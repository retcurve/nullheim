"""Semantic rules: identity, ownership, and reachability.

There is far less here than the border-contract design needed, and that is the
point of deriving exits from adjacency — most of what used to be checkable is
now unrepresentable.
"""

import unittest

from helpers import build, codes, make_engine, obj, root, sector, settle

from mosaic.coords import ORIGIN, Coordinate
from mosaic.schema import parse_object, parse_sector
from mosaic.validation import validate_object, validate_sector


def check_sector(engine, at, payload):
    parsed, errors = parse_sector(payload)
    if parsed is None:
        return errors
    return list(errors) + validate_sector(parsed, Coordinate(*at), engine.store)


def check_object(engine, at, payload):
    parsed, errors = parse_object(payload)
    if parsed is None:
        return errors
    return list(errors) + validate_object(parsed, Coordinate(*at), engine.store)


class SectorRuleTests(unittest.TestCase):
    def test_a_valid_sector_passes(self):
        engine = make_engine()
        self.assertEqual(check_sector(engine, (0, 1), sector((0, 1))), [])

    def test_submission_must_match_the_claimed_coordinate(self):
        engine = make_engine()
        errors = check_sector(engine, (0, 1), sector((5, 5)))
        self.assertIn("coordinate_mismatch", codes(errors))

    def test_a_mismatched_coordinate_suppresses_the_other_rules(self):
        """Reporting orphan/adjacency errors about the wrong square is noise."""
        engine = make_engine()
        errors = check_sector(engine, (0, 1), sector((900, 900)))
        self.assertEqual(codes(errors), {"coordinate_mismatch"})

    def test_a_taken_coordinate_is_refused(self):
        engine = make_engine()
        errors = check_sector(engine, ORIGIN, sector(ORIGIN))
        self.assertIn("already_baked", codes(errors))

    def test_a_sector_touching_nothing_is_refused(self):
        """Allocation cannot produce this, but an orphan would be unreachable."""
        engine = make_engine()
        errors = check_sector(engine, (40, 40), sector((40, 40)))
        self.assertIn("orphan_sector", codes(errors))

    def test_touching_the_world_on_any_single_side_is_enough(self):
        engine = make_engine()
        for at in ((0, 1), (0, -1), (1, 0), (-1, 0)):
            with self.subTest(at=at):
                self.assertEqual(check_sector(engine, at, sector(at)), [])

    def test_a_coordinate_off_the_lattice_is_refused(self):
        engine = make_engine()
        far = (1025, 0)
        self.assertIn("out_of_bounds", codes(check_sector(engine, far, sector(far))))


class ObjectRuleTests(unittest.TestCase):
    def test_hanging_an_object_on_the_sector_is_always_fine(self):
        engine = make_engine()
        genesis_id = engine.store.get(ORIGIN).sector_id
        self.assertEqual(check_object(engine, ORIGIN, obj(genesis_id)), [])

    def test_a_null_parent_id_is_refused(self):
        """null used to mean the sector itself; the sector's own id does now."""
        engine = make_engine()
        errors = check_object(engine, ORIGIN, obj(None))
        self.assertIn("type_error", codes(errors))

    def test_a_parent_that_does_not_exist_is_refused(self):
        engine = make_engine()
        errors = check_object(engine, ORIGIN, obj("obj_nope"))
        self.assertIn("no_such_parent", codes(errors))

    def test_an_object_may_hang_on_another_object_in_the_same_sector(self):
        engine = make_engine()
        agent, _, _ = settle(engine)
        first, errors = engine.create_object(agent, obj(root(engine, agent)))
        self.assertEqual(errors, [])
        self.assertEqual(check_object(engine, agent.coordinate, obj(first.object_id)), [])

    def test_an_object_in_another_agents_sector_is_not_a_valid_parent(self):
        engine = make_engine()
        one, _, _ = settle(engine, "one")
        two, _, _ = settle(engine, "two")
        theirs, _ = engine.create_object(one, obj(root(engine, one)))

        errors = check_object(engine, two.coordinate, obj(theirs.object_id))
        self.assertIn("no_such_parent", codes(errors))

    def test_someone_elses_object_is_indistinguishable_from_a_missing_one(self):
        """An agent has no business learning what stands in another sector."""
        engine = make_engine()
        one, _, _ = settle(engine, "one")
        two, _, _ = settle(engine, "two")
        theirs, _ = engine.create_object(one, obj(root(engine, one), title="Their Secret Thing"))

        trespass = check_object(engine, two.coordinate, obj(theirs.object_id))
        missing = check_object(engine, two.coordinate, obj("obj_deadbeefdeadbeef"))
        self.assertEqual(codes(trespass), codes(missing))
        self.assertNotIn("Their Secret Thing", trespass[0].message)

    def test_the_object_graph_cannot_cycle(self):
        """A parent must already exist, so a cycle is unrepresentable."""
        engine = make_engine()
        agent, _, _ = settle(engine)
        first, _ = engine.create_object(agent, obj(root(engine, agent), title="Crate"))
        second, _ = engine.create_object(agent, obj(first.object_id, title="Tin"))

        # The only way to close a loop would be to repoint an existing object,
        # and nothing in the API can do that.
        self.assertEqual(second.parent_id, first.object_id)
        self.assertIsNone(engine.store.get_object(first.object_id).parent_id)


if __name__ == "__main__":
    unittest.main()
