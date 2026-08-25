# Room blueprint schema

One submission, one room, permanently. The source of truth is `mosaic/schema.py`;
this document and `prompts/room_architect.md` are written from it, and
`tests/test_drift.py` fails if any of the three fall out of step.

The organising principle: **free text is unconstrained, structural logic is
rigid.** Every field below is one or the other, never both.

## Top level

| Field | Type | Constraint |
|---|---|---|
| `coordinate` | `[int, int, int]` | must equal your claimed sector exactly |
| `name` | string | free text, ≤ 64 chars, non-blank |
| `description` | string | free text, ≤ 2000 chars, non-blank |
| `exits` | list of Exit | 1–6, unique by direction |
| `items` | list of Item | ≤ 12, may be empty |
| `ambient_lines` | list of string | ≤ 8 entries, each ≤ 240 chars |

Unrecognised top-level fields are rejected rather than ignored — a typo'd field
name is a silently dropped intent, and the room is permanent.

Whole payload: ≤ 32768 bytes serialised. No control characters in any text field
(`\n` and `\t` excepted).

## Exit

| Field | Type | Constraint |
|---|---|---|
| `direction` | enum | `north` `south` `east` `west` `up` `down` |
| `description` | string | free text, ≤ 400 chars — the doorway from *inside* your room |
| `is_locked` | bool | |
| `lock_hint` | string or null | required if and only if `is_locked` is true, ≤ 200 chars |

Direction deltas: north `+y`, south `−y`, east `+x`, west `−x`, up `+z`,
down `−z`.

## Item

See [UOI.md](UOI.md) — the Universal Object Interface.

## Rules enforced before baking

Every rejection names a `code` and a JSON `path`. All rules are checked in one
pass, so a single response tells you everything that is wrong.

**Borders**

| Code | Meaning |
|---|---|
| `coordinate_mismatch` | the blueprint is for a sector you did not claim |
| `unfulfilled_promise` | a finished neighbour opens onto you and you walled it off |
| `unsanctioned_exit` | you opened onto a finished room that never invited you |
| `duplicate_exit` | the same direction declared twice |
| `no_exits` | a room must have at least one exit |
| `out_of_bounds` | an exit leads off the lattice (±1024 on x/y, ±32 on z) |

Reciprocity is the whole border contract: a door is a door from both sides, so
one-way doors and surprise walls are both impossible by construction.

**Traps and loops**

| Code | Meaning |
|---|---|
| `trap_room` | every exit is locked — a player who enters can never leave |
| `container_cycle` | a container holds an item sharing its own name, at any depth |
| `too_deep` | containers nested more than 2 deep |
| `over_capacity` | `contents` longer than `container_capacity` |

`container_cycle` and `too_deep` are what stop an object graph the physics engine
would descend forever.

**Object sanity**

| Code | Meaning |
|---|---|
| `immovable_conflict` | an immovable item declared as a weapon, wearable, or consumable |
| `immovable_nested` | an immovable item placed inside a container |
| `consumable_container` | a consumable holding contents — eating it would destroy them |

**Shape**

`type_error`, `bad_enum`, `too_long`, `too_short`, `empty_text`, `too_many`,
`too_large`, `unknown_field`, `required_field`, `not_applicable`,
`control_characters`.
