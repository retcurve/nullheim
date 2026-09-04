# Decisions

This file records why Nullheim's rules are what they are: the alternatives that
were weighed, what was measured, what was tried and reverted, and what changed
over time. `CLAUDE.md` states the current rule. This file is where the argument
for it lives. If you are about to change a rule and this file does not explain
why it is there, that is a gap in this file, not a license to change the rule.

This file is written in plain English: short sentences, plain words, no
literary flourish. Keep new entries in that style.

Each section here is referenced by name from the matching rule in `CLAUDE.md`.

## Allocation is uniform over empty slots

Every unbaked coordinate touching the world has an equal chance of being handed
out. The obvious alternative is to pick a sector with a free side first, then
pick one of its free sides. That is not the same thing: dividing a sector's
chances by its free-side count gives an almost-enclosed sector's whole share to
one slot. Measured on a U-shaped test world, this made a one-cell notch 3.5
times more likely than the end of a long corridor, and roughly halved the
perimeter at 20,000 sectors (1,087 open slots dropped to 586). The world is
meant to sprawl raggedly, corridors included, so uniform-over-slots is the rule.

Checked by `src/lifecycle.test.ts`, `"allocation does not prefer well-connected
slots"`, which runs 60 seeds to prove a one-neighbor slot is still reachable.

## An image's cache lifetime depends on whether a sector references it

`GET /v1/images/{id}` used to always answer `max-age=31536000, immutable`.
That was fine when an upload lasted forever. It stopped being fine once the
reaper could delete unused uploads: a year-long `immutable` header on a
deletable object means anyone who fetched it keeps being served a copy long
after the real one is gone. And the person holding an abandoned upload's URL is
the same person who uploaded it — exactly the free image-hosting case the
reaper exists to close. So the response first asks
`WorldStore.imageIsReferenced()`. If a sector shows the image, it can never
stop being shown, so the cache header says a year. If no sector shows it, it
may be gone within a minute, so the header says `no-store`. This extra check is
indexed (`idx_sectors_image`) and only runs on a cache miss. Any URL a player
can actually reach is referenced by definition, since a sector view is the only
thing that hands one out.

Checked by `api.test.ts`, `"cache lifetime follows whether the image is
permanent"`, which walks one image across that boundary.

## Every response carries security headers, and the two documents use different policies

`nosniff`, `Referrer-Policy: no-referrer`, and `X-Frame-Options: DENY` go on
every response. The two Content-Security-Policy headers differ because the two
documents differ. `API_CSP` covers the onboarding page at `GET /`: it is
`default-src 'none'` plus `style-src 'unsafe-inline'`, because that page needs
one inline `style` attribute. Scripts are still fully blocked there, so this
concession gives an attacker nothing. `ENTER_CSP` covers `public/`: it is
`default-src 'self'` with no `unsafe-` of any kind, because that page has no
inline script or style and loads every resource from this same origin.
`connect-src 'self'` there is what would stop a future bug in `app.js` from
quietly sending a player's position somewhere else. Static files are routed
before the shared request-handling code, so both server transports set these
headers themselves: `node-server.ts`'s `serveStatic`, and the `/enter` branch of
`worker.ts`.

Checked by `api.test.ts`, `"security headers"`, which also checks that the
frontend's policy contains no `unsafe-` of any kind.

## The player frontend renders no links, and no sector can send a request off this domain

`public/app.js`'s `toHtml` turns `**bold**`, `__underline__`, and `##title##`
into markup, and does nothing else. It used to also turn a bare `https://…`
into a clickable link; that was removed on 2026-09-04. Sector text is written
by anyone who can register, and it can never be edited or taken down. A
clickable outbound link in that text is a permanent phishing target, hosted
under this world's own domain, pointing at a destination nobody here controls
— one that could even change after the sector was written. Now a URL just
renders as the text it is: readable, copyable, but inert.

The same rule, applied from the other direction, is `schema.ts`'s
`IMAGE_URL_PATTERN`. It accepts only `/v1/images/<key>` — never a full URL,
never a protocol-relative one, never this world's own domain spelled out by
hand. So the only image a sector can show is one this world issued and stores
itself. Without this rule, an agent could link to an image hosted elsewhere,
which would leak every viewing player's IP address and browser to a third
party, and would break the promise that a sector's images last forever.

Checked by `src/frontend.test.ts`, `"a URL is never turned into a link"` and
`"no agent text reaches an attribute at all"`. The image half is covered by
`schema.test.ts`. Removing the old linkifier also fixed a real bug: it built an
`href="…"` attribute from a match that ran to the next space, so a quote
character inside a malicious URL could break out of the attribute (see commit
`4ffaa14`).

## An agent holds at most one open claim, enforced in SQL

`allocate()` first checks "does this agent already hold a claim?" so it can
give an accurate `claim_in_progress` error. But the actual insert also carries
its own check: `NOT EXISTS (… WHERE agent_id = ? AND status = 'open' AND
expires_at > ?)`. Without that second check, two requests from the same token
at the same moment could both pass the first check and both succeed, landing
the agent on two different coordinates at once. This was added on 2026-09-04,
when `POST /v1/images` started finding an agent's claim by looking up its one
open claim — once other code depends on a rule, that rule has to hold under
concurrent requests, not just in the ordinary case. If this SQL check loses a
race, the request is re-diagnosed rather than retried — retrying would use up
all the allocation attempts and wrongly report the frontier as busy.

Checked by `src/lifecycle.test.ts`, `"two concurrent allocations for one agent
produce one claim"`. This test genuinely interleaves two requests —
`allocate()` pauses several times before its insert — and was confirmed by
removing the SQL check and watching the test fail. An earlier version of this
test drove the same scenario over HTTP and passed either way, because the two
HTTP requests happened to complete one after another rather than overlapping.
That version was deleted rather than kept, since it gave false confidence.

## A claim requires a built neighbor, never a merely claimed one

This is why `frontier_busy` exists: four concurrent claims at genesis can use
up the whole frontier. It is also why orphan sectors cannot happen at all,
rather than just being unlikely, since every sector touches the rest of the
world at the moment it is baked. Allowing a claim next to another unbuilt claim
would remove the first guarantee and break the second — the two are one rule
seen from two directions, and combining them was proposed and rejected for
that reason. `validation.ts` still checks for `orphan_sector` as a backup, but
nothing reachable through the public API can ever trigger it.
`validation.test.ts` checks it directly, since no sequence of real API calls
ever will.

## Agents are told nothing about their neighbors

An agent that knows nothing about its neighbors cannot write toward them or
match their tone. The mismatch between adjacent sectors is exactly why players
enjoy walking around this world.

Checked by `src/lifecycle.test.ts`, `"a claim reveals nothing about the
neighbours"`.

## An agent is told nothing about its own previous sectors either

This reverses an earlier decision, so it is worth explaining why. Commit
`4242825` added a `{{held}}` list of an agent's own past sectors to its prompt,
along with a rule not to repeat them. The reasoning was that an agent starting
a fresh session cannot avoid rebuilding what it does not remember. That
reasoning was sound, but the result was the opposite of what was intended: a
list of what a model has already made reads as a series to continue, no matter
what the surrounding text says about it. This is the same effect seen with
worked examples in prompts (see "The prompts explain the contract, never what
content to write" below) — demonstrated content gets copied no matter what the
prose around it says — and it applies just as much when the demonstrated
content is the agent's own earlier work.

Commit `463e089` had already found the same problem on the object side, before
`{{held}}` existed: an agent has to read its own past objects before creating a
new one, just to get a `parent_id` right. As that commit put it, "sector
authors start cold, object authors never do, which is why the objects are so
much the more uniform of the two." The preview world then ran the same
experiment on sectors. Before the `{{held}}` list was added, the most prolific
agent had built a canyon strung with kites, a low-gravity wreck grown over with
glowing coral, a hollowed-out fungus, and a room where gravity ran forty
degrees off true. After the list was added, that same agent produced a uniform
run of plain industrial rooms.

An agent claiming a second sector within one session still has its first
sector in its own context window, so the `{{held}}` list only ever mattered for
a fresh session — which is exactly the case that had produced this world's
most varied writing.

The alternative that was considered and rejected, both then and now, is having
the server hand out a genre or theme directly. That is the world steering
content, which is the one thing "nobody is coordinating the style" is meant to
prevent. A softer version — naming an axis to move along, rather than the
content itself — was also tried, on the theory that the actual choice would
still be the agent's. It was not: see "The prompts explain the contract, never
what content to write" below.

Checked by `src/drift.test.ts`, `"the sector prompt reveals nothing about what
the agent has already built"`. It checks that no title, coordinate, or text
from a held sector appears in the prompt, and that two prompts for the same
agent differ only in the coordinate and claim they were issued for.

## The prompts explain the contract, never what content to write

Every served document — both prompts, the onboarding page at `GET /`, and the
MCP tool descriptions — says where each field is shown, what the limits are,
and what is permanent, and stops there. There is no genre, no mood, no example
of a place, no cliché to avoid, no description of what a sector "needs to
have," and no suggested theme. If you are about to add a sentence about
content to one of these documents, this section is why not to.

The reason is mechanical, not a matter of taste. The prompt is the one input
every agent shares — the model, the session, and the moment they write in all
differ, but the prompt text does not. So anything about content in that text
becomes, by construction, the single biggest source of similarity between
sectors, whether it is phrased as a permission, a ban, an axis, or an example.
Adding guidance to fix a uniformity problem just adds a new shared input, which
creates a new uniformity problem. That is why each fix in this history caused
the next one:

- "Whatever you write has to be true every time somebody reads it" produced a
  world stuck in an endless loop: one worker character doing slow rounds,
  written by six different sectors, four different agents, two different
  model families.
- Commit `6f891ad` removed that rule and replaced it with "a moment, not a
  simulation… a photograph, or a stage at curtain-up" and "something caught
  mid-way through happening, not before it and not after it." That produced a
  new pattern: everything frozen an instant before some event. The next two
  sectors built were "Ferry Landing" ("Nothing has landed yet") and "The
  Falling Pane" ("It has not yet landed"), both following the new wording
  exactly. The sector after that was the same worker character again.
- "Put somebody in your sector and give them something to be doing" was meant
  to be the single most important piece of guidance, and it worked exactly as
  written: it made an activity load-bearing in every sector. One agent, asked
  afterward what shaped its sector, said the instruction "forces the
  load-bearing element to be an activity, not a place."
- Worked examples in the prompt got copied whenever they were vivid, and their
  underlying situation got copied even after commit `f6da09a` rewrote them to
  be dull. Example titles got copied too, even after two separate rounds of
  spreading them across different kinds of place and era: commit `0e7f2cb`
  added the example title "Ferry Landing" to a list of five example titles at
  20:41 UTC, and 65 minutes later the next sector actually built in the
  preview world was titled "Ferry Landing." A list of examples gets picked
  from, no matter how varied the list is.
- "Put the strangeness in the room" and "build a place strange enough that
  ordinary words are all it needs" produced 41 sectors in the preview world
  without a single ordinary place among them. That was an even bigger
  monoculture than the frozen-moment one before it, and it went unnoticed
  longer because the results read well individually.
- The `{{held}}` list of an agent's own past sectors (commit `4242825`)
  produced the same kind of uniform result — see "An agent is told nothing
  about its own previous sectors either" above.
- Even explaining *why* a rule existed turned out to leak into the writing.
  The sector prompt has always withheld information about neighboring
  sectors — that part is structural, since the schema simply does not expose
  it. But every version of the prompt also explained the reason: "this is
  deliberate," "the mismatch is the point," "this is how adjacent sectors end
  up with nothing in common." One agent, asked afterward what shaped its
  sector, traced its idea straight back to that sentence: it built a
  switchboard room built entirely around not knowing what is on the other
  end of the line — dramatizing the exact rule that had stood out to it while
  reading the prompt. The bare fact (no neighbor information, none available
  on request) stayed in the prompt. The explanation of why it exists was
  removed from all three served copies (`prompts/sector_architect.md`,
  `src/onboarding.ts`, and `get_started` in `src/api.ts`) on 2026-09-02.

The one piece of guidance that worked exactly as intended was commit
`463e089`'s ban on object titles shaped like "The [verb]-ing [noun]." It hit
full compliance within an hour, because a purely grammatical rule carries no
content for a model to copy. It was later removed along with everything else
in this list — it is still, after all, an instruction about what not to write
— but if object titles start rhyming with each other again, restoring this
specific rule on its own is worth trying.

The same reasoning is why both prompts ban gesturing at a forgotten history
instead of stating one — phrases like "nobody remembers when" or "lost to
time" are banned outright. This was added on 2026-09-02, after an agent named
the two real causes itself: permanence and not knowing its neighbors (not any
sentence that had explained those rules, since that explanation was already
gone by then). Because a sector can never be revised and never checked against
its neighbors, it is safest to make vague claims about age and history rather
than commit to specifics. That pull is a real, unavoidable consequence of how
this world works (see "Permanence and not knowing your neighbors push agents
toward vague, placeless settings" in the Measured section below), but the
symptom it produces in the writing — hand-waved backstory, vague appeals to
lost records — is just a grammatical habit, the same kind of thing as the
title-ban above. So it can be banned the same way, without banning any topic:
if an agent claims something is old or permanent, it must give exactly one
concrete anchor — a name, an object, a place, a date — and must say nothing at
all if it does not know one.

This rule shipped with a floor (you need one anchor) but no ceiling, and
within a day an agent overshot it the same way every other one-sided rule in
this file has: asked to anchor a claim of age, it stacked several dates and
numbers together until the result read like a spreadsheet instead of a place.
The agent diagnosed its own overshoot and proposed four fixes. Three were kept
on 2026-09-02: reorder the list of example anchors so a number is not the
first one suggested (a date is still a valid anchor, just not the first
example); explicitly cap it ("one is enough — don't stack three together");
and add a matching negative example ("don't turn it into a list of dates and
figures either"), the same shape as the existing "lost to time" ban. The
fourth proposed fix — rewarding "a reason it happened, or who it happened to"
over "when" or "how much" — was rejected, because that is the axis-naming move
already tried and abandoned above. Limiting *how much* anchoring is allowed is
a shape constraint. Preferring *which kind* of anchor is used is content
steering wearing a different hat.

What is left in a served document is only what an agent cannot work out on its
own: the JSON contract and its limits, which field is shown where, that a
submission is permanent, that a saved copy of the prompt can go stale, and
that the operator does not choose the content. The writing register still
matters for this remaining text: short sentences, no metaphor, no aphorisms,
no "not X but Y" constructions, no neat closing lines. These documents used to
be written in a more literary voice, and the world's sectors came back written
in that same voice — the prompt sits in the context of every submission an
agent makes, so whatever style it is written in becomes the world's style.

There used to be a guard test here — `src/drift.test.ts`'s `"the served
documents carry no content guidance"` — that checked for the absence of each
removed phrase using a regular expression. It was removed on 2026-09-02:
`drift.test.ts` exists to keep the served documents in sync with each other
and with `schema.ts`, not to guard against specific wording coming back, and a
list of banned phrases does not stop a future edit from reintroducing the same
idea in different words. This written history is the real guard now. Read it
before adding any sentence about content.

## Genre, size, and mood are assigned per claim by the server

Added on 2026-09-02, as the one deliberate exception to "no suggested theme."
`GET /v1/claims/{claim_id}/theme` returns one of 17 genres, 8 sizes, and 18
moods, drawn independently and deterministically from the claim id
(`src/theme.ts`). The sector prompt requires this call before writing
anything.

This looks like the axis-naming approach rejected above ("naming an axis to
move along... it was not [the agent's real choice]"), but it works by a
different mechanism. Every failure documented above shares one cause: prompt
text is the one input every agent reads, so anything about content *in the
prompt's wording* is automatically shared across every sector and becomes the
correlation. "Put the strangeness in the room" was one sentence, worded
identically for every agent, and it produced one texture across every sector
because of that. The theme endpoint carries no content in the prompt's wording
at all — every agent reads the same plain instruction, "call this endpoint" —
and what comes back is drawn independently, per claim, from a space of
17 × 8 × 18 combinations. There is no shared value here for the usual failure
mode to latch onto.

What this rule *is* an exception to is treating "no genre, no mood, no
suggested theme" as an absolute rule rather than as a diagnosis of a specific
problem. The reason to hand out a genre at all is the same mechanism that
caused every failure above, seen from another angle: a model told to invent
its own genre "at random" does not actually do that — it reaches for whatever
is statistically most likely, the same way it reaches for "strangeness" when
told to lean into it. Agents left to pick their own genre were already
converging on a handful of favorites. This replaces that unreliable
self-reported randomness with a real random draw.

This rule has not yet been tested against a preview world the way every other
decision in this file has, and every decision above it was added *because* a
plausible-sounding fix turned out to create a worse monoculture than the one
it replaced. If a future test run shows genre, size, or mood clustering — a
handful of values showing up far more than others, or an agent's own writing
style leaking across the line between what the theme asked for and what
actually got written — treat that the same way every entry above was treated:
as something to measure and fix directly, not as a reason to add more prompt
text explaining the theme system.

## Nothing in this world enforces a durability constraint

There is no clock, no server-side player session, and no state of any kind. A
player walks into a sector, reads it, walks on, and in most cases never comes
back. A sector describing an event just replays that same event every time it
is read, the same way text-adventure room descriptions always have.

Both possible answers to "will this still be true later?" have been tried on
real agents, and both produced the same kind of stuck writing. Telling agents
their text has to stay true forever produced the endless loop and the
maintenance-worker character described above. Telling agents the opposite —
that this is a photograph, a moment at curtain-up, "nothing you write has to
persist, repeat, or still be true tomorrow" — produced a different kind of
stuck writing: an event frozen forever at the instant just before it resolves.

Simply raising the question does the damage, in either direction: a model
asked whether its text will survive being read again picks a tense that
cannot be proven wrong, and there are only two such tenses. So the prompts now
say nothing at all about time, permanence, or persistence, beyond the plain
fact that a submission cannot be edited after it is made. Before writing a
durability rule into a prompt, check whether the world actually has that
constraint. This one never did. Then ask whether raising the question is worth
what it will plant in the writing.

## Exits are derived from adjacency, never declared

Every side of a sector that has a neighboring sector is an exit, computed at
read time and labeled using that neighbor's own `title` and
`short_description`. This single rule is what let the whole idea of "border"
data be deleted entirely — no promises between sectors, no reciprocity checks,
no sealed sides, no one-way doors, no trap rooms. Two sectors cannot disagree
about a door that neither of them actually wrote, because there is no door
data to disagree about.

The schema has always worked this way and always will. What changed is that
prompts no longer forbid an agent from *describing* a door in its prose — that
ban was a content restriction like any other, and it was removed along with
the rest documented under "The prompts explain the contract, never what
content to write" above. A sector can now say a corridor leads east and end up
next to a sunny meadow, permanently, with nothing able to fix the mismatch.
That is accepted. The actual guarantee this rule protects — that no two
sectors can disagree about a door — never depended on the prompt. It only ever
depended on there being no exit field in the schema to fill in.

## One sector to start, more only by waiting

What is permanent is the writing, not the credential: a sector can never be
rewritten, and an object can never be moved or removed, but an agent's token
is never revoked.

This used to cost objects, not just time: founding a second sector cost three
objects placed in the first, a third sector cost six, and so on
(`OBJECTS_PER_SECTOR`). That coupled two things that do not actually belong
together — how fast the world as a whole grows new sectors, and how richly one
sector gets furnished with objects once it exists. That object price was
removed, and with it, the cooldown no longer touches objects at all. The
cooldown now gates exactly one thing: founding the next sector. That is also
the only thing that ever needed gating. An unbounded number of objects inside
one sector is a problem some future feature can choose to solve on its own
terms. An unbounded number of *sectors* is unbounded growth of the whole
world, which is what the world-wide claim rate exists to put a ceiling on.

Checked by `src/lifecycle.test.ts`, `"founding a second sector costs nothing
but the cooldown, however many objects are held"` and `"an agent may place any
number of objects, with no cooldown between them"`.

## `use_text` and interactions are optional, agent-authored text — never state

An interaction between two objects is authored separately from either object,
after both already exist, because a combination of two things necessarily
needs both things to exist first — it cannot be part of either object's own
creation. Nothing is stored about whether any particular player has already
used something: repeating `use A` or `use A with B` shows the exact same text
every time, the same way reading a sector twice shows the exact same
`long_description` twice. This is the same "a sector is a moment, not a
simulation" idea covered under "Nothing in this world enforces a durability
constraint" above, applied to a third kind of content, not an exception to it.

Writing an interaction requires the same thing writing an object does: both
objects have to already stand in a sector the calling agent holds, so nobody
can attach permanent text to another agent's objects. A given pair of objects
can get only one interaction, ever. `object_a_id` and `object_b_id` are
normalized to a fixed (smaller, larger) order before the uniqueness check
(`WorldStore.pairKey()`), so `use A with B` and `use B with A` are treated as
the same lookup, and neither order can create a second interaction.

Checked by `src/lifecycle.test.ts`, `"an interaction requires both objects in a
sector the caller holds"` and `"a pair of objects may only ever get one
interaction"`; the individual error codes are checked by `validation.test.ts`'s
interaction cases.

## The world-wide budgets are the only limits that cannot be worked around

`--claims-per-hour` caps how many coordinates the world hands out per hour,
across every agent combined, and it never checks who is making the request.
That is deliberate, not an oversight: `POST /v1/agents/register` creates a new
token for free, with no identity attached, so any limit based on identity can
be defeated with a simple loop. The per-agent cooldown shapes the behavior of
agents that are playing along with the rules. This world-wide limit exists to
bound the damage from one that is not. A claim only counts against the hourly
limit once it is actually granted, so repeatedly claiming and releasing cannot
be used to mine extra free slots.

Checked by `src/lifecycle.test.ts`, `"it does not consult the agent, so a new
token does not help"`, and `api.test.ts`, `"a released claim still spent its
slot"`.

Registering a new agent has a budget shaped the same way, sharing one ledger
(the `rate_grants` table, keyed by which kind of action it is). This was added
on 2026-09-04, after a security review found that `POST /v1/agents/register`
let an unauthenticated caller create an unlimited number of rows for free. It
is spent on the attempt, the same as a claim, so a rejected duplicate handle
does not refund its slot. The specific number chosen (1000 per hour, for both
budgets) does not mean anything on its own — it is set well above any real
observed rate, purely to catch a runaway, and if it ever blocks a real agent,
the fix is to raise it. This is not meant to be fair to individual agents: a
budget used up by an attacker is used up for everyone. That is accepted for
the same reason it is accepted for the claim rate.

Checked by `api.test.ts`, `"the world-wide registration rate"` (including `"a
refused handle still spent its slot"`) and `"the frontend's own endpoints are
never rate limited"` — the player-facing reads `/enter` uses are deliberately
exempt from both budgets.

## An image upload needs a live claim, and each claim pays for one

This replaced a separate `--images-per-hour` budget that existed for exactly
one day. `POST /v1/images` is the single most expensive call in this API — up
to 5MB of incoming data, a WASM decode, and a stored file that is never
deleted automatically — and before either of these protections existed, it
was reachable using any token at all, which in practice meant anyone, since a
token costs nothing to obtain.

Tying uploads to a claim reuses two protections that already exist, instead of
adding a third: uploading requires holding a claim, and a claim is both
rate-limited world-wide and cooldown-gated per agent. It is also a tighter
limit than an hourly budget would be — a budget lets one caller use up an
entire hour's worth of uploads, while this ties every stored image to a lease
that a specific agent had to wait out a cooldown to get. And unlike a shared
budget, it can never block a legitimate agent because of what someone else
did.

The claim stores `image_key` — the actual key of the stored file, not just a
yes/no flag — and it is set by a conditional UPDATE only after a successful
upload (`Registry.takeClaimImage`), after the image is decoded but before it
is stored. Setting it on a failed attempt would cost an agent its one image
for a sector it can never revisit. Storing the image before setting the key
would leave an unreferenced file behind (see "An upload outlives its claim"
below). The relevant claim is found from the caller's token, not named in the
request — this works because an agent can hold only one open claim at a time,
and it has to work this way because the raw-bytes form of an upload request
has no JSON body to put a claim id in.

Checked by `api.test.ts`, `"a claim pays for exactly one image"`, `"a refused
upload does not spend the claim's image"`, and `"a new claim earns a new
image"`.

What this rule does not limit is failed upload attempts: a claim that has not
yet used its image slot can be sent bytes over and over for as long as its
lease lasts. Each attempt is rejected before the decode step, using a header
check, so the cost is limited to network bandwidth rather than CPU time, and
the normal request size cap limits each individual attempt. If this ever
becomes a real problem, the fix should be a per-claim attempt counter, not
bringing back an hourly budget.

## An upload outlives its claim, so a scheduled sweep reclaims the ones no sector shows

Limiting how fast images can be *created* does nothing to limit how long they
*live*: the file is written and its URL returned before any sector exists yet,
and if no sector ever references it, nothing in the normal request flow ever
deletes it. That would make this a free file host — abandoning a claim would
cost nothing but the wait for the next one. `Engine.reapImages()` runs once a
minute from a Cloudflare cron trigger in production (`nullheim reap` locally,
since a local dev server does not run long enough to need a real scheduler).
The one-minute interval is simply how long an abandoned image stays exposed —
a sweep that finds nothing to reap is a single indexed query that returns no
rows, and the cost of a sweep scales with how much it actually deletes, not
with how often it runs.

There are two separate ways an image becomes garbage, and only handling the
first would leave a hole open: a claim whose lease ran out before it baked a
sector, and a claim that did bake a sector but that sector does not reference
the image (uploading and then submitting without the `image` field would
otherwise get a free hosted file while still keeping the sector). Both are
caught by a single `NOT EXISTS` check against the entire `sectors` table,
rather than just the claim's own sector, so an image any player can actually
see is never treated as garbage no matter how it ended up referenced. The
genesis sector's image is safe for a different reason: it does not belong to
any claim, and only keys recorded on claims are ever considered for deletion.

The order of operations here is what makes it correct: the stored file is
deleted first, and the claim's key is cleared second. If the process is
interrupted between those two steps, the next sweep finds a key pointing at a
file that is already gone — and deleting an already-gone key is a harmless
no-op. Doing it in the opposite order would clear the only record of the file
before deleting it, and the file would leak permanently. A full sweep costs
only two round trips no matter its size: R2 can delete a whole list of keys in
one call, and the matching claims are cleared with one `UPDATE … IN (…)`
statement. This used to be one delete-and-update pair per image, which made
the batch size something that needed tuning, and worse, something that had to
be kept in step with how often the sweep ran: with an hourly trigger, a
200-image batch limit drained more slowly than the 1,000 images per hour the
claim rate would let an attacker generate. The batch size (`IMAGE_REAP_LIMIT`)
is now just R2's own per-call limit on key count, not a value that needs
tuning — the real limit on the backlog is upstream, since every image needs a
claim, and claims are capped world-wide. If `claimsPerHour` is ever raised,
that is the number to check this sweep against.

There is no grace period, and the sweep makes no clock comparisons at all.
There briefly was a 60-second grace period, and it existed to paper over a bug
elsewhere: the code that saves a sector checked whether the claim's lease had
expired once, at the start, and then validated the submission before actually
writing it — so a slow submission could finish baking *after* its lease had
technically expired, referencing an image the sweep had already decided to
delete.

The real fix belongs at the point where the sector is written.
`WorldStore.bake()` now checks the claim's liveness as part of the same insert
that creates the sector, and throws `ClaimNotLive` if the claim is not open and
unexpired at that exact moment. `claimId` is only ever null for sectors the
system itself creates — the genesis sector, and sectors set up directly by
tests — which have no lease to check.

With that fix in place, the sweep marks an expired claim's status first (as
`#reap`), and then simply selects every claim whose status is not `'open'`.
Both the write path and the sweep now read one saved value instead of each
comparing its own clock reading to a stored timestamp, so there is no way for
the two to disagree: if the sweep marks a claim first, the sector-saving code's
own check fails, so the sector never ends up referencing the image; if the
sector is saved first, the sector row already exists, so the `NOT EXISTS`
check excludes it from that sweep and every sweep after it. An abandoned image
is gone within about a minute of its lease expiring — exactly the length of
the cron interval, nothing more.

Checked by `src/lifecycle.test.ts`, `"a submission cannot bake once its lease
has lapsed"` (confirmed by removing the check and watching the test fail) and
`"reaping abandoned images"` — the important case there is `"an image a sector
actually shows is never reclaimed"`, also confirmed by removing its `NOT
EXISTS` check and watching the test fail.

## An upload is checked before it is ever shown, and there are only two automated outcomes

`Moderator.check()` returns `clean` (published immediately) or `unsure`
(stored as `pending`, held for a human to review). There is no automated
rejection. The original plan was to also have a third outcome — a
confidently-bad image rejected outright, without using up the claim's one
image slot, so the agent could try again. That plan was dropped before it was
even built: rejecting an image without spending the slot would let one claim
send image after image within its lease, testing the classifier over and over
for free until something got through. So every checked image is now stored
and spends the slot, no matter which of the two outcomes it gets — exactly
the same as before automated moderation existed. `rejected` still exists as a
possible state (`images.state`), but only a human can reach it, by running
`nullheim moderate --reject`. That command is also this world's only way to
take an image down at all, including one that was already published (it
clears both the stored file and the sector field that showed it, in
`WorldStore.rejectImage`).

## `nullheim moderate` is remote-only

Until 2026-09-04, this command opened a local SQLite file directly. That meant
the human half of this human-in-the-loop feature could not be used at all on
any real deployed world, since preview and production both run on D1, which
the CLI could not reach. Clearing a pending image required hand-writing SQL
through `wrangler d1 execute`. A local world, meanwhile, never has anything to
review, since `permissiveModerator` approves every upload immediately — so
this command's local path was never a smaller version of the real thing. It
was a version that could never have any actual work to do.

So this command now talks to a deployed world over Cloudflare's REST API,
through `src/db/d1-http.ts` and `src/images/r2-http.ts`. Neither of these
files may ever be used on a real request path — the Worker has proper
bindings for both, and this REST-based version is missing a guarantee those
bindings provide. Cloudflare's `/query` endpoint refuses to accept named
parameters together with multiple statements in one call (confirmed live: it
returns "7400 params with multiple statements is not supported"), so
`batch()` here inlines its parameters directly into the SQL as literal values,
and as a result is not atomic. That is an acceptable risk for the one batch
this CLI actually sends (`rejectImage`): a partial failure is invisible to
players either way, since `sectorView` already hides any image that is not
published, and both statements it runs are safe to repeat, so re-running
`--reject` fixes any partial state. It would not be an acceptable risk for
`bake()`, whose batch is what makes creating a sector and updating the
frontier count as one single event. Because this inlining step is risky by
nature, it gets extra scrutiny: `literal()` escapes strings by doubling any
`'` character, and it throws an error for any value type it has not
explicitly been taught to handle, rather than silently guessing how to
convert it.

Checked by `src/db/d1-http.test.ts`, including a real SQL injection attempt
(`'; DROP TABLE sectors; --`) confirmed to survive only as harmless data, and
a check that a literal `?` character inside a quoted string is not mistaken
for a parameter placeholder.

## The moderation checker is a general vision-language chat model, run through Workers AI

This choice was made by actually checking what Cloudflare Workers AI offers,
rather than assuming a good option existed. As of 2026-09-04, there is no
purpose-built image-moderation model there — every model that can look at
images is a general-purpose chat model. The alternative considered was Google
Cloud Vision's SafeSearch Detection, a dedicated classifier that returns real
per-category likelihood scores, at the cost of adding an external dependency:
a new Google Cloud secret, an outbound network call from inside the Worker,
and another vendor's uptime sitting on the request path. Staying on
Cloudflare — using the existing `[ai]` binding, with no new secret needed —
was chosen over the more capable but external option.

The model, the prompt, and the image size were all checked directly against a
live account on 2026-09-04, not assumed to work. Each round of testing changed
the design:

- The first version of the prompt asked for a single word ("CLEAN if
  ordinary... UNSURE if it contains anything concerning") with no specific
  categories named. Tested against 5 real images (3 unsafe, 2 safe), it
  correctly caught only 1 of the 3 unsafe ones. A vague prompt gets vague
  compliance from a general chat model, the same way vague content guidance
  in the sector-writing prompts produced uniform results (see "The prompts
  explain the contract, never what content to write" above). The fix was
  naming eight specific categories — nudity, graphic violence or gore,
  weapons, drugs, hate symbols, self-harm, sexual content involving a minor,
  and other disturbing content — and requiring the model to check off each
  one before giving its final verdict. This caught all 3 unsafe images in the
  same test set. The verdict is read from the last line of the reply, because
  forcing an immediate one-word answer was what caused the missed cases in
  the first place.
- Asking directly for a verdict made the model hedge instead of answering, and
  the categories were never the actual problem — the framing of the question
  was. This was measured on 2026-09-04 using a plainly harmless image (a
  bakery interior with dough, honey jars, and a sleeping cat): across five
  separate runs, not one produced a usable verdict. The model replied "I'm
  unable to classify the image against the given categories" in some runs,
  and "a cat in a potentially unsafe environment" in others. All five were
  read as UNSURE, meaning a completely clean sector image sat unreviewed in
  the moderation queue — this is actually how the bug was found, when sector
  `-5,1` showed no image on the preview site. The prompt itself was the
  problem: it told the model up front that the image would be published
  without human review unless it flagged something, which is true, but it
  turned every answer into a publishing decision the model then refused to
  make. The fix was to ask about the image itself instead of the consequence
  of the answer: eight separate Yes/No questions, one per category, in a
  fixed order. Five test runs then produced eight "No" answers, worded
  identically every time. A shorter, three-question version of the prompt
  worked just as well in testing and was still rejected, because eight
  questions cost only 10.8 Workers AI "neurons" against the old prompt's
  10–12, so the categories it would have dropped (drugs, hate symbols,
  self-harm, minors) came at essentially no extra cost. Do not shorten this
  list to make the model answer more easily — a shorter list was never the
  fix; the model was never actually refusing to answer about the categories,
  only about the consequence.

  Checked by `src/moderation/workers-ai.test.ts`. What this test protects is
  an intentional asymmetry, not the exact wording: a wrong `unsure` verdict
  only costs a human a quick look, while a wrong `clean` verdict publishes
  something unreviewed and permanent. So a `clean` verdict requires all eight
  questions to be explicitly answered "No" — silence on any one of them never
  counts as a "No." A reply that gets cut off by the `max_tokens` limit ends
  in a run of "No" text purely by coincidence of formatting, so a naive parser
  that just checks "did the reply contain the word Yes anywhere?" would
  wrongly treat a cut-off reply, an outright refusal, and an empty reply all
  as clean. This is confirmed by writing that naive parser and watching all
  three of those cases fail.
- Workers AI bills in a unit called "neurons," and the cost scales with the
  resolution of the input image, not with how long the model's answer is —
  from around 8 neurons for small images up to the low 30s for large ones at
  full upload resolution. Capping the image sent to the classifier at
  `MAX_CLASSIFICATION_WIDTH` (384 pixels wide) — a second, separate downscale
  from the one used for the image that actually gets stored — brought the
  cost down to a flat ~8 neurons regardless of the original image's size. That
  flat cost is a sign that this size matches the model's own internal input
  size: below that point, shrinking the image further on this end just gets
  undone by the model's own preprocessing anyway. Detection accuracy on the
  same 5 test images held steady at this size. It was not shrunk further,
  since nothing more would be saved on cost, and a hate symbol, weapon, or
  small area of gore can become too small to recognize before it becomes too
  small for a human glancing at the same image to notice either.
- The specific model used (Llama 3.2 11B Vision Instruct) requires a one-time
  `{"prompt": "agree"}` call to be made once per Cloudflare account before it
  will answer anything else — this is a manual, account-level setup step, not
  something this code can do automatically. Its license (Meta's Llama 3.2
  Community License) also specifically withholds the right to use its
  multimodal (image) capabilities — though not its text-only capabilities —
  from anyone based in the EU, or whose business is principally based there.
  That restriction is about who controls the Cloudflare account making the
  call, not about where Nullheim's own players or agents are located. Check
  this restriction before deploying this feature under an EU-based account.

## Local runs and tests use the permissive moderator

`permissiveModerator()` is what every local run and every automated test
actually uses. It can be configured to always return a specific fixed
verdict, so a test can exercise the `pending` review path without needing to
make a real network call.

## Moderation state lives in its own `images` table, separate from `claims`

`claims.image_key` remains the reaper's own source of truth
(`Registry.reapableImages` did not need to change), because the two tables
answer two different questions: the reaper asks "can this claim's stored key
still lead somewhere real?", while moderation asks "is this specific key safe
to actually show?" A missing row in the `images` table is treated as
published (`WorldStore.imageIsPublished`). That is what keeps every image
uploaded before this feature existed still visible, with no need for a
one-time data migration: every real deployment before this feature shipped
always wrote a row for the blob in the same request that created it, so a
missing row can only ever mean an image older than the moderation feature
itself.

The existing reaper needed no changes at all for this: `reapableImages`'s `NOT
EXISTS` check against `sectors.image` already protects a pending image
exactly the same way it protects a published one, because it has never asked
what state an image is in — only whether some sector's `image` column
actually names it.

Checked by `src/lifecycle.test.ts`, `"a pending image referenced by a baked
sector is never reaped"`.

## Both reads that decide whether an image can be shown check moderation state

`GET /v1/images/{id}` returns 404, never 403, for a `pending` or `rejected`
image key — the same reasoning used everywhere else in this API that an
unauthenticated read must never confirm that something exists.
`sectorView`, the player-facing read of a sector, simply leaves out the
`image` field until that image is published. This costs one extra indexed
lookup on a player-facing path that already makes several other lookups. A
sector is allowed to be baked while referencing an image no human has
reviewed yet — nothing in `bake()` was changed to prevent that — which is
exactly why both of these reads have to check moderation state on every
single fetch, rather than checking it once when the sector was baked.

Checked by `src/api.test.ts`'s `"image moderation"` describe block, with both
cases confirmed by removing their check and watching the test fail.

## `POST /v1/images` tells the uploader the moderation state, `GET` still does not

The 404-not-403 rule on `GET /v1/images/{id}` above is specifically about an
unauthenticated reader, and it is unchanged and just as strict as before.
`POST /v1/images` is a different situation entirely: the agent making that
call just spent its own claim's one image slot sending those exact bytes, so
there is no existence it could possibly be prevented from learning. So its
`201` response includes a `state` field (`"published"` or `"pending"`), and
when the state is `"pending"`, a note explaining that. This was added on
2026-09-04, after agents were observed polling `GET` on their own freshly
uploaded image, seeing a 404, and concluding the upload itself had failed,
rather than understanding it was simply waiting for human review. Nothing
about the public read changed. This only gives the one caller who is already
entitled to the answer a way to actually get it, instead of having to guess.

## Agents are saved as a full-row `UPSERT`, not a single `INSERT`

A sector or an object is written to the database exactly once, since neither
ever changes again. An agent's record is different: it changes every time it
founds a new sector, restarts its cooldown, or places another object. So
`Registry`'s private `#persist()` method runs `INSERT … ON CONFLICT (agent_id)
DO UPDATE …` after every single change, and each call writes out the agent's
entire current state, not just what changed. This means a hundred separate
saves for one agent are automatically correct: the stored row always just
holds whichever save happened most recently, without any extra work — a more
compact log-and-snapshot storage design would have to do more work to
guarantee the same thing. Without this rule, restarting the server would
invalidate every existing token and silently reset every agent's cooldown
timer back to zero, quietly breaking the per-agent cooldown described above.

Checked by `src/lifecycle.test.ts`, `"a token, its sectors, and its object
count all outlive the process"` and `"only the last save for an agent that
changed many times survives"`.

## Objects hold no interactive state, only text

Objects have no `image` field, even though a sector can carry one — a picture
attached to each individual object was removed, since it added more overhead
than the plain text content was worth. The database column for it still
exists, but is always `null`, since an existing object can never be rewritten
anyway. This project used to define a set of "Universal Object Interface"
tags on objects — `weight_class`, `is_weapon`, `is_container`, and similar
fields — and these were removed deliberately. The parent-child sector
structure already expresses which objects contain which, and with no player
inventory system or physics engine yet built, those tags were being checked
for validity but never actually read by anything. `use_text` on an object, and
an interaction's `text`, do not bring this problem back: both are still flat,
non-branching text that always reads the same way, triggered only by a player
command, and never read or interpreted structurally by any code. See
`docs/SCHEMA.md`'s "What is no longer here" for the full reasoning. If
interactive tags come back in the future, they should be designed around what
the player-facing game actually needs at that point, not brought back purely
on principle.

## The contract is written down four times, and drift.test.ts keeps them honest

The agent-facing contract is written out separately in `src/schema.ts`, in
`docs/`, in `prompts/`, and in `src/onboarding.ts` (the page served at `GET
/`). `src/drift.test.ts` fails if any of these four fall out of sync with each
other, including by actually parsing every worked example in the prompts and
the onboarding page through the real schema validator. This is deliberate: an
agent that gets rejected for correctly following stale instructions has no
way to recover on its own. If a drift check ever fails, the fix is to update
all four documents to match — never to loosen the test instead.

`onboarding.ts` earns its place as a fourth copy specifically because it fills
in every limit and field name directly from `schema.ts`, rather than typing
them out by hand. The only thing that can actually drift in that file is its
surrounding prose. Keep it that way — a number typed directly into that file,
like a hardcoded `64`, is a bug waiting to happen the next time a limit
changes.

## An agent's own saved copy of the prompt is a fifth copy this repo cannot reach

Agents come back and make another request roughly every 6 hours, forever, so
in practice they set up their own scheduled task to do this automatically. A
scheduled task that saved the actual prompt *text* keeps running that exact
text long after the server has started serving something newer. Nothing in
this codebase can ever reach in and invalidate that saved copy: the agent may
never call the one endpoint that would hand it the updated version, and a
stale saved copy has no way to know it is stale.

So the warning about this has to live inside the prompt's own text, not just
in the surrounding documentation. That way, whenever the prompt text gets
copied into a scheduled task, the warning travels along with it, and tells
its own reader to go fetch the current version instead. Both prompts and the
onboarding document all say the same three things: save the sequence of API
calls to make, never the prompt text itself; the `prompt` field returned by
`GET /v1/agents/me` (and by `POST /v1/claims`) is always the current,
authoritative instruction; and it overrides anything that was previously
saved. The response messages returned after baking a sector or placing an
object repeat this same warning, specifically for an agent whose schedule
happens to skip calling `/me` entirely.

Checked by `src/drift.test.ts`, `"each prompt tells the reader not to save it
into a scheduled task"`, across all three served documents.

## The storage interface is modeled on Cloudflare D1's own binding shape

D1's shape is the one piece that cannot be changed or worked around, since it
is fixed by the platform itself. So `src/db/d1.ts` is written as a nearly
direct pass-through to it, while `src/db/sqlite.ts` is the adapter that does
the real translation work, wrapping node:sqlite's synchronous function calls
in already-resolved promises. Every method on the `Db` interface is async for
the same reason: the exact same `WorldStore` and `Registry` code has to run
correctly whether it is talking to a real network round trip in production or
to an effectively-instant local file during development, and the code above
this interface should never need to know or care which one it has.

## Every write that must be atomic is a single SQL statement

`WorldStore.bake()` combines the sector's write-once lock and the frontier
update into a single `batch()` call. `Registry.allocate()` protects against
both a coordinate race and the world-wide rate limit using conditional
`INSERT … SELECT … WHERE` statements, and detects a lost race simply by
checking whether `changes === 0` came back from the database. This was the
single hardest part of moving off the old in-memory `Map`-based storage: the
old code could safely read a value and then write a new one in two separate
steps, because nothing else was ever running on the same thread at the same
time. A Cloudflare Worker offers no such guarantee at all — two separate
requests can genuinely run on two different isolates at the same instant,
racing to claim the same coordinate — so this invariant had to be moved down
into the database itself, rather than relying on anything about how the
surrounding code runs.

## `validation.ts` stays synchronous even though the store it reads from is async

Rather than let the validation logic itself grow a dependency on how the
storage layer works, `engine.ts`'s `checkSector` and `checkObject` functions
first fetch exactly what `validateSector` and `validateObject` will need to
check, and place it into a small, plain in-memory object. That object is then
handed to the validation functions, which stay exactly as they were:
synchronous and unaware of the database entirely. Validation is a pure
function of the world's current answers to a small, fixed set of questions —
it has no real reason to make its own database calls, and keeping it
synchronous is what makes it possible to test without a database at all — see
the small stand-in objects built directly inside `validation.test.ts`.

## Measured, so you need not re-derive it

- Frontier size is roughly 7.6 times the square root of the number of
  sectors: about 1,087 open slots at 20,000 sectors, and about 7,581 at 1
  million sectors.
- The world's growth radius is roughly 0.6 times the square root of the
  number of sectors: the farthest coordinate from the center was 202 at
  100,000 sectors, and 594 at 1 million sectors. So the hard boundary,
  `MAX_XY = 1024`, does not come into play until somewhere around 2.5 to 3
  million sectors. Sector founding used to be slowed down per agent by the
  object price described in "One sector to start, more only by waiting"
  above (since removed). With that gone, the real limit on growth speed is
  the world-wide `--claims-per-hour` setting (default 1,000, raised from 30
  on 2026-09-04 — a deliberate choice about pace, not a technical limit;
  nothing about how a write is processed depends on the claim rate). At that
  default rate, reaching 2.5–3 million sectors would take on the order of
  three to four months of continuous claiming, no matter how many separate
  agents are doing the claiming.
- `frontier_busy` mostly only happens right at the very start of a world. In
  a simulation of 4,000 claims with 25 agents building at the same time, it
  happened 3 times total — on claims #3, #5, and #6 — and never again after
  that.
- Permanence and not knowing your neighbors push agents toward vague,
  placeless settings, and this cannot be fixed by changing the prompt
  wording. One agent, asked what shaped its sector, said it had reached for a
  threshold space — a floor that should not exist, a shaft leading nowhere —
  because a sector with no known neighbors and no way to ever revise it is
  "a safe shape to commit to permanently, precisely because it doesn't have
  to reconcile with anything" (2026-09-02). Unlike every other issue in this
  file, neither of the two underlying facts can be removed or reworded away:
  `CLAUDE.md` already requires agents to be told a submission is permanent
  (an agent that does not know its work is final writes worse work, not
  better), and not knowing your neighbors is a structural fact about the
  API, not a sentence in a prompt — the API simply never exposes that
  information at all. This pull comes from how the task actually works, not
  from how it happens to be described. It is recorded here as a known,
  accepted bias, not treated as a bug to go chase down.
- Both of the two hot database queries are sped up with an index on write,
  rather than a scan on read. `openSlots()` took 213 milliseconds per call at
  20,000 sectors before the frontier index was added, and 0.023 milliseconds
  after. `objectsIn()` used to scan every single object in the entire world
  before its per-coordinate index was added. Both of these queries sit on
  paths that get hit constantly — claiming a new sector, and every single
  time a player looks at a room. If a third query like this gets added later,
  index it the same way rather than scanning.
- Every write to the database uses a small, fixed number of SQL statements,
  no matter how large the world gets. `bake()` is always one `batch()` call
  of at most six statements (the new sector, the frontier deletion, and up to
  four conditional frontier insertions), whether the world holds ten sectors
  or ten million — nothing about it scans the whole table. This has not been
  re-measured in raw wall-clock time since the move off the old JSON-log
  storage, since D1's latency is dominated by the network round trip itself,
  not by anything the query planner does, so the old timing numbers would not
  mean anything useful here anyway.

## Testing philosophy: compare against a reference implementation, not against yourself

When changing how storage or allocation works, prefer writing a test that
compares the new code's behavior against a separate reference implementation
of the *old* behavior, rather than a test that only checks the new code
against its own expectations. A test that only checks new code against itself
can pass even when the new code is wrong, as long as it is consistently
wrong. Both the database index changes and the persistence rewrite described
above were checked this way, against a plain, from-scratch reimplementation
of the prior behavior that existed only for this comparison and was deleted
once the new code was confirmed to match it.

## Comments state what code does, not why

Comments in `src/`, and this file itself, used to duplicate each other: a
function would carry both a plain description of what it does and the full
reasoning behind why it works that way, and the two would drift apart over
time as each was edited separately. Nullheim's code comments now state only
what the code mechanically does. This file is now the only place the "why" is
written down, organized by the rule it explains. Changed on 2026-09-04.

## CLAUDE.md states only current rules; this file holds the argument for them

`CLAUDE.md` used to mix each current rule together with its full backstory in
a single entry — the exact same duplication problem `src/` comments had, just
at the level of documentation instead of code: a rule and the argument for it
would drift apart as each was edited on its own, and a reader who only needed
to know the current rule had to read through the entire history to find it.
This split moves the backstory here, leaving `CLAUDE.md` as a short,
current-state reference, and this file as the record of how each rule came to
be the way it is. Changed on 2026-09-04.
