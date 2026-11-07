// End-to-end checks for the demo against a running dev server.
//   npx wrangler dev --env demo --port 8962 --test-scheduled --var DEMO_RATE_PER_IP:1000 --var DEMO_RATE_GLOBAL:1000
//   NODE_PATH=<dir with playwright> node scripts/e2e-demo.mjs http://127.0.0.1:8962 [--screenshots]
// Not part of `npm test`: it needs a browser. Exits with code 1 if any check fails.
import { createRequire } from "node:module";

const { chromium, devices } = createRequire(import.meta.url)("playwright");
const BASE = process.argv[2] ?? "http://127.0.0.1:8962";
const SHOTS = process.argv.includes("--screenshots");
let failures = 0;
const check = (ok, label, extra = "") => {
  if (!ok) failures++;
  console.log(`${ok ? "ok  " : "FAIL"} ${label}${extra ? " | " + extra : ""}`);
};
const norm = (s) => s.replace(/[  ]/g, " ").replace(/\s+/g, " ").trim();

const browser = await chromium.launch();

async function newMobile(width, extra = {}) {
  const ctx = await browser.newContext({ ...devices["iPhone 13"], viewport: { width, height: 760 }, screen: { width, height: 760 }, ...extra });
  const page = await ctx.newPage();
  const errors = [];
  page.on("console", (m) => m.type() === "error" && errors.push(m.text()));
  page.on("pageerror", (e) => errors.push(String(e)));
  return { ctx, page, errors, cdp: await ctx.newCDPSession(page) };
}

/** A real touch swipe through CDP. Negative dy: finger moves up, the page scrolls down. */
async function swipe(page, cdp, dy) {
  const x = 190, y0 = dy < 0 ? 560 : 140, steps = 10;
  await cdp.send("Input.dispatchTouchEvent", { type: "touchStart", touchPoints: [{ x, y: y0 }] });
  for (let i = 1; i <= steps; i++) {
    await cdp.send("Input.dispatchTouchEvent", { type: "touchMove", touchPoints: [{ x, y: y0 + (dy * i) / steps }] });
    await page.waitForTimeout(16);
  }
  await cdp.send("Input.dispatchTouchEvent", { type: "touchEnd", touchPoints: [] });
  await page.waitForTimeout(450);
}
const scrollY = (page) => page.evaluate(() => Math.round(window.scrollY));

async function noOverflow(page, label) {
  const w = await page.evaluate(() => ({ inner: innerWidth, scroll: document.documentElement.scrollWidth }));
  const offenders = await page.evaluate(() =>
    [...document.querySelectorAll("body *")]
      .filter((n) => n.getBoundingClientRect().right > innerWidth + 1 && n.offsetParent !== null && !n.closest(".sr-only"))
      .slice(0, 5)
      .map((n) => n.tagName + "." + n.className),
  );
  check(w.scroll <= w.inner && offenders.length === 0, `no horizontal overflow: ${label}`, `inner=${w.inner} scroll=${w.scroll} ${offenders.join(",")}`);
}

/** Clicks the order button from inside the page and measures when the loading state is on screen. */
async function clickOrder(page) {
  return page.evaluate(
    () =>
      new Promise((resolve) => {
        const b = document.getElementById("order");
        const t0 = performance.now();
        b.click();
        requestAnimationFrame(() => {
          const shown = getComputedStyle(b, "::before").content;
          resolve({ ms: performance.now() - t0, busy: b.getAttribute("aria-busy") === "true", disabled: b.disabled, spinner: shown !== "none" && shown !== "normal", label: b.textContent });
        });
      }),
  );
}

/** Samples the page while an order runs: states seen per step, layout height, scroll position. */
async function watchOrder(page, maxMs = 45000) {
  return page.evaluate(
    (limit) =>
      new Promise((resolve) => {
        const seen = new Set(), heights = new Set(), ys = new Set();
        const start = performance.now();
        (function tick() {
          const steps = [...document.querySelectorAll("[data-step]")];
          steps.forEach((s) => (s.className.match(/st-\w+/g) || []).forEach((c) => seen.add(c)));
          if (steps.some((s) => /ponawiam|retrying/.test(s.querySelector(".stxt").textContent))) seen.add("retry-text");
          heights.add(document.documentElement.scrollHeight);
          ys.add(Math.round(scrollY));
          const done = steps.every((s) => s.classList.contains("st-done"));
          if (done || performance.now() - start > limit) resolve({ seen: [...seen], heights: [...heights], ys: [...ys], done, ms: performance.now() - start });
          else setTimeout(tick, 50);
        })();
      }),
    maxMs,
  );
}

for (const width of [390, 360]) {
  console.log(`--- mobile ${width}px (iPhone 13 emulation, CDP touch events)`);
  const { page, errors, cdp } = await newMobile(width);
  await page.goto(BASE + "/?lang=pl");
  await page.waitForSelector("#order");
  await noOverflow(page, "initial");
  await swipe(page, cdp, -200);
  const y0 = await scrollY(page);
  const click = await clickOrder(page);
  check(click.ms < 100 && click.busy && click.disabled && click.spinner, "loading state within 100 ms of the click", JSON.stringify(click));
  check(/Przetwarzam/.test(click.label), "button says it is processing", click.label);
  const w = await watchOrder(page);
  check(w.done && ["st-waiting", "st-running", "st-done"].every((c) => w.seen.includes(c)), "four steps go through waiting, running and done", w.seen.join(","));
  check(w.seen.includes("st-retry") && w.seen.includes("retry-text"), "a retry is shown as 'ponawiam' with a countdown", w.seen.join(","));
  check(w.heights.length === 1, "no layout shift while the order runs", `heights=${w.heights.join(",")}`);
  check(w.ys.length === 1 && w.ys[0] === y0, "scrollY unchanged while the order runs", `y=${w.ys.join(",")} start=${y0}`);
  await page.waitForTimeout(1200);
  check((await page.getAttribute("#steps ~ .progress", "aria-valuenow")) === "4", "progress bar shows 4 of 4");
  check(/^Automatycznie: \d+,\d s$/.test(norm(await page.innerText("#cmpAuto"))), "measured automatic time is shown", await page.innerText("#cmpAuto"));
  check((await page.getAttribute("#order", "aria-busy")) === "false" && !(await page.isDisabled("#order")), "button is ready again");
  await noOverflow(page, "after the order");

  // calculator
  await page.fill("#calcOrders", "100"); await page.fill("#calcMinutes", "6"); await page.fill("#calcRate", "100");
  await page.waitForTimeout(900);
  const res = norm(await page.innerText("#calcResult"));
  check(/10,0 godz\. i 1 ?000 zł miesięcznie/.test(res), "calculator result is right", res);
  check(/Ręcznie: około 6 min/.test(norm(await page.innerText("#cmpManual"))), "manual time follows the calculator", await page.innerText("#cmpManual"));
  await page.fill("#calcOrders", "abc");
  await page.fill("#calcMinutes", "0,2");
  await page.fill("#calcRate", "5000");
  check((await page.getAttribute("#calcOrders", "aria-invalid")) === "true" && (await page.getAttribute("#calcMinutes", "aria-invalid")) === "true" && (await page.getAttribute("#calcRate", "aria-invalid")) === "true", "invalid values are flagged");
  check(norm(await page.innerText("#errOrders")) !== "" && norm(await page.innerText("#calcResult")) === res, "error text shown and the result is not replaced");
  await noOverflow(page, "calculator with errors");
  await page.fill("#calcOrders", "200"); await page.fill("#calcMinutes", "8"); await page.fill("#calcRate", "80");
  await page.waitForTimeout(800);

  // developer view: open, create events, scroll with real touch
  await page.tap("#dev > summary");
  await page.waitForSelector("[data-action]", { state: "visible" });
  for (const a of ["flaky", "duplicate", "bad-signature", "down"]) {
    await page.tap(`[data-action="${a}"]`);
    await page.waitForFunction(() => document.querySelector("[data-action]:not([disabled])"));
  }
  await page.waitForSelector("#rows tr");
  await page.tap("#rows tr >> nth=0");
  await page.waitForSelector("#detail .timeline");
  await noOverflow(page, "developer view with details");
  await page.evaluate(() => {
    const long = "x".repeat(300);
    document.querySelector("#rows tr td:nth-child(3)").textContent = long;
    document.querySelector("#detail pre").textContent = JSON.stringify({ k: long });
    document.querySelector("#detail .timeline .desc").textContent = long;
  });
  await noOverflow(page, "300-character values");
  await page.reload();
  await page.waitForSelector("#order");
  await page.tap("#dev > summary");
  await page.waitForSelector("#rows tr");
  await page.tap("#auto");
  await page.tap("#rows tr >> nth=0");
  await page.waitForSelector("#detail .timeline");
  await page.evaluate(() => window.scrollTo(0, 0));
  const maxY = await page.evaluate(() => document.documentElement.scrollHeight - innerHeight);
  check(maxY > 600, "page is long enough to scroll", `max scrollY=${maxY}`);
  for (let i = 0; i < 25 && (await scrollY(page)) < maxY - 5; i++) await swipe(page, cdp, -500);
  const bottom = await scrollY(page);
  check(bottom > maxY * 0.7, "swipes scrolled down", `scrollY=${bottom} of ${maxY}`);
  let listRequests = 0;
  page.on("request", (r) => /\/admin\/events\?/.test(r.url()) && listRequests++);
  const samples = [];
  for (let i = 0; i < 20; i++) { await page.waitForTimeout(500); samples.push(await scrollY(page)); }
  check(listRequests >= 2, "auto-refresh ran while idle", `${listRequests} list requests in 10 s`);
  check(new Set(samples).size === 1, "scrollY unchanged by refreshes", samples.slice(0, 4).join(",") + "...");
  const ys = [];
  for (let i = 0; i < 25 && (await scrollY(page)) > 0; i++) { await swipe(page, cdp, 500); ys.push(await scrollY(page)); }
  check((await scrollY(page)) === 0, "can scroll back to the top", `${bottom} -> ${ys.join(" -> ")}`);
  check(ys.every((y, i) => i === 0 || y <= ys[i - 1]), "scroll up is monotonic");
  const r0 = listRequests;
  await cdp.send("Input.dispatchTouchEvent", { type: "touchStart", touchPoints: [{ x: 190, y: 400 }] });
  await page.waitForTimeout(6000);
  await cdp.send("Input.dispatchTouchEvent", { type: "touchEnd", touchPoints: [] });
  check(listRequests === r0, "no refresh while the screen is touched", `${listRequests - r0} requests`);
  check(errors.length === 0, "no console errors", errors.join(" | "));
  await page.close();
}

console.log("--- reduced motion");
for (const reduce of [false, true]) {
  const ctx = await browser.newContext({ viewport: { width: 1100, height: 900 }, reducedMotion: reduce ? "reduce" : "no-preference" });
  const page = await ctx.newPage();
  await page.goto(BASE + "/?lang=pl");
  await page.waitForSelector("#order");
  const probe = await page.evaluate(() => {
    const li = document.querySelector('[data-step="invoice"]');
    const saved = li.className;
    li.className = "step st-running";
    const spin = getComputedStyle(li.querySelector(".i-spin")).animationName;
    li.className = "step st-waiting";
    const pulse = getComputedStyle(li.querySelector(".i-pulse")).animationName;
    li.className = saved;
    return { spin, pulse, bar: getComputedStyle(document.getElementById("bar")).transitionDuration };
  });
  if (reduce) check(probe.spin === "none" && probe.pulse === "none" && /^0s(, 0s)*$/.test(probe.bar), "animations are off with prefers-reduced-motion", JSON.stringify(probe));
  else check(probe.spin === "spin" && probe.pulse === "pulse", "animations are on by default", JSON.stringify(probe));
  await ctx.close();
}

console.log("--- language coverage (desktop)");
{
  const ctx = await browser.newContext({ viewport: { width: 1280, height: 900 }, locale: "en-US" });
  const page = await ctx.newPage();
  await page.goto(BASE + "/?lang=pl");
  await page.waitForSelector("#order");
  await page.click("#order");
  await page.waitForFunction(() => [...document.querySelectorAll("[data-step]")].every((s) => s.classList.contains("st-done")), null, { timeout: 45000 });
  await page.click("#dev > summary");
  await page.waitForSelector("[data-action]", { state: "visible" });
  for (const a of ["flaky", "duplicate", "bad-signature", "down"]) {
    await page.click(`[data-action="${a}"]`);
    await page.waitForFunction(() => document.querySelector("[data-action]:not([disabled])"));
  }
  await page.click("#rows tr >> nth=1");
  await page.waitForSelector("#detail .timeline");
  await page.waitForTimeout(1500);
  const visible = () =>
    page.evaluate(() => {
      const c = document.body.cloneNode(true);
      c.querySelectorAll("pre, script, style").forEach((n) => n.remove());
      return c.innerText;
    });
  const ENGLISH = ["the", "and", "with", "from", "for", "your", "event", "events", "delivery", "delivered", "failed", "pending", "success",
    "succeeded", "error", "received", "request", "requests", "signature", "payment", "provider", "sample", "scenario", "send", "run",
    "load", "refresh", "details", "select", "show", "please", "retry", "retries", "retrying", "stored", "ignored", "rejected", "step", "next",
    "try", "tries", "given", "waits", "receiver", "notification", "wrong", "is", "are", "was", "will", "not", "of", "in", "order", "orders",
    "invoice", "issued", "warehouse", "notified", "spreadsheet", "calculator", "savings", "month", "hours", "queued", "done", "place", "shop",
    "manual", "automatically", "processing", "write", "want", "automate", "process", "developers", "hood"];
  const ALLOWED = new Set(["relay", "webhook", "hmac", "crm", "demo", "json", "http", "ms", "pl", "en", "utc", "ok", "id", "a", "i", "w", "o", "u", "z", "do", "na", "to", "po", "co", "jak", "nie", "tak", "za", "od", "ze", "mail", "e"]);
  const polish = await visible();
  const words = (polish.toLowerCase().match(/[a-ząćęłńóśźż]+/g) ?? []).filter((w) => !/^(evt|ord)$/.test(w));
  const bad = [...new Set(words.filter((w) => ENGLISH.includes(w) && !ALLOWED.has(w)))];
  check(bad.length === 0, "Polish view has no typical English words", bad.join(", "));
  check(/[ąćęłńóśźż]/.test(polish) && /Faktura wystawiona/.test(polish) && /Wiersz dodany do arkusza zamówień/.test(polish), "Polish view has the Polish step names");
  if (SHOTS) {
    await page.click("#dev > summary"); // collapse for the hero screenshot
    await page.evaluate(() => window.scrollTo(0, 0));
    await page.screenshot({ path: "docs/panel.png", fullPage: true });
  }
  await page.click('[data-lang="en"]');
  await page.waitForTimeout(300);
  const english = await visible();
  check(!/[ąćęłńóśźż]/i.test(english), "English view has no Polish letters", (english.match(/.{0,20}[ąćęłńóśźż].{0,20}/i) ?? [""])[0]);
  check(/Invoice issued/.test(english) && /Want to automate your own process\? Write to Piotr Majkutewicz\./.test(english), "English view has the English step names and call to action");
  await ctx.close();
}

if (SHOTS) {
  const { page, ctx } = await newMobile(390);
  await page.goto(BASE + "/?lang=pl");
  await page.waitForSelector("#order");
  await page.tap("#order");
  await page.waitForFunction(() => [...document.querySelectorAll("[data-step]")].every((s) => s.classList.contains("st-done")), null, { timeout: 45000 });
  await page.waitForTimeout(1200);
  await page.screenshot({ path: "docs/panel-mobile.png", fullPage: true });
  await ctx.close();
}

await browser.close();
console.log(failures === 0 ? "ALL CHECKS PASSED" : `${failures} CHECK(S) FAILED`);
process.exit(failures === 0 ? 0 : 1);
