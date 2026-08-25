"""The frontier and object indexes are maintained on write, not computed on read.

That is a performance change with a correctness risk: an index can silently drift
from the definition it replaced. So these tests keep a reference implementation of
the old full-scan behaviour and assert the index agrees with it, rather than
asserting the index matches itself.
"""

import json
import random
import tempfile
import unittest
from pathlib import Path

from helpers import build, make_engine, obj, sector, settle

from mosaic.coords import MAX_XY, ORIGIN, Coordinate
from mosaic.engine import Engine
from mosaic.schema import Sector, parse_sector
from mosaic.store import BakedSector, InMemoryWorldStore, WorldObject


def reference_frontier(store) -> set[Coordinate]:
    """The pre-index definition: scan every sector, collect empty neighbours."""
    slots: set[Coordinate] = set()
    for baked in store.sectors():
        for _, neighbour in baked.coordinate.neighbours():
            if not store.is_baked(neighbour) and neighbour.in_bounds:
                slots.add(neighbour)
    return slots


def reference_objects_in(store, coordinate) -> list[WorldObject]:
    """The pre-index definition: filter every object in the world."""
    return sorted(
        (o for o in store._objects.values() if o.coordinate == coordinate),
        key=lambda o: o.created_at,
    )


def bake_at(store, x, y, agent_id="a"):
    parsed, errors = parse_sector(sector((x, y)))
    assert parsed is not None and not errors, errors
    store.bake(BakedSector(sector=parsed, agent_id=agent_id, baked_at=0.0))


class FrontierIndexTests(unittest.TestCase):
    def test_an_empty_world_has_an_empty_frontier(self):
        store = InMemoryWorldStore()
        self.assertEqual(store.open_slots(), set())

    def test_the_first_sector_opens_four_slots(self):
        store = InMemoryWorldStore()
        bake_at(store, 0, 0)
        self.assertEqual(store.open_slots(), reference_frontier(store))
        self.assertEqual(len(store.open_slots()), 4)

    def test_the_index_matches_the_full_scan_at_every_step(self):
        """The property that matters: the index never drifts from the definition."""
        rng = random.Random(17)
        store = InMemoryWorldStore()
        bake_at(store, 0, 0)

        for step in range(400):
            slot = rng.choice(sorted(store.open_slots()))
            bake_at(store, slot.x, slot.y)
            with self.subTest(step=step, sectors=store.count()):
                self.assertEqual(store.open_slots(), reference_frontier(store))

    def test_filling_a_hole_removes_it_from_the_frontier(self):
        """The discard half of the update — easy to omit and rarely noticed."""
        store = InMemoryWorldStore()
        for x, y in ((0, 0), (2, 0), (1, 1), (1, -1)):
            bake_at(store, x, y)
        hole = Coordinate(1, 0)
        self.assertIn(hole, store.open_slots())

        bake_at(store, 1, 0)
        self.assertNotIn(hole, store.open_slots())
        self.assertEqual(store.open_slots(), reference_frontier(store))

    def test_the_frontier_stops_at_the_lattice_edge(self):
        store = InMemoryWorldStore()
        bake_at(store, MAX_XY, 0)
        self.assertNotIn(Coordinate(MAX_XY + 1, 0), store.open_slots())
        self.assertIn(Coordinate(MAX_XY - 1, 0), store.open_slots())
        self.assertEqual(store.open_slots(), reference_frontier(store))

    def test_callers_cannot_mutate_the_index_through_open_slots(self):
        store = InMemoryWorldStore()
        bake_at(store, 0, 0)
        store.open_slots().clear()
        self.assertEqual(len(store.open_slots()), 4)

    def test_the_frontier_survives_a_snapshot_round_trip(self):
        with tempfile.TemporaryDirectory() as tmp:
            path = str(Path(tmp) / "world.json")
            first = InMemoryWorldStore(path=path)
            bake_at(first, 0, 0)
            for x, y in ((0, 1), (1, 1), (1, 0)):
                bake_at(first, x, y)

            reloaded = InMemoryWorldStore(path=path)
            self.assertEqual(reloaded.open_slots(), first.open_slots())
            self.assertEqual(reloaded.open_slots(), reference_frontier(reloaded))
            first.close()
            reloaded.close()

    def test_allocation_still_sees_the_whole_frontier(self):
        """The index feeds claiming; a slot missing from it is unbuildable."""
        engine = make_engine()
        build(engine, (0, 1))
        self.assertEqual(set(engine.registry.frontier()), reference_frontier(engine.store))


class ObjectIndexTests(unittest.TestCase):
    def test_an_empty_sector_has_no_objects(self):
        engine = make_engine()
        self.assertEqual(engine.store.objects_in(ORIGIN), [])

    def test_objects_come_back_oldest_first(self):
        engine = make_engine(cooldown_seconds=0)
        agent, _, _ = settle(engine)
        for title in ("First", "Second", "Third"):
            engine.create_object(agent, obj(title=title))

        titles = [o.title for o in engine.store.objects_in(agent.coordinate)]
        self.assertEqual(titles, ["First", "Second", "Third"])

    def test_the_index_matches_the_full_scan_and_never_leaks_a_neighbour(self):
        engine = make_engine(cooldown_seconds=0)
        one, _, _ = settle(engine, "one")
        two, _, _ = settle(engine, "two")
        for index in range(4):
            engine.create_object(one, obj(title=f"one-{index}"))
            engine.create_object(two, obj(title=f"two-{index}"))

        for agent in (one, two):
            with self.subTest(agent=agent.label):
                indexed = engine.store.objects_in(agent.coordinate)
                self.assertEqual(indexed, reference_objects_in(engine.store, agent.coordinate))
                self.assertTrue(all(o.title.startswith(agent.label) for o in indexed))

    def test_callers_cannot_mutate_the_index_through_objects_in(self):
        engine = make_engine(cooldown_seconds=0)
        agent, _, _ = settle(engine)
        engine.create_object(agent, obj())
        engine.store.objects_in(agent.coordinate).clear()
        self.assertEqual(len(engine.store.objects_in(agent.coordinate)), 1)

    def test_the_object_index_survives_a_snapshot_round_trip(self):
        """Rebuilt from a snapshot whose stored order is deliberately wrong.

        JSON object order is not a guarantee, so the rebuild has to sort by
        created_at rather than trust the file. Writing the objects back in
        reverse is what makes this test able to fail.
        """
        with tempfile.TemporaryDirectory() as tmp:
            path = str(Path(tmp) / "world.json")
            first = Engine(state_path=path, cooldown_seconds=0)
            agent, _ = first.register("architect")
            claim = first.claim(agent)
            first.submit_sector(agent, claim, sector(claim.coordinate))
            for title in ("First", "Second", "Third"):
                first.create_object(agent, obj(title=title))
            # Writes land in the log; force them into the snapshot so there is
            # a snapshot whose stored order can be scrambled.
            first.store.compact()

            payload = json.loads(Path(path).read_text())
            payload["objects"] = dict(reversed(list(payload["objects"].items())))
            Path(path).write_text(json.dumps(payload))

            reloaded = Engine(state_path=path)
            indexed = reloaded.store.objects_in(claim.coordinate)
            self.assertEqual([o.title for o in indexed], ["First", "Second", "Third"])
            self.assertEqual(indexed, reference_objects_in(reloaded.store, claim.coordinate))
            first.store.close()
            reloaded.store.close()


class ObjectTreeTests(unittest.TestCase):
    """object_tree buckets by parent in one pass instead of re-querying per node."""

    @staticmethod
    def reference_tree(engine, coordinate):
        def branch(parent_id):
            return [
                {
                    "object_id": o.object_id,
                    "title": o.title,
                    "description": o.description,
                    "contains": branch(o.object_id),
                }
                for o in engine.store.children_of(parent_id, coordinate)
            ]

        return branch(None)

    def test_a_nested_tree_is_unchanged_by_the_rewrite(self):
        engine = make_engine(cooldown_seconds=0)
        agent, _, _ = settle(engine)

        bench, _ = engine.create_object(agent, obj(title="Bench"))
        can, _ = engine.create_object(agent, obj(title="Can", parent_id=bench.object_id))
        engine.create_object(agent, obj(title="Key", parent_id=can.object_id))
        engine.create_object(agent, obj(title="Rag", parent_id=bench.object_id))
        engine.create_object(agent, obj(title="Crate"))

        tree = engine.object_tree(agent.coordinate)
        self.assertEqual(tree, self.reference_tree(engine, agent.coordinate))
        self.assertEqual([n["title"] for n in tree], ["Bench", "Crate"])
        self.assertEqual([n["title"] for n in tree[0]["contains"]], ["Can", "Rag"])
        self.assertEqual([n["title"] for n in tree[0]["contains"][0]["contains"]], ["Key"])

    def test_a_deep_chain_walks_correctly(self):
        engine = make_engine(cooldown_seconds=0)
        agent, _, _ = settle(engine)

        parent_id = None
        for depth in range(12):
            placed, _ = engine.create_object(
                agent, obj(title=f"level-{depth}", parent_id=parent_id)
            )
            parent_id = placed.object_id

        node = engine.object_tree(agent.coordinate)
        for depth in range(12):
            self.assertEqual(len(node), 1)
            self.assertEqual(node[0]["title"], f"level-{depth}")
            node = node[0]["contains"]
        self.assertEqual(node, [])


if __name__ == "__main__":
    unittest.main()
