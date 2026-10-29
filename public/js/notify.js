// Web push for the nag schedule. The server decides what to send (api/index.py, run_cron);
// this file only asks permission and registers this device.
import { api } from "./api.js";

let vapid; // undefined = not asked yet, null = server has no push keys

const isIOS = () => /iphone|ipad|ipod/i.test(navigator.userAgent) || (navigator.platform === "MacIntel" && navigator.maxTouchPoints > 1);
export const standalone = () => matchMedia("(display-mode: standalone)").matches || navigator.standalone === true;
const capable = () => "serviceWorker" in navigator && "PushManager" in window && "Notification" in window;

async function key() {
  if (vapid === undefined) {
    try { vapid = (await api("GET", "config")).vapidPublicKey || null; } catch { vapid = undefined; return null; }
  }
  return vapid;
}

const toBytes = b64 => {
  const raw = atob((b64 + "=".repeat((4 - (b64.length % 4)) % 4)).replace(/-/g, "+").replace(/_/g, "/"));
  return Uint8Array.from(raw, c => c.charCodeAt(0));
};

// getRegistration() answers right away even when no worker is installed (`ready` would wait forever).
async function currentSub() {
  const reg = await navigator.serviceWorker.getRegistration();
  return reg ? reg.pushManager.getSubscription() : null;
}

async function register(sub) {
  const j = sub.toJSON();
  await api("POST", "push", { endpoint: j.endpoint, keys: j.keys });
}

// 'hidden' (server has no keys or nothing can be done), 'install' (iPhone, not on the home screen yet),
// 'blocked', 'off' or 'on'.
export async function status() {
  if (!(await key())) return "hidden";
  if (!capable()) return isIOS() && !standalone() ? "install" : "hidden";
  if (Notification.permission === "denied") return "blocked";
  if (Notification.permission !== "granted") return "off";
  try { return (await currentSub()) ? "on" : "off"; } catch { return "off"; }
}

// Call from a tap. Returns true when this device is subscribed.
export async function enable() {
  if (!capable() || vapid === null) return false;
  try {
    // ask first, before any await, so the tap still counts as the user gesture the browser wants
    if (Notification.permission === "default") await Notification.requestPermission();
    if (Notification.permission !== "granted") return false;
    const k = await key();
    if (!k) return false;
    await navigator.serviceWorker.register("/sw.js");
    const reg = await navigator.serviceWorker.ready;
    const sub = (await reg.pushManager.getSubscription()) ||
      (await reg.pushManager.subscribe({ userVisibleOnly: true, applicationServerKey: toBytes(k) }));
    await register(sub);
    return true;
  } catch { return false; }
}

// Quietly keep this device registered to whoever is signed in (no prompt).
export async function refresh() {
  try {
    if (!(await key()) || !capable() || Notification.permission !== "granted") return;
    const sub = await currentSub();
    if (sub) await register(sub);
  } catch { /* try again next launch */ }
}

export async function disable() {
  try {
    const sub = await currentSub();
    if (sub) {
      await api("DELETE", "push", { endpoint: sub.endpoint });
      await sub.unsubscribe();
    }
  } catch { /* nothing to undo */ }
}

// Sign-out: stop this phone's nags for this account but leave the browser subscription alone.
export async function forget() {
  try {
    if (!capable()) return;
    const sub = await currentSub();
    if (sub) await api("DELETE", "push", { endpoint: sub.endpoint });
  } catch { /* best effort */ }
}
