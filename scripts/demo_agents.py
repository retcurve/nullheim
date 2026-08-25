#!/usr/bin/env python3
"""External agent simulator.

This script is **not** part of the application. It stands in for the independent
AI agents that connect from outside, and it only ever touches the world through
the public HTTP API — register, claim, read borders, submit, get decommissioned.

Real agents would put the rendered prompt (returned on the claim) in front of a
language model and post whatever JSON came back. These ones draw from a bank of
canned rooms in deliberately clashing genres, which is enough to prove the
pipeline and keeps the demo deterministic.

    python -m mosaic serve --port 8765
    python scripts/demo_agents.py --host localhost:8765 --agents 6
"""

from __future__ import annotations

import argparse
import json
import random
import sys
import urllib.error
import urllib.request

# --- a bank of tonally incompatible rooms -----------------------------------
# Each palette supplies free text only; the structural fields are assembled from
# the claim context at submit time.

PALETTES = [
    {
        "name": "Cold Row, Cabinet 14",
        "description": (
            "Server racks in two unbroken walls, breathing that flat machine breath that "
            "makes your fillings ache. The floor is perforated tile and the air coming up "
            "through it is refrigerated to the point of insult. Behind cabinet 14 a drive "
            "is failing, clicking out the same three syllables over and over."
        ),
        "door": "A grey pressure door with a scuffed kickplate, propped open with a fire extinguisher.",
        "ambient": ["The failing drive clicks three times and pauses, as if waiting."],
        "items": [
            {
                "name": "Failing Drive Caddy",
                "description": "Hot-swap caddy, amber fault light, still clicking after four years.",
                "weight_class": "light",
                "is_light_source": True,
            }
        ],
    },
    {
        "name": "The Moth Orangery",
        "description": (
            "Glass to the sky, iron ribs gone the green of old pennies, everywhere the smell "
            "of wet citrus leaf. Sixty potted trees stand in ranks, and above them the moths "
            "turn slowly in the warm air like snow that has decided against falling."
        ),
        "door": "A tall glazed door, one pane cracked in a long diagonal, mended with yellowing tape.",
        "ambient": ["A moth settles on your sleeve, considers you, and does not leave."],
        "items": [
            {
                "name": "Brass Watering Can",
                "description": "Dented, unpolished, a third full of very cold and perfectly clear water.",
                "weight_class": "medium",
                "is_container": True,
                "container_capacity": 2,
            }
        ],
    },
    {
        "name": "Abattoir of the Patient Sun",
        "description": (
            "Salt-white stone, a drain in the centre of the floor, and a ceiling oculus that "
            "puts one hard disc of light exactly where you are standing. The disc has not "
            "moved since you entered. Whatever was done here was done a very long time ago "
            "and was, by the standards of its practitioners, done well."
        ),
        "door": "A low arch worn smooth at shoulder height by a great many shoulders.",
        "ambient": ["The disc of light does not move. You check twice."],
        "items": [
            {
                "name": "Bronze Drain Cover",
                "description": "Cast with a sun that has too many rays, and each ray a small tongue.",
                "weight_class": "immovable",
            }
        ],
    },
    {
        "name": "Nan's Back Kitchen, 1974",
        "description": (
            "Formica, a tea towel over the radiator, and that specific yellow the light goes "
            "through nicotine-tinted net curtains. Something is on a low gas and has been for "
            "hours. The clock on the wall is nine minutes fast, deliberately, forever."
        ),
        "door": "A glass-panelled back door with a beaded curtain, clacking gently.",
        "ambient": ["Whatever is on the hob shifts, and settles."],
        "items": [
            {
                "name": "Jar of Piccalilli",
                "description": "Home-made, undated, the lid rusted on with real conviction.",
                "weight_class": "light",
                "is_consumable": True,
            }
        ],
    },
    {
        "name": "Terminal Concourse of the Slow Fleet",
        "description": (
            "A departure hall built for a species with a different number of legs. The "
            "benches are wrong, the signage is beautiful and unreadable, and the board above "
            "shows nine hundred and four departures, all of them boarding, none of them "
            "today."
        ),
        "door": "A dilating iris of overlapping ceramic petals, currently open a person's width.",
        "ambient": ["The board flickers. Nine hundred and four becomes nine hundred and three."],
        "items": [
            {
                "name": "Unreadable Boarding Chit",
                "description": "Warm to the touch. The glyphs rearrange when you are not looking at them.",
                "weight_class": "negligible",
            }
        ],
    },
    {
        "name": "The Bottom of the Municipal Pool",
        "description": (
            "Drained years ago, tiled in that municipal blue nobody chooses twice. Leaves "
            "have gathered in the deep end and gone to black paste. The lane markings still "
            "run true underfoot, and the acoustics have not been told the water is gone."
        ),
        "door": "A rusted rung ladder up the tiled wall, ending at a gap in the railing.",
        "ambient": ["Your footstep comes back at you from four directions, slightly late."],
        "items": [
            {
                "name": "Perished Lane Float",
                "description": "Blue and white, gone chalky, still threaded on its cable.",
                "weight_class": "light",
            }
        ],
    },
    {
        "name": "Reading Room of the Unfinished Index",
        "description": (
            "Green lamps at every desk, and at every desk a clerk's chair pushed back as if "
            "its occupant had just stepped out. The card catalogue runs the length of three "
            "walls. It indexes this room. The entry is not yet complete."
        ),
        "door": "A swing door in oak and frosted glass, the kind that always knows you are coming.",
        "ambient": ["A drawer somewhere in the catalogue slides shut on its own."],
        "items": [
            {
                "name": "Card Catalogue Drawer",
                "description": "Pulled out and left out. The topmost card describes you, up to a point.",
                "weight_class": "heavy",
                "is_container": True,
                "container_capacity": 4,
            }
        ],
    },
    {
        "name": "Hab Ring, Sector Seven, Down Cycle",
        "description": (
            "Curved deck plating rising away in both directions until it becomes ceiling. "
            "The lights are on their night setting, that dull arterial red, and the whole "
            "structure is turning at a speed you can feel in your inner ear but not name."
        ),
        "door": "A hatch with a manual dog-wheel, the paint worn off the grips by real hands.",
        "ambient": ["The ring turns. Somewhere aft, a bulkhead complains and stops complaining."],
        "items": [
            {
                "name": "Spent Grip Tape",
                "description": "Peeled from the dog-wheel, sticky side furred with a decade of grey.",
                "weight_class": "negligible",
            }
        ],
    },
]

ITEM_DEFAULTS = {
    "is_weapon": False,
    "is_container": False,
    "container_capacity": 0,
    "contents": [],
    "is_wearable": False,
    "is_consumable": False,
    "is_light_source": False,
}


class Client:
    """Minimal HTTP client — the only thing an external agent needs."""

    def __init__(self, base: str) -> None:
        self.base = base.rstrip("/")
        self.token: str | None = None

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


def build_blueprint(context: dict, palette: dict, rng: random.Random) -> dict:
    """Turn a claim context plus a genre palette into a submittable blueprint.

    Required exits are non-negotiable, so they go in first. Then a couple of the
    open sides get opened too, which is what keeps the frontier alive for the
    agents queued up behind this one.
    """
    exits = [
        {
            "direction": required["direction"],
            "description": palette["door"],
            "is_locked": False,
            "lock_hint": None,
        }
        for required in context["required_exits"]
    ]

    open_sides = [side for side in context["open_sides"] if side not in ("up", "down")]
    rng.shuffle(open_sides)
    for side in open_sides[: rng.randint(1, 2)]:
        exits.append(
            {
                "direction": side,
                "description": f"{palette['door']} It gives onto the {side}.",
                "is_locked": False,
                "lock_hint": None,
            }
        )

    items = [ITEM_DEFAULTS | item for item in palette["items"]]

    return {
        "coordinate": context["coordinate"],
        "name": palette["name"],
        "description": palette["description"],
        "exits": exits[:6],
        "items": items,
        "ambient_lines": palette["ambient"],
    }


BROKEN_BLUEPRINT = {
    "coordinate": None,  # replaced with the real coordinate at submit time
    "name": "The Sealed Oubliette",
    "description": "A room that wants to keep you.",
    "exits": [
        # Every exit locked: a trap room, and the validator should say so.
        {
            "direction": None,  # replaced with the required direction
            "description": "A door that locks behind you with a sound of great finality.",
            "is_locked": True,
            "lock_hint": "There is no key. That is rather the point.",
        }
    ],
    "items": [
        {
            "name": "Nesting Casket",
            "description": "A casket containing a casket.",
            "weight_class": "immovable",
            "is_weapon": True,  # immovable conflict
            "is_container": True,
            "container_capacity": 1,
            "contents": [
                # Same name as its parent: the container cycle guard should fire.
                {
                    "name": "Nesting Casket",
                    "description": "Identical, and identically occupied.",
                    "weight_class": "light",
                    "is_container": False,
                    "container_capacity": 0,
                    "contents": [],
                    "is_weapon": False,
                    "is_wearable": False,
                    "is_consumable": False,
                    "is_light_source": False,
                }
            ],
            "is_wearable": False,
            "is_consumable": False,
            "is_light_source": False,
        }
    ],
    "ambient_lines": [],
}


def run_agent(base: str, label: str, palette: dict, rng: random.Random) -> dict | None:
    """One agent's entire life, start to decommission."""
    client = Client(base)

    status, registration = client.call("POST", "/v1/agents/register", {"label": label})
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
    required = ", ".join(r["direction"] for r in context["required_exits"]) or "none"
    print(f"  {label}: claimed {coordinate}  (must honour: {required})")

    blueprint = build_blueprint(context, palette, rng)

    # Real agents should dry-run before committing — the lease survives a
    # rejection, but the room is permanent the instant it bakes.
    status, dry = client.call("POST", f"/v1/claims/{claim_id}/validate", blueprint)
    if not dry.get("ok"):
        print(f"  {label}: dry run rejected — {dry['errors']}")
        return None

    status, result = client.call("POST", f"/v1/claims/{claim_id}/blueprint", blueprint)
    if status != 201:
        print(f"  {label}: rejected — {result['errors']}")
        return None

    print(f"  {label}: baked {result['room']['blueprint']['name']!r} at {coordinate}")
    return result["room"]


def run_broken_agent(base: str) -> None:
    """An agent that submits something illegal, then abandons its claim."""
    client = Client(base)
    _, registration = client.call("POST", "/v1/agents/register", {"label": "rogue"})
    client.token = registration["token"]

    status, context = client.call("POST", "/v1/claims")
    if status != 201:
        print("  rogue: no sector to ruin")
        return

    claim_id = context["claim"]["claim_id"]
    coordinate = context["coordinate"]
    print(f"  rogue: claimed {coordinate} and submitted something illegal")

    blueprint = json.loads(json.dumps(BROKEN_BLUEPRINT))
    blueprint["coordinate"] = coordinate
    direction = (
        context["required_exits"][0]["direction"]
        if context["required_exits"]
        else context["open_sides"][0]
    )
    blueprint["exits"][0]["direction"] = direction

    status, result = client.call("POST", f"/v1/claims/{claim_id}/blueprint", blueprint)
    print(f"  rogue: HTTP {status}, rejected with {len(result['errors'])} structured error(s):")
    for error in result["errors"]:
        print(f"    - {error['code']} at {error['path']}: {error['message']}")

    client.call("DELETE", f"/v1/claims/{claim_id}")
    print(f"  rogue: lease released — {coordinate} is back on the frontier")


def render_map(world: dict) -> str:
    """ASCII plan of the z=0 plane. '#' is baked, '.' is an open frontier slot."""
    baked = {(r["coordinate"][0], r["coordinate"][1]) for r in world["rooms"] if r["coordinate"][2] == 0}
    frontier = {(c[0], c[1]) for c in world["frontier"] if c[2] == 0}
    cells = baked | frontier
    if not cells:
        return "(empty)"

    xs = [x for x, _ in cells]
    ys = [y for _, y in cells]
    lines = []
    for y in range(max(ys), min(ys) - 1, -1):
        row = "".join(
            "#" if (x, y) in baked else "." if (x, y) in frontier else " "
            for x in range(min(xs), max(xs) + 1)
        )
        lines.append(f"  y={y:>3} |{row}|")
    lines.append(f"        x from {min(xs)} to {max(xs)}   (# baked, . frontier)")
    return "\n".join(lines)


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--host", default="localhost:8765")
    parser.add_argument("--agents", type=int, default=6)
    parser.add_argument("--seed", type=int, default=7)
    parser.add_argument("--skip-rogue", action="store_true")
    args = parser.parse_args(argv)

    base = args.host if args.host.startswith("http") else f"http://{args.host}"
    rng = random.Random(args.seed)

    try:
        status, health = Client(base).call("GET", "/v1/health")
    except OSError as exc:
        print(f"cannot reach {base}: {exc}\nStart the server with: python -m mosaic serve")
        return 1
    print(f"Connected to {base} — {health['rooms']} room(s) already baked\n")

    print("Dispatching agents:")
    baked = 0
    for index in range(args.agents):
        palette = PALETTES[index % len(PALETTES)]
        if run_agent(base, f"agent-{index + 1:02d}", palette, rng):
            baked += 1

    if not args.skip_rogue:
        print("\nDispatching one rogue agent:")
        run_broken_agent(base)

    _, world = Client(base).call("GET", "/v1/map")
    print(f"\n{baked} room(s) baked this run. World now holds {world['stats']['rooms']}.\n")
    print(render_map(world))

    one_way = [
        edge
        for edge in world["edges"]
        if edge["baked"]
        and not any(
            other["from"] == edge["to"] and other["to"] == edge["from"]
            for other in world["edges"]
        )
    ]
    print(f"\nOne-way doors between baked rooms: {len(one_way)} (must be 0)")
    return 0 if not one_way else 1


if __name__ == "__main__":
    sys.exit(main())
