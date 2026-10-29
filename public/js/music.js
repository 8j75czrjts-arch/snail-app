// His jazz: free 30-second Sinatra previews from the iTunes Search API.
const SEARCH = "https://itunes.apple.com/search?term=frank+sinatra&entity=song&attribute=artistTerm&limit=50";
const CACHE_KEY = "sn.songs";
const SONG_KEY = "sn.song";
const WEEK = 7 * 24 * 3600 * 1000;

export const FALLBACK = {
  id: "essentials",
  name: "Frank Sinatra Essentials",
  url: "https://music.apple.com/us/playlist/frank-sinatra-essentials/pl.732436e7084944c8aba1f06c1cf7fa1d",
  preview: null,
};

let songs = [];
const audio = new Audio();
audio.preload = "auto";
let onEnd = () => {};
audio.addEventListener("ended", () => onEnd());
audio.addEventListener("pause", () => onEnd());

const read = k => { try { return JSON.parse(localStorage.getItem(k)); } catch { return null; } };
const write = (k, v) => { try { localStorage.setItem(k, JSON.stringify(v)); } catch { /* private mode */ } };

export const songsReady = () => songs.length > 0;

// Fetch once, remember for a week. Safe to call on every launch.
export async function loadSongs() {
  if (songs.length) return songs;
  const cached = read(CACHE_KEY);
  if (cached && Date.now() - cached.at < WEEK && cached.list.length) return (songs = cached.list);
  try {
    const res = await fetch(SEARCH);
    const data = await res.json();
    const seen = new Set();
    const list = (data.results || [])
      .filter(r => r.previewUrl && r.trackName && /sinatra/i.test(r.artistName || ""))
      .map(r => ({ id: String(r.trackId), name: r.trackName, url: r.trackViewUrl, preview: r.previewUrl }))
      .filter(s => !seen.has(s.name.toLowerCase()) && seen.add(s.name.toLowerCase()));
    if (list.length) {
      write(CACHE_KEY, { at: Date.now(), list });
      songs = list;
    }
  } catch { /* offline or blocked: the playlist link is the fallback */ }
  if (!songs.length && cached && cached.list.length) songs = cached.list;
  return songs;
}

// A different song each time the goal is hit.
export function pickSong(avoidId) {
  const pool = songs.filter(s => s.id !== avoidId);
  const from = pool.length ? pool : songs;
  return from.length ? from[Math.floor(Math.random() * from.length)] : null;
}

// Today's song is remembered so reopening the app shows the same card without replaying it.
export const rememberSong = (day, song) => write(SONG_KEY, { day, song });
export function songFor(day) {
  const s = read(SONG_KEY);
  return s && s.day === day ? s.song : null;
}
export const lastSongId = () => (read(SONG_KEY) || {}).song?.id;

// Call from inside a tap handler: browsers only allow sound after a gesture.
export function play(song, ended) {
  onEnd = ended || (() => {});
  if (!song || !song.preview) return Promise.resolve(false);
  audio.src = song.preview;
  audio.currentTime = 0;
  try {
    const p = audio.play();
    return p ? p.then(() => true, () => false) : Promise.resolve(true);
  } catch { return Promise.resolve(false); }
}

export function stop() {
  onEnd = () => {};
  audio.pause();
}

export const isPlaying = () => !audio.paused && !audio.ended;

export function linkFor(song, app) {
  const s = song || FALLBACK;
  if (app === "spotify") {
    return `https://open.spotify.com/search/${encodeURIComponent(song ? `${song.name} frank sinatra` : "frank sinatra essentials")}`;
  }
  return s.url;
}
export const appName = app => (app === "spotify" ? "Spotify" : "Apple Music");
