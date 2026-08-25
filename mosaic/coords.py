"""Spatial primitives for the Mosaic grid.

The world is an integer lattice. A room occupies exactly one coordinate and is
never moved, resized, or regenerated once baked.
"""

from __future__ import annotations

from enum import Enum
from typing import Iterator, NamedTuple

# The lattice is bounded so the frontier stays finite and coordinates stay
# printable. These are deliberately generous: ~4M sectors on the ground plane.
MAX_XY = 1024
MAX_Z = 32


class Direction(str, Enum):
    NORTH = "north"
    SOUTH = "south"
    EAST = "east"
    WEST = "west"
    UP = "up"
    DOWN = "down"

    @property
    def delta(self) -> tuple[int, int, int]:
        return _DELTAS[self]

    @property
    def opposite(self) -> "Direction":
        return _OPPOSITES[self]


_DELTAS: dict[Direction, tuple[int, int, int]] = {
    Direction.NORTH: (0, 1, 0),
    Direction.SOUTH: (0, -1, 0),
    Direction.EAST: (1, 0, 0),
    Direction.WEST: (-1, 0, 0),
    Direction.UP: (0, 0, 1),
    Direction.DOWN: (0, 0, -1),
}

_OPPOSITES: dict[Direction, Direction] = {
    Direction.NORTH: Direction.SOUTH,
    Direction.SOUTH: Direction.NORTH,
    Direction.EAST: Direction.WEST,
    Direction.WEST: Direction.EAST,
    Direction.UP: Direction.DOWN,
    Direction.DOWN: Direction.UP,
}


class Coordinate(NamedTuple):
    x: int
    y: int
    z: int

    @classmethod
    def parse(cls, raw: object) -> "Coordinate":
        """Build a Coordinate from an untrusted ``[x, y, z]`` payload."""
        if not isinstance(raw, (list, tuple)) or len(raw) != 3:
            raise ValueError("coordinate must be a list of exactly three integers")
        values = []
        for part in raw:
            # bool is an int subclass; reject it so [true, 0, 0] is not a point.
            if isinstance(part, bool) or not isinstance(part, int):
                raise ValueError("coordinate components must be integers")
            values.append(part)
        return cls(*values)

    def step(self, direction: Direction) -> "Coordinate":
        dx, dy, dz = direction.delta
        return Coordinate(self.x + dx, self.y + dy, self.z + dz)

    def neighbours(self) -> Iterator[tuple[Direction, "Coordinate"]]:
        for direction in Direction:
            yield direction, self.step(direction)

    @property
    def in_bounds(self) -> bool:
        return (
            abs(self.x) <= MAX_XY
            and abs(self.y) <= MAX_XY
            and abs(self.z) <= MAX_Z
        )

    def as_list(self) -> list[int]:
        return [self.x, self.y, self.z]

    @property
    def key(self) -> str:
        """Stable string form, used as a dict key in JSON snapshots."""
        return f"{self.x},{self.y},{self.z}"

    @classmethod
    def from_key(cls, key: str) -> "Coordinate":
        x, y, z = (int(part) for part in key.split(","))
        return cls(x, y, z)

    def __str__(self) -> str:  # pragma: no cover - trivial
        return f"[{self.x}, {self.y}, {self.z}]"


ORIGIN = Coordinate(0, 0, 0)
