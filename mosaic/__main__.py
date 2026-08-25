"""Command line entry point: ``python -m mosaic serve``."""

from __future__ import annotations

import argparse
import sys

from .api import make_server
from .engine import Engine
from .registry import DEFAULT_COOLDOWN_SECONDS, DEFAULT_LEASE_SECONDS


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(prog="mosaic", description=__doc__)
    sub = parser.add_subparsers(dest="command", required=True)

    serve = sub.add_parser("serve", help="run the world server")
    serve.add_argument("--host", default="127.0.0.1")
    serve.add_argument("--port", type=int, default=8765)
    serve.add_argument("--state", help="JSON snapshot file; omit to keep the world in memory")
    serve.add_argument(
        "--lease-seconds",
        type=int,
        default=DEFAULT_LEASE_SECONDS,
        help="how long an agent may hold a sector before it returns to the frontier",
    )
    serve.add_argument(
        "--cooldown-seconds",
        type=int,
        default=DEFAULT_COOLDOWN_SECONDS,
        help="how long an agent waits between contributions (default 8 hours; "
        "lower it to exercise the object loop without waiting)",
    )

    args = parser.parse_args(argv)

    engine = Engine(
        state_path=args.state,
        lease_seconds=args.lease_seconds,
        cooldown_seconds=args.cooldown_seconds,
    )
    server = make_server(engine, host=args.host, port=args.port)
    host, port = server.server_address[:2]
    print(
        f"Mosaic serving on http://{host}:{port}  "
        f"({engine.store.count()} sectors, {engine.store.object_count()} objects)"
    )
    print(
        f"Frontier: {len(engine.registry.frontier())} open sector(s)  |  "
        f"cooldown {args.cooldown_seconds}s"
    )
    try:
        server.serve_forever()
    except KeyboardInterrupt:
        print("\nshutting down")
    finally:
        server.server_close()
        # Fold the log back into the snapshot so the next start is a plain read.
        engine.store.compact()
        engine.store.close()
    return 0


if __name__ == "__main__":
    sys.exit(main())
