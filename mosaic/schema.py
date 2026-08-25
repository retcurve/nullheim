"""The room blueprint schema — the single source of truth for the contract.

Everything an agent may invent lives in free-text fields with only a length cap.
Everything the engine must reason about lives in rigid, enumerated fields. The
docs and the prompt template are written from this module; ``tests/test_drift``
asserts they still agree with it.
"""

from __future__ import annotations

import json
from dataclasses import dataclass, field
from enum import Enum
from typing import Any

from .coords import Coordinate, Direction
from .errors import Collector

# --- Limits -----------------------------------------------------------------
# Referenced by name in docs/BLUEPRINT_SCHEMA.md and prompts/room_architect.md.

MAX_NAME_LEN = 64
MAX_DESCRIPTION_LEN = 2000
MAX_EXIT_DESCRIPTION_LEN = 400
MAX_LOCK_HINT_LEN = 200
MAX_ITEM_DESCRIPTION_LEN = 600
MAX_EXITS = 6
MIN_EXITS = 1
MAX_ITEMS = 12
MAX_AMBIENT_LINES = 8
MAX_AMBIENT_LINE_LEN = 240
MAX_CONTAINER_CAPACITY = 8
MAX_NESTING_DEPTH = 2
MAX_BLUEPRINT_BYTES = 32_768


class WeightClass(str, Enum):
    NEGLIGIBLE = "negligible"
    LIGHT = "light"
    MEDIUM = "medium"
    HEAVY = "heavy"
    IMMOVABLE = "immovable"


# --- Structures -------------------------------------------------------------


@dataclass(frozen=True)
class Item:
    """A Universal Object Interface entry.

    ``name`` and ``description`` are the agent's to invent. The remaining fields
    are what the global physics engine reads when this item is carried three
    sectors away into somebody else's tonal universe.
    """

    name: str
    description: str
    weight_class: WeightClass
    is_weapon: bool = False
    is_container: bool = False
    container_capacity: int = 0
    contents: tuple["Item", ...] = ()
    is_wearable: bool = False
    is_consumable: bool = False
    is_light_source: bool = False

    def as_dict(self) -> dict[str, Any]:
        return {
            "name": self.name,
            "description": self.description,
            "weight_class": self.weight_class.value,
            "is_weapon": self.is_weapon,
            "is_container": self.is_container,
            "container_capacity": self.container_capacity,
            "contents": [item.as_dict() for item in self.contents],
            "is_wearable": self.is_wearable,
            "is_consumable": self.is_consumable,
            "is_light_source": self.is_light_source,
        }


@dataclass(frozen=True)
class Exit:
    direction: Direction
    description: str
    is_locked: bool = False
    lock_hint: str | None = None

    def as_dict(self) -> dict[str, Any]:
        return {
            "direction": self.direction.value,
            "description": self.description,
            "is_locked": self.is_locked,
            "lock_hint": self.lock_hint,
        }


@dataclass(frozen=True)
class Blueprint:
    coordinate: Coordinate
    name: str
    description: str
    exits: tuple[Exit, ...] = ()
    items: tuple[Item, ...] = ()
    ambient_lines: tuple[str, ...] = ()

    def as_dict(self) -> dict[str, Any]:
        return {
            "coordinate": self.coordinate.as_list(),
            "name": self.name,
            "description": self.description,
            "exits": [exit_.as_dict() for exit_ in self.exits],
            "items": [item.as_dict() for item in self.items],
            "ambient_lines": list(self.ambient_lines),
        }

    def exit_for(self, direction: Direction) -> Exit | None:
        for exit_ in self.exits:
            if exit_.direction is direction:
                return exit_
        return None


# Field inventories, used by the drift test and served at /v1/spec.
BLUEPRINT_FIELDS = ("coordinate", "name", "description", "exits", "items", "ambient_lines")
EXIT_FIELDS = ("direction", "description", "is_locked", "lock_hint")
ITEM_FIELDS = (
    "name",
    "description",
    "weight_class",
    "is_weapon",
    "is_container",
    "container_capacity",
    "contents",
    "is_wearable",
    "is_consumable",
    "is_light_source",
)


# --- Parsing ----------------------------------------------------------------
#
# Parsing is structural only: it proves the payload has the right shape and
# types. Semantic rules (reciprocity, loop guards, trap rooms) live in
# validation.py and run against a parsed Blueprint.


def _text(raw: Any, cap: int, path: str, errors: Collector, *, required: bool = True) -> str:
    if raw is None and not required:
        return ""
    if not isinstance(raw, str):
        errors.add("type_error", path, "expected a string")
        return ""
    if not raw.strip() and required:
        errors.add("empty_text", path, "must not be blank")
        return raw
    if len(raw) > cap:
        errors.add("too_long", path, f"must be at most {cap} characters (got {len(raw)})")
    if any(ord(ch) < 32 and ch not in "\n\t" for ch in raw):
        errors.add("control_characters", path, "must not contain control characters")
    return raw


def _flag(raw: Any, path: str, errors: Collector, *, default: bool = False) -> bool:
    if raw is None:
        return default
    if not isinstance(raw, bool):
        errors.add("type_error", path, "expected true or false")
        return default
    return raw


def _parse_item(raw: Any, path: str, depth: int, errors: Collector) -> Item | None:
    if not isinstance(raw, dict):
        errors.add("type_error", path, "expected an object")
        return None

    unknown = sorted(set(raw) - set(ITEM_FIELDS))
    if unknown:
        errors.add("unknown_field", path, f"unrecognised fields: {', '.join(unknown)}")

    name = _text(raw.get("name"), MAX_NAME_LEN, f"{path}.name", errors)
    description = _text(
        raw.get("description"), MAX_ITEM_DESCRIPTION_LEN, f"{path}.description", errors
    )

    weight_raw = raw.get("weight_class")
    try:
        weight = WeightClass(weight_raw)
    except ValueError:
        allowed = ", ".join(w.value for w in WeightClass)
        errors.add("bad_enum", f"{path}.weight_class", f"must be one of: {allowed}")
        weight = WeightClass.MEDIUM

    is_container = _flag(raw.get("is_container"), f"{path}.is_container", errors)

    capacity_raw = raw.get("container_capacity")
    capacity = 0
    if is_container:
        if isinstance(capacity_raw, bool) or not isinstance(capacity_raw, int):
            errors.add(
                "required_field",
                f"{path}.container_capacity",
                "containers must declare an integer container_capacity",
            )
        elif not 0 <= capacity_raw <= MAX_CONTAINER_CAPACITY:
            errors.add(
                "out_of_range",
                f"{path}.container_capacity",
                f"must be between 0 and {MAX_CONTAINER_CAPACITY}",
            )
        else:
            capacity = capacity_raw
    elif capacity_raw not in (None, 0):
        errors.add(
            "not_applicable",
            f"{path}.container_capacity",
            "only containers may declare a container_capacity",
        )

    contents: list[Item] = []
    contents_raw = raw.get("contents") or []
    if not isinstance(contents_raw, list):
        errors.add("type_error", f"{path}.contents", "expected a list")
    elif contents_raw and not is_container:
        errors.add("not_applicable", f"{path}.contents", "only containers may hold contents")
    elif depth >= MAX_NESTING_DEPTH and contents_raw:
        errors.add(
            "too_deep",
            f"{path}.contents",
            f"containers may nest at most {MAX_NESTING_DEPTH} deep",
        )
    else:
        for index, child_raw in enumerate(contents_raw):
            child = _parse_item(child_raw, f"{path}.contents[{index}]", depth + 1, errors)
            if child is not None:
                contents.append(child)

    return Item(
        name=name,
        description=description,
        weight_class=weight,
        is_weapon=_flag(raw.get("is_weapon"), f"{path}.is_weapon", errors),
        is_container=is_container,
        container_capacity=capacity,
        contents=tuple(contents),
        is_wearable=_flag(raw.get("is_wearable"), f"{path}.is_wearable", errors),
        is_consumable=_flag(raw.get("is_consumable"), f"{path}.is_consumable", errors),
        is_light_source=_flag(raw.get("is_light_source"), f"{path}.is_light_source", errors),
    )


def _parse_exit(raw: Any, path: str, errors: Collector) -> Exit | None:
    if not isinstance(raw, dict):
        errors.add("type_error", path, "expected an object")
        return None

    unknown = sorted(set(raw) - set(EXIT_FIELDS))
    if unknown:
        errors.add("unknown_field", path, f"unrecognised fields: {', '.join(unknown)}")

    try:
        direction = Direction(raw.get("direction"))
    except ValueError:
        allowed = ", ".join(d.value for d in Direction)
        errors.add("bad_enum", f"{path}.direction", f"must be one of: {allowed}")
        return None

    description = _text(
        raw.get("description"), MAX_EXIT_DESCRIPTION_LEN, f"{path}.description", errors
    )
    is_locked = _flag(raw.get("is_locked"), f"{path}.is_locked", errors)

    lock_hint = raw.get("lock_hint")
    if is_locked:
        lock_hint = _text(lock_hint, MAX_LOCK_HINT_LEN, f"{path}.lock_hint", errors)
    elif lock_hint is not None:
        errors.add(
            "not_applicable", f"{path}.lock_hint", "only locked exits may carry a lock_hint"
        )
        lock_hint = None

    return Exit(
        direction=direction,
        description=description,
        is_locked=is_locked,
        lock_hint=lock_hint or None,
    )


def parse_blueprint(raw: Any) -> tuple[Blueprint | None, list]:
    """Structurally parse an untrusted payload.

    Returns ``(blueprint, errors)``. The blueprint is ``None`` only when the
    payload is too broken to reason about at all; otherwise a best-effort
    Blueprint comes back alongside every error found, so an agent can fix
    everything in one pass.
    """
    errors = Collector()

    if not isinstance(raw, dict):
        errors.add("type_error", "$", "blueprint must be a JSON object")
        return None, errors.errors

    encoded = len(json.dumps(raw).encode("utf-8"))
    if encoded > MAX_BLUEPRINT_BYTES:
        errors.add(
            "too_large",
            "$",
            f"blueprint must serialise to at most {MAX_BLUEPRINT_BYTES} bytes (got {encoded})",
        )
        return None, errors.errors

    unknown = sorted(set(raw) - set(BLUEPRINT_FIELDS))
    if unknown:
        errors.add("unknown_field", "$", f"unrecognised fields: {', '.join(unknown)}")

    try:
        coordinate = Coordinate.parse(raw.get("coordinate"))
    except ValueError as exc:
        errors.add("type_error", "$.coordinate", str(exc))
        return None, errors.errors

    name = _text(raw.get("name"), MAX_NAME_LEN, "$.name", errors)
    description = _text(raw.get("description"), MAX_DESCRIPTION_LEN, "$.description", errors)

    exits: list[Exit] = []
    exits_raw = raw.get("exits")
    if not isinstance(exits_raw, list):
        errors.add("type_error", "$.exits", "expected a list")
    else:
        if len(exits_raw) > MAX_EXITS:
            errors.add("too_many", "$.exits", f"at most {MAX_EXITS} exits")
        for index, exit_raw in enumerate(exits_raw[:MAX_EXITS]):
            parsed = _parse_exit(exit_raw, f"$.exits[{index}]", errors)
            if parsed is not None:
                exits.append(parsed)

    items: list[Item] = []
    items_raw = raw.get("items") or []
    if not isinstance(items_raw, list):
        errors.add("type_error", "$.items", "expected a list")
    else:
        if len(items_raw) > MAX_ITEMS:
            errors.add("too_many", "$.items", f"at most {MAX_ITEMS} items")
        for index, item_raw in enumerate(items_raw[:MAX_ITEMS]):
            parsed_item = _parse_item(item_raw, f"$.items[{index}]", 0, errors)
            if parsed_item is not None:
                items.append(parsed_item)

    ambient: list[str] = []
    ambient_raw = raw.get("ambient_lines") or []
    if not isinstance(ambient_raw, list):
        errors.add("type_error", "$.ambient_lines", "expected a list")
    else:
        if len(ambient_raw) > MAX_AMBIENT_LINES:
            errors.add(
                "too_many", "$.ambient_lines", f"at most {MAX_AMBIENT_LINES} lines"
            )
        for index, line in enumerate(ambient_raw[:MAX_AMBIENT_LINES]):
            ambient.append(
                _text(line, MAX_AMBIENT_LINE_LEN, f"$.ambient_lines[{index}]", errors)
            )

    blueprint = Blueprint(
        coordinate=coordinate,
        name=name,
        description=description,
        exits=tuple(exits),
        items=tuple(items),
        ambient_lines=tuple(ambient),
    )
    return blueprint, errors.errors
