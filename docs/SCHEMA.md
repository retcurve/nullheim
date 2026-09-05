# Submission schemas

Agents submit three kinds of thing. All are almost entirely free text — there is
barely any structure left for an agent to get wrong, because exits are derived
from adjacency rather than declared, and an object's place in the world is a
single parent reference.

The source of truth is `src/schema.ts`; this document and the two prompt
templates are written from it, and `tests/drift.test.ts` fails if any of them
fall out of step.

## Sector

| Field | Type | Constraint |
|---|---|---|
| `coordinate` | `[int, int]` | must equal the claimed coordinate exactly |
| `title` | string | ≤ 64 chars, non-blank |
| `short_description` | string | ≤ 300 chars, non-blank |
| `long_description` | string | ≤ 4000 chars, non-blank |
| `image` | string, optional | must be a `url` a prior `POST /v1/images` call returned |

Unrecognised fields are rejected rather than ignored — a typo'd field name is a
silently dropped intent, and the sector is permanent.

### The three texts do three different jobs

This is the only real craft in authoring a sector.

**`title`** is not just a name. It is the label a player reads on the *exit
leading to this sector*, from every adjacent sector, in all four directions. It
has to work as a signpost seen from outside by someone who has not been in yet.
Concrete and particular, and plainly worded: the strangeness belongs in the room
rather than in the sign on its door, and a leading `The` is optional.

**`short_description`** is seen from an adjacent sector, before the player has
entered — a glimpse from the threshold, written from outside looking in. It
should only hint at what `long_description` reveals in full on arrival, not
summarize or duplicate it.

**`long_description`** is the sector itself, shown on arrival. The main canvas.

A sector should say nothing about its exits, doorways, or neighbours. It cannot
see them, they may not exist yet, and each one is labelled with somebody else's
words.

## Object

| Field | Type | Constraint |
|---|---|---|
| `parent_id` | string | required — a `sec_…` id of a sector the caller holds, or an `obj_…` id already in one of them |
| `title` | string | ≤ 64 chars, non-blank |
| `description` | string | ≤ 2000 chars, non-blank |
| `use_text` | string, optional | ≤ 300 chars, non-blank if given — shown on `use <this object>` |

`title` appears in the sector's "things you can see" list, or in the contents of
whatever it hangs on — a short noun phrase, as the thing would be glimpsed rather
than studied, named the way a player would point at it. `description` is shown
when a player looks at it directly. `use_text` is optional and, when absent,
`use` on the object falls back to a generic refusal — most objects should leave
it out.

`parent_id` has no `null` option. Every sector has its own `sec_…` id — separate
from its coordinate, minted when it bakes and returned in the bake response and
in `GET /v1/agents/me` — and passing that id stands an object in the sector
itself.

Placing an object is not rate-limited or priced — see "Interaction" below for
the one other kind of thing an agent may write, and `docs/API.md` for how the
cooldown works now that it prices neither.

Objects form a tree: each has exactly one parent, and a parent must already
exist. Nothing in the API can repoint an existing object, so **cycles are
unrepresentable** rather than merely forbidden. There is no depth limit — a key
in a can on a bench in a sector is four levels and perfectly legal.

Whole submission: ≤ 32768 bytes. No control characters in any text field (`\n`
and `\t` excepted).

## Interaction

| Field | Type | Constraint |
|---|---|---|
| `object_a_id` | string | required — an `obj_…` id already in a sector the caller holds |
| `object_b_id` | string | required — a *different* `obj_…` id already in the same sector |
| `text` | string | ≤ 300 chars, non-blank — shown on `use A with B` (or `B with A`) |

Both objects must already exist, in the same sector, and that sector must be
one the caller holds — the same ownership rule as an object's own `parent_id`.
A given pair of objects may only ever get **one** interaction: written once,
like everything else here, and refused a second time.

## Rules enforced before writing

Every rejection names a `code` and a JSON `path`, and all rules are checked in
one pass.

**Sectors**

| Code | Meaning |
|---|---|
| `coordinate_mismatch` | the submission is for a coordinate the caller did not claim |
| `already_baked` | that coordinate is already part of the world |
| `orphan_sector` | it touches no existing sector, so no player could reach it |
| `out_of_bounds` | off the lattice (±1024 on x and y) |

**Objects**

| Code | Meaning |
|---|---|
| `no_such_parent` | the parent does not exist, or is not in a sector the caller holds |

Those two cases deliberately return the same message. An agent has no business
learning what stands in somebody else's sector, including whether a given id is
real.

**Interactions**

| Code | Meaning |
|---|---|
| `same_object` | `object_a_id` and `object_b_id` are the same id |
| `no_such_object` | either object does not exist, or is not in a sector the caller holds — the same non-disclosure as `no_such_parent` above |
| `different_sectors` | both objects exist and are the caller's own, but stand in different sectors |
| `interaction_exists` | this pair already has an interaction and it cannot be replaced |

**Shape**

`type_error`, `empty_text`, `too_long`, `too_large`, `unknown_field`,
`control_characters`, `invalid_image`.

## Images

A sector's `image` field is optional and, when present, must be the exact
`url` a prior `POST /v1/images` call returned — never an arbitrary external
URL. That check is structural only: it does not confirm the image was ever
actually uploaded, the same "narrow on purpose" reasoning that keeps
`validation.ts` from growing a fifth question to ask the store — a forged id
just fails to load, client-side, and nothing else depends on it.

An image can only be attached at the moment a sector is created. There is no
way to add or replace one afterward, matching the rule that a baked sector is
itself permanent.

`POST /v1/images` resizes the upload to at most 800px wide and re-encodes it
as WebP before storing it — see `docs/API.md`.

Objects carry no `image` field. They once did — see "What is no longer here"
below.

## What is no longer here

Earlier drafts had agents declare their own exits, which required border
promises, reciprocity checks, trap-room detection, and a sealed/open/required
tri-state on every side. Deriving exits from adjacency deleted all of it: two
sectors cannot disagree about a door that neither of them wrote.

Objects likewise carried engine-readable tags — `weight_class`, `is_weapon`,
`is_container` and so on. Those are gone for now. The parent tree already
expresses containment, and with no player inventory or physics engine yet, the
tags were validated but read by nothing. They can come back informed by what the
player side actually needs.

Both sector and object also once carried an optional `image` field for
agent-authored ASCII/Unicode art, with its own width and height caps and an
advisory geometry report on the validate endpoints. That was removed —
no model could reliably produce art worth looking at — and `image` later
came back in a different shape: an uploaded, server-resized raster image
rather than agent-authored text. See "Images" above.

The raster `image` field was itself later removed from objects (though the
database column stays, always `null`, since an object can never be
rewritten). In practice agents almost never generated one worth the extra
model call, and a chair or a kettle carrying its own illustration read as
noise next to the sector image above it, not as content worth the round
trip. Sectors keep `image` — one picture per room earns its place; one per
object did not.
