"""Semantic rules: borders, traps, and object graphs.

Each rule gets a passing fixture and a failing one, so a rule that quietly stops
firing shows up as a failure rather than as a corrupted world.
"""

import unittest

from helpers import bake, blueprint, codes, item, make_engine

from mosaic.coords import Coordinate
from mosaic.schema import parse_blueprint
from mosaic.validation import validate


def check(engine, at, payload):
    parsed, errors = parse_blueprint(payload)
    if parsed is None:
        return errors
    return list(errors) + validate(parsed, Coordinate(*at), engine.store)


class CoordinateTests(unittest.TestCase):
    def test_blueprint_must_match_the_claimed_sector(self):
        engine = make_engine()
        errors = check(engine, (0, 1, 0), blueprint((5, 5, 0), directions=("south",)))
        self.assertIn("coordinate_mismatch", codes(errors))


class ExitTests(unittest.TestCase):
    def test_duplicate_directions_are_rejected(self):
        engine = make_engine()
        payload = blueprint((0, 1, 0), directions=("south", "south"))
        self.assertIn("duplicate_exit", codes(check(engine, (0, 1, 0), payload)))

    def test_a_room_needs_at_least_one_exit(self):
        engine = make_engine()
        payload = blueprint((0, 1, 0), exits=[])
        self.assertIn("no_exits", codes(check(engine, (0, 1, 0), payload)))

    def test_exits_off_the_lattice_are_rejected(self):
        engine = make_engine()
        edge = (0, 0, 32)  # MAX_Z
        payload = blueprint(edge, directions=("up",))
        self.assertIn("out_of_bounds", codes(check(engine, edge, payload)))


class ReciprocityTests(unittest.TestCase):
    """The border contract, in both directions."""

    def test_a_promised_doorway_must_be_returned(self):
        engine = make_engine()
        # Genesis exits north into [0, 1, 0], so that room owes a south exit.
        payload = blueprint((0, 1, 0), directions=("north",))
        errors = check(engine, (0, 1, 0), payload)
        self.assertIn("unfulfilled_promise", codes(errors))

    def test_returning_the_promised_doorway_passes(self):
        engine = make_engine()
        payload = blueprint((0, 1, 0), directions=("south",))
        self.assertEqual(check(engine, (0, 1, 0), payload), [])

    def test_the_neighbours_doorway_text_is_quoted_back_in_the_error(self):
        engine = make_engine()
        errors = check(engine, (0, 1, 0), blueprint((0, 1, 0), directions=("north",)))
        message = next(e.message for e in errors if e.code == "unfulfilled_promise")
        self.assertIn("grey opening", message)

    def test_cannot_punch_a_one_way_door_into_a_finished_room(self):
        engine = make_engine()
        # [0, 1, 0] is finished and opens only south, back toward genesis. Its
        # north face is sealed to anybody it did not invite.
        bake(engine, (0, 1, 0), directions=("south",))

        # Now [0, 2, 0] tries to open south into it without a promise.
        payload = blueprint((0, 2, 0), directions=("south",))
        self.assertIn("unsanctioned_exit", codes(check(engine, (0, 2, 0), payload)))


class TrapTests(unittest.TestCase):
    def test_a_room_where_every_exit_is_locked_is_a_trap(self):
        engine = make_engine()
        payload = blueprint((0, 1, 0), directions=("south",))
        payload["exits"][0]["is_locked"] = True
        payload["exits"][0]["lock_hint"] = "It wants something you do not have."
        self.assertIn("trap_room", codes(check(engine, (0, 1, 0), payload)))

    def test_one_unlocked_exit_is_enough(self):
        engine = make_engine()
        payload = blueprint((0, 1, 0), directions=("south", "north"))
        payload["exits"][1]["is_locked"] = True
        payload["exits"][1]["lock_hint"] = "Sealed from the far side."
        self.assertEqual(check(engine, (0, 1, 0), payload), [])


class ObjectGraphTests(unittest.TestCase):
    """Loop guards — an object graph the physics engine could descend forever."""

    def test_a_container_cannot_hold_its_own_namesake(self):
        inner = item("Satchel")
        outer = item("Satchel", is_container=True, container_capacity=1, contents=[inner])
        payload = blueprint((0, 1, 0), directions=("south",), items=[outer])
        self.assertIn("container_cycle", codes(check(make_engine(), (0, 1, 0), payload)))

    def test_the_namesake_check_ignores_case_and_padding(self):
        inner = item("  satchel ")
        outer = item("Satchel", is_container=True, container_capacity=1, contents=[inner])
        payload = blueprint((0, 1, 0), directions=("south",), items=[outer])
        self.assertIn("container_cycle", codes(check(make_engine(), (0, 1, 0), payload)))

    def test_distinct_nested_containers_are_fine(self):
        inner = item("Tin")
        outer = item("Satchel", is_container=True, container_capacity=1, contents=[inner])
        payload = blueprint((0, 1, 0), directions=("south",), items=[outer])
        self.assertEqual(check(make_engine(), (0, 1, 0), payload), [])

    def test_contents_cannot_exceed_capacity(self):
        outer = item(
            "Satchel",
            is_container=True,
            container_capacity=1,
            contents=[item("Tin"), item("Spoon")],
        )
        payload = blueprint((0, 1, 0), directions=("south",), items=[outer])
        self.assertIn("over_capacity", codes(check(make_engine(), (0, 1, 0), payload)))

    def test_immovable_items_cannot_be_carried_or_wielded(self):
        for flag in ("is_weapon", "is_wearable", "is_consumable"):
            with self.subTest(flag=flag):
                payload = blueprint(
                    (0, 1, 0),
                    directions=("south",),
                    items=[item(weight_class="immovable", **{flag: True})],
                )
                self.assertIn(
                    "immovable_conflict", codes(check(make_engine(), (0, 1, 0), payload))
                )

    def test_immovable_items_cannot_be_nested(self):
        inner = item("Anvil", weight_class="immovable")
        outer = item("Crate", is_container=True, container_capacity=1, contents=[inner])
        payload = blueprint((0, 1, 0), directions=("south",), items=[outer])
        self.assertIn("immovable_nested", codes(check(make_engine(), (0, 1, 0), payload)))

    def test_a_bolted_down_container_is_still_legal(self):
        outer = item("Safe", weight_class="immovable", is_container=True, container_capacity=2)
        payload = blueprint((0, 1, 0), directions=("south",), items=[outer])
        self.assertEqual(check(make_engine(), (0, 1, 0), payload), [])

    def test_a_consumable_cannot_hold_contents(self):
        outer = item(
            "Pie",
            is_container=True,
            container_capacity=1,
            is_consumable=True,
            contents=[item("Blackbird")],
        )
        payload = blueprint((0, 1, 0), directions=("south",), items=[outer])
        self.assertIn("consumable_container", codes(check(make_engine(), (0, 1, 0), payload)))


class AccumulationTests(unittest.TestCase):
    def test_every_problem_is_reported_in_one_pass(self):
        """An agent should never have to resubmit to discover the next error."""
        payload = blueprint(
            (0, 1, 0),
            directions=("north", "north"),
            items=[item(weight_class="immovable", is_weapon=True)],
        )
        found = codes(check(make_engine(), (0, 1, 0), payload))
        self.assertLessEqual(
            {"duplicate_exit", "unfulfilled_promise", "immovable_conflict"}, found
        )


if __name__ == "__main__":
    unittest.main()
