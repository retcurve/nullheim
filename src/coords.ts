/**
 * Spatial primitives for the Mosaic grid.
 *
 * The world is a flat integer lattice — x and y only. A sector occupies exactly
 * one coordinate and is never moved, resized, or regenerated once baked.
 *
 * Porting note: Python's `Coordinate` was a NamedTuple, so it had value equality
 * and could be a dict key, a set member, and sortable for free. JavaScript's Map
 * and Set key on reference identity, which would silently break every index in
 * store.ts. So the canonical *key* here is the string form `"x,y"` — the same
 * spelling the JSON snapshot has always used — and `Coordinate` is only ever a
 * value. Anything keyed by coordinate must key on `CoordKey`, never the object.
 */

// An arbitrary sanity bound — nothing depends on this number. Agents never
// choose their own coordinate, so a submission can only carry an out-of-bounds
// one by driving the engine directly; its real effect is to stop the frontier
// growing past the wall. At the measured growth rate (radius roughly 0.6·√N)
// that does not bind until a few million sectors.
//
// The ceiling that would actually matter is 2**53 - 1: coordinates cross the
// wire as JSON numbers, and an agent written in JavaScript parses them to a
// double, so anything larger loses precision silently. In this implementation
// that is not merely a wire concern — it is the runtime's own integer limit.
export const MAX_XY = 1024;

export const Direction = {
  NORTH: "north",
  SOUTH: "south",
  EAST: "east",
  WEST: "west",
} as const;

export type Direction = (typeof Direction)[keyof typeof Direction];

/** Iteration order matters: it fixes the order exits are derived in. */
export const DIRECTIONS: readonly Direction[] = [
  Direction.NORTH,
  Direction.SOUTH,
  Direction.EAST,
  Direction.WEST,
];

const DELTAS: Record<Direction, readonly [number, number]> = {
  [Direction.NORTH]: [0, 1],
  [Direction.SOUTH]: [0, -1],
  [Direction.EAST]: [1, 0],
  [Direction.WEST]: [-1, 0],
};

const OPPOSITES: Record<Direction, Direction> = {
  [Direction.NORTH]: Direction.SOUTH,
  [Direction.SOUTH]: Direction.NORTH,
  [Direction.EAST]: Direction.WEST,
  [Direction.WEST]: Direction.EAST,
};

export function delta(direction: Direction): readonly [number, number] {
  return DELTAS[direction];
}

export function opposite(direction: Direction): Direction {
  return OPPOSITES[direction];
}

export interface Coordinate {
  readonly x: number;
  readonly y: number;
}

/**
 * The string form of a coordinate, `"x,y"`.
 *
 * Branded so it cannot be confused with an arbitrary string — a sector id and a
 * coordinate key are both strings, and mixing them up would be a silent bug.
 */
export type CoordKey = string & { readonly __brand: "CoordKey" };

export function coord(x: number, y: number): Coordinate {
  return { x, y };
}

export const ORIGIN: Coordinate = coord(0, 0);

/** Stable string form, used as a Map/Set key and in JSON snapshots. */
export function key(c: Coordinate): CoordKey {
  return `${c.x},${c.y}` as CoordKey;
}

// Matched against each half of a key before it is converted. `Number("")` is 0
// and `Number(" ")` is 0, so a bare `Number()` would read the key "1," as the
// perfectly plausible coordinate [1, 0] — silently inventing a sector. Python's
// `int("")` raised instead, and so must this.
const INTEGER = /^[+-]?\d+$/;

export function fromKey(k: string): Coordinate {
  const parts = k.split(",");
  if (parts.length !== 2 || !INTEGER.test(parts[0]!) || !INTEGER.test(parts[1]!)) {
    throw new Error(`malformed coordinate key ${JSON.stringify(k)}`);
  }
  const x = Number(parts[0]);
  const y = Number(parts[1]);
  if (!Number.isSafeInteger(x) || !Number.isSafeInteger(y)) {
    throw new Error(`coordinate key out of safe integer range: ${JSON.stringify(k)}`);
  }
  return { x, y };
}

export function equals(a: Coordinate, b: Coordinate): boolean {
  return a.x === b.x && a.y === b.y;
}

/**
 * Python sorted a list of coordinate tuples, which orders by x then y. Several
 * behaviours depend on that exact ordering — `edges()`, the frontier listing,
 * and above all `allocate()`, which sorts candidates before the seeded RNG picks
 * one. A different order would silently change which slot a given seed hands out.
 */
export function compare(a: Coordinate, b: Coordinate): number {
  return a.x - b.x || a.y - b.y;
}

export function step(c: Coordinate, direction: Direction): Coordinate {
  const [dx, dy] = DELTAS[direction];
  return { x: c.x + dx, y: c.y + dy };
}

export function neighbours(c: Coordinate): [Direction, Coordinate][] {
  return DIRECTIONS.map((direction) => [direction, step(c, direction)]);
}

export function inBounds(c: Coordinate): boolean {
  return Math.abs(c.x) <= MAX_XY && Math.abs(c.y) <= MAX_XY;
}

export function asList(c: Coordinate): [number, number] {
  return [c.x, c.y];
}

/** Matches Python's `__str__`: `[x, y]`. Appears in agent-facing messages. */
export function toString(c: Coordinate): string {
  return `[${c.x}, ${c.y}]`;
}

/**
 * Build a Coordinate from an untrusted `[x, y]` payload.
 *
 * Throws on anything that is not exactly two integers. Booleans are rejected
 * explicitly: Python had to because `bool` subclasses `int`, and while
 * `Number.isInteger(true)` is already false, saying so out loud keeps the two
 * implementations obviously equivalent.
 */
export function parse(raw: unknown): Coordinate {
  if (!Array.isArray(raw) || raw.length !== 2) {
    throw new Error("coordinate must be a list of exactly two integers");
  }
  for (const part of raw) {
    if (typeof part === "boolean" || !Number.isInteger(part)) {
      throw new Error("coordinate components must be integers");
    }
  }
  return { x: raw[0] as number, y: raw[1] as number };
}
