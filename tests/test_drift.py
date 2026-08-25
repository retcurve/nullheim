"""The contract is stated three times. These tests keep the three in agreement.

`schema.py` is the source of truth. The prompts tell agents what to emit and the
docs tell their authors the same thing — if either drifts from the dataclasses,
agents get rejected for obeying instructions that are no longer true.
"""

import json
import unittest
from pathlib import Path

from helpers import make_engine, obj, sector, settle

from mosaic.coords import Direction
from mosaic.schema import (
    MAX_LONG_DESCRIPTION_LEN,
    MAX_OBJECT_DESCRIPTION_LEN,
    MAX_SHORT_DESCRIPTION_LEN,
    MAX_TITLE_LEN,
    OBJECT_FIELDS,
    SECTOR_FIELDS,
    ObjectDraft,
    Sector,
    parse_object,
    parse_sector,
)

ROOT = Path(__file__).resolve().parent.parent
SECTOR_PROMPT = (ROOT / "prompts" / "sector_architect.md").read_text(encoding="utf-8")
OBJECT_PROMPT = (ROOT / "prompts" / "object_artisan.md").read_text(encoding="utf-8")
SCHEMA_DOC = (ROOT / "docs" / "SCHEMA.md").read_text(encoding="utf-8")
API_DOC = (ROOT / "docs" / "API.md").read_text(encoding="utf-8")


def json_blocks(text: str) -> list[str]:
    blocks, inside, fence = [], [], False
    for line in text.splitlines():
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


class FieldInventoryTests(unittest.TestCase):
    def test_the_declared_inventories_match_the_dataclasses(self):
        self.assertEqual(set(SECTOR_FIELDS), set(Sector.__dataclass_fields__))
        self.assertEqual(set(OBJECT_FIELDS), set(ObjectDraft.__dataclass_fields__))

    def test_each_prompt_names_every_field_of_its_own_schema(self):
        for field in SECTOR_FIELDS:
            with self.subTest(field=field):
                self.assertIn(f'"{field}"', SECTOR_PROMPT)
        for field in OBJECT_FIELDS:
            with self.subTest(field=field):
                self.assertIn(f'"{field}"', OBJECT_PROMPT)

    def test_the_schema_doc_names_every_field(self):
        for field in SECTOR_FIELDS + OBJECT_FIELDS:
            with self.subTest(field=field):
                self.assertIn(f"`{field}`", SCHEMA_DOC)

    def test_the_prompts_state_the_current_limits(self):
        for limit in (MAX_TITLE_LEN, MAX_SHORT_DESCRIPTION_LEN, MAX_LONG_DESCRIPTION_LEN):
            with self.subTest(limit=limit):
                self.assertIn(str(limit), SECTOR_PROMPT)
        for limit in (MAX_TITLE_LEN, MAX_OBJECT_DESCRIPTION_LEN):
            with self.subTest(limit=limit):
                self.assertIn(str(limit), OBJECT_PROMPT)

    def test_the_grid_is_documented_as_flat(self):
        """A prompt that still mentions up or down would produce bad titles."""
        self.assertIn("no up or down", SECTOR_PROMPT)
        for direction in Direction:
            self.assertIn(direction.value, SECTOR_PROMPT)
        for stale in ('"up"', '"down"', '"exits"', "weight_class"):
            with self.subTest(stale=stale):
                self.assertNotIn(stale, SECTOR_PROMPT)
                self.assertNotIn(stale, OBJECT_PROMPT)


class PromptExampleTests(unittest.TestCase):
    """The worked examples must be submittable, not just plausible."""

    def test_the_sector_examples_parse_without_a_single_error(self):
        blocks = json_blocks(SECTOR_PROMPT)
        self.assertGreaterEqual(len(blocks), 3)  # the skeleton plus two sectors
        for block in blocks[1:]:
            with self.subTest(block=block[:40]):
                parsed, errors = parse_sector(json.loads(block))
                self.assertEqual(errors, [])
                self.assertIsNotNone(parsed)

    def test_the_object_examples_parse_without_a_single_error(self):
        blocks = json_blocks(OBJECT_PROMPT)
        self.assertGreaterEqual(len(blocks), 3)
        for block in blocks[1:]:
            with self.subTest(block=block[:40]):
                parsed, errors = parse_object(json.loads(block))
                self.assertEqual(errors, [])
                self.assertIsNotNone(parsed)


class PlaceholderTests(unittest.TestCase):
    def test_the_sector_prompt_is_fully_filled(self):
        engine = make_engine()
        agent, _ = engine.register("architect")
        claim = engine.claim(agent)
        rendered = engine.render_sector_prompt(claim)
        self.assertNotIn("{{", rendered)
        self.assertIn(str(claim.coordinate), rendered)
        self.assertIn(claim.claim_id, rendered)

    def test_the_object_prompt_is_fully_filled_and_lists_what_is_there(self):
        engine = make_engine(cooldown_seconds=0)
        agent, _, _ = settle(engine)
        placed, _ = engine.create_object(agent, obj(title="Brass Can"))

        rendered = engine.render_object_prompt(agent)
        self.assertNotIn("{{", rendered)
        self.assertIn(placed.object_id, rendered)
        self.assertIn("Brass Can", rendered)

    def test_the_object_prompt_copes_with_a_bare_sector(self):
        engine = make_engine(cooldown_seconds=0)
        agent, _, _ = settle(engine)
        rendered = engine.render_object_prompt(agent)
        self.assertNotIn("{{", rendered)
        self.assertIn("nothing yet", rendered)


class ApiDocTests(unittest.TestCase):
    def test_the_api_doc_lists_every_route(self):
        from mosaic.api import ROUTES

        for verb, pattern, _ in ROUTES:
            readable = pattern.pattern.replace(r"(-?\d+)", "{n}").replace(r"([\w-]+)", "{id}")
            with self.subTest(route=f"{verb} {readable}"):
                self.assertIn(readable, API_DOC)


if __name__ == "__main__":
    unittest.main()
