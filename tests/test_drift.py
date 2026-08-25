"""The contract is stated three times. These tests keep the three in agreement.

`schema.py` is the source of truth. The prompt tells agents what to emit and the
docs tell their authors the same thing — if either drifts from the dataclasses,
agents get rejected for obeying instructions that are no longer true.
"""

import json
import unittest
from pathlib import Path

from helpers import make_engine

from mosaic.coords import Direction
from mosaic.schema import (
    BLUEPRINT_FIELDS,
    EXIT_FIELDS,
    ITEM_FIELDS,
    MAX_CONTAINER_CAPACITY,
    MAX_EXITS,
    MAX_ITEMS,
    MAX_NESTING_DEPTH,
    Blueprint,
    Exit,
    Item,
    WeightClass,
    parse_blueprint,
)

ROOT = Path(__file__).resolve().parent.parent
PROMPT = (ROOT / "prompts" / "room_architect.md").read_text(encoding="utf-8")
SCHEMA_DOC = (ROOT / "docs" / "BLUEPRINT_SCHEMA.md").read_text(encoding="utf-8")
UOI_DOC = (ROOT / "docs" / "UOI.md").read_text(encoding="utf-8")
API_DOC = (ROOT / "docs" / "API.md").read_text(encoding="utf-8")


class FieldInventoryTests(unittest.TestCase):
    def test_the_declared_inventories_match_the_dataclasses(self):
        self.assertEqual(set(BLUEPRINT_FIELDS), set(Blueprint.__dataclass_fields__))
        self.assertEqual(set(EXIT_FIELDS), set(Exit.__dataclass_fields__))
        self.assertEqual(set(ITEM_FIELDS), set(Item.__dataclass_fields__))

    def test_the_prompt_names_every_field(self):
        for field in BLUEPRINT_FIELDS + EXIT_FIELDS + ITEM_FIELDS:
            with self.subTest(field=field):
                self.assertIn(f'"{field}"', PROMPT)

    def test_the_schema_doc_names_every_field(self):
        for field in BLUEPRINT_FIELDS + EXIT_FIELDS + ITEM_FIELDS:
            with self.subTest(field=field):
                self.assertIn(f"`{field}`", SCHEMA_DOC + UOI_DOC)

    def test_the_prompt_names_every_direction_and_weight_class(self):
        for value in [d.value for d in Direction] + [w.value for w in WeightClass]:
            with self.subTest(value=value):
                self.assertIn(value, PROMPT)

    def test_the_prompt_states_the_current_limits(self):
        for limit in (MAX_EXITS, MAX_ITEMS, MAX_NESTING_DEPTH, MAX_CONTAINER_CAPACITY):
            with self.subTest(limit=limit):
                self.assertIn(str(limit), PROMPT)


class PromptExampleTests(unittest.TestCase):
    """The worked examples must be submittable, not just plausible."""

    @staticmethod
    def _examples():
        blocks, inside = [], []
        fence = False
        for line in PROMPT.splitlines():
            if line.strip() == "```json":
                fence, inside = True, []
                continue
            if fence and line.strip() == "```":
                fence = False
                blocks.append("\n".join(inside))
                continue
            if fence:
                inside.append(line)
        return blocks

    def test_the_examples_are_valid_json(self):
        blocks = self._examples()
        self.assertGreaterEqual(len(blocks), 3)  # the skeleton plus two rooms
        for block in blocks:
            json.loads(block)

    def test_the_worked_rooms_parse_without_a_single_error(self):
        # The first block is the annotated skeleton with placeholder strings;
        # the rest are complete rooms an agent could really submit.
        for block in self._examples()[1:]:
            with self.subTest(block=block[:40]):
                parsed, errors = parse_blueprint(json.loads(block))
                self.assertEqual(errors, [])
                self.assertIsNotNone(parsed)


class PlaceholderTests(unittest.TestCase):
    def test_every_placeholder_in_the_template_gets_filled(self):
        engine = make_engine()
        agent, _ = engine.register("architect")
        claim = engine.claim(agent)
        rendered = engine.render_prompt(claim)
        self.assertNotIn("{{", rendered)
        self.assertIn(str(claim.coordinate), rendered)
        self.assertIn(claim.claim_id, rendered)


class ApiDocTests(unittest.TestCase):
    def test_the_api_doc_lists_every_route(self):
        from mosaic.api import ROUTES

        for verb, pattern, _ in ROUTES:
            readable = (
                pattern.pattern.replace(r"(-?\d+)", "{n}").replace(r"([\w-]+)", "{id}")
            )
            with self.subTest(route=f"{verb} {readable}"):
                self.assertIn(readable, API_DOC)


if __name__ == "__main__":
    unittest.main()
