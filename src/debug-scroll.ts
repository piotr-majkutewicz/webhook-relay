// Scroll diagnostics, active only when the page is opened with ?dbg=1. It adds an on-screen log of
// scroll, touch and resize events so a stuck scroll on a real phone can be analysed from a screenshot.
export const DEBUG_SCROLL_JS = String.raw`
(function () {
  if (!/[?&]dbg=1(&|$)/.test(location.search)) return;
  var KEY = "dbgScrollLog";
  var lines = [];
  var prev = [];
  try { prev = JSON.parse(sessionStorage.getItem(KEY) || "[]"); } catch (e) {}
  var box = document.createElement("div");
  var st = box.style;
  st.position = "fixed"; st.left = "0"; st.right = "0"; st.bottom = "0"; st.maxHeight = "44vh";
  st.overflow = "hidden"; st.background = "rgba(0,0,0,0.88)"; st.color = "#9f9";
  st.font = "11px/1.3 monospace"; st.padding = "6px 8px"; st.zIndex = "2147483647";
  st.whiteSpace = "pre-wrap"; st.pointerEvents = "none"; st.overflowWrap = "anywhere";
  function t() {
    var d = new Date();
    return ("0" + d.getMinutes()).slice(-2) + ":" + ("0" + d.getSeconds()).slice(-2) + "." + ("00" + d.getMilliseconds()).slice(-3);
  }
  function info() {
    var vv = window.visualViewport;
    return "y=" + Math.round(window.scrollY) + " docH=" + document.documentElement.scrollHeight + " innerH=" + window.innerHeight +
      (vv ? " vv=" + Math.round(vv.height) + "@" + Math.round(vv.offsetTop) + " x" + vv.scale.toFixed(2) : "");
  }
  function save() { try { sessionStorage.setItem(KEY, JSON.stringify(lines.slice(-60))); } catch (e) {} }
  function show() {
    var head = prev.length ? "PREVIOUS LOAD, last lines:\n" + prev.slice(-9).join("\n") + "\n--- NEW LOAD ---\n" : "";
    box.textContent = head + lines.slice(-13).join("\n");
  }
  function log(m) {
    lines.push(t() + " " + m);
    if (lines.length > 200) lines.shift();
    save();
    show();
  }
  function tag(el) {
    if (!el || !el.tagName) return "?";
    return el.tagName.toLowerCase() + (el.id ? "#" + el.id : "") + (el.className && typeof el.className === "string" ? "." + el.className.split(" ")[0] : "");
  }
  function stackLine() {
    var s = (new Error().stack || "").split("\n");
    return (s[3] || s[2] || "").replace(/^\s+/, "").slice(0, 90);
  }
  var nav = "";
  try { nav = performance.getEntriesByType("navigation")[0].type; } catch (e) {}
  log("load nav=" + nav + " dpr=" + window.devicePixelRatio + " standalone=" + (window.navigator.standalone === true) + " " + info());
  log("ua=" + navigator.userAgent.slice(0, 110));

  var lastY = Math.round(window.scrollY);
  window.addEventListener("scroll", function () {
    var y = Math.round(window.scrollY);
    if (Math.abs(y - lastY) >= 1) { log("scroll " + lastY + "->" + y + " " + (y < lastY ? "UP" : "down")); lastY = y; }
  }, { passive: true });

  var moves = 0;
  window.addEventListener("touchstart", function (ev) {
    moves = 0;
    var tc = ev.touches[0];
    log("touchstart " + tag(ev.target) + " cy=" + Math.round(tc ? tc.clientY : -1) + " " + info());
  }, { capture: true, passive: true });
  window.addEventListener("touchmove", function (ev) {
    moves++;
    if (moves === 1 || moves % 10 === 0) {
      var tc = ev.touches[0];
      log("touchmove#" + moves + " cy=" + Math.round(tc ? tc.clientY : -1) + " cancelable=" + ev.cancelable + " prevented=" + ev.defaultPrevented);
    }
  }, { passive: true });
  window.addEventListener("touchend", function () { log("touchend moves=" + moves + " " + info()); }, { capture: true, passive: true });
  window.addEventListener("touchcancel", function () { log("touchcancel " + info()); }, { capture: true, passive: true });
  window.addEventListener("resize", function () { log("resize " + info()); });
  if (window.visualViewport) {
    window.visualViewport.addEventListener("resize", function () { log("vv-resize " + info()); });
    window.visualViewport.addEventListener("scroll", function () { log("vv-scroll " + info()); });
  }
  window.addEventListener("pagehide", function () { log("PAGEHIDE persisted=" + "?" + " " + info()); });
  window.addEventListener("beforeunload", function () { log("BEFOREUNLOAD " + info()); });
  document.addEventListener("visibilitychange", function () { log("visibility=" + document.visibilityState); });

  ["scrollTo", "scrollBy", "scroll"].forEach(function (name) {
    var orig = window[name];
    if (typeof orig !== "function") return;
    window[name] = function () {
      log("window." + name + "(" + Array.prototype.slice.call(arguments).map(function (a) { return typeof a === "object" ? JSON.stringify(a) : String(a); }).join(",") + ") from " + stackLine());
      return orig.apply(window, arguments);
    };
  });
  var origInto = Element.prototype.scrollIntoView;
  Element.prototype.scrollIntoView = function () {
    log("scrollIntoView " + tag(this) + " from " + stackLine());
    return origInto.apply(this, arguments);
  };

  var lastInfo = "";
  setInterval(function () {
    var i = info();
    if (i !== lastInfo) { lastInfo = i; log("tick " + i); }
  }, 1000);

  function mount() { (document.body || document.documentElement).appendChild(box); show(); }
  if (document.body) mount(); else document.addEventListener("DOMContentLoaded", mount);
})();
`;
