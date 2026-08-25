"""World persistence.

Sectors are nodes on a flat lattice. Exits are *not* stored — they are derived
from adjacency every time they are asked for, which is why no two neighbouring
agents can ever disagree about a doorway. Objects hang off sectors and off each
other in a tree.

The interface is narrow enough that a Neo4j implementation would need to provide
nothing more than what is here.
"""

from __future__ import annotations

import json
import os
import threading
import time
from dataclasses import dataclass
from typing import Any, Iterable, Protocol

from .coords import Coordinate, Direction
from .schema import Sector, parse_sector


@dataclass(frozen=True)
class BakedSector:
    """A sector that has passed validation and been locked into the world."""

    sector: Sector
    agent_id: str
    baked_at: float

    @property
    def coordinate(self) -> Coordinate:
        return self.sector.coordinate

    def as_dict(self) -> dict[str, Any]:
        return {
            "sector": self.sector.as_dict(),
            "agent_id": self.agent_id,
            "baked_at": self.baked_at,
        }

    @classmethod
    def from_dict(cls, raw: dict[str, Any]) -> "BakedSector":
        sector, errors = parse_sector(raw["sector"])
        if sector is None or errors:
            # Snapshots only hold sectors that already passed validation, so this
            # means the file was hand-edited or corrupted.
            raise ValueError(f"corrupt snapshot sector: {errors}")
        return cls(sector=sector, agent_id=raw["agent_id"], baked_at=raw["baked_at"])


@dataclass(frozen=True)
class WorldObject:
    object_id: str
    coordinate: Coordinate
    parent_id: str | None
    title: str
    description: str
    agent_id: str
    created_at: float

    def as_dict(self) -> dict[str, Any]:
        return {
            "object_id": self.object_id,
            "coordinate": self.coordinate.as_list(),
            "parent_id": self.parent_id,
            "title": self.title,
            "description": self.description,
            "agent_id": self.agent_id,
            "created_at": self.created_at,
        }

    @classmethod
    def from_dict(cls, raw: dict[str, Any]) -> "WorldObject":
        return cls(
            object_id=raw["object_id"],
            coordinate=Coordinate.parse(raw["coordinate"]),
            parent_id=raw["parent_id"],
            title=raw["title"],
            description=raw["description"],
            agent_id=raw["agent_id"],
            created_at=raw["created_at"],
        )


class WorldStore(Protocol):
    def get(self, coordinate: Coordinate) -> BakedSector | None: ...
    def bake(self, baked: BakedSector) -> None: ...
    def sectors(self) -> Iterable[BakedSector]: ...
    def count(self) -> int: ...


class InMemoryWorldStore:
    """Dict-backed world with an optional JSON snapshot on disk."""

    def __init__(self, path: str | None = None) -> None:
        self._sectors: dict[Coordinate, BakedSector] = {}
        self._objects: dict[str, WorldObject] = {}
        self._lock = threading.RLock()
        self._path = path
        if path:
            self.load()

    # --- sectors ------------------------------------------------------------

    def get(self, coordinate: Coordinate) -> BakedSector | None:
        with self._lock:
            return self._sectors.get(coordinate)

    def bake(self, baked: BakedSector) -> None:
        """Write a sector permanently. The static lock is enforced here."""
        with self._lock:
            if baked.coordinate in self._sectors:
                raise KeyError(f"{baked.coordinate} is already baked and cannot be rewritten")
            self._sectors[baked.coordinate] = baked
            self._persist_locked()

    def sectors(self) -> list[BakedSector]:
        with self._lock:
            return list(self._sectors.values())

    def count(self) -> int:
        with self._lock:
            return len(self._sectors)

    def is_baked(self, coordinate: Coordinate) -> bool:
        with self._lock:
            return coordinate in self._sectors

    # --- derived exits ------------------------------------------------------

    def exits_from(self, coordinate: Coordinate) -> list[dict[str, Any]]:
        """Every side with a neighbour is an exit. Nobody declares these.

        The label a player reads on the door is the neighbour's own ``title``,
        and examining the door without walking through shows the neighbour's
        ``short_description``. So each sector writes the sign on the outside of
        its own front door, and its neighbours never get a say — which is how
        two rooms that agree on nothing still join up cleanly.
        """
        found: list[dict[str, Any]] = []
        with self._lock:
            for direction, neighbour_coord in coordinate.neighbours():
                neighbour = self._sectors.get(neighbour_coord)
                if neighbour is None:
                    continue
                found.append(
                    {
                        "direction": direction.value,
                        "name": neighbour.sector.title,
                        "description": neighbour.sector.short_description,
                        "to": neighbour_coord.as_list(),
                    }
                )
        return found

    def open_slots(self) -> set[Coordinate]:
        """Unbaked, in-bounds coordinates touching at least one baked sector.

        This is the frontier, and the only rule is adjacency — a slot beside a
        sector with three neighbours already is worth exactly as much as a slot
        beside a lonely one. The world is allowed to grow a corridor if that is
        where the dice fall.
        """
        slots: set[Coordinate] = set()
        with self._lock:
            for coordinate in self._sectors:
                for _, neighbour in coordinate.neighbours():
                    if neighbour not in self._sectors and neighbour.in_bounds:
                        slots.add(neighbour)
        return slots

    def edges(self) -> list[dict[str, Any]]:
        with self._lock:
            coordinates = set(self._sectors)
        return [
            {"from": coordinate.as_list(), "direction": direction.value,
             "to": neighbour.as_list()}
            for coordinate in sorted(coordinates)
            for direction, neighbour in coordinate.neighbours()
            if neighbour in coordinates
        ]

    # --- objects ------------------------------------------------------------

    def add_object(self, world_object: WorldObject) -> None:
        with self._lock:
            if world_object.object_id in self._objects:
                raise KeyError(f"{world_object.object_id} already exists")
            self._objects[world_object.object_id] = world_object
            self._persist_locked()

    def get_object(self, object_id: str) -> WorldObject | None:
        with self._lock:
            return self._objects.get(object_id)

    def objects_in(self, coordinate: Coordinate) -> list[WorldObject]:
        with self._lock:
            return sorted(
                (o for o in self._objects.values() if o.coordinate == coordinate),
                key=lambda o: o.created_at,
            )

    def children_of(self, parent_id: str | None, coordinate: Coordinate) -> list[WorldObject]:
        return [o for o in self.objects_in(coordinate) if o.parent_id == parent_id]

    def object_count(self) -> int:
        with self._lock:
            return len(self._objects)

    # --- snapshot -----------------------------------------------------------

    def _persist_locked(self) -> None:
        if not self._path:
            return
        payload = {
            "version": 2,
            "saved_at": time.time(),
            "sectors": {b.coordinate.key: b.as_dict() for b in self._sectors.values()},
            "objects": {o.object_id: o.as_dict() for o in self._objects.values()},
        }
        tmp = f"{self._path}.tmp"
        with open(tmp, "w", encoding="utf-8") as handle:
            json.dump(payload, handle, indent=2)
        os.replace(tmp, self._path)

    def load(self) -> None:
        if not self._path:
            return
        try:
            with open(self._path, encoding="utf-8") as handle:
                payload = json.load(handle)
        except FileNotFoundError:
            return
        with self._lock:
            self._sectors = {
                Coordinate.from_key(key): BakedSector.from_dict(value)
                for key, value in payload.get("sectors", {}).items()
            }
            self._objects = {
                key: WorldObject.from_dict(value)
                for key, value in payload.get("objects", {}).items()
            }
