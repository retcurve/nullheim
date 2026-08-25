"""Structural parsing: shape and type conformance."""

import unittest

from helpers import codes, obj, sector

from mosaic.schema import (
    MAX_LONG_DESCRIPTION_LEN,
    MAX_SHORT_DESCRIPTION_LEN,
    MAX_TITLE_LEN,
    parse_object,
    parse_sector,
)


class SectorParsingTests(unittest.TestCase):
    def test_a_minimal_sector_parses_clean(self):
        parsed, errors = parse_sector(sector((0, 1)))
        self.assertEqual(errors, [])
        self.assertEqual(parsed.coordinate, (0, 1))

    def test_non_object_payload_is_rejected(self):
        parsed, errors = parse_sector(["not", "an", "object"])
        self.assertIsNone(parsed)
        self.assertEqual(codes(errors), {"type_error"})

    def test_coordinate_must_be_two_integers(self):
        """The grid is flat — a three-component coordinate is a stale client."""
        for bad in ([0], [0, 1, 0], [0, "y"], [True, 0], "0,1"):
            with self.subTest(bad=bad):
                parsed, errors = parse_sector(sector((0, 1), coordinate=bad))
                self.assertIsNone(parsed)
                self.assertEqual(codes(errors), {"type_error"})

    def test_all_three_texts_are_required(self):
        for field in ("title", "short_description", "long_description"):
            with self.subTest(field=field):
                _, errors = parse_sector(sector((0, 1), **{field: "  "}))
                self.assertIn("empty_text", codes(errors))
                _, errors = parse_sector(sector((0, 1), **{field: None}))
                self.assertIn("type_error", codes(errors))

    def test_each_text_has_its_own_cap(self):
        caps = {
            "title": MAX_TITLE_LEN,
            "short_description": MAX_SHORT_DESCRIPTION_LEN,
            "long_description": MAX_LONG_DESCRIPTION_LEN,
        }
        for field, cap in caps.items():
            with self.subTest(field=field):
                _, errors = parse_sector(sector((0, 1), **{field: "x" * (cap + 1)}))
                self.assertIn("too_long", codes(errors))
                _, errors = parse_sector(sector((0, 1), **{field: "x" * cap}))
                self.assertEqual(errors, [])

    def test_declared_exits_are_rejected_as_an_unknown_field(self):
        """Exits are derived from adjacency; declaring them is a stale client."""
        _, errors = parse_sector(sector((0, 1), exits=[{"direction": "north"}]))
        self.assertIn("unknown_field", codes(errors))

    def test_control_characters_are_rejected(self):
        _, errors = parse_sector(sector((0, 1), long_description="a\x07b"))
        self.assertIn("control_characters", codes(errors))

    def test_oversized_payload_is_rejected_outright(self):
        parsed, errors = parse_sector(sector((0, 1), title="x" * 40_000))
        self.assertIsNone(parsed)
        self.assertIn("too_large", codes(errors))

    def test_round_trip_through_as_dict_is_stable(self):
        parsed, errors = parse_sector(sector((2, -3)))
        self.assertEqual(errors, [])
        reparsed, errors = parse_sector(parsed.as_dict())
        self.assertEqual((errors, reparsed), ([], parsed))


class ObjectParsingTests(unittest.TestCase):
    def test_a_minimal_object_parses_clean(self):
        parsed, errors = parse_object(obj("sec_abc123"))
        self.assertEqual(errors, [])
        self.assertEqual(parsed.parent_id, "sec_abc123")

    def test_a_parent_id_may_be_a_sector_id_or_an_object_id(self):
        parsed, errors = parse_object(obj("obj_abc123"))
        self.assertEqual((errors, parsed.parent_id), ([], "obj_abc123"))

    def test_a_null_parent_id_is_rejected(self):
        """parent_id is required — null used to mean the sector itself; now the
        sector's own id does, so there is nothing left for null to mean."""
        _, errors = parse_object(obj(None))
        self.assertIn("type_error", codes(errors))

    def test_a_missing_parent_id_is_rejected(self):
        payload = obj("sec_abc123")
        del payload["parent_id"]
        _, errors = parse_object(payload)
        self.assertIn("type_error", codes(errors))

    def test_a_non_string_parent_is_rejected(self):
        _, errors = parse_object(obj(17))
        self.assertIn("type_error", codes(errors))

    def test_title_and_description_are_required(self):
        for field in ("title", "description"):
            with self.subTest(field=field):
                _, errors = parse_object(obj("sec_abc123", **{field: ""}))
                self.assertIn("empty_text", codes(errors))

    def test_unknown_fields_are_reported(self):
        """The UOI tags are gone — a client still sending them should hear so."""
        _, errors = parse_object(obj("sec_abc123", weight_class="light", is_weapon=False))
        self.assertIn("unknown_field", codes(errors))


if __name__ == "__main__":
    unittest.main()
