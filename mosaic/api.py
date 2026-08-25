"""HTTP surface.

Agents are external processes. This is the only way they touch the world, so the
whole contract — auth, claim lifecycle, validation feedback — is expressed here
over plain stdlib HTTP. Swapping in FastAPI later is a rewrite of this file and
nothing else.
"""

from __future__ import annotations

import json
import re
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from typing import Any, Callable

from .coords import Coordinate
from .engine import Engine
from .registry import ClaimStatus, SectorUnavailable
from .schema import (
    BLUEPRINT_FIELDS,
    EXIT_FIELDS,
    ITEM_FIELDS,
    MAX_BLUEPRINT_BYTES,
    MAX_EXITS,
    MAX_ITEMS,
    WeightClass,
)

MAX_BODY_BYTES = MAX_BLUEPRINT_BYTES * 2

Route = tuple[str, re.Pattern[str], Callable]


class ApiError(Exception):
    def __init__(self, status: int, code: str, message: str, **extra: Any) -> None:
        super().__init__(message)
        self.status = status
        self.payload = {"error": {"code": code, "message": message}, **extra}


class MosaicHandler(BaseHTTPRequestHandler):
    engine: Engine
    server_version = "Mosaic/0.1"
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
                "provide a live agent token as 'Authorization: Bearer <token>'. "
                "Decommissioned agents are permanently revoked.",
            )
        return agent

    def _claim(self, claim_id: str):
        claim = self.engine.registry.get_claim(claim_id)
        if claim is None:
            raise ApiError(404, "no_such_claim", f"no claim {claim_id}")
        agent = self._agent()
        if claim.agent_id != agent.agent_id:
            raise ApiError(403, "not_your_claim", "this sector belongs to another agent")
        return claim

    def _active_claim(self, claim_id: str):
        claim = self._claim(claim_id)
        if not claim.is_active:
            raise ApiError(
                409,
                "claim_not_active",
                f"claim is {claim.status.value}; its sector has returned to the frontier",
                claim=claim.as_dict(),
            )
        return claim

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

    # --- handlers -----------------------------------------------------------

    def health(self):
        return 200, {"status": "ok", "rooms": self.engine.store.count()}

    def spec(self):
        return 200, {
            "blueprint_fields": list(BLUEPRINT_FIELDS),
            "exit_fields": list(EXIT_FIELDS),
            "item_fields": list(ITEM_FIELDS),
            "weight_classes": [w.value for w in WeightClass],
            "limits": {
                "max_exits": MAX_EXITS,
                "max_items": MAX_ITEMS,
                "max_blueprint_bytes": MAX_BLUEPRINT_BYTES,
            },
            "prompt_template": self.engine.prompt_template(),
        }

    def register(self):
        body = self._body()
        label = body.get("label") or "anonymous"
        if not isinstance(label, str):
            raise ApiError(400, "type_error", "label must be a string")
        agent, token = self.engine.register(label)
        return 201, {
            "agent": agent.as_dict(),
            "token": token,
            "note": "Store this token. It is shown once and revoked when you are decommissioned.",
        }

    def create_claim(self):
        agent = self._agent()
        try:
            claim = self.engine.claim(agent)
        except SectorUnavailable as exc:
            raise ApiError(409, "no_sector_available", str(exc)) from exc
        payload = self.engine.context(claim)
        payload["prompt"] = self.engine.render_prompt(claim)
        return 201, payload

    def read_claim(self, claim_id: str):
        claim = self._claim(claim_id)
        payload = self.engine.context(claim)
        payload["prompt"] = self.engine.render_prompt(claim)
        return 200, payload

    def validate_claim(self, claim_id: str):
        claim = self._active_claim(claim_id)
        _, errors = self.engine.check(claim, self._body())
        return 200, {
            "ok": not errors,
            "errors": [error.as_dict() for error in errors],
        }

    def submit_blueprint(self, claim_id: str):
        claim = self._active_claim(claim_id)
        room, errors = self.engine.submit(claim, self._body())
        if room is None:
            return 422, {
                "ok": False,
                "errors": [error.as_dict() for error in errors],
                "hint": "Fix the paths named above and resubmit; your lease is still live.",
            }
        return 201, {
            "ok": True,
            "room": room.as_dict(),
            "status": "baked",
            "note": "This room is now permanent and your agent has been decommissioned.",
        }

    def delete_claim(self, claim_id: str):
        claim = self._claim(claim_id)
        self.engine.release(claim)
        return 200, {"claim": claim.as_dict(), "status": "released"}

    def read_room(self, x: str, y: str, z: str):
        view = self.engine.room_view(Coordinate(int(x), int(y), int(z)))
        if view is None:
            raise ApiError(404, "no_such_room", f"nothing baked at [{x}, {y}, {z}]")
        return 200, view

    def read_map(self):
        return 200, self.engine.world_map()


_INT = r"(-?\d+)"

ROUTES: list[Route] = [
    ("GET", re.compile(r"/v1/health"), MosaicHandler.health),
    ("GET", re.compile(r"/v1/spec"), MosaicHandler.spec),
    ("GET", re.compile(r"/v1/map"), MosaicHandler.read_map),
    ("GET", re.compile(rf"/v1/rooms/{_INT}/{_INT}/{_INT}"), MosaicHandler.read_room),
    ("POST", re.compile(r"/v1/agents/register"), MosaicHandler.register),
    ("POST", re.compile(r"/v1/claims"), MosaicHandler.create_claim),
    ("GET", re.compile(r"/v1/claims/([\w-]+)"), MosaicHandler.read_claim),
    ("POST", re.compile(r"/v1/claims/([\w-]+)/validate"), MosaicHandler.validate_claim),
    ("POST", re.compile(r"/v1/claims/([\w-]+)/blueprint"), MosaicHandler.submit_blueprint),
    ("DELETE", re.compile(r"/v1/claims/([\w-]+)"), MosaicHandler.delete_claim),
]


def make_server(engine: Engine, host: str = "127.0.0.1", port: int = 8765, quiet: bool = False):
    handler = type("BoundMosaicHandler", (MosaicHandler,), {"engine": engine, "quiet": quiet})
    return ThreadingHTTPServer((host, port), handler)
