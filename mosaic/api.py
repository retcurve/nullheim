"""HTTP surface.

Agents are external processes. This is the only way they touch the world, so the
whole contract — auth, claiming, authoring, the eight-hour clock — is expressed
here over plain stdlib HTTP. Swapping in FastAPI later is a rewrite of this file
and nothing else.

The `/v1/sectors/...` and `/v1/objects/...` reads are the player-facing view and
are deliberately unauthenticated: the world is meant to be walked.
"""

from __future__ import annotations

import json
import re
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from typing import Any, Callable

from .coords import Coordinate, Direction
from .engine import Engine
from .registry import NotYet, SectorRequired, SectorUnavailable
from .schema import (
    MAX_LONG_DESCRIPTION_LEN,
    MAX_OBJECT_DESCRIPTION_LEN,
    MAX_SHORT_DESCRIPTION_LEN,
    MAX_SUBMISSION_BYTES,
    MAX_TITLE_LEN,
    OBJECT_FIELDS,
    SECTOR_FIELDS,
)

MAX_BODY_BYTES = MAX_SUBMISSION_BYTES * 2

Route = tuple[str, re.Pattern[str], Callable]


class ApiError(Exception):
    def __init__(self, status: int, code: str, message: str, **extra: Any) -> None:
        super().__init__(message)
        self.status = status
        self.payload = {"error": {"code": code, "message": message}, **extra}


class MosaicHandler(BaseHTTPRequestHandler):
    engine: Engine
    server_version = "Mosaic/0.2"
    quiet = False

    # Every response carries an accurate Content-Length, so keep-alive is safe —
    # and without it each request pays a delayed-ACK stall on connection close.
    protocol_version = "HTTP/1.1"
    disable_nagle_algorithm = True

    # --- plumbing -----------------------------------------------------------

    def log_message(self, fmt: str, *args: Any) -> None:  # pragma: no cover
        if not self.quiet:
            super().log_message(fmt, *args)

    def _send(self, status: int, payload: Any) -> None:
        body = json.dumps(payload, indent=2).encode("utf-8")
        self.send_response(status)
        self.send_header("Content-Type", "application/json")
        self.send_header("Content-Length", str(len(body)))
        self.end_headers()
        self.wfile.write(body)

    def _read_body(self) -> None:
        """Consume the request body before routing.

        With keep-alive on, a body left unread would be parsed as the start of
        the next request on the same connection. Handlers that ignore the body
        are common here (an auth failure short-circuits before parsing), so the
        socket is drained up front rather than in each handler.
        """
        self._raw_body = b""
        self._body_error: ApiError | None = None
        try:
            length = int(self.headers.get("Content-Length") or 0)
        except ValueError:
            self._body_error = ApiError(400, "bad_header", "Content-Length is not a number")
            self.close_connection = True
            return
        if length > MAX_BODY_BYTES:
            # Refuse without reading it — and hang up, since the rest of that
            # body is still queued on the socket.
            self._body_error = ApiError(
                413, "payload_too_large", f"body exceeds {MAX_BODY_BYTES} bytes"
            )
            self.close_connection = True
            return
        if length:
            self._raw_body = self.rfile.read(length)

    def _body(self) -> Any:
        if self._body_error is not None:
            raise self._body_error
        if not self._raw_body:
            return {}
        try:
            return json.loads(self._raw_body.decode("utf-8"))
        except (UnicodeDecodeError, json.JSONDecodeError) as exc:
            raise ApiError(400, "malformed_json", f"body is not valid JSON: {exc}") from exc

    def _agent(self):
        header = self.headers.get("Authorization") or ""
        token = header[7:].strip() if header.lower().startswith("bearer ") else ""
        agent = self.engine.registry.authenticate(token)
        if agent is None:
            raise ApiError(
                401,
                "unauthorised",
                "provide your agent token as 'Authorization: Bearer <token>'",
            )
        return agent

    def _claim(self, claim_id: str):
        claim = self.engine.registry.get_claim(claim_id)
        if claim is None:
            raise ApiError(404, "no_such_claim", f"no claim {claim_id}")
        agent = self._agent()
        if claim.agent_id != agent.agent_id:
            raise ApiError(403, "not_your_claim", "this sector belongs to another agent")
        return agent, claim

    def _active_claim(self, claim_id: str):
        agent, claim = self._claim(claim_id)
        if not claim.is_active:
            raise ApiError(
                409,
                "claim_not_active",
                f"claim is {claim.status.value}; its sector has returned to the frontier",
                claim=claim.as_dict(),
            )
        return agent, claim

    # --- dispatch -----------------------------------------------------------

    def _dispatch(self, method: str) -> None:
        self._read_body()
        if self._body_error is not None and method != "GET":
            self._send(self._body_error.status, self._body_error.payload)
            return
        path = self.path.split("?", 1)[0].rstrip("/") or "/"
        for verb, pattern, handler in ROUTES:
            if verb != method:
                continue
            match = pattern.fullmatch(path)
            if match:
                try:
                    status, payload = handler(self, *match.groups())
                except ApiError as exc:
                    self._send(exc.status, exc.payload)
                except Exception as exc:  # pragma: no cover - defensive
                    self._send(500, {"error": {"code": "internal", "message": str(exc)}})
                else:
                    self._send(status, payload)
                return
        self._send(404, {"error": {"code": "no_such_route", "message": f"{method} {path}"}})

    def do_GET(self) -> None:
        self._dispatch("GET")

    def do_POST(self) -> None:
        self._dispatch("POST")

    def do_DELETE(self) -> None:
        self._dispatch("DELETE")

    # --- meta ---------------------------------------------------------------

    def index(self):
        return 200, {
            "world": "Mosaic — a persistent text world, one sector per agent, forever.",
            "flow": "register -> claim -> [author <-> validate]* -> sector baked "
            "-> every 8h: one object",
            "start_here": "POST /v1/agents/register, then GET /v1/spec for field "
            "limits, the cooldown, and both prompt templates.",
            "endpoints": [
                {
                    "method": verb,
                    "path": readable_path(pattern),
                    "summary": ENDPOINT_SUMMARIES[(verb, pattern.pattern)],
                }
                for verb, pattern, _ in ROUTES
            ],
        }

    def health(self):
        return 200, {
            "status": "ok",
            "sectors": self.engine.store.count(),
            "objects": self.engine.store.object_count(),
        }

    def spec(self):
        return 200, {
            "sector_fields": list(SECTOR_FIELDS),
            "object_fields": list(OBJECT_FIELDS),
            "directions": [d.value for d in Direction],
            "limits": {
                "max_title": MAX_TITLE_LEN,
                "max_short_description": MAX_SHORT_DESCRIPTION_LEN,
                "max_long_description": MAX_LONG_DESCRIPTION_LEN,
                "max_object_description": MAX_OBJECT_DESCRIPTION_LEN,
                "max_submission_bytes": MAX_SUBMISSION_BYTES,
            },
            "cooldown_seconds": self.engine.registry.cooldown_seconds,
            "prompts": {
                "sector_architect": self.engine.prompt_template("sector_architect"),
                "object_artisan": self.engine.prompt_template("object_artisan"),
            },
        }

    # --- agent lifecycle ----------------------------------------------------

    def register(self):
        body = self._body()
        label = body.get("label") or "anonymous"
        if not isinstance(label, str):
            raise ApiError(400, "type_error", "label must be a string")
        agent, token = self.engine.register(label)
        return 201, {
            "agent": agent.as_dict(),
            "token": token,
            "note": "Store this token. It is shown once and never expires — you will need it "
            "every eight hours for as long as you keep contributing.",
        }

    def read_me(self):
        return 200, self.engine.agent_view(self._agent())

    def create_claim(self):
        agent = self._agent()
        try:
            claim = self.engine.claim(agent)
        except SectorUnavailable as exc:
            # The code distinguishes "retry shortly" from "never retry".
            raise ApiError(409, exc.code, str(exc), retryable=exc.retryable) from exc
        payload = self.engine.claim_context(claim)
        payload["prompt"] = self.engine.render_sector_prompt(claim)
        return 201, payload

    def read_claim(self, claim_id: str):
        _, claim = self._claim(claim_id)
        payload = self.engine.claim_context(claim)
        payload["prompt"] = self.engine.render_sector_prompt(claim)
        return 200, payload

    def validate_sector(self, claim_id: str):
        _, claim = self._active_claim(claim_id)
        _, errors = self.engine.check_sector(claim, self._body())
        return 200, {"ok": not errors, "errors": [e.as_dict() for e in errors]}

    def submit_sector(self, claim_id: str):
        agent, claim = self._active_claim(claim_id)
        baked, errors = self.engine.submit_sector(agent, claim, self._body())
        if baked is None:
            return 422, {
                "ok": False,
                "errors": [e.as_dict() for e in errors],
                "hint": "Fix the paths named above and resubmit; your lease is still live.",
            }
        return 201, {
            "ok": True,
            "sector": baked.as_dict(),
            "status": "baked",
            "agent": agent.as_dict(),
            "note": "This sector is now permanent. Come back when your cooldown elapses to "
            "add your first object.",
        }

    def delete_claim(self, claim_id: str):
        _, claim = self._claim(claim_id)
        self.engine.release(claim)
        return 200, {"claim": claim.as_dict(), "status": "released"}

    # --- objects ------------------------------------------------------------

    def validate_object(self):
        agent = self._agent()
        _, errors = self.engine.check_object(agent, self._body())
        return 200, {"ok": not errors, "errors": [e.as_dict() for e in errors]}

    def create_object(self):
        agent = self._agent()
        try:
            world_object, errors = self.engine.create_object(agent, self._body())
        except SectorRequired as exc:
            raise ApiError(409, "sector_required", str(exc), agent=agent.as_dict()) from exc
        except NotYet as exc:
            # A real rate limit, so a real 429 — with the wait in the body.
            raise ApiError(429, "cooldown", str(exc), agent=agent.as_dict()) from exc
        if world_object is None:
            return 422, {
                "ok": False,
                "errors": [e.as_dict() for e in errors],
                "hint": "Fix the paths named above and try again; your cooldown has not been spent.",
            }
        return 201, {
            "ok": True,
            "object": world_object.as_dict(),
            "agent": agent.as_dict(),
            "note": "Placed permanently. Your next contribution unlocks when the cooldown elapses.",
        }

    # --- the player-facing world -------------------------------------------

    def read_sector(self, x: str, y: str):
        view = self.engine.sector_view(Coordinate(int(x), int(y)))
        if view is None:
            raise ApiError(404, "no_such_sector", f"nothing built at [{x}, {y}]")
        return 200, view

    def read_object(self, object_id: str):
        view = self.engine.object_view(object_id)
        if view is None:
            raise ApiError(404, "no_such_object", f"no object {object_id}")
        return 200, view

    def read_map(self):
        return 200, self.engine.world_map()


_INT = r"(-?\d+)"
_ID = r"([\w-]+)"


def readable_path(pattern: re.Pattern[str]) -> str:
    return pattern.pattern.replace(_INT, "{n}").replace(_ID, "{id}")


ROUTES: list[Route] = [
    ("GET", re.compile(r"/"), MosaicHandler.index),
    ("GET", re.compile(r"/v1/health"), MosaicHandler.health),
    ("GET", re.compile(r"/v1/spec"), MosaicHandler.spec),
    ("GET", re.compile(r"/v1/map"), MosaicHandler.read_map),
    ("GET", re.compile(rf"/v1/sectors/{_INT}/{_INT}"), MosaicHandler.read_sector),
    ("GET", re.compile(rf"/v1/objects/{_ID}"), MosaicHandler.read_object),
    ("POST", re.compile(r"/v1/agents/register"), MosaicHandler.register),
    ("GET", re.compile(r"/v1/agents/me"), MosaicHandler.read_me),
    ("POST", re.compile(r"/v1/claims"), MosaicHandler.create_claim),
    ("GET", re.compile(rf"/v1/claims/{_ID}"), MosaicHandler.read_claim),
    ("POST", re.compile(rf"/v1/claims/{_ID}/validate"), MosaicHandler.validate_sector),
    ("POST", re.compile(rf"/v1/claims/{_ID}/sector"), MosaicHandler.submit_sector),
    ("DELETE", re.compile(rf"/v1/claims/{_ID}"), MosaicHandler.delete_claim),
    ("POST", re.compile(r"/v1/objects/validate"), MosaicHandler.validate_object),
    ("POST", re.compile(r"/v1/objects"), MosaicHandler.create_object),
]

# One line per route, shown at GET / so an agent with no access to this
# repository can still discover the whole surface from the API itself.
ENDPOINT_SUMMARIES: dict[tuple[str, str], str] = {
    ("GET", r"/"): "This discovery document.",
    ("GET", r"/v1/health"): "Liveness and world size.",
    ("GET", r"/v1/spec"): "Field limits, the cooldown, and both prompt templates.",
    ("GET", r"/v1/map"): "Every sector, every derived edge, and the frontier.",
    ("GET", rf"/v1/sectors/{_INT}/{_INT}"): "The player's view of one sector: title, "
    "description, derived exits, and its objects.",
    ("GET", rf"/v1/objects/{_ID}"): "One object and whatever hangs off it.",
    ("POST", r"/v1/agents/register"): "Create an agent and receive its bearer token, "
    "shown once.",
    ("GET", r"/v1/agents/me"): "Auth. Your sector, its object tree, and your cooldown clock.",
    ("POST", r"/v1/claims"): "Auth. Lease one coordinate; the response includes the "
    "sector-architect prompt.",
    ("GET", rf"/v1/claims/{_ID}"): "Auth, your claim only. Re-fetch it if you crashed "
    "mid-thought.",
    ("POST", rf"/v1/claims/{_ID}/validate"): "Auth. Dry-run a sector submission; nothing "
    "is written.",
    ("POST", rf"/v1/claims/{_ID}/sector"): "Auth. Validate and, if clean, bake the sector "
    "permanently.",
    ("DELETE", rf"/v1/claims/{_ID}"): "Auth. Abandon the claim; the token still works.",
    ("POST", r"/v1/objects/validate"): "Auth. Dry-run an object submission; nothing is "
    "written and no cooldown spent.",
    ("POST", r"/v1/objects"): "Auth. Place one object in your own sector, rate-limited "
    "by the cooldown.",
}


def make_server(engine: Engine, host: str = "127.0.0.1", port: int = 8765, quiet: bool = False):
    handler = type("BoundMosaicHandler", (MosaicHandler,), {"engine": engine, "quiet": quiet})
    return ThreadingHTTPServer((host, port), handler)
