/** Claims, the frontier, the static lock, and the 6-hour contribution clock. */

import { test, describe } from "node:test";
import assert from "node:assert/strict";

import { SCHEMA_SQL } from "./db/schema.node.ts";
import { openSqlite } from "./db/sqlite.ts";
import * as coords from "./coords.ts";
import { ORIGIN, coord } from "./coords.ts";
import { Engine, ensureGenesis } from "./engine.ts";
import { openFsImages } from "./images/fs.ts";
import { loadPrompts } from "./prompts.node.ts";
import { seeded } from "./random.ts";
import {
  ClaimRateLimited,
  ClaimStatus,
  HandleTaken,
  NotYet,
  Registry,
  SectorRequired,
  SectorUnavailable,
  cooldownRemaining,
  isActive,
} from "./registry.ts";
import { AlreadyBaked, WorldStore } from "./store.ts";
import { loadCodecs } from "./wasm.node.ts";
import {
  build,
  codes,
  found,
  furnish,
  makeEngine,
  obj,
  root,
  sector,
  settle,
} from "./testing.ts";

const PROMPTS = loadPrompts();
const CODECS = loadCodecs();

async function frontierKeys(engine: Engine): Promise<Set<string>> {
  return new Set((await engine.registry.frontier()).map(coords.key));
}

describe("the frontier", () => {
  test("the world seeds itself with one sector", async () => {
    const { engine } = await makeEngine();
    assert.equal(await engine.store.count(), 1);
    assert.notEqual(await engine.store.get(ORIGIN), null);
  });

  test("the frontier is every side of every sector", async () => {
    // Any side can take a neighbour — there are no sealed edges.
    const { engine } = await makeEngine();
    const expected = new Set(
      coords.neighbours(ORIGIN).map(([, neighbour]) => coords.key(neighbour)),
    );
    assert.deepEqual(await frontierKeys(engine), expected);
  });

  test("the frontier grows as the world does", async () => {
    const { engine } = await makeEngine();
    await build(engine, [0, 1]);
    const frontier = await frontierKeys(engine);
    assert.ok(frontier.has(coords.key(coord(0, 2))));
    assert.ok(frontier.has(coords.key(coord(1, 1))));
    assert.ok(!frontier.has(coords.key(ORIGIN)));
  });

  test("allocation never hands out the same sector twice", async () => {
    const { engine } = await makeEngine();
    const seen = new Set<string>();
    for (let index = 0; index < 4; index += 1) {
      const { agent } = await engine.register(`a${index}`);
      const claim = await engine.claim(agent);
      const k = coords.key(claim.coordinate);
      assert.ok(!seen.has(k), "handed out a coordinate twice");
      seen.add(k);
    }
  });

  test("running out of frontier is a clean retryable refusal", async () => {
    // Only reachable while the frontier is tiny — four slots at genesis.
    const { engine } = await makeEngine();
    for (let index = 0; index < 4; index += 1) {
      const { agent } = await engine.register(`a${index}`);
      await engine.claim(agent);
    }
    const { agent } = await engine.register("one-too-many");
    try {
      await engine.claim(agent);
      assert.fail("expected a refusal");
    } catch (exc) {
      assert.ok(exc instanceof SectorUnavailable);
      assert.equal(exc.code, "frontier_busy");
    }
  });

  test("allocation does not prefer well-connected slots", async () => {
    // A pocket is worth no more than the end of a limb. The world is meant to
    // sprawl organically, corridors included, so the only rule is adjacency.
    // This asserts the absence of the old fill-the-pockets heuristic.
    //
    // An L: [1,1] touches two sectors, [3,0] touches one.
    const pocket = coords.key(coord(1, 1));
    const limbEnd = coords.key(coord(3, 0));

    const chosen = new Set<string>();
    for (let seed = 0; seed < 60; seed += 1) {
      const db = openSqlite(":memory:");
      await db.exec(SCHEMA_SQL);
      const store = new WorldStore(db);
      const registry = new Registry(db, { rng: seeded(seed) });
      await ensureGenesis(store);
      const engine = new Engine({ store, registry, prompts: PROMPTS, images: openFsImages(null), codecs: CODECS });
      await build(engine, [1, 0]);
      await build(engine, [2, 0]);
      await build(engine, [0, 1]);

      const { agent } = await engine.register("a");
      chosen.add(coords.key((await engine.claim(agent)).coordinate));
    }

    assert.ok(chosen.has(pocket), "a pocket must be reachable");
    assert.ok(chosen.has(limbEnd), "a slot with one neighbour must still be reachable");
  });
});

describe("leases", () => {
  test("an expired lease returns the sector to the frontier", async () => {
    const { engine } = await makeEngine({ leaseSeconds: 0 });
    const { agent } = await engine.register("slow");
    const claim = await engine.claim(agent);

    assert.ok(!isActive(claim));
    assert.ok((await frontierKeys(engine)).has(coords.key(claim.coordinate)));
    assert.equal((await engine.registry.getClaim(claim.claimId))?.status, ClaimStatus.EXPIRED);
  });

  test("an agent whose lease lapsed may claim again", async () => {
    const { engine } = await makeEngine({ leaseSeconds: 0 });
    const { agent } = await engine.register("slow");
    await engine.claim(agent);
    assert.notEqual(await engine.claim(agent), null);
  });

  test("a live lease holds its sector against other agents", async () => {
    const { engine } = await makeEngine();
    const { agent } = await engine.register("holder");
    const claim = await engine.claim(agent);
    assert.ok(!(await frontierKeys(engine)).has(coords.key(claim.coordinate)));
  });

  test("an agent cannot hold two claims at once", async () => {
    const { engine } = await makeEngine();
    const { agent } = await engine.register("greedy");
    await engine.claim(agent);
    try {
      await engine.claim(agent);
      assert.fail("expected a refusal");
    } catch (exc) {
      assert.ok(exc instanceof SectorUnavailable);
      assert.equal(exc.code, "claim_in_progress");
    }
  });

  test("releasing frees the sector but keeps the agent", async () => {
    const { engine } = await makeEngine();
    const { agent, token } = await engine.register("quitter");
    const claim = await engine.claim(agent);
    await engine.release(claim);

    assert.ok((await frontierKeys(engine)).has(coords.key(claim.coordinate)));
    // The token survives — an agent that gave up may try again.
    assert.deepEqual(await engine.registry.authenticate(token), agent);
    assert.notEqual(await engine.claim(agent), null);
  });
});

describe("the world-wide claim rate", () => {
  test("it refuses once the hour is full, and says how long", async () => {
    const { engine } = await makeEngine({ claimsPerHour: 2 });
    for (const name of ["one", "two"]) {
      await engine.claim((await engine.register(name)).agent);
    }
    try {
      await engine.claim((await engine.register("three")).agent);
      assert.fail("expected a refusal");
    } catch (exc) {
      assert.ok(exc instanceof ClaimRateLimited);
      // The wait points at the oldest grant ageing out of the window, so it is
      // the better part of an hour rather than a token back-off.
      assert.ok(exc.retryAfter > 3500 && exc.retryAfter <= 3600, String(exc.retryAfter));
    }
  });

  test("it does not consult the agent, so a new token does not help", async () => {
    // The reason this brake exists in the first place: registration is free.
    const { engine } = await makeEngine({ claimsPerHour: 1 });
    await engine.claim((await engine.register("first")).agent);
    await assert.rejects(
      engine.claim((await engine.register("second")).agent),
      ClaimRateLimited,
    );
  });

  test("this agent's own cooldown is reported before the world's rate", async () => {
    // A cooldown-limited agent polling a rate limit would be waiting on the
    // wrong thing. settle() itself spends the hour's one claim, so a second
    // attempt hits both limits at once — the agent's own cooldown must win.
    const { engine } = await makeEngine({ claimsPerHour: 1, cooldownSeconds: 3600 });
    const { agent } = await settle(engine);
    await assert.rejects(engine.claim(agent), NotYet);
  });
});

describe("submitting a sector", () => {
  test("a clean submission bakes and settles the agent", async () => {
    const { engine } = await makeEngine({ cooldownSeconds: 3600 });
    const { agent } = await engine.register("architect");
    const claim = await engine.claim(agent);

    const { errors } = await engine.submitSector(
      agent,
      claim,
      sector(coords.asList(claim.coordinate)),
    );
    assert.deepEqual(errors, []);
    assert.notEqual(await engine.store.get(claim.coordinate), null);
    assert.equal((await engine.registry.getClaim(claim.claimId))?.status, ClaimStatus.BAKED);
    assert.deepEqual(agent.coordinates, [claim.coordinate]);
    assert.ok(cooldownRemaining(agent) > 0);
  });

  test("the token survives baking", async () => {
    // The sector is permanent; the agent is not spent. It comes back.
    const { engine } = await makeEngine();
    const { agent, token } = await settle(engine);
    assert.deepEqual(await engine.registry.authenticate(token), agent);
  });

  test("claiming again before the cooldown elapses throws NotYet", async () => {
    const { engine } = await makeEngine({ cooldownSeconds: 3600 });
    const { agent } = await settle(engine);
    await assert.rejects(engine.claim(agent), NotYet);
  });

  test("founding a second sector costs nothing but the cooldown, however many objects are held", async () => {
    const { engine } = await makeEngine({ cooldownSeconds: 0 });
    const { agent } = await settle(engine);

    // Not a single object placed, and a second sector is still available
    // immediately — sectors are no longer priced in objects at all.
    const second = await found(engine, agent);
    assert.equal(agent.coordinates.length, 2);
    assert.notDeepEqual(second.sector.coordinate, agent.coordinates[0]);

    // A third costs no more than the second did — nothing, either way.
    const third = await found(engine, agent);
    assert.equal(agent.coordinates.length, 3);
    assert.notDeepEqual(third.sector.coordinate, agent.coordinates[1]);
  });

  test("an agent may place any number of objects, with no cooldown between them", async () => {
    const { engine } = await makeEngine({ cooldownSeconds: 3600 });
    const { agent } = await settle(engine);
    const sectorId = await root(engine, agent);

    for (let i = 0; i < 5; i += 1) {
      const { object, errors } = await engine.createObject(agent, obj(sectorId, { title: `Thing ${i}` }));
      assert.deepEqual(errors, []);
      assert.notEqual(object, null);
    }
    assert.equal(agent.objectsCreated, 5);
  });

  test("parent_id alone decides which sector an object lands in", async () => {
    const { engine } = await makeEngine({ cooldownSeconds: 0 });
    const { agent } = await settle(engine);
    await found(engine, agent); // a second sector, free and immediate now

    const older = await root(engine, agent, 0);
    const newer = await root(engine, agent, 1);
    const { object } = await engine.createObject(agent, obj(newer));
    assert.notEqual(object, null);
    assert.deepEqual(object!.coordinate, agent.coordinates[1]);

    const { object: back } = await engine.createObject(agent, obj(older));
    assert.deepEqual(back!.coordinate, agent.coordinates[0]);
  });

  test("an agent cannot furnish a sector it does not hold", async () => {
    const { engine } = await makeEngine();
    const { agent } = await settle(engine);
    const { agent: neighbour } = await settle(engine, "someone-else");

    const { errors } = await engine.checkObject(agent, obj(await root(engine, neighbour)));
    assert.ok(codes(errors).has("no_such_parent"));
  });

  test("a rejected submission leaves the lease live", async () => {
    const { engine } = await makeEngine();
    const { agent } = await engine.register("architect");
    const claim = await engine.claim(agent);

    const { baked, errors } = await engine.submitSector(
      agent,
      claim,
      sector(coords.asList(claim.coordinate), { title: "" }),
    );
    assert.equal(baked, null);
    assert.ok(codes(errors).has("empty_text"));
    assert.ok(isActive(claim));
    assert.deepEqual(agent.coordinates, []);
    assert.equal(claim.attempts, 1);
  });

  test("the dry run never touches the world", async () => {
    const { engine } = await makeEngine();
    const { agent } = await engine.register("careful");
    const claim = await engine.claim(agent);

    const before = await engine.store.count();
    const { errors } = await engine.checkSector(claim, sector(coords.asList(claim.coordinate)));
    assert.deepEqual(errors, []);
    assert.equal(await engine.store.count(), before);
  });

  test("the static lock refuses a rewrite", async () => {
    const { engine } = await makeEngine();
    await build(engine, [0, 1]);
    await assert.rejects(build(engine, [0, 1]), AlreadyBaked);
  });
});

describe("what a claim reveals", () => {
  test("a claim reveals nothing about the neighbours", async () => {
    // The withholding is the mechanism, so it gets a test of its own.
    const { engine } = await makeEngine();
    await build(engine, [0, 1], {
      overrides: { title: "The Tell-Tale Orangery", long_description: "Moths, mostly." },
    });
    const { agent } = await engine.register("architect");
    const claim = await engine.claim(agent);

    const serialised = JSON.stringify(await engine.claimContext(claim));
    for (const leak of [
      "Tell-Tale",
      "Orangery",
      "Moths",
      "title",
      "north",
      "exit",
      "neighbour",
    ]) {
      assert.ok(!serialised.includes(leak), `claim context leaked ${JSON.stringify(leak)}`);
    }
  });

  test("a claim reveals the coordinate and the clock", async () => {
    const { engine } = await makeEngine();
    const { agent } = await engine.register("architect");
    const claim = await engine.claim(agent);
    const context = await engine.claimContext(claim);

    assert.deepEqual(context["coordinate"], coords.asList(claim.coordinate));
    const claimPayload = context["claim"] as Record<string, number>;
    assert.ok(claimPayload["expires_in"]! > 0);
  });
});

describe("the contribution clock", () => {
  test("an unsettled agent has nothing to furnish", async () => {
    const { engine } = await makeEngine();
    const { agent } = await engine.register("drifter");
    await assert.rejects(engine.createObject(agent, obj("sec_whatever")), SectorRequired);
  });

  test("a fresh sector's cooldown does not block furnishing it", async () => {
    const { engine } = await makeEngine({ cooldownSeconds: 3600 });
    const { agent } = await settle(engine);
    assert.ok(cooldownRemaining(agent) > 0, "settling starts the sector cooldown");

    const { object, errors } = await engine.createObject(agent, obj(await root(engine, agent)));
    assert.deepEqual(errors, []);
    assert.notEqual(object, null);
  });

  test("placing an object increments objectsCreated", async () => {
    const { engine } = await makeEngine({ cooldownSeconds: 0 });
    const { agent } = await settle(engine);

    const { object, errors } = await engine.createObject(
      agent,
      obj(await root(engine, agent), { title: "One" }),
    );
    assert.deepEqual(errors, []);
    assert.notEqual(object, null);
    assert.equal(agent.objectsCreated, 1);
  });

  test("placing an object never touches the sector cooldown", async () => {
    const { engine } = await makeEngine({ cooldownSeconds: 3600 });
    const { agent } = await settle(engine);
    const before = agent.nextContributionAt;

    await engine.createObject(agent, obj(await root(engine, agent)));
    assert.equal(agent.objectsCreated, 1);
    assert.equal(agent.nextContributionAt, before);
  });

  test("a rejected object does not spend the cooldown", async () => {
    const { engine } = await makeEngine({ cooldownSeconds: 0 });
    const { agent } = await settle(engine);

    const { object, errors } = await engine.createObject(agent, obj("obj_nope"));
    assert.equal(object, null);
    assert.ok(codes(errors).has("no_such_parent"));
    assert.equal(agent.objectsCreated, 0);
    assert.equal(cooldownRemaining(agent), 0);
  });

  test("objects accumulate into a tree", async () => {
    const { engine } = await makeEngine({ cooldownSeconds: 0 });
    const { agent } = await settle(engine);

    const { object: can } = await engine.createObject(
      agent,
      obj(await root(engine, agent), { title: "Watering Can" }),
    );
    await engine.createObject(agent, obj(can!.objectId, { title: "Key" }));
    await engine.createObject(agent, obj(await root(engine, agent), { title: "Label" }));

    const tree = await engine.objectTree(agent.coordinates[0]!);
    assert.deepEqual(
      tree.map((node) => node.title),
      ["Watering Can", "Label"],
    );
    assert.deepEqual(
      tree[0]!.contains.map((node) => node.title),
      ["Key"],
    );
  });
});

describe("interactions", () => {
  test("an interaction requires both objects in a sector the caller holds", async () => {
    const { engine } = await makeEngine({ cooldownSeconds: 0 });
    const { agent: one } = await settle(engine, "one");
    const { agent: two } = await settle(engine, "two");
    const { object: mine } = await engine.createObject(one, obj(await root(engine, one)));
    const { object: theirs } = await engine.createObject(two, obj(await root(engine, two)));

    const { interaction: made, errors } = await engine.createInteraction(one, {
      object_a_id: mine!.objectId,
      object_b_id: theirs!.objectId,
      text: "Doesn't fit.",
    });
    assert.equal(made, null);
    assert.ok(codes(errors).has("no_such_object"));
  });

  test("a pair of objects may only ever get one interaction", async () => {
    const { engine } = await makeEngine({ cooldownSeconds: 0 });
    const { agent } = await settle(engine);
    const { object: a } = await engine.createObject(agent, obj(await root(engine, agent), { title: "Rope" }));
    const { object: b } = await engine.createObject(agent, obj(await root(engine, agent), { title: "Hook" }));

    const first = await engine.createInteraction(agent, {
      object_a_id: a!.objectId,
      object_b_id: b!.objectId,
      text: "Tied fast.",
    });
    assert.deepEqual(first.errors, []);
    assert.notEqual(first.interaction, null);

    const second = await engine.createInteraction(agent, {
      object_a_id: a!.objectId,
      object_b_id: b!.objectId,
      text: "Something else entirely.",
    });
    assert.equal(second.interaction, null);
    assert.ok(codes(second.errors).has("interaction_exists"));

    // Order-independent: "use B with A" resolves the same written pair.
    const view = await engine.interactionView(b!.objectId, a!.objectId);
    assert.equal(view!["text"], "Tied fast.");
  });

  test("placing an interaction is unaffected by the sector cooldown", async () => {
    const { engine } = await makeEngine({ cooldownSeconds: 3600 });
    const { agent } = await settle(engine);
    const { object: a } = await engine.createObject(agent, obj(await root(engine, agent), { title: "Rope" }));
    const { object: b } = await engine.createObject(agent, obj(await root(engine, agent), { title: "Hook" }));

    const { interaction: made, errors } = await engine.createInteraction(agent, {
      object_a_id: a!.objectId,
      object_b_id: b!.objectId,
      text: "Tied fast.",
    });
    assert.deepEqual(errors, []);
    assert.notEqual(made, null);
  });
});

describe("the read model", () => {
  test("exits are derived from adjacency alone", async () => {
    const { engine } = await makeEngine();
    await build(engine, [0, 1], {
      overrides: { title: "North Place", short_description: "A glimpse north." },
    });
    await build(engine, [1, 0], {
      overrides: { title: "East Place", short_description: "A glimpse east." },
    });

    const view = (await engine.sectorView(ORIGIN))!;
    const exits = view["exits"] as { direction: string; name: string; description: string }[];
    const byDirection = new Map(exits.map((e) => [e.direction, e]));
    assert.deepEqual(new Set(byDirection.keys()), new Set(["north", "east"]));
    assert.equal(byDirection.get("north")!.name, "North Place");
    assert.equal(byDirection.get("north")!.description, "A glimpse north.");
  });

  test("every adjacency produces an exit in both directions", async () => {
    // Neither side declares the door, so neither side can disagree.
    const { engine } = await makeEngine();
    await build(engine, [0, 1], { overrides: { title: "North Place" } });

    const southSide = (await engine.sectorView(ORIGIN))!["exits"] as {
      direction: string;
      name: string;
    }[];
    const northSide = (await engine.sectorView(coord(0, 1)))!["exits"] as {
      direction: string;
      name: string;
    }[];
    assert.deepEqual(
      southSide.map((e) => e.direction),
      ["north"],
    );
    assert.deepEqual(
      northSide.map((e) => e.direction),
      ["south"],
    );
    assert.equal(northSide[0]!.name, "The Nullpoint");
  });

  test("the player's view shows the long description and object titles", async () => {
    const { engine } = await makeEngine({ cooldownSeconds: 0 });
    const { agent } = await settle(engine);
    await engine.createObject(
      agent,
      obj(await root(engine, agent), { title: "A Thing", description: "Longer detail." }),
    );

    const view = (await engine.sectorView(agent.coordinates[0]!))!;
    assert.equal(view["description"], "It is a place, and it is here.");
    const things = view["things_you_can_see"] as { title: string }[];
    assert.deepEqual(
      things.map((t) => t.title),
      ["A Thing"],
    );
    // The detail is only on the object itself, not spilled into the room.
    assert.ok(!JSON.stringify(view).includes("Longer detail."));
  });

  test("looking at an object shows its description and contents", async () => {
    const { engine } = await makeEngine({ cooldownSeconds: 0 });
    const { agent } = await settle(engine);
    const { object: can } = await engine.createObject(
      agent,
      obj(await root(engine, agent), { title: "Can", description: "Dented." }),
    );
    await engine.createObject(agent, obj(can!.objectId, { title: "Key" }));

    const view = (await engine.objectView(can!.objectId))!;
    assert.equal(view["description"], "Dented.");
    const things = view["things_you_can_see"] as { title: string }[];
    assert.deepEqual(
      things.map((t) => t.title),
      ["Key"],
    );
  });

  test("nested objects do not appear at sector level", async () => {
    const { engine } = await makeEngine({ cooldownSeconds: 0 });
    const { agent } = await settle(engine);
    const { object: can } = await engine.createObject(
      agent,
      obj(await root(engine, agent), { title: "Can" }),
    );
    await engine.createObject(agent, obj(can!.objectId, { title: "Key" }));

    const view = (await engine.sectorView(agent.coordinates[0]!))!;
    const things = view["things_you_can_see"] as { title: string }[];
    assert.deepEqual(
      things.map((t) => t.title),
      ["Can"],
    );
  });

  test("a deep chain walks correctly", async () => {
    const { engine } = await makeEngine({ cooldownSeconds: 0 });
    const { agent } = await settle(engine);

    let parentId = await root(engine, agent);
    for (let depth = 0; depth < 12; depth += 1) {
      const { object } = await engine.createObject(agent, obj(parentId, { title: `level-${depth}` }));
      parentId = object!.objectId;
    }

    let node = await engine.objectTree(agent.coordinates[0]!);
    for (let depth = 0; depth < 12; depth += 1) {
      assert.equal(node.length, 1);
      assert.equal(node[0]!.title, `level-${depth}`);
      node = node[0]!.contains;
    }
    assert.deepEqual(node, []);
  });
});

describe("registering an agent", () => {
  test("a second agent cannot take a handle already in use", async () => {
    const { engine } = await makeEngine();
    await engine.register("scrivener");
    await assert.rejects(engine.register("scrivener"), HandleTaken);
  });

  test("two concurrent registrations for the same handle: exactly one wins", async () => {
    const { engine } = await makeEngine();
    const results = await Promise.allSettled([
      engine.register("racer"),
      engine.register("racer"),
    ]);
    const fulfilled = results.filter((r) => r.status === "fulfilled");
    const rejected = results.filter((r) => r.status === "rejected");
    assert.equal(fulfilled.length, 1);
    assert.equal(rejected.length, 1);
    assert.ok((rejected[0] as PromiseRejectedResult).reason instanceof HandleTaken);
  });
});

describe("agents survive a restart", () => {
  test("a token, its sectors, and its object count all outlive the process", async () => {
    const db = openSqlite(":memory:");
    await db.exec(SCHEMA_SQL);

    let store = new WorldStore(db);
    let registry = new Registry(db, { cooldownSeconds: 0, claimsPerHour: 0 });
    await ensureGenesis(store);
    let engine = new Engine({ store, registry, prompts: PROMPTS, images: openFsImages(null), codecs: CODECS });
    const { agent, token } = await engine.register("persisto");
    await found(engine, agent);
    await furnish(engine, agent, 3);

    // A fresh Engine over the same (still-open) database, as a restart
    // against the same file would produce: nothing but the database itself
    // carries state across it.
    store = new WorldStore(db);
    registry = new Registry(db, { cooldownSeconds: 0, claimsPerHour: 0 });
    engine = new Engine({ store, registry, prompts: PROMPTS, images: openFsImages(null), codecs: CODECS });
    const revived = await engine.registry.authenticate(token);
    assert.notEqual(revived, null, "the token must still authenticate");
    assert.deepEqual(revived!.coordinates, agent.coordinates);
    assert.equal(revived!.objectsCreated, 3);
    // The cooldown clock survives the restart too, at the value it actually
    // held rather than reset to zero — a second sector stays available here
    // only because this registry's cooldownSeconds is 0, not because the
    // objects placed bought anything.
    assert.notEqual(await engine.claim(revived!), null);
    db.close();
  });

  test("only the last save for an agent that changed many times survives", async () => {
    const db = openSqlite(":memory:");
    await db.exec(SCHEMA_SQL);

    let store = new WorldStore(db);
    let registry = new Registry(db, { cooldownSeconds: 0, claimsPerHour: 0 });
    await ensureGenesis(store);
    let engine = new Engine({ store, registry, prompts: PROMPTS, images: openFsImages(null), codecs: CODECS });
    const { agent, token } = await engine.register("grinder");
    await found(engine, agent);
    await furnish(engine, agent, 5); // several separate saves of the same agent

    store = new WorldStore(db);
    registry = new Registry(db, { cooldownSeconds: 0, claimsPerHour: 0 });
    engine = new Engine({ store, registry, prompts: PROMPTS, images: openFsImages(null), codecs: CODECS });
    const revived = await engine.registry.authenticate(token);
    assert.equal(revived!.objectsCreated, 5);
    assert.equal((await engine.registry.stats()).agents, 1);
    db.close();
  });
});
