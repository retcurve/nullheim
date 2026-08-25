"""World engine — the claim → context → validate → bake pipeline.

This is the only module that mutates the world, and it is where the static lock
lives: once ``submit`` succeeds, the room is permanent and its agent is spent.
"""

from __future__ import annotations

import time
from pathlib import Path
from typing import Any

from .coords import ORIGIN, Coordinate, Direction
from .errors import ValidationError
from .registry import Agent, Claim, ClaimStatus, Registry, SectorUnavailable
from .schema import Blueprint, Exit, parse_blueprint
from .store import BakedRoom, InMemoryGraphStore
from .validation import validate

PROMPT_PATH = Path(__file__).resolve().parent.parent / "prompts" / "room_architect.md"

GENESIS_AGENT_ID = "agent_genesis"

# The one room the system authors. It exists purely to seed a non-empty frontier;
# its own text is deliberately blank-canvas so it imposes no theme on anybody.
GENESIS = Blueprint(
    coordinate=ORIGIN,
    name="The Nullpoint",
    description=(
        "A perfectly unremarkable square of grey floor under a grey ceiling, lit by no "
        "visible source. It is the one room nobody dreamed. Four doorways lead away from "
        "it, and each one is already a different weather."
    ),
    exits=tuple(
        Exit(direction=d, description=f"A plain grey opening in the {d.value} wall.")
        for d in (Direction.NORTH, Direction.SOUTH, Direction.EAST, Direction.WEST)
    ),
    ambient_lines=("Somewhere beyond the walls, something is being decided.",),
)


class Engine:
    def __init__(
        self,
        store: InMemoryGraphStore | None = None,
        registry: Registry | None = None,
        *,
        state_path: str | None = None,
        lease_seconds: int | None = None,
    ) -> None:
        self.store = store or InMemoryGraphStore(path=state_path)
        if registry is not None:
            self.registry = registry
        elif lease_seconds is not None:
            self.registry = Registry(self.store, lease_seconds=lease_seconds)
        else:
            self.registry = Registry(self.store)
        self._ensure_genesis()

    def _ensure_genesis(self) -> None:
        if self.store.count() == 0:
            self.store.bake(
                BakedRoom(blueprint=GENESIS, agent_id=GENESIS_AGENT_ID, baked_at=time.time())
            )

    # --- lifecycle ----------------------------------------------------------

    def register(self, label: str) -> tuple[Agent, str]:
        return self.registry.register(label)

    def claim(self, agent: Agent) -> Claim:
        return self.registry.allocate(agent)

    def context(self, claim: Claim) -> dict[str, Any]:
        """Everything an agent needs to author its sector, and nothing more.

        Neighbour *exit* text is shared so borders can be anchored; neighbour
        room descriptions are deliberately withheld. Agents anchoring only the
        doorway is what preserves the tonal whiplash between sectors.
        """
        coordinate = claim.coordinate
        promises = self.store.promises_into(coordinate)

        required = [
            {
                "direction": direction.value,
                "neighbour": coordinate.step(direction).as_list(),
                "neighbour_room_name": self._neighbour_name(coordinate, direction),
                "their_doorway": exit_.description,
                "is_locked": exit_.is_locked,
                "lock_hint": exit_.lock_hint,
            }
            for direction, exit_ in sorted(promises.items(), key=lambda kv: kv[0].value)
        ]

        open_sides = [
            direction.value
            for direction, target in coordinate.neighbours()
            if direction not in promises
            and not self.store.is_baked(target)
            and target.in_bounds
        ]

        sealed = [
            direction.value
            for direction, target in coordinate.neighbours()
            if direction not in promises and self.store.is_baked(target)
        ]

        return {
            "claim": claim.as_dict(),
            "coordinate": coordinate.as_list(),
            "required_exits": required,
            "open_sides": open_sides,
            "sealed_sides": sealed,
            "world_rooms": self.store.count(),
        }

    # --- submission ---------------------------------------------------------

    def check(self, claim: Claim, raw: Any) -> tuple[Blueprint | None, list[ValidationError]]:
        """Parse and validate without touching the graph — the dry-run path."""
        blueprint, errors = parse_blueprint(raw)
        if blueprint is None:
            return None, errors
        errors = list(errors) + validate(blueprint, claim.coordinate, self.store)
        return blueprint, errors

    def submit(self, claim: Claim, raw: Any) -> tuple[BakedRoom | None, list[ValidationError]]:
        """Validate and, if clean, bake permanently and retire the agent."""
        self.registry.note_attempt(claim)
        blueprint, errors = self.check(claim, raw)
        if blueprint is None or errors:
            return None, errors

        room = BakedRoom(blueprint=blueprint, agent_id=claim.agent_id, baked_at=time.time())
        try:
            self.store.bake(room)
        except KeyError as exc:
            return None, [ValidationError("already_baked", "$.coordinate", str(exc))]

        self.registry.mark_baked(claim)
        return room, []

    def release(self, claim: Claim) -> None:
        self.registry.release(claim)

    # --- read-only world views ---------------------------------------------

    def room_view(self, coordinate: Coordinate) -> dict[str, Any] | None:
        room = self.store.get(coordinate)
        if room is None:
            return None
        payload = room.as_dict()
        payload["frontier_exits"] = [
            exit_.direction.value
            for exit_ in room.blueprint.exits
            if not self.store.is_baked(coordinate.step(exit_.direction))
        ]
        return payload

    def world_map(self) -> dict[str, Any]:
        return {
            "rooms": [
                {
                    "coordinate": room.coordinate.as_list(),
                    "name": room.blueprint.name,
                    "agent_id": room.agent_id,
                    "exits": [e.direction.value for e in room.blueprint.exits],
                }
                for room in sorted(self.store.rooms(), key=lambda r: r.coordinate)
            ],
            "edges": self.store.edges(),
            "frontier": [coord.as_list() for coord in self.registry.frontier()],
            "stats": self.registry.stats() | {"rooms": self.store.count()},
        }

    # --- prompt -------------------------------------------------------------

    def prompt_template(self) -> str:
        try:
            return PROMPT_PATH.read_text(encoding="utf-8")
        except FileNotFoundError:  # pragma: no cover - packaging safety net
            return ""

    def render_prompt(self, claim: Claim) -> str:
        """Fill the room-architect template with this claim's border context."""
        ctx = self.context(claim)
        if ctx["required_exits"]:
            anchors = "\n".join(
                f"- **{r['direction']}** leads to the existing room {r['neighbour_room_name']!r} "
                f"at {r['neighbour']}. From their side the doorway reads: "
                f"\"{r['their_doorway']}\""
                for r in ctx["required_exits"]
            )
            required = ", ".join(r["direction"] for r in ctx["required_exits"])
        else:
            anchors = "- (none — this sector has no finished neighbours yet)"
            required = "(none)"

        return (
            self.prompt_template()
            .replace("{{coordinate}}", str(claim.coordinate))
            .replace("{{claim_id}}", claim.claim_id)
            .replace("{{required_exits}}", required)
            .replace("{{neighbour_anchors}}", anchors)
            .replace("{{open_sides}}", ", ".join(ctx["open_sides"]) or "(none)")
            .replace("{{sealed_sides}}", ", ".join(ctx["sealed_sides"]) or "(none)")
        )

    def _neighbour_name(self, coordinate: Coordinate, direction: Direction) -> str:
        room = self.store.get(coordinate.step(direction))
        return room.blueprint.name if room else ""
