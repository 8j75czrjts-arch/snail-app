# Drank Snail Natra

Drink water. Don't die. A water tracker with a sassy diva snail: every bottle gets him dressed up a bit more, hit the goal and he sings Sinatra, miss a day and he's dead by midnight.

Built from the design handoff (`_pkg/`, not deployed). Same setup as Daily Tally: a static PWA (`public/`, no framework, no build step) plus one Python function on Vercel (`api/index.py`) that reads and writes Supabase.

```
public/              the app: index.html, css/app.css, js/*.js, sw.js, manifest, icons, assets (snail, bottles, hand-drawn UI, fonts)
api/index.py         the only server code; the browser never talks to Supabase directly
supabase/schema.sql  tables (sn_users, sn_snails, sn_drinks, sn_days, sn_push, sn_nags), RLS on, no public policies
supabase/cron.sql    optional: the 15-minute clock for push nags
dev_server.py        local server with an in-memory database
tests/               python3 -m unittest discover -s tests
scripts/gen_vapid.py makes the key pair for push nags
```

## Run it locally (no database needed)

```bash
python3 dev_server.py        # http://localhost:8001, data resets when you stop it
```

Testing a death without waiting for midnight: in the browser console run `localStorage.setItem('sn.dayOffset','1'); location.reload()`. The app then thinks it is tomorrow (the server allows up to 2 days of drift). Set it back to `0` afterwards.

## Go live

1. **Supabase:** SQL editor, paste `supabase/schema.sql`, run it. (Same project as Daily Tally is fine; tables are prefixed `sn_`.)
2. **Vercel:** new project from this repo (framework preset "Other"; `vercel.json` already points the output at `public/`). Add two environment variables, then redeploy:
   - `SUPABASE_URL`: `https://<project-ref>.supabase.co`
   - `SUPABASE_SERVICE_KEY`: the *service_role* / secret key. Server-side only, never sent to the browser.
3. **Phone:** open the Vercel URL in Safari, Share → Add to Home Screen. Home-screen name is "Snail Natra".

### Fast follow: turn on the nags (not live yet)

**Status:** v1 ships without notifications. The code is all in place but dormant: with no `VAPID_PUBLIC_KEY` set, the app never asks for permission and hides the "His nagging" box in Settings. Do the steps below when you're ready.

A web app can't schedule notifications on the phone the way a native app can, so nags are real Web Push sent from the server. Without this step everything else works; the Settings screen just hides the nagging box.

1. `pip install pywebpush && python3 scripts/gen_vapid.py` and add the printed values to Vercel as `VAPID_PUBLIC_KEY` and `VAPID_PRIVATE_KEY`. Also add `CRON_SECRET` (any long random string) and optionally `VAPID_SUBJECT` (`mailto:you@example.com`).
2. Redeploy, then run `supabase/cron.sql` (fill in the two placeholders) so the server is poked every 15 minutes.
3. On iPhone, notifications only work for the app installed to the Home Screen (iOS 16.4+). The app asks once, right after "It's a snail!", and Settings → "His nagging" turns them on/off later.

The schedule and copy are the handoff's section 8. Each nag is sent at most once a day (`sn_nags`), only if the condition is true at that moment, never before 8 AM, and a cron run up to 45 minutes late still sends it.

## How it works

- **Water is stored in US fl oz.** Liters are only for display/typing (`oz / 33.814`, one decimal). Bottles needed = `ceil(goal / bottle)`.
- **A day** is the player's local calendar day; the browser sends it with every request and the time zone is saved on the profile.
- **Death** is worked out lazily on app open (and by the nag cron): every finished day since the last check is scored, and the first one with too few bottles kills the snail on that day. Away for a week means he died on the first missed day. Hatching starts a fresh snail whose first scored day is today.
- **Offline:** the app shell is cached and bottles/undo/settings are queued locally and replayed when the connection returns (each bottle has a client-made id, so a retry never double-counts).
- **Music:** free 30-second Sinatra previews from the iTunes Search API, started inside the tap that logs the goal bottle (browsers only allow sound after a tap). Tapping the card opens the song in Apple Music, or a Spotify search.
- **Login:** email only, no password or code, same as Daily Tally. The email returns the user id as a token the browser keeps. Anyone who types someone else's email loads their snail, which is fine for a handful of friends. To tighten later, add a PIN column to `sn_users` and check it in `login` (or a magic link, handoff section 7 option 1).

## Shipping changes

Installed copies cache the app shell. Bump `VERSION` in `public/sw.js` when you deploy changes so phones pick them up (close and reopen the app once).
