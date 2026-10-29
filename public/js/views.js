// Screens as HTML strings. Layout and tilts follow the mockups in the handoff; app.js wires the taps.
import { S, count, need, ozSoFar, isDead } from "./state.js";
import { STAGES, stageFor, vol, unitLabel, toDisplay, bottlesWord, trim, esc, shiftDay, weekday, PRESET_GOALS } from "./logic.js";
import * as music from "./music.js";

const img = (dir, file, alt, cls = "", style = "") =>
  `<img src="/assets/${dir}/${file}" alt="${esc(alt)}" class="${cls}" style="${style}" draggable="false" decoding="sync">`;

// ---------------------------------------------------------------- shared bits

const TILTS = [-6, 3, -2, 7, -4, 5, -1, 6, -3, 4];
const DROPS = [2, 0, 4, 1, 3, 0, 2, 1, 4, 0];
const DEAD_TILTS = [-6, 14, -9, 5, -4, 9, -2, 11, -7, 6];

// Full bottles for what is drunk, empty for what is left. Extra full ones appear after the goal.
function bottles({ full, total, dead = false, fillIn = false }) {
  const n = Math.max(total, full);
  const w = n <= 6 ? 40 : n <= 8 ? 32 : n <= 10 ? 24 : 22;
  const h = Math.round((w * 94) / 40);
  const tilts = dead ? DEAD_TILTS : TILTS;
  const items = [];
  for (let i = 0; i < n; i++) {
    const isFull = i < full;
    const knocked = dead && !isFull && i === n - 1 && n - full >= 2;
    const tf = knocked
      ? `rotate(80deg) translate(${Math.round(w * 0.7)}px, -6px)`
      : `rotate(${tilts[i % tilts.length]}deg) translateY(${DROPS[i % DROPS.length]}px)`;
    const fresh = fillIn && isFull && i === full - 1;
    items.push(`<img src="/assets/bottles/bottle-${isFull ? "full" : "empty"}.svg" alt="" draggable="false" decoding="sync" class="bottle${fresh ? " fill-in" : ""}" style="width:${w}px;height:${h}px;transform:${tf}">`);
  }
  const label = dead ? `${full} of ${total} bottles` : `${full} of ${total} bottles drunk`;
  return `<div class="bottles${n > 6 ? " many" : ""}${dead ? " ghost" : ""}" role="img" aria-label="${label}">${items.join("")}</div>`;
}

const tabs = active => `
  <nav aria-label="Tabs" class="tabs sk-line">
    <button type="button" data-act="tab" data-tab="snail" class="tab" style="transform:rotate(-2deg)" ${active === "snail" ? 'aria-current="page"' : ""}><span class="${active === "snail" ? "sk-under on" : ""}">Snail</span></button>
    <button type="button" data-act="tab" data-tab="settings" class="tab" style="transform:rotate(1.5deg)" ${active === "settings" ? 'aria-current="page"' : ""}><span class="${active === "settings" ? "sk-under on" : ""}">Settings</span></button>
  </nav>`;

const unitToggle = (unit, style = "") => `
  <div role="group" aria-label="Units" class="toggle" style="${style}">
    <button type="button" data-act="unit" data-unit="oz" aria-pressed="${unit === "oz"}" class="tog">oz</button>
    <button type="button" data-act="unit" data-unit="l" aria-pressed="${unit === "l"}" class="tog" style="${unit === "l" ? "" : "transform:rotate(3deg)"}">L</button>
  </div>`;

const perDay = n => `= ${n == null ? "? bottles" : bottlesWord(n)} a day`;

// ---------------------------------------------------------------- onboarding

export const welcome = () => `
  <main class="screen welcome">
    <h1 class="logo"><span style="font-size:64px;margin-left:6px">Drank</span><span class="big">Snail Natra</span></h1>
    ${img("snail", "snail-1-diva.svg", "Snail Natra giving you a heavy-lidded diva look", "hero")}
    <p class="tagline"><span class="sk-under" style="padding:0 6px 6px 4px">Drink water.</span> Don’t die.</p>
    <button type="button" data-act="go-email" class="btn sk-yellow" style="margin:auto 0 0 4px;transform:rotate(-1.4deg)">Get started</button>
    <button type="button" data-act="go-email" class="link" style="align-self:flex-end;margin:8px 24px 0 0;transform:rotate(2deg)">Log in</button>
  </main>`;

export const email = () => `
  <main class="screen emailscreen">
    <button type="button" data-act="go-welcome" aria-label="Back" class="back">${img("ui", "arrow-back.svg", "", "", "width:40px;height:32px")}</button>
    <h1 class="ask" style="margin-top:96px;font-size:58px">What’s your<br>email?</h1>
    <p class="sub" style="margin:16px 0 0 8px;transform:rotate(-0.6deg)">Just this once. He never forgets a face.</p>
    <form data-form="email" novalidate>
      <label for="email" class="sr">Email</label>
      <input id="email" class="sk-input field" type="email" autocomplete="email" autocapitalize="off" autocorrect="off" spellcheck="false" inputmode="email" placeholder="you@email.com" value="${esc(S.emailDraft || "")}" style="margin:28px 0 0 2px;width:calc(100% - 6px);transform:rotate(0.8deg)">
      <p id="email-err" class="err" role="alert">${esc(S.error || "")}</p>
      <button type="submit" class="btn sk-yellow" style="margin:12px 0 0 8px;width:calc(100% - 14px);transform:rotate(-1.4deg)" ${S.busy ? 'aria-disabled="true"' : ""}>${S.busy ? "One sec…" : "Let me in"}</button>
    </form>
    ${img("snail", "snail-1-diva.svg", "", "peek")}
  </main>`;

export function setup() {
  const st = S.setup;
  const unit = st.unit;
  const women = st.goalOz === PRESET_GOALS.women, men = st.goalOz === PRESET_GOALS.men;
  const goalLabel = oz => `${vol(oz, unit)} ${unitLabel(unit)}`;
  return `
  <main class="screen setup">
    <div class="stack" style="gap:28px">
      <button type="button" data-act="go-email" aria-label="Back" class="back">${img("ui", "arrow-back.svg", "", "", "width:40px;height:32px")}</button>
      <h1 class="ask" style="font-size:56px">How thirsty is<br>your snail?</h1>
    </div>

    <div class="stack" style="gap:34px">
      <div class="stack" style="gap:8px;transform:rotate(0.6deg)">
        <label for="sbottle" style="font-size:20px">My water bottle holds</label>
        <div class="row" style="gap:10px">
          <input id="sbottle" class="sk-input num" type="text" inputmode="decimal" autocomplete="off" value="${esc(st.bottleText)}" style="width:104px;font-size:34px">
          ${unitToggle(unit)}
          ${img("bottles", "bottle-full.svg", "", "", "width:32px;height:75px;margin-left:auto;margin-right:6px;transform:rotate(12deg)")}
        </div>
        <p id="setup-err" class="err" role="alert" style="margin:0"></p>
      </div>

      <fieldset class="stack" style="margin:0;padding:0;border:none;gap:10px;transform:rotate(-0.6deg)">
        <legend style="padding:0;margin-bottom:8px;font-size:20px">Daily goal</legend>
        <div class="two">
          <button type="button" data-act="goal" data-goal="women" aria-pressed="${women}" class="tog big" style="transform:rotate(-1.5deg)"><span class="n">${goalLabel(PRESET_GOALS.women)}</span><span class="cap">women</span></button>
          <button type="button" data-act="goal" data-goal="men" aria-pressed="${men}" class="tog big" style="transform:rotate(2deg) translateY(4px)"><span class="n">${goalLabel(PRESET_GOALS.men)}</span><span class="cap">men</span></button>
        </div>
        <p class="small" style="margin:6px 0 0 4px">Expert picks, minus the water you get from food.</p>
      </fieldset>
    </div>

    <div class="stack" style="gap:16px">
      <p id="setup-result" class="result" style="margin-left:28px;font-size:34px;transform:rotate(-2deg)">${perDay(st.needed)}</p>
      <button type="button" data-act="hatch-first" class="btn sk-yellow" style="margin:0 0 0 4px;width:calc(100% - 10px);transform:rotate(1.2deg)" ${st.needed == null || S.busy ? 'aria-disabled="true"' : ""}>${S.busy ? "Hatching…" : "Hatch my snail"}</button>
    </div>
  </main>`;
}

export const hatched = () => `
  <main class="screen hatched">
    <h1 class="ask" style="margin:0 0 0 4px;font-size:72px;transform:rotate(-3deg)">It’s a snail!</h1>
    <div class="sk-box" style="margin:30px 0 0 8px;padding:18px 14px 16px 14px;transform:rotate(1.8deg)">
      ${img("snail", "snail-baby-swaddle.svg", "Baby Snail Natra swaddled in a blue blanket with a pacifier and very long eye stalks", "", "width:280px;max-width:100%;height:auto;display:block;margin-left:10px")}
    </div>
    <p style="margin:28px 0 0 10px;font-size:21px;line-height:1.35;transform:rotate(-1deg)">Meet Snail Natra. He’s a star, and stars need water.</p>
    <p class="result" style="margin:10px 0 0 26px;font-size:30px;transform:rotate(1.5deg)">${bottlesWord(need())} a day or he dies.</p>
    <button type="button" data-act="start" class="btn sk-yellow" style="margin:auto 0 0 4px;transform:rotate(-1.4deg)">Fine. Let’s drink.</button>
  </main>`;

// ---------------------------------------------------------------- the snail tab

function nowPlaying() {
  const song = S.song;
  const app = S.user.musicApp;
  const name = song ? song.name : music.FALLBACK.name;
  const blocked = S.audio === "blocked" && song && song.preview;
  const sub = blocked ? "Tap to hear him · Frank Sinatra" : `Frank Sinatra · ${music.appName(app)}`;
  const href = music.linkFor(song, app);
  return `
    <a href="${esc(href)}" target="_blank" rel="noopener" data-act="song" aria-label="Now playing ${esc(name)} by Frank Sinatra. ${blocked ? "Tap to play the preview" : "Open in " + music.appName(app)}" class="sk-np nowplaying" style="transform:rotate(-1.2deg)">
      ${img("ui", "eq-bars.svg", "", S.audio === "playing" ? "eq going" : "eq", "width:42px;height:34px;flex:none")}
      <span class="np-text"><span class="np-title">${esc(name)}</span><span style="font-size:15px">${esc(sub)}</span></span>
    </a>`;
}

function alive() {
  const c = count(), n = need(), unit = S.user.unit;
  const stage = STAGES[stageFor(c, n)];
  const goalHit = c >= n;
  const left = c > n ? `${c} bottles. Encore!` : `${c} of ${n} bottles`;
  const fx = S.fx || {};
  return `
  <main class="screen today">
    <h1 class="title">Drank Snail Natra</h1>
    <section class="sk-box snailcard" style="transform:rotate(1.2deg)">
      ${img("snail", stage.img, stage.alt, `snailpic${fx.wobble ? " pop" : ""}${goalHit ? " sing" : ""}`)}
      <p class="headline">${esc(stage.line)}</p>
    </section>
    <section aria-label="Water meter" class="meter">
      <div class="row between base">
        <h2 id="meter-left">${esc(left)}</h2>
        <p class="amt" style="transform:rotate(2.5deg)"><span id="meter-oz">${vol(ozSoFar(), unit)}</span> / ${vol(S.user.goalOz, unit)} ${unitLabel(unit)}</p>
      </div>
      ${bottles({ full: c, total: n, fillIn: fx.fill })}
    </section>
    ${goalHit ? `
      ${nowPlaying()}
      <div class="row smallrow">
        <button type="button" data-act="glug" class="textbtn" style="transform:rotate(-1.5deg)">+ one more? encore</button>
        <button type="button" data-act="undo" class="textbtn" style="transform:rotate(2deg)">oops, undo</button>
      </div>` : `
      <div class="stack" style="padding-top:4px">
        <button type="button" data-act="glug" class="btn sk-yellow" style="margin-left:4px;width:calc(100% - 12px);transform:rotate(-1.6deg)">+ Glug glug</button>
        <button type="button" data-act="undo" class="textbtn" style="align-self:flex-end;margin-right:18px;transform:rotate(2deg)" ${c === 0 ? 'aria-disabled="true"' : ""}>oops, undo</button>
      </div>`}
    ${tabs("snail")}
  </main>`;
}

function rip() {
  const d = S.dead;
  const unit = S.user.unit;
  const yesterday = shiftDay(S.today, -1);
  const when = d.day === yesterday ? "Yesterday" : weekday(d.day);
  return `
  <main class="screen today rip">
    <h1 class="title">Drank Snail Natra</h1>
    <section class="sk-dash snailcard" style="transform:rotate(-1deg)">
      ${img("snail", "snail-dead.svg", "Snail Natra dead: his shell is a skull, eyes are X's, halo overhead", "snailpic")}
      <p class="headline" style="font-size:44px;transform:rotate(-2deg)">RIP that bitch.</p>
    </section>
    <section aria-label="${esc(when)}" class="meter">
      <div class="row between base">
        <h2>${esc(when)}: ${d.bottles} of ${d.needed}</h2>
        <p class="amt" style="transform:rotate(2.5deg)">${vol(d.oz, unit)} / ${vol(S.user.goalOz, unit)} ${unitLabel(unit)}</p>
      </div>
      ${bottles({ full: Math.min(d.bottles, d.needed), total: d.needed, dead: true })}
    </section>
    <button type="button" data-act="hatch-new" class="btn sk-green" style="margin:8px 0 0 6px;width:calc(100% - 14px);transform:rotate(1.4deg)" ${S.busy ? 'aria-disabled="true"' : ""}>${S.busy ? "Hatching…" : "Hatch a new snail"}</button>
    ${tabs("snail")}
  </main>`;
}

export const snailTab = () => (isDead() ? rip() : alive());

// ---------------------------------------------------------------- settings

export function settings() {
  const u = S.user, unit = u.unit;
  const l = unit === "l";
  const note = (l ? "Experts say about 2.2 L (women) or 3 L (men) from drinks." : "Experts say about 73 oz (women) or 100 oz (men) from drinks.")
    .replace(/\boz\b/g, '<span class="oz">oz</span>'); // Gochi Hand's "oz" reads like "o3"

  const nags = S.nags;
  const nagBody = {
    on: `<p class="small" style="margin:0">Nags are on. He’ll nag you when you’re behind.</p><button type="button" data-act="nags-off" class="textbtn" style="align-self:flex-start;transform:rotate(-1deg)">turn off</button>`,
    off: `<button type="button" data-act="nags-on" class="tog wide" style="align-self:flex-start">Turn on nags</button>`,
    blocked: `<p class="small" style="margin:0">Notifications are blocked for this app. Allow them in your phone’s settings and he can nag you again.</p>`,
    install: `<p class="small" style="margin:0">To get nags on iPhone: tap Share, then Add to Home Screen, and open it from there.</p>`,
  }[nags];
  return `
  <main class="screen settingsscreen">
    <h1 class="title" style="font-size:55px">Settings</h1>

    <section aria-labelledby="h-water" class="sk-box2 card" style="padding:20px 20px 24px 22px;transform:rotate(-0.8deg)">
      <div class="row between">
        <h2 id="h-water" class="h2">Water</h2>
        ${unitToggle(unit, "transform:rotate(2deg)")}
      </div>
      <div class="row between" style="gap:10px">
        <label for="bottle" style="font-size:19px">Bottle size</label>
        <span class="row" style="gap:8px"><input id="bottle" class="sk-input num" type="text" inputmode="decimal" autocomplete="off" value="${trim(toDisplay(u.bottleOz, unit))}" style="width:96px;font-size:30px"><span class="unit" data-unit-label>${unitLabel(unit)}</span></span>
      </div>
      <div class="row between" style="gap:10px">
        <label for="goal" style="font-size:19px">Daily goal</label>
        <span class="row" style="gap:8px"><input id="goal" class="sk-input num" type="text" inputmode="decimal" autocomplete="off" value="${trim(toDisplay(u.goalOz, unit))}" style="width:96px;font-size:30px;transform:rotate(1.5deg)"><span class="unit" data-unit-label>${unitLabel(unit)}</span></span>
      </div>
      <p id="settings-err" class="err" role="alert" style="margin:-6px 0 0"></p>
      <p class="small" style="margin:0;font-size:15px;line-height:1.35">${note}</p>
      <p id="settings-result" class="result" style="margin:0 0 0 30px;font-size:30px;transform:rotate(-1.5deg)">${perDay(need())}</p>
    </section>

    <section aria-labelledby="h-jazz" class="sk-box2 card" style="margin-left:8px;padding:18px 18px 20px 20px;transform:rotate(1deg)">
      <h2 id="h-jazz" class="h2">His jazz plays in</h2>
      <div role="group" aria-label="Music app" class="two" style="gap:10px">
        <button type="button" data-act="music" data-app="apple" aria-pressed="${u.musicApp === "apple"}" class="tog">Apple Music</button>
        <button type="button" data-act="music" data-app="spotify" aria-pressed="${u.musicApp === "spotify"}" class="tog" style="transform:rotate(-2deg)">Spotify</button>
      </div>
    </section>

    ${nagBody ? `
    <section aria-labelledby="h-nags" class="sk-box2 card" style="padding:16px 18px 18px 20px;transform:rotate(-0.6deg)">
      <h2 id="h-nags" class="h2">His nagging</h2>
      ${nagBody}
    </section>` : ""}

    <p class="who">${esc(u.email)} · <button type="button" data-act="logout" class="inline">log out</button></p>
    ${tabs("settings")}
  </main>`;
}

export const loading = () => `
  <main class="screen center">
    ${img("snail", "snail-0-thirsty.svg", "Snail Natra, waiting", "hero pulse", "width:260px")}
    <p class="result" style="font-size:34px;margin-top:12px">Waking him up…</p>
  </main>`;

export const failed = () => `
  <main class="screen center">
    ${img("snail", "snail-dead.svg", "Snail Natra, not moving", "hero", "width:240px")}
    <p class="result" style="font-size:34px;margin:12px 0 0">Can’t reach him.</p>
    <p class="small" style="margin:6px 0 20px">${esc(S.error || "No connection.")}</p>
    <button type="button" data-act="retry" class="btn sk-yellow" style="width:80%;transform:rotate(-1deg)">Try again</button>
    <button type="button" data-act="logout" class="link" style="margin-top:12px">log out</button>
  </main>`;

export function view() {
  switch (S.screen) {
    case "welcome": return welcome();
    case "email": return email();
    case "setup": return setup();
    case "hatched": return hatched();
    case "error": return failed();
    case "main": return S.tab === "settings" ? settings() : snailTab();
    default: return loading();
  }
}
