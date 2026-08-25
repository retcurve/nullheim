"""Shared fixtures for the test suite."""

from __future__ import annotations

import random
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent.parent))

from mosaic.coords import Coordinate  # noqa: E402
from mosaic.engine import Engine  # noqa: E402
from mosaic.registry import Registry  # noqa: E402
from mosaic.store import InMemoryWorldStore  # noqa: E402


def make_engine(lease_seconds: int = 900, cooldown_seconds: int = 0, seed: int = 1) -> Engine:
    """A fresh in-memory world with a deterministic frontier allocator.

    Cooldown defaults to zero so object tests do not have to wait out a lease;
    the tests that care about the clock set it explicitly.
    """
    store = InMemoryWorldStore()
    registry = Registry(
        store,
        lease_seconds=lease_seconds,
        cooldown_seconds=cooldown_seconds,
        rng=random.Random(seed),
    )
    return Engine(store=store, registry=registry)


def sector(at, **overrides) -> dict:
    """A minimal, valid sector submission at ``at``."""
    payload = {
        "coordinate": list(at),
        "title": "A Place",
        "short_description": "A doorway, and something past it.",
        "long_description": "It is a place, and it is here.",
    }
    payload.update(overrides)
    return payload


def obj(**overrides) -> dict:
    payload = {"parent_id": None, "title": "A Thing", "description": "An object of some kind."}
    payload.update(overrides)
    return payload


def build(engine: Engine, at, agent_id="agent_test", **overrides):
    """Bake a sector straight into the store, bypassing claim allocation.

    Tests that care about world shape should place sectors explicitly rather
    than depending on which slot the frontier allocator happens to hand out.
    """
    from mosaic.schema import parse_sector
    from mosaic.store import BakedSector

    parsed, errors = parse_sector(sector(at, **overrides))
    assert parsed is not None and not errors, errors
    baked = BakedSector(sector=parsed, agent_id=agent_id, baked_at=0.0)
    engine.store.bake(baked)
    return baked


def settle(engine: Engine, label="tester"):
    """Register an agent and take it all the way through founding its sector."""
    agent, token = engine.register(label)
    claim = engine.claim(agent)
    baked, errors = engine.submit_sector(agent, claim, sector(claim.coordinate))
    assert not errors, errors
    return agent, token, baked


def codes(errors) -> set[str]:
    return {error.code for error in errors}
