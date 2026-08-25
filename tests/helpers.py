"""Shared fixtures for the test suite."""

from __future__ import annotations

import random
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent.parent))

from mosaic.coords import Coordinate  # noqa: E402
from mosaic.engine import Engine  # noqa: E402
from mosaic.registry import Registry  # noqa: E402
from mosaic.store import InMemoryGraphStore  # noqa: E402


def make_engine(lease_seconds: int = 900, seed: int = 1) -> Engine:
    """A fresh in-memory world with a deterministic frontier allocator."""
    store = InMemoryGraphStore()
    registry = Registry(store, lease_seconds=lease_seconds, rng=random.Random(seed))
    return Engine(store=store, registry=registry)


def blueprint(at, directions=("north",), **overrides) -> dict:
    """A minimal, valid blueprint at coordinate ``at``."""
    payload = {
        "coordinate": list(at),
        "name": "A Room",
        "description": "It is a room, and it is here.",
        "exits": [
            {
                "direction": direction,
                "description": f"An opening to the {direction}.",
                "is_locked": False,
                "lock_hint": None,
            }
            for direction in directions
        ],
        "items": [],
        "ambient_lines": [],
    }
    payload.update(overrides)
    return payload


def item(name="Thing", **overrides) -> dict:
    payload = {
        "name": name,
        "description": "An object of some kind.",
        "weight_class": "light",
        "is_weapon": False,
        "is_container": False,
        "container_capacity": 0,
        "contents": [],
        "is_wearable": False,
        "is_consumable": False,
        "is_light_source": False,
    }
    payload.update(overrides)
    return payload


def claim_for(engine: Engine, label: str = "tester"):
    agent, token = engine.register(label)
    return engine.claim(agent), token


def codes(errors) -> set[str]:
    return {error.code for error in errors}


def bake(engine, at, directions=("north",), agent_id="agent_test", **overrides):
    """Bake a room straight into the store, bypassing claim allocation.

    Tests that care about graph shape should place rooms explicitly rather than
    depending on which slot the frontier allocator happens to hand out.
    """
    from mosaic.schema import parse_blueprint
    from mosaic.store import BakedRoom

    parsed, errors = parse_blueprint(blueprint(at, directions, **overrides))
    assert parsed is not None and not errors, errors
    room = BakedRoom(blueprint=parsed, agent_id=agent_id, baked_at=0.0)
    engine.store.bake(room)
    return room
