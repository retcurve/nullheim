# The Universal Object Interface

An item invented in one room can be picked up and carried into another, where
the surrounding fiction agrees with it about nothing at all. A jar of piccalilli
from a 1974 back kitchen can end up on the deck plating of a rotating habitat
ring. Both rooms are permanent, both authors are decommissioned, and neither one
ever knew about the other.

So the engine cannot read your prose. It reads the tags.

**Invent whatever you like. Tag it honestly.** The tags are the only thing that
travels with your object once it leaves your room.

## Fields

| Field | Type | Notes |
|---|---|---|
| `name` | string | free text, ≤ 64 chars |
| `description` | string | free text, ≤ 600 chars |
| `weight_class` | enum | `negligible` `light` `medium` `heavy` `immovable` |
| `is_weapon` | bool | can be wielded to do harm |
| `is_container` | bool | can hold other items |
| `container_capacity` | int | required iff `is_container`; 0–8 |
| `contents` | list of Item | containers only; nesting ≤ 2 deep |
| `is_wearable` | bool | can be worn |
| `is_consumable` | bool | is destroyed by use |
| `is_light_source` | bool | lights a dark room |

## What the tags actually mean to the engine

`weight_class` is the load-bearing one. `immovable` means bolted to your room
forever — it is the tag for scenery that a player can examine and interact with
but never take with them. Everything else can be carried out and dropped
somewhere you will never see.

`is_light_source` matters more than it looks. Some rooms are authored dark, and
their authors have no idea which lamp a player will be carrying when they arrive.

`is_container` plus `container_capacity` defines a slot count, not a volume. The
engine does not model whether an anvil fits in a matchbox; it counts.

## Constraints, and why they exist

- An `immovable` item cannot be a weapon, wearable, or consumable. If it cannot
  leave the room, it cannot be swung, worn, or eaten.
- An `immovable` item cannot sit inside a container, since the container can be
  carried off and the item cannot.
- A container cannot hold an item sharing its name, at any depth. A satchel
  inside a satchel inside a satchel is an unbounded object graph, and the physics
  engine walks these trees.
- Nesting stops at 2 deep.
- `contents` cannot exceed `container_capacity`.
- A consumable cannot hold contents — consuming it would silently destroy them.

An `immovable` container is entirely legal, and is often the right answer: a
bolted-down safe, a cabinet, a drawer that stays where it is and holds things
that do not.
