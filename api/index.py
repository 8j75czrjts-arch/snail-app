"""Drank Snail Natra API: one Vercel function that fronts Supabase.

The browser never talks to Supabase. It sends a per-user token (the user's id) to this
function, which validates the input and reads or writes the sn_* tables with the
service_role key. Routes arrive as /api?r=<route>, for example /api?r=drinks/<id>.

Env vars:
  SUPABASE_URL, SUPABASE_SERVICE_KEY    required (unless SN_MEMORY=1)
  VAPID_PUBLIC_KEY, VAPID_PRIVATE_KEY   optional, turn on push nags (see README)
  VAPID_SUBJECT                         optional, "mailto:you@example.com"
  CRON_SECRET                           optional, protects /api?r=cron

With SN_MEMORY=1 an in-memory store is used instead, which is what dev_server.py does so the
app can run with no database.
"""
import hmac
import json
import math
import os
import re
import time
import uuid
import urllib.error
import urllib.parse
import urllib.request
from datetime import date, datetime, timedelta, timezone
from http.server import BaseHTTPRequestHandler

try:
    from zoneinfo import ZoneInfo
except ImportError:  # pragma: no cover  (python < 3.9)
    ZoneInfo = None

UUID_RE = re.compile(r"^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$")
DAY_RE = re.compile(r"^\d{4}-\d{2}-\d{2}$")
EMAIL_RE = re.compile(r"^[^@\s]{1,64}@[^@\s]{1,255}\.[^@\s]{2,}$")

BOTTLE_OZ = (5, 170)   # one bottle, US fl oz
GOAL_OZ = (8, 400)     # a day, US fl oz
OZ_PER_L = 33.814


class ApiError(Exception):
    def __init__(self, status, message):
        super().__init__(message)
        self.status = status
        self.message = message


class Gone(Exception):
    """A push subscription the push service says no longer exists."""


# ---------------------------------------------------------------- stores

class SupabaseStore:
    """Minimal PostgREST client. Filters are (column, op, value) tuples."""

    def __init__(self, url, key):
        self.url = url.rstrip("/")
        self.key = key

    def _query(self, filters, extra=None):
        parts = [f"{c}={op}.{urllib.parse.quote(str(v), safe='@.-_:')}" for c, op, v in filters or []]
        parts += extra or []
        return ("?" + "&".join(parts)) if parts else ""

    def _req(self, method, table, query="", body=None, headers=None):
        data = json.dumps(body).encode() if body is not None else None
        req = urllib.request.Request(f"{self.url}/rest/v1/{table}{query}", data=data, method=method)
        req.add_header("apikey", self.key)
        if self.key.startswith("eyJ"):  # legacy service_role JWT; the newer sb_secret_ keys go in apikey only
            req.add_header("Authorization", f"Bearer {self.key}")
        req.add_header("Content-Type", "application/json")
        for k, v in (headers or {}).items():
            req.add_header(k, v)
        try:
            with urllib.request.urlopen(req, timeout=8) as res:
                raw = res.read()
                return json.loads(raw) if raw else None
        except urllib.error.HTTPError as e:
            if e.code == 416 and method == "GET":  # paged past the last row
                return []
            detail = e.read().decode("utf-8", "replace")[:300]
            raise ApiError(409 if e.code == 409 else 502, f"database error: {detail}")
        except urllib.error.URLError as e:
            raise ApiError(502, f"database unreachable: {e.reason}")

    def select(self, table, filters=None, order=None):
        rows, start = [], 0
        while True:  # PostgREST caps a response at 1000 rows, so page through
            extra = [f"order={order}"] if order else []
            page = self._req("GET", table, self._query(filters, extra),
                             headers={"Range-Unit": "items", "Range": f"{start}-{start + 999}"}) or []
            rows += page
            if len(page) < 1000:
                return rows
            start += 1000

    def insert(self, table, rows):
        return self._req("POST", table, "", rows, {"Prefer": "return=representation"}) or []

    def update(self, table, filters, patch):
        return self._req("PATCH", table, self._query(filters), patch, {"Prefer": "return=representation"}) or []

    def delete(self, table, filters):
        self._req("DELETE", table, self._query(filters))

    def upsert(self, table, row, conflict):
        q = self._query([], [f"on_conflict={conflict}"])
        self._req("POST", table, q, [row], {"Prefer": "resolution=merge-duplicates,return=minimal"})


class MemoryStore:
    """Same interface as SupabaseStore, for local development and tests."""

    UNIQUE = {"sn_users": ["email"], "sn_drinks": ["id"], "sn_snails": ["id"], "sn_push": ["endpoint"],
              "sn_nags": ["user_id", "day", "kind"], "sn_days": ["user_id", "day"]}

    def __init__(self):
        self.t = {"sn_users": [], "sn_snails": [], "sn_drinks": [], "sn_days": [], "sn_push": [], "sn_nags": []}
        self._n = 0

    @staticmethod
    def _match(row, filters):
        for c, op, v in filters or []:
            have = row.get(c)
            if op == "eq" and str(have).lower() != str(v).lower():
                return False
            if op == "neq" and str(have).lower() == str(v).lower():
                return False
            if op == "gte" and (have is None or str(have) < str(v)):
                return False
            if op == "lte" and (have is None or str(have) > str(v)):
                return False
            if op == "is" and (have is None) != (str(v) == "null"):
                return False
        return True

    def select(self, table, filters=None, order=None):
        rows = [dict(r) for r in self.t[table] if self._match(r, filters)]
        if order:
            for key in reversed([k.split(".")[0] for k in order.split(",")]):
                rows.sort(key=lambda r: str(r.get(key)))
        return rows

    def insert(self, table, rows):
        out = []
        for r in rows:
            r = dict(r)
            keys = self.UNIQUE.get(table)
            if keys and any(all(str(x.get(k)).lower() == str(r.get(k)).lower() for k in keys) for x in self.t[table]):
                raise ApiError(409, "duplicate")
            self._n += 1
            r.setdefault("created_at", f"{datetime.now(timezone.utc).isoformat()}#{self._n:08d}")
            self.t[table].append(r)
            out.append(dict(r))
        return out

    def update(self, table, filters, patch):
        out = []
        for r in self.t[table]:
            if self._match(r, filters):
                r.update(patch)
                out.append(dict(r))
        return out

    def delete(self, table, filters):
        self.t[table] = [r for r in self.t[table] if not self._match(r, filters)]

    def upsert(self, table, row, conflict):
        keys = conflict.split(",")
        for r in self.t[table]:
            if all(r.get(k) == row.get(k) for k in keys):
                r.update(row)
                return
        self.t[table].append(dict(row))


_store = None


def get_store():
    global _store
    if _store is None:
        if os.environ.get("SN_MEMORY") == "1":
            _store = MemoryStore()
        else:
            url, key = os.environ.get("SUPABASE_URL"), os.environ.get("SUPABASE_SERVICE_KEY")
            if not url or not key:
                raise ApiError(500, "server is missing SUPABASE_URL or SUPABASE_SERVICE_KEY")
            _store = SupabaseStore(url, key)
    return _store


# ---------------------------------------------------------------- validation

def need_uuid(v, what="id"):
    if not isinstance(v, str) or not UUID_RE.match(v):
        raise ApiError(400, f"bad {what}")
    return v


def parse_day(v):
    if not isinstance(v, str) or not DAY_RE.match(v):
        raise ApiError(400, "bad day")
    try:
        return date.fromisoformat(v)
    except ValueError:
        raise ApiError(400, "bad day")


def need_near_today(v, now=None):
    """A client-supplied local day must be within a day or two of the server's UTC date."""
    d = parse_day(v)
    now = now or datetime.now(timezone.utc)
    if abs((d - now.date()).days) > 2:
        raise ApiError(400, "your clock looks off")
    return d


def num_in(v, lo, hi, what):
    try:
        n = float(v)
    except (TypeError, ValueError):
        raise ApiError(400, f"bad {what}")
    if not (lo <= n <= hi) or n != n:
        raise ApiError(400, f"{what} must be between {lo} and {hi}")
    return round(n, 3)


def clean_tz(v):
    if isinstance(v, str) and ZoneInfo and 0 < len(v) < 64:
        try:
            ZoneInfo(v)
            return v
        except Exception:
            pass
    return None


def bottles_needed(user):
    return max(1, math.ceil(float(user["goal_oz"]) / float(user["bottle_oz"]) - 1e-9))


# ---------------------------------------------------------------- game rules

def evaluate(store, user, today):
    """Close out every finished day since the last check. The first day with too few bottles
    kills the current snail (died_on = that day). Returns the user's current snail row or None.

    `today` is the user's local date. Days before it are final; today is still in play."""
    snails = store.select("sn_snails", [("user_id", "eq", user["id"])], "hatched_on.asc,created_at.asc")
    snail = snails[-1] if snails else None
    if not snail or snail.get("died_on"):
        return snail
    hatched = date.fromisoformat(snail["hatched_on"])
    last = user.get("last_evaluated_day")
    start = max(hatched, date.fromisoformat(last) + timedelta(days=1)) if last else hatched
    if start >= today:
        return snail
    rows = store.select("sn_drinks", [("user_id", "eq", user["id"]), ("snail_id", "eq", snail["id"]),
                                      ("day", "gte", start.isoformat()), ("day", "lte", (today - timedelta(days=1)).isoformat())])
    per_day = {}
    for r in rows:
        n, oz = per_day.get(r["day"], (0, 0.0))
        per_day[r["day"]] = (n + 1, oz + float(r["amount_oz"]))
    needed = bottles_needed(user)
    d, evaluated = start, None
    while d < today:
        n, oz = per_day.get(d.isoformat(), (0, 0.0))
        met = n >= needed
        store.upsert("sn_days", {"user_id": user["id"], "day": d.isoformat(), "bottles": n,
                                 "oz": round(oz, 3), "needed": needed, "goal_met": met}, "user_id,day")
        evaluated = d
        if not met:
            store.update("sn_snails", [("id", "eq", snail["id"])], {"died_on": d.isoformat()})
            snail["died_on"] = d.isoformat()
            break
        d += timedelta(days=1)
    if evaluated:
        store.update("sn_users", [("id", "eq", user["id"])], {"last_evaluated_day": evaluated.isoformat()})
        user["last_evaluated_day"] = evaluated.isoformat()
    return snail


def hatch(store, user, today):
    """Start a new snail today unless one is already alive. Returns the current snail row."""
    snails = store.select("sn_snails", [("user_id", "eq", user["id"])], "hatched_on.asc,created_at.asc")
    if snails and not snails[-1].get("died_on"):
        return snails[-1]
    row = {"id": str(uuid.uuid4()), "user_id": user["id"], "hatched_on": today.isoformat(), "died_on": None}
    store.insert("sn_snails", [row])
    prev = (today - timedelta(days=1)).isoformat()
    store.update("sn_users", [("id", "eq", user["id"])], {"last_evaluated_day": prev})
    user["last_evaluated_day"] = prev
    return row


def run_length(days, end, want_met):
    """How many calendar days in a row, counting back from `end`, had the wanted outcome."""
    n, d = 0, end
    while d.isoformat() in days and days[d.isoformat()]["goal_met"] == want_met:
        n += 1
        d -= timedelta(days=1)
    return n


# ---------------------------------------------------------------- wire format

def user_out(u):
    return {"email": u["email"], "unit": u["unit"], "bottleOz": float(u["bottle_oz"]), "goalOz": float(u["goal_oz"]),
            "musicApp": u["music_app"], "onboarded": bool(u["onboarded"])}


def state_out(store, user, snail, today):
    drinks, dead = [], None
    if snail and not snail.get("died_on"):
        rows = store.select("sn_drinks", [("user_id", "eq", user["id"]), ("snail_id", "eq", snail["id"]),
                                          ("day", "eq", today.isoformat())], "created_at.asc")
        drinks = [{"id": r["id"], "amountOz": float(r["amount_oz"])} for r in rows]
    if snail and snail.get("died_on"):
        res = store.select("sn_days", [("user_id", "eq", user["id"]), ("day", "eq", snail["died_on"])])
        r = res[0] if res else {"bottles": 0, "oz": 0, "needed": bottles_needed(user)}
        dead = {"day": snail["died_on"], "bottles": r["bottles"], "oz": float(r["oz"]), "needed": r["needed"]}
    return {"user": user_out(user), "today": today.isoformat(), "needed": bottles_needed(user),
            "snail": {"id": snail["id"], "hatchedOn": snail["hatched_on"], "diedOn": snail.get("died_on")} if snail else None,
            "drinks": drinks, "dead": dead}


# ---------------------------------------------------------------- push nags

def _plural(n):
    return f"{n} bottle" if n == 1 else f"{n} bottles"


# (kind, hour, minute, condition(count, needed), text(count, needed)). Every one also needs count < needed.
NAGS = [
    ("n0900", 9, 0, lambda c, n: True, lambda c, n: "Good morning. Snail Natra is parched and he's not happy about it."),
    ("n1100", 11, 0, lambda c, n: c == 0, lambda c, n: "Damn, he's thirsty. Not one drop? Really?"),
    ("n1300", 13, 0, lambda c, n: c < 1, lambda c, n: "His agent called. He wants water. Now."),
    ("n1500", 15, 0, lambda c, n: c < n / 2, lambda c, n: "He's drying out like a raisin. Drink something."),
    ("n1800", 18, 0, lambda c, n: c < n / 2, lambda c, n: "It's getting late and he's getting crispy."),
    ("n2000", 20, 0, lambda c, n: True, lambda c, n: f"{_plural(n - c)} to go. He's already in costume. Don't embarrass him."),
    ("n2100", 21, 0, lambda c, n: True, lambda c, n: "Snail Natra has 3 hours to live."),
    ("n2230", 22, 30, lambda c, n: True, lambda c, n: "Snail Natra is fucking dying."),
    ("n2330", 23, 30, lambda c, n: True, lambda c, n: "Last call. He's writing his will. You're not in it."),
]
NAG_WINDOW_MIN = 45   # a nag still goes out if the cron run is up to this late
QUIET_BEFORE_MIN = 8 * 60


def plan_nags(local_now, count, needed, alive, days, hatched_today=False):
    """Pure: what should be sent right now? Returns [(kind, text)].

    `days` maps 'YYYY-MM-DD' -> sn_days row. Nothing is returned before 8 AM, and nothing but the
    8 AM aftermath is returned for a dead snail. `hatched_today` mutes the aftermath (already handled)."""
    minutes = local_now.hour * 60 + local_now.minute
    if minutes < QUIET_BEFORE_MIN:
        return []
    out = []
    if minutes < 8 * 60 + NAG_WINDOW_MIN and not hatched_today:
        yesterday = local_now.date() - timedelta(days=1)
        y = days.get(yesterday.isoformat())
        if y is not None and not y["goal_met"]:
            dead_run = run_length(days, yesterday, False)
            if dead_run >= 3:
                out.append(("rip3", "Another day, another diva… slayed."))
            elif dead_run == 2:
                out.append(("rip2", "Another one? You're a serial snail killer."))
            else:
                out.append(("rip1", "RIP that bitch. Tap to hatch a new one."))
        elif y is not None and run_length(days, yesterday, True) == 3:
            out.append(("streak3", "3 days alive. He's talking about a Vegas residency."))
    if alive and count < needed:
        for kind, h, m, cond, text in NAGS:
            t = h * 60 + m
            if t <= minutes < t + NAG_WINDOW_MIN and cond(count, needed):
                out.append((kind, text(count, needed)))
    return out


def webpush_sender(sub, payload):
    from pywebpush import webpush, WebPushException  # only needed when push is configured
    try:
        webpush(subscription_info={"endpoint": sub["endpoint"], "keys": {"p256dh": sub["p256dh"], "auth": sub["auth"]}},
                data=json.dumps(payload), vapid_private_key=os.environ["VAPID_PRIVATE_KEY"],
                vapid_claims={"sub": os.environ.get("VAPID_SUBJECT", "mailto:snail@example.com")}, ttl=1800)
    except WebPushException as e:
        if e.response is not None and e.response.status_code in (404, 410):
            raise Gone()
        raise


def run_cron(store, now_utc=None, sender=None):
    """Called every ~15 minutes. Sends whatever nags are due to every subscribed device."""
    now_utc = now_utc or datetime.now(timezone.utc)
    sender = sender or webpush_sender
    subs_by_user = {}
    for s in store.select("sn_push"):
        subs_by_user.setdefault(s["user_id"], []).append(s)
    sent = dead_subs = 0
    for uid, subs in subs_by_user.items():
        users = store.select("sn_users", [("id", "eq", uid)])
        if not users or not users[0]["onboarded"]:
            continue
        user = users[0]
        tz = clean_tz(user["time_zone"]) or "UTC"
        local = now_utc.astimezone(ZoneInfo(tz))
        today = local.date()
        try:
            snail = evaluate(store, user, today)
            alive = bool(snail and not snail.get("died_on"))
            count = 0
            if alive:
                count = len(store.select("sn_drinks", [("user_id", "eq", uid), ("snail_id", "eq", snail["id"]),
                                                       ("day", "eq", today.isoformat())]))
            days = {r["day"]: r for r in store.select("sn_days", [("user_id", "eq", uid),
                                                                  ("day", "gte", (today - timedelta(days=10)).isoformat())])}
            hatched_today = bool(alive and snail["hatched_on"] >= today.isoformat())
            for kind, text in plan_nags(local, count, bottles_needed(user), alive, days, hatched_today):
                key = [("user_id", "eq", uid), ("day", "eq", today.isoformat()), ("kind", "eq", kind)]
                if store.select("sn_nags", key):
                    continue
                store.insert("sn_nags", [{"user_id": uid, "day": today.isoformat(), "kind": kind}])
                for sub in subs:
                    try:
                        sender(sub, {"title": "Snail Natra", "body": text, "tag": kind, "url": "/"})
                        sent += 1
                    except Gone:
                        store.delete("sn_push", [("endpoint", "eq", sub["endpoint"])])
                        dead_subs += 1
                    except Exception as e:  # one bad device must not stop the rest
                        print("push failed:", repr(e))
        except ApiError as e:
            print("cron skipped a user:", e.message)
    return {"users": len(subs_by_user), "sent": sent, "removed": dead_subs}


# ---------------------------------------------------------------- routes

def handle(method, route, headers, query, body, store=None):
    """Returns (status, json-able). `body` is the parsed JSON body or None."""
    store = store or get_store()
    parts = [p for p in route.strip("/").split("/") if p]
    body = body if isinstance(body, dict) else {}
    head = parts[0] if parts else ""

    if (method, head) == ("GET", "config"):
        return 200, {"vapidPublicKey": os.environ.get("VAPID_PUBLIC_KEY") or None}

    if head == "cron":
        secret = os.environ.get("CRON_SECRET")
        given = headers.get("x-cron-secret") or (headers.get("authorization") or "").removeprefix("Bearer ")
        if not secret or not hmac.compare_digest(given or "", secret):
            raise ApiError(401, "no")
        if not os.environ.get("VAPID_PRIVATE_KEY"):
            raise ApiError(500, "push is not configured")
        return 200, run_cron(store)

    if (method, head) == ("POST", "login"):
        email = str(body.get("email") or "").strip().lower()
        if not EMAIL_RE.match(email):
            raise ApiError(400, "enter a valid email")
        tz = clean_tz(body.get("tz")) or "UTC"
        found = store.select("sn_users", [("email", "eq", email)])
        if found:
            return 200, {"token": found[0]["id"], "user": user_out(found[0]), "isNew": False}
        row = {"id": str(uuid.uuid4()), "email": email, "unit": "oz", "bottle_oz": 20, "goal_oz": 73,
               "music_app": "apple", "time_zone": tz, "onboarded": False}
        try:
            store.insert("sn_users", [row])
        except ApiError as e:
            if e.status != 409:
                raise
            row = store.select("sn_users", [("email", "eq", email)])[0]  # lost a signup race
            return 200, {"token": row["id"], "user": user_out(row), "isNew": False}
        return 200, {"token": row["id"], "user": user_out(row), "isNew": True}

    token = headers.get("x-token")
    uid = need_uuid(token, "token") if token else None
    users = store.select("sn_users", [("id", "eq", uid)]) if uid else []
    if not users:
        raise ApiError(401, "signed out")
    user = users[0]
    mine = [("user_id", "eq", uid)]

    if (method, head) == ("GET", "state"):
        today = need_near_today((query.get("today") or [""])[0])
        tz = clean_tz((query.get("tz") or [""])[0])
        if tz and tz != user["time_zone"]:
            store.update("sn_users", [("id", "eq", uid)], {"time_zone": tz})
            user["time_zone"] = tz
        snail = evaluate(store, user, today)
        return 200, state_out(store, user, snail, today)

    if (method, head) == ("PUT", "settings"):
        patch = {}
        if "unit" in body:
            if body["unit"] not in ("oz", "l"):
                raise ApiError(400, "bad unit")
            patch["unit"] = body["unit"]
        if "bottleOz" in body:
            patch["bottle_oz"] = num_in(body["bottleOz"], *BOTTLE_OZ, "bottle size")
        if "goalOz" in body:
            patch["goal_oz"] = num_in(body["goalOz"], *GOAL_OZ, "daily goal")
        if "musicApp" in body:
            if body["musicApp"] not in ("apple", "spotify"):
                raise ApiError(400, "bad music app")
            patch["music_app"] = body["musicApp"]
        if "onboarded" in body:
            patch["onboarded"] = bool(body["onboarded"])
        if clean_tz(body.get("tz")):
            patch["time_zone"] = body["tz"]
        if patch:
            store.update("sn_users", [("id", "eq", uid)], patch)
            user.update(patch)
        return 200, {"user": user_out(user), "needed": bottles_needed(user)}

    if (method, head) == ("POST", "hatch"):
        today = need_near_today(body.get("today"))
        evaluate(store, user, today)
        hatch(store, user, today)
        snail = evaluate(store, user, today)
        return 200, state_out(store, user, snail, today)

    if (method, head) == ("POST", "drinks"):
        did = need_uuid(body.get("id"))
        day = need_near_today(body.get("day"))
        oz = num_in(body.get("amountOz"), 0.5, BOTTLE_OZ[1], "amount")
        snails = store.select("sn_snails", mine, "hatched_on.asc,created_at.asc")
        if not snails or snails[-1].get("died_on"):
            raise ApiError(409, "dead")
        row = {"id": did, "user_id": uid, "snail_id": snails[-1]["id"], "day": day.isoformat(), "amount_oz": oz}
        try:
            store.insert("sn_drinks", [row])
        except ApiError as e:
            if e.status != 409:  # same id again is a retry of a request that already landed
                raise
        return 200, {"ok": True}

    if head == "drinks" and len(parts) == 2 and method == "DELETE":
        store.delete("sn_drinks", mine + [("id", "eq", need_uuid(parts[1]))])
        return 200, {"ok": True}

    if (method, head) == ("POST", "push"):
        keys = body.get("keys") if isinstance(body.get("keys"), dict) else {}
        endpoint, p256dh, auth = body.get("endpoint"), keys.get("p256dh"), keys.get("auth")
        if not all(isinstance(x, str) and 0 < len(x) < 600 for x in (endpoint, p256dh, auth)) or not endpoint.startswith("https://"):
            raise ApiError(400, "bad subscription")
        store.upsert("sn_push", {"endpoint": endpoint, "user_id": uid, "p256dh": p256dh, "auth": auth}, "endpoint")
        return 200, {"ok": True}

    if (method, head) == ("DELETE", "push"):
        endpoint = body.get("endpoint")
        if isinstance(endpoint, str) and endpoint:
            store.delete("sn_push", mine + [("endpoint", "eq", endpoint)])
        return 200, {"ok": True}

    raise ApiError(404, "not found")


def respond(method, raw_path, headers, raw_body):
    headers = {k.lower(): v for k, v in (headers or {}).items()}
    parsed = urllib.parse.urlparse(raw_path)
    query = urllib.parse.parse_qs(parsed.query)
    route = (query.get("r") or [""])[0]
    try:
        body = json.loads(raw_body) if raw_body else None
    except ValueError:
        return 400, {"error": "bad json"}
    try:
        return handle(method, route, headers, query, body)
    except ApiError as e:
        return e.status, {"error": e.message}
    except Exception as e:  # never leak a traceback to the client
        print("api error:", repr(e))
        return 500, {"error": "server error"}


class handler(BaseHTTPRequestHandler):
    """Vercel's Python runtime looks for a class named `handler`."""

    def _run(self):
        n = int(self.headers.get("content-length") or 0)
        raw = self.rfile.read(n) if n else b""
        status, payload = respond(self.command, self.path, dict(self.headers.items()), raw)
        out = json.dumps(payload).encode()
        self.send_response(status)
        self.send_header("Content-Type", "application/json")
        self.send_header("Cache-Control", "no-store")
        self.send_header("Content-Length", str(len(out)))
        self.end_headers()
        self.wfile.write(out)

    do_GET = do_POST = do_PUT = do_DELETE = _run

    def log_message(self, *args):
        pass
