"""Semantic validation — the gate between a well-formed payload and the world.

There is very little left to check, and that is the design working rather than a
gap. Exits are derived from adjacency instead of declared, so there are no
borders to disagree about. An object's parent must already exist, so the object
graph is a tree by construction and there is no cycle to hunt for.

What remains is ownership and identity: is this the sector you claimed, and is
that parent really yours?
"""

from __future__ import annotations

from .coords import Coordinate
from .errors import Collector, ValidationError
from .schema import ObjectDraft, Sector


def validate_sector(sector: Sector, claimed: Coordinate, store) -> list[ValidationError]:
    """Rules for a sector submission. Empty list means it may be baked."""
    errors = Collector()

    if sector.coordinate != claimed:
        errors.add(
            "coordinate_mismatch",
            "$.coordinate",
            f"submission is for {sector.coordinate} but the claim is for {claimed}",
        )
        return errors.errors

    if not sector.coordinate.in_bounds:
        errors.add("out_of_bounds", "$.coordinate", f"{sector.coordinate} is off the lattice")

    if store.is_baked(sector.coordinate):
        errors.add(
            "already_baked",
            "$.coordinate",
            f"{sector.coordinate} is already part of the world and cannot be rewritten",
        )

    # Allocation only ever hands out coordinates touching the existing world, so
    # this should be unreachable. It is asserted anyway: an orphan sector would
    # be permanently unreachable by players and impossible to repair.
    if store.count() and not any(
        store.is_baked(neighbour) for _, neighbour in sector.coordinate.neighbours()
    ):
        errors.add(
            "orphan_sector",
            "$.coordinate",
            f"{sector.coordinate} touches no existing sector, so no player could ever reach it",
        )

    return errors.errors


def validate_object(
    draft: ObjectDraft, sector_coordinate: Coordinate, store
) -> list[ValidationError]:
    """Rules for an object submission.

    The parent has to exist and has to stand in this agent's own sector. Both
    checks are really the same one: an agent may furnish its own room and
    nobody else's.
    """
    errors = Collector()

    if draft.parent_id is None:
        return errors.errors  # hanging it on the sector itself is always fine

    parent = store.get_object(draft.parent_id)
    if parent is None:
        errors.add(
            "no_such_parent",
            "$.parent_id",
            f"there is no object {draft.parent_id!r} in the world",
        )
    elif parent.coordinate != sector_coordinate:
        # Deliberately the same message as a missing parent. An agent has no
        # business learning what stands in somebody else's sector.
        errors.add(
            "no_such_parent",
            "$.parent_id",
            f"there is no object {draft.parent_id!r} in your sector",
        )

    return errors.errors
