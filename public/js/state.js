// App state, the offline outbox and syncing with the API.
//
// Logging a bottle or changing a setting updates the screen at once and queues a request. The
// queue is replayed in order whenever there is a connection. Every request is safe to repeat
// (drinks carry a client-made id), so a retry after a dropped connection never double counts.
import { api, getToken, setToken, ApiError } from "./api.js";
import { localDay, needed, timeZone, uuid, BOTTLE_OZ, GOAL_OZ } from "./logic.js";

const CACHE_KEY = "sn.cache";
const OUTBOX_KEY = "sn.outbox";

export const S = {
  token: getToken(),
  user: null,        // { email, unit, bottleOz, goalOz, musicApp, onboarded }
  snail: null,       // { id, hatchedOn, diedOn }
  drinks: [],        // today's bottles for the current snail: [{ id, amountOz }]
  dead: null,        // { day, bottles, oz, needed } once he has died
  today: null,
  screen: "boot",    // boot | welcome | email | setup | hatched | main | error
  tab: "snail",      // snail | settings
  offline: false,
  error: "",
};

const listeners = new Set();
export const onChange = fn => listeners.add(fn);
const emit = () => listeners.forEach(fn => fn());

const read = k => { try { return JSON.parse(localStorage.getItem(k)); } catch { return null; } };
const write = (k, v) => { try { v == null ? localStorage.removeItem(k) : localStorage.setItem(k, JSON.stringify(v)); } catch { /* private mode */ } };

let outbox = read(OUTBOX_KEY) || [];

function persist() {
  write(OUTBOX_KEY, outbox.length ? outbox : null);
  if (S.user) write(CACHE_KEY, { user: S.user, snail: S.snail, drinks: S.drinks, dead: S.dead, today: S.today });
}

// ---------------------------------------------------------------- derived

export const need = () => (S.user ? needed(S.user) : 4);
export const count = () => S.drinks.length;
export const ozSoFar = () => S.drinks.reduce((n, d) => n + d.amountOz, 0);
export const isDead = () => !!(S.snail && S.snail.diedOn);

// ---------------------------------------------------------------- outbox

function queue(op) {
  if (op.op === "settings") {
    const existing = outbox.find(o => o.op === "settings");
    if (existing) { Object.assign(existing.patch, op.patch); persist(); scheduleFlush(); return; }
  }
  outbox.push(op);
  persist();
  scheduleFlush();
}

async function send(op) {
  if (op.op === "add") return api("POST", "drinks", { id: op.id, day: op.day, amountOz: op.amountOz });
  if (op.op === "rm") return api("DELETE", `drinks/${op.id}`);
  if (op.op === "settings") return api("PUT", "settings", op.patch);
}

let flushing = null;
export function flush() {
  if (flushing) return flushing;
  flushing = (async () => {
    while (outbox.length) {
      try {
        await send(outbox[0]);
      } catch (e) {
        if (e instanceof ApiError && e.status === 401) { await signOut(); return false; }
        if (!(e instanceof ApiError) || e.status === 0 || e.status >= 500) { S.offline = true; emit(); return false; }
        // a 4xx means the server will never accept it (for example a bottle for a snail that has died)
      }
      outbox.shift();
      persist();
    }
    S.offline = false;
    return true;
  })().finally(() => { flushing = null; });
  return flushing;
}

let flushTimer;
function scheduleFlush() {
  clearTimeout(flushTimer);
  flushTimer = setTimeout(() => flush().then(ok => ok && emit()), 400);
}

// Put not-yet-sent changes back on top of whatever the server just told us.
function replayOutbox() {
  for (const op of outbox) {
    if (op.op === "add" && op.day === S.today && !S.drinks.some(d => d.id === op.id) && !isDead()) S.drinks.push({ id: op.id, amountOz: op.amountOz });
    if (op.op === "rm") S.drinks = S.drinks.filter(d => d.id !== op.id);
    if (op.op === "settings" && S.user) Object.assign(S.user, op.patch);
  }
}

// ---------------------------------------------------------------- sync

function apply(st) {
  S.user = st.user;
  S.snail = st.snail;
  S.drinks = st.drinks;
  S.dead = st.dead;
  S.today = st.today;
  replayOutbox();
  persist();
}

function route() {
  if (!S.user) return;
  if (!S.user.onboarded) { if (!["email", "setup"].includes(S.screen)) S.screen = "setup"; return; }
  if (["boot", "welcome", "email", "setup", "error"].includes(S.screen)) S.screen = "main";
}

let inflight = null;
export function sync() {
  if (!S.token) return Promise.resolve();
  if (inflight) return inflight;
  inflight = (async () => {
    try {
      if (!(await flush()) && !S.token) return;
      const st = await api("GET", "state", undefined, { today: localDay(), tz: timeZone() });
      apply(st);
      S.offline = false;
      if (S.user.onboarded && !S.snail) apply(await api("POST", "hatch", { today: localDay() }));
      route();
    } catch (e) {
      if (e instanceof ApiError && e.status === 401) { await signOut(); return; }
      S.offline = true;
      if (!S.user) { S.screen = "error"; S.error = e.message; }
      else route();
    } finally {
      inflight = null;
      emit();
    }
  })();
  return inflight;
}

// Open from the last known state so the app is instant (and still opens with no signal).
export function boot() {
  if (!S.token) { S.screen = "welcome"; emit(); return Promise.resolve(); }
  const c = read(CACHE_KEY);
  if (c && c.user && c.today === localDay()) {
    Object.assign(S, { user: c.user, snail: c.snail, drinks: c.drinks, dead: c.dead, today: c.today });
    replayOutbox();
    route();
  } else if (c && c.user) {
    S.user = c.user; // keep the settings handy, but his day is unknown until we hear back
  }
  emit();
  return sync();
}

// ---------------------------------------------------------------- accounts

export async function logIn(email) {
  const res = await api("POST", "login", { email, tz: timeZone() });
  S.token = res.token;
  setToken(res.token);
  S.user = res.user;
  return res;
}

export async function signOut() {
  S.token = null;
  setToken(null);
  outbox = [];
  Object.assign(S, { user: null, snail: null, drinks: [], dead: null, today: null, screen: "welcome", tab: "snail", offline: false });
  write(CACHE_KEY, null);
  write(OUTBOX_KEY, null);
  emit();
}

// ---------------------------------------------------------------- actions

// Returns { before, now } so the caller can play the song if this bottle hit the goal.
export function glug() {
  if (!S.user || isDead()) return null;
  const before = count();
  const d = { id: uuid(), amountOz: S.user.bottleOz };
  S.drinks.push(d);
  queue({ op: "add", id: d.id, day: S.today, amountOz: d.amountOz });
  return { before, now: count() };
}

export function undo() {
  const d = S.drinks[S.drinks.length - 1];
  if (!d) return null;
  const before = count();
  S.drinks.pop();
  const pending = outbox.findIndex(o => o.op === "add" && o.id === d.id);
  if (pending >= 0) { outbox.splice(pending, 1); persist(); } // never reached the server, so just forget it
  else queue({ op: "rm", id: d.id });
  return { before, now: count() };
}

// patch uses the wire names: unit, bottleOz, goalOz, musicApp.
export function setSettings(patch) {
  Object.assign(S.user, patch);
  queue({ op: "settings", patch: { ...patch } });
}

export async function finishSetup({ unit, bottleOz, goalOz }) {
  const settings = { unit, bottleOz, goalOz, onboarded: true, tz: timeZone() };
  await api("PUT", "settings", settings);
  Object.assign(S.user, { unit, bottleOz, goalOz, onboarded: true });
  apply(await api("POST", "hatch", { today: localDay() }));
}

export async function hatchNew() {
  apply(await api("POST", "hatch", { today: localDay() }));
}

export const limits = { bottle: BOTTLE_OZ, goal: GOAL_OZ };
