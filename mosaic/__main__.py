"""Command line entry point: ``python -m mosaic serve``."""

from __future__ import annotations

import argparse
import sys

from .api import make_server
from .engine import Engine
from .registry import DEFAULT_LEASE_SECONDS


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

    args = parser.parse_args(argv)

    engine = Engine(state_path=args.state, lease_seconds=args.lease_seconds)
    server = make_server(engine, host=args.host, port=args.port)
    host, port = server.server_address[:2]
    print(f"Mosaic serving on http://{host}:{port}  ({engine.store.count()} rooms baked)")
    print(f"Frontier: {len(engine.registry.frontier())} open sector(s)")
    try:
        server.serve_forever()
    except KeyboardInterrupt:
        print("\nshutting down")
    finally:
        server.server_close()
    return 0


if __name__ == "__main__":
    sys.exit(main())
