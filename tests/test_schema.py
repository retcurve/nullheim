"""Structural parsing: shape and type conformance."""

import unittest

from helpers import blueprint, codes, item

from mosaic.schema import MAX_NAME_LEN, parse_blueprint


class ParsingTests(unittest.TestCase):
    def test_minimal_blueprint_parses_clean(self):
        parsed, errors = parse_blueprint(blueprint((0, 1, 0)))
        self.assertEqual(errors, [])
        self.assertEqual(parsed.coordinate, (0, 1, 0))
        self.assertEqual(len(parsed.exits), 1)

    def test_non_object_payload_is_rejected(self):
        parsed, errors = parse_blueprint(["not", "an", "object"])
        self.assertIsNone(parsed)
        self.assertEqual(codes(errors), {"type_error"})

    def test_coordinate_must_be_three_integers(self):
        for bad in ([0, 1], [0, 1, "z"], [True, 0, 0], "0,1,0"):
            with self.subTest(bad=bad):
                parsed, errors = parse_blueprint(blueprint((0, 1, 0), coordinate=bad))
                self.assertIsNone(parsed)
                self.assertEqual(codes(errors), {"type_error"})

    def test_name_length_is_capped(self):
        _, errors = parse_blueprint(blueprint((0, 1, 0), name="x" * (MAX_NAME_LEN + 1)))
        self.assertIn("too_long", codes(errors))

    def test_blank_required_text_is_rejected(self):
        _, errors = parse_blueprint(blueprint((0, 1, 0), name="   "))
        self.assertIn("empty_text", codes(errors))

    def test_control_characters_are_rejected(self):
        _, errors = parse_blueprint(blueprint((0, 1, 0), description="a\x07b"))
        self.assertIn("control_characters", codes(errors))

    def test_unknown_fields_are_reported(self):
        _, errors = parse_blueprint(blueprint((0, 1, 0), secret_powers=["flight"]))
        self.assertIn("unknown_field", codes(errors))

    def test_bad_direction_enum_is_rejected(self):
        _, errors = parse_blueprint(blueprint((0, 1, 0), directions=("widdershins",)))
        self.assertIn("bad_enum", codes(errors))

    def test_bad_weight_class_is_rejected(self):
        payload = blueprint((0, 1, 0), items=[item(weight_class="fluffy")])
        _, errors = parse_blueprint(payload)
        self.assertIn("bad_enum", codes(errors))

    def test_lock_hint_required_only_when_locked(self):
        locked = blueprint((0, 1, 0))
        locked["exits"][0]["is_locked"] = True
        _, errors = parse_blueprint(locked)
        self.assertIn("type_error", codes(errors))

        unlocked = blueprint((0, 1, 0))
        unlocked["exits"][0]["lock_hint"] = "a hint nobody asked for"
        _, errors = parse_blueprint(unlocked)
        self.assertIn("not_applicable", codes(errors))

    def test_container_capacity_required_for_containers(self):
        payload = blueprint((0, 1, 0), items=[item(is_container=True, container_capacity=None)])
        _, errors = parse_blueprint(payload)
        self.assertIn("required_field", codes(errors))

    def test_capacity_on_a_non_container_is_rejected(self):
        payload = blueprint((0, 1, 0), items=[item(container_capacity=3)])
        _, errors = parse_blueprint(payload)
        self.assertIn("not_applicable", codes(errors))

    def test_nesting_deeper_than_the_cap_is_rejected(self):
        deepest = item("C", is_container=True, container_capacity=1, contents=[item("D")])
        middle = item("B", is_container=True, container_capacity=1, contents=[deepest])
        outer = item("A", is_container=True, container_capacity=1, contents=[middle])
        _, errors = parse_blueprint(blueprint((0, 1, 0), items=[outer]))
        self.assertIn("too_deep", codes(errors))

    def test_oversized_payload_is_rejected_outright(self):
        payload = blueprint((0, 1, 0), ambient_lines=["x" * 200] * 400)
        parsed, errors = parse_blueprint(payload)
        self.assertIsNone(parsed)
        self.assertIn("too_large", codes(errors))

    def test_round_trip_through_as_dict_is_stable(self):
        original = blueprint((2, -3, 1), directions=("north", "east"), items=[item()])
        parsed, errors = parse_blueprint(original)
        self.assertEqual(errors, [])
        reparsed, errors = parse_blueprint(parsed.as_dict())
        self.assertEqual(errors, [])
        self.assertEqual(parsed, reparsed)


if __name__ == "__main__":
    unittest.main()
