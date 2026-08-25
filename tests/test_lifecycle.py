"""Claims, leases, the frontier, and the static lock."""

import time
import unittest

from helpers import bake, blueprint, codes, make_engine

from mosaic.coords import ORIGIN, Coordinate
from mosaic.registry import AgentStatus, ClaimStatus, SectorUnavailable


class FrontierTests(unittest.TestCase):
    def test_the_world_seeds_itself_with_one_room(self):
        engine = make_engine()
        self.assertEqual(engine.store.count(), 1)
        self.assertIsNotNone(engine.store.get(ORIGIN))

    def test_the_frontier_is_exactly_what_genesis_opens_onto(self):
        engine = make_engine()
        self.assertEqual(
            set(engine.registry.frontier()),
            {ORIGIN.step(d) for d, _ in ORIGIN.neighbours() if d.value != "up" and d.value != "down"},
        )

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

    def test_allocation_prefers_pockets_so_the_map_thickens(self):
        """A slot with two finished neighbours beats a slot with one.

        This is what stops the world growing into a single corridor.
        """
        engine = make_engine()
        bake(engine, (0, 1, 0), directions=("south", "east"))
        agent, _ = engine.register("filler")
        claim = engine.claim(agent)
        # [1, 1, 0] touches the new room; [1, 0, 0] touches genesis. Neither has
        # two baked neighbours yet, so what matters is that the pocket adjacent
        # to the most finished work is preferred once one exists.
        bake(engine, (1, 0, 0), directions=("west", "north"))
        agent2, _ = engine.register("filler2")
        claim2 = engine.claim(agent2)
        self.assertEqual(claim2.coordinate, Coordinate(1, 1, 0))


class LeaseTests(unittest.TestCase):
    def test_an_expired_lease_returns_the_sector_to_the_frontier(self):
        engine = make_engine(lease_seconds=0)
        agent, _ = engine.register("slow")
        claim = engine.claim(agent)
        coordinate = claim.coordinate

        time.sleep(0.01)
        self.assertFalse(claim.is_active)
        self.assertIn(coordinate, engine.registry.frontier())
        self.assertIs(engine.registry.get_claim(claim.claim_id).status, ClaimStatus.EXPIRED)

    def test_a_live_lease_holds_its_sector_against_other_agents(self):
        engine = make_engine()
        agent, _ = engine.register("holder")
        claim = engine.claim(agent)
        self.assertNotIn(claim.coordinate, engine.registry.frontier())

    def test_releasing_a_claim_frees_the_sector_and_spends_the_agent(self):
        engine = make_engine()
        agent, token = engine.register("quitter")
        claim = engine.claim(agent)
        engine.release(claim)

        self.assertIn(claim.coordinate, engine.registry.frontier())
        self.assertIsNone(engine.registry.authenticate(token))


class SubmissionTests(unittest.TestCase):
    def test_a_clean_submission_bakes_and_decommissions(self):
        engine = make_engine()
        agent, token = engine.register("architect")
        claim = engine.claim(agent)
        directions = [d.value for d in engine.store.promises_into(claim.coordinate)]

        room, errors = engine.submit(claim, blueprint(claim.coordinate, directions))
        self.assertEqual(errors, [])
        self.assertIsNotNone(engine.store.get(claim.coordinate))
        self.assertIs(engine.registry.get_claim(claim.claim_id).status, ClaimStatus.BAKED)
        self.assertIs(agent.status, AgentStatus.DECOMMISSIONED)
        self.assertIsNone(engine.registry.authenticate(token))

    def test_a_rejected_submission_leaves_the_lease_live(self):
        engine = make_engine()
        agent, token = engine.register("architect")
        claim = engine.claim(agent)

        room, errors = engine.submit(claim, blueprint(claim.coordinate, ("up",)))
        self.assertIsNone(room)
        self.assertIn("unfulfilled_promise", codes(errors))
        self.assertTrue(claim.is_active)
        self.assertIsNotNone(engine.registry.authenticate(token))
        self.assertEqual(claim.attempts, 1)

    def test_the_dry_run_never_touches_the_graph(self):
        engine = make_engine()
        agent, _ = engine.register("careful")
        claim = engine.claim(agent)
        directions = [d.value for d in engine.store.promises_into(claim.coordinate)]

        before = engine.store.count()
        parsed, errors = engine.check(claim, blueprint(claim.coordinate, directions))
        self.assertEqual(errors, [])
        self.assertEqual(engine.store.count(), before)

    def test_the_static_lock_refuses_a_rewrite(self):
        engine = make_engine()
        bake(engine, (0, 1, 0), directions=("south",))
        with self.assertRaises(KeyError):
            bake(engine, (0, 1, 0), directions=("south",))

    def test_an_agent_gets_exactly_one_sector(self):
        engine = make_engine()
        agent, _ = engine.register("greedy")
        engine.claim(agent)
        with self.assertRaises(SectorUnavailable):
            engine.claim(agent)


class ContextTests(unittest.TestCase):
    def test_context_shares_doorway_text_but_not_room_descriptions(self):
        """Anchoring the doorway is required; anchoring the interior is not.

        Withholding neighbour descriptions is what preserves the tonal whiplash.
        """
        engine = make_engine()
        agent, _ = engine.register("architect")
        claim = engine.claim(agent)
        context = engine.context(claim)

        genesis = engine.store.get(ORIGIN).blueprint
        serialised = repr(context)
        self.assertIn("their_doorway", serialised)
        self.assertNotIn(genesis.description, serialised)

    def test_context_separates_required_open_and_sealed_sides(self):
        engine = make_engine()
        bake(engine, (0, 1, 0), directions=("south",))
        bake(engine, (1, 0, 0), directions=("west", "north"))
        # [1, 1, 0] owes a south exit to [1, 0, 0], and [0, 1, 0] never opened east.
        agent, _ = engine.register("architect")
        claim = engine.claim(agent)
        self.assertEqual(claim.coordinate, Coordinate(1, 1, 0))

        context = engine.context(claim)
        self.assertEqual([r["direction"] for r in context["required_exits"]], ["south"])
        self.assertIn("west", context["sealed_sides"])
        self.assertIn("north", context["open_sides"])


class SnapshotTests(unittest.TestCase):
    def test_a_world_round_trips_through_its_snapshot(self):
        import tempfile
        from pathlib import Path

        from mosaic.engine import Engine

        with tempfile.TemporaryDirectory() as tmp:
            path = str(Path(tmp) / "world.json")
            first = Engine(state_path=path)
            agent, _ = first.register("architect")
            claim = first.claim(agent)
            directions = [d.value for d in first.store.promises_into(claim.coordinate)]
            room, errors = first.submit(claim, blueprint(claim.coordinate, directions))
            self.assertEqual(errors, [])

            reloaded = Engine(state_path=path)
            self.assertEqual(reloaded.store.count(), first.store.count())
            self.assertEqual(
                reloaded.store.get(claim.coordinate).blueprint, room.blueprint
            )


if __name__ == "__main__":
    unittest.main()
