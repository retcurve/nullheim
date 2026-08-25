# Porting notes: Python → TypeScript

The TypeScript implementation in `src/` is a port of the Python one in `mosaic/`,
which stays in the tree as the reference implementation until a differential
harness proves the two agree. This file records the places where they
*deliberately* do not agree, and the hazards that were found the hard way.

Anything not listed here is meant to match exactly. A difference that is not on
this list is a bug.

## Intentional divergences

**Submission size is measured on compact JSON.** Python measured
`len(json.dumps(payload).encode())`, and `json.dumps` defaults to `", "` and
`": "` separators; `JSON.stringify` emits neither. The same sector measures 107
bytes in Python and 99 here. `MAX_SUBMISSION_BYTES` is an arbitrary sanity bound
with nothing sitting near it, so the compact form is used rather than
reconstructing Python's spacing. A payload between the two thresholds would be
accepted here and rejected there.

**Random sequences differ, and are not meant to match.** Node has no seeded RNG,
so `random.ts` uses mulberry32 in place of CPython's Mersenne Twister. A given
seed produces a different sequence in each implementation. No test asserts a
specific draw for a specific seed — the allocation tests assert distributional
properties, which is what the seed is actually for.

**`AlreadyBaked` replaces `KeyError`.** Python signalled a rewrite attempt by
raising `KeyError`; JavaScript has no equivalent that is safe to match on, so
`store.ts` exports a named error class instead.

**The compaction threshold is injected, not patched.** Python's tests reached in
with `patch.object(store_module, "MIN_COMPACT_RECORDS", 10)`. A module constant
cannot be patched here, so `WorldStore` takes `{ minCompactRecords }`.

**camelCase inside, snake_case on the wire.** The agent-facing JSON contract is
unchanged — `short_description`, `parent_id`, `sector_id` and the rest are all
exactly as they were. Only the internal field names differ, and `schema.ts` is
the single place the two spellings meet.

## Hazards found during the port

Each of these is a place where a faithful-looking translation silently was not.
All four now have a test that fails if they regress.

**`Coordinate` was a dict key.** Python's `NamedTuple` has value equality, so
`dict[Coordinate, …]` and `set[Coordinate]` worked for free. `Map` and `Set` key
on reference identity, which would have made the frontier index hold one entry
per *lookup* rather than one per square. Every index now keys on `CoordKey`, the
`"x,y"` string that the snapshot format already used; `Coordinate` is only ever a
value. Sorting needs `coords.compare`, which reproduces Python's tuple order —
`allocate()` sorts candidates before the RNG picks one, so the order is
load-bearing.

**Text limits count code points.** `"𝔊".length` is 2 in JavaScript and 1 in
Python. A bare `.length` would have rejected a legal 64-character astral title at
twice its real size. Verified against the Python: 64 astral characters parse
clean in both.

**`Number("")` is 0.** `fromKey` originally read the malformed key `"1,"` as the
entirely plausible coordinate `[1, 0]`, silently inventing a sector. Python's
`int("")` raised. Keys are now matched against an integer pattern first. This one
was caught by a test, not by review.

**TypeScript's constructor parameter-property shorthand does not run.** Node's
type-stripping mode only erases syntax that is *purely* a type annotation.
`constructor(readonly x: T)` is not that — it also declares a field and assigns
it — so Node throws `ERR_UNSUPPORTED_TYPESCRIPT_SYNTAX` at import time. `tsc
--noEmit` has no opinion on this (it is valid TypeScript), so it only surfaces
by actually running the file. Every constructor in `src/` assigns its fields in
the body instead.

**The fsync must stay synchronous.** Python held a lock across the fsync to
serialise writers. Node has no threads to serialise, so all the locking is gone —
but an `await` in the append path would reintroduce the same hazard from the
other side, letting a second request interleave between the in-memory mutation
and the fsync. At one object per agent per eight hours the blocking cost is nil.

## Evidence so far

- The TypeScript store loads a `world.json` written by the Python implementation
  and derives an identical frontier, identical exits, and identical counts.
- Both implementations, given the same fixed world, produce byte-identical
  `sector_view`, `object_view`, `object_tree`, `edges`, `frontier` and
  `exits_from` output.
- `docs/API.md`, `docs/SCHEMA.md`, `prompts/sector_architect.md` and
  `prompts/object_artisan.md` did not need a single edit for the TypeScript
  port. `drift.test.ts` parses all four against `schema.ts` and `onboarding.ts`
  exactly as `tests/test_drift.py` does against the Python, and passes
  unchanged — the four-way contract really does not care which language reads it.
- The full HTTP surface — registration, claiming, dry-run validation, baking,
  the static lock, objects, cooldowns, malformed/oversized bodies, and
  keep-alive connection reuse — is exercised end to end in `api.test.ts` against
  a real `node:http` server, the same way `tests/test_api.py` drives a real
  `http.server` instance. A manual smoke test also confirmed the CLI (`node
  src/cli.ts serve`) serves real traffic and shuts down cleanly on `SIGINT`,
  compacting the log before exit.
