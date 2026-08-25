"""Semantic validation — the gate between a well-formed payload and the graph.

``schema.parse_blueprint`` proves a submission has the right *shape*. These rules
prove it is safe to bake permanently: that its borders match its neighbours',
that a player can get back out, and that no item nests into itself forever.

Every rule is a pure function of (blueprint, coordinate, store) so each one can
be tested in isolation.
"""

from __future__ import annotations

from .coords import Coordinate, Direction
from .errors import Collector, ValidationError
from .schema import Blueprint, Item, WeightClass


def _check_coordinate(bp: Blueprint, claimed: Coordinate, errors: Collector) -> None:
    if bp.coordinate != claimed:
        errors.add(
            "coordinate_mismatch",
            "$.coordinate",
            f"blueprint is for {bp.coordinate} but the claim is for {claimed}",
        )


def _check_exits_wellformed(bp: Blueprint, errors: Collector) -> None:
    seen: set[Direction] = set()
    for index, exit_ in enumerate(bp.exits):
        if exit_.direction in seen:
            errors.add(
                "duplicate_exit",
                f"$.exits[{index}]",
                f"{exit_.direction.value} is declared more than once",
            )
        seen.add(exit_.direction)

        target = bp.coordinate.step(exit_.direction)
        if not target.in_bounds:
            errors.add(
                "out_of_bounds",
                f"$.exits[{index}]",
                f"{exit_.direction.value} leads to {target}, outside the lattice",
            )

    if len(bp.exits) < 1:
        errors.add("no_exits", "$.exits", "a room must declare at least one exit")


def _check_reciprocity(bp: Blueprint, store, errors: Collector) -> None:
    """Borders must agree in both directions.

    Two failure modes, both fatal to a shared world: a promised doorway the new
    room walls off, and a new doorway punched into a finished room that never
    agreed to it.
    """
    promised = store.promises_into(bp.coordinate)
    declared = {exit_.direction for exit_ in bp.exits}

    for direction, neighbour_exit in promised.items():
        if direction not in declared:
            neighbour_coord = bp.coordinate.step(direction)
            errors.add(
                "unfulfilled_promise",
                "$.exits",
                (
                    f"the room at {neighbour_coord} already opens onto this sector, so a "
                    f"{direction.value} exit is required. Its doorway reads: "
                    f"{neighbour_exit.description!r}"
                ),
            )

    for index, exit_ in enumerate(bp.exits):
        target = bp.coordinate.step(exit_.direction)
        if store.is_baked(target) and exit_.direction not in promised:
            errors.add(
                "unsanctioned_exit",
                f"$.exits[{index}]",
                (
                    f"the room at {target} is already baked and has no matching doorway; "
                    f"a {exit_.direction.value} exit here would be one-way"
                ),
            )


def _check_not_a_trap(bp: Blueprint, errors: Collector) -> None:
    """A player who walks in must be able to walk out."""
    if bp.exits and all(exit_.is_locked for exit_ in bp.exits):
        errors.add(
            "trap_room",
            "$.exits",
            "at least one exit must be unlocked, or players who enter can never leave",
        )


def _walk_items(items, path: str, ancestors: tuple[str, ...], errors: Collector) -> None:
    for index, item in enumerate(items):
        item_path = f"{path}[{index}]"
        _check_item(item, item_path, ancestors, errors)
        if item.contents:
            _walk_items(
                item.contents,
                f"{item_path}.contents",
                ancestors + (item.name.strip().casefold(),),
                errors,
            )


def _check_item(item: Item, path: str, ancestors: tuple[str, ...], errors: Collector) -> None:
    # Self-nesting: a satchel that contains a satchel that contains a satchel is
    # an unbounded object graph the physics engine would descend forever.
    if item.name.strip().casefold() in ancestors:
        errors.add(
            "container_cycle",
            f"{path}.name",
            f"{item.name!r} is nested inside an item of the same name",
        )

    if item.is_container and len(item.contents) > item.container_capacity:
        errors.add(
            "over_capacity",
            f"{path}.contents",
            f"holds {len(item.contents)} items but declares capacity {item.container_capacity}",
        )

    if item.weight_class is WeightClass.IMMOVABLE:
        if ancestors:
            errors.add(
                "immovable_nested",
                f"{path}.weight_class",
                "an immovable item cannot be inside a container",
            )
        for flag, phrase in (
            ("is_weapon", "a weapon"),
            ("is_wearable", "wearable"),
            ("is_consumable", "consumable"),
        ):
            if getattr(item, flag):
                errors.add(
                    "immovable_conflict",
                    f"{path}.{flag}",
                    f"an immovable item cannot be {phrase}",
                )

    if item.is_consumable and item.contents:
        errors.add(
            "consumable_container",
            f"{path}.contents",
            "a consumable item cannot hold contents — eating it would destroy them",
        )


def validate(bp: Blueprint, claimed: Coordinate, store) -> list[ValidationError]:
    """Run every semantic rule. An empty list means the blueprint may be baked."""
    errors = Collector()
    _check_coordinate(bp, claimed, errors)
    _check_exits_wellformed(bp, errors)
    _check_reciprocity(bp, store, errors)
    _check_not_a_trap(bp, errors)
    _walk_items(bp.items, "$.items", (), errors)
    return errors.errors
