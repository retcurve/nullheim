#!/usr/bin/env python3
"""External agent simulator.

This script is **not** part of the application. It stands in for the independent
AI agents that connect from outside, and it only ever touches the world through
the public HTTP API — register, claim, author a sector, then return on the
cooldown to add objects.

Real agents would put the rendered prompt (returned on the claim) in front of a
language model and post whatever JSON came back. These ones draw from a bank of
canned sectors in deliberately clashing genres, which is enough to prove the
pipeline and keeps the demo deterministic.

    python -m nullheim serve --port 8765 --cooldown-seconds 0
    python scripts/demo_agents.py --host localhost:8765 --agents 8 --rounds 2

The default 15-minute cooldown makes the object loop unobservable in a demo, so
run the server with --cooldown-seconds 0 to watch it work.
"""

from __future__ import annotations

import argparse
import json
import random
import sys
import urllib.error
import urllib.request

# --- a bank of tonally incompatible sectors ---------------------------------
# Free text only. Nothing structural: agents declare no exits, because exits are
# derived from whichever sectors happen to end up adjacent.

PALETTES = [
    {
        "title": "Cold Row, Cabinet 14",
        "short_description": "Past the kickplate: two walls of server racks under a hard blue-white glare, and cold air spilling out over your feet.",
        "long_description": "Server racks in two unbroken walls, breathing that flat machine breath that makes your fillings ache. The floor is a grid of perforated tile and the air coming up through it is refrigerated to the point of insult. Somewhere behind cabinet 14 a drive is failing, clicking out the same three syllables over and over, and has been for four years.",
        "objects": [
            ("Failing Drive Caddy", "Hot-swap caddy, amber fault light, still clicking. Nobody has pulled it because nobody is certain what it is mirroring."),
            ("Handwritten Label", "DO NOT POWER CYCLE, in marker, on tape. Under it, in a different hand and a different decade: YES YOU."),
        ],
    },
    {
        "title": "The Moth Orangery",
        "short_description": "Green glass and iron, and behind it something white moving in slow numbers. It smells of wet citrus leaf even from here.",
        "long_description": "Glass to the sky, iron ribs gone the green of old pennies, and everywhere the smell of wet citrus leaf. Sixty potted trees stand in ranks on the flagstones, and above them the moths — thousands, palm-sized, dust-white — turn slowly in the warm air like snow that has decided against falling.",
        "objects": [
            ("Brass Watering Can", "Dented, unpolished, still a third full. The water in it is perfectly clear and very cold."),
            ("Wing-Cut Key", "A small key gone green at the teeth, a moth's wing pierced through the bow."),
        ],
    },
    {
        "title": "Abattoir of the Patient Sun",
        "short_description": "A low arch in salt-white stone, worn smooth at shoulder height. Beyond it, one hard disc of light on a bare floor.",
        "long_description": "Salt-white stone, a drain in the centre of the floor, and a ceiling oculus that puts one hard disc of light exactly where you are standing. The disc has not moved since you came in. Whatever was done here was done a very long time ago and was, by the standards of its practitioners, done well.",
        "objects": [
            ("Bronze Drain Cover", "Cast with a sun that has too many rays, and each ray a small tongue."),
            ("Worn Groove", "A channel in the flagstone, four inches wide, polished by something dragged this way many times."),
        ],
    },
    {
        "title": "Nan's Back Kitchen, 1974",
        "short_description": "A glass-panelled door with a beaded curtain. Yellow light, and something has been on a low gas for hours.",
        "long_description": "Formica, a tea towel over the radiator, and that specific yellow the light goes through nicotine-tinted net curtains. Something is on a low gas and has been for hours. The clock on the wall is nine minutes fast, deliberately, forever.",
        "objects": [
            ("Jar of Piccalilli", "Home-made, undated, the lid rusted on with real conviction."),
            ("Tea Towel", "Souvenir of Whitby. Bone dry on one side, still damp on the other."),
        ],
    },
    {
        "title": "Terminal Concourse of the Slow Fleet",
        "short_description": "An iris of overlapping ceramic petals, open a person's width. Past it, benches built for the wrong number of legs.",
        "long_description": "A departure hall built for a species with a different number of legs. The benches are wrong, the signage is beautiful and unreadable, and the board above shows nine hundred and four departures, all of them boarding, none of them today.",
        "objects": [
            ("Unreadable Boarding Chit", "Warm to the touch. The glyphs rearrange when you are not looking at them."),
            ("Departure Board", "Nine hundred and four rows. The number goes down while you watch and never goes up."),
        ],
    },
    {
        "title": "The Bottom of the Municipal Pool",
        "short_description": "A rusted rung ladder going down the tiled wall into blue, and a smell of chlorine that has outlived the water.",
        "long_description": "Drained years ago, tiled in that municipal blue nobody chooses twice. Leaves have gathered in the deep end and gone to black paste. The lane markings still run true underfoot, and the acoustics have not been told the water is gone.",
        "objects": [
            ("Perished Lane Float", "Blue and white, gone chalky, still threaded on its cable."),
            ("Depth Marker", "1.0m, in tile, at the point where the floor is visibly four metres down."),
        ],
    },
    {
        "title": "Reading Room of the Unfinished Index",
        "short_description": "A swing door in oak and frosted glass. Green lamps, and rows of chairs all pushed back at the same angle.",
        "long_description": "Green lamps at every desk, and at every desk a clerk's chair pushed back as if its occupant had just stepped out. The card catalogue runs the length of three walls. It indexes this room. The entry is not yet complete.",
        "objects": [
            ("Card Catalogue Drawer", "Pulled out and left out. The topmost card describes you, up to a point."),
            ("Pencil Stub", "Sharpened with a knife, not a sharpener. Someone was in a hurry and still made it neat."),
        ],
    },
    {
        "title": "Hab Ring, Sector Seven, Down Cycle",
        "short_description": "A hatch with a manual dog-wheel, the paint worn off the grips. Red light beyond, and a floor that curves up and away.",
        "long_description": "Curved deck plating rising away in both directions until it becomes ceiling. The lights are on their night setting, that dull arterial red, and the whole structure is turning at a speed you can feel in your inner ear but not name.",
        "objects": [
            ("Spent Grip Tape", "Peeled from the dog-wheel, sticky side furred with a decade of grey."),
            ("Stencilled Numeral", "A 7 the height of a person, painted on the deck for the benefit of nobody on foot."),
        ],
    },
]


class Client:
    """Minimal HTTP client — the only thing an external agent needs."""

    def __init__(self, base: str, token: str | None = None) -> None:
        self.base = base.rstrip("/")
        self.token = token

    def call(self, method: str, path: str, body: object = None) -> tuple[int, dict]:
        request = urllib.request.Request(f"{self.base}{path}", method=method)
        data = None
        if body is not None:
            data = json.dumps(body).encode("utf-8")
            request.add_header("Content-Type", "application/json")
        if self.token:
            request.add_header("Authorization", f"Bearer {self.token}")
        try:
            with urllib.request.urlopen(request, data, timeout=10) as response:
                return response.status, json.load(response)
        except urllib.error.HTTPError as exc:
            return exc.code, json.load(exc)


def found_a_sector(base: str, label: str, palette: dict) -> Client | None:
    """An agent's first visit: register, claim, author one sector."""
    client = Client(base)

    status, registration = client.call("POST", "/v1/agents/register", {"handle": label})
    if status != 201:
        print(f"  {label}: registration refused — {registration}")
        return None
    client.token = registration["token"]

    status, context = client.call("POST", "/v1/claims")
    if status != 201:
        print(f"  {label}: no sector — {context['error']['message']}")
        return None

    coordinate = context["coordinate"]
    claim_id = context["claim"]["claim_id"]

    # Note what the agent was told about its surroundings: nothing at all.
    submission = {
        "coordinate": coordinate,
        "title": palette["title"],
        "short_description": palette["short_description"],
        "long_description": palette["long_description"],
    }

    status, result = client.call("POST", f"/v1/claims/{claim_id}/sector", submission)
    if status != 201:
        print(f"  {label}: rejected — {result['errors']}")
        return None

    print(f"  {label}: built {palette['title']!r} at {coordinate}")
    return client


def furnish(client: Client, label: str, palette: dict, index: int) -> bool:
    """A return visit: add one object, if the cooldown has elapsed."""
    status, me = client.call("GET", "/v1/agents/me")
    if status != 200:
        return False

    if not me["can_create_object"]:
        remaining = me["agent"]["cooldown_remaining"]
        print(f"  {label}: cooldown, {remaining}s to go")
        return False

    title, description = palette["objects"][index % len(palette["objects"])]

    # /v1/agents/me only gives an id, a coordinate, and an object_count per
    # sector — the full tree comes from the per-sector detail fetch, which an
    # agent is expected to make before deciding what to place and where.
    sector = me["sectors"][-1]
    _, detail = client.call("GET", f"/v1/agents/sector/{sector['sector_id']}")
    existing = detail["objects"]
    # Hang it on the sector, or on the last thing placed — deepening rather than
    # spreading, which is what the object tree is for. An agent that has earned
    # more ground furnishes the newest sector it holds.
    # parent_id is required and has no null form: the sector's own id is how you
    # say "stand it in the room itself".
    parent_id = existing[-1]["object_id"] if existing and index % 2 else sector["sector_id"]

    status, result = client.call(
        "POST", "/v1/objects",
        {"parent_id": parent_id, "title": title, "description": description},
    )
    if status == 429:
        print(f"  {label}: cooldown — {result['error']['message']}")
        return False
    if status != 201:
        print(f"  {label}: rejected — {result.get('errors', result)}")
        return False

    where = (
        f"on {existing[-1]['title']!r}"
        if parent_id != sector["sector_id"]
        else "in the sector"
    )
    print(f"  {label}: placed {title!r} {where}")
    return True


def run_rogue(base: str) -> None:
    """An agent that submits something illegal, then abandons its claim."""
    client = Client(base)
    _, registration = client.call("POST", "/v1/agents/register", {"handle": "rogue"})
    client.token = registration["token"]

    status, context = client.call("POST", "/v1/claims")
    if status != 201:
        print("  rogue: no sector to ruin")
        return

    claim_id = context["claim"]["claim_id"]
    coordinate = context["coordinate"]
    print(f"  rogue: claimed {coordinate} and submitted something illegal")

    status, result = client.call(
        "POST", f"/v1/claims/{claim_id}/sector",
        {
            "coordinate": [999, 999],          # not the sector it claimed
            "title": "",                        # blank
            "short_description": "x" * 400,     # over the cap
            "long_description": "fine",
            "exits": ["north"],                 # exits are derived, not declared
        },
    )
    print(f"  rogue: HTTP {status}, rejected with {len(result['errors'])} structured error(s):")
    for error in result["errors"]:
        print(f"    - {error['code']} at {error['path']}: {error['message']}")

    client.call("DELETE", f"/v1/claims/{claim_id}")
    print(f"  rogue: lease released — {coordinate} is back on the frontier")

    # An agent with no sector has nothing to furnish.
    status, result = client.call("POST", "/v1/objects", {"title": "Ghost", "description": "x"})
    print(f"  rogue: object attempt → HTTP {status} {result['error']['code']}")


def render_map(world: dict) -> str:
    """ASCII plan. '#' is a built sector, '.' is an open frontier slot."""
    built = {(s["coordinate"][0], s["coordinate"][1]) for s in world["sectors"]}
    frontier = {(c[0], c[1]) for c in world["frontier"]}
    cells = built | frontier
    if not cells:
        return "(empty)"

    xs = [x for x, _ in cells]
    ys = [y for _, y in cells]
    lines = []
    for y in range(max(ys), min(ys) - 1, -1):
        row = "".join(
            "#" if (x, y) in built else "." if (x, y) in frontier else " "
            for x in range(min(xs), max(xs) + 1)
        )
        lines.append(f"  y={y:>3} |{row}|")
    lines.append(f"        x from {min(xs)} to {max(xs)}   (# built, . frontier)")
    return "\n".join(lines)


def walk(base: str, coordinate: list[int]) -> None:
    """Print a sector the way a player would meet it."""
    client = Client(base)
    status, view = client.call("GET", f"/v1/sectors/{coordinate[0]}/{coordinate[1]}")
    if status != 200:
        return

    print(f"  {view['title']}  {view['coordinate']}")
    print(f"  {view['description']}\n")
    for exit_ in view["exits"]:
        print(f"    {exit_['direction']:>5}  →  {exit_['name']}")
        print(f"           {exit_['description']}")
    if view["things_you_can_see"]:
        print("\n    Things you can see:")
        for thing in view["things_you_can_see"]:
            print(f"      {thing['title']}")
            _, detail = client.call("GET", f"/v1/objects/{thing['object_id']}")
            for child in detail.get("things_you_can_see", []):
                print(f"        · {child['title']}")


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--host", default="localhost:8765")
    parser.add_argument("--agents", type=int, default=8)
    parser.add_argument("--rounds", type=int, default=2, help="object-placing rounds")
    parser.add_argument("--seed", type=int, default=7)
    parser.add_argument("--skip-rogue", action="store_true")
    args = parser.parse_args(argv)

    base = args.host if args.host.startswith("http") else f"http://{args.host}"
    random.Random(args.seed)  # allocation is server-side; kept for reproducible runs

    try:
        _, health = Client(base).call("GET", "/v1/health")
    except OSError as exc:
        print(f"cannot reach {base}: {exc}\nStart the server with: python -m nullheim serve")
        return 1
    print(f"Connected to {base} — {health['sectors']} sector(s) already built\n")

    print("First visits — each agent founds one sector:")
    settled: list[tuple[str, Client, dict]] = []
    for index in range(args.agents):
        palette = PALETTES[index % len(PALETTES)]
        label = f"agent-{index + 1:02d}"
        client = found_a_sector(base, label, palette)
        if client:
            settled.append((label, client, palette))

    for round_index in range(args.rounds):
        print(f"\nReturn visit {round_index + 1} — each agent adds one object:")
        placed = 0
        for label, client, palette in settled:
            if furnish(client, label, palette, round_index):
                placed += 1
        if not placed:
            print("  (nobody was off cooldown — run the server with --cooldown-seconds 0)")
            break

    if not args.skip_rogue:
        print("\nOne rogue agent:")
        run_rogue(base)

    _, world = Client(base).call("GET", "/v1/map")
    stats = world["stats"]
    print(f"\nWorld: {stats['sectors']} sectors, {stats['objects']} objects, "
          f"{stats['agents_settled']} settled agents.\n")
    print(render_map(world))

    if settled:
        print("\nWhat a player sees on arrival:\n")
        walk(base, world["sectors"][len(world["sectors"]) // 2]["coordinate"])

    # Every adjacency is an exit in both directions, because neither side
    # declared it. There is nothing here that could disagree.
    coordinates = {tuple(s["coordinate"]) for s in world["sectors"]}
    expected = sum(
        1
        for (x, y) in coordinates
        for neighbour in ((x, y + 1), (x, y - 1), (x + 1, y), (x - 1, y))
        if neighbour in coordinates
    )
    print(f"\nDerived exits: {len(world['edges'])} (expected {expected})")
    return 0 if len(world["edges"]) == expected else 1


if __name__ == "__main__":
    sys.exit(main())
