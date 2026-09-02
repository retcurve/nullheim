/**
 * The contract is stated three times. These tests keep the three in agreement.
 *
 * `schema.ts` is the source of truth. The prompts tell agents what to emit and
 * the docs tell their authors the same thing — if either drifts from the
 * schema, agents get rejected for obeying instructions that are no longer true.
 */

import { test, describe } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { join, dirname } from "node:path";

import { Direction } from "./coords.ts";
import { DEFAULT_COOLDOWN_SECONDS } from "./registry.ts";
import {
  INTERACTION_FIELDS,
  MAX_INTERACTION_TEXT_LEN,
  MAX_LONG_DESCRIPTION_LEN,
  MAX_OBJECT_DESCRIPTION_LEN,
  MAX_SHORT_DESCRIPTION_LEN,
  MAX_TITLE_LEN,
  OBJECT_FIELDS,
  SECTOR_FIELDS,
  parseInteraction,
  parseObject,
  parseSector,
} from "./schema.ts";
import { makeEngine } from "./testing.ts";
import { ROUTES } from "./api.ts";
import {
  onboardingDocument,
  EXAMPLE_INTERACTION,
  EXAMPLE_OBJECT,
  EXAMPLE_SECTOR,
} from "./onboarding.ts";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const SECTOR_PROMPT = readFileSync(join(ROOT, "prompts", "sector_architect.md"), "utf-8");
const OBJECT_PROMPT = readFileSync(join(ROOT, "prompts", "object_artisan.md"), "utf-8");
const SCHEMA_DOC = readFileSync(join(ROOT, "docs", "SCHEMA.md"), "utf-8");
const API_DOC = readFileSync(join(ROOT, "docs", "API.md"), "utf-8");

function jsonBlocks(text: string): string[] {
  const blocks: string[] = [];
  let inside: string[] = [];
  let fence = false;
  for (const line of text.split("\n")) {
    if (line.trim() === "```json") {
      fence = true;
      inside = [];
      continue;
    }
    if (fence && line.trim() === "```") {
      fence = false;
      blocks.push(inside.join("\n"));
      continue;
    }
    if (fence) {
      inside.push(line);
    }
  }
  return blocks;
}

describe("field inventories", () => {
  test("each prompt names every field of its own schema", () => {
    for (const field of SECTOR_FIELDS) {
      assert.ok(SECTOR_PROMPT.includes(`"${field}"`), field);
    }
    for (const field of OBJECT_FIELDS) {
      assert.ok(OBJECT_PROMPT.includes(`"${field}"`), field);
    }
  });

  test("the schema doc names every field", () => {
    for (const field of [...SECTOR_FIELDS, ...OBJECT_FIELDS, ...INTERACTION_FIELDS]) {
      assert.ok(SCHEMA_DOC.includes(`\`${field}\``), field);
    }
  });

  test("the object prompt names every interaction field", () => {
    // Interactions are authored by a separate call, after both objects
    // already exist, so they get prose in the object prompt rather than a
    // fenced JSON block of their own — see the "the object examples parse"
    // test below, which would otherwise try to validate it as an object.
    for (const field of INTERACTION_FIELDS) {
      assert.ok(OBJECT_PROMPT.includes(`\`${field}\``), field);
    }
  });

  test("the prompts state the current limits", () => {
    for (const limit of [MAX_TITLE_LEN, MAX_SHORT_DESCRIPTION_LEN, MAX_LONG_DESCRIPTION_LEN]) {
      assert.ok(SECTOR_PROMPT.includes(String(limit)), String(limit));
    }
    for (const limit of [MAX_TITLE_LEN, MAX_OBJECT_DESCRIPTION_LEN, MAX_INTERACTION_TEXT_LEN]) {
      assert.ok(OBJECT_PROMPT.includes(String(limit)), String(limit));
    }
  });

  test("the grid is documented as flat", () => {
    // A prompt that still mentions up or down would produce bad titles.
    assert.ok(SECTOR_PROMPT.includes("no up or down"));
    for (const direction of Object.values(Direction)) {
      assert.ok(SECTOR_PROMPT.includes(direction), direction);
    }
    for (const stale of ['"up"', '"down"', '"exits"', "weight_class"]) {
      assert.ok(!SECTOR_PROMPT.includes(stale), stale);
      assert.ok(!OBJECT_PROMPT.includes(stale), stale);
    }
  });
});

/**
 * Agents come back every 6 hours forever, so most of them schedule it — and
 * a scheduled task that carries a copy of the prompt text runs that copy long
 * after the server stopped serving it. A stale copy cannot report its own
 * staleness, so the only place the warning works is inside the prompt itself:
 * copied into the cron, it travels with the copy and tells the reader to go
 * and fetch the live one.
 */
describe("a served prompt says it is live", () => {
  test("each prompt tells the reader not to save it into a scheduled task", () => {
    for (const [name, text] of [
      ["sector", SECTOR_PROMPT],
      ["object", OBJECT_PROMPT],
      ["onboarding", onboardingDocument(DEFAULT_COOLDOWN_SECONDS)],
    ] as const) {
      assert.ok(text.includes("scheduled task"), name);
      assert.match(text, /supersedes|replaces anything you have saved|the copy is wrong|stored copy is wrong/, name);
    }
  });
});

describe("the worked examples must be submittable, not just plausible", () => {
  test("the sector examples parse without a single error", () => {
    const blocks = jsonBlocks(SECTOR_PROMPT);
    assert.ok(blocks.length >= 2); // the skeleton plus one sector
    for (const block of blocks.slice(1)) {
      const { parsed, errors } = parseSector(JSON.parse(block));
      assert.deepEqual(errors, [], block.slice(0, 40));
      assert.notEqual(parsed, null);
    }
  });

  test("the object examples parse without a single error", () => {
    const blocks = jsonBlocks(OBJECT_PROMPT);
    assert.ok(blocks.length >= 3);
    for (const block of blocks.slice(1)) {
      const { parsed, errors } = parseObject(JSON.parse(block));
      assert.deepEqual(errors, [], block.slice(0, 40));
      assert.notEqual(parsed, null);
    }
  });
});

/**
 * "The roof coming down" and "the moment the boat is sighted" were worked
 * examples of what an event-sector could be, not content to be built. At
 * least one agent built the former literally. Naming a scene in a prompt puts
 * a well-written sentence about that scene in the context window, and it gets
 * absorbed regardless of the disclaiming prose around it — the same mechanism
 * `f6da09a` already found for object examples and titles (see CLAUDE.md's
 * "Even the example names carry genre"). The banned-furniture list ("old
 * books, ledgers, dust motes, hidden notes") had the identical problem from
 * the other side: it described the cliché being banned instead of banning it
 * by shape, which CLAUDE.md's own "prompts never describe the cliché they are
 * banning" rule rules out.
 *
 * These tests check the replacement phrasing stays in sync across all three
 * copies, not that the old strings are gone — a blocklist of retired phrases
 * guards against nobody, since no one retypes "the roof coming down" by
 * accident. The actual drift risk is a future edit rephrasing the ban in only
 * one of the three copies.
 */
describe("the moment and cliché guidance stays in sync across copies", () => {
  test("the event guidance bans by shape, not by naming a scene", () => {
    for (const [name, text] of [
      ["sector", SECTOR_PROMPT],
      ["onboarding", onboardingDocument(DEFAULT_COOLDOWN_SECONDS)],
    ] as const) {
      assert.ok(text.includes("mid-way through happening"), name);
    }
  });

  test("the cliché-furniture guidance bans by function, not by naming props", () => {
    for (const [name, text] of [
      ["sector", SECTOR_PROMPT],
      ["object", OBJECT_PROMPT],
      ["onboarding", onboardingDocument(DEFAULT_COOLDOWN_SECONDS)],
    ] as const) {
      assert.ok(text.replace(/\s+/g, " ").includes("signal age, disuse, or hidden meaning"), name);
    }
  });
});

describe("placeholders", () => {
  test("the sector prompt is fully filled", async () => {
    const { engine } = await makeEngine();
    const { agent } = await engine.register("architect");
    const claim = await engine.claim(agent);
    const rendered = await engine.renderSectorPrompt(claim);
    assert.ok(!rendered.includes("{{"));
    assert.ok(rendered.includes(`[${claim.coordinate.x}, ${claim.coordinate.y}]`));
    assert.ok(rendered.includes(claim.claimId));
  });

  /**
   * A cold start is the feature. The prompt used to interpolate the agent's
   * own back catalogue under a rule to repeat none of it, and that produced
   * the opposite: a list of what a model has already made reads as a series
   * to continue, and the label on it does not decide otherwise. The preview
   * world's most prolific agent wrote a kite-strung canyon, a low-gravity
   * wreck and a hollowed fungus before the list existed, and a uniform run of
   * plain industrial rooms after it.
   *
   * So the seventh prompt is byte-identical to the first, deliberately, and
   * this test fails if anything about the agent's other sectors leaks back
   * in.
   */
  test("the sector prompt reveals nothing about what the agent has already built", async () => {
    const { engine } = await makeEngine({ cooldownSeconds: 0 });
    const { agent } = await engine.register("architect");
    const first = await engine.claim(agent);
    await engine.submitSector(agent, first, {
      coordinate: [first.coordinate.x, first.coordinate.y],
      title: "The Moth Orangery",
      short_description: "Green glass and iron, and behind it something white moving in slow numbers.",
      long_description: "d",
    });
    const second = await engine.claim(agent);
    const rendered = await engine.renderSectorPrompt(second);
    assert.ok(!rendered.includes("{{"));
    assert.ok(!rendered.includes("The Moth Orangery"), "no title of a sector it holds");
    assert.ok(!rendered.includes("something white moving in slow numbers"), "no prose");
    assert.ok(
      !rendered.includes(`[${first.coordinate.x}, ${first.coordinate.y}]`),
      "no coordinate of a sector it holds",
    );

    // And the second prompt differs from the first only in the coordinate and
    // the claim it was issued for.
    const asFirst = rendered
      .replaceAll(`[${second.coordinate.x}, ${second.coordinate.y}]`, "<xy>")
      .replaceAll(second.claimId, "<claim>");
    const fresh = await engine.renderSectorPrompt(first);
    const asSecond = fresh
      .replaceAll(`[${first.coordinate.x}, ${first.coordinate.y}]`, "<xy>")
      .replaceAll(first.claimId, "<claim>");
    assert.equal(asFirst, asSecond);
  });

  test("the object prompt is fully filled and lists what is there", async () => {
    const { engine } = await makeEngine({ cooldownSeconds: 0 });
    const { agent } = await engine.register("architect");
    const claim = await engine.claim(agent);
    await engine.submitSector(agent, claim, {
      coordinate: [claim.coordinate.x, claim.coordinate.y],
      title: "A Place",
      short_description: "d",
      long_description: "long leavened diorama of the seams",
    });
    const { object: placed } = await engine.createObject(agent, {
      parent_id: (await engine.store.get(claim.coordinate))!.sectorId,
      title: "Brass Can",
      description: "grooved candid illustrated cagemate",
    });

    const rendered = await engine.renderObjectPrompt(agent);
    assert.ok(!rendered.includes("{{"));
    // The index is a count, not a tree: no object ids or titles at all, and
    // no prose. The sector's long description and the objects' own
    // descriptions are not dragged into it; the pointed-to endpoint is where
    // all of that lives.
    assert.ok(!rendered.includes(placed!.objectId));
    assert.ok(!rendered.includes("Brass Can"));
    assert.ok(rendered.includes("1 object"));
    assert.ok(rendered.includes("/v1/agents/sector/"));
    assert.ok(!rendered.includes("long leavened diorama of the seams"));
    assert.ok(!rendered.includes("grooved candid illustrated cagemate"));

    // And the detail endpoint has them.
    const sectorId = (await engine.store.get(claim.coordinate))!.sectorId;
    const detail = await engine.sectorContext(agent, sectorId);
    assert.notEqual(detail, null);
    assert.equal(detail!["long_description"], "long leavened diorama of the seams");
    const objects = detail!["objects"] as { title: string; description: string }[];
    assert.equal(objects[0]!.title, "Brass Can");
    assert.equal(objects[0]!.description, "grooved candid illustrated cagemate");
  });

  test("the object prompt copes with a bare sector", async () => {
    const { engine } = await makeEngine({ cooldownSeconds: 0 });
    const { agent } = await engine.register("architect");
    const claim = await engine.claim(agent);
    await engine.submitSector(agent, claim, {
      coordinate: [claim.coordinate.x, claim.coordinate.y],
      title: "A Place",
      short_description: "d",
      long_description: "d",
    });

    const rendered = await engine.renderObjectPrompt(agent);
    assert.ok(!rendered.includes("{{"));
    assert.ok(rendered.includes("0 objects"));
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

    // A sector the agent does not own is indistinguishable from a missing one.
    const { agent: other } = await engine.register("other");
    assert.equal(await engine.sectorContext(other, sectorId), null);
    assert.equal(await engine.sectorContext(agent, "sec_does_not_exist"), null);
  });
});

describe("the onboarding document", () => {
  function document(cooldownSeconds = DEFAULT_COOLDOWN_SECONDS): string {
    return onboardingDocument(cooldownSeconds);
  }

  test("it names every field an agent must write", () => {
    for (const field of [...SECTOR_FIELDS, ...OBJECT_FIELDS, ...INTERACTION_FIELDS]) {
      assert.ok(document().includes(`\`${field}\``), field);
    }
  });

  test("it states the current limits", () => {
    const text = document();
    for (const limit of [
      MAX_TITLE_LEN,
      MAX_SHORT_DESCRIPTION_LEN,
      MAX_LONG_DESCRIPTION_LEN,
      MAX_OBJECT_DESCRIPTION_LEN,
      MAX_INTERACTION_TEXT_LEN,
    ]) {
      assert.ok(text.includes(String(limit)), String(limit));
    }
  });

  test("its worked examples are actually submittable", () => {
    // A teaching example that the validator would reject is worse than none.
    let result = parseSector(EXAMPLE_SECTOR);
    assert.deepEqual(result.errors, []);
    assert.notEqual(result.parsed, null);

    const objectResult = parseObject(EXAMPLE_OBJECT);
    assert.deepEqual(objectResult.errors, []);
    assert.notEqual(objectResult.parsed, null);

    const interactionResult = parseInteraction(EXAMPLE_INTERACTION);
    assert.deepEqual(interactionResult.errors, []);
    assert.notEqual(interactionResult.parsed, null);
  });

  test("the examples it shows are the ones it embeds", () => {
    // The prose must show the same JSON the drift test just validated.
    const blocks = jsonBlocks(document()).map((b) => JSON.parse(b));
    assert.ok(blocks.some((b) => JSON.stringify(b) === JSON.stringify(EXAMPLE_SECTOR)));
    assert.ok(blocks.some((b) => JSON.stringify(b) === JSON.stringify(EXAMPLE_OBJECT)));
    assert.ok(blocks.some((b) => JSON.stringify(b) === JSON.stringify(EXAMPLE_INTERACTION)));
  });

  test("it describes the grid as flat and never declares exits", () => {
    const text = document();
    assert.ok(text.includes("no up or down"));
    for (const direction of Object.values(Direction)) {
      assert.ok(text.includes(direction), direction);
    }
    for (const stale of ['"up"', '"down"', '"exits"', "weight_class"]) {
      assert.ok(!text.includes(stale), stale);
    }
  });

  test("it reports the cooldown this server actually runs", () => {
    assert.ok(document().includes("6 hours"));
    assert.ok(document(0).includes("testing"));
  });
});

describe("the api doc", () => {
  test("lists every route", () => {
    for (const route of ROUTES) {
      const readable = route.source.replaceAll(String.raw`(-?\d+)`, "{n}").replaceAll(
        String.raw`([\w-]+)`,
        "{id}",
      );
      assert.ok(API_DOC.includes(readable), `${route.method} ${readable}`);
    }
  });
});
