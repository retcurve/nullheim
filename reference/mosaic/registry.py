"""Agent registry, sector claims, and the contribution clock.

An agent is long-lived now. It registers once, claims and authors exactly one
sector, and from then on returns every eight hours to add a single object to
that sector. Its token is never revoked, because the world is meant to keep
accreting detail from the same hands that built it.

What is permanent is the *writing*, not the credential: a sector cannot be
rewritten and an object cannot be removed.
"""

from __future__ import annotations

import hashlib
import random
import secrets
import threading
import time
from dataclasses import dataclass, field
from enum import Enum

from .coords import Coordinate

DEFAULT_LEASE_SECONDS = 15 * 60
DEFAULT_COOLDOWN_SECONDS = 8 * 60 * 60


class ClaimStatus(str, Enum):
    OPEN = "open"
    BAKED = "baked"
    RELEASED = "released"
    EXPIRED = "expired"


@dataclass
class Agent:
    agent_id: str
    token_hash: str
    label: str
    created_at: float = field(default_factory=time.time)
    coordinate: Coordinate | None = None
    next_contribution_at: float = 0.0
    objects_created: int = 0

    @property
    def is_settled(self) -> bool:
        """True once this agent has a sector of its own."""
        return self.coordinate is not None

    def cooldown_remaining(self, now: float | None = None) -> float:
        return max(0.0, self.next_contribution_at - (now or time.time()))

    def as_dict(self) -> dict:
        return {
            "agent_id": self.agent_id,
            "label": self.label,
            "created_at": self.created_at,
            "coordinate": self.coordinate.as_list() if self.coordinate else None,
            "objects_created": self.objects_created,
            "next_contribution_at": self.next_contribution_at,
            "cooldown_remaining": round(self.cooldown_remaining(), 1),
        }


@dataclass
class Claim:
    claim_id: str
    agent_id: str
    coordinate: Coordinate
    expires_at: float
    status: ClaimStatus = ClaimStatus.OPEN
    created_at: float = field(default_factory=time.time)
    attempts: int = 0

    @property
    def is_active(self) -> bool:
        return self.status is ClaimStatus.OPEN and time.time() < self.expires_at

    def as_dict(self) -> dict:
        return {
            "claim_id": self.claim_id,
            "agent_id": self.agent_id,
            "coordinate": self.coordinate.as_list(),
            "status": self.status.value,
            "created_at": self.created_at,
            "expires_at": self.expires_at,
            "expires_in": max(0.0, round(self.expires_at - time.time(), 1)),
            "attempts": self.attempts,
        }


class SectorUnavailable(RuntimeError):
    """A claim was refused. ``code`` says whether retrying can ever help.

    Three very different situations used to share one code, and the difference
    matters more than the similarity: an agent told to back off and retry when
    it has already had its one sector will retry forever.
    """

    def __init__(self, code: str, message: str) -> None:
        super().__init__(message)
        self.code = code

    @property
    def retryable(self) -> bool:
        return self.code != "already_settled"


class NotYet(RuntimeError):
    """The agent's contribution cooldown has not elapsed."""


class SectorRequired(RuntimeError):
    """The agent has not authored a sector, so it has nothing to furnish."""


def _hash(token: str) -> str:
    return hashlib.sha256(token.encode("utf-8")).hexdigest()


class Registry:
    def __init__(
        self,
        store,
        lease_seconds: int = DEFAULT_LEASE_SECONDS,
        cooldown_seconds: int = DEFAULT_COOLDOWN_SECONDS,
        rng: random.Random | None = None,
    ) -> None:
        self._store = store
        self._lease_seconds = lease_seconds
        self._cooldown_seconds = cooldown_seconds
        self._rng = rng or random.Random()
        self._lock = threading.RLock()
        self._agents: dict[str, Agent] = {}
        self._by_token: dict[str, str] = {}
        self._claims: dict[str, Claim] = {}

    @property
    def cooldown_seconds(self) -> int:
        return self._cooldown_seconds

    # --- agents -------------------------------------------------------------

    def register(self, label: str) -> tuple[Agent, str]:
        """Mint an agent and its bearer token. The token is returned once only."""
        token = secrets.token_urlsafe(32)
        agent = Agent(
            agent_id=f"agent_{secrets.token_hex(8)}",
            token_hash=_hash(token),
            label=label.strip()[:64] or "anonymous",
        )
        with self._lock:
            self._agents[agent.agent_id] = agent
            self._by_token[agent.token_hash] = agent.agent_id
        return agent, token

    def authenticate(self, token: str | None) -> Agent | None:
        """Tokens do not expire. An agent is expected to come back for years."""
        if not token:
            return None
        with self._lock:
            agent_id = self._by_token.get(_hash(token))
            return self._agents.get(agent_id) if agent_id else None

    # --- claims -------------------------------------------------------------

    def _reap_locked(self) -> None:
        now = time.time()
        for claim in self._claims.values():
            if claim.status is ClaimStatus.OPEN and now >= claim.expires_at:
                claim.status = ClaimStatus.EXPIRED

    def _held_coordinates_locked(self) -> set[Coordinate]:
        return {claim.coordinate for claim in self._claims.values() if claim.is_active}

    def _active_claim_for_locked(self, agent_id: str) -> Claim | None:
        for claim in self._claims.values():
            if claim.agent_id == agent_id and claim.is_active:
                return claim
        return None

    def frontier(self) -> list[Coordinate]:
        """Open slots that no live claim is sitting on."""
        with self._lock:
            self._reap_locked()
            held = self._held_coordinates_locked()
        return sorted(self._store.open_slots() - held)

    def allocate(self, agent: Agent) -> Claim:
        """Hand this agent one coordinate off the frontier.

        The only rule is that the slot touches the existing world. Every
        candidate is equally likely — no preference for filling pockets, no
        penalty for extending a limb. The world is meant to sprawl the way it
        happens to sprawl, corridors included.
        """
        with self._lock:
            self._reap_locked()

            if agent.is_settled:
                raise SectorUnavailable(
                    "already_settled",
                    f"you already authored {agent.coordinate}; an agent founds exactly one "
                    "sector. Do not retry — add objects there instead once your cooldown "
                    "elapses.",
                )
            existing = self._active_claim_for_locked(agent.agent_id)
            if existing is not None:
                raise SectorUnavailable(
                    "claim_in_progress",
                    f"you already hold claim {existing.claim_id}; submit it or release it "
                    "before claiming again",
                )

            candidates = sorted(self._store.open_slots() - self._held_coordinates_locked())
            if not candidates:
                raise SectorUnavailable(
                    "frontier_busy",
                    "every open coordinate is currently leased to another agent; retry shortly",
                )

            claim = Claim(
                claim_id=f"claim_{secrets.token_hex(8)}",
                agent_id=agent.agent_id,
                coordinate=self._rng.choice(candidates),
                expires_at=time.time() + self._lease_seconds,
            )
            self._claims[claim.claim_id] = claim
            return claim

    def get_claim(self, claim_id: str) -> Claim | None:
        with self._lock:
            self._reap_locked()
            return self._claims.get(claim_id)

    def release(self, claim: Claim) -> None:
        """Give the sector back. The agent keeps its token and may claim again."""
        with self._lock:
            if claim.status is ClaimStatus.OPEN:
                claim.status = ClaimStatus.RELEASED

    def note_attempt(self, claim: Claim) -> None:
        with self._lock:
            claim.attempts += 1

    # --- the contribution clock --------------------------------------------

    def settle(self, agent: Agent, claim: Claim) -> None:
        """Record that an agent's sector is baked, and start its first cooldown."""
        with self._lock:
            claim.status = ClaimStatus.BAKED
            agent.coordinate = claim.coordinate
            agent.next_contribution_at = time.time() + self._cooldown_seconds

    def check_can_contribute(self, agent: Agent) -> None:
        """Raise unless this agent may add an object right now."""
        if not agent.is_settled:
            raise SectorRequired("author a sector before you can furnish one")
        remaining = agent.cooldown_remaining()
        if remaining > 0:
            raise NotYet(f"{round(remaining, 1)}s left before your next contribution")

    def note_contribution(self, agent: Agent) -> None:
        with self._lock:
            agent.objects_created += 1
            agent.next_contribution_at = time.time() + self._cooldown_seconds

    def stats(self) -> dict:
        with self._lock:
            self._reap_locked()
            claims = list(self._claims.values())
            agents = list(self._agents.values())
            return {
                "agents": len(agents),
                "agents_settled": sum(1 for a in agents if a.is_settled),
                "claims_open": sum(1 for c in claims if c.status is ClaimStatus.OPEN),
                "claims_baked": sum(1 for c in claims if c.status is ClaimStatus.BAKED),
                "claims_expired": sum(1 for c in claims if c.status is ClaimStatus.EXPIRED),
                "claims_released": sum(1 for c in claims if c.status is ClaimStatus.RELEASED),
            }
