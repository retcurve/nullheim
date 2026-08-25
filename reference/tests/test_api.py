"""The HTTP surface, exercised the way an external agent (or player) would use it."""

import http.client
import json
import threading
import unittest
import urllib.error
import urllib.request

from helpers import make_engine, obj, sector

from mosaic.api import make_server


class ApiTestCase(unittest.TestCase):
    """Boots a real server on an ephemeral port — agents are external, so is this."""

    cooldown_seconds = 0

    def setUp(self):
        self.engine = make_engine(cooldown_seconds=self.cooldown_seconds)
        self.server = make_server(self.engine, host="127.0.0.1", port=0, quiet=True)
        self.base = "http://{}:{}".format(*self.server.server_address[:2])
        self.thread = threading.Thread(
            target=self.server.serve_forever, kwargs={"poll_interval": 0.01}, daemon=True
        )
        self.thread.start()

    def tearDown(self):
        self.server.shutdown()
        self.server.server_close()
        self.thread.join(timeout=5)

    def call(self, method, path, body=None, token=None, raw_body=None, accept="application/json"):
        request = urllib.request.Request(f"{self.base}{path}", method=method)
        data = raw_body
        if body is not None:
            data = json.dumps(body).encode("utf-8")
        if data is not None:
            request.add_header("Content-Type", "application/json")
        if accept:
            request.add_header("Accept", accept)
        if token:
            request.add_header("Authorization", f"Bearer {token}")
        try:
            with urllib.request.urlopen(request, data, timeout=10) as response:
                return response.status, json.load(response)
        except urllib.error.HTTPError as exc:
            return exc.code, json.load(exc)

    def call_text(self, method, path, accept="*/*"):
        """Fetch without asking for JSON — what a bare client or browser sends."""
        request = urllib.request.Request(f"{self.base}{path}", method=method)
        request.add_header("Accept", accept)
        with urllib.request.urlopen(request, None, timeout=10) as response:
            return response.status, response.headers["Content-Type"], response.read().decode()

    def new_agent(self, label="tester"):
        status, payload = self.call("POST", "/v1/agents/register", {"label": label})
        self.assertEqual(status, 201)
        return payload["token"]

    def new_claim(self, token):
        status, context = self.call("POST", "/v1/claims", None, token)
        self.assertEqual(status, 201)
        return context

    def settle(self, label="tester", **overrides):
        token = self.new_agent(label)
        context = self.new_claim(token)
        claim_id = context["claim"]["claim_id"]
        status, result = self.call(
            "POST", f"/v1/claims/{claim_id}/sector",
            sector(context["coordinate"], **overrides), token,
        )
        self.assertEqual(status, 201)
        return token, context["coordinate"]

    def sector_id_for(self, token):
        _, me = self.call("GET", "/v1/agents/me", None, token)
        return me["sector"]["sector_id"]


class PublicEndpointTests(ApiTestCase):
    def test_root_serves_prose_to_whoever_just_turned_up(self):
        status, content_type, text = self.call_text("GET", "/")
        self.assertEqual(status, 200)
        self.assertIn("text/markdown", content_type)
        self.assertTrue(text.startswith("# Mosaic"))

    def test_root_teaches_the_three_texts_not_just_the_endpoints(self):
        """The craft, not only the choreography — this is the whole point of /."""
        _, _, text = self.call_text("GET", "/")
        for taught in ("short_description", "long_description", "Exits are derived"):
            with self.subTest(taught=taught):
                self.assertIn(taught, text)

    def test_a_browser_accept_header_still_gets_the_prose(self):
        _, content_type, _ = self.call_text(
            "GET", "/", accept="text/html,application/xhtml+xml,*/*"
        )
        self.assertIn("text/markdown", content_type)

    def test_root_lists_every_endpoint_for_an_agent_with_no_repo_access(self):
        status, payload = self.call("GET", "/")
        self.assertEqual(status, 200)
        reference = payload["full_endpoint_reference"]
        paths = {e["path"] for e in reference}
        self.assertIn("/v1/spec", paths)
        self.assertIn("/v1/agents/register", paths)
        methods = {(e["method"], e["path"]) for e in reference}
        self.assertIn(("POST", "/v1/claims"), methods)
        for endpoint in reference:
            self.assertTrue(endpoint["summary"])

    def test_root_walks_an_agent_through_the_whole_lifecycle(self):
        status, payload = self.call("GET", "/")
        self.assertEqual(status, 200)
        steps = payload["getting_started"]
        self.assertEqual([s["step"] for s in steps], list(range(1, len(steps) + 1)))
        requests = [(s["request"]["method"], s["request"]["path"]) for s in steps]
        self.assertIn(("POST", "/v1/agents/register"), requests)
        self.assertIn(("POST", "/v1/claims"), requests)
        self.assertIn(("POST", "/v1/claims/{claim_id}/validate"), requests)
        self.assertIn(("POST", "/v1/claims/{claim_id}/sector"), requests)
        self.assertIn(("GET", "/v1/agents/me"), requests)
        self.assertIn(("POST", "/v1/objects/validate"), requests)
        self.assertIn(("POST", "/v1/objects"), requests)
        for step in steps:
            self.assertTrue(step["do"])

    def test_health(self):
        status, payload = self.call("GET", "/v1/health")
        self.assertEqual((status, payload["status"]), (200, "ok"))

    def test_spec_carries_both_schemas_and_both_prompts(self):
        status, payload = self.call("GET", "/v1/spec")
        self.assertEqual(status, 200)
        self.assertIn("short_description", payload["sector_fields"])
        self.assertIn("parent_id", payload["object_fields"])
        self.assertEqual(payload["directions"], ["north", "south", "east", "west"])
        self.assertIn("Sector Architect", payload["prompts"]["sector_architect"])
        self.assertIn("Object Artisan", payload["prompts"]["object_artisan"])

    def test_reading_a_sector_gives_the_players_view(self):
        status, payload = self.call("GET", "/v1/sectors/0/0")
        self.assertEqual(status, 200)
        self.assertEqual(payload["title"], "The Nullpoint")
        self.assertIn("description", payload)
        self.assertEqual(payload["exits"], [])

    def test_a_new_neighbour_creates_exits_on_both_sides(self):
        _, coordinate = self.settle(title="Somewhere Else")
        _, origin = self.call("GET", "/v1/sectors/0/0")
        _, theirs = self.call("GET", "/v1/sectors/{}/{}".format(*coordinate))

        self.assertEqual(len(origin["exits"]), 1)
        self.assertEqual(origin["exits"][0]["name"], "Somewhere Else")
        self.assertEqual(len(theirs["exits"]), 1)
        self.assertEqual(theirs["exits"][0]["name"], "The Nullpoint")

    def test_reading_an_empty_coordinate_is_a_404(self):
        status, payload = self.call("GET", "/v1/sectors/0/9")
        self.assertEqual((status, payload["error"]["code"]), (404, "no_such_sector"))

    def test_negative_coordinates_route_correctly(self):
        status, _ = self.call("GET", "/v1/sectors/-1/-1")
        self.assertEqual(status, 404)  # routed, just empty

    def test_reading_a_missing_object_is_a_404(self):
        status, payload = self.call("GET", "/v1/objects/obj_nope")
        self.assertEqual((status, payload["error"]["code"]), (404, "no_such_object"))

    def test_map_reports_sectors_edges_and_frontier(self):
        status, payload = self.call("GET", "/v1/map")
        self.assertEqual(status, 200)
        self.assertEqual(len(payload["sectors"]), 1)
        self.assertEqual(len(payload["frontier"]), 4)

    def test_unknown_route(self):
        status, payload = self.call("GET", "/v1/nonsense")
        self.assertEqual((status, payload["error"]["code"]), (404, "no_such_route"))


class AuthTests(ApiTestCase):
    def test_claiming_without_a_token_is_refused(self):
        status, payload = self.call("POST", "/v1/claims")
        self.assertEqual((status, payload["error"]["code"]), (401, "unauthorised"))

    def test_a_bogus_token_is_refused(self):
        status, _ = self.call("POST", "/v1/claims", None, "not-a-real-token")
        self.assertEqual(status, 401)

    def test_a_token_still_works_after_the_sector_is_baked(self):
        """Agents are long-lived now — the credential outlives the building."""
        token, _ = self.settle()
        status, me = self.call("GET", "/v1/agents/me", None, token)
        self.assertEqual(status, 200)
        self.assertTrue(me["can_create_object"])
        self.assertFalse(me["can_claim_sector"])

    def test_one_agent_cannot_read_anothers_claim(self):
        first = self.new_agent("first")
        context = self.new_claim(first)
        second = self.new_agent("second")
        self.new_claim(second)

        status, payload = self.call(
            "GET", "/v1/claims/{}".format(context["claim"]["claim_id"]), None, second
        )
        self.assertEqual((status, payload["error"]["code"]), (403, "not_your_claim"))


class ClaimFlowTests(ApiTestCase):
    def test_a_claim_returns_a_coordinate_and_a_prompt_and_nothing_else(self):
        context = self.new_claim(self.new_agent())
        self.assertEqual(set(context), {"claim", "coordinate", "world_sectors", "prompt"})
        self.assertIn("Sector Architect", context["prompt"])
        self.assertIn(str(tuple(context["coordinate"])).replace("(", "[").replace(")", "]"),
                      context["prompt"])

    def test_the_claim_payload_leaks_nothing_about_neighbours(self):
        self.settle("neighbour", title="The Tell-Tale Orangery")
        context = self.new_claim(self.new_agent("next"))
        blob = json.dumps(context)
        self.assertNotIn("Tell-Tale", blob)
        self.assertNotIn("Nullpoint", blob)

    def test_dry_run_reports_errors_without_baking(self):
        token = self.new_agent()
        context = self.new_claim(token)
        claim_id = context["claim"]["claim_id"]

        bad = sector(context["coordinate"], title="")
        status, payload = self.call("POST", f"/v1/claims/{claim_id}/validate", bad, token)
        self.assertEqual(status, 200)
        self.assertFalse(payload["ok"])
        self.assertEqual(self.engine.store.count(), 1)

        status, payload = self.call(
            "POST", f"/v1/claims/{claim_id}/validate", sector(context["coordinate"]), token
        )
        self.assertTrue(payload["ok"])
        self.assertEqual(self.engine.store.count(), 1)

    def test_a_rejected_submission_returns_422_and_structured_errors(self):
        token = self.new_agent()
        context = self.new_claim(token)
        claim_id = context["claim"]["claim_id"]

        bad = sector([99, 99], title="")
        status, payload = self.call("POST", f"/v1/claims/{claim_id}/sector", bad, token)
        self.assertEqual(status, 422)
        self.assertFalse(payload["ok"])
        self.assertTrue(all({"code", "path", "message"} <= set(e) for e in payload["errors"]))

    def test_a_rejection_leaves_the_lease_usable(self):
        token = self.new_agent()
        context = self.new_claim(token)
        claim_id = context["claim"]["claim_id"]

        self.call("POST", f"/v1/claims/{claim_id}/sector", sector([99, 99]), token)
        status, payload = self.call(
            "POST", f"/v1/claims/{claim_id}/sector", sector(context["coordinate"]), token
        )
        self.assertEqual((status, payload["status"]), (201, "baked"))

    def test_resubmitting_after_baking_is_refused(self):
        token = self.new_agent()
        context = self.new_claim(token)
        claim_id = context["claim"]["claim_id"]
        self.call("POST", f"/v1/claims/{claim_id}/sector", sector(context["coordinate"]), token)

        status, payload = self.call(
            "POST", f"/v1/claims/{claim_id}/sector", sector(context["coordinate"]), token
        )
        # The token still works, but the claim is spent — the sector is locked.
        self.assertEqual((status, payload["error"]["code"]), (409, "claim_not_active"))

    def test_a_settled_agent_cannot_claim_again(self):
        token, _ = self.settle()
        status, payload = self.call("POST", "/v1/claims", None, token)
        self.assertEqual((status, payload["error"]["code"]), (409, "already_settled"))
        self.assertFalse(payload["retryable"])

    def test_holding_a_claim_blocks_a_second_one_but_is_retryable(self):
        token = self.new_agent()
        self.new_claim(token)
        status, payload = self.call("POST", "/v1/claims", None, token)
        self.assertEqual((status, payload["error"]["code"]), (409, "claim_in_progress"))
        self.assertTrue(payload["retryable"])

    def test_releasing_a_claim_returns_the_sector(self):
        token = self.new_agent()
        context = self.new_claim(token)
        claim_id = context["claim"]["claim_id"]

        status, payload = self.call("DELETE", f"/v1/claims/{claim_id}", None, token)
        self.assertEqual((status, payload["status"]), (200, "released"))

        _, world = self.call("GET", "/v1/map")
        self.assertIn(context["coordinate"], world["frontier"])

    def test_a_fully_leased_frontier_is_a_retryable_409(self):
        tokens = [self.new_agent(f"a{i}") for i in range(4)]
        for token in tokens:
            self.new_claim(token)
        status, payload = self.call("POST", "/v1/claims", None, self.new_agent("extra"))
        self.assertEqual((status, payload["error"]["code"]), (409, "frontier_busy"))
        self.assertTrue(payload["retryable"])

    def test_the_three_claim_refusals_are_distinguishable(self):
        """One code for all three would have agents retrying a permanent refusal."""
        settled, _ = self.settle("settled")
        holding = self.new_agent("holding")
        self.new_claim(holding)

        codes = set()
        for token in (settled, holding):
            _, payload = self.call("POST", "/v1/claims", None, token)
            codes.add(payload["error"]["code"])
        self.assertEqual(codes, {"already_settled", "claim_in_progress"})


class ExpiredLeaseTests(ApiTestCase):
    def test_submitting_against_an_expired_lease_is_a_409(self):
        engine = make_engine(lease_seconds=0)
        server = make_server(engine, host="127.0.0.1", port=0, quiet=True)
        thread = threading.Thread(
            target=server.serve_forever, kwargs={"poll_interval": 0.01}, daemon=True
        )
        thread.start()
        try:
            self.base = "http://{}:{}".format(*server.server_address[:2])
            token = self.new_agent()
            context = self.new_claim(token)
            claim_id = context["claim"]["claim_id"]
            status, payload = self.call(
                "POST", f"/v1/claims/{claim_id}/sector", sector(context["coordinate"]), token
            )
            self.assertEqual((status, payload["error"]["code"]), (409, "claim_not_active"))
        finally:
            server.shutdown()
            server.server_close()
            thread.join(timeout=5)


class ObjectTests(ApiTestCase):
    def test_an_agent_with_no_sector_gets_409_not_429(self):
        """No sector is a state error, not a rate limit."""
        token = self.new_agent()
        status, payload = self.call("POST", "/v1/objects", obj("sec_whatever"), token)
        self.assertEqual((status, payload["error"]["code"]), (409, "sector_required"))

    def test_placing_an_object_and_seeing_it_as_a_player(self):
        token, coordinate = self.settle()
        status, result = self.call(
            "POST", "/v1/objects",
            obj(self.sector_id_for(token), title="Brass Can", description="Dented."), token,
        )
        self.assertEqual(status, 201)
        object_id = result["object"]["object_id"]

        _, view = self.call("GET", "/v1/sectors/{}/{}".format(*coordinate))
        self.assertEqual([t["title"] for t in view["things_you_can_see"]], ["Brass Can"])

        _, detail = self.call("GET", f"/v1/objects/{object_id}")
        self.assertEqual(detail["description"], "Dented.")

    def test_an_object_may_hang_on_another(self):
        token, coordinate = self.settle()
        sector_id = self.sector_id_for(token)
        _, first = self.call("POST", "/v1/objects", obj(sector_id, title="Can"), token)
        parent_id = first["object"]["object_id"]

        status, second = self.call(
            "POST", "/v1/objects", obj(parent_id, title="Key"), token
        )
        self.assertEqual(status, 201)

        _, view = self.call("GET", "/v1/sectors/{}/{}".format(*coordinate))
        self.assertEqual([t["title"] for t in view["things_you_can_see"]], ["Can"])
        _, detail = self.call("GET", f"/v1/objects/{parent_id}")
        self.assertEqual([t["title"] for t in detail["things_you_can_see"]], ["Key"])

    def test_another_agents_object_is_not_a_valid_parent(self):
        first_token, _ = self.settle("first")
        _, theirs = self.call(
            "POST", "/v1/objects", obj(self.sector_id_for(first_token), title="Theirs"), first_token
        )
        second_token, _ = self.settle("second")

        status, payload = self.call(
            "POST", "/v1/objects",
            obj(theirs["object"]["object_id"]), second_token,
        )
        self.assertEqual(status, 422)
        self.assertEqual({e["code"] for e in payload["errors"]}, {"no_such_parent"})

    def test_the_object_dry_run_places_nothing(self):
        token, _ = self.settle()
        status, payload = self.call(
            "POST", "/v1/objects/validate", obj(self.sector_id_for(token)), token
        )
        self.assertEqual((status, payload["ok"]), (200, True))
        self.assertEqual(self.engine.store.object_count(), 0)

    def test_agents_me_exposes_the_object_tree_for_choosing_a_parent(self):
        token, _ = self.settle()
        sector_id = self.sector_id_for(token)
        _, first = self.call("POST", "/v1/objects", obj(sector_id, title="Can"), token)
        self.call(
            "POST", "/v1/objects",
            obj(first["object"]["object_id"], title="Key"), token,
        )

        status, me = self.call("GET", "/v1/agents/me", None, token)
        self.assertEqual(status, 200)
        tree = me["sector"]["objects"]
        self.assertEqual(tree[0]["title"], "Can")
        self.assertEqual(tree[0]["contains"][0]["title"], "Key")


class CooldownTests(ApiTestCase):
    cooldown_seconds = 3600

    def test_a_fresh_sector_is_on_cooldown(self):
        token, _ = self.settle()
        status, payload = self.call("POST", "/v1/objects", obj("sec_whatever"), token)
        self.assertEqual((status, payload["error"]["code"]), (429, "cooldown"))
        self.assertGreater(payload["agent"]["cooldown_remaining"], 0)

    def test_agents_me_reports_the_wait(self):
        token, _ = self.settle()
        _, me = self.call("GET", "/v1/agents/me", None, token)
        self.assertFalse(me["can_create_object"])
        self.assertEqual(me["cooldown_seconds"], 3600)
        self.assertGreater(me["agent"]["cooldown_remaining"], 0)


class MalformedInputTests(ApiTestCase):
    def test_a_non_json_body_is_a_400(self):
        token = self.new_agent()
        context = self.new_claim(token)
        claim_id = context["claim"]["claim_id"]
        status, payload = self.call(
            "POST", f"/v1/claims/{claim_id}/sector", None, token, raw_body=b"{nope"
        )
        self.assertEqual((status, payload["error"]["code"]), (400, "malformed_json"))

    def test_an_oversized_body_is_a_413(self):
        token = self.new_agent()
        context = self.new_claim(token)
        claim_id = context["claim"]["claim_id"]
        status, payload = self.call(
            "POST", f"/v1/claims/{claim_id}/sector", None, token, raw_body=b"x" * 200_000
        )
        self.assertEqual((status, payload["error"]["code"]), (413, "payload_too_large"))


class KeepAliveTests(ApiTestCase):
    """Connection reuse must not be poisoned by a body a handler ignored."""

    def test_a_body_the_handler_ignores_is_still_drained(self):
        connection = http.client.HTTPConnection(*self.server.server_address[:2], timeout=5)
        try:
            # POST /v1/claims never looks at the body, and this one fails auth
            # before routing anyway. The bytes must not survive into request two.
            connection.request(
                "POST", "/v1/claims", json.dumps({"junk": "x" * 500}),
                {"Content-Type": "application/json"},
            )
            first = connection.getresponse()
            self.assertEqual(first.status, 401)
            first.read()

            connection.request("GET", "/v1/health")
            second = connection.getresponse()
            self.assertEqual(second.status, 200)
            self.assertEqual(json.loads(second.read())["status"], "ok")
        finally:
            connection.close()

    def test_the_connection_is_reused_rather_than_reopened(self):
        connection = http.client.HTTPConnection(*self.server.server_address[:2], timeout=5)
        try:
            for _ in range(3):
                connection.request("GET", "/v1/health")
                response = connection.getresponse()
                self.assertEqual(response.status, 200)
                self.assertNotEqual(response.getheader("Connection", ""), "close")
                response.read()
        finally:
            connection.close()


if __name__ == "__main__":
    unittest.main()
