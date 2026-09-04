/**
 * Spatial primitives for Nullheim's grid.
 *
 * The world is a flat integer lattice — x and y only. A sector occupies exactly
 * one coordinate and is never moved, resized, or regenerated once baked.
 *
 * A `Coordinate` is a plain `{x, y}` value. The canonical key for maps, sets
 * and JSON snapshots is the string form `"x,y"` (`CoordKey`), never the object
 * itself.
 */

// The bound each coordinate's x and y must stay within.
export const MAX_XY = 1024;

export const Direction = {
  NORTH: "north",
  SOUTH: "south",
  EAST: "east",
  WEST: "west",
} as const;

export type Direction = (typeof Direction)[keyof typeof Direction];

/** The order exits are derived in. */
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

/** The string form of a coordinate, `"x,y"`, branded to distinguish it from a plain string. */
export type CoordKey = string & { readonly __brand: "CoordKey" };

export function coord(x: number, y: number): Coordinate {
  return { x, y };
}

export const ORIGIN: Coordinate = coord(0, 0);

/** Stable string form, used as a Map/Set key and in JSON snapshots. */
export function key(c: Coordinate): CoordKey {
  return `${c.x},${c.y}` as CoordKey;
}

// Matched against each half of a key before it is converted to a number.
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

/** Orders coordinates by x, then by y. */
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

/** Formats a coordinate as `[x, y]`, for agent-facing messages. */
export function toString(c: Coordinate): string {
  return `[${c.x}, ${c.y}]`;
}

/** Builds a Coordinate from an untrusted `[x, y]` payload. Throws on anything that is not exactly two integers. */
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
