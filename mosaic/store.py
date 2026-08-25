"""Graph persistence.

Rooms are nodes, exits are directed edges. The interface below is deliberately
narrow — it is the whole surface a Neo4j-backed implementation would need to
provide, so swapping the in-memory store out later touches nothing else.
"""

from __future__ import annotations

import json
import threading
import time
from dataclasses import dataclass
from typing import Any, Iterable, Protocol

from .coords import Coordinate, Direction
from .schema import Blueprint, Exit, parse_blueprint


@dataclass(frozen=True)
class BakedRoom:
    """A room that has passed validation and been locked into the graph."""

    blueprint: Blueprint
    agent_id: str
    baked_at: float

    @property
    def coordinate(self) -> Coordinate:
        return self.blueprint.coordinate

    def as_dict(self) -> dict[str, Any]:
        return {
            "blueprint": self.blueprint.as_dict(),
            "agent_id": self.agent_id,
            "baked_at": self.baked_at,
        }

    @classmethod
    def from_dict(cls, raw: dict[str, Any]) -> "BakedRoom":
        blueprint, errors = parse_blueprint(raw["blueprint"])
        if blueprint is None or errors:
            # Snapshots only ever contain blueprints that already passed the
            # validator, so this means the file was hand-edited or corrupted.
            raise ValueError(f"corrupt snapshot room: {errors}")
        return cls(blueprint=blueprint, agent_id=raw["agent_id"], baked_at=raw["baked_at"])


class GraphStore(Protocol):
    def get(self, coordinate: Coordinate) -> BakedRoom | None: ...
    def bake(self, room: BakedRoom) -> None: ...
    def rooms(self) -> Iterable[BakedRoom]: ...
    def count(self) -> int: ...


class InMemoryGraphStore:
    """Dict-backed graph with an optional JSON snapshot on disk."""

    def __init__(self, path: str | None = None) -> None:
        self._rooms: dict[Coordinate, BakedRoom] = {}
        self._lock = threading.RLock()
        self._path = path
        if path:
            self.load()

    # --- node access --------------------------------------------------------

    def get(self, coordinate: Coordinate) -> BakedRoom | None:
        with self._lock:
            return self._rooms.get(coordinate)

    def bake(self, room: BakedRoom) -> None:
        """Write a room permanently. The static lock is enforced here."""
        with self._lock:
            if room.coordinate in self._rooms:
                raise KeyError(f"{room.coordinate} is already baked and cannot be rewritten")
            self._rooms[room.coordinate] = room
            self._persist_locked()

    def rooms(self) -> list[BakedRoom]:
        with self._lock:
            return list(self._rooms.values())

    def count(self) -> int:
        with self._lock:
            return len(self._rooms)

    def is_baked(self, coordinate: Coordinate) -> bool:
        with self._lock:
            return coordinate in self._rooms

    # --- edges and promises -------------------------------------------------

    def promises_into(self, coordinate: Coordinate) -> dict[Direction, Exit]:
        """Exits from baked neighbours that point at ``coordinate``.

        The key is the direction the *new* room must exit toward in order to
        reciprocate; the value is the neighbour's exit, whose description is the
        anchor text the claiming agent gets to borrow.
        """
        found: dict[Direction, Exit] = {}
        with self._lock:
            for direction, neighbour_coord in coordinate.neighbours():
                neighbour = self._rooms.get(neighbour_coord)
                if neighbour is None:
                    continue
                inbound = neighbour.blueprint.exit_for(direction.opposite)
                if inbound is not None:
                    found[direction] = inbound
        return found

    def open_slots(self) -> set[Coordinate]:
        """Unbaked, in-bounds coordinates that a baked room already exits into.

        This is the frontier. Allocating only from it is what guarantees every
        room is reachable from the genesis room without ever running a
        connectivity check.
        """
        slots: set[Coordinate] = set()
        with self._lock:
            for room in self._rooms.values():
                for exit_ in room.blueprint.exits:
                    target = room.coordinate.step(exit_.direction)
                    if target in self._rooms or not target.in_bounds:
                        continue
                    slots.add(target)
        return slots

    def edges(self) -> list[dict[str, Any]]:
        with self._lock:
            return [
                {
                    "from": room.coordinate.as_list(),
                    "direction": exit_.direction.value,
                    "to": room.coordinate.step(exit_.direction).as_list(),
                    "is_locked": exit_.is_locked,
                    "baked": room.coordinate.step(exit_.direction) in self._rooms,
                }
                for room in self._rooms.values()
                for exit_ in room.blueprint.exits
            ]

    # --- snapshot -----------------------------------------------------------

    def _persist_locked(self) -> None:
        if not self._path:
            return
        payload = {
            "version": 1,
            "saved_at": time.time(),
            "rooms": {room.coordinate.key: room.as_dict() for room in self._rooms.values()},
        }
        tmp = f"{self._path}.tmp"
        with open(tmp, "w", encoding="utf-8") as handle:
            json.dump(payload, handle, indent=2)
        import os

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
            self._rooms = {
                Coordinate.from_key(key): BakedRoom.from_dict(value)
                for key, value in payload.get("rooms", {}).items()
            }
