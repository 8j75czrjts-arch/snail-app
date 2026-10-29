// Wires the screens (views.js) to the state (state.js). One delegated listener handles every tap.
import { S, onChange, boot, sync, logIn, signOut, glug, undo, setSettings, finishSetup, hatchNew, need, count, isDead } from "./state.js";
import { view } from "./views.js";
import { toastFor, localDay, msToMidnight, parseNum, fromDisplay, toDisplay, trim, unitLabel, needed, bottlesWord,
  BOTTLE_OZ, GOAL_OZ, PRESET_GOALS } from "./logic.js";
import * as music from "./music.js";
import * as notify from "./notify.js";

const root = document.getElementById("app");
const toastEl = document.getElementById("toast");
const EMAIL_RE = /^[^@\s]{1,64}@[^@\s]{1,255}\.[^@\s]{2,}$/;
const ASKED_KEY = "sn.askedPush";

// ---------------------------------------------------------------- rendering

let lastScreen = "";
function render() {
  const active = document.activeElement;
  const refocus = active && root.contains(active) && active.dataset ? active.dataset.act : null;
  const y = window.scrollY;
  if (S.screen === "setup" && !S.setup) initSetup();
  ensureSong();
  const key = `${S.screen}/${S.tab}/${isDead()}`;
  root.innerHTML = view();
  document.body.classList.toggle("dead", S.screen === "main" && S.tab === "snail" && isDead());
  S.fx = null;
  if (key !== lastScreen) { window.scrollTo(0, 0); lastScreen = key; } else window.scrollTo(0, y);
  if (refocus) { const el = root.querySelector(`[data-act="${refocus}"]`); if (el) el.focus({ preventScroll: true }); }
}

// State changes that arrive from the network must not wipe a field someone is typing in.
let renderLater = false;
onChange(() => {
  if (document.activeElement && document.activeElement.tagName === "INPUT" && root.contains(document.activeElement)) { renderLater = true; return; }
  render();
});
root.addEventListener("focusout", () => { if (renderLater) { renderLater = false; setTimeout(render, 0); } });

let toastTimer;
function toast(text) {
  toastEl.textContent = text;
  toastEl.classList.add("show");
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => toastEl.classList.remove("show"), 2800);
}

// ---------------------------------------------------------------- song at the goal

function ensureSong() {
  const atGoal = S.screen === "main" && S.user && !isDead() && count() >= need();
  if (!atGoal) { S.song = null; return; }
  if (!S.song) S.song = music.songFor(S.today); // after a reopen: same card, no replay
}

// Runs inside the tap that logged the last bottle, which is the only time a browser lets sound start.
function goalHit() {
  const song = music.songsReady() ? music.pickSong(music.lastSongId()) : null;
  S.song = song;
  if (!song) return;
  music.rememberSong(S.today, song);
  S.audio = "starting";
  music.play(song, () => { if (S.audio === "playing") { S.audio = "idle"; render(); } }).then(ok => {
    S.audio = ok ? "playing" : "blocked";
    render();
  });
}

// ---------------------------------------------------------------- setup helpers

const rangeText = ([lo, hi], unit) => {
  const l = unit === "l" ? Math.ceil((lo / 33.814) * 10) / 10 : lo;
  const h = unit === "l" ? Math.floor((hi / 33.814) * 10) / 10 : hi;
  return `${l}–${h} ${unitLabel(unit)}`;
};
const inRange = (oz, [lo, hi]) => oz != null && oz >= lo - 1e-9 && oz <= hi + 1e-9;
const round2 = n => Math.round(n * 100) / 100;

function initSetup() {
  const u = S.user;
  S.setup = { unit: u.unit, bottleOz: u.bottleOz, goalOz: u.goalOz === PRESET_GOALS.men ? PRESET_GOALS.men : PRESET_GOALS.women, bottleText: trim(toDisplay(u.bottleOz, u.unit)) };
  S.setup.needed = needed({ bottleOz: S.setup.bottleOz, goalOz: S.setup.goalOz });
}

function setupRecalc() {
  const st = S.setup;
  st.needed = inRange(st.bottleOz, BOTTLE_OZ) ? needed(st) : null;
  const result = root.querySelector("#setup-result");
  if (result) result.textContent = `= ${st.needed == null ? "? bottles" : bottlesWord(st.needed)} a day`;
  const btn = root.querySelector('[data-act="hatch-first"]');
  if (btn) btn.setAttribute("aria-disabled", String(st.needed == null || !!S.busy));
}

// ---------------------------------------------------------------- actions

const actions = {
  "go-welcome"() { S.screen = "welcome"; S.error = ""; render(); },
  "go-email"() {
    if (S.token && S.user && !S.user.onboarded) { initSetup(); S.screen = "setup"; render(); return; }
    S.screen = "email"; S.error = ""; render();
    root.querySelector("#email")?.focus();
  },

  async "hatch-first"() {
    const st = S.setup;
    if (st.needed == null || S.busy) {
      const err = root.querySelector("#setup-err");
      if (err) err.textContent = `How big is it? ${rangeText(BOTTLE_OZ, st.unit)}, please.`;
      return;
    }
    S.busy = true; render();
    try {
      await finishSetup({ unit: st.unit, bottleOz: round2(st.bottleOz), goalOz: st.goalOz });
      S.busy = false; S.song = null; S.screen = "hatched"; render();
    } catch (e) {
      S.busy = false; render();
      const err = root.querySelector("#setup-err");
      if (err) err.textContent = e.message;
    }
  },

  async start() {
    S.screen = "main"; S.tab = "snail"; render();
    // ask for notifications once, right after he hatches (the tap is the gesture the browser wants)
    let asked = false;
    try { asked = !!localStorage.getItem(ASKED_KEY); localStorage.setItem(ASKED_KEY, "1"); } catch { /* private mode */ }
    if (!asked) await notify.enable();
  },

  glug() {
    if (S.today !== localDay()) { sync(); return; } // the day rolled over while the app sat open
    const r = glug();
    if (!r) return;
    S.fx = { wobble: true, fill: true };
    if (navigator.vibrate) navigator.vibrate(12);
    toast(toastFor(r.now, need()));
    if (r.before < need() && r.now >= need()) goalHit();
    render();
  },

  undo() {
    const r = undo();
    if (!r) return;
    if (r.before >= need() && r.now < need()) { music.stop(); S.audio = "idle"; S.song = null; }
    S.fx = { wobble: true };
    render();
  },

  async song(el, e) {
    if (S.audio === "blocked" && S.song && S.song.preview) { // autoplay was refused: this tap is allowed to play it
      e.preventDefault();
      S.audio = "starting";
      const ok = await music.play(S.song, () => { S.audio = "idle"; render(); });
      S.audio = ok ? "playing" : "idle";
      render();
    }
  },

  tab(el) {
    S.tab = el.dataset.tab;
    render();
    if (S.tab === "settings") notify.status().then(s => { if (s !== S.nags) { S.nags = s; if (S.tab === "settings") render(); } });
  },

  unit(el) {
    const unit = el.dataset.unit;
    if (S.screen === "setup") {
      S.setup.unit = unit;
      if (S.setup.bottleOz != null) S.setup.bottleText = trim(toDisplay(S.setup.bottleOz, unit));
    } else if (S.user.unit !== unit) {
      setSettings({ unit });
    }
    render();
  },

  goal(el) {
    S.setup.goalOz = PRESET_GOALS[el.dataset.goal];
    setupRecalc();
    render();
  },

  music(el) { setSettings({ musicApp: el.dataset.app }); render(); },

  async "hatch-new"() {
    if (S.busy) return;
    S.busy = true; render();
    try { await hatchNew(); S.song = null; S.audio = "idle"; S.screen = "hatched"; }
    catch (e) { toast(e.message); }
    S.busy = false; render();
  },

  async "nags-on"() { await notify.enable(); S.nags = await notify.status(); render(); },
  async "nags-off"() { await notify.disable(); S.nags = await notify.status(); render(); },

  async logout() {
    if (!confirm("Log out? Your snail will wait for you.")) return;
    music.stop();
    await Promise.race([notify.forget(), new Promise(r => setTimeout(r, 1500))]); // never let this hold up signing out
    S.setup = S.song = S.nags = null;
    S.emailDraft = "";
    await signOut();
  },

  retry() { S.screen = "boot"; render(); boot(); },
};

root.addEventListener("click", e => {
  const el = e.target.closest("[data-act]");
  if (el && actions[el.dataset.act] && el.getAttribute("aria-disabled") !== "true") actions[el.dataset.act](el, e);
});

// ---------------------------------------------------------------- forms and fields

root.addEventListener("submit", async e => {
  e.preventDefault();
  if (e.target.dataset.form !== "email" || S.busy) return;
  const input = root.querySelector("#email");
  const email = input.value.trim().toLowerCase();
  S.emailDraft = email;
  if (!EMAIL_RE.test(email)) { S.error = "That doesn’t look like an email."; render(); root.querySelector("#email").focus(); return; }
  S.error = ""; S.busy = true; input.blur(); render();
  try {
    const res = await logIn(email);
    S.busy = false;
    if (res.user.onboarded) { S.screen = "boot"; render(); await sync(); }
    else { initSetup(); S.screen = "setup"; render(); }
  } catch (err) {
    S.busy = false;
    S.error = err.status === 0 ? "No connection. Try again?" : err.message;
    render();
  }
});

root.addEventListener("input", e => {
  const el = e.target;
  if (el.id === "email") { S.emailDraft = el.value; return; }

  if (el.id === "sbottle") {
    const st = S.setup;
    st.bottleText = el.value;
    const v = parseNum(el.value);
    st.bottleOz = v == null ? null : fromDisplay(v, st.unit);
    el.setAttribute("aria-invalid", String(!inRange(st.bottleOz, BOTTLE_OZ)));
    root.querySelector("#setup-err").textContent = "";
    setupRecalc();
    return;
  }

  if (el.id === "bottle" || el.id === "goal") {
    const field = el.id === "bottle" ? "bottleOz" : "goalOz";
    const lim = el.id === "bottle" ? BOTTLE_OZ : GOAL_OZ;
    const v = parseNum(el.value);
    const oz = v == null ? null : round2(fromDisplay(v, S.user.unit));
    const ok = inRange(oz, lim);
    el.setAttribute("aria-invalid", String(!ok));
    root.querySelector("#settings-err").textContent = "";
    if (!ok) return;
    setSettings({ [field]: oz });
    root.querySelector("#settings-result").textContent = `= ${bottlesWord(need())} a day`;
  }
});

// On leaving a field: say what is wrong, or tidy the number back to what is saved.
root.addEventListener("change", e => {
  const el = e.target;
  if (el.id === "sbottle") {
    const st = S.setup;
    if (inRange(st.bottleOz, BOTTLE_OZ)) el.value = st.bottleText = trim(toDisplay(st.bottleOz, st.unit));
    else root.querySelector("#setup-err").textContent = `Pick something between ${rangeText(BOTTLE_OZ, st.unit)}.`;
  }
  if (el.id === "bottle" || el.id === "goal") {
    const field = el.id === "bottle" ? "bottleOz" : "goalOz";
    const lim = el.id === "bottle" ? BOTTLE_OZ : GOAL_OZ;
    const v = parseNum(el.value);
    if (inRange(v == null ? null : fromDisplay(v, S.user.unit), lim)) el.value = trim(toDisplay(S.user[field], S.user.unit));
    else {
      root.querySelector("#settings-err").textContent = `Pick something between ${rangeText(lim, S.user.unit)}.`;
      el.value = trim(toDisplay(S.user[field], S.user.unit));
      el.setAttribute("aria-invalid", "false");
    }
  }
});

// ---------------------------------------------------------------- staying fresh

let lastSync = Date.now();
const syncSoon = () => { lastSync = Date.now(); return sync(); };
document.addEventListener("visibilitychange", () => {
  if (document.visibilityState !== "visible" || !S.token) return;
  if (S.today !== localDay() || Date.now() - lastSync > 30000) syncSoon();
});
addEventListener("online", () => { if (S.token) syncSoon(); });

// Midnight is when he can die, so look again the moment the day turns over.
function watchMidnight() {
  setTimeout(() => { if (S.token) syncSoon(); watchMidnight(); }, msToMidnight() + 1500);
}

// ---------------------------------------------------------------- go

// Keep every picture decoded in memory so a re-render never flashes an empty frame.
const kept = [];
["snail/snail-0-thirsty", "snail/snail-1-diva", "snail/snail-2-hat", "snail/snail-3-bowtie", "snail/snail-4-singing",
  "snail/snail-dead", "snail/snail-baby-swaddle", "bottles/bottle-full", "bottles/bottle-empty", "ui/eq-bars"]
  .forEach(n => { const i = new Image(); i.src = `/assets/${n}.svg`; kept.push(i); });

if ("serviceWorker" in navigator && (location.hostname !== "localhost" || location.search.includes("sw"))) {
  navigator.serviceWorker.register("/sw.js").catch(() => {});
}

render();
boot().then(() => {
  lastSync = Date.now();
  if (S.token && S.user) notify.refresh();
});
music.loadSongs().then(() => { if (S.screen === "main" && document.activeElement?.tagName !== "INPUT") render(); });
notify.status();
watchMidnight();
