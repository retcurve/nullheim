/** Tests claims, the frontier, the static lock, and the contribution clock. */

import { test, describe } from "node:test";
import assert from "node:assert/strict";

import { SCHEMA_SQL } from "../src/db/schema.node.ts";
import { openSqlite } from "../src/db/sqlite.ts";
import * as coords from "../src/coords.ts";
import { ORIGIN, coord } from "../src/coords.ts";
import { Engine, ensureGenesis } from "../src/engine.ts";
import { openFsImages } from "../src/images/fs.ts";
import { permissiveModerator } from "../src/moderation/permissive.ts";
import { loadPrompts } from "../src/prompts.node.ts";
import { seeded } from "../src/random.ts";
import {
  RateKind,
  RateLimited,
  ClaimStatus,
  HandleTaken,
  NotYet,
  Registry,
  SectorRequired,
  SectorUnavailable,
  cooldownRemaining,
  isActive,
} from "../src/registry.ts";
import { AlreadyBaked, ClaimNotLive, WorldStore } from "../src/store.ts";
import { loadCodecs } from "../src/wasm.node.ts";
import {
  build,
  codes,
  makePng,
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
    // [1,1] touches two built sectors; [3,0] touches one.
    const pocket = coords.key(coord(1, 1));
    const limbEnd = coords.key(coord(3, 0));

    const chosen = new Set<string>();
    for (let seed = 0; seed < 60; seed += 1) {
      const db = openSqlite(":memory:");
      await db.exec(SCHEMA_SQL);
      const store = new WorldStore(db);
      const registry = new Registry(db, { rng: seeded(seed) });
      await ensureGenesis(store);
      const engine = new Engine({ store, registry, prompts: PROMPTS, images: openFsImages(null), codecs: CODECS, moderator: permissiveModerator("clean") });
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
    assert.deepEqual(await engine.registry.authenticate(token), agent);
    assert.notEqual(await engine.claim(agent), null);
  });
});

describe("one claim at a time", () => {
  test("two concurrent allocations for one agent produce one claim", async () => {
    const { engine } = await makeEngine({ claimsPerHour: 0 });
    const { agent } = await engine.register("racer");
    const outcomes = await Promise.allSettled([engine.claim(agent), engine.claim(agent)]);

    const granted = outcomes.filter((o) => o.status === "fulfilled");
    assert.equal(granted.length, 1);
    const refused = outcomes.find((o) => o.status === "rejected");
    assert.ok(refused !== undefined);
    assert.ok((refused as PromiseRejectedResult).reason instanceof SectorUnavailable);
    assert.equal((refused as PromiseRejectedResult).reason.code, "claim_in_progress");
  });
});

describe("reaping abandoned images", () => {
  async function uploaded(engine: Engine, handle: string) {
    const { agent } = await engine.register(handle);
    const claim = await engine.claim(agent);
    const { url } = await engine.uploadImage(agent, makePng(8, 8));
    return { agent, claim, url, key: url.slice("/v1/images/".length) };
  }

  test("an image whose claim expired is reclaimed", async () => {
    const { engine, db } = await makeEngine();
    const { claim, key } = await uploaded(engine, "abandoner");
    assert.notEqual(await engine.images.get(key), null);

    await db.run("UPDATE claims SET expires_at = 0 WHERE claim_id = ?", [claim.claimId]);
    assert.deepEqual(await engine.reapImages(), { deleted: 1 });
    assert.equal(await engine.images.get(key), null);
  });

  test("an image whose claim was released is reclaimed", async () => {
    const { engine } = await makeEngine();
    const { claim, key } = await uploaded(engine, "quitter");
    await engine.release(claim);

    assert.deepEqual(await engine.reapImages(), { deleted: 1 });
    assert.equal(await engine.images.get(key), null);
  });

  test("an image a sector actually shows is never reclaimed", async () => {
    const { engine } = await makeEngine();
    const { agent, claim, url, key } = await uploaded(engine, "builder");
    const { errors } = await engine.submitSector(
      agent,
      claim,
      sector(coords.asList(claim.coordinate) as [number, number], { image: url }),
    );
    assert.deepEqual(errors, []);

    assert.deepEqual(await engine.reapImages(), { deleted: 0 });
    assert.notEqual(await engine.images.get(key), null);
  });

  test("an image the baked sector left unused is reclaimed too", async () => {
    const { engine } = await makeEngine();
    const { agent, claim, key } = await uploaded(engine, "keeper");
    const { errors } = await engine.submitSector(
      agent,
      claim,
      sector(coords.asList(claim.coordinate) as [number, number]),
    );
    assert.deepEqual(errors, []);

    assert.deepEqual(await engine.reapImages(), { deleted: 1 });
    assert.equal(await engine.images.get(key), null);
  });

  test("a live claim's image is left alone", async () => {
    const { engine } = await makeEngine();
    const { key } = await uploaded(engine, "still-working");

    assert.deepEqual(await engine.reapImages(), { deleted: 0 });
    assert.notEqual(await engine.images.get(key), null);
  });

  test("a submission cannot bake once its lease has lapsed", async () => {
    const { engine, db } = await makeEngine();
    const { agent, claim, url } = await uploaded(engine, "too-slow");
    await db.run("UPDATE claims SET expires_at = 0 WHERE claim_id = ?", [claim.claimId]);

    await assert.rejects(
      engine.submitSector(
        agent,
        claim,
        sector(coords.asList(claim.coordinate) as [number, number], { image: url }),
      ),
      ClaimNotLive,
    );
    assert.equal(await engine.store.get(claim.coordinate), null);
  });

  test("one sweep clears many images at once", async () => {
    const { engine } = await makeEngine();
    const keys: string[] = [];
    for (const handle of ["one", "two", "three"]) {
      const { claim, key } = await uploaded(engine, handle);
      await engine.release(claim);
      keys.push(key);
    }

    assert.deepEqual(await engine.reapImages(), { deleted: 3 });
    for (const key of keys) {
      assert.equal(await engine.images.get(key), null, key);
    }
  });

  test("a reaped claim forgets its key, so the next sweep has nothing to do", async () => {
    const { engine } = await makeEngine();
    const { claim } = await uploaded(engine, "swept");
    await engine.release(claim);
    await engine.reapImages();

    assert.equal((await engine.registry.getClaim(claim.claimId))?.imageKey, null);
    assert.deepEqual(await engine.reapImages(), { deleted: 0 });
  });

  test("reaping a pending image also deletes its now-dangling moderation record", async () => {
    const { engine } = await makeEngine({ moderator: permissiveModerator("unsure") });
    const { claim, key } = await uploaded(engine, "orphan-maker");
    await engine.release(claim);

    assert.deepEqual(await engine.reapImages(), { deleted: 1 });
    const remaining = await engine.store.listImages();
    assert.equal(remaining.some((row) => row.imageKey === key), false);
  });
});

describe("image moderation", () => {
  async function uploaded(engine: Engine, handle: string) {
    const { agent } = await engine.register(handle);
    const claim = await engine.claim(agent);
    const { url } = await engine.uploadImage(agent, makePng(8, 8));
    return { agent, claim, url, key: url.slice("/v1/images/".length) };
  }

  test("a clean verdict publishes the image immediately", async () => {
    const { engine } = await makeEngine({ moderator: permissiveModerator("clean") });
    const { key } = await uploaded(engine, "clean-uploader");
    assert.equal(await engine.store.imageIsPublished(key), true);
  });

  test("an unsure verdict stores the image but withholds it", async () => {
    const { engine } = await makeEngine({ moderator: permissiveModerator("unsure") });
    const { key } = await uploaded(engine, "unsure-uploader");
    assert.notEqual(await engine.images.get(key), null);
    assert.equal(await engine.store.imageIsPublished(key), false);
  });

  test("approving a pending image publishes it", async () => {
    const { engine } = await makeEngine({ moderator: permissiveModerator("unsure") });
    const { key } = await uploaded(engine, "reviewed");
    assert.equal(await engine.store.approveImage(key), true);
    assert.equal(await engine.store.imageIsPublished(key), true);
  });

  test("approving an image that is not pending does nothing", async () => {
    const { engine } = await makeEngine({ moderator: permissiveModerator("clean") });
    const { key } = await uploaded(engine, "already-clean");
    assert.equal(await engine.store.approveImage(key), false);
  });

  test("a pending image referenced by a baked sector is never reaped", async () => {
    const { engine } = await makeEngine({ moderator: permissiveModerator("unsure") });
    const { agent, claim, url, key } = await uploaded(engine, "pending-builder");
    const { errors } = await engine.submitSector(
      agent,
      claim,
      sector(coords.asList(claim.coordinate) as [number, number], { image: url }),
    );
    assert.deepEqual(errors, []);

    assert.deepEqual(await engine.reapImages(), { deleted: 0 });
    assert.notEqual(await engine.images.get(key), null);
  });

  test("rejecting an image a sector already shows takes it down", async () => {
    const { engine } = await makeEngine({ moderator: permissiveModerator("clean") });
    const { agent, claim, url, key } = await uploaded(engine, "takedown-target");
    const { errors } = await engine.submitSector(
      agent,
      claim,
      sector(coords.asList(claim.coordinate) as [number, number], { image: url }),
    );
    assert.deepEqual(errors, []);
    assert.equal((await engine.store.get(claim.coordinate))?.sector.image, url);

    assert.equal(await engine.rejectImage(key), true);

    assert.equal(await engine.images.get(key), null);
    assert.equal((await engine.store.get(claim.coordinate))?.sector.image, null);
    assert.equal(await engine.store.imageIsPublished(key), false);
  });

  test("rejecting an image that does not exist is reported honestly", async () => {
    const { engine } = await makeEngine();
    assert.equal(await engine.rejectImage("nonexistent"), false);
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
      assert.ok(exc instanceof RateLimited);
      assert.equal(exc.kind, RateKind.CLAIM);
      assert.ok(exc.retryAfter > 3500 && exc.retryAfter <= 3600, String(exc.retryAfter));
    }
  });

  test("it does not consult the agent, so a new token does not help", async () => {
    const { engine } = await makeEngine({ claimsPerHour: 1 });
    await engine.claim((await engine.register("first")).agent);
    await assert.rejects(
      engine.claim((await engine.register("second")).agent),
      RateLimited,
    );
  });

  test("this agent's own cooldown is reported before the world's rate", async () => {
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

    const second = await found(engine, agent);
    assert.equal(agent.coordinates.length, 2);
    assert.notDeepEqual(second.sector.coordinate, agent.coordinates[0]);

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
    await found(engine, agent);

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
    assert.equal(northSide[0]!.name, "The Grey Expanse");
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

  test("the sector detail endpoint returns the full prose for an owned sector", async () => {
    const { engine } = await makeEngine({ cooldownSeconds: 0 });
    const { agent } = await engine.register("architect");
    const claim = await engine.claim(agent);
    await engine.submitSector(agent, claim, {
      coordinate: [claim.coordinate.x, claim.coordinate.y],
      title: "A Place",
      short_description: "d",
      long_description: "the full long description",
    });
    const sectorId = (await engine.store.get(claim.coordinate))!.sectorId;
    await engine.createObject(agent, {
      parent_id: sectorId,
      title: "Brass Can",
      description: "the full object description",
    });

    const detail = await engine.sectorContext(agent, sectorId);
    assert.notEqual(detail, null);
    assert.equal(detail!["long_description"], "the full long description");
    const objects = detail!["objects"] as { title: string; description: string }[];
    assert.equal(objects[0]!.title, "Brass Can");
    assert.equal(objects[0]!.description, "the full object description");

    const { agent: other } = await engine.register("other");
    assert.equal(await engine.sectorContext(other, sectorId), null);
    assert.equal(await engine.sectorContext(agent, "sec_does_not_exist"), null);
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
    let engine = new Engine({ store, registry, prompts: PROMPTS, images: openFsImages(null), codecs: CODECS, moderator: permissiveModerator("clean") });
    const { agent, token } = await engine.register("persisto");
    await found(engine, agent);
    await furnish(engine, agent, 3);

    store = new WorldStore(db);
    registry = new Registry(db, { cooldownSeconds: 0, claimsPerHour: 0 });
    engine = new Engine({ store, registry, prompts: PROMPTS, images: openFsImages(null), codecs: CODECS, moderator: permissiveModerator("clean") });
    const revived = await engine.registry.authenticate(token);
    assert.notEqual(revived, null, "the token must still authenticate");
    assert.deepEqual(revived!.coordinates, agent.coordinates);
    assert.equal(revived!.objectsCreated, 3);
    assert.notEqual(await engine.claim(revived!), null);
    db.close();
  });

  test("only the last save for an agent that changed many times survives", async () => {
    const db = openSqlite(":memory:");
    await db.exec(SCHEMA_SQL);

    let store = new WorldStore(db);
    let registry = new Registry(db, { cooldownSeconds: 0, claimsPerHour: 0 });
    await ensureGenesis(store);
    let engine = new Engine({ store, registry, prompts: PROMPTS, images: openFsImages(null), codecs: CODECS, moderator: permissiveModerator("clean") });
    const { agent, token } = await engine.register("grinder");
    await found(engine, agent);
    await furnish(engine, agent, 5);

    store = new WorldStore(db);
    registry = new Registry(db, { cooldownSeconds: 0, claimsPerHour: 0 });
    engine = new Engine({ store, registry, prompts: PROMPTS, images: openFsImages(null), codecs: CODECS, moderator: permissiveModerator("clean") });
    const revived = await engine.registry.authenticate(token);
    assert.equal(revived!.objectsCreated, 5);
    assert.equal((await engine.registry.stats()).agents, 1);
    db.close();
  });
});
