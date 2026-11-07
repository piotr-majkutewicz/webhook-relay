import { describe, expect, it } from "vitest";
import type { Env } from "../src/config";
import { dictionaries, parseLang } from "../src/i18n";
import { createWorker } from "../src/index";
import { MemoryRepository } from "./memoryRepo";

function harness(vars: Record<string, string> = {}) {
  const repo = new MemoryRepository();
  const worker = createWorker(() => repo);
  const pending: Promise<unknown>[] = [];
  const ctx = { waitUntil: (p: Promise<unknown>) => void pending.push(p), passThroughOnException() {} } as unknown as ExecutionContext;
  const env = { DB: {}, DEMO_SOURCE_SECRET: "demo-secret", ADMIN_TOKEN: "admin-token", ...vars } as unknown as Env;
  const call = async (path: string, init: RequestInit = {}) => {
    const res = await worker.fetch!(new Request(`https://relay.test${path}`, init) as never, env, ctx);
    await Promise.all(pending.splice(0));
    return res;
  };
  return { repo, call };
}
const placeholders = (s: string) => [...s.matchAll(/\{(\w+)\}/g)].map((m) => m[1]).sort();

describe("dictionaries", () => {
  it("define the same keys in Polish and English, none empty", () => {
    const pl = Object.keys(dictionaries.pl).sort();
    expect(pl).toEqual(Object.keys(dictionaries.en).sort());
    for (const lang of ["pl", "en"] as const) {
      for (const [k, v] of Object.entries(dictionaries[lang])) expect(v.trim(), `${lang}.${k}`).not.toBe("");
    }
  });

  it("use the same placeholders in both languages", () => {
    for (const k of Object.keys(dictionaries.en) as (keyof typeof dictionaries.en)[]) {
      expect(placeholders(dictionaries.pl[k]), k).toEqual(placeholders(dictionaries.en[k]));
    }
  });

  it("avoid long dashes and raw HTML in texts", () => {
    for (const lang of ["pl", "en"] as const) {
      for (const [k, v] of Object.entries(dictionaries[lang])) {
        expect(v, `${lang}.${k}`).not.toMatch(/[–—<>]/);
      }
    }
  });

  it("parses only known language codes", () => {
    expect(parseLang("pl")).toBe("pl");
    expect(parseLang("en")).toBe("en");
    for (const v of ["de", "PL", "", null, undefined, "pl,en"]) expect(parseLang(v)).toBeNull();
  });
});

describe("panel language", () => {
  const modes: [string, Record<string, string>][] = [["normal", {}], ["demo", { DEMO_MODE: "true" }]];

  for (const [mode, vars] of modes) {
    it(`${mode}: defaults to Polish regardless of Accept-Language, with a switcher`, async () => {
      const h = harness(vars);
      const html = await (await h.call("/", { headers: { "accept-language": "en-US,en;q=0.9" } })).text();
      expect(html).toContain('<html lang="pl">');
      expect(html).toContain('data-lang="pl"');
      expect(html).toContain('data-lang="en"');
      expect(html).toContain('role="group"');
      expect(html).toContain(dictionaries.pl.loadButton);
      expect(html).not.toContain(`>${dictionaries.en.loadButton}<`);
    });

    it(`${mode}: ?lang=en renders English and the client script handles ?lang= and storage`, async () => {
      const h = harness(vars);
      const html = await (await h.call("/?lang=en")).text();
      expect(html).toContain('<html lang="en">');
      expect(html).toContain(`>${dictionaries.en.loadButton}<`);
      expect(html).toContain("relay.lang");
      expect(html).toMatch(/try \{ localStorage\.setItem/);
      expect(await (await h.call("/?lang=xx")).text()).toContain('<html lang="pl">');
    });

    it(`${mode}: ships both dictionaries as inert JSON and never uses innerHTML`, async () => {
      const html = await (await harness(vars).call("/")).text();
      const m = /<script nonce="[^"]+" type="application\/json" id="i18n">(.*?)<\/script>/s.exec(html);
      const data = JSON.parse(m![1]!) as Record<string, Record<string, string>>;
      expect(data.pl!.sendButton ?? data.pl!.loadButton).toBeTruthy();
      expect(data.en!.loadButton).toBe(dictionaries.en.loadButton);
      expect(html).not.toMatch(/innerHTML|<script[^>]+src=/);
    });
  }

  it("demo: Polish texts and CTA, and no replay or token texts in either language", async () => {
    const html = await (await harness({ DEMO_MODE: "true" }).call("/")).text();
    expect(html).toContain("Wyślij przykładowe zdarzenie");
    expect(html).toContain("nie działa dwa razy, potem działa");
    expect(html).toContain("Potrzebujesz niezawodnych integracji między swoimi systemami? Napisz do Piotra Majkutewicza.");
    expect(html).toContain('href="https://piotrmajkutewicz.pl" rel="noopener"');
    expect(html).toContain("24 h");
    expect(html).toContain("500");
    for (const word of [dictionaries.pl.replayButton, dictionaries.en.replayButton, dictionaries.en.tokenLabel, dictionaries.pl.tokenLabel, "/replay"]) {
      expect(html).not.toContain(word);
    }
  });

  it("normal mode: Polish token field and replay text available", async () => {
    const html = await (await harness().call("/")).text();
    expect(html).toContain(dictionaries.pl.tokenLabel);
    expect(html).toContain('id="token"');
    expect(html).toContain("/replay");
  });
});

describe("API is independent of the UI language", () => {
  it("returns identical JSON for any Accept-Language and ?lang=", async () => {
    const h = harness({ DEMO_MODE: "true" });
    await h.call("/demo/sample", { method: "POST", body: '{"scenario":"ok"}' });
    const a = await (await h.call("/admin/events")).text();
    const b = await (await h.call("/admin/events?lang=en", { headers: { "accept-language": "en" } })).text();
    expect(b).toBe(a);
    const ev = JSON.parse(a).events[0];
    expect(Object.keys(ev)).toEqual(["id", "source", "eventKey", "receivedAt", "status", "deliveries"]);
    expect(["pending", "delivered", "failed", "dead"]).toContain(ev.status);
    const err = await (await h.call("/admin/events/nope/replay", { method: "POST" })).json();
    expect(err).toEqual({ error: "read-only in demo mode" });
  });
});
