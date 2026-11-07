/**
 * Admin panel: one static HTML page. The admin token is typed in by the user
 * and kept only in a JS variable (never in localStorage, cookies or the URL).
 * All server data is inserted with textContent, never innerHTML.
 */
export interface DemoPanelInfo {
  ttlHours: number;
  maxEvents: number;
}

/**
 * In demo mode (`demo` is set) the page needs no token, has no replay button, and offers
 * a "Send a sample event" control. The mode is decided on the server; nothing in this
 * page can switch it.
 */
export function panelHtml(nonce: string, demo: DemoPanelInfo | null = null): string {
  const isDemo = demo !== null;
  return `<!doctype html>
<html lang="en">
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
input, select, button { font:inherit; color:var(--fg); background:#1d1815; border:1px solid var(--line2); border-radius:6px; padding:8px 12px; min-height:40px; }
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
footer { padding:16px 20px 28px; border-top:1px solid var(--line); margin-top:8px; }
</style>
</head>
<body>
<header>
  <h1>webhook<span>-relay</span></h1>
  ${
    isDemo
      ? `<label class="muted" for="scenario">Sample event</label>
  <select id="scenario">
    <option value="flaky">fails twice, then succeeds</option><option value="ok">succeeds at once</option><option value="down">never succeeds (dead-letter)</option>
  </select>
  <button id="send" class="primary" type="button">Send a sample event</button>`
      : `<label class="muted" for="token">Admin token</label>
  <input id="token" type="password" autocomplete="off" placeholder="Bearer token" size="22">`
  }
  <label class="muted" for="filter">Status</label>
  <select id="filter">
    <option value="">all</option><option>pending</option><option>delivered</option><option>failed</option><option>dead</option>
  </select>
  <button id="load" class="primary" type="button">Load</button>
  <button id="auto" type="button" aria-pressed="false">Auto-refresh: off</button>
</header>${
    isDemo
      ? `
<div class="note" role="note">
  <p><strong>Public demo, read-only.</strong> Events here are samples created by the button above and delivered to a simulated destination inside the Worker; nothing is sent to the outside. Replay is disabled. Samples are deleted after ${demo.ttlHours} h, and at most ${demo.maxEvents} are kept. A failed delivery is retried by a cron job that runs once a minute, so a retry shows up within about a minute.</p>
</div>`
      : ""
  }
<main>
  <section aria-label="Events">
    <div id="msg" class="msg" role="status"></div>
    <div class="scroll"><table>
      <thead><tr><th>Received</th><th>Source</th><th>Event key</th><th>Status</th></tr></thead>
      <tbody id="rows"></tbody>
    </table></div>
  </section>
  <section aria-label="Event details" id="detail"><p class="muted">Select an event to see deliveries and attempts.</p></section>
</main>${
    isDemo
      ? `
<footer>
  <a class="cta" href="https://piotrmajkutewicz.pl" rel="noopener">Need reliable integrations between your systems? Talk to Piotr Majkutewicz.</a>
</footer>`
      : ""
  }
<script nonce="${nonce}">
(function () {
  var DEMO = ${isDemo ? "true" : "false"};
  var token = ""; // memory only
  var selected = null, timer = null;
  var $ = function (id) { return document.getElementById(id); };

  function el(tag, text, cls) {
    var n = document.createElement(tag);
    if (text !== undefined && text !== null) n.textContent = String(text);
    if (cls) n.className = cls;
    return n;
  }
  function badge(status) { return el("span", status, "badge " + status); }
  function when(ms) { return ms ? new Date(ms).toISOString().replace("T", " ").replace(/\\.\\d+Z$/, "Z") : "-"; }

  function api(path, opts) {
    opts = opts || {};
    opts.headers = DEMO ? {} : { authorization: "Bearer " + token };
    return fetch(path, opts).then(function (r) {
      return r.json().then(function (d) { return { ok: r.ok, status: r.status, data: d }; });
    });
  }

  function load() {
    if (!DEMO) token = $("token").value;
    var f = $("filter").value;
    api("/admin/events?limit=100" + (f ? "&status=" + encodeURIComponent(f) : "")).then(function (r) {
      if (!r.ok) { $("msg").textContent = r.status === 401 ? "Invalid admin token." : "Error: " + (r.data.error || r.status); return; }
      $("msg").textContent = r.data.events.length ? "" : "No events.";
      var tb = $("rows");
      tb.replaceChildren();
      r.data.events.forEach(function (e) {
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
    }).catch(function () { $("msg").textContent = "Network error."; });
  }

  function showDetail(id) {
    api("/admin/events/" + encodeURIComponent(id)).then(function (r) {
      var box = $("detail");
      box.replaceChildren();
      if (!r.ok) { box.appendChild(el("p", r.data.error || "Error", "msg")); return; }
      var e = r.data;
      var h = el("h2", "Event "); h.appendChild(badge(e.status)); box.appendChild(h);
      box.appendChild(el("p", e.source + " / " + e.eventKey + " / " + when(e.receivedAt), "muted mono"));
      box.appendChild(el("pre", e.body, "mono"));
${isDemo ? "" : `      if (!DEMO) {
        var canReplay = e.deliveryList.some(function (d) { return d.status === "failed" || d.status === "dead"; });
        var btn = el("button", "Replay failed deliveries", "primary");
        btn.type = "button";
        btn.disabled = !canReplay;
        btn.addEventListener("click", function () {
          btn.disabled = true;
          api("/admin/events/" + encodeURIComponent(id) + "/replay", { method: "POST" }).then(function (rr) {
            $("msg").textContent = rr.ok ? "Replay scheduled." : (rr.data.error || "Replay failed.");
            setTimeout(function () { showDetail(id); load(); }, 1500);
          });
        });
        box.appendChild(btn);
      }
`}
      e.deliveryList.forEach(function (d) {
        var c = el("div", null, "card");
        var t = el("div"); t.appendChild(el("strong", d.destination + " ")); t.appendChild(badge(d.status));
        c.appendChild(t);
        c.appendChild(el("div", "attempts: " + d.attempts + ", replays: " + d.replays +
          (d.status === "pending" ? ", next try: " + when(d.nextAttemptAt) : "") +
          (d.deliveredAt ? ", delivered: " + when(d.deliveredAt) : ""), "muted"));
        if (d.lastError) c.appendChild(el("div", "last error: " + d.lastError, "muted"));
        if (d.attemptLog.length) {
          var tbl = el("table"), body = el("tbody");
          var head = el("tr");
          ["#", "replay", "time", "ms", "outcome", "code", "error"].forEach(function (x) { head.appendChild(el("th", x)); });
          tbl.appendChild(el("thead")).appendChild(head);
          d.attemptLog.forEach(function (a) {
            var tr = el("tr");
            [a.attemptNo, a.replayNo, when(a.startedAt), a.durationMs, a.outcome,
             a.statusCode === null ? "-" : a.statusCode, a.error || ""].forEach(function (x) { tr.appendChild(el("td", x, "mono")); });
            body.appendChild(tr);
          });
          tbl.appendChild(body);
          var wrap = el("div", null, "scroll"); wrap.appendChild(tbl); c.appendChild(wrap);
        }
        box.appendChild(c);
      });
    });
  }

  function setAuto(on) {
    if (on && !timer) {
      timer = setInterval(function () {
        if (document.hidden) return;
        load(); if (selected) showDetail(selected);
      }, DEMO ? 5000 : 3000);
    } else if (!on && timer) { clearInterval(timer); timer = null; }
    $("auto").textContent = "Auto-refresh: " + (timer ? "on" : "off");
    $("auto").setAttribute("aria-pressed", String(!!timer));
  }

  $("load").addEventListener("click", load);
  $("filter").addEventListener("change", load);
  $("auto").addEventListener("click", function () { setAuto(!timer); });
  if (DEMO) {
    $("send").addEventListener("click", function () {
      var btn = $("send");
      btn.disabled = true;
      $("msg").textContent = "Sending...";
      fetch("/demo/sample", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ scenario: $("scenario").value })
      }).then(function (r) {
        return r.json().then(function (d) { return { ok: r.ok, data: d }; });
      }).then(function (r) {
        if (!r.ok) { $("msg").textContent = r.data.error || "Could not send the sample event."; return; }
        selected = r.data.id;
        $("msg").textContent = "";
        setAuto(true);
        load(); showDetail(selected);
      }).catch(function () { $("msg").textContent = "Network error."; })
        .then(function () { btn.disabled = false; });
    });
    load();
  } else {
    $("token").addEventListener("keydown", function (ev) { if (ev.key === "Enter") load(); });
  }
})();
</script>
</body>
</html>`;
}
