"""Spatial primitives for the Mosaic grid.

The world is a flat integer lattice — x and y only. A sector occupies exactly one
coordinate and is never moved, resized, or regenerated once baked.
"""

from __future__ import annotations

from enum import Enum
from typing import Iterator, NamedTuple

# An arbitrary sanity bound — nothing depends on this number. Agents never choose
# their own coordinate, so a submission can only carry an out-of-bounds one by
# driving the engine directly; its real effect is to stop the frontier growing
# past the wall. At the measured growth rate (radius roughly 0.6·√N) that does
# not bind until a few million sectors.
#
# The ceiling that would actually matter is 2**53 - 1: coordinates cross the wire
# as JSON numbers, and an agent written in JavaScript parses them to a double, so
# anything larger loses precision silently. Python itself has no limit.
MAX_XY = 1024


class Direction(str, Enum):
    NORTH = "north"
    SOUTH = "south"
    EAST = "east"
    WEST = "west"

    @property
    def delta(self) -> tuple[int, int]:
        return _DELTAS[self]

    @property
    def opposite(self) -> "Direction":
        return _OPPOSITES[self]


_DELTAS: dict[Direction, tuple[int, int]] = {
    Direction.NORTH: (0, 1),
    Direction.SOUTH: (0, -1),
    Direction.EAST: (1, 0),
    Direction.WEST: (-1, 0),
}

_OPPOSITES: dict[Direction, Direction] = {
    Direction.NORTH: Direction.SOUTH,
    Direction.SOUTH: Direction.NORTH,
    Direction.EAST: Direction.WEST,
    Direction.WEST: Direction.EAST,
}


class Coordinate(NamedTuple):
    x: int
    y: int

    @classmethod
    def parse(cls, raw: object) -> "Coordinate":
        """Build a Coordinate from an untrusted ``[x, y]`` payload."""
        if not isinstance(raw, (list, tuple)) or len(raw) != 2:
            raise ValueError("coordinate must be a list of exactly two integers")
        values = []
        for part in raw:
            # bool is an int subclass; reject it so [true, 0] is not a point.
            if isinstance(part, bool) or not isinstance(part, int):
                raise ValueError("coordinate components must be integers")
            values.append(part)
        return cls(*values)

    def step(self, direction: Direction) -> "Coordinate":
        dx, dy = direction.delta
        return Coordinate(self.x + dx, self.y + dy)

    def neighbours(self) -> Iterator[tuple[Direction, "Coordinate"]]:
        for direction in Direction:
            yield direction, self.step(direction)

    @property
    def in_bounds(self) -> bool:
        return abs(self.x) <= MAX_XY and abs(self.y) <= MAX_XY

    def as_list(self) -> list[int]:
        return [self.x, self.y]

    @property
    def key(self) -> str:
        """Stable string form, used as a dict key in JSON snapshots."""
        return f"{self.x},{self.y}"

    @classmethod
    def from_key(cls, key: str) -> "Coordinate":
        x, y = (int(part) for part in key.split(","))
        return cls(x, y)

    def __str__(self) -> str:  # pragma: no cover - trivial
        return f"[{self.x}, {self.y}]"


ORIGIN = Coordinate(0, 0)
