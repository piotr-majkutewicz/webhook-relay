import { DEFAULT_LANG, dictionaries, type Dict, type Key, type Lang } from "./i18n";

/**
 * Admin panel: one HTML page, rendered in Polish by default with an EN switch.
 * The admin token is typed in by the user and kept only in a JS variable (never in
 * cookies or the URL). The only thing stored in localStorage is the chosen language.
 * All texts come from the dictionaries in src/i18n; all server data is inserted
 * with textContent, never innerHTML.
 */
export interface DemoPanelInfo {
  ttlHours: number;
  maxEvents: number;
}

const esc = (v: string): string =>
  v.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");

function format(text: string, vars: Record<string, string | number> = {}): string {
  return text.replace(/\{(\w+)\}/g, (m, k: string) => (k in vars ? String(vars[k]) : m));
}

/** Demo pages carry no token or replay texts at all. */
function dictFor(d: Dict, isDemo: boolean): Partial<Dict> {
  if (!isDemo) return d;
  return Object.fromEntries(Object.entries(d).filter(([k]) => !k.startsWith("replay") && !k.startsWith("token")));
}

/**
 * In demo mode (`demo` is set) the page needs no token, has no replay button, and offers
 * a "Send a sample event" control. The mode is decided on the server; nothing in this
 * page can switch it. `lang` is only the initial language of the server-rendered text;
 * the script then applies ?lang=, the saved choice, or the default (Polish).
 */
export function panelHtml(nonce: string, demo: DemoPanelInfo | null = null, lang: Lang = DEFAULT_LANG): string {
  const isDemo = demo !== null;
  const d = dictionaries[lang];
  const t = (k: Key, vars?: Record<string, string | number>): string => esc(format(d[k], vars));
  // JSON in a non-executed script block; "<" is escaped so the data cannot close the tag.
  const i18nJson = JSON.stringify({ pl: dictFor(dictionaries.pl, isDemo), en: dictFor(dictionaries.en, isDemo) }).replace(/</g, "\\u003c");
  const pressed = (l: Lang) => (l === lang ? "true" : "false");
  return `<!doctype html>
<html lang="${lang}">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<meta name="robots" content="noindex, nofollow">
<title>webhook-relay</title>
<style nonce="${nonce}">
:root { --bg:#14110f; --fg:#f2ebdd; --muted:#a99f90; --line:#2f2823; --line2:#4a4038; --accent:#ef4444; --ok:#7fb069; --warn:#e0a458; }
* { box-sizing: border-box; }
body { margin:0; background:var(--bg); color:var(--fg); font:15px/1.5 system-ui,-apple-system,"Segoe UI",Roboto,sans-serif; }
header { display:flex; flex-wrap:wrap; gap:12px; align-items:center; padding:16px 20px; border-bottom:1px solid var(--line); }
h1 { font-size:18px; margin:0 auto 0 0; letter-spacing:.02em; }
h1 span { color:var(--accent); }
main { display:grid; grid-template-columns:minmax(0,1.2fr) minmax(0,1fr); gap:20px; padding:20px; }
@media (max-width:900px) { main { grid-template-columns:1fr; } }
input, select, button { font:inherit; color:var(--fg); background:#1d1815; border:1px solid var(--line2); border-radius:6px; padding:8px 12px; min-height:44px; }
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
pre { background:#0f0d0b; border:1px solid var(--line); border-radius:6px; padding:10px; overflow:auto; max-height:240px; white-space:pre-wrap; word-break:break-word; }
.card { border:1px solid var(--line); border-radius:8px; padding:12px; margin:12px 0; }
.msg { color:var(--accent); min-height:1.5em; }
.mono { font-family:ui-monospace,SFMono-Regular,Menlo,monospace; font-size:13px; }
.scroll { overflow-x:auto; }
.note { margin:0 20px; padding:12px 16px; border:1px solid var(--line2); border-radius:8px; background:#1a1613; }
.note p { margin:0 0 6px; }
a { color:var(--accent); }
a:hover { color:var(--fg); }
a.cta { display:inline-block; padding:10px 0; min-height:44px; }
.lang { display:flex; gap:4px; }
.lang button { min-width:44px; min-height:44px; font-weight:600; }
.lang button[aria-pressed="true"] { border-color:var(--accent); color:var(--accent); }
.tz { margin:8px 0 0; font-size:13px; }
footer { padding:16px 20px 28px; border-top:1px solid var(--line); margin-top:8px; }
</style>
</head>
<body>
<header>
  <h1>webhook<span>-relay</span></h1>
  ${
    isDemo
      ? `<label class="muted" for="scenario" data-i18n="sampleLabel">${t("sampleLabel")}</label>
  <select id="scenario">
    <option value="flaky" data-i18n="scenarioFlaky">${t("scenarioFlaky")}</option><option value="ok" data-i18n="scenarioOk">${t("scenarioOk")}</option><option value="down" data-i18n="scenarioDown">${t("scenarioDown")}</option>
  </select>
  <button id="send" class="primary" type="button" data-i18n="sendButton">${t("sendButton")}</button>`
      : `<label class="muted" for="token" data-i18n="tokenLabel">${t("tokenLabel")}</label>
  <input id="token" type="password" autocomplete="off" placeholder="${t("tokenPlaceholder")}" data-i18n-ph="tokenPlaceholder" size="22">`
  }
  <label class="muted" for="filter" data-i18n="statusLabel">${t("statusLabel")}</label>
  <select id="filter">
    <option value="" data-i18n="filterAll">${t("filterAll")}</option><option value="pending" data-i18n="statusPending">${t("statusPending")}</option><option value="delivered" data-i18n="statusDelivered">${t("statusDelivered")}</option><option value="failed" data-i18n="statusFailed">${t("statusFailed")}</option><option value="dead" data-i18n="statusDead">${t("statusDead")}</option>
  </select>
  <button id="load" class="primary" type="button" data-i18n="loadButton">${t("loadButton")}</button>
  <button id="auto" type="button" aria-pressed="false" data-i18n="autoOff">${t("autoOff")}</button>
  <div class="lang" role="group" aria-label="${t("languageGroup")}" data-i18n-aria="languageGroup">
    <button type="button" data-lang="pl" lang="pl" aria-label="Polski" aria-pressed="${pressed("pl")}">PL</button>
    <button type="button" data-lang="en" lang="en" aria-label="English" aria-pressed="${pressed("en")}">EN</button>
  </div>
</header>${
    isDemo
      ? `
<div class="note" role="note">
  <p><strong data-i18n="demoTitle">${t("demoTitle")}</strong> <span data-i18n="demoText">${t("demoText", { ttl: demo.ttlHours, max: demo.maxEvents })}</span></p>
</div>`
      : ""
  }
<main>
  <section aria-label="${t("eventsSection")}" data-i18n-aria="eventsSection">
    <div id="msg" class="msg" role="status"></div>
    <div class="scroll"><table>
      <thead><tr><th data-i18n="colReceived">${t("colReceived")}</th><th data-i18n="colSource">${t("colSource")}</th><th data-i18n="colKey">${t("colKey")}</th><th data-i18n="colStatus">${t("colStatus")}</th></tr></thead>
      <tbody id="rows"></tbody>
    </table></div>
    <p id="tz" class="muted tz"></p>
  </section>
  <section aria-label="${t("detailsSection")}" data-i18n-aria="detailsSection" id="detail"><p class="muted" data-i18n="selectHint">${t("selectHint")}</p></section>
</main>${
    isDemo
      ? `
<footer>
  <a class="cta" href="https://piotrmajkutewicz.pl" rel="noopener" data-i18n="cta">${t("cta")}</a>
</footer>`
      : ""
  }
<script nonce="${nonce}" type="application/json" id="i18n">${i18nJson}</script>
<script nonce="${nonce}">
(function () {
  var DEMO = ${isDemo ? JSON.stringify({ ttl: demo.ttlHours, max: demo.maxEvents }) : "false"};
  var I18N = JSON.parse(document.getElementById("i18n").textContent);
  var STORE_KEY = "relay.lang";
  var token = ""; // memory only
  var selected = null, timer = null;
  var lastEvents = null, lastDetail = null, msgState = null;
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
  var OUTCOME = { success: "outcomeSuccess", permanent: "outcomePermanent", retry: "outcomeRetry" };

  function el(tag, text, cls) {
    var n = document.createElement(tag);
    if (text !== undefined && text !== null) n.textContent = String(text);
    if (cls) n.className = cls;
    return n;
  }
  function badge(status) { return el("span", statusLabel(status), "badge " + status); }

  function setMsg(key, vars) { msgState = key ? { key: key, vars: vars } : null; $("msg").textContent = key ? t(key, vars) : ""; }

  // ---- static texts ----
  function applyStatic() {
    document.documentElement.lang = lang;
    var vars = DEMO ? { ttl: DEMO.ttl, max: DEMO.max } : {};
    Array.prototype.forEach.call(document.querySelectorAll("[data-i18n]"), function (n) {
      var k = n.getAttribute("data-i18n");
      if (k === "autoOn" || k === "autoOff") k = timer ? "autoOn" : "autoOff";
      n.textContent = t(k, vars);
    });
    Array.prototype.forEach.call(document.querySelectorAll("[data-i18n-ph]"), function (n) { n.setAttribute("placeholder", t(n.getAttribute("data-i18n-ph"))); });
    Array.prototype.forEach.call(document.querySelectorAll("[data-i18n-aria]"), function (n) { n.setAttribute("aria-label", t(n.getAttribute("data-i18n-aria"))); });
    Array.prototype.forEach.call(document.querySelectorAll("[data-lang]"), function (n) {
      n.setAttribute("aria-pressed", String(n.getAttribute("data-lang") === lang));
    });
    $("tz").textContent = t("timeZoneNote", { tz: tzName });
    if (msgState) $("msg").textContent = t(msgState.key, msgState.vars);
    $("auto").setAttribute("aria-pressed", String(!!timer));
  }

  function api(path, opts) {
    opts = opts || {};
    opts.headers = DEMO ? {} : { authorization: "Bearer " + token };
    return fetch(path, opts).then(function (r) {
      return r.json().then(function (d) { return { ok: r.ok, status: r.status, data: d }; });
    });
  }

  // ---- list ----
  function renderList() {
    var tb = $("rows");
    tb.replaceChildren();
    if (!lastEvents) return;
    lastEvents.forEach(function (e) {
      var tr = document.createElement("tr");
      tr.tabIndex = 0;
      if (e.id === selected) tr.className = "sel";
      tr.appendChild(el("td", when(e.receivedAt), "mono"));
      tr.appendChild(el("td", e.source));
      tr.appendChild(el("td", e.eventKey, "mono"));
      var td = document.createElement("td"); td.appendChild(badge(e.status)); tr.appendChild(td);
      var open = function () { selected = e.id; showDetail(e.id); load(); };
      tr.addEventListener("click", open);
      tr.addEventListener("keydown", function (ev) { if (ev.key === "Enter") open(); });
      tb.appendChild(tr);
    });
  }

  function load() {
    if (!DEMO) token = $("token").value;
    var f = $("filter").value;
    api("/admin/events?limit=100" + (f ? "&status=" + encodeURIComponent(f) : "")).then(function (r) {
      if (!r.ok) { if (r.status === 401) setMsg("invalidToken"); else setMsg("errorGeneric", { error: r.data.error || r.status }); return; }
      lastEvents = r.data.events;
      setMsg(lastEvents.length ? null : "noEvents");
      renderList();
    }).catch(function () { setMsg("networkError"); });
  }

  // ---- details ----
  function renderDetail() {
    var box = $("detail");
    box.replaceChildren();
    if (!lastDetail) { box.appendChild(el("p", t("selectHint"), "muted")); return; }
    if (lastDetail.err) { box.appendChild(el("p", t(lastDetail.err, lastDetail.vars), "msg")); return; }
    var e = lastDetail.event;
    var id = e.id;
    var h = el("h2", t("eventTitle") + " "); h.appendChild(badge(e.status)); box.appendChild(h);
    box.appendChild(el("p", e.source + " / " + e.eventKey + " / " + when(e.receivedAt), "muted mono"));
    box.appendChild(el("pre", e.body, "mono"));
${isDemo ? "" : `    var canReplay = e.deliveryList.some(function (d) { return d.status === "failed" || d.status === "dead"; });
    var btn = el("button", t("replayButton"), "primary");
    btn.type = "button";
    btn.disabled = !canReplay;
    btn.addEventListener("click", function () {
      btn.disabled = true;
      api("/admin/events/" + encodeURIComponent(id) + "/replay", { method: "POST" }).then(function (rr) {
        if (rr.ok) setMsg("replayScheduled"); else setMsg("errorGeneric", { error: rr.data.error || rr.status });
        setTimeout(function () { showDetail(id); load(); }, 1500);
      });
    });
    box.appendChild(btn);
`}    e.deliveryList.forEach(function (d) {
      var c = el("div", null, "card");
      var tt = el("div"); tt.appendChild(el("strong", d.destination + " ")); tt.appendChild(badge(d.status));
      c.appendChild(tt);
      c.appendChild(el("div", t("detailStats", { attempts: d.attempts, replays: d.replays }) +
        (d.status === "pending" ? t("detailNext", { time: when(d.nextAttemptAt) }) : "") +
        (d.deliveredAt ? t("detailDelivered", { time: when(d.deliveredAt) }) : ""), "muted"));
      if (d.lastError) c.appendChild(el("div", t("detailLastError", { error: d.lastError }), "muted"));
      if (d.attemptLog.length) {
        var tbl = el("table"), body = el("tbody");
        var head = el("tr");
        ["thNo", "thReplay", "thTime", "thMs", "thOutcome", "thCode", "thError"].forEach(function (k) { head.appendChild(el("th", t(k))); });
        tbl.appendChild(el("thead")).appendChild(head);
        d.attemptLog.forEach(function (a) {
          var tr = el("tr");
          [a.attemptNo, a.replayNo, when(a.startedAt), a.durationMs, OUTCOME[a.outcome] ? t(OUTCOME[a.outcome]) : a.outcome,
           a.statusCode === null ? "-" : a.statusCode, a.error || ""].forEach(function (x) { tr.appendChild(el("td", x, "mono")); });
          body.appendChild(tr);
        });
        tbl.appendChild(body);
        var wrap = el("div", null, "scroll"); wrap.appendChild(tbl); c.appendChild(wrap);
      }
      box.appendChild(c);
    });
  }

  function showDetail(id) {
    api("/admin/events/" + encodeURIComponent(id)).then(function (r) {
      if (!r.ok) {
        lastDetail = r.status === 404 ? { err: "eventNotFound" } : { err: "errorGeneric", vars: { error: r.data.error || r.status } };
      } else {
        lastDetail = { event: r.data };
      }
      renderDetail();
    });
  }

  function setAuto(on) {
    if (on && !timer) {
      timer = setInterval(function () {
        if (document.hidden) return;
        load(); if (selected) showDetail(selected);
      }, DEMO ? 5000 : 3000);
    } else if (!on && timer) { clearInterval(timer); timer = null; }
    $("auto").textContent = t(timer ? "autoOn" : "autoOff");
    $("auto").setAttribute("aria-pressed", String(!!timer));
  }

  function sampleError(r) {
    if (r.status === 429) {
      var secs = Number(r.retryAfter) || 60;
      return setMsg("rateLimited", { minutes: Math.max(1, Math.ceil(secs / 60)) });
    }
    if (r.status === 403) return setMsg("forbidden");
    if (r.status === 503) return setMsg("notConfigured");
    return setMsg("sampleError");
  }

  // Switching the language re-renders from the data already on screen: no request,
  // the selected event, the filter and the auto-refresh timer stay as they are.
  function setLang(l) {
    if (l === lang) return;
    lang = l;
    save(l);
    applyStatic();
    renderList();
    renderDetail();
  }
  Array.prototype.forEach.call(document.querySelectorAll("[data-lang]"), function (b) {
    b.addEventListener("click", function () { setLang(b.getAttribute("data-lang")); });
  });

  $("load").addEventListener("click", load);
  $("filter").addEventListener("change", load);
  $("auto").addEventListener("click", function () { setAuto(!timer); });
  if (DEMO) {
    $("send").addEventListener("click", function () {
      var btn = $("send");
      btn.disabled = true;
      setMsg("sending");
      fetch("/demo/sample", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ scenario: $("scenario").value })
      }).then(function (r) {
        return r.json().then(function (d) { return { ok: r.ok, status: r.status, retryAfter: r.headers.get("retry-after"), data: d }; });
      }).then(function (r) {
        if (!r.ok) { sampleError(r); return; }
        selected = r.data.id;
        setMsg(null);
        setAuto(true);
        load(); showDetail(selected);
      }).catch(function () { setMsg("networkError"); })
        .then(function () { btn.disabled = false; });
    });
  } else {
    $("token").addEventListener("keydown", function (ev) { if (ev.key === "Enter") load(); });
  }
  applyStatic();
  renderDetail();
  if (DEMO) load();
})();
</script>
</body>
</html>`;
}
