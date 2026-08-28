/** Structural parsing: shape and type conformance. */

import { test, describe } from "node:test";
import assert from "node:assert/strict";

import { coord } from "./coords.ts";
import {
  describeImage,
  MAX_IMAGE_HEIGHT,
  MAX_IMAGE_WIDTH,
  MAX_LONG_DESCRIPTION_LEN,
  MAX_OBJECT_DESCRIPTION_LEN,
  MAX_SHORT_DESCRIPTION_LEN,
  MAX_TITLE_LEN,
  parseObject,
  parseSector,
  sectorAsDict,
} from "./schema.ts";
import { codes, obj, sector } from "./testing.ts";

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
    // The grid is flat — a three-component coordinate is a stale client.
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
    // The hazard this guards: "𝔊".length is 2 in JavaScript and 1 in Python.
    // A title of exactly MAX_TITLE_LEN astral characters is legal, and a naive
    // .length would reject it as twice the size.
    const astral = "𝔊".repeat(MAX_TITLE_LEN);
    const { errors } = parseSector(sector([0, 1], { title: astral }));
    assert.deepEqual(errors, []);

    const overBy_one = "𝔊".repeat(MAX_TITLE_LEN + 1);
    const result = parseSector(sector([0, 1], { title: overBy_one }));
    assert.ok(codes(result.errors).has("too_long"));
  });

  test("declared exits are rejected as an unknown field", () => {
    // Exits are derived from adjacency; declaring them is a stale client.
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

  describe("the optional image", () => {
    test("is null when the field is absent or explicitly null", () => {
      let { parsed, errors } = parseSector(sector([0, 1]));
      assert.deepEqual(errors, []);
      assert.equal(parsed?.image, null);

      ({ parsed, errors } = parseSector(sector([0, 1], { image: null })));
      assert.deepEqual(errors, []);
      assert.equal(parsed?.image, null);
    });

    test("a plain ASCII multi-line image is accepted", () => {
      const art = "+----+\n|    |\n+----+";
      const { parsed, errors } = parseSector(sector([0, 1], { image: art }));
      assert.deepEqual(errors, []);
      assert.equal(parsed?.image, art);
    });

    test("non-ASCII characters our font can render are accepted", () => {
      for (const art of ["café", "🙂", "░▒▓█▓▒░"]) {
        const { parsed, errors } = parseSector(sector([0, 1], { image: art }));
        assert.deepEqual(errors, [], JSON.stringify(art));
        assert.equal(parsed?.image, art);
      }
    });

    test("a blank image is rejected rather than treated as absent", () => {
      const { errors } = parseSector(sector([0, 1], { image: "   " }));
      assert.ok(codes(errors).has("empty_text"));
    });

    test("a non-string image is rejected", () => {
      const { errors } = parseSector(sector([0, 1], { image: 12345 }));
      assert.ok(codes(errors).has("type_error"));
    });

    test("tabs and control characters are rejected — no glyph to render", () => {
      for (const bad of ["line one\tindented with a tab", "line one\x00line two", "esc\x1b[31m"]) {
        const { errors } = parseSector(sector([0, 1], { image: bad }));
        assert.ok(codes(errors).has("control_characters"), JSON.stringify(bad));
      }
    });

    test("a line over the width cap is rejected", () => {
      const tooWide = "x".repeat(MAX_IMAGE_WIDTH + 1);
      let { errors } = parseSector(sector([0, 1], { image: tooWide }));
      assert.ok(codes(errors).has("too_wide"));

      ({ errors } = parseSector(sector([0, 1], { image: "x".repeat(MAX_IMAGE_WIDTH) })));
      assert.deepEqual(errors, []);
    });

    test("more rows than the height cap is rejected", () => {
      const tooTall = Array(MAX_IMAGE_HEIGHT + 1).fill("x").join("\n");
      let { errors } = parseSector(sector([0, 1], { image: tooTall }));
      assert.ok(codes(errors).has("too_tall"));

      const exact = Array(MAX_IMAGE_HEIGHT).fill("x").join("\n");
      ({ errors } = parseSector(sector([0, 1], { image: exact })));
      assert.deepEqual(errors, []);
    });

    test("a single trailing newline doesn't count as an extra row", () => {
      const exact = Array(MAX_IMAGE_HEIGHT).fill("x").join("\n") + "\n";
      const { errors } = parseSector(sector([0, 1], { image: exact }));
      assert.deepEqual(errors, []);
    });
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
    // parent_id is required — null used to mean the sector itself; now the
    // sector's own id does, so there is nothing left for null to mean.
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
    // The UOI tags are gone — a client still sending them should hear so.
    const { errors } = parseObject(
      obj("sec_abc123", { weight_class: "light", is_weapon: false }),
    );
    assert.ok(codes(errors).has("unknown_field"));
  });

  describe("the optional image", () => {
    test("is null when the field is absent", () => {
      const { parsed, errors } = parseObject(obj("sec_abc123"));
      assert.deepEqual(errors, []);
      assert.equal(parsed?.image, null);
    });

    test("a plain ASCII image is accepted, sharing the sector's own limits", () => {
      const art = "   ___\n  /   \\\n |     |";
      const { parsed, errors } = parseObject(obj("sec_abc123", { image: art }));
      assert.deepEqual(errors, []);
      assert.equal(parsed?.image, art);
    });

    test("a non-ASCII image is accepted", () => {
      const { parsed, errors } = parseObject(obj("sec_abc123", { image: "🙂" }));
      assert.deepEqual(errors, []);
      assert.equal(parsed?.image, "🙂");
    });

    test("a tab is rejected, and oversized dimensions are rejected", () => {
      let { errors } = parseObject(obj("sec_abc123", { image: "a\tb" }));
      assert.ok(codes(errors).has("control_characters"));

      errors = parseObject(obj("sec_abc123", { image: "x".repeat(MAX_IMAGE_WIDTH + 1) })).errors;
      assert.ok(codes(errors).has("too_wide"));

      errors = parseObject(
        obj("sec_abc123", { image: Array(MAX_IMAGE_HEIGHT + 1).fill("x").join("\n") }),
      ).errors;
      assert.ok(codes(errors).has("too_tall"));
    });
  });
});

/**
 * The advisory geometry report. It never rejects anything — these assert that
 * it measures honestly and stays quiet when there is nothing to say.
 */
describe("describing an image's geometry", () => {
  test("an absent image is not described", () => {
    assert.deepEqual(describeImage(null), []);
  });

  test("a square drawing gets one line and no edge maps", () => {
    const notes = describeImage("┌──┐\n│▓▓│\n└──┘");
    assert.deepEqual(notes, ["image: 3 rows, every row ending at column 4."]);
  });

  test("a ragged right edge names the row that breaks the run", () => {
    // Rows 1, 2 and 4 end at column 5; row 3 stops one short of them.
    const notes = describeImage("█████\n█████\n████\n█████");
    const edges = notes.find((note) => note.startsWith("image right edge"));
    assert.ok(edges, notes.join("\n"));
    assert.match(edges!, /1-2:5, 3:4, 4:5/);
  });

  test("a deliberate silhouette is measured, never judged", () => {
    // A stepped shape is as ragged as a broken wall; the report says so
    // without calling either one wrong.
    const notes = describeImage("█\n███\n█████");
    assert.ok(notes.some((note) => note.includes("1:1, 2:3, 3:5")));
    assert.ok(!notes.some((note) => /error|invalid|wrong|must/i.test(note)));
  });

  test("a blank row is reported as blank rather than as column zero", () => {
    const notes = describeImage("██\n\n██");
    assert.ok(notes.some((note) => note.includes("2:blank")), notes.join("\n"));
  });

  test("columns are counted in code points, so astral characters do not double", () => {
    // "𝔊" is two UTF-16 units but one cell; a naive .length would say 3.
    const notes = describeImage("𝔊𝔊");
    assert.deepEqual(notes, ["image: 1 row, ending at column 2."]);
  });

  test("leading indentation is reported as a left edge, not trimmed away", () => {
    const notes = describeImage("  ██\n██");
    const left = notes.find((note) => note.startsWith("image left edge"));
    assert.ok(left, notes.join("\n"));
    assert.match(left!, /1:3, 2:1/);
  });
});
