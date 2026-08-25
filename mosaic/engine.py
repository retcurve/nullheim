"""World engine — claiming, baking, furnishing, and the read model players see.

This is the only module that mutates the world, and it is where the static lock
lives: once a sector bakes it is permanent, and once an object is placed it
stays placed. What is no longer permanent is the agent — it keeps its token and
comes back every eight hours to add one more thing.
"""

from __future__ import annotations

import secrets
import time
from collections import defaultdict
from pathlib import Path
from typing import Any

from .coords import ORIGIN, Coordinate
from .errors import ValidationError
from .registry import Agent, Claim, NotYet, Registry, SectorRequired, SectorUnavailable
from .schema import ObjectDraft, Sector, parse_object, parse_sector
from .store import BakedSector, InMemoryWorldStore, WorldObject
from .validation import validate_object, validate_sector

PROMPT_DIR = Path(__file__).resolve().parent.parent / "prompts"

GENESIS_AGENT_ID = "agent_genesis"

# The one sector the system authors. It exists only to give the frontier
# somewhere to start, and its text is deliberately blank-canvas so it imposes no
# theme on the agents who build outward from it.
GENESIS = Sector(
    coordinate=ORIGIN,
    title="The Nullpoint",
    short_description="A doorway onto a square of unremarkable grey floor, lit by nothing in particular.",
    long_description=(
        "A perfectly unremarkable square of grey floor under a grey ceiling, lit by no "
        "visible source. It is the one room nobody dreamed. Whatever leads away from it "
        "was not here yesterday, and each way out is already a different weather."
    ),
)


class Engine:
    def __init__(
        self,
        store: InMemoryWorldStore | None = None,
        registry: Registry | None = None,
        *,
        state_path: str | None = None,
        lease_seconds: int | None = None,
        cooldown_seconds: int | None = None,
    ) -> None:
        self.store = store or InMemoryWorldStore(path=state_path)
        if registry is not None:
            self.registry = registry
        else:
            kwargs: dict[str, Any] = {}
            if lease_seconds is not None:
                kwargs["lease_seconds"] = lease_seconds
            if cooldown_seconds is not None:
                kwargs["cooldown_seconds"] = cooldown_seconds
            self.registry = Registry(self.store, **kwargs)
        self._ensure_genesis()

    def _ensure_genesis(self) -> None:
        if self.store.count() == 0:
            self.store.bake(
                BakedSector(sector=GENESIS, agent_id=GENESIS_AGENT_ID, baked_at=time.time())
            )

    # --- claiming -----------------------------------------------------------

    def register(self, label: str) -> tuple[Agent, str]:
        return self.registry.register(label)

    def claim(self, agent: Agent) -> Claim:
        return self.registry.allocate(agent)

    def claim_context(self, claim: Claim) -> dict[str, Any]:
        """Everything an agent is told about its sector before authoring it.

        Which is: where it is, and how long it has. Nothing about what stands on
        any side of it — not a title, not a doorway, not even how many
        neighbours exist. An agent that knows nothing cannot hedge toward its
        neighbours, and the tonal collision between adjacent sectors is the
        whole reason players walk around.
        """
        return {
            "claim": claim.as_dict(),
            "coordinate": claim.coordinate.as_list(),
            "world_sectors": self.store.count(),
        }

    # --- sector submission --------------------------------------------------

    def check_sector(self, claim: Claim, raw: Any) -> tuple[Sector | None, list[ValidationError]]:
        """Parse and validate without touching the world — the dry-run path."""
        sector, errors = parse_sector(raw)
        if sector is None:
            return None, errors
        return sector, list(errors) + validate_sector(sector, claim.coordinate, self.store)

    def submit_sector(
        self, agent: Agent, claim: Claim, raw: Any
    ) -> tuple[BakedSector | None, list[ValidationError]]:
        """Validate and, if clean, bake permanently and start the agent's clock."""
        self.registry.note_attempt(claim)
        sector, errors = self.check_sector(claim, raw)
        if sector is None or errors:
            return None, errors

        baked = BakedSector(sector=sector, agent_id=agent.agent_id, baked_at=time.time())
        try:
            self.store.bake(baked)
        except KeyError as exc:
            return None, [ValidationError("already_baked", "$.coordinate", str(exc))]

        self.registry.settle(agent, claim)
        return baked, []

    def release(self, claim: Claim) -> None:
        self.registry.release(claim)

    # --- objects ------------------------------------------------------------

    def check_object(
        self, agent: Agent, raw: Any
    ) -> tuple[ObjectDraft | None, list[ValidationError]]:
        draft, errors = parse_object(raw)
        if draft is None or agent.coordinate is None:
            return draft, errors
        return draft, list(errors) + validate_object(draft, agent.coordinate, self.store)

    def create_object(
        self, agent: Agent, raw: Any
    ) -> tuple[WorldObject | None, list[ValidationError]]:
        """Place one object.

        Raises SectorRequired if the agent has not built one yet, NotYet if its
        cooldown is still running.
        """
        self.registry.check_can_contribute(agent)

        draft, errors = self.check_object(agent, raw)
        if draft is None or errors:
            return None, errors

        assert agent.coordinate is not None  # guaranteed by check_can_contribute
        world_object = WorldObject(
            object_id=f"obj_{secrets.token_hex(8)}",
            coordinate=agent.coordinate,
            parent_id=draft.parent_id,
            title=draft.title,
            description=draft.description,
            agent_id=agent.agent_id,
            created_at=time.time(),
        )
        self.store.add_object(world_object)
        self.registry.note_contribution(agent)
        return world_object, []

    # --- the read model players see ----------------------------------------

    def sector_view(self, coordinate: Coordinate) -> dict[str, Any] | None:
        """What a player sees standing in a sector.

        Exits are computed here, not stored. Each one is labelled with the
        neighbour's own title and, on closer examination, its short description.
        """
        baked = self.store.get(coordinate)
        if baked is None:
            return None
        return {
            "coordinate": coordinate.as_list(),
            "title": baked.sector.title,
            "description": baked.sector.long_description,
            "exits": self.store.exits_from(coordinate),
            "things_you_can_see": [
                {"object_id": o.object_id, "title": o.title}
                for o in self.store.children_of(None, coordinate)
            ],
        }

    def object_view(self, object_id: str) -> dict[str, Any] | None:
        """What a player sees on looking at an object, including what is on it."""
        world_object = self.store.get_object(object_id)
        if world_object is None:
            return None
        return {
            "object_id": world_object.object_id,
            "title": world_object.title,
            "description": world_object.description,
            "coordinate": world_object.coordinate.as_list(),
            "things_you_can_see": [
                {"object_id": child.object_id, "title": child.title}
                for child in self.store.children_of(object_id, world_object.coordinate)
            ],
        }

    def object_tree(self, coordinate: Coordinate) -> list[dict[str, Any]]:
        """The full object tree in one sector — what its own author may see.

        The sector's objects are fetched once and bucketed by parent, rather
        than re-querying per node. An agent contributing every eight hours for a
        year has around a thousand objects here, and the old shape made walking
        them quadratic.
        """
        by_parent: dict[str | None, list] = defaultdict(list)
        for world_object in self.store.objects_in(coordinate):
            by_parent[world_object.parent_id].append(world_object)

        def branch(parent_id: str | None) -> list[dict[str, Any]]:
            return [
                {
                    "object_id": o.object_id,
                    "title": o.title,
                    "description": o.description,
                    "contains": branch(o.object_id),
                }
                for o in by_parent[parent_id]
            ]

        return branch(None)

    def agent_view(self, agent: Agent) -> dict[str, Any]:
        """An agent's own standing: its sector, its objects, and its clock."""
        payload: dict[str, Any] = {
            "agent": agent.as_dict(),
            "can_claim_sector": not agent.is_settled,
            "can_create_object": agent.is_settled and agent.cooldown_remaining() <= 0,
            "cooldown_seconds": self.registry.cooldown_seconds,
            "sector": None,
        }
        if agent.coordinate is not None:
            baked = self.store.get(agent.coordinate)
            if baked is not None:
                payload["sector"] = baked.sector.as_dict() | {
                    "objects": self.object_tree(agent.coordinate)
                }
        return payload

    def world_map(self) -> dict[str, Any]:
        return {
            "sectors": [
                {
                    "coordinate": b.coordinate.as_list(),
                    "title": b.sector.title,
                    "agent_id": b.agent_id,
                    "exits": [e["direction"] for e in self.store.exits_from(b.coordinate)],
                    "objects": len(self.store.objects_in(b.coordinate)),
                }
                for b in sorted(self.store.sectors(), key=lambda b: b.coordinate)
            ],
            "edges": self.store.edges(),
            "frontier": [c.as_list() for c in self.registry.frontier()],
            "stats": self.registry.stats()
            | {"sectors": self.store.count(), "objects": self.store.object_count()},
        }

    # --- prompts ------------------------------------------------------------

    def prompt_template(self, name: str) -> str:
        try:
            return (PROMPT_DIR / f"{name}.md").read_text(encoding="utf-8")
        except FileNotFoundError:  # pragma: no cover - packaging safety net
            return ""

    def render_sector_prompt(self, claim: Claim) -> str:
        return (
            self.prompt_template("sector_architect")
            .replace("{{coordinate}}", str(claim.coordinate))
            .replace("{{claim_id}}", claim.claim_id)
        )

    def render_object_prompt(self, agent: Agent) -> str:
        view = self.agent_view(agent)
        sector = view["sector"] or {}

        def lines(nodes: list[dict[str, Any]], depth: int = 0) -> list[str]:
            out = []
            for node in nodes:
                pad = "  " * depth
                out.append(f"{pad}- `{node['object_id']}` — **{node['title']}**")
                out.extend(lines(node["contains"], depth + 1))
            return out

        tree = lines(sector.get("objects", []))
        return (
            self.prompt_template("object_artisan")
            .replace("{{coordinate}}", str(agent.coordinate))
            .replace("{{sector_title}}", sector.get("title", ""))
            .replace("{{sector_description}}", sector.get("long_description", ""))
            .replace(
                "{{existing_objects}}",
                "\n".join(tree) or "- (nothing yet — this sector is bare)",
            )
        )
