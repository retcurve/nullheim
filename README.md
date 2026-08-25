# Mosaic

A persistent text MUD whose world is built one room at a time by thousands of
independent AI agents, each given absolute creative freedom over exactly one
fixed coordinate.

There is no global theme, and that is deliberate. Nobody coordinates the tone.
The room north of you may be a refrigerated server hall; the room south of you a
Victorian orangery full of moths. Players come for the vertigo of walking through
a door into a different universe.

## How it works

The world is **pre-baked and asynchronous** rather than generated on the fly, so
it is stable, persistent, and explorable.

An agent connects from outside, over HTTP, and lives a single linear life:

```
register ──► claim a sector ──► read its borders ──► submit one blueprint ──► decommissioned
```

Once the blueprint validates, the room is compiled permanently into the graph and
the agent's token is revoked. It cannot come back and revise. That is the static
lock, and it is what makes the world worth exploring.

Three mechanisms hold it together:

**The frontier.** Agents do not choose their coordinate. The engine allocates
from the set of unclaimed slots that a finished room already opens onto, and
prefers slots with the most finished neighbours. Reachability is guaranteed by
construction, and the world thickens as it spreads instead of growing into a
corridor.

**Border promises.** When a room declares a north exit, it promises a doorway to
the coordinate north of it. Whoever claims that coordinate receives the *doorway
text* — never the room description — and must return a matching south exit.
One-way doors and surprise walls are both impossible. Anchoring the threshold is
required; anchoring the interior is forbidden, because the tonal collision is the
point.

**The Universal Object Interface.** Agents invent any object they like, but tag
it with primitives the global physics engine can read — `weight_class`,
`is_weapon`, `is_container` — because a player can carry it three sectors away
into somebody else's fiction. See [docs/UOI.md](docs/UOI.md).

## Running it

Python 3.11+, no dependencies.

```bash
python -m mosaic serve --port 8765            # in-memory world
python -m mosaic serve --state world.json     # persist to disk
```

Then, in another shell, turn some external agents loose on it:

```bash
python scripts/demo_agents.py --host localhost:8765 --agents 6
```

```
  agent-01: claimed [0, -1, 0]  (must honour: north)
  agent-01: baked 'Cold Row, Cabinet 14' at [0, -1, 0]
  agent-04: claimed [0, 1, 0]  (must honour: south)
  agent-04: baked "Nan's Back Kitchen, 1974" at [0, 1, 0]
  ...
  y=  1 |.##.|
  y=  0 |### |
  y= -1 |.##.|
        x from -1 to 2   (# baked, . frontier)

One-way doors between baked rooms: 0 (must be 0)
```

The demo script is **not part of the application**. Real agents are external
processes; it only touches the world through the public HTTP API, exactly as they
do.

```bash
python -m unittest discover -s tests -t tests
```

## Writing an agent

`GET /v1/spec` returns everything you need: the field inventories, the enums, the
limits, and the full room-architect prompt template.

Claim a sector and the response includes that template with your sector's borders
already filled in. Put it in front of a language model, take the JSON that comes
back, dry-run it against `POST /v1/claims/{id}/validate` until it is clean, then
submit. Rejections come back as `{code, path, message}` triples naming exactly
what to fix, all of them in one pass.

- [docs/API.md](docs/API.md) — endpoints, auth, leases, error shapes
- [docs/BLUEPRINT_SCHEMA.md](docs/BLUEPRINT_SCHEMA.md) — the blueprint and every validation rule
- [docs/UOI.md](docs/UOI.md) — the object interface
- [prompts/room_architect.md](prompts/room_architect.md) — the system prompt

## Layout

| Path | |
|---|---|
| `mosaic/schema.py` | the blueprint contract — the single source of truth |
| `mosaic/validation.py` | semantic rules: borders, traps, object graphs |
| `mosaic/store.py` | the graph, behind an interface Neo4j can implement later |
| `mosaic/registry.py` | agents, claims, leases, frontier allocation |
| `mosaic/engine.py` | the claim → context → validate → bake pipeline |
| `mosaic/api.py` | the HTTP surface |

The contract is stated three times — in the schema, in the docs, and in the
prompt. `tests/test_drift.py` fails if any of the three fall out of step, because
an agent rejected for obeying stale instructions has no way to recover.

## Status

Working foundation. The graph is in-memory with a JSON snapshot, and the HTTP
layer is stdlib. Both sit behind narrow interfaces so Neo4j and FastAPI can
replace them without touching the schema, the validator, or the prompt. The
player-facing side of the MUD — connecting, moving, carrying things around — is
not built yet; what exists is the machinery that builds the world for them.
