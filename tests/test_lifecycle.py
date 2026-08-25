"""Claims, the frontier, the static lock, and the eight-hour contribution clock."""

import random
import time
import unittest

from helpers import build, codes, make_engine, obj, sector, settle

from mosaic.coords import ORIGIN, Coordinate
from mosaic.registry import ClaimStatus, NoSector, NotYet, Registry, SectorUnavailable
from mosaic.store import InMemoryWorldStore


class FrontierTests(unittest.TestCase):
    def test_the_world_seeds_itself_with_one_sector(self):
        engine = make_engine()
        self.assertEqual(engine.store.count(), 1)
        self.assertIsNotNone(engine.store.get(ORIGIN))

    def test_the_frontier_is_every_side_of_every_sector(self):
        """Any side can take a neighbour — there are no sealed edges."""
        engine = make_engine()
        self.assertEqual(
            set(engine.registry.frontier()),
            {ORIGIN.step(direction) for direction, _ in ORIGIN.neighbours()},
        )

    def test_the_frontier_grows_as_the_world_does(self):
        engine = make_engine()
        build(engine, (0, 1))
        self.assertIn(Coordinate(0, 2), engine.registry.frontier())
        self.assertIn(Coordinate(1, 1), engine.registry.frontier())
        self.assertNotIn(ORIGIN, engine.registry.frontier())

    def test_allocation_never_hands_out_the_same_sector_twice(self):
        engine = make_engine()
        seen = set()
        for index in range(4):
            agent, _ = engine.register(f"a{index}")
            claim = engine.claim(agent)
            self.assertNotIn(claim.coordinate, seen)
            seen.add(claim.coordinate)

    def test_running_out_of_frontier_is_a_clean_refusal(self):
        engine = make_engine()
        for index in range(4):
            agent, _ = engine.register(f"a{index}")
            engine.claim(agent)
        agent, _ = engine.register("one-too-many")
        with self.assertRaises(SectorUnavailable):
            engine.claim(agent)

    def test_allocation_does_not_prefer_well_connected_slots(self):
        """A pocket is worth no more than the end of a limb.

        The world is meant to sprawl organically, corridors included, so the
        only rule is adjacency. This asserts the absence of the old
        fill-the-pockets heuristic.
        """
        # An L: [1,1] touches two sectors, [3,0] touches one.
        pocket = Coordinate(1, 1)
        limb_end = Coordinate(3, 0)

        chosen = set()
        for seed in range(60):
            store = InMemoryWorldStore()
            engine_registry = Registry(store, rng=random.Random(seed))
            from mosaic.engine import Engine

            engine = Engine(store=store, registry=engine_registry)
            build(engine, (1, 0))
            build(engine, (2, 0))
            build(engine, (0, 1))

            agent, _ = engine.register("a")
            chosen.add(engine.claim(agent).coordinate)

        self.assertIn(pocket, chosen)
        self.assertIn(limb_end, chosen, "a slot with one neighbour must still be reachable")


class LeaseTests(unittest.TestCase):
    def test_an_expired_lease_returns_the_sector_to_the_frontier(self):
        engine = make_engine(lease_seconds=0)
        agent, _ = engine.register("slow")
        claim = engine.claim(agent)

        time.sleep(0.01)
        self.assertFalse(claim.is_active)
        self.assertIn(claim.coordinate, engine.registry.frontier())
        self.assertIs(engine.registry.get_claim(claim.claim_id).status, ClaimStatus.EXPIRED)

    def test_an_agent_whose_lease_lapsed_may_claim_again(self):
        engine = make_engine(lease_seconds=0)
        agent, _ = engine.register("slow")
        engine.claim(agent)
        time.sleep(0.01)
        self.assertIsNotNone(engine.claim(agent))

    def test_a_live_lease_holds_its_sector_against_other_agents(self):
        engine = make_engine()
        agent, _ = engine.register("holder")
        claim = engine.claim(agent)
        self.assertNotIn(claim.coordinate, engine.registry.frontier())

    def test_an_agent_cannot_hold_two_claims_at_once(self):
        engine = make_engine()
        agent, _ = engine.register("greedy")
        engine.claim(agent)
        with self.assertRaises(SectorUnavailable):
            engine.claim(agent)

    def test_releasing_frees_the_sector_but_keeps_the_agent(self):
        engine = make_engine()
        agent, token = engine.register("quitter")
        claim = engine.claim(agent)
        engine.release(claim)

        self.assertIn(claim.coordinate, engine.registry.frontier())
        # The token survives — an agent that gave up may try again.
        self.assertIs(engine.registry.authenticate(token), agent)
        self.assertIsNotNone(engine.claim(agent))


class SectorSubmissionTests(unittest.TestCase):
    def test_a_clean_submission_bakes_and_settles_the_agent(self):
        engine = make_engine(cooldown_seconds=3600)
        agent, token = engine.register("architect")
        claim = engine.claim(agent)

        baked, errors = engine.submit_sector(agent, claim, sector(claim.coordinate))
        self.assertEqual(errors, [])
        self.assertIsNotNone(engine.store.get(claim.coordinate))
        self.assertIs(engine.registry.get_claim(claim.claim_id).status, ClaimStatus.BAKED)
        self.assertEqual(agent.coordinate, claim.coordinate)
        self.assertGreater(agent.cooldown_remaining(), 0)

    def test_the_token_survives_baking(self):
        """The sector is permanent; the agent is not spent. It comes back."""
        engine = make_engine()
        agent, token, _ = settle(engine)
        self.assertIs(engine.registry.authenticate(token), agent)

    def test_an_agent_gets_exactly_one_sector_ever(self):
        engine = make_engine()
        agent, _, _ = settle(engine)
        with self.assertRaises(SectorUnavailable):
            engine.claim(agent)

    def test_a_rejected_submission_leaves_the_lease_live(self):
        engine = make_engine()
        agent, _ = engine.register("architect")
        claim = engine.claim(agent)

        baked, errors = engine.submit_sector(agent, claim, sector(claim.coordinate, title=""))
        self.assertIsNone(baked)
        self.assertIn("empty_text", codes(errors))
        self.assertTrue(claim.is_active)
        self.assertIsNone(agent.coordinate)
        self.assertEqual(claim.attempts, 1)

    def test_the_dry_run_never_touches_the_world(self):
        engine = make_engine()
        agent, _ = engine.register("careful")
        claim = engine.claim(agent)

        before = engine.store.count()
        parsed, errors = engine.check_sector(claim, sector(claim.coordinate))
        self.assertEqual(errors, [])
        self.assertEqual(engine.store.count(), before)

    def test_the_static_lock_refuses_a_rewrite(self):
        engine = make_engine()
        build(engine, (0, 1))
        with self.assertRaises(KeyError):
            build(engine, (0, 1))


class ClaimContextTests(unittest.TestCase):
    def test_a_claim_reveals_nothing_about_the_neighbours(self):
        """The withholding is the mechanism, so it gets a test of its own."""
        engine = make_engine()
        build(engine, (0, 1), title="The Tell-Tale Orangery", long_description="Moths, mostly.")
        agent, _ = engine.register("architect")
        claim = engine.claim(agent)

        serialised = repr(engine.claim_context(claim))
        for leak in ("Tell-Tale", "Orangery", "Moths", "title", "north", "exit", "neighbour"):
            with self.subTest(leak=leak):
                self.assertNotIn(leak, serialised)

    def test_a_claim_reveals_the_coordinate_and_the_clock(self):
        engine = make_engine()
        agent, _ = engine.register("architect")
        claim = engine.claim(agent)
        context = engine.claim_context(claim)

        self.assertEqual(context["coordinate"], claim.coordinate.as_list())
        self.assertGreater(context["claim"]["expires_in"], 0)


class ContributionClockTests(unittest.TestCase):
    def test_an_unsettled_agent_has_nothing_to_furnish(self):
        engine = make_engine()
        agent, _ = engine.register("drifter")
        with self.assertRaises(NoSector):
            engine.create_object(agent, obj())

    def test_a_fresh_sector_starts_a_cooldown(self):
        engine = make_engine(cooldown_seconds=3600)
        agent, _, _ = settle(engine)
        with self.assertRaises(NotYet):
            engine.create_object(agent, obj())

    def test_an_elapsed_cooldown_allows_exactly_one_object(self):
        engine = make_engine(cooldown_seconds=0)
        agent, _, _ = settle(engine)

        first, errors = engine.create_object(agent, obj(title="One"))
        self.assertEqual(errors, [])
        self.assertEqual(agent.objects_created, 1)
        self.assertIsNotNone(first)

    def test_each_object_restarts_the_clock(self):
        engine = make_engine(cooldown_seconds=0)
        agent, _, _ = settle(engine)
        engine.create_object(agent, obj())

        engine.registry._cooldown_seconds = 3600  # the next wait is a long one
        engine.registry.note_contribution(agent)
        with self.assertRaises(NotYet):
            engine.create_object(agent, obj())

    def test_a_rejected_object_does_not_spend_the_cooldown(self):
        engine = make_engine(cooldown_seconds=0)
        agent, _, _ = settle(engine)

        rejected, errors = engine.create_object(agent, obj(parent_id="obj_nope"))
        self.assertIsNone(rejected)
        self.assertIn("no_such_parent", codes(errors))
        self.assertEqual(agent.objects_created, 0)
        self.assertEqual(agent.cooldown_remaining(), 0)

    def test_objects_accumulate_into_a_tree(self):
        engine = make_engine(cooldown_seconds=0)
        agent, _, _ = settle(engine)

        can, _ = engine.create_object(agent, obj(title="Watering Can"))
        key, _ = engine.create_object(agent, obj(title="Key", parent_id=can.object_id))
        engine.create_object(agent, obj(title="Label"))

        tree = engine.object_tree(agent.coordinate)
        self.assertEqual([node["title"] for node in tree], ["Watering Can", "Label"])
        self.assertEqual([node["title"] for node in tree[0]["contains"]], ["Key"])


class ReadModelTests(unittest.TestCase):
    def test_exits_are_derived_from_adjacency_alone(self):
        engine = make_engine()
        build(engine, (0, 1), title="North Place", short_description="A glimpse north.")
        build(engine, (1, 0), title="East Place", short_description="A glimpse east.")

        view = engine.sector_view(ORIGIN)
        by_direction = {e["direction"]: e for e in view["exits"]}
        self.assertEqual(set(by_direction), {"north", "east"})
        self.assertEqual(by_direction["north"]["name"], "North Place")
        self.assertEqual(by_direction["north"]["description"], "A glimpse north.")

    def test_every_adjacency_produces_an_exit_in_both_directions(self):
        """Neither side declares the door, so neither side can disagree."""
        engine = make_engine()
        build(engine, (0, 1), title="North Place")

        south_side = engine.sector_view(ORIGIN)["exits"]
        north_side = engine.sector_view(Coordinate(0, 1))["exits"]
        self.assertEqual([e["direction"] for e in south_side], ["north"])
        self.assertEqual([e["direction"] for e in north_side], ["south"])
        self.assertEqual(north_side[0]["name"], "The Nullpoint")

    def test_the_players_view_shows_long_description_and_object_titles(self):
        engine = make_engine(cooldown_seconds=0)
        agent, _, _ = settle(engine)
        engine.create_object(agent, obj(title="A Thing", description="Longer detail."))

        view = engine.sector_view(agent.coordinate)
        self.assertEqual(view["description"], "It is a place, and it is here.")
        self.assertEqual([t["title"] for t in view["things_you_can_see"]], ["A Thing"])
        # The detail is only on the object itself, not spilled into the room.
        self.assertNotIn("Longer detail.", repr(view))

    def test_looking_at_an_object_shows_its_description_and_contents(self):
        engine = make_engine(cooldown_seconds=0)
        agent, _, _ = settle(engine)
        can, _ = engine.create_object(agent, obj(title="Can", description="Dented."))
        engine.create_object(agent, obj(title="Key", parent_id=can.object_id))

        view = engine.object_view(can.object_id)
        self.assertEqual(view["description"], "Dented.")
        self.assertEqual([t["title"] for t in view["things_you_can_see"]], ["Key"])

    def test_nested_objects_do_not_appear_at_sector_level(self):
        engine = make_engine(cooldown_seconds=0)
        agent, _, _ = settle(engine)
        can, _ = engine.create_object(agent, obj(title="Can"))
        engine.create_object(agent, obj(title="Key", parent_id=can.object_id))

        view = engine.sector_view(agent.coordinate)
        self.assertEqual([t["title"] for t in view["things_you_can_see"]], ["Can"])


class SnapshotTests(unittest.TestCase):
    def test_a_world_round_trips_through_its_snapshot(self):
        import tempfile
        from pathlib import Path

        from mosaic.engine import Engine

        with tempfile.TemporaryDirectory() as tmp:
            path = str(Path(tmp) / "world.json")
            first = Engine(state_path=path, cooldown_seconds=0)
            agent, _ = first.register("architect")
            claim = first.claim(agent)
            first.submit_sector(agent, claim, sector(claim.coordinate, title="Kept"))
            can, _ = first.create_object(agent, obj(title="Can"))
            first.create_object(agent, obj(title="Key", parent_id=can.object_id))

            reloaded = Engine(state_path=path)
            self.assertEqual(reloaded.store.count(), first.store.count())
            self.assertEqual(reloaded.store.get(claim.coordinate).sector.title, "Kept")
            self.assertEqual(reloaded.store.object_count(), 2)
            self.assertEqual(
                reloaded.object_tree(claim.coordinate)[0]["contains"][0]["title"], "Key"
            )


if __name__ == "__main__":
    unittest.main()
