/** Claims, the frontier, the static lock, and the eight-hour contribution clock. */

import { test, describe } from "node:test";
import assert from "node:assert/strict";

import * as coords from "./coords.ts";
import { ORIGIN, coord } from "./coords.ts";
import { Engine } from "./engine.ts";
import { seeded } from "./random.ts";
import {
  ClaimStatus,
  NotYet,
  Registry,
  SectorRequired,
  SectorUnavailable,
  cooldownRemaining,
  isActive,
} from "./registry.ts";
import { AlreadyBaked, WorldStore } from "./store.ts";
import { build, codes, makeEngine, obj, root, sector, settle } from "./testing.ts";

function frontierKeys(engine: Engine): Set<string> {
  return new Set(engine.registry.frontier().map(coords.key));
}

describe("the frontier", () => {
  test("the world seeds itself with one sector", () => {
    const engine = makeEngine();
    assert.equal(engine.store.count(), 1);
    assert.notEqual(engine.store.get(ORIGIN), null);
  });

  test("the frontier is every side of every sector", () => {
    // Any side can take a neighbour — there are no sealed edges.
    const engine = makeEngine();
    const expected = new Set(
      coords.neighbours(ORIGIN).map(([, neighbour]) => coords.key(neighbour)),
    );
    assert.deepEqual(frontierKeys(engine), expected);
  });

  test("the frontier grows as the world does", () => {
    const engine = makeEngine();
    build(engine, [0, 1]);
    const frontier = frontierKeys(engine);
    assert.ok(frontier.has(coords.key(coord(0, 2))));
    assert.ok(frontier.has(coords.key(coord(1, 1))));
    assert.ok(!frontier.has(coords.key(ORIGIN)));
  });

  test("allocation never hands out the same sector twice", () => {
    const engine = makeEngine();
    const seen = new Set<string>();
    for (let index = 0; index < 4; index += 1) {
      const { agent } = engine.register(`a${index}`);
      const claim = engine.claim(agent);
      const k = coords.key(claim.coordinate);
      assert.ok(!seen.has(k), "handed out a coordinate twice");
      seen.add(k);
    }
  });

  test("running out of frontier is a clean retryable refusal", () => {
    // Only reachable while the frontier is tiny — four slots at genesis.
    const engine = makeEngine();
    for (let index = 0; index < 4; index += 1) {
      const { agent } = engine.register(`a${index}`);
      engine.claim(agent);
    }
    const { agent } = engine.register("one-too-many");
    try {
      engine.claim(agent);
      assert.fail("expected a refusal");
    } catch (exc) {
      assert.ok(exc instanceof SectorUnavailable);
      assert.equal(exc.code, "frontier_busy");
      assert.ok(exc.retryable);
    }
  });

  test("allocation does not prefer well-connected slots", () => {
    // A pocket is worth no more than the end of a limb. The world is meant to
    // sprawl organically, corridors included, so the only rule is adjacency.
    // This asserts the absence of the old fill-the-pockets heuristic.
    //
    // An L: [1,1] touches two sectors, [3,0] touches one.
    const pocket = coords.key(coord(1, 1));
    const limbEnd = coords.key(coord(3, 0));

    const chosen = new Set<string>();
    for (let seed = 0; seed < 60; seed += 1) {
      const store = new WorldStore();
      const registry = new Registry(store, { rng: seeded(seed) });
      const engine = new Engine({ store, registry });
      build(engine, [1, 0]);
      build(engine, [2, 0]);
      build(engine, [0, 1]);

      const { agent } = engine.register("a");
      chosen.add(coords.key(engine.claim(agent).coordinate));
    }

    assert.ok(chosen.has(pocket), "a pocket must be reachable");
    assert.ok(chosen.has(limbEnd), "a slot with one neighbour must still be reachable");
  });
});

describe("leases", () => {
  test("an expired lease returns the sector to the frontier", () => {
    const engine = makeEngine({ leaseSeconds: 0 });
    const { agent } = engine.register("slow");
    const claim = engine.claim(agent);

    assert.ok(!isActive(claim));
    assert.ok(frontierKeys(engine).has(coords.key(claim.coordinate)));
    assert.equal(engine.registry.getClaim(claim.claimId)?.status, ClaimStatus.EXPIRED);
  });

  test("an agent whose lease lapsed may claim again", () => {
    const engine = makeEngine({ leaseSeconds: 0 });
    const { agent } = engine.register("slow");
    engine.claim(agent);
    assert.notEqual(engine.claim(agent), null);
  });

  test("a live lease holds its sector against other agents", () => {
    const engine = makeEngine();
    const { agent } = engine.register("holder");
    const claim = engine.claim(agent);
    assert.ok(!frontierKeys(engine).has(coords.key(claim.coordinate)));
  });

  test("an agent cannot hold two claims at once", () => {
    const engine = makeEngine();
    const { agent } = engine.register("greedy");
    engine.claim(agent);
    try {
      engine.claim(agent);
      assert.fail("expected a refusal");
    } catch (exc) {
      assert.ok(exc instanceof SectorUnavailable);
      assert.equal(exc.code, "claim_in_progress");
      assert.ok(exc.retryable);
    }
  });

  test("releasing frees the sector but keeps the agent", () => {
    const engine = makeEngine();
    const { agent, token } = engine.register("quitter");
    const claim = engine.claim(agent);
    engine.release(claim);

    assert.ok(frontierKeys(engine).has(coords.key(claim.coordinate)));
    // The token survives — an agent that gave up may try again.
    assert.equal(engine.registry.authenticate(token), agent);
    assert.notEqual(engine.claim(agent), null);
  });
});

describe("submitting a sector", () => {
  test("a clean submission bakes and settles the agent", () => {
    const engine = makeEngine({ cooldownSeconds: 3600 });
    const { agent } = engine.register("architect");
    const claim = engine.claim(agent);

    const { errors } = engine.submitSector(
      agent,
      claim,
      sector(coords.asList(claim.coordinate)),
    );
    assert.deepEqual(errors, []);
    assert.notEqual(engine.store.get(claim.coordinate), null);
    assert.equal(engine.registry.getClaim(claim.claimId)?.status, ClaimStatus.BAKED);
    assert.deepEqual(agent.coordinate, claim.coordinate);
    assert.ok(cooldownRemaining(agent) > 0);
  });

  test("the token survives baking", () => {
    // The sector is permanent; the agent is not spent. It comes back.
    const engine = makeEngine();
    const { agent, token } = settle(engine);
    assert.equal(engine.registry.authenticate(token), agent);
  });

  test("an agent gets exactly one sector ever", () => {
    const engine = makeEngine();
    const { agent } = settle(engine);
    try {
      engine.claim(agent);
      assert.fail("expected a refusal");
    } catch (exc) {
      assert.ok(exc instanceof SectorUnavailable);
      assert.equal(exc.code, "already_settled");
    }
  });

  test("a settled agent is told never to retry", () => {
    // The one refusal that retrying can never fix must say so.
    const engine = makeEngine();
    const { agent } = settle(engine);
    try {
      engine.claim(agent);
      assert.fail("expected a refusal");
    } catch (exc) {
      assert.ok(exc instanceof SectorUnavailable);
      assert.ok(!exc.retryable);
      assert.match(exc.message, /Do not retry/);
    }
  });

  test("a rejected submission leaves the lease live", () => {
    const engine = makeEngine();
    const { agent } = engine.register("architect");
    const claim = engine.claim(agent);

    const { baked, errors } = engine.submitSector(
      agent,
      claim,
      sector(coords.asList(claim.coordinate), { title: "" }),
    );
    assert.equal(baked, null);
    assert.ok(codes(errors).has("empty_text"));
    assert.ok(isActive(claim));
    assert.equal(agent.coordinate, null);
    assert.equal(claim.attempts, 1);
  });

  test("the dry run never touches the world", () => {
    const engine = makeEngine();
    const { agent } = engine.register("careful");
    const claim = engine.claim(agent);

    const before = engine.store.count();
    const { errors } = engine.checkSector(claim, sector(coords.asList(claim.coordinate)));
    assert.deepEqual(errors, []);
    assert.equal(engine.store.count(), before);
  });

  test("the static lock refuses a rewrite", () => {
    const engine = makeEngine();
    build(engine, [0, 1]);
    assert.throws(() => build(engine, [0, 1]), AlreadyBaked);
  });
});

describe("what a claim reveals", () => {
  test("a claim reveals nothing about the neighbours", () => {
    // The withholding is the mechanism, so it gets a test of its own.
    const engine = makeEngine();
    build(engine, [0, 1], {
      overrides: { title: "The Tell-Tale Orangery", long_description: "Moths, mostly." },
    });
    const { agent } = engine.register("architect");
    const claim = engine.claim(agent);

    const serialised = JSON.stringify(engine.claimContext(claim));
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

  test("a claim reveals the coordinate and the clock", () => {
    const engine = makeEngine();
    const { agent } = engine.register("architect");
    const claim = engine.claim(agent);
    const context = engine.claimContext(claim);

    assert.deepEqual(context["coordinate"], coords.asList(claim.coordinate));
    const claimPayload = context["claim"] as Record<string, number>;
    assert.ok(claimPayload["expires_in"]! > 0);
  });
});

describe("the contribution clock", () => {
  test("an unsettled agent has nothing to furnish", () => {
    const engine = makeEngine();
    const { agent } = engine.register("drifter");
    assert.throws(() => engine.createObject(agent, obj("sec_whatever")), SectorRequired);
  });

  test("a fresh sector starts a cooldown", () => {
    const engine = makeEngine({ cooldownSeconds: 3600 });
    const { agent } = settle(engine);
    assert.throws(() => engine.createObject(agent, obj("sec_whatever")), NotYet);
  });

  test("an elapsed cooldown allows exactly one object", () => {
    const engine = makeEngine({ cooldownSeconds: 0 });
    const { agent } = settle(engine);

    const { object, errors } = engine.createObject(
      agent,
      obj(root(engine, agent), { title: "One" }),
    );
    assert.deepEqual(errors, []);
    assert.notEqual(object, null);
    assert.equal(agent.objectsCreated, 1);
  });

  test("each object restarts the clock", () => {
    const engine = makeEngine({ cooldownSeconds: 3600 });
    const { agent } = settle(engine);
    agent.nextContributionAt = 0; // as if the first cooldown had elapsed

    engine.createObject(agent, obj(root(engine, agent)));
    assert.equal(agent.objectsCreated, 1);
    assert.ok(cooldownRemaining(agent) > 0, "placing an object must restart the clock");
    assert.throws(() => engine.createObject(agent, obj("sec_whatever")), NotYet);
  });

  test("a rejected object does not spend the cooldown", () => {
    const engine = makeEngine({ cooldownSeconds: 0 });
    const { agent } = settle(engine);

    const { object, errors } = engine.createObject(agent, obj("obj_nope"));
    assert.equal(object, null);
    assert.ok(codes(errors).has("no_such_parent"));
    assert.equal(agent.objectsCreated, 0);
    assert.equal(cooldownRemaining(agent), 0);
  });

  test("objects accumulate into a tree", () => {
    const engine = makeEngine({ cooldownSeconds: 0 });
    const { agent } = settle(engine);

    const { object: can } = engine.createObject(
      agent,
      obj(root(engine, agent), { title: "Watering Can" }),
    );
    engine.createObject(agent, obj(can!.objectId, { title: "Key" }));
    engine.createObject(agent, obj(root(engine, agent), { title: "Label" }));

    const tree = engine.objectTree(agent.coordinate!);
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

describe("the read model", () => {
  test("exits are derived from adjacency alone", () => {
    const engine = makeEngine();
    build(engine, [0, 1], {
      overrides: { title: "North Place", short_description: "A glimpse north." },
    });
    build(engine, [1, 0], {
      overrides: { title: "East Place", short_description: "A glimpse east." },
    });

    const view = engine.sectorView(ORIGIN)!;
    const exits = view["exits"] as { direction: string; name: string; description: string }[];
    const byDirection = new Map(exits.map((e) => [e.direction, e]));
    assert.deepEqual(new Set(byDirection.keys()), new Set(["north", "east"]));
    assert.equal(byDirection.get("north")!.name, "North Place");
    assert.equal(byDirection.get("north")!.description, "A glimpse north.");
  });

  test("every adjacency produces an exit in both directions", () => {
    // Neither side declares the door, so neither side can disagree.
    const engine = makeEngine();
    build(engine, [0, 1], { overrides: { title: "North Place" } });

    const southSide = engine.sectorView(ORIGIN)!["exits"] as { direction: string; name: string }[];
    const northSide = engine.sectorView(coord(0, 1))!["exits"] as {
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

  test("the player's view shows the long description and object titles", () => {
    const engine = makeEngine({ cooldownSeconds: 0 });
    const { agent } = settle(engine);
    engine.createObject(
      agent,
      obj(root(engine, agent), { title: "A Thing", description: "Longer detail." }),
    );

    const view = engine.sectorView(agent.coordinate!)!;
    assert.equal(view["description"], "It is a place, and it is here.");
    const things = view["things_you_can_see"] as { title: string }[];
    assert.deepEqual(
      things.map((t) => t.title),
      ["A Thing"],
    );
    // The detail is only on the object itself, not spilled into the room.
    assert.ok(!JSON.stringify(view).includes("Longer detail."));
  });

  test("looking at an object shows its description and contents", () => {
    const engine = makeEngine({ cooldownSeconds: 0 });
    const { agent } = settle(engine);
    const { object: can } = engine.createObject(
      agent,
      obj(root(engine, agent), { title: "Can", description: "Dented." }),
    );
    engine.createObject(agent, obj(can!.objectId, { title: "Key" }));

    const view = engine.objectView(can!.objectId)!;
    assert.equal(view["description"], "Dented.");
    const things = view["things_you_can_see"] as { title: string }[];
    assert.deepEqual(
      things.map((t) => t.title),
      ["Key"],
    );
  });

  test("nested objects do not appear at sector level", () => {
    const engine = makeEngine({ cooldownSeconds: 0 });
    const { agent } = settle(engine);
    const { object: can } = engine.createObject(agent, obj(root(engine, agent), { title: "Can" }));
    engine.createObject(agent, obj(can!.objectId, { title: "Key" }));

    const view = engine.sectorView(agent.coordinate!)!;
    const things = view["things_you_can_see"] as { title: string }[];
    assert.deepEqual(
      things.map((t) => t.title),
      ["Can"],
    );
  });

  test("a deep chain walks correctly", () => {
    const engine = makeEngine({ cooldownSeconds: 0 });
    const { agent } = settle(engine);

    let parentId = root(engine, agent);
    for (let depth = 0; depth < 12; depth += 1) {
      const { object } = engine.createObject(agent, obj(parentId, { title: `level-${depth}` }));
      parentId = object!.objectId;
    }

    let node = engine.objectTree(agent.coordinate!);
    for (let depth = 0; depth < 12; depth += 1) {
      assert.equal(node.length, 1);
      assert.equal(node[0]!.title, `level-${depth}`);
      node = node[0]!.contains;
    }
    assert.deepEqual(node, []);
  });
});
