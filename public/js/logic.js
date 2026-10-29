// Pure rules and formatting. No DOM, no network.
export const OZ_PER_L = 33.814;
export const BOTTLE_OZ = [5, 170];
export const GOAL_OZ = [8, 400];
export const PRESET_GOALS = { women: 73, men: 100 };

export const needed = u => Math.max(1, Math.ceil(u.goalOz / u.bottleOz - 1e-9));

// Stage ladder (handoff section 5). Checked from the top so any goal size works.
export function stageFor(count, need) {
  if (count >= need) return 4;
  if (count === need - 1 && need >= 2) return 3;
  if (count >= need / 2) return 2;
  if (count >= 1) return 1;
  return 0;
}

export const STAGES = [
  { img: "snail-0-thirsty.svg", line: "Damn, he's thirsty.", alt: "Snail Natra, droopy and sweating with his tongue out" },
  { img: "snail-1-diva.svg", line: "One down.", alt: "Snail Natra giving you a heavy-lidded diva look" },
  { img: "snail-2-hat.svg", line: "Looking moist.", alt: "Snail Natra wearing a fedora" },
  { img: "snail-3-bowtie.svg", line: "What's he gonna do?", alt: "Snail Natra in a fedora and bow tie, eyes wide" },
  { img: "snail-4-singing.svg", line: "Oh shit, he's singing.", alt: "Snail Natra singing in a fedora and bow tie, with a saxophone and music notes" },
];

// What the little toast says when a bottle goes in.
export function toastFor(count, need) {
  if (count > need) return "Encore! The crowd goes mild.";
  if (count === need) return "Oh shit, he's singing. Tap to listen.";
  return [
    "",
    "One down. He's still mad, but less.",
    "Looking moist. He found his hat.",
    "What's he gonna do?",
  ][Math.min(stageFor(count, need), 3)] || "One down. He's still mad, but less.";
}

const round1 = n => Math.round(n * 10) / 10;
export const trim = n => String(round1(n));

// Everything is stored in US fl oz; liters are only ever for display and typing.
export const toDisplay = (oz, unit) => (unit === "l" ? round1(oz / OZ_PER_L) : round1(oz));
export const fromDisplay = (v, unit) => (unit === "l" ? v * OZ_PER_L : v);
export const unitLabel = unit => (unit === "l" ? "L" : "oz");
export const vol = (oz, unit) => trim(unit === "l" ? oz / OZ_PER_L : oz);
export const bottlesWord = n => (n === 1 ? "1 bottle" : `${n} bottles`);

export function parseNum(text) {
  const n = parseFloat(String(text).replace(",", "."));
  return Number.isFinite(n) ? n : null;
}

const pad = n => String(n).padStart(2, "0");
export function dayOffset() {
  try { return parseInt(localStorage.getItem("sn.dayOffset") || "0", 10) || 0; } catch { return 0; }  // dev aid only
}
export function localDay(now = new Date()) {
  const d = new Date(now.getFullYear(), now.getMonth(), now.getDate() + dayOffset());
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
}
export function shiftDay(day, delta) {
  const [y, m, d] = day.split("-").map(Number);
  const x = new Date(y, m - 1, d + delta);
  return `${x.getFullYear()}-${pad(x.getMonth() + 1)}-${pad(x.getDate())}`;
}
export function weekday(day) {
  const [y, m, d] = day.split("-").map(Number);
  return new Date(y, m - 1, d).toLocaleDateString(undefined, { weekday: "long" });
}
export function msToMidnight(now = new Date()) {
  return new Date(now.getFullYear(), now.getMonth(), now.getDate() + 1).getTime() - now.getTime();
}

export const timeZone = () => { try { return Intl.DateTimeFormat().resolvedOptions().timeZone || "UTC"; } catch { return "UTC"; } };

export function uuid() {
  if (crypto.randomUUID) return crypto.randomUUID();
  const b = crypto.getRandomValues(new Uint8Array(16));
  b[6] = (b[6] & 0x0f) | 0x40;
  b[8] = (b[8] & 0x3f) | 0x80;
  const h = [...b].map(x => x.toString(16).padStart(2, "0")).join("");
  return `${h.slice(0, 8)}-${h.slice(8, 12)}-${h.slice(12, 16)}-${h.slice(16, 20)}-${h.slice(20)}`;
}

export const esc = s => String(s).replace(/[&<>"']/g, c => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
