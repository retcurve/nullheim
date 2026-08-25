"""The submission schemas — the single source of truth for the contract.

Agents submit two kinds of thing, and both are almost entirely free text. There
is no structural payload left for an agent to get wrong: exits are derived from
adjacency by the engine, not declared, and an object's place in the world is a
single parent reference.

The docs and the prompt templates are written from this module;
``tests/test_drift.py`` asserts they still agree with it.
"""

from __future__ import annotations

import json
from dataclasses import dataclass
from typing import Any

from .coords import Coordinate
from .errors import Collector

# --- Limits -----------------------------------------------------------------
# Referenced by name in docs/ and prompts/.

MAX_TITLE_LEN = 64
MAX_SHORT_DESCRIPTION_LEN = 300
MAX_LONG_DESCRIPTION_LEN = 4000
MAX_OBJECT_DESCRIPTION_LEN = 2000
MAX_SUBMISSION_BYTES = 32_768


# --- Sector -----------------------------------------------------------------


@dataclass(frozen=True)
class Sector:
    """One authored square of the world.

    The three texts do three different jobs, and an agent that confuses them
    produces a room that reads wrong from next door:

    ``title`` is not just a name — it is the label a player sees on the exit
    leading here from every adjacent sector. It has to work as a signpost read
    from outside.

    ``short_description`` is what a player sees when they examine that exit
    without walking through it. A glimpse through the doorway.

    ``long_description`` is the room itself, shown on arrival.
    """

    coordinate: Coordinate
    title: str
    short_description: str
    long_description: str

    def as_dict(self) -> dict[str, Any]:
        return {
            "coordinate": self.coordinate.as_list(),
            "title": self.title,
            "short_description": self.short_description,
            "long_description": self.long_description,
        }


SECTOR_FIELDS = ("coordinate", "title", "short_description", "long_description")


# --- Object -----------------------------------------------------------------


@dataclass(frozen=True)
class ObjectDraft:
    """An object an agent wants to hang somewhere in its sector.

    ``parent_id`` of ``None`` means the sector itself; otherwise it names an
    object already standing in that sector. Because a parent must already exist,
    the object graph is a tree by construction — there is no cycle to guard
    against.
    """

    parent_id: str | None
    title: str
    description: str

    def as_dict(self) -> dict[str, Any]:
        return {
            "parent_id": self.parent_id,
            "title": self.title,
            "description": self.description,
        }


OBJECT_FIELDS = ("parent_id", "title", "description")


# --- Parsing ----------------------------------------------------------------
#
# Parsing is structural only: it proves the payload has the right shape and
# types. Whether a coordinate is the one you claimed, or a parent really exists,
# is decided in validation.py.


def _text(raw: Any, cap: int, path: str, errors: Collector) -> str:
    if not isinstance(raw, str):
        errors.add("type_error", path, "expected a string")
        return ""
    if not raw.strip():
        errors.add("empty_text", path, "must not be blank")
        return raw
    if len(raw) > cap:
        errors.add("too_long", path, f"must be at most {cap} characters (got {len(raw)})")
    if any(ord(ch) < 32 and ch not in "\n\t" for ch in raw):
        errors.add("control_characters", path, "must not contain control characters")
    return raw


def _oversized(raw: Any, errors: Collector) -> bool:
    encoded = len(json.dumps(raw).encode("utf-8"))
    if encoded > MAX_SUBMISSION_BYTES:
        errors.add(
            "too_large",
            "$",
            f"submission must serialise to at most {MAX_SUBMISSION_BYTES} bytes (got {encoded})",
        )
        return True
    return False


def parse_sector(raw: Any) -> tuple[Sector | None, list]:
    """Structurally parse an untrusted sector submission.

    Returns ``(sector, errors)``. Every problem found is reported at once, so an
    agent never has to resubmit to discover the next one.
    """
    errors = Collector()

    if not isinstance(raw, dict):
        errors.add("type_error", "$", "a sector must be a JSON object")
        return None, errors.errors
    if _oversized(raw, errors):
        return None, errors.errors

    unknown = sorted(set(raw) - set(SECTOR_FIELDS))
    if unknown:
        errors.add("unknown_field", "$", f"unrecognised fields: {', '.join(unknown)}")

    try:
        coordinate = Coordinate.parse(raw.get("coordinate"))
    except ValueError as exc:
        errors.add("type_error", "$.coordinate", str(exc))
        return None, errors.errors

    sector = Sector(
        coordinate=coordinate,
        title=_text(raw.get("title"), MAX_TITLE_LEN, "$.title", errors),
        short_description=_text(
            raw.get("short_description"),
            MAX_SHORT_DESCRIPTION_LEN,
            "$.short_description",
            errors,
        ),
        long_description=_text(
            raw.get("long_description"),
            MAX_LONG_DESCRIPTION_LEN,
            "$.long_description",
            errors,
        ),
    )
    return sector, errors.errors


def parse_object(raw: Any) -> tuple[ObjectDraft | None, list]:
    """Structurally parse an untrusted object submission."""
    errors = Collector()

    if not isinstance(raw, dict):
        errors.add("type_error", "$", "an object must be a JSON object")
        return None, errors.errors
    if _oversized(raw, errors):
        return None, errors.errors

    unknown = sorted(set(raw) - set(OBJECT_FIELDS))
    if unknown:
        errors.add("unknown_field", "$", f"unrecognised fields: {', '.join(unknown)}")

    parent_id = raw.get("parent_id")
    if parent_id is not None and not isinstance(parent_id, str):
        errors.add(
            "type_error",
            "$.parent_id",
            "expected an object id, or null to hang this on the sector itself",
        )
        parent_id = None

    draft = ObjectDraft(
        parent_id=parent_id,
        title=_text(raw.get("title"), MAX_TITLE_LEN, "$.title", errors),
        description=_text(
            raw.get("description"), MAX_OBJECT_DESCRIPTION_LEN, "$.description", errors
        ),
    )
    return draft, errors.errors
