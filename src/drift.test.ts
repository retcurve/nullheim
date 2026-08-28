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
import { OBJECTS_PER_SECTOR } from "./registry.ts";
import {
  MAX_LONG_DESCRIPTION_LEN,
  MAX_OBJECT_DESCRIPTION_LEN,
  MAX_SHORT_DESCRIPTION_LEN,
  MAX_TITLE_LEN,
  OBJECT_FIELDS,
  SECTOR_FIELDS,
  parseObject,
  parseSector,
} from "./schema.ts";
import { makeEngine } from "./testing.ts";
import { ROUTES } from "./api.ts";
import { onboardingDocument, EXAMPLE_OBJECT, EXAMPLE_SECTOR } from "./onboarding.ts";

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
    for (const field of [...SECTOR_FIELDS, ...OBJECT_FIELDS]) {
      assert.ok(SCHEMA_DOC.includes(`\`${field}\``), field);
    }
  });

  test("the prompts state the current limits", () => {
    for (const limit of [MAX_TITLE_LEN, MAX_SHORT_DESCRIPTION_LEN, MAX_LONG_DESCRIPTION_LEN]) {
      assert.ok(SECTOR_PROMPT.includes(String(limit)), String(limit));
    }
    for (const limit of [MAX_TITLE_LEN, MAX_OBJECT_DESCRIPTION_LEN]) {
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

describe("the worked examples must be submittable, not just plausible", () => {
  test("the sector examples parse without a single error", () => {
    const blocks = jsonBlocks(SECTOR_PROMPT);
    assert.ok(blocks.length >= 3); // the skeleton plus two sectors
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

describe("placeholders", () => {
  test("the sector prompt is fully filled", async () => {
    const { engine } = await makeEngine();
    const { agent } = await engine.register("architect");
    const claim = await engine.claim(agent);
    const rendered = await engine.renderSectorPrompt(agent, claim);
    assert.ok(!rendered.includes("{{"));
    assert.ok(rendered.includes(`[${claim.coordinate.x}, ${claim.coordinate.y}]`));
    assert.ok(rendered.includes(claim.claimId));
    // Nothing built yet, so the one thing it must not do is look like a list.
    assert.ok(rendered.includes("nothing yet"));
  });

  // The rule this feeds — build nothing you have already built — is
  // unenforceable and unstateable unless the agent is shown its own back
  // catalogue, so an empty `{{held}}` is the whole feature failing silently.
  test("the sector prompt shows the agent what it has already built", async () => {
    const { engine } = await makeEngine({ cooldownSeconds: 0 });
    const { agent } = await engine.register("architect");
    const first = await engine.claim(agent);
    await engine.submitSector(agent, first, {
      coordinate: [first.coordinate.x, first.coordinate.y],
      title: "The Moth Orangery",
      short_description: "Green glass and iron, and behind it something white moving in slow numbers.",
      long_description: "d",
    });
    for (let i = 0; i < OBJECTS_PER_SECTOR; i++) {
      await engine.createObject(agent, {
        parent_id: (await engine.store.get(first.coordinate))!.sectorId,
        title: `Thing ${i}`,
        description: "d",
      });
    }

    const second = await engine.claim(agent);
    const rendered = await engine.renderSectorPrompt(agent, second);
    assert.ok(!rendered.includes("{{"));
    assert.ok(rendered.includes("The Moth Orangery"));
    assert.ok(rendered.includes("something white moving in slow numbers"));
    assert.ok(rendered.includes(`[${first.coordinate.x}, ${first.coordinate.y}]`));
  });

  test("the object prompt is fully filled and lists what is there", async () => {
    const { engine } = await makeEngine({ cooldownSeconds: 0 });
    const { agent, token: _t } = await engine.register("architect");
    const claim = await engine.claim(agent);
    await engine.submitSector(agent, claim, {
      coordinate: [claim.coordinate.x, claim.coordinate.y],
      title: "A Place",
      short_description: "d",
      long_description: "d",
    });
    const { object: placed } = await engine.createObject(agent, {
      parent_id: (await engine.store.get(claim.coordinate))!.sectorId,
      title: "Brass Can",
      description: "d",
    });

    const rendered = await engine.renderObjectPrompt(agent);
    assert.ok(!rendered.includes("{{"));
    assert.ok(rendered.includes(placed!.objectId));
    assert.ok(rendered.includes("Brass Can"));
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
    assert.ok(rendered.includes("nothing yet"));
  });
});

describe("the onboarding document", () => {
  function document(cooldownSeconds = 28800): string {
    return onboardingDocument(cooldownSeconds);
  }

  test("it names every field an agent must write", () => {
    for (const field of [...SECTOR_FIELDS, ...OBJECT_FIELDS]) {
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
  });

  test("the examples it shows are the ones it embeds", () => {
    // The prose must show the same JSON the drift test just validated.
    const blocks = jsonBlocks(document()).map((b) => JSON.parse(b));
    assert.ok(blocks.some((b) => JSON.stringify(b) === JSON.stringify(EXAMPLE_SECTOR)));
    assert.ok(blocks.some((b) => JSON.stringify(b) === JSON.stringify(EXAMPLE_OBJECT)));
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
    assert.ok(document(28800).includes("8 hours"));
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
