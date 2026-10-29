"""API tests against the in-memory store.  Run:  python3 -m unittest discover -s tests -v"""
import importlib.util
import json
import os
import unittest
import uuid
from datetime import date, datetime, timedelta, timezone

os.environ["SN_MEMORY"] = "1"
ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
spec = importlib.util.spec_from_file_location("sn_api", os.path.join(ROOT, "api", "index.py"))
api = importlib.util.module_from_spec(spec)
spec.loader.exec_module(api)

TODAY = datetime.now(timezone.utc).date()


def day(offset=0):
    return (TODAY + timedelta(days=offset)).isoformat()


def call(method, route, token=None, body=None, extra=None):
    headers = {"x-token": token} if token else {}
    headers.update(extra or {})
    status, data = api.respond(method, f"/api?r={route}", headers, json.dumps(body).encode() if body is not None else b"")
    return status, data


def login(email="a@x.com"):
    status, data = call("POST", "login", body={"email": email, "tz": "America/New_York"})
    assert status == 200, data
    return data["token"], data["isNew"]


def state(token, today=0):
    status, data = call("GET", f"state&today={day(today)}", token)
    assert status == 200, data
    return data


def new_player(email="a@x.com", today=0):
    t, _ = login(email)
    assert call("PUT", "settings", t, {"onboarded": True})[0] == 200
    assert call("POST", "hatch", t, {"today": day(today)})[0] == 200
    return t


def drink(t, d=0, amount=20):
    return call("POST", "drinks", t, {"id": str(uuid.uuid4()), "day": day(d), "amountOz": amount})


def fill_day(t, d, n=4):
    for _ in range(n):
        assert drink(t, d)[0] == 200


class ApiTests(unittest.TestCase):
    def setUp(self):
        api._store = api.MemoryStore()

    # ---- auth
    def test_login_creates_then_finds_by_email_case_insensitive(self):
        t1, new1 = login("Nolan@Example.com ")
        t2, new2 = login("nolan@example.com")
        self.assertTrue(new1)
        self.assertFalse(new2)
        self.assertEqual(t1, t2)

    def test_login_rejects_bad_email(self):
        self.assertEqual(call("POST", "login", body={"email": "nope"})[0], 400)

    def test_requires_valid_token(self):
        self.assertEqual(call("GET", f"state&today={day()}")[0], 401)
        self.assertEqual(call("GET", f"state&today={day()}", "not-a-uuid")[0], 400)
        self.assertEqual(call("GET", f"state&today={day()}", str(uuid.uuid4()))[0], 401)

    def test_defaults_for_new_user(self):
        t, _ = login()
        status, data = call("GET", f"state&today={day()}", t)
        self.assertEqual(data["user"]["bottleOz"], 20)
        self.assertEqual(data["user"]["goalOz"], 73)
        self.assertEqual(data["needed"], 4)
        self.assertFalse(data["user"]["onboarded"])
        self.assertIsNone(data["snail"])

    def test_state_rejects_bad_or_far_off_day(self):
        t, _ = login()
        self.assertEqual(call("GET", "state&today=nope", t)[0], 400)
        self.assertEqual(call("GET", "state&today=2001-01-01", t)[0], 400)

    # ---- settings
    def test_settings_validation_and_needed(self):
        t, _ = login()
        s, d = call("PUT", "settings", t, {"bottleOz": 16, "goalOz": 100, "unit": "l", "musicApp": "spotify"})
        self.assertEqual(s, 200)
        self.assertEqual(d["needed"], 7)  # ceil(100/16)
        self.assertEqual(d["user"]["unit"], "l")
        self.assertEqual(call("PUT", "settings", t, {"bottleOz": 0})[0], 400)
        self.assertEqual(call("PUT", "settings", t, {"goalOz": "lots"})[0], 400)
        self.assertEqual(call("PUT", "settings", t, {"unit": "gallons"})[0], 400)
        self.assertEqual(call("PUT", "settings", t, {"musicApp": "tidal"})[0], 400)

    def test_needed_rounds_up_and_ignores_float_noise(self):
        self.assertEqual(api.bottles_needed({"goal_oz": 73, "bottle_oz": 20}), 4)
        self.assertEqual(api.bottles_needed({"goal_oz": 80, "bottle_oz": 20}), 4)
        self.assertEqual(api.bottles_needed({"goal_oz": 100, "bottle_oz": 33.3333}), 4)
        self.assertEqual(api.bottles_needed({"goal_oz": 8, "bottle_oz": 170}), 1)

    # ---- drinks
    def test_drink_add_undo_and_idempotent_retry(self):
        t = new_player()
        did = str(uuid.uuid4())
        body = {"id": did, "day": day(), "amountOz": 20}
        self.assertEqual(call("POST", "drinks", t, body)[0], 200)
        self.assertEqual(call("POST", "drinks", t, body)[0], 200)  # retry of the same request
        self.assertEqual(len(state(t)["drinks"]), 1)
        self.assertEqual(call("DELETE", f"drinks/{did}", t)[0], 200)
        self.assertEqual(call("DELETE", f"drinks/{did}", t)[0], 200)  # undo twice is a no-op
        self.assertEqual(state(t)["drinks"], [])

    def test_drinks_are_private_to_their_owner(self):
        a, b = new_player("a@x.com"), new_player("b@x.com")
        did = str(uuid.uuid4())
        call("POST", "drinks", a, {"id": did, "day": day(), "amountOz": 20})
        call("DELETE", f"drinks/{did}", b)  # b cannot delete a's drink
        self.assertEqual(len(state(a)["drinks"]), 1)
        self.assertEqual(state(b)["drinks"], [])

    def test_drink_validation(self):
        t = new_player()
        self.assertEqual(call("POST", "drinks", t, {"id": "x", "day": day(), "amountOz": 20})[0], 400)
        self.assertEqual(call("POST", "drinks", t, {"id": str(uuid.uuid4()), "day": day(), "amountOz": -5})[0], 400)
        self.assertEqual(call("POST", "drinks", t, {"id": str(uuid.uuid4()), "day": "1999-01-01", "amountOz": 5})[0], 400)

    def test_drinks_only_count_for_the_requested_day(self):
        t = new_player(today=-1)
        fill_day(t, -1, 4)
        drink(t, 0)
        s = state(t, 0)
        self.assertEqual(len(s["drinks"]), 1)

    # ---- death rule
    def test_meeting_the_goal_keeps_him_alive(self):
        t = new_player(today=-1)
        fill_day(t, -1, 4)
        s = state(t, 0)
        self.assertIsNone(s["snail"]["diedOn"])
        self.assertIsNone(s["dead"])

    def test_missing_the_goal_kills_him_at_midnight(self):
        t = new_player(today=-1)
        fill_day(t, -1, 1)
        s = state(t, 0)
        self.assertEqual(s["snail"]["diedOn"], day(-1))
        self.assertEqual(s["dead"], {"day": day(-1), "bottles": 1, "oz": 20.0, "needed": 4})
        self.assertEqual(s["drinks"], [])

    def test_today_is_never_judged_early(self):
        t = new_player(today=0)
        s = state(t, 0)
        self.assertIsNone(s["snail"]["diedOn"])

    def test_away_for_days_he_died_on_the_first_missed_day(self):
        t = new_player(today=-2)
        fill_day(t, -2, 4)   # day -2 is met, -1 is missed, today is open
        s = state(t, 0)
        self.assertEqual(s["snail"]["diedOn"], day(-1))

    def test_cannot_log_water_for_a_dead_snail(self):
        t = new_player(today=-1)
        state(t, 0)
        s, d = drink(t, 0)
        self.assertEqual((s, d["error"]), (409, "dead"))

    def test_hatching_starts_a_fresh_snail_with_zero_bottles(self):
        t = new_player(today=-1)
        state(t, 0)
        s, d = call("POST", "hatch", t, {"today": day()})
        self.assertEqual(s, 200)
        self.assertIsNone(d["snail"]["diedOn"])
        self.assertEqual(d["snail"]["hatchedOn"], day())
        self.assertEqual(d["drinks"], [])
        self.assertIsNone(d["dead"])
        self.assertEqual(drink(t, 0)[0], 200)

    def test_hatch_is_idempotent_while_alive(self):
        t = new_player()
        first = state(t)["snail"]["id"]
        s, d = call("POST", "hatch", t, {"today": day()})
        self.assertEqual(d["snail"]["id"], first)
        self.assertEqual(len(api.get_store().select("sn_snails")), 1)

    def test_new_snail_is_judged_from_its_own_hatch_day(self):
        t = new_player(today=-2)
        self.assertEqual(state(t, -1)["snail"]["diedOn"], day(-2))   # nothing logged on -2
        call("POST", "hatch", t, {"today": day(-1)})                 # hatches on -1
        fill_day(t, -1, 4)
        s = state(t, 0)
        self.assertIsNone(s["snail"]["diedOn"])        # -2 was not held against the new snail

    def test_goal_uses_current_settings_when_the_day_is_closed(self):
        t = new_player(today=-1)
        fill_day(t, -1, 2)
        call("PUT", "settings", t, {"bottleOz": 40})   # now 2 bottles is enough
        self.assertIsNone(state(t, 0)["snail"]["diedOn"])

    # ---- streaks and nags
    def _days(self, pattern, end_offset=-1):
        """pattern like 'MMX' oldest first: M = met, X = missed, ending on `end_offset`."""
        rows, d = {}, TODAY + timedelta(days=end_offset - len(pattern) + 1)
        for ch in pattern:
            rows[d.isoformat()] = {"goal_met": ch == "M"}
            d += timedelta(days=1)
        return rows

    def test_run_length(self):
        days = self._days("XMMM")
        self.assertEqual(api.run_length(days, TODAY - timedelta(days=1), True), 3)
        self.assertEqual(api.run_length(days, TODAY - timedelta(days=1), False), 0)

    def at(self, h, m=0):
        return datetime(2026, 10, 29, h, m)

    def test_no_nags_before_8am(self):
        self.assertEqual(api.plan_nags(self.at(7, 30), 0, 4, True, {}), [])

    def test_daily_nags_only_when_behind(self):
        self.assertEqual([k for k, _ in api.plan_nags(self.at(9), 0, 4, True, {})], ["n0900"])
        self.assertEqual([k for k, _ in api.plan_nags(self.at(11), 0, 4, True, {})], ["n1100"])
        self.assertEqual(api.plan_nags(self.at(11), 1, 4, True, {}), [])
        self.assertEqual([k for k, _ in api.plan_nags(self.at(15), 1, 4, True, {})], ["n1500"])
        self.assertEqual(api.plan_nags(self.at(15), 2, 4, True, {}), [])  # exactly halfway is not behind
        self.assertEqual(api.plan_nags(self.at(18), 3, 4, True, {}), [])

    def test_evening_nags_say_how_many_bottles_to_go(self):
        (kind, text), = api.plan_nags(self.at(20), 1, 4, True, {})
        self.assertEqual(kind, "n2000")
        self.assertTrue(text.startswith("3 bottles to go."))
        (_, text), = api.plan_nags(self.at(20), 3, 4, True, {})
        self.assertTrue(text.startswith("1 bottle to go."))

    def test_every_nag_stops_once_the_goal_is_met_or_he_is_dead(self):
        for h, m in [(9, 0), (11, 0), (13, 0), (15, 0), (18, 0), (20, 0), (21, 0), (22, 30), (23, 30)]:
            self.assertEqual(api.plan_nags(self.at(h, m), 4, 4, True, {}), [], (h, m))
            self.assertEqual(api.plan_nags(self.at(h, m), 0, 4, False, {}), [], (h, m))

    def test_a_late_cron_run_still_sends_but_not_hours_later(self):
        self.assertEqual(len(api.plan_nags(self.at(21, 40), 0, 4, True, {})), 1)
        self.assertEqual(api.plan_nags(self.at(21, 50), 0, 4, True, {}), [])

    def test_aftermath_messages(self):
        morning = self.at(8)
        text = lambda days: dict(api.plan_nags(morning, 0, 4, False, days))
        self.assertIn("RIP that bitch", text(self._days("MX"))["rip1"])
        self.assertIn("serial snail killer", text(self._days("MXX"))["rip2"])
        self.assertIn("slayed", text(self._days("XXX"))["rip3"])
        self.assertIn("Vegas", text(self._days("MMM"))["streak3"])
        self.assertEqual(text(self._days("MM")), {})        # only exactly 3 days alive
        self.assertEqual(text({}), {})
        self.assertEqual(api.plan_nags(morning, 0, 4, True, self._days("MX"), hatched_today=True), [])

    # ---- cron + push
    def _subscribe(self, t, endpoint="https://push.example/abc"):
        return call("POST", "push", t, {"endpoint": endpoint, "keys": {"p256dh": "k", "auth": "a"}})

    def test_push_subscription_roundtrip_and_validation(self):
        t = new_player()
        self.assertEqual(self._subscribe(t)[0], 200)
        self.assertEqual(self._subscribe(t)[0], 200)  # same device again
        self.assertEqual(len(api.get_store().select("sn_push")), 1)
        self.assertEqual(call("POST", "push", t, {"endpoint": "http://insecure", "keys": {"p256dh": "k", "auth": "a"}})[0], 400)
        self.assertEqual(call("POST", "push", t, {"endpoint": "https://x"})[0], 400)
        self.assertEqual(call("DELETE", "push", t, {"endpoint": "https://push.example/abc"})[0], 200)
        self.assertEqual(api.get_store().select("sn_push"), [])

    def test_cron_sends_due_nags_once_and_cleans_dead_subscriptions(self):
        t = new_player()
        self._subscribe(t, "https://push.example/live")
        self._subscribe(t, "https://push.example/dead")
        user = api.get_store().select("sn_users")[0]
        api.get_store().update("sn_users", [("id", "eq", user["id"])], {"time_zone": "UTC"})
        sent = []

        def sender(sub, payload):
            if sub["endpoint"].endswith("dead"):
                raise api.Gone()
            sent.append((sub["endpoint"], payload["body"]))

        today = datetime.now(timezone.utc).date()
        at_eleven = datetime(today.year, today.month, today.day, 11, 5, tzinfo=timezone.utc)
        # snail was hatched "today" in UTC terms, so it is alive and at 0 bottles
        first = api.run_cron(api.get_store(), at_eleven, sender)
        self.assertEqual(first["sent"], 1)
        self.assertEqual(first["removed"], 1)
        self.assertEqual(sent[0][0], "https://push.example/live")
        self.assertIn("thirsty", sent[0][1])
        again = api.run_cron(api.get_store(), at_eleven + timedelta(minutes=15), sender)
        self.assertEqual(again["sent"], 0)  # same nag is never repeated

    def test_cron_requires_its_secret(self):
        os.environ["CRON_SECRET"] = "s3cret"
        os.environ["VAPID_PRIVATE_KEY"] = "x"
        try:
            self.assertEqual(call("POST", "cron")[0], 401)
            self.assertEqual(call("POST", "cron", extra={"x-cron-secret": "nope"})[0], 401)
            os.environ.pop("CRON_SECRET")
            self.assertEqual(call("POST", "cron", extra={"x-cron-secret": ""})[0], 401)  # unset secret never opens it
        finally:
            os.environ.pop("CRON_SECRET", None)
            os.environ.pop("VAPID_PRIVATE_KEY", None)

    def test_config_exposes_only_the_public_key(self):
        os.environ["VAPID_PUBLIC_KEY"] = "pub"
        try:
            self.assertEqual(call("GET", "config")[1], {"vapidPublicKey": "pub"})
        finally:
            os.environ.pop("VAPID_PUBLIC_KEY")
        self.assertEqual(call("GET", "config")[1], {"vapidPublicKey": None})


if __name__ == "__main__":
    unittest.main()
