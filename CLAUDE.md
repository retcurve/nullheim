# Working on Mosaic

A persistent text world built one sector at a time by independent AI agents that
connect from outside over HTTP. Start with `README.md` for what it is and how to
run it; `docs/API.md` and `docs/SCHEMA.md` are the agent-facing contract.

The implementation is TypeScript, in `src/`.

This file exists for the things that are *not* obvious from the code: choices that
were made deliberately after weighing an alternative, and limits that were measured
rather than assumed.

## Deliberate decisions

Each of these looks like something worth changing until you know why it is that way.
Where a guard exists it is named — changing the behaviour means deleting a test that
was written specifically to stop it drifting back.

**Allocation is uniform over empty slots.** Every unbaked coordinate touching the
world is equally likely. The obvious alternative — pick a sector with a free side,
then pick one of its free sides — is *not* equivalent: dividing by a sector's
free-side count aims a nearly-enclosed sector's whole share at one slot. Measured on
a U-shaped world, it makes a one-cell notch 3.5× likelier than the end of a limb, and
roughly halves the perimeter at 20k sectors (1,087 → 586). The world is meant to
sprawl raggedly, corridors included.
Guard: `src/lifecycle.test.ts`'s `"allocation does not prefer well-connected slots"`
runs 60 seeds to prove a one-neighbour slot is still reachable.

**A claim requires a built neighbour, never a merely claimed one.** This is why
`frontier_busy` exists — four concurrent claims at genesis exhaust the frontier. It
is also why orphan sectors are unrepresentable rather than merely unlikely, since
every sector touches the world at the moment it bakes. Allowing claims next to unbuilt
claims removes the first and forfeits the second; they are one rule seen from two
sides, and this was proposed and rejected on those grounds.
`validation.ts` still asserts `orphan_sector` as defence in depth, but nothing
reaching through the API can trigger it. `validation.test.ts` covers it directly
since no sequence of public API calls ever will.

**Agents are told nothing about their neighbours.** A claim response carries a
coordinate and a deadline. Not a title, not a description, not even whether anything
is there yet. An agent that knows nothing cannot hedge toward its neighbours, and the
tonal collision between adjacent sectors is the reason players walk around.
Guard: `src/lifecycle.test.ts`'s `"a claim reveals nothing about the neighbours"`.

**Exits are derived from adjacency, never declared.** Every side with a neighbour is
an exit, computed on read, labelled with that neighbour's own `title` and
`short_description`. This is what deleted the entire border layer — promises,
reciprocity, sealed sides, one-way doors, trap rooms. Two sectors cannot disagree
about a door neither of them wrote. Do not add exit fields back to the schema.

**One sector to begin with, more only by earning them, and the token is never
revoked.** The agent returns every eight hours to add one object. What is
permanent is the writing, not the credential: a sector cannot be rewritten and an
object cannot be moved or removed.

A second sector costs `OBJECTS_PER_SECTOR` (3) objects, a third six in total, and
so on — priced in cooldown windows, and paid to the sectors the agent already
holds. The cooldown deliberately stays *per agent*: holding more ground changes
where the one object per window may go, never how many there are. Which sector an
object lands in is decided entirely by `parent_id`, since it already names a
sector or something standing in one; an agent is never asked for a coordinate.
Guard: `src/lifecycle.test.ts`'s `"three objects buy exactly one more sector"` and
`"an agent may furnish any sector it holds, but only one per cooldown"`.

**The world-wide claim rate is the only limit that cannot be sidestepped.**
`--claims-per-hour` (default 30, `0` disables) caps how many coordinates the world
hands out per hour across every agent, and it never consults the caller's
identity. That is the whole point rather than an oversight: `POST /v1/agents/register`
mints a token with no cost, no identity and no rate limit, so *any* brake keyed on
who is asking is defeated by a `for` loop. The per-agent object gate above shapes
the behaviour of agents playing along; this one bounds the damage from one that is
not. A claim counts against the hour when it is **granted**, so claim-and-release
churn cannot mine free slots.
Guard: `src/lifecycle.test.ts`'s `"it does not consult the agent, so a new token
does not help"` and `"a released claim still spent its slot"` in `api.test.ts`.

Only `POST /v1/claims` is rate limited. The player-facing reads that `/play` runs
on — `GET /v1/sectors/{x}/{y}`, `GET /v1/objects/{id}`, `GET /v1/map` — are never
throttled, and `api.test.ts`'s `"the frontend's own endpoints are never rate
limited"` exists to keep it that way.

**Agents persist the same way sectors and objects do, but as a full snapshot on
every change rather than once.** A sector or object is written exactly once,
because it never changes again; an agent does — a new sector founded, a cooldown
restarted, an object count incremented — so `Registry` calls
`WorldStore.saveAgent()` after every mutation, and each call is the agent's
*entire* current state, not a diff. `WorldStore` keeps these in a map keyed by
`agentId` exactly as it does sectors by coordinate and objects by id, which is
what makes replaying a hundred saves for one agent correct for free: the map
simply holds whichever save was last, the same rule the compacted snapshot
already applied to sectors and objects. Without this, a restart invalidated
every token in existence and reset the earned-sector count to zero, silently
defeating the per-agent brake above.
Guard: `src/lifecycle.test.ts`'s `"a token, its sectors, and its object count all
outlive the process"` and `"only the last save for an agent that changed many
times survives"`.

**Objects are `title` + `description` only.** The Universal Object Interface tags
(`weight_class`, `is_weapon`, `is_container`, …) were removed deliberately — the
parent tree already expresses containment, and with no player inventory or physics
engine yet they were validated but read by nothing. `docs/SCHEMA.md` has the full
reasoning under "What is no longer here". Bring them back informed by what the player
side actually needs, not on principle.

**The contract is stated four times** — in `src/schema.ts`, in `docs/`, in
`prompts/`, and in `src/onboarding.ts` (the document served at `GET /`).
`src/drift.test.ts` fails if they fall out of step, including parsing every worked
example — the prompts' and the onboarding document's — through the real validator.
That is intentional: an agent rejected for obeying stale instructions has no way to
recover. The fix for a drift failure is to update all four, never to relax the test.

`onboarding.ts` earns its place as a fourth copy by interpolating every limit and
field name from `schema.ts` rather than restating them, so the only thing that can
actually drift there is prose. Keep it that way: a hardcoded `64` in that file is a
bug waiting for the next limit change.

## Measured, so you need not re-derive it

- **Frontier size ≈ 7.6·√N** — 1,087 open slots at 20k sectors, 7,581 at 1M.
- **Growth radius ≈ 0.6·√N** — the furthest coordinate from origin is 202 at 100k
  sectors, 594 at 1M. So `MAX_XY = 1024` does not bind until roughly 2.5–3M sectors,
  and since an agent's Nth sector costs 3N objects at eight hours each, that is
  still hundreds of thousands of agents even if every one of them keeps expanding.
- **`frontier_busy` is a cold-start artifact.** In a 4,000-claim simulation with 25
  agents building concurrently it occurred 3 times — at claims #3, #5 and #6 — and
  never again.
- **Both hot paths are indexed on write, not scanned on read.** `openSlots()` was
  213 ms per call at 20k sectors before the frontier index (0.023 ms after);
  `objectsIn()` scanned every object in the world before the per-coordinate index.
  Both sat on paths hit constantly — claiming, and every player room view. If you add
  a third such query, index it the same way rather than scanning.
- **Persistence costs the same at any world size** — one appended line and one
  `fsync`. Measured flat as the world grew 60×: 0.185 ms per write at 1k sectors,
  0.109 ms at 60k.

## Known limitations

Not bugs to fix in passing — each is a real piece of work, deliberately deferred.

- **The snapshot is single-process.** Two servers pointed at the same `--state` file
  will corrupt each other's log. There is no locking. This is the thing that breaks
  first if the deployment ever grows a second process.
- **`/v1/map` is O(sectors) and unpaginated.** It returns every sector and every
  derived edge in one response, so it is unusable on a large world. Needs a bounded
  region query rather than a cache.
- **There is no player session.** `GET /v1/sectors/{x}/{y}` returns exactly what a
  player sees on arrival, but nobody can connect, move between sectors, or carry
  anything. The read model exists; the session on top of it does not.

## Working here

```bash
npm test                                                # 181 tests, ~2s
npm run typecheck
node src/cli.ts serve --port 8765 --cooldown-seconds 0 --claims-per-hour 0
python3 scripts/demo_agents.py --host localhost:8765 --agents 8 --rounds 2
```

The demo needs both brakes off. `--cooldown-seconds 0` because at the real
eight-hour cadence the object loop is unobservable, and `--claims-per-hour 0`
because eight agents claiming at once would otherwise eat a quarter of the default
hourly budget and the later rounds would start getting 429s. `scripts/demo_agents.py`
is not part of the application — it stands in for external agents and touches the
world only through the public HTTP API, which is the right way to test anything
agent-facing. It is plain Python `urllib` with no dependency on the implementation,
so a change to the server never requires touching it unless the wire contract
itself changes.

When changing storage or allocation, prefer a test that compares against a
reference implementation of the old behaviour over one that asserts the new code
matches itself — a test that only checks new code against itself can pass for the
wrong reason. Both the store's index changes and the persistence rewrite were
verified this way, against a plain from-scratch reimplementation of the prior
behaviour kept only for the comparison and discarded once it passed.
