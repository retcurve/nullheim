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

SNAPSHOT_VERSION = 3

# Compact once the log reaches roughly the size of the world. That makes the
# O(world) rewrite happen every O(world) writes, so it costs O(1) amortised
# however large the world gets.
MIN_COMPACT_RECORDS = 1000


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
        # Two indexes maintained on write rather than recomputed on read. Both
        # answer questions the store already knows the answer to at bake time,
        # and both sit on paths hit constantly — claiming and room views.
        self._frontier: set[Coordinate] = set()
        self._objects_by_coordinate: dict[Coordinate, list[WorldObject]] = {}
        self._lock = threading.RLock()
        self._path = path
        self._log = None
        self._log_records = 0
        self._compacted_size = 0
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
            self._index_frontier_locked(baked.coordinate)
            self._append_locked("sector", baked.as_dict())

    def sectors(self) -> list[BakedSector]:
        with self._lock:
            return list(self._sectors.values())

    def count(self) -> int:
        with self._lock:
            return len(self._sectors)

    def is_baked(self, coordinate: Coordinate) -> bool:
        with self._lock:
            return coordinate in self._sectors

    def _index_frontier_locked(self, coordinate: Coordinate) -> None:
        """Fold one newly baked sector into the frontier.

        Exactly five coordinates can change: the one just filled, and its four
        neighbours, any of which may now touch the world for the first time.
        """
        self._frontier.discard(coordinate)
        for _, neighbour in coordinate.neighbours():
            if neighbour not in self._sectors and neighbour.in_bounds:
                self._frontier.add(neighbour)

    def _rebuild_indexes_locked(self) -> None:
        """Recompute both indexes from scratch. Startup only."""
        self._frontier = set()
        for coordinate in self._sectors:
            self._index_frontier_locked(coordinate)

        self._objects_by_coordinate = {}
        # Snapshot dict order is not guaranteed to match creation order, so sort
        # rather than trusting it — objects_in() promises oldest first.
        for world_object in sorted(self._objects.values(), key=lambda o: o.created_at):
            self._objects_by_coordinate.setdefault(world_object.coordinate, []).append(
                world_object
            )

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

        Maintained incrementally in ``bake``. It used to be recomputed here by
        scanning every sector, which cost ten seconds a claim at a million
        sectors; the frontier itself only grows as about 7.6·√N.
        """
        with self._lock:
            return set(self._frontier)

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
            # Objects are created in timestamp order, so appending keeps the
            # oldest-first ordering objects_in() promises.
            self._objects_by_coordinate.setdefault(world_object.coordinate, []).append(
                world_object
            )
            self._append_locked("object", world_object.as_dict())

    def get_object(self, object_id: str) -> WorldObject | None:
        with self._lock:
            return self._objects.get(object_id)

    def objects_in(self, coordinate: Coordinate) -> list[WorldObject]:
        """Everything standing in one sector, oldest first.

        Indexed by coordinate rather than filtered out of every object in the
        world — this is on the player's path, called for every room view.
        """
        with self._lock:
            return list(self._objects_by_coordinate.get(coordinate, ()))

    def children_of(self, parent_id: str | None, coordinate: Coordinate) -> list[WorldObject]:
        return [o for o in self.objects_in(coordinate) if o.parent_id == parent_id]

    def object_count(self) -> int:
        with self._lock:
            return len(self._objects)

    # --- persistence --------------------------------------------------------
    #
    # A compacted snapshot plus an append-only log of everything since. Writing
    # costs one line and one fsync no matter how big the world is; the snapshot
    # used to be rewritten in full on every single contribution, which is half a
    # gigabyte per object at a million sectors.
    #
    # Nothing acknowledged is ever lost. A sector is permanent and an agent waits
    # eight hours per object, so the API must not say "baked" about something a
    # power cut can take back.

    @property
    def _log_path(self) -> str:
        return f"{self._path}.log"

    def _append_locked(self, kind: str, payload: dict[str, Any]) -> None:
        if not self._path:
            return
        if self._log is None:
            self._log = open(self._log_path, "a", encoding="utf-8")

        self._log.write(json.dumps({"t": kind, "d": payload}, separators=(",", ":")) + "\n")
        self._log.flush()
        # Holding the store lock across the fsync serialises writers. At the
        # world's actual write rate — one object per agent per eight hours —
        # that is a few percent of one core, and correctness is worth more.
        os.fsync(self._log.fileno())

        self._log_records += 1
        self._maybe_compact_locked()

    def _maybe_compact_locked(self) -> None:
        # Measured against the world size *at the last compaction*, not the
        # current one. Comparing against the current size never fires: every
        # append grows both sides at once, so the log can never catch up.
        threshold = max(MIN_COMPACT_RECORDS, self._compacted_size)
        if self._log_records >= threshold:
            self._compact_locked()

    def _compact_locked(self) -> None:
        """Fold the log back into the snapshot and start a fresh one.

        The snapshot is made durable *before* the log is dropped. A crash in
        between leaves log records that are already in the snapshot, and replay
        is idempotent, so the worst case is redundant work rather than loss.
        """
        if not self._path:
            return

        payload = {
            "version": SNAPSHOT_VERSION,
            "saved_at": time.time(),
            "sectors": {b.coordinate.key: b.as_dict() for b in self._sectors.values()},
            "objects": {o.object_id: o.as_dict() for o in self._objects.values()},
        }
        tmp = f"{self._path}.tmp"
        with open(tmp, "w", encoding="utf-8") as handle:
            json.dump(payload, handle, indent=2)
            handle.flush()
            os.fsync(handle.fileno())
        os.replace(tmp, self._path)
        self._sync_directory()

        if self._log is not None:
            self._log.close()
            self._log = None
        with open(self._log_path, "w", encoding="utf-8") as handle:
            handle.flush()
            os.fsync(handle.fileno())
        self._log_records = 0
        self._compacted_size = len(self._sectors) + len(self._objects)

    def _sync_directory(self) -> None:
        """Make the rename itself durable, not just the file contents."""
        directory = os.path.dirname(os.path.abspath(self._path)) or "."
        try:
            fd = os.open(directory, os.O_RDONLY)
        except OSError:  # pragma: no cover - not every platform allows this
            return
        try:
            os.fsync(fd)
        except OSError:  # pragma: no cover
            pass
        finally:
            os.close(fd)

    def compact(self) -> None:
        """Force a compaction. Called on clean shutdown and by the tests."""
        with self._lock:
            self._compact_locked()

    def close(self) -> None:
        """Release the log handle. Everything written is already durable."""
        with self._lock:
            if self._log is not None:
                self._log.close()
                self._log = None

    def load(self) -> None:
        if not self._path:
            return
        try:
            with open(self._path, encoding="utf-8") as handle:
                payload = json.load(handle)
        except FileNotFoundError:
            payload = {}

        sectors = {
            Coordinate.from_key(key): BakedSector.from_dict(value)
            for key, value in payload.get("sectors", {}).items()
        }
        objects = {
            key: WorldObject.from_dict(value)
            for key, value in payload.get("objects", {}).items()
        }
        replayed = self._replay_log(sectors, objects)

        with self._lock:
            self._sectors = sectors
            self._objects = objects
            self._log_records = replayed
            self._compacted_size = len(sectors) + len(objects) - replayed
            self._rebuild_indexes_locked()
            self._maybe_compact_locked()

    def _replay_log(self, sectors: dict, objects: dict) -> int:
        """Apply everything written since the snapshot. Idempotent by design."""
        try:
            with open(self._log_path, encoding="utf-8") as handle:
                lines = handle.readlines()
        except FileNotFoundError:
            return 0

        replayed = 0
        for index, line in enumerate(lines):
            try:
                record = json.loads(line)
                kind, data = record["t"], record["d"]
                if kind == "sector":
                    baked = BakedSector.from_dict(data)
                    sectors[baked.coordinate] = baked
                elif kind == "object":
                    world_object = WorldObject.from_dict(data)
                    objects[world_object.object_id] = world_object
                else:
                    raise ValueError(f"unknown record type {kind!r}")
            except Exception as exc:
                if index == len(lines) - 1:
                    # A crash mid-append leaves a torn final line. Every line
                    # before it was fsynced; this one was never acknowledged to
                    # the agent, so dropping it loses nothing anybody was told.
                    break
                # A break in the middle is real corruption, and silently
                # skipping it would quietly lose somebody's permanent sector.
                raise ValueError(
                    f"{self._log_path} is corrupt at line {index + 1}: {exc}"
                ) from exc
            replayed += 1
        return replayed
