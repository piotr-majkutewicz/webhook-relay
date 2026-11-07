// End-to-end checks for the demo panel against a running dev server.
//   npx wrangler dev --env demo --port 8942 --test-scheduled --var DEMO_RATE_PER_IP:1000 --var DEMO_RATE_GLOBAL:1000
//   NODE_PATH=<dir with playwright> node scripts/e2e-demo.mjs http://127.0.0.1:8942 [--screenshots]
// Not part of `npm test`: it needs a browser. Exits with code 1 if any check fails.
import { createRequire } from "node:module";

const { chromium, devices } = createRequire(import.meta.url)("playwright");
const BASE = process.argv[2] ?? "http://127.0.0.1:8942";
const SHOTS = process.argv.includes("--screenshots");
let failures = 0;
const check = (ok, label, extra = "") => {
  if (!ok) failures++;
  console.log(`${ok ? "ok  " : "FAIL"} ${label}${extra ? " | " + extra : ""}`);
};

const browser = await chromium.launch();

async function newPage(width) {
  const base = devices["iPhone 13"];
  const ctx = await browser.newContext({ ...base, viewport: { width, height: 760 }, screen: { width, height: 760 } });
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
const widths = (page) => page.evaluate(() => ({ inner: innerWidth, scroll: document.documentElement.scrollWidth }));

async function noOverflow(page, label) {
  const w = await widths(page);
  const offenders = await page.evaluate(() =>
    [...document.querySelectorAll("body *")]
      .filter((n) => n.getBoundingClientRect().right > innerWidth + 1 && n.offsetParent !== null)
      .slice(0, 5)
      .map((n) => n.tagName + "." + n.className),
  );
  check(w.scroll <= w.inner && offenders.length === 0, `no horizontal overflow: ${label}`, `inner=${w.inner} scroll=${w.scroll} ${offenders.join(",")}`);
}

for (const width of [390, 360]) {
  console.log(`--- mobile ${width}px (iPhone 13 emulation, CDP touch events)`);
  const { page, errors, cdp } = await newPage(width);
  let listRequests = 0;
  page.on("request", (r) => /\/admin\/events\?/.test(r.url()) && listRequests++);
  await page.goto(BASE + "/?lang=pl");
  await page.waitForSelector("[data-action]");
  await noOverflow(page, "initial");
  for (const a of ["ok", "flaky", "down", "duplicate", "bad-signature", "flaky", "ok"]) {
    await page.tap(`[data-action="${a}"]`);
    await page.waitForFunction(() => document.querySelector("[data-action]:not([disabled])"));
  }
  await page.waitForSelector("#rows tr");
  await noOverflow(page, "list and details after actions");
  await page.tap("#rows tr >> nth=0");
  await page.waitForSelector("#detail .timeline");
  await noOverflow(page, "event details");
  // very long values must wrap, not widen the page
  await page.evaluate(() => {
    const long = "x".repeat(300);
    document.querySelector("#rows tr td:nth-child(3)").textContent = long;
    document.querySelector("#detail pre").textContent = JSON.stringify({ k: long });
    document.querySelector("#detail .timeline .desc").textContent = long;
  });
  await noOverflow(page, "300-character values");
  // the injected values are replaced by real data on the next refresh; start the scroll test from a clean page
  await page.reload();
  await page.waitForSelector("#rows tr");
  await page.tap("#auto");
  await page.tap("#rows tr >> nth=0");
  await page.waitForSelector("#detail .timeline");

  // scroll down with real touch gestures, hold still through several auto-refresh cycles, scroll back up
  await page.evaluate(() => window.scrollTo(0, 0));
  const maxY = await page.evaluate(() => document.documentElement.scrollHeight - innerHeight);
  check(maxY > 600, "page is long enough to scroll", `max scrollY=${maxY}`);
  for (let i = 0; i < 25 && (await scrollY(page)) < maxY - 5; i++) await swipe(page, cdp, -500);
  const bottom = await scrollY(page);
  check(bottom > maxY * 0.7, "swipes scrolled down", `scrollY=${bottom} of ${maxY}`);
  const before = listRequests;
  const samples = [];
  for (let i = 0; i < 20; i++) { await page.waitForTimeout(500); samples.push(await scrollY(page)); }
  check(listRequests - before >= 2, "auto-refresh ran while idle", `${listRequests - before} list requests in 10 s`);
  check(new Set(samples).size === 1, "scrollY unchanged by refreshes", samples.join(","));
  const ys = [];
  for (let i = 0; i < 12 && (await scrollY(page)) > 0; i++) { await swipe(page, cdp, 500); ys.push(await scrollY(page)); }
  check((await scrollY(page)) === 0, "can scroll back to the top", `scrollY path: ${bottom} -> ${ys.join(" -> ")}`);
  check(ys.every((y, i) => i === 0 || y <= ys[i - 1]), "scroll up is monotonic");
  // a refresh must not run while the finger is down
  const r0 = listRequests;
  await cdp.send("Input.dispatchTouchEvent", { type: "touchStart", touchPoints: [{ x: 190, y: 400 }] });
  await page.waitForTimeout(6000);
  await cdp.send("Input.dispatchTouchEvent", { type: "touchEnd", touchPoints: [] });
  check(listRequests === r0, "no refresh while the screen is touched", `${listRequests - r0} requests`);
  check(errors.length === 0, "no console errors", errors.join(" | "));
  if (SHOTS && width === 390) {
    await page.evaluate(() => window.scrollTo(0, 0));
    await page.tap("#rows tr >> nth=0");
    await page.waitForTimeout(800);
    await page.screenshot({ path: "docs/panel-mobile.png", fullPage: true });
  }
  await page.close();
}

console.log("--- language coverage (desktop)");
{
  const ctx = await browser.newContext({ viewport: { width: 1280, height: 900 }, locale: "en-US" });
  const page = await ctx.newPage();
  await page.goto(BASE + "/?lang=pl");
  await page.waitForSelector("[data-action]");
  for (const a of ["flaky", "duplicate", "bad-signature", "down"]) {
    await page.click(`[data-action="${a}"]`);
    await page.waitForFunction(() => document.querySelector("[data-action]:not([disabled])"));
  }
  await page.click("#rows tr >> nth=1");
  await page.waitForSelector("#detail .timeline");
  // wait until the flaky event shows a failed try and a countdown or a later state
  await page.waitForTimeout(1500);
  const visible = () =>
    page.evaluate(() => {
      const c = document.body.cloneNode(true);
      c.querySelectorAll("pre, script, style").forEach((n) => n.remove());
      return c.innerText;
    });
  const ENGLISH = ["the", "and", "with", "from", "for", "your", "event", "events", "delivery", "delivered", "failed", "pending", "success",
    "succeeded", "error", "received", "request", "requests", "signature", "payment", "provider", "sample", "scenario", "send", "run",
    "load", "refresh", "details", "select", "show", "please", "retry", "retries", "stored", "ignored", "rejected", "step", "next",
    "try", "tries", "given", "up", "waits", "receiver", "notification", "wrong", "is", "are", "was", "will", "not", "of", "in"];
  // technical names that are allowed in Polish text
  const ALLOWED = new Set(["relay", "webhook", "hmac", "crm", "demo", "json", "http", "ms", "pl", "en", "utc", "simulated", "ok", "id", "a", "i", "w", "o", "u", "z", "do", "na", "to", "po", "co", "jak", "nie", "tak", "za", "od", "ze"]);
  const polish = await visible();
  const words = (polish.toLowerCase().match(/[a-ząćęłńóśźż]+/g) ?? []).filter((w) => !/^evt$/.test(w));
  const bad = [...new Set(words.filter((w) => ENGLISH.includes(w) && !ALLOWED.has(w)))];
  check(bad.length === 0, "Polish view has no typical English words", bad.join(", "));
  check(/[ąćęłńóśźż]/.test(polish), "Polish view has Polish text");
  await page.click('[data-lang="en"]');
  await page.waitForTimeout(300);
  const english = await visible();
  check(!/[ąćęłńóśźż]/i.test(english), "English view has no Polish letters", (english.match(/.{0,20}[ąćęłńóśźż].{0,20}/i) ?? [""])[0]);
  await ctx.close();
}

await browser.close();
console.log(failures === 0 ? "ALL CHECKS PASSED" : `${failures} CHECK(S) FAILED`);
process.exit(failures === 0 ? 1 - 1 : 1);
