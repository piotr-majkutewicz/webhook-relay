import { DEFAULT_LANG, dictionaries, type Dict, type Key, type Lang } from "./i18n";
import { DEBUG_SCROLL_JS } from "./debug-scroll.js";

/**
 * Admin panel: one HTML page, rendered in Polish by default with an EN switch.
 * The admin token is typed in by the user and kept only in a JS variable (never in
 * cookies or the URL). The only thing stored in localStorage is the chosen language.
 * All texts come from the dictionaries in src/i18n; all server data is inserted
 * with textContent, never innerHTML.
 *
 * Refreshing never rebuilds what the user is looking at: the event list is updated
 * node by node, the detail view is rebuilt only when its data changed, nothing is
 * applied while the user touches or scrolls the page (and for 1.5 s after), and the
 * scroll position is restored if a rebuild moved it.
 */
export interface DemoPanelInfo {
  ttlHours: number;
  maxEvents: number;
  maxAttempts: number;
}

const esc = (v: string): string =>
  v.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");

function format(text: string, vars: Record<string, string | number> = {}): string {
  return text.replace(/\{(\w+)\}/g, (m, k: string) => (k in vars ? String(vars[k]) : m));
}

const cap = (v: string): string => v.charAt(0).toUpperCase() + v.slice(1);

const ICONS: Record<string, string> = {
  invoice: '<svg viewBox="0 0 24 24"><path d="M6 3h9l4 4v14H6z"/><path d="M14 3v5h5"/><path d="M9 13h7M9 17h7"/></svg>',
  email: '<svg viewBox="0 0 24 24"><rect x="3" y="5" width="18" height="14" rx="2"/><path d="M3 7l9 6 9-6"/></svg>',
  warehouse: '<svg viewBox="0 0 24 24"><path d="M3 9l9-5 9 5v11H3z"/><path d="M9 20v-6h6v6"/></svg>',
  sheet: '<svg viewBox="0 0 24 24"><rect x="3" y="4" width="18" height="16" rx="2"/><path d="M3 10h18M3 15h18M9 4v16"/></svg>',
};

/** Demo pages carry no token or replay texts at all. */
function dictFor(d: Dict, isDemo: boolean): Partial<Dict> {
  if (!isDemo) return d;
  return Object.fromEntries(Object.entries(d).filter(([k]) => !k.startsWith("replay") && !k.startsWith("token")));
}

/**
 * In demo mode (`demo` is set) the page needs no token, has no replay button, and offers
 * scenario cards instead. The mode is decided on the server; nothing in this page can switch
 * it. `lang` is only the initial language of the server-rendered text; the script then
 * applies ?lang=, the saved choice, or the default (Polish).
 */
export function panelHtml(nonce: string, demo: DemoPanelInfo | null = null, lang: Lang = DEFAULT_LANG): string {
  const isDemo = demo !== null;
  const d = dictionaries[lang];
  const vars: Record<string, string | number> = demo ? { ttl: demo.ttlHours, max: demo.maxEvents, attempts: demo.maxAttempts } : {};
  const t = (k: Key, v: Record<string, string | number> = vars): string => esc(format(d[k], v));
  // JSON in a non-executed script block; "<" is escaped so the data cannot close the tag.
  const i18nJson = JSON.stringify({ pl: dictFor(dictionaries.pl, isDemo), en: dictFor(dictionaries.en, isDemo) }).replace(/</g, "\\u003c");
  const pressed = (l: Lang) => (l === lang ? "true" : "false");
  const toolbar = `<label class="muted" for="filter" data-i18n="statusLabel">${t("statusLabel")}</label>
  <select id="filter">
    <option value="" data-i18n="filterAll">${t("filterAll")}</option><option value="pending" data-i18n="statusPending">${t("statusPending")}</option><option value="delivered" data-i18n="statusDelivered">${t("statusDelivered")}</option><option value="failed" data-i18n="statusFailed">${t("statusFailed")}</option><option value="dead" data-i18n="statusDead">${t("statusDead")}</option>
  </select>
  <button id="load" class="primary" type="button" data-i18n="loadButton">${t("loadButton")}</button>
  <button id="auto" type="button" aria-pressed="false" data-i18n="autoOff">${t("autoOff")}</button>`;
  const scenarios: [string, string, string][] = [
    ["ok", "scOkTitle", "scOkDesc"],
    ["flaky", "scFlakyTitle", "scFlakyDesc"],
    ["down", "scDownTitle", "scDownDesc"],
    ["duplicate", "scDuplicateTitle", "scDuplicateDesc"],
    ["bad-signature", "scBadSigTitle", "scBadSigDesc"],
  ];
  return `<!doctype html>
<html lang="${lang}">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<meta name="theme-color" content="#14110f">
<meta name="color-scheme" content="dark">
<meta name="robots" content="noindex, nofollow">
<title>webhook-relay</title>
<style nonce="${nonce}">
html { background:#14110f; color-scheme:dark; }
:root { --bg:#14110f; --fg:#f2ebdd; --muted:#a99f90; --line:#2f2823; --line2:#4a4038; --accent:#ef4444; --ok:#7fb069; --warn:#e0a458; --card:#1a1613; }
* { box-sizing: border-box; }
html { -webkit-text-size-adjust:100%; }
body { margin:0; background:var(--bg); color:var(--fg); font:15px/1.5 system-ui,-apple-system,"Segoe UI",Roboto,sans-serif; overflow-wrap:anywhere; }
header { display:flex; flex-wrap:wrap; gap:12px; align-items:center; padding:16px 20px; border-bottom:1px solid var(--line); }
h1 { font-size:18px; margin:0 auto 0 0; letter-spacing:.02em; }
h1 span { color:var(--accent); }
h2 { font-size:17px; margin:0 0 8px; }
h3 { font-size:15px; margin:0 0 4px; }
main { display:grid; grid-template-columns:minmax(0,1.2fr) minmax(0,1fr); gap:20px; padding:20px; }
main > * { min-width:0; }
input, select, button { font:inherit; color:var(--fg); background:#1d1815; border:1px solid var(--line2); border-radius:6px; padding:8px 12px; min-height:44px; max-width:100%; }
button { cursor:pointer; }
button:hover { border-color:var(--accent); }
button.primary { background:var(--accent); border-color:var(--accent); color:#fff; }
button:disabled { opacity:.5; cursor:not-allowed; }
:focus-visible { outline:2px solid var(--accent); outline-offset:2px; }
table { width:100%; border-collapse:collapse; }
th, td { text-align:left; padding:8px 10px; border-bottom:1px solid var(--line); vertical-align:top; }
th { color:var(--muted); font-weight:500; font-size:13px; }
tbody tr { cursor:pointer; }
tbody tr:hover, tbody tr.sel { background:#1d1815; }
.badge { display:inline-block; padding:1px 8px; border-radius:99px; border:1px solid var(--line2); font-size:12px; }
.badge.delivered { color:var(--ok); border-color:var(--ok); }
.badge.pending { color:var(--warn); border-color:var(--warn); }
.badge.failed, .badge.dead { color:var(--accent); border-color:var(--accent); }
.muted { color:var(--muted); }
pre { background:#0f0d0b; border:1px solid var(--line); border-radius:6px; padding:10px; margin:8px 0; white-space:pre-wrap; overflow-wrap:anywhere; word-break:break-word; overflow:visible; }
.card { border:1px solid var(--line); border-radius:8px; padding:12px; margin:12px 0; }
.msg { color:var(--accent); min-height:1.5em; }
.mono { font-family:ui-monospace,SFMono-Regular,Menlo,monospace; font-size:13px; }
.note, .about, .try, .intake { margin:16px 20px 0; padding:14px 16px; border:1px solid var(--line2); border-radius:8px; background:var(--card); }
.note p, .about p, .try p { margin:0 0 8px; }
.toolbar { display:flex; flex-wrap:wrap; gap:8px 12px; align-items:center; margin-bottom:8px; }
.flow { display:flex; align-items:stretch; gap:8px; margin-top:12px; }
.flow .stage { flex:1 1 0; min-width:0; border:1px solid var(--line2); border-radius:8px; padding:10px 12px; background:#1d1815; }
.flow .stage.relay { border-color:var(--accent); }
.flow .stage strong { display:block; }
.flow .stage span { color:var(--muted); font-size:13px; }
.flow .arrow { flex:none; align-self:center; color:var(--accent); font-size:22px; }
.scenarios { list-style:none; margin:12px 0 0; padding:0; display:grid; grid-template-columns:repeat(auto-fit,minmax(min(100%,220px),1fr)); gap:12px; }
.scenarios li { border:1px solid var(--line); border-radius:8px; padding:12px; display:flex; flex-direction:column; gap:8px; background:#1d1815; }
.scenarios p { margin:0; color:var(--muted); font-size:14px; flex:1; }
.timeline { list-style:none; margin:8px 0 0 6px; padding:0 0 0 18px; border-left:2px solid var(--line2); }
.timeline li { position:relative; padding:0 0 12px 12px; }
.timeline li::before { content:""; position:absolute; left:-27px; top:5px; width:12px; height:12px; border-radius:50%; background:var(--bg); border:2px solid var(--muted); }
.timeline li.ok::before { border-color:var(--ok); background:var(--ok); }
.timeline li.fail::before, .timeline li.dead::before { border-color:var(--accent); background:var(--accent); }
.timeline li.wait::before { border-color:var(--warn); }
.timeline strong { display:block; }
.timeline .desc { color:var(--muted); font-size:14px; }
.timeline .meta { color:var(--muted); font-size:12px; }
.summary { font-weight:600; margin:8px 0; }
.intake ul { list-style:none; margin:8px 0 0; padding:0; }
.intake li { padding:8px 0; border-top:1px solid var(--line); display:flex; flex-wrap:wrap; gap:4px 12px; align-items:center; }
.intake li .when { color:var(--muted); font-size:13px; }
.lang { display:flex; gap:4px; }
.lang button { min-width:44px; min-height:44px; font-weight:600; }
.lang button[aria-pressed="true"] { border-color:var(--accent); color:var(--accent); }
.tz { margin:8px 0 0; font-size:13px; }
a { color:var(--accent); }
a:hover { color:var(--fg); }
a.cta { display:inline-block; padding:10px 0; min-height:44px; }
footer { padding:16px 20px 28px; border-top:1px solid var(--line); margin-top:16px; }
@media (min-width:901px) { pre { max-height:240px; overflow:auto; } }
@media (max-width:900px) {
  main { grid-template-columns:minmax(0,1fr); gap:12px; padding:12px; }
  header { padding:12px; }
  .note, .about, .try, .intake { margin:12px 12px 0; }
  footer { padding:12px 12px 24px; }
}
@media (max-width:700px) {
  .flow { flex-direction:column; }
  .flow .arrow { transform:rotate(90deg); line-height:1; }
  select, input { width:100%; }
  .events, .events tbody, .events tr, .events td { display:block; width:100%; }
  .events thead { display:none; }
  .events tr { border:1px solid var(--line); border-radius:8px; margin:8px 0; padding:8px 10px; }
  .events td { border:0; padding:2px 0; display:flex; gap:12px; justify-content:space-between; }
  .events td::before { content:attr(data-label); color:var(--muted); flex:none; }
  .events td > * { min-width:0; text-align:right; }
}
.sr-only { position:absolute; width:1px; height:1px; margin:-1px; padding:0; overflow:hidden; clip:rect(0,0,0,0); white-space:nowrap; border:0; }
button.busy::before { content:""; display:inline-block; width:14px; height:14px; margin-right:8px; vertical-align:-2px; border:2px solid currentColor; border-right-color:transparent; border-radius:50%; animation:spin .8s linear infinite; }
@keyframes spin { to { transform:rotate(360deg); } }
@keyframes pulse { 0%,100% { transform:scale(.7); opacity:.45; } 50% { transform:scale(1); opacity:1; } }
@keyframes enter { from { opacity:0; transform:translateY(8px); } to { opacity:1; transform:none; } }
@keyframes draw { from { stroke-dashoffset:24; } to { stroke-dashoffset:0; } }
.hero, .calc, .ctabox { margin:16px 20px 0; padding:16px; border:1px solid var(--line2); border-radius:8px; background:var(--card); }
.hero h2 { font-size:22px; }
.hero p { margin:0 0 8px; }
.check { display:flex; gap:10px; align-items:flex-start; margin:12px 0; min-height:44px; cursor:pointer; }
.check input { width:24px; height:24px; min-height:24px; flex:none; margin:0; accent-color:var(--accent); }
button.big { width:100%; max-width:420px; font-size:16px; font-weight:600; min-height:52px; }
.steps { list-style:none; margin:16px 0 0; padding:0; display:grid; gap:8px; }
.step { display:grid; grid-template-columns:44px minmax(0,1fr) minmax(0,150px); gap:4px 12px; align-items:center; padding:10px 12px; border:1px solid var(--line); border-radius:8px; background:#1d1815; }
.step.enter { animation:enter .35s ease both; }
.step .ico { width:44px; height:44px; display:grid; place-items:center; color:var(--muted); }
.step .ico svg { width:26px; height:26px; fill:none; stroke:currentColor; stroke-width:1.6; stroke-linecap:round; stroke-linejoin:round; }
.step .body strong { display:block; }
.step .hint { font-size:13px; display:block; color:var(--muted); }
.step .snote { display:grid; font-size:13px; color:var(--warn); }
.step .snote > span { grid-area:1/1; visibility:hidden; }
.step.st-retry .snote .n1, .step.retried .snote .n2 { visibility:visible; }
.step .state { display:flex; align-items:center; gap:8px; justify-content:flex-end; text-align:right; font-size:14px; }
.ind { position:relative; width:28px; height:28px; flex:none; }
.ind > * { position:absolute; inset:0; margin:auto; opacity:0; }
.i-pulse { width:12px; height:12px; border-radius:50%; background:var(--warn); }
.i-spin { width:22px; height:22px; border:3px solid var(--line2); border-top-color:var(--accent); border-radius:50%; }
.i-warn, .i-check { width:26px; height:26px; fill:none; stroke-width:2; stroke-linecap:round; stroke-linejoin:round; }
.i-warn { stroke:var(--warn); }
.i-check { stroke:var(--ok); }
.i-check .tick { stroke-dasharray:24; stroke-dashoffset:0; }
.st-idle { opacity:.6; }
.st-waiting .i-pulse { opacity:1; animation:pulse 1.4s ease-in-out infinite; }
.st-running .i-spin { opacity:1; animation:spin .8s linear infinite; }
.st-retry .i-warn { opacity:1; }
.st-retry .stxt { color:var(--warn); }
.st-done .i-check { opacity:1; }
.st-done .i-check .tick { animation:draw .45s ease-out both; }
.st-done .stxt { color:var(--ok); }
.st-failed .stxt { color:var(--accent); }
.progress { height:10px; border-radius:99px; background:var(--line); margin:16px 0 4px; overflow:hidden; }
.progress .bar { height:100%; width:0; background:var(--ok); transition:width .4s ease; }
.compare { display:grid; grid-template-columns:1fr 1fr; gap:12px; margin-top:12px; }
.compare > div { border:1px solid var(--line2); border-radius:8px; padding:12px; min-height:72px; font-weight:600; }
.compare .auto { border-color:var(--ok); }
.small { font-size:13px; }
.calc h2 { margin-bottom:4px; }
.fields { display:grid; grid-template-columns:repeat(auto-fit,minmax(min(100%,200px),1fr)); gap:12px; margin:12px 0; }
.field label { display:block; font-size:14px; color:var(--muted); }
.field input { width:100%; }
.field input[aria-invalid="true"] { border-color:var(--accent); }
.field .err { display:block; min-height:1.4em; font-size:13px; color:var(--accent); }
.result { font-size:18px; font-weight:600; margin:4px 0 8px; min-height:1.7em; }
.result strong { color:var(--ok); font-variant-numeric:tabular-nums; }
.ctabox { text-align:center; }
.ctabox a { display:inline-block; font-size:18px; font-weight:600; padding:12px 8px; min-height:44px; }
details.dev { margin:16px 20px 0; border:1px solid var(--line2); border-radius:8px; background:var(--card); }
details.dev > summary { cursor:pointer; padding:12px 16px; min-height:44px; font-weight:600; }
details.dev > .devbody { padding:0 0 16px; }
details.dev .about, details.dev .note, details.dev .try, details.dev .intake { margin-left:12px; margin-right:12px; }
@media (max-width:900px) {
  .hero, .calc, .ctabox, details.dev { margin:12px 12px 0; }
}
@media (max-width:700px) {
  .step { grid-template-columns:44px minmax(0,1fr); }
  .step .state { grid-column:2; justify-content:flex-start; text-align:left; }
  .compare { grid-template-columns:1fr; }
  .compare > div { min-height:104px; }
  button.big { min-height:68px; }
  .field .err { min-height:2.8em; }
  .result { min-height:3.4em; }
}
@media (prefers-reduced-motion:reduce) {
  *, *::before, *::after { animation:none !important; transition:none !important; scroll-behavior:auto !important; }
}
</style>
</head>
<body>
<header>
  <h1>webhook<span>-relay</span></h1>${
    isDemo
      ? ""
      : `
  <label class="muted" for="token" data-i18n="tokenLabel">${t("tokenLabel")}</label>
  <input id="token" type="password" autocomplete="off" placeholder="${t("tokenPlaceholder")}" data-i18n-ph="tokenPlaceholder" size="22">
  ${toolbar}`
  }
  <div class="lang" role="group" aria-label="${t("languageGroup")}" data-i18n-aria="languageGroup">
    <button type="button" data-lang="pl" lang="pl" aria-label="Polski" aria-pressed="${pressed("pl")}">PL</button>
    <button type="button" data-lang="en" lang="en" aria-label="English" aria-pressed="${pressed("en")}">EN</button>
  </div>
</header>${
    isDemo
      ? `
<section class="hero" aria-labelledby="hero-title">
  <h2 id="hero-title" data-i18n="heroTitle">${t("heroTitle")}</h2>
  <p data-i18n="heroText">${t("heroText")}</p>
  <p class="muted" data-i18n="heroCart">${t("heroCart")}</p>
  <label class="check"><input type="checkbox" id="hiccup" checked><span data-i18n="hiccupLabel">${t("hiccupLabel")}</span></label>
  <button id="order" class="primary big" type="button" aria-busy="false"><span data-i18n="orderButton">${t("orderButton")}</span></button>
  <div id="omsg" class="msg" role="status"></div>
  <ol class="steps" id="steps" aria-label="${t("orderRegion")}" data-i18n-aria="orderRegion">${["invoice", "email", "warehouse", "sheet"]
    .map(
      (st) => `
    <li class="step st-idle" data-step="${st}">
      <span class="ico" aria-hidden="true">${ICONS[st]}</span>
      <span class="body"><strong data-i18n="step${cap(st)}">${t(("step" + cap(st)) as Key)}</strong><span class="hint" data-i18n="hint${cap(st)}">${t(("hint" + cap(st)) as Key)}</span><span class="snote"><span class="n1" data-i18n="noteRetry">${t("noteRetry")}</span><span class="n2" data-i18n="noteRetried">${t("noteRetried")}</span></span></span>
      <span class="state"><span class="ind" aria-hidden="true"><span class="i-pulse"></span><span class="i-spin"></span><svg class="i-warn" viewBox="0 0 24 24"><path d="M12 4l9 16H3z"/><path d="M12 10v4M12 17v.5"/></svg><svg class="i-check" viewBox="0 0 24 24"><path class="tick" d="M5 13l4 4 10-10"/></svg></span><span class="stxt">${t("stateIdle")}</span></span>
    </li>`,
    )
    .join("")}
  </ol>
  <div class="progress" role="progressbar" aria-labelledby="progress-label" aria-valuemin="0" aria-valuemax="4" aria-valuenow="0"><div class="bar" id="bar"></div></div>
  <div id="progress-label" class="muted small"></div>
  <div class="compare">
    <div id="cmpManual"></div>
    <div id="cmpAuto" class="auto"></div>
  </div>
  <p class="muted small" data-i18n="compareNote">${t("compareNote")}</p>
  <div id="live" class="sr-only" role="status" aria-live="polite"></div>
</section>
<section class="calc" aria-labelledby="calc-title">
  <h2 id="calc-title" data-i18n="calcTitle">${t("calcTitle")}</h2>
  <p class="muted" data-i18n="calcAssumptions">${t("calcAssumptions")}</p>
  <div class="fields">
    <div class="field"><label for="calcOrders" data-i18n="calcOrders">${t("calcOrders")}</label><input id="calcOrders" type="text" inputmode="numeric" value="200" autocomplete="off"><span class="err" id="errOrders"></span></div>
    <div class="field"><label for="calcMinutes" data-i18n="calcMinutes">${t("calcMinutes")}</label><input id="calcMinutes" type="text" inputmode="decimal" value="8" autocomplete="off"><span class="err" id="errMinutes"></span></div>
    <div class="field"><label for="calcRate" data-i18n="calcRate">${t("calcRate")}</label><input id="calcRate" type="text" inputmode="decimal" value="80" autocomplete="off"><span class="err" id="errRate"></span></div>
  </div>
  <div class="result" id="calcResult" aria-hidden="true"></div>
  <div id="calcLive" class="sr-only" role="status" aria-live="polite"></div>
  <p class="muted small" data-i18n="calcDisclaimer">${t("calcDisclaimer")}</p>
</section>
<section class="ctabox">
  <a class="cta" href="https://piotrmajkutewicz.pl" rel="noopener" data-i18n="cta">${t("cta")}</a>
</section>
<details class="dev" id="dev">
<summary data-i18n="devSummary">${t("devSummary")}</summary>
<div class="devbody">
<section class="about" aria-labelledby="about-title">
  <h2 id="about-title" data-i18n="aboutTitle">${t("aboutTitle")}</h2>
  <p data-i18n="devIntro">${t("devIntro")}</p>
  <p data-i18n="aboutText">${t("aboutText")}</p>
  <div class="flow">
    <div class="stage"><strong data-i18n="flowSource">${t("flowSource")}</strong><span data-i18n="flowSourceNote">${t("flowSourceNote")}</span></div>
    <span class="arrow" aria-hidden="true">&rarr;</span>
    <div class="stage relay"><strong data-i18n="flowRelay">${t("flowRelay")}</strong><span data-i18n="flowRelayNote">${t("flowRelayNote")}</span></div>
    <span class="arrow" aria-hidden="true">&rarr;</span>
    <div class="stage"><strong data-i18n="flowTarget">${t("flowTarget")}</strong><span data-i18n="flowTargetNote">${t("flowTargetNote")}</span></div>
  </div>
</section>
<div class="note" role="note">
  <p><strong data-i18n="demoTitle">${t("demoTitle")}</strong> <span data-i18n="demoText">${t("demoText")}</span></p>
</div>
<section class="try" aria-labelledby="try-title">
  <h2 id="try-title" data-i18n="tryTitle">${t("tryTitle")}</h2>
  <p class="muted" data-i18n="tryHint">${t("tryHint")}</p>
  <ul class="scenarios">${scenarios
    .map(
      ([action, title, desc]) => `
    <li><h3 data-i18n="${title}">${t(title as Key)}</h3><p data-i18n="${desc}">${t(desc as Key)}</p><button type="button" class="primary" data-action="${action}" data-i18n="runButton">${t("runButton")}</button></li>`,
    )
    .join("")}
  </ul>
  <div id="amsg" class="msg" role="status"></div>
</section>`
      : ""
  }
<main>
  <section aria-label="${t("eventsSection")}" data-i18n-aria="eventsSection">${isDemo ? `
    <h2 data-i18n="eventsSection">${t("eventsSection")}</h2>
    <div class="toolbar">${toolbar}</div>` : ""}
    <div id="msg" class="msg" role="status"></div>
    <table class="events">
      <thead><tr><th data-i18n="colReceived">${t("colReceived")}</th><th data-i18n="colSource">${t("colSource")}</th><th data-i18n="colKey">${t("colKey")}</th><th data-i18n="colStatus">${t("colStatus")}</th></tr></thead>
      <tbody id="rows"></tbody>
    </table>
    <p id="tz" class="muted tz"></p>
  </section>
  <section aria-label="${t("detailsSection")}" data-i18n-aria="detailsSection" id="detail"><p class="muted" data-i18n="selectHint">${t("selectHint")}</p></section>
</main>${
    isDemo
      ? `
<section class="intake" aria-labelledby="intake-title">
  <h2 id="intake-title" data-i18n="intakeTitle">${t("intakeTitle")}</h2>
  <p class="muted" data-i18n="intakeHint">${t("intakeHint")}</p>
  <div id="intake"></div>
</section>
</div>
</details>`
      : ""
  }
<script nonce="${nonce}">${DEBUG_SCROLL_JS}</script>
<script nonce="${nonce}" type="application/json" id="i18n">${i18nJson}</script>
<script nonce="${nonce}">
(function () {
  var DEMO = ${isDemo ? JSON.stringify({ ttl: demo.ttlHours, max: demo.maxEvents, attempts: demo.maxAttempts }) : "false"};
  var I18N = JSON.parse(document.getElementById("i18n").textContent);
  var STORE_KEY = "relay.lang";
  var IDLE_MS = 1500;
  var token = ""; // memory only
  var selected = null, timer = null;
  var lastEvents = null, lastDetail = null, lastIntake = [], msgState = null, amsgState = null;
  var rowMap = {}, detailFor = null, detailSig = null, intakeSig = null, busy = false, busyBtn = null, loading = false;
  var order = null, orderBusy = false, calcOk = null, reduceMotion = false;
  try { reduceMotion = window.matchMedia("(prefers-reduced-motion: reduce)").matches; } catch (e) { /* ignore */ }
  var $ = function (id) { return document.getElementById(id); };

  // ---- language: ?lang= (saved), then the saved choice, then Polish ----
  function save(l) { try { localStorage.setItem(STORE_KEY, l); } catch (e) { /* storage may be blocked */ } }
  function pickLang() {
    var q = null, s = null;
    try { q = new URLSearchParams(location.search).get("lang"); } catch (e) { /* ignore */ }
    if (q === "pl" || q === "en") { save(q); return q; }
    try { s = localStorage.getItem(STORE_KEY); } catch (e) { /* ignore */ }
    return s === "en" || s === "pl" ? s : "pl";
  }
  var lang = pickLang();

  function t(key, vars) {
    var s = (I18N[lang] && I18N[lang][key]) || (I18N.pl && I18N.pl[key]) || key;
    return s.replace(/\\{(\\w+)\\}/g, function (m, k) { return vars && vars[k] !== undefined ? String(vars[k]) : m; });
  }
  var tzName = "UTC";
  try { tzName = Intl.DateTimeFormat().resolvedOptions().timeZone || "UTC"; } catch (e) { /* ignore */ }
  var fmtCache = {};
  function when(ms) {
    if (!ms) return "-";
    try {
      var loc = lang === "pl" ? "pl-PL" : "en-GB";
      fmtCache[loc] = fmtCache[loc] || new Intl.DateTimeFormat(loc, {
        year: "numeric", month: "2-digit", day: "2-digit",
        hour: "2-digit", minute: "2-digit", second: "2-digit", hourCycle: "h23"
      });
      return fmtCache[loc].format(new Date(ms));
    } catch (e) {
      return new Date(ms).toISOString().replace("T", " ").replace(/\\.\\d+Z$/, "Z");
    }
  }
  function statusLabel(s) { return t("status" + s.charAt(0).toUpperCase() + s.slice(1)); }

  function el(tag, text, cls) {
    var n = document.createElement(tag);
    if (text !== undefined && text !== null) n.textContent = String(text);
    if (cls) n.className = cls;
    return n;
  }
  function setText(n, text) { if (n.textContent !== text) n.textContent = text; }

  function setMsg(key, vars) { msgState = key ? { key: key, vars: vars } : null; $("msg").textContent = key ? t(key, vars) : ""; }
  function setAmsg(key, vars) { amsgState = key ? { key: key, vars: vars } : null; if ($("amsg")) $("amsg").textContent = key ? t(key, vars) : ""; }

  // ---- do not touch the page while the user is touching or scrolling it ----
  var lastTouch = 0, fingers = 0;
  function touchedRecently() { return fingers > 0 || Date.now() - lastTouch < IDLE_MS; }
  ["touchstart", "touchmove", "scroll", "wheel", "pointerdown", "keydown"].forEach(function (ev) {
    window.addEventListener(ev, function () { lastTouch = Date.now(); }, { passive: true, capture: true });
  });
  // A finger resting on the screen counts as touching, even without movement.
  window.addEventListener("touchstart", function (ev) { fingers = ev.touches.length; }, { passive: true, capture: true });
  ["touchend", "touchcancel"].forEach(function (ev) {
    window.addEventListener(ev, function (e) { fingers = e.touches.length; lastTouch = Date.now(); }, { passive: true, capture: true });
  });
  var pending = {}, flushTimer = null;
  function schedule() {
    if (flushTimer) return;
    flushTimer = setTimeout(function () {
      flushTimer = null;
      if (touchedRecently()) { schedule(); return; }
      var p = pending; pending = {};
      Object.keys(p).forEach(function (k) { p[k](); });
    }, 300);
  }
  /** Runs fn now (user-initiated, or the page is idle); otherwise keeps only the latest fn per kind. */
  function whenIdle(kind, force, fn) {
    if (force || !touchedRecently()) { delete pending[kind]; fn(); return; }
    pending[kind] = fn; schedule();
  }

  // ---- static texts ----
  function applyStatic() {
    document.documentElement.lang = lang;
    var vars = DEMO ? { ttl: DEMO.ttl, max: DEMO.max, attempts: DEMO.attempts } : {};
    Array.prototype.forEach.call(document.querySelectorAll("[data-i18n]"), function (n) {
      var k = n.getAttribute("data-i18n");
      if (k === "autoOn" || k === "autoOff") k = timer ? "autoOn" : "autoOff";
      if (n === busyBtn && busy) k = "sending";
      if (k === "orderButton" && orderBusy) k = "sending";
      setText(n, t(k, vars));
    });
    Array.prototype.forEach.call(document.querySelectorAll("[data-i18n-ph]"), function (n) { n.setAttribute("placeholder", t(n.getAttribute("data-i18n-ph"))); });
    Array.prototype.forEach.call(document.querySelectorAll("[data-i18n-aria]"), function (n) { n.setAttribute("aria-label", t(n.getAttribute("data-i18n-aria"))); });
    Array.prototype.forEach.call(document.querySelectorAll("[data-lang]"), function (n) {
      n.setAttribute("aria-pressed", String(n.getAttribute("data-lang") === lang));
    });
    $("tz").textContent = t("timeZoneNote", { tz: tzName });
    if (msgState) $("msg").textContent = t(msgState.key, msgState.vars);
    if (amsgState && $("amsg")) $("amsg").textContent = t(amsgState.key, amsgState.vars);
    $("auto").setAttribute("aria-pressed", String(!!timer));
  }

  function api(path, opts) {
    opts = opts || {};
    opts.headers = DEMO ? {} : { authorization: "Bearer " + token };
    return fetch(path, opts).then(function (r) {
      return r.json().then(function (d) { return { ok: r.ok, status: r.status, data: d }; });
    });
  }

  // ---- list: updated node by node ----
  function makeRow(id) {
    var tr = document.createElement("tr");
    tr.tabIndex = 0;
    tr.setAttribute("data-id", id);
    for (var i = 0; i < 4; i++) tr.appendChild(document.createElement("td"));
    tr.cells[0].className = "mono";
    tr.cells[2].className = "mono";
    tr.cells[3].appendChild(document.createElement("span"));
    var open = function () { selected = id; updateSelection(); showDetail(id, true); };
    tr.addEventListener("click", open);
    tr.addEventListener("keydown", function (ev) { if (ev.key === "Enter") open(); });
    return tr;
  }
  function fillRow(tr, e) {
    var labels = ["colReceived", "colSource", "colKey", "colStatus"];
    for (var i = 0; i < 4; i++) tr.cells[i].setAttribute("data-label", t(labels[i]));
    setText(tr.cells[0], when(e.receivedAt));
    setText(tr.cells[1], e.source);
    setText(tr.cells[2], e.eventKey);
    var b = tr.cells[3].firstChild;
    var cls = "badge " + e.status;
    if (b.className !== cls) b.className = cls;
    setText(b, statusLabel(e.status));
  }
  function updateSelection() {
    Object.keys(rowMap).forEach(function (id) {
      var cls = id === selected ? "sel" : "";
      if (rowMap[id].className !== cls) rowMap[id].className = cls;
    });
  }
  function renderList() {
    var tb = $("rows");
    var seen = {}, prev = null;
    (lastEvents || []).forEach(function (e) {
      seen[e.id] = true;
      var tr = rowMap[e.id];
      if (!tr) { tr = makeRow(e.id); rowMap[e.id] = tr; }
      fillRow(tr, e);
      var expected = prev ? prev.nextSibling : tb.firstChild;
      if (tr !== expected) tb.insertBefore(tr, expected);
      prev = tr;
    });
    Object.keys(rowMap).forEach(function (id) { if (!seen[id]) { rowMap[id].remove(); delete rowMap[id]; } });
    updateSelection();
  }

  function load(force) {
    if (loading) return;
    if (!DEMO) token = $("token").value;
    var f = $("filter").value;
    loading = true;
    $("load").classList.add("busy");
    var reqs = [api("/admin/events?limit=" + (DEMO ? 10 : 100) + (f ? "&status=" + encodeURIComponent(f) : ""))];
    if (DEMO) reqs.push(api("/admin/intake"));
    Promise.all(reqs).then(function (rs) {
      var r = rs[0];
      if (!r.ok) { if (r.status === 401) setMsg("invalidToken"); else setMsg("errorGeneric", { error: r.data.error || r.status }); return; }
      whenIdle("list", force, function () {
        lastEvents = r.data.events;
        setMsg(lastEvents.length ? null : "noEvents");
        renderList();
      });
      if (rs[1] && rs[1].ok) {
        whenIdle("intake", force, function () { lastIntake = rs[1].data.entries; renderIntake(); renderDetail(); });
      }
    }).catch(function () { setMsg("networkError"); }).then(function () { loading = false; $("load").classList.remove("busy"); });
  }

  // ---- intake log (demo) ----
  function renderIntake() {
    var box = $("intake");
    if (!box) return;
    var sig = JSON.stringify([lang, lastIntake]);
    if (sig === intakeSig) return;
    intakeSig = sig;
    box.replaceChildren();
    if (!lastIntake.length) { box.appendChild(el("p", t("intakeEmpty"), "muted")); return; }
    var ul = el("ul");
    lastIntake.forEach(function (x) {
      var li = el("li");
      li.appendChild(el("span", when(x.receivedAt), "when mono"));
      var key = x.eventKey || "-";
      var text = x.kind === "duplicate" ? t("intakeDuplicate", { key: key })
        : x.reason === "bad_signature" ? t("intakeRejected", { key: key })
        : t("intakeRejectedOther", { key: key, reason: x.reason });
      li.appendChild(el("span", text));
      if (x.eventId) {
        var b = el("button", t("intakeShow")); b.type = "button";
        b.addEventListener("click", function () { selected = x.eventId; updateSelection(); showDetail(x.eventId, true); $("detail").scrollIntoView({ block: "start" }); });
        li.appendChild(b);
      }
      ul.appendChild(li);
    });
    box.appendChild(ul);
  }

  // ---- details: summary and a timeline of what happened ----
  function cd(at) {
    var s = Math.ceil((at - Date.now()) / 1000);
    return s > 0 ? t("inSeconds", { s: s }) : t("soon");
  }
  function step(cls, title, desc, meta) {
    var li = el("li", null, cls);
    li.appendChild(el("strong", title));
    var d = el("span", desc, "desc"); li.appendChild(d);
    if (meta) li.appendChild(el("div", meta, "meta mono"));
    li.descEl = d;
    return li;
  }
  function summaryFor(e) {
    var ds = e.deliveryList, worst = null;
    ["dead", "failed", "pending", "delivered"].some(function (s) {
      return ds.some(function (d) { if (d.status === s) { worst = d; return true; } return false; });
    });
    if (!worst) return t("summaryPending");
    if (worst.status === "delivered") return worst.attempts <= 1 ? t("summaryDeliveredFirst") : t("summaryDelivered", { n: worst.attempts });
    if (worst.status === "dead") return worst.attempts <= 1 ? t("summaryDeadOne") : t("summaryDead", { n: worst.attempts });
    if (worst.status === "failed") return t("summaryFailed");
    return t("summaryPending");
  }
  function renderDetail() {
    var box = $("detail");
    var sig = JSON.stringify([lang, lastDetail, lastDetail && lastDetail.event ? lastIntake.filter(function (x) { return x.eventId === lastDetail.event.id; }) : null]);
    if (sig === detailSig) return;
    detailSig = sig;
    var y = window.scrollY;
    var hadFocus = box.contains(document.activeElement) && document.activeElement.id;
    var evId = lastDetail && lastDetail.event ? lastDetail.event.id : null;
    if (evId !== detailFor) { box.style.minHeight = ""; detailFor = evId; }
    else box.style.minHeight = box.offsetHeight + "px"; // the view of one event does not shrink while it refreshes
    box.replaceChildren();
    if (!lastDetail) { box.appendChild(el("p", t("selectHint"), "muted")); return; }
    if (lastDetail.err) { box.appendChild(el("p", t(lastDetail.err, lastDetail.vars), "msg")); return; }
    var e = lastDetail.event;
    var id = e.id;
    var h = el("h2", t("eventTitle") + " "); h.appendChild(el("span", statusLabel(e.status), "badge " + e.status)); box.appendChild(h);
    box.appendChild(el("p", summaryFor(e), "summary"));
    box.appendChild(el("p", e.source + " / " + e.eventKey + " / " + when(e.receivedAt), "muted mono"));
    box.appendChild(el("div", t("payloadLabel"), "muted"));
    box.appendChild(el("pre", e.body, "mono"));
${isDemo ? "" : `    var canReplay = e.deliveryList.some(function (d) { return d.status === "failed" || d.status === "dead"; });
    var btn = el("button", t("replayButton"), "primary");
    btn.type = "button"; btn.id = "replay";
    btn.disabled = !canReplay;
    btn.addEventListener("click", function () {
      btn.disabled = true;
      api("/admin/events/" + encodeURIComponent(id) + "/replay", { method: "POST" }).then(function (rr) {
        if (rr.ok) setMsg("replayScheduled"); else setMsg("errorGeneric", { error: rr.data.error || rr.status });
        setTimeout(function () { showDetail(id, true); load(true); }, 1500);
      });
    });
    box.appendChild(btn);
`}    box.appendChild(el("h3", t("stepsTitle")));
    var ol = el("ol", null, "timeline");
    ol.appendChild(step("ok", t("stepReceived"), t("stepReceivedDesc", { source: e.source }), when(e.receivedAt)));
    ol.appendChild(step("ok", t("stepSigned"), t("stepSignedDesc")));
    ol.appendChild(step("ok", t("stepStored"), t("stepStoredDesc")));
    lastIntake.filter(function (x) { return x.eventId === e.id && x.kind === "duplicate"; }).forEach(function (x) {
      ol.appendChild(step("info", t("stepDuplicate"), t("stepDuplicateDesc"), when(x.receivedAt)));
    });
    e.deliveryList.forEach(function (d) {
      if (e.deliveryList.length > 1 || d.destination !== "simulated") {
        var dk = "dest" + d.destination.charAt(0).toUpperCase() + d.destination.slice(1);
        var nm = I18N.pl[dk] ? t(dk) : d.destination;
        ol.appendChild(step("info", t("destination", { name: nm }), ""));
      }
      d.attemptLog.forEach(function (a) {
        var detail = a.error || (a.statusCode === null ? "-" : "HTTP " + a.statusCode);
        var res = a.outcome === "success" ? "attemptResultOk" : a.outcome === "permanent" ? "attemptResultPermanent" : "attemptResultRetry";
        var adk = a.outcome === "success" ? "attemptOkDesc" : a.outcome === "permanent" ? "attemptPermanentDesc" : "attemptRetryDesc";
        var title = t("stepAttempt", { n: a.attemptNo, result: t(res) }) + (a.replayNo > 0 ? t("attemptReplaySuffix", { r: a.replayNo }) : "");
        var meta = when(a.startedAt) + " | " + (a.statusCode === null ? "-" : a.statusCode) + " | " + a.durationMs + " ms" + (a.error ? " | " + a.error : "");
        ol.appendChild(step(a.outcome === "success" ? "ok" : "fail", title, t(adk, { detail: detail }), meta));
      });
      if (d.status === "delivered") ol.appendChild(step("ok", t("stepDelivered"), t("stepDeliveredDesc", { n: d.attempts }), when(d.deliveredAt)));
      else if (d.status === "dead") ol.appendChild(step("dead", t("stepDead"), t("stepDeadDesc", { n: d.attempts })));
      else if (d.status === "failed") ol.appendChild(step("dead", t("stepFailed"), t("stepFailedDesc")));
      else {
        var w = step("wait", t("stepNext"), t("stepNextDesc", { when: cd(d.nextAttemptAt) }));
        w.setAttribute("data-next-at", String(d.nextAttemptAt));
        ol.appendChild(w);
      }
    });
    box.appendChild(ol);
    if (hadFocus && $(hadFocus)) $(hadFocus).focus({ preventScroll: true });
    if (Math.abs(window.scrollY - y) > 1) window.scrollTo(0, y);
  }

  function showDetail(id, force) {
    api("/admin/events/" + encodeURIComponent(id)).then(function (r) {
      whenIdle("detail", force, function () {
        if (selected !== id) return;
        if (!r.ok) {
          lastDetail = r.status === 404 ? { err: "eventNotFound" } : { err: "errorGeneric", vars: { error: r.data.error || r.status } };
        } else {
          lastDetail = { event: r.data };
        }
        renderDetail();
      });
    });
  }

  // The countdown is the only thing that changes every second, and only its text.
  setInterval(function () {
    if (document.hidden) return;
    if (DEMO && order && order.phase === "running") renderOrder();
    Array.prototype.forEach.call(document.querySelectorAll("[data-next-at]"), function (li) {
      setText(li.descEl, t("stepNextDesc", { when: cd(Number(li.getAttribute("data-next-at"))) }));
    });
  }, 1000);

  function setAuto(on) {
    if (on && !timer) {
      timer = setInterval(function () {
        if (document.hidden || touchedRecently()) return;
        load(false); if (selected) showDetail(selected, false);
      }, DEMO ? 4000 : 3000);
    } else if (!on && timer) { clearInterval(timer); timer = null; }
    setText($("auto"), t(timer ? "autoOn" : "autoOff"));
    $("auto").setAttribute("aria-pressed", String(!!timer));
  }

  function actionError(r) {
    if (r.status === 429) {
      var secs = Number(r.retryAfter) || 60;
      return setAmsg("rateLimited", { minutes: Math.max(1, Math.ceil(secs / 60)) });
    }
    if (r.status === 403) return setAmsg("forbidden");
    if (r.status === 503) return setAmsg("notConfigured");
    return setAmsg("sampleError");
  }

  // Switching the language re-renders from the data already on screen: no request,
  // the selected event, the filter and the auto-refresh timer stay as they are.
  function setLang(l) {
    if (l === lang) return;
    lang = l;
    save(l);
    applyStatic();
    renderList();
    renderIntake();
    renderDetail();
    if (DEMO) { renderOrder(); renderCalcText(); announce(""); if (calcOk && calcOk.text) $("calcLive").textContent = calcOk.text(); }
  }
  Array.prototype.forEach.call(document.querySelectorAll("[data-lang]"), function (b) {
    b.addEventListener("click", function () { setLang(b.getAttribute("data-lang")); });
  });


  // ================= demo story: order automation =================
  var STEPS = ["invoice", "email", "warehouse", "sheet"];
  function cap(v) { return v.charAt(0).toUpperCase() + v.slice(1); }
  function numFmt(opts) { return new Intl.NumberFormat(lang === "pl" ? "pl-PL" : "en-GB", opts); }
  function announce(text) { var n = $("live"); if (n) n.textContent = text; }

  /** The state of one step comes from the real delivery returned by the API, never from a timer. */
  function stepState(d) {
    if (!d) return { s: order && order.phase !== "idle" ? "waiting" : "idle" };
    if (d.status === "delivered") return { s: "done", retried: d.attempts > 1 };
    if (d.status === "failed" || d.status === "dead") return { s: "failed" };
    if (d.attempts === 0) return { s: "waiting" };
    if (d.attemptLog.length < d.attempts) return { s: "running" };
    return { s: "retry", at: d.nextAttemptAt };
  }
  function setOrderBusy(on) {
    orderBusy = on;
    var b = $("order");
    b.disabled = on;
    b.setAttribute("aria-busy", String(on));
    b.classList.toggle("busy", on);
    setText(b.firstChild, t(on ? "sending" : "orderButton"));
  }
  function autoText() {
    if (!order || order.phase === "idle" || order.phase === "error") return t("compareAutoIdle");
    if (order.phase === "running" || order.phase === "starting") return t("compareAutoRunning");
    return t("compareAuto", { s: numFmt({ minimumFractionDigits: 1, maximumFractionDigits: 1 }).format(order.shownSeconds === undefined ? order.seconds : order.shownSeconds) });
  }
  function renderOrder() {
    var ds = {};
    if (order && order.detail) order.detail.deliveryList.forEach(function (d) { ds[d.destination] = d; });
    var done = 0;
    STEPS.forEach(function (name) {
      var li = document.querySelector('[data-step="' + name + '"]');
      var st = stepState(ds[name]);
      if (st.s === "done") done++;
      var cls = "step st-" + st.s + (st.retried ? " retried" : "") + (li.getAttribute("data-enter") ? " enter" : "");
      if (li.className !== cls) li.className = cls;
      var text = st.s === "idle" ? t("stateIdle") : st.s === "waiting" ? t("stateWaiting") : st.s === "running" ? t("stateRunning")
        : st.s === "retry" ? t("stateRetry", { when: cd(st.at) }) : st.s === "done" ? t(st.retried ? "stateDoneRetried" : "stateDone") : t("stateFailed");
      setText(li.querySelector(".stxt"), text);
      var prev = li.getAttribute("data-last");
      var key = st.s + (st.retried ? "r" : "");
      if (prev !== key) {
        li.setAttribute("data-last", key);
        if (st.s === "retry" || st.s === "done" || st.s === "failed") announce(t("liveStep", { step: t("step" + cap(name)), state: text }));
      }
    });
    var bar = $("bar");
    bar.style.width = (done * 25) + "%";
    var pb = bar.parentNode;
    pb.setAttribute("aria-valuenow", String(done));
    pb.setAttribute("aria-valuetext", t("progressLabel", { n: done, total: 4 }));
    setText($("progress-label"), t("progressLabel", { n: done, total: 4 }));
    setText($("cmpManual"), t("compareManual", { min: numFmt({ maximumFractionDigits: 1 }).format(calcOk ? calcOk.minutes : 8) }));
    setText($("cmpAuto"), autoText());
    return done;
  }
  function animateValue(from, to, ms, apply, done) {
    if (reduceMotion || ms <= 0 || from === to) { apply(to); if (done) done(); return; }
    var t0 = performance.now();
    (function frame(now) {
      var k = Math.min(1, (now - t0) / ms);
      apply(from + (to - from) * (1 - Math.pow(1 - k, 3)));
      if (k < 1) requestAnimationFrame(frame); else if (done) done();
    })(t0);
  }
  function finishOrder(detail) {
    var last = 0;
    detail.deliveryList.forEach(function (d) { if (d.deliveredAt && d.deliveredAt > last) last = d.deliveredAt; });
    order.phase = "done";
    order.seconds = Math.max(0.1, Math.round((last - detail.receivedAt) / 100) / 10);
    order.shownSeconds = 0;
    renderOrder();
    animateValue(0, order.seconds, 700, function (v) { order.shownSeconds = v; setText($("cmpAuto"), autoText()); }, function () { order.shownSeconds = undefined; renderOrder(); });
    announce(t("liveAllDone", { s: numFmt({ minimumFractionDigits: 1, maximumFractionDigits: 1 }).format(order.seconds) }));
    setOrderBusy(false);
  }
  function pollOrder() {
    if (!order || order.phase !== "running") return;
    if (Date.now() - order.startedAt > 90000) { order.phase = "error"; renderOrder(); setOrderMsg("orderSlow"); setOrderBusy(false); return; }
    api("/admin/events/" + encodeURIComponent(order.id)).then(function (r) {
      if (!order || order.phase !== "running") return;
      if (r.ok) {
        order.detail = r.data;
        var done = renderOrder();
        if (done === STEPS.length && r.data.deliveryList.length === STEPS.length) { finishOrder(r.data); return; }
      }
      order.timer = setTimeout(pollOrder, 700);
    }).catch(function () { if (order) order.timer = setTimeout(pollOrder, 1500); });
  }
  var omsgState = null;
  function setOrderMsg(key, vars) { omsgState = key ? { key: key, vars: vars } : null; $("omsg").textContent = key ? t(key, vars) : ""; }
  function startOrder() {
    if (orderBusy) return;
    // Immediate feedback, before any network round trip.
    setOrderBusy(true);
    setOrderMsg(null);
    if (order && order.timer) clearTimeout(order.timer);
    order = { phase: "starting", startedAt: Date.now(), detail: null };
    STEPS.forEach(function (name, i) {
      var li = document.querySelector('[data-step="' + name + '"]');
      li.removeAttribute("data-last");
      li.setAttribute("data-enter", "1");
      li.style.animationDelay = reduceMotion ? "0s" : (i * 90) + "ms";
      li.classList.remove("enter"); void li.offsetWidth;
    });
    renderOrder();
    announce(t("orderStarted"));
    fetch("/demo/order", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ hiccup: $("hiccup").checked }) })
      .then(function (r) { return r.json().then(function (d) { return { ok: r.ok, status: r.status, retryAfter: r.headers.get("retry-after"), data: d }; }); })
      .then(function (r) {
        if (!r.ok) {
          order = null; renderOrder(); setOrderBusy(false);
          if (r.status === 429) { var secs = Number(r.retryAfter) || 60; setOrderMsg("rateLimited", { minutes: Math.max(1, Math.ceil(secs / 60)) }); }
          else if (r.status === 403) setOrderMsg("forbidden");
          else if (r.status === 503) setOrderMsg("notConfigured");
          else setOrderMsg("orderError");
          return;
        }
        order.id = r.data.id; order.phase = "running";
        pollOrder();
      })
      .catch(function () { order = null; renderOrder(); setOrderBusy(false); setOrderMsg("networkError"); });
  }
  function initOrder() {
    $("order").addEventListener("click", startOrder);
    renderOrder();
  }

  // ================= savings calculator =================
  var CALC = {
    orders: { id: "calcOrders", err: "errOrders", msg: "calcErrOrders", min: 1, max: 100000, int: true },
    minutes: { id: "calcMinutes", err: "errMinutes", msg: "calcErrMinutes", min: 0.5, max: 240 },
    rate: { id: "calcRate", err: "errRate", msg: "calcErrRate", min: 1, max: 2000 }
  };
  function parseField(f) {
    var raw = $(f.id).value.trim().replace(/\\s/g, "").replace(",", ".");
    if (raw === "" || !/^\\d+(\\.\\d+)?$/.test(raw)) return null;
    var v = Number(raw);
    if (!isFinite(v) || v < f.min || v > f.max || (f.int && Math.floor(v) !== v)) return null;
    return v;
  }
  var shown = { hours: null, money: null };
  function renderCalcText() {
    if (!calcOk) return;
    var box = $("calcResult");
    box.replaceChildren();
    var parts = t("calcResult").split(/(\\{hours\\}|\\{money\\})/);
    parts.forEach(function (p) {
      if (p === "{hours}" || p === "{money}") {
        var st = document.createElement("strong");
        st.setAttribute("data-k", p === "{hours}" ? "hours" : "money");
        st.textContent = fmtCalc(p === "{hours}" ? "hours" : "money", shown[p === "{hours}" ? "hours" : "money"]);
        box.appendChild(st);
      } else if (p) box.appendChild(document.createTextNode(p));
    });
  }
  function fmtCalc(k, v) { return numFmt(k === "hours" ? { minimumFractionDigits: 1, maximumFractionDigits: 1 } : { maximumFractionDigits: 0 }).format(v); }
  function updateCalc() {
    var vals = {}, ok = true;
    Object.keys(CALC).forEach(function (k) {
      var f = CALC[k], v = parseField(f), input = $(f.id);
      vals[k] = v;
      input.setAttribute("aria-invalid", String(v === null));
      input.setAttribute("aria-describedby", f.err);
      setText($(f.err), v === null ? t(f.msg) : "");
      if (v === null) ok = false;
    });
    if (!ok) return;
    var hours = vals.orders * vals.minutes / 60;
    var target = { hours: hours, money: hours * vals.rate };
    var from = { hours: shown.hours === null ? 0 : shown.hours, money: shown.money === null ? 0 : shown.money };
    calcOk = { minutes: vals.minutes, text: function () { return t("calcResult", { hours: fmtCalc("hours", target.hours), money: fmtCalc("money", target.money) }); } };
    if (shown.hours === null) { shown.hours = 0; shown.money = 0; }
    renderCalcText();
    ["hours", "money"].forEach(function (k) {
      animateValue(from[k], target[k], 500, function (v) {
        shown[k] = v;
        var n = document.querySelector('#calcResult [data-k="' + k + '"]');
        if (n) n.textContent = fmtCalc(k, v);
      }, function () {
        if (k === "money") $("calcLive").textContent = calcOk.text();
      });
    });
    renderOrder();
  }
  function initCalc() {
    Object.keys(CALC).forEach(function (k) { $(CALC[k].id).addEventListener("input", updateCalc); });
    updateCalc();
  }

  $("load").addEventListener("click", function () { load(true); });
  $("filter").addEventListener("change", function () { load(true); });
  $("auto").addEventListener("click", function () { setAuto(!timer); });
  if (DEMO) {
    var actions = {
      "ok": ["/demo/sample", { scenario: "ok" }],
      "flaky": ["/demo/sample", { scenario: "flaky" }],
      "down": ["/demo/sample", { scenario: "down" }],
      "duplicate": ["/demo/duplicate", {}],
      "bad-signature": ["/demo/bad-signature", {}]
    };
    var buttons = document.querySelectorAll("[data-action]");
    Array.prototype.forEach.call(buttons, function (btn) {
      btn.addEventListener("click", function () {
        var a = actions[btn.getAttribute("data-action")];
        busy = true; busyBtn = btn; btn.classList.add("busy"); applyStatic();
        Array.prototype.forEach.call(buttons, function (b) { b.disabled = true; });
        setAmsg(null);
        fetch(a[0], { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(a[1]) }).then(function (r) {
          return r.json().then(function (d) { return { ok: r.ok, status: r.status, retryAfter: r.headers.get("retry-after"), data: d }; });
        }).then(function (r) {
          if (!r.ok) { actionError(r); return; }
          if (r.data.id) { selected = r.data.id; setAmsg("actionDone"); } else setAmsg("actionRejected");
          setAuto(true);
          load(true); if (selected) showDetail(selected, true);
        }).catch(function () { setAmsg("networkError"); })
          .then(function () { busy = false; busyBtn = null; btn.classList.remove("busy"); applyStatic(); Array.prototype.forEach.call(buttons, function (b) { b.disabled = false; }); });
      });
    });
  } else {
    $("token").addEventListener("keydown", function (ev) { if (ev.key === "Enter") load(true); });
  }
  applyStatic();
  renderDetail();
  if (DEMO) {
    renderIntake();
    initOrder();
    initCalc();
    // The developer view loads when it is first opened, not on every visit.
    var devLoaded = false;
    $("dev").addEventListener("toggle", function () {
      if ($("dev").open && !devLoaded) { devLoaded = true; load(true); }
    });
  }
})();
</script>
</body>
</html>`;
}
