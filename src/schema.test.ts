/** Structural parsing: shape and type conformance. */

import { test, describe } from "node:test";
import assert from "node:assert/strict";

import { coord } from "./coords.ts";
import {
  MAX_INTERACTION_TEXT_LEN,
  MAX_LONG_DESCRIPTION_LEN,
  MAX_OBJECT_DESCRIPTION_LEN,
  MAX_SHORT_DESCRIPTION_LEN,
  MAX_TITLE_LEN,
  parseInteraction,
  parseObject,
  parseSector,
  sectorAsDict,
} from "./schema.ts";
import { codes, interaction, obj, sector } from "./testing.ts";

describe("parsing a sector", () => {
  test("a minimal sector parses clean", () => {
    const { parsed, errors } = parseSector(sector([0, 1]));
    assert.deepEqual(errors, []);
    assert.deepEqual(parsed?.coordinate, coord(0, 1));
  });

  test("a non-object payload is rejected", () => {
    const { parsed, errors } = parseSector(["not", "an", "object"]);
    assert.equal(parsed, null);
    assert.deepEqual(codes(errors), new Set(["type_error"]));
  });

  test("a coordinate must be two integers", () => {
    for (const bad of [[0], [0, 1, 0], [0, "y"], [true, 0], "0,1"]) {
      const { parsed, errors } = parseSector(sector([0, 1], { coordinate: bad }));
      assert.equal(parsed, null, `expected ${JSON.stringify(bad)} to be refused`);
      assert.deepEqual(codes(errors), new Set(["type_error"]));
    }
  });

  test("all three texts are required", () => {
    for (const field of ["title", "short_description", "long_description"]) {
      let result = parseSector(sector([0, 1], { [field]: "  " }));
      assert.ok(codes(result.errors).has("empty_text"), `${field} blank`);
      result = parseSector(sector([0, 1], { [field]: null }));
      assert.ok(codes(result.errors).has("type_error"), `${field} null`);
    }
  });

  test("each text has its own cap", () => {
    const caps: Record<string, number> = {
      title: MAX_TITLE_LEN,
      short_description: MAX_SHORT_DESCRIPTION_LEN,
      long_description: MAX_LONG_DESCRIPTION_LEN,
    };
    for (const [field, cap] of Object.entries(caps)) {
      let result = parseSector(sector([0, 1], { [field]: "x".repeat(cap + 1) }));
      assert.ok(codes(result.errors).has("too_long"), `${field} over cap`);
      result = parseSector(sector([0, 1], { [field]: "x".repeat(cap) }));
      assert.deepEqual(result.errors, [], `${field} exactly at cap`);
    }
  });

  test("caps count characters, not UTF-16 code units", () => {
    // "𝔊" has a JavaScript .length of 2 but counts as 1 character.
    const astral = "𝔊".repeat(MAX_TITLE_LEN);
    const { errors } = parseSector(sector([0, 1], { title: astral }));
    assert.deepEqual(errors, []);

    const overBy_one = "𝔊".repeat(MAX_TITLE_LEN + 1);
    const result = parseSector(sector([0, 1], { title: overBy_one }));
    assert.ok(codes(result.errors).has("too_long"));
  });

  test("declared exits are rejected as an unknown field", () => {
    const { errors } = parseSector(sector([0, 1], { exits: [{ direction: "north" }] }));
    assert.ok(codes(errors).has("unknown_field"));
  });

  test("control characters are rejected, but tab and newline are not", () => {
    let result = parseSector(sector([0, 1], { long_description: "a\x07b" }));
    assert.ok(codes(result.errors).has("control_characters"));

    result = parseSector(sector([0, 1], { long_description: "a\nb\tc" }));
    assert.deepEqual(result.errors, []);
  });

  test("an oversized payload is rejected outright", () => {
    const { parsed, errors } = parseSector(sector([0, 1], { title: "x".repeat(40_000) }));
    assert.equal(parsed, null);
    assert.ok(codes(errors).has("too_large"));
  });

  test("a round trip through the wire form is stable", () => {
    const first = parseSector(sector([2, -3]));
    assert.deepEqual(first.errors, []);
    const second = parseSector(sectorAsDict(first.parsed!));
    assert.deepEqual(second.errors, []);
    assert.deepEqual(second.parsed, first.parsed);
  });
});

describe("parsing an object", () => {
  test("a minimal object parses clean", () => {
    const { parsed, errors } = parseObject(obj("sec_abc123"));
    assert.deepEqual(errors, []);
    assert.equal(parsed?.parentId, "sec_abc123");
  });

  test("a parent id may be a sector id or an object id", () => {
    const { parsed, errors } = parseObject(obj("obj_abc123"));
    assert.deepEqual(errors, []);
    assert.equal(parsed?.parentId, "obj_abc123");
  });

  test("a null parent id is rejected", () => {
    const { errors } = parseObject(obj(null));
    assert.ok(codes(errors).has("type_error"));
  });

  test("a missing parent id is rejected", () => {
    const payload = obj("sec_abc123");
    delete payload["parent_id"];
    const { errors } = parseObject(payload);
    assert.ok(codes(errors).has("type_error"));
  });

  test("a non-string parent is rejected", () => {
    const { errors } = parseObject(obj(17));
    assert.ok(codes(errors).has("type_error"));
  });

  test("a blank parent id is rejected", () => {
    const { errors } = parseObject(obj("   "));
    assert.ok(codes(errors).has("type_error"));
  });

  test("title and description are required", () => {
    for (const field of ["title", "description"]) {
      const { errors } = parseObject(obj("sec_abc123", { [field]: "" }));
      assert.ok(codes(errors).has("empty_text"), field);
    }
  });

  test("the description has its own, larger cap", () => {
    let result = parseObject(
      obj("sec_abc123", { description: "x".repeat(MAX_OBJECT_DESCRIPTION_LEN) }),
    );
    assert.deepEqual(result.errors, []);
    result = parseObject(
      obj("sec_abc123", { description: "x".repeat(MAX_OBJECT_DESCRIPTION_LEN + 1) }),
    );
    assert.ok(codes(result.errors).has("too_long"));
  });

  test("unknown fields are reported", () => {
    const { errors } = parseObject(
      obj("sec_abc123", { weight_class: "light", is_weapon: false }),
    );
    assert.ok(codes(errors).has("unknown_field"));
  });

  test("use_text is optional and absent by default", () => {
    const { parsed, errors } = parseObject(obj("sec_abc123"));
    assert.deepEqual(errors, []);
    assert.equal(parsed?.useText, null);
  });

  test("use_text, when given, follows the same text rules as any other field", () => {
    let result = parseObject(obj("sec_abc123", { use_text: "It creaks, then gives." }));
    assert.deepEqual(result.errors, []);
    assert.equal(result.parsed?.useText, "It creaks, then gives.");

    result = parseObject(obj("sec_abc123", { use_text: "   " }));
    assert.ok(codes(result.errors).has("empty_text"));

    result = parseObject(obj("sec_abc123", { use_text: "x".repeat(MAX_INTERACTION_TEXT_LEN + 1) }));
    assert.ok(codes(result.errors).has("too_long"));
  });
});

describe("parsing an interaction", () => {
  test("a minimal interaction parses clean", () => {
    const { parsed, errors } = parseInteraction(interaction("obj_a", "obj_b"));
    assert.deepEqual(errors, []);
    assert.equal(parsed?.objectAId, "obj_a");
    assert.equal(parsed?.objectBId, "obj_b");
  });

  test("both object ids are required", () => {
    for (const field of ["object_a_id", "object_b_id"]) {
      const payload = interaction("obj_a", "obj_b");
      delete payload[field];
      const { errors } = parseInteraction(payload);
      assert.ok(codes(errors).has("type_error"), field);
    }
  });

  test("a blank object id is rejected", () => {
    const { errors } = parseInteraction(interaction("   ", "obj_b"));
    assert.ok(codes(errors).has("type_error"));
  });

  test("text is required and capped", () => {
    let result = parseInteraction(interaction("obj_a", "obj_b", { text: "" }));
    assert.ok(codes(result.errors).has("empty_text"));

    result = parseInteraction(interaction("obj_a", "obj_b", { text: "x".repeat(MAX_INTERACTION_TEXT_LEN) }));
    assert.deepEqual(result.errors, []);

    result = parseInteraction(
      interaction("obj_a", "obj_b", { text: "x".repeat(MAX_INTERACTION_TEXT_LEN + 1) }),
    );
    assert.ok(codes(result.errors).has("too_long"));
  });

  test("unknown fields are reported", () => {
    const { errors } = parseInteraction(interaction("obj_a", "obj_b", { state: "used" }));
    assert.ok(codes(errors).has("unknown_field"));
  });
});
