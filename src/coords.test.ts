import { test, describe } from "node:test";
import assert from "node:assert/strict";

import {
  DIRECTIONS,
  Direction,
  MAX_XY,
  ORIGIN,
  asList,
  compare,
  coord,
  equals,
  fromKey,
  inBounds,
  key,
  neighbours,
  opposite,
  parse,
  step,
  toString,
} from "./coords.ts";

describe("parsing an untrusted coordinate", () => {
  test("two integers parse", () => {
    assert.deepEqual(parse([0, 1]), { x: 0, y: 1 });
    assert.deepEqual(parse([-3, 12]), { x: -3, y: 12 });
  });

  test("anything that is not exactly two integers is refused", () => {
    // The grid is flat — a three-component coordinate is a stale client.
    for (const bad of [[0], [0, 1, 0], [0, "y"], [true, 0], "0,1", null, {}, [1.5, 0]]) {
      assert.throws(() => parse(bad), Error, `expected ${JSON.stringify(bad)} to be refused`);
    }
  });

  test("booleans are not coordinates", () => {
    // Python had to reject these explicitly because bool subclasses int.
    assert.throws(() => parse([true, false]));
  });
});

describe("coordinates as keys", () => {
  test("the key round-trips", () => {
    for (const c of [ORIGIN, coord(3, 1), coord(-7, -12), coord(0, -1)]) {
      assert.deepEqual(fromKey(key(c)), c);
    }
  });

  test("equal coordinates produce the same key, unequal ones do not", () => {
    // This is the property that lets a Map stand in for Python's dict[Coordinate].
    assert.equal(key(coord(2, 3)), key(coord(2, 3)));
    assert.notEqual(key(coord(2, 3)), key(coord(3, 2)));
  });

  test("distinct objects with the same value collide in a Set, as they must", () => {
    // The bug this guards: Set<Coordinate> would hold both, and the frontier
    // index would double-count every slot.
    const seen = new Set([key(coord(1, 1)), key(coord(1, 1))]);
    assert.equal(seen.size, 1);
  });

  test("a malformed key is refused rather than silently becoming NaN", () => {
    for (const bad of ["", "1", "1,2,3", "a,b", "1,"]) {
      assert.throws(() => fromKey(bad), Error, `expected ${JSON.stringify(bad)} to be refused`);
    }
  });
});

describe("ordering", () => {
  test("sorts by x then y, matching Python's tuple order", () => {
    const sorted = [coord(1, 0), coord(0, 5), coord(0, -2), coord(-1, 9)].sort(compare);
    assert.deepEqual(sorted, [coord(-1, 9), coord(0, -2), coord(0, 5), coord(1, 0)]);
  });

  test("comparing a coordinate with itself is zero", () => {
    assert.equal(compare(coord(4, 4), coord(4, 4)), 0);
  });
});

describe("the lattice", () => {
  test("every direction has an opposite, and it is mutual", () => {
    for (const direction of DIRECTIONS) {
      assert.equal(opposite(opposite(direction)), direction);
    }
  });

  test("stepping and stepping back returns to where it started", () => {
    for (const direction of DIRECTIONS) {
      const there = step(ORIGIN, direction);
      assert.ok(equals(step(there, opposite(direction)), ORIGIN));
    }
  });

  test("a coordinate has exactly four neighbours, one per side", () => {
    const found = neighbours(coord(2, 2));
    assert.equal(found.length, 4);
    assert.deepEqual(
      found.map(([direction]) => direction),
      [...DIRECTIONS],
    );
  });

  test("north is positive y and east is positive x", () => {
    assert.deepEqual(step(ORIGIN, Direction.NORTH), coord(0, 1));
    assert.deepEqual(step(ORIGIN, Direction.EAST), coord(1, 0));
  });

  test("the bound is inclusive, and one past it is off the lattice", () => {
    assert.ok(inBounds(coord(MAX_XY, MAX_XY)));
    assert.ok(inBounds(coord(-MAX_XY, -MAX_XY)));
    assert.ok(!inBounds(coord(MAX_XY + 1, 0)));
    assert.ok(!inBounds(coord(0, -MAX_XY - 1)));
  });
});

describe("wire and display forms", () => {
  test("as a list, for JSON", () => {
    assert.deepEqual(asList(coord(2, -3)), [2, -3]);
  });

  test("as prose, for agent-facing messages", () => {
    assert.equal(toString(coord(2, -3)), "[2, -3]");
  });
});
