"""The HTTP surface, exercised the way an external agent would use it."""

import http.client
import json
import threading
import unittest
import urllib.error
import urllib.request

from helpers import blueprint, make_engine

from mosaic.api import make_server


class ApiTestCase(unittest.TestCase):
    """Boots a real server on an ephemeral port — agents are external, so is this."""

    def setUp(self):
        self.engine = make_engine()
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

    def call(self, method, path, body=None, token=None, raw_body=None):
        request = urllib.request.Request(f"{self.base}{path}", method=method)
        data = raw_body
        if body is not None:
            data = json.dumps(body).encode("utf-8")
        if data is not None:
            request.add_header("Content-Type", "application/json")
        if token:
            request.add_header("Authorization", f"Bearer {token}")
        try:
            with urllib.request.urlopen(request, data, timeout=10) as response:
                return response.status, json.load(response)
        except urllib.error.HTTPError as exc:
            return exc.code, json.load(exc)

    def new_agent(self, label="tester"):
        status, payload = self.call("POST", "/v1/agents/register", {"label": label})
        self.assertEqual(status, 201)
        return payload["token"]

    def new_claim(self, token):
        status, context = self.call("POST", "/v1/claims", None, token)
        self.assertEqual(status, 201)
        return context

    @staticmethod
    def valid_for(context):
        directions = [r["direction"] for r in context["required_exits"]]
        return blueprint(context["coordinate"], directions or ("north",))


class PublicEndpointTests(ApiTestCase):
    def test_health(self):
        status, payload = self.call("GET", "/v1/health")
        self.assertEqual((status, payload["status"]), (200, "ok"))

    def test_spec_carries_the_schema_and_the_prompt(self):
        status, payload = self.call("GET", "/v1/spec")
        self.assertEqual(status, 200)
        self.assertIn("coordinate", payload["blueprint_fields"])
        self.assertIn("weight_class", payload["item_fields"])
        self.assertIn("Room Architect", payload["prompt_template"])

    def test_reading_a_baked_room(self):
        status, payload = self.call("GET", "/v1/rooms/0/0/0")
        self.assertEqual(status, 200)
        self.assertEqual(payload["blueprint"]["coordinate"], [0, 0, 0])

    def test_reading_an_empty_coordinate_is_a_404(self):
        status, payload = self.call("GET", "/v1/rooms/0/9/0")
        self.assertEqual((status, payload["error"]["code"]), (404, "no_such_room"))

    def test_negative_coordinates_route_correctly(self):
        status, _ = self.call("GET", "/v1/rooms/-1/-1/-1")
        self.assertEqual(status, 404)  # routed, just empty

    def test_map_reports_rooms_edges_and_frontier(self):
        status, payload = self.call("GET", "/v1/map")
        self.assertEqual(status, 200)
        self.assertEqual(len(payload["rooms"]), 1)
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

    def test_a_decommissioned_token_is_revoked(self):
        token = self.new_agent()
        context = self.new_claim(token)
        claim_id = context["claim"]["claim_id"]
        status, _ = self.call(
            "POST", f"/v1/claims/{claim_id}/blueprint", self.valid_for(context), token
        )
        self.assertEqual(status, 201)

        status, payload = self.call("GET", f"/v1/claims/{claim_id}", None, token)
        self.assertEqual((status, payload["error"]["code"]), (401, "unauthorised"))

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
    def test_a_claim_returns_borders_and_a_rendered_prompt(self):
        context = self.new_claim(self.new_agent())
        self.assertEqual(len(context["required_exits"]), 1)
        self.assertIn("Room Architect", context["prompt"])
        self.assertIn(str(tuple(context["coordinate"])).replace("(", "[").replace(")", "]"),
                      context["prompt"])

    def test_the_rendered_prompt_names_the_required_direction(self):
        context = self.new_claim(self.new_agent())
        direction = context["required_exits"][0]["direction"]
        self.assertIn(direction, context["prompt"])
        self.assertIn(context["required_exits"][0]["their_doorway"], context["prompt"])

    def test_dry_run_reports_errors_without_baking(self):
        token = self.new_agent()
        context = self.new_claim(token)
        claim_id = context["claim"]["claim_id"]

        bad = blueprint(context["coordinate"], ("up",))
        status, payload = self.call("POST", f"/v1/claims/{claim_id}/validate", bad, token)
        self.assertEqual(status, 200)
        self.assertFalse(payload["ok"])
        self.assertEqual(self.engine.store.count(), 1)

        status, payload = self.call(
            "POST", f"/v1/claims/{claim_id}/validate", self.valid_for(context), token
        )
        self.assertTrue(payload["ok"])
        self.assertEqual(self.engine.store.count(), 1)

    def test_a_rejected_submission_returns_422_and_structured_errors(self):
        token = self.new_agent()
        context = self.new_claim(token)
        claim_id = context["claim"]["claim_id"]

        bad = blueprint(context["coordinate"], ("up",))
        status, payload = self.call("POST", f"/v1/claims/{claim_id}/blueprint", bad, token)
        self.assertEqual(status, 422)
        self.assertFalse(payload["ok"])
        self.assertEqual(
            {"unfulfilled_promise"}, {e["code"] for e in payload["errors"]}
        )
        self.assertTrue(all({"code", "path", "message"} <= set(e) for e in payload["errors"]))

    def test_a_rejection_leaves_the_lease_usable(self):
        token = self.new_agent()
        context = self.new_claim(token)
        claim_id = context["claim"]["claim_id"]

        self.call("POST", f"/v1/claims/{claim_id}/blueprint",
                  blueprint(context["coordinate"], ("up",)), token)
        status, payload = self.call(
            "POST", f"/v1/claims/{claim_id}/blueprint", self.valid_for(context), token
        )
        self.assertEqual((status, payload["status"]), (201, "baked"))

    def test_resubmitting_after_baking_is_refused(self):
        token = self.new_agent()
        context = self.new_claim(token)
        claim_id = context["claim"]["claim_id"]
        self.call("POST", f"/v1/claims/{claim_id}/blueprint", self.valid_for(context), token)

        status, payload = self.call(
            "POST", f"/v1/claims/{claim_id}/blueprint", self.valid_for(context), token
        )
        # The token died with the agent, so the rewrite never reaches the graph.
        self.assertEqual((status, payload["error"]["code"]), (401, "unauthorised"))

    def test_releasing_a_claim_returns_the_sector(self):
        token = self.new_agent()
        context = self.new_claim(token)
        claim_id = context["claim"]["claim_id"]

        status, payload = self.call("DELETE", f"/v1/claims/{claim_id}", None, token)
        self.assertEqual((status, payload["status"]), (200, "released"))

        _, world = self.call("GET", "/v1/map")
        self.assertIn(context["coordinate"], world["frontier"])

    def test_submitting_against_an_expired_lease_is_a_409(self):
        engine = make_engine(lease_seconds=0)
        server = make_server(engine, host="127.0.0.1", port=0, quiet=True)
        base = "http://{}:{}".format(*server.server_address[:2])
        thread = threading.Thread(
            target=server.serve_forever, kwargs={"poll_interval": 0.01}, daemon=True
        )
        thread.start()
        try:
            self.base = base
            token = self.new_agent()
            context = self.new_claim(token)
            claim_id = context["claim"]["claim_id"]
            status, payload = self.call(
                "POST", f"/v1/claims/{claim_id}/blueprint", self.valid_for(context), token
            )
            self.assertEqual((status, payload["error"]["code"]), (409, "claim_not_active"))
        finally:
            server.shutdown()
            server.server_close()
            thread.join(timeout=5)

    def test_no_sector_available_is_a_409(self):
        tokens = [self.new_agent(f"a{i}") for i in range(4)]
        for token in tokens:
            self.new_claim(token)
        status, payload = self.call("POST", "/v1/claims", None, self.new_agent("extra"))
        self.assertEqual((status, payload["error"]["code"]), (409, "no_sector_available"))


class MalformedInputTests(ApiTestCase):
    def test_a_non_json_body_is_a_400(self):
        token = self.new_agent()
        context = self.new_claim(token)
        claim_id = context["claim"]["claim_id"]
        status, payload = self.call(
            "POST", f"/v1/claims/{claim_id}/blueprint", None, token, raw_body=b"{nope"
        )
        self.assertEqual((status, payload["error"]["code"]), (400, "malformed_json"))

    def test_an_oversized_body_is_a_413(self):
        token = self.new_agent()
        context = self.new_claim(token)
        claim_id = context["claim"]["claim_id"]
        status, payload = self.call(
            "POST",
            f"/v1/claims/{claim_id}/blueprint",
            None,
            token,
            raw_body=b"x" * 200_000,
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
