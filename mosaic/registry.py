"""Agent registry, sector claims, and frontier allocation.

An agent's whole life is: register, claim one sector, read its borders, submit
one blueprint, get decommissioned. The registry owns that lifecycle and the
leases that stop a dead agent from punching a permanent hole in the world.
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


class AgentStatus(str, Enum):
    REGISTERED = "registered"
    CLAIMED = "claimed"
    DECOMMISSIONED = "decommissioned"


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
    status: AgentStatus = AgentStatus.REGISTERED
    created_at: float = field(default_factory=time.time)

    def as_dict(self) -> dict:
        return {
            "agent_id": self.agent_id,
            "label": self.label,
            "status": self.status.value,
            "created_at": self.created_at,
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
    """No frontier coordinate is free right now."""


def _hash(token: str) -> str:
    return hashlib.sha256(token.encode("utf-8")).hexdigest()


class Registry:
    def __init__(
        self,
        store,
        lease_seconds: int = DEFAULT_LEASE_SECONDS,
        rng: random.Random | None = None,
    ) -> None:
        self._store = store
        self._lease_seconds = lease_seconds
        self._rng = rng or random.Random()
        self._lock = threading.RLock()
        self._agents: dict[str, Agent] = {}
        self._by_token: dict[str, str] = {}
        self._claims: dict[str, Claim] = {}

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
        if not token:
            return None
        with self._lock:
            agent_id = self._by_token.get(_hash(token))
            if agent_id is None:
                return None
            agent = self._agents[agent_id]
            return None if agent.status is AgentStatus.DECOMMISSIONED else agent

    def decommission(self, agent_id: str) -> None:
        """Retire an agent and revoke its token. Its room is now permanent."""
        with self._lock:
            agent = self._agents.get(agent_id)
            if agent is None:
                return
            agent.status = AgentStatus.DECOMMISSIONED
            self._by_token.pop(agent.token_hash, None)

    # --- claims -------------------------------------------------------------

    def _reap_locked(self) -> None:
        now = time.time()
        for claim in self._claims.values():
            if claim.status is ClaimStatus.OPEN and now >= claim.expires_at:
                claim.status = ClaimStatus.EXPIRED

    def _held_coordinates_locked(self) -> set[Coordinate]:
        return {claim.coordinate for claim in self._claims.values() if claim.is_active}

    def frontier(self) -> list[Coordinate]:
        """Open slots that no live claim is sitting on."""
        with self._lock:
            self._reap_locked()
            held = self._held_coordinates_locked()
        return sorted(self._store.open_slots() - held)

    def allocate(self, agent: Agent) -> Claim:
        """Hand this agent one coordinate off the frontier.

        Slots with more baked neighbours win. Filling pockets before pushing
        outward is what keeps the map from growing into a long corridor — the
        world thickens as it spreads.
        """
        with self._lock:
            self._reap_locked()
            if agent.status is not AgentStatus.REGISTERED:
                raise SectorUnavailable(
                    f"agent {agent.agent_id} has already been through the claim cycle"
                )

            candidates = sorted(self._store.open_slots() - self._held_coordinates_locked())
            if not candidates:
                raise SectorUnavailable("no open sector on the frontier right now")

            def rank(coord: Coordinate) -> tuple[int, int]:
                baked_neighbours = sum(
                    1 for _, n in coord.neighbours() if self._store.is_baked(n)
                )
                return (-baked_neighbours, abs(coord.x) + abs(coord.y) + abs(coord.z))

            best = rank(min(candidates, key=rank))
            tied = [coord for coord in candidates if rank(coord) == best]
            coordinate = self._rng.choice(tied)

            claim = Claim(
                claim_id=f"claim_{secrets.token_hex(8)}",
                agent_id=agent.agent_id,
                coordinate=coordinate,
                expires_at=time.time() + self._lease_seconds,
            )
            self._claims[claim.claim_id] = claim
            agent.status = AgentStatus.CLAIMED
            return claim

    def get_claim(self, claim_id: str) -> Claim | None:
        with self._lock:
            self._reap_locked()
            return self._claims.get(claim_id)

    def release(self, claim: Claim) -> None:
        """Give the sector back. The agent is spent either way."""
        with self._lock:
            if claim.status is ClaimStatus.OPEN:
                claim.status = ClaimStatus.RELEASED
        self.decommission(claim.agent_id)

    def mark_baked(self, claim: Claim) -> None:
        with self._lock:
            claim.status = ClaimStatus.BAKED
        self.decommission(claim.agent_id)

    def note_attempt(self, claim: Claim) -> None:
        with self._lock:
            claim.attempts += 1

    def stats(self) -> dict:
        with self._lock:
            self._reap_locked()
            claims = list(self._claims.values())
            return {
                "agents": len(self._agents),
                "claims_open": sum(1 for c in claims if c.status is ClaimStatus.OPEN),
                "claims_baked": sum(1 for c in claims if c.status is ClaimStatus.BAKED),
                "claims_expired": sum(1 for c in claims if c.status is ClaimStatus.EXPIRED),
                "claims_released": sum(1 for c in claims if c.status is ClaimStatus.RELEASED),
            }
