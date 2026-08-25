"""Durability: a compacted snapshot plus an append-only log.

The contract this has to keep is narrow and absolute. A sector is permanent and
an agent waits eight hours per object, so once the API has answered "baked", a
crash must not take it back. Everything here is about what survives.
"""

import json
import unittest
from pathlib import Path
from tempfile import TemporaryDirectory
from unittest.mock import patch

from helpers import obj, sector

from mosaic import store as store_module
from mosaic.coords import ORIGIN, Coordinate
from mosaic.engine import Engine
from mosaic.schema import parse_sector
from mosaic.store import BakedSector, InMemoryWorldStore


def bake_at(store, x, y):
    parsed, errors = parse_sector(sector((x, y)))
    assert parsed is not None and not errors, errors
    store.bake(BakedSector(sector=parsed, agent_id="a", baked_at=float(x * 100 + y)))


class WorldOnDisk:
    """A world in a temp directory that can be reopened as if after a crash."""

    def __init__(self):
        self._tmp = TemporaryDirectory()
        self.path = str(Path(self._tmp.name) / "world.json")
        self.log = Path(f"{self.path}.log")
        self.snapshot = Path(self.path)

    def open(self) -> InMemoryWorldStore:
        return InMemoryWorldStore(path=self.path)

    def cleanup(self):
        self._tmp.cleanup()


class DurabilityTests(unittest.TestCase):
    def setUp(self):
        self.world = WorldOnDisk()
        self.addCleanup(self.world.cleanup)

    def test_writes_survive_with_no_snapshot_at_all(self):
        """The ordinary case: everything lives in the log until compaction."""
        store = self.world.open()
        for x in range(5):
            bake_at(store, x, 0)
        store.close()

        self.assertFalse(self.world.snapshot.exists(), "no snapshot should be needed yet")
        self.assertTrue(self.world.log.exists())

        reopened = self.world.open()
        self.addCleanup(reopened.close)
        self.assertEqual(reopened.count(), 5)
        self.assertEqual(reopened.open_slots(), store.open_slots())

    def test_the_snapshot_is_not_rewritten_on_every_write(self):
        """The whole point: a write must not cost O(world)."""
        store = self.world.open()
        self.addCleanup(store.close)
        for x in range(20):
            bake_at(store, x, 0)
        self.assertFalse(self.world.snapshot.exists())
        self.assertEqual(len(self.world.log.read_text().splitlines()), 20)

    def test_objects_and_sectors_both_survive(self):
        engine = Engine(state_path=self.world.path, cooldown_seconds=0)
        agent, _ = engine.register("architect")
        claim = engine.claim(agent)
        engine.submit_sector(agent, claim, sector(claim.coordinate))
        can, _ = engine.create_object(agent, obj(title="Can"))
        engine.create_object(agent, obj(title="Key", parent_id=can.object_id))
        engine.store.close()

        reloaded = Engine(state_path=self.world.path)
        self.addCleanup(reloaded.store.close)
        self.assertEqual(reloaded.store.count(), engine.store.count())
        tree = reloaded.object_tree(claim.coordinate)
        self.assertEqual(tree[0]["title"], "Can")
        self.assertEqual(tree[0]["contains"][0]["title"], "Key")

    def test_a_torn_final_line_is_dropped_and_the_rest_survives(self):
        """A crash mid-append. The torn write was never acknowledged."""
        store = self.world.open()
        for x in range(4):
            bake_at(store, x, 0)
        store.close()

        with self.world.log.open("a", encoding="utf-8") as handle:
            handle.write('{"t": "sector", "d": {"sector": {"coord')  # cut off

        reopened = self.world.open()
        self.addCleanup(reopened.close)
        self.assertEqual(reopened.count(), 4)

    def test_an_empty_trailing_write_is_survivable(self):
        store = self.world.open()
        bake_at(store, 0, 0)
        store.close()
        with self.world.log.open("a", encoding="utf-8") as handle:
            handle.write("\x00\x00\x00")

        reopened = self.world.open()
        self.addCleanup(reopened.close)
        self.assertEqual(reopened.count(), 1)

    def test_corruption_in_the_middle_refuses_to_load(self):
        """Silently skipping it would quietly lose somebody's permanent sector."""
        store = self.world.open()
        for x in range(4):
            bake_at(store, x, 0)
        store.close()

        lines = self.world.log.read_text().splitlines()
        lines[1] = "{ this is not json"
        self.world.log.write_text("\n".join(lines) + "\n")

        with self.assertRaises(ValueError) as caught:
            self.world.open()
        self.assertIn("corrupt at line 2", str(caught.exception))

    def test_new_writes_append_after_a_restart(self):
        store = self.world.open()
        bake_at(store, 0, 0)
        store.close()

        reopened = self.world.open()
        bake_at(reopened, 1, 0)
        reopened.close()

        final = self.world.open()
        self.addCleanup(final.close)
        self.assertEqual(final.count(), 2)
        self.assertEqual(len(self.world.log.read_text().splitlines()), 2)


class CompactionTests(unittest.TestCase):
    def setUp(self):
        self.world = WorldOnDisk()
        self.addCleanup(self.world.cleanup)

    def test_the_log_folds_into_the_snapshot_at_the_threshold(self):
        with patch.object(store_module, "MIN_COMPACT_RECORDS", 10):
            store = self.world.open()
            self.addCleanup(store.close)
            for x in range(10):
                bake_at(store, x, 0)

            self.assertTrue(self.world.snapshot.exists())
            self.assertEqual(self.world.log.read_text(), "", "log should be truncated")

            payload = json.loads(self.world.snapshot.read_text())
            self.assertEqual(len(payload["sectors"]), 10)

    def test_a_compacted_world_reloads_identically(self):
        with patch.object(store_module, "MIN_COMPACT_RECORDS", 10):
            store = self.world.open()
            for x in range(14):        # crosses the threshold, then writes more
                bake_at(store, x, 0)
            before = store.open_slots()
            store.close()

            reopened = self.world.open()
            self.addCleanup(reopened.close)
            self.assertEqual(reopened.count(), 14)
            self.assertEqual(reopened.open_slots(), before)

    def test_compaction_keeps_firing_as_the_world_grows(self):
        """The log must stay bounded, not compact once and then never again.

        Measured against the world size at the last compaction. Comparing it
        against the current size looks right and never fires, because every
        append grows the log and the world together.
        """
        with patch.object(store_module, "MIN_COMPACT_RECORDS", 10):
            store = self.world.open()
            self.addCleanup(store.close)
            for x in range(300):
                bake_at(store, x, 0)

            pending = len(self.world.log.read_text().splitlines())
            snapshotted = len(json.loads(self.world.snapshot.read_text())["sectors"])
            self.assertLess(pending, 150, "log is not being folded back in")
            self.assertGreater(snapshotted, 150, "snapshot is falling behind the world")

    def test_a_crash_between_snapshot_and_truncate_is_survivable(self):
        """Replay is idempotent, so records already in the snapshot are harmless.

        The snapshot is made durable before the log is dropped. If the process
        dies in between, those records get replayed on top of a snapshot that
        already contains them — which must not double-apply or raise.
        """
        store = self.world.open()
        for x in range(4):
            bake_at(store, x, 0)
        store.compact()
        self.assertEqual(self.world.log.read_text(), "")

        # Put the already-compacted records back, as an interrupted truncate would.
        payload = json.loads(self.world.snapshot.read_text())
        with self.world.log.open("w", encoding="utf-8") as handle:
            for value in payload["sectors"].values():
                handle.write(json.dumps({"t": "sector", "d": value}) + "\n")
        store.close()

        reopened = self.world.open()
        self.addCleanup(reopened.close)
        self.assertEqual(reopened.count(), 4)
        self.assertEqual(reopened.open_slots(), store.open_slots())

    def test_compaction_preserves_the_indexes(self):
        engine = Engine(state_path=self.world.path, cooldown_seconds=0)
        agent, _ = engine.register("architect")
        claim = engine.claim(agent)
        engine.submit_sector(agent, claim, sector(claim.coordinate))
        for title in ("First", "Second", "Third"):
            engine.create_object(agent, obj(title=title))
        engine.store.compact()
        engine.store.close()

        reloaded = Engine(state_path=self.world.path)
        self.addCleanup(reloaded.store.close)
        titles = [o.title for o in reloaded.store.objects_in(claim.coordinate)]
        self.assertEqual(titles, ["First", "Second", "Third"])

        expected = {
            neighbour
            for coordinate in (ORIGIN, claim.coordinate)
            for _, neighbour in coordinate.neighbours()
            if not reloaded.store.is_baked(neighbour)
        }
        self.assertEqual(reloaded.store.open_slots(), expected)

    def test_an_unwritten_world_needs_no_files(self):
        store = InMemoryWorldStore()          # no path at all
        bake_at(store, 0, 0)
        self.assertEqual(store.count(), 1)
        store.close()


if __name__ == "__main__":
    unittest.main()
