// Dev helper: loads dist/chrome in Chromium and screenshots popup + options.
import { chromium } from "playwright";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

const ext = resolve(import.meta.dir, "../dist/chrome");
const outDir = process.argv[2] ?? "shots";
const profile = mkdtempSync(join(tmpdir(), "alias-maker-"));

for (const scheme of ["light", "dark"] as const) {
  const ctx = await chromium.launchPersistentContext(join(profile, scheme), {
    executablePath: process.env.CHROMIUM ?? "/usr/bin/chromium",
    headless: false,
    colorScheme: scheme,
    args: [`--disable-extensions-except=${ext}`, `--load-extension=${ext}`, "--headless=new", "--no-sandbox"],
  });
  let [sw] = ctx.serviceWorkers();
  sw ??= await ctx.waitForEvent("serviceworker");
  const id = sw.url().split("/")[2];
  const errors: string[] = [];

  // Seed registry + a page to derive the tag from.
  const page = await ctx.newPage();
  page.on("pageerror", (e) => errors.push(String(e)));
  await sw.evaluate(async () => {
    const mk = (alias: string, site: string, status: string, note = "") => ({
      alias, tag: alias.split(".")[0], site, created: "2026-10-01T00:00:00.000Z", updated: "2026-10-01T00:00:00.000Z", status, note,
    });
    await chrome.storage.local.set({
      registry: [
        mk("github.x7k2qf@rounakkumarsingh.com", "github.com", "active"),
        mk("fin.k4v9qe@rounakkumarsingh.com", "onlinesbi.sbi.co.in", "active", "main bank"),
        mk("shop.m3n8zp@rounakkumarsingh.com", "shop.example.com", "blocked", "leaked"),
      ],
      lastCopiedHash: "old",
    });
  });
  await page.goto("https://example.com/");

  const popup = await ctx.newPage();
  popup.on("pageerror", (e) => errors.push(String(e)));
  popup.on("console", (m) => m.type() === "error" && errors.push(m.text()));
  await popup.setViewportSize({ width: 340, height: 560 });
  await popup.goto(`chrome-extension://${id}/popup/popup.html`);
  await popup.waitForSelector("#list li");
  await popup.fill("#tag", "github");
  await popup.screenshot({ path: `${outDir}/chromium-popup-${scheme}.png`, fullPage: true });

  const opts = await ctx.newPage();
  opts.on("pageerror", (e) => errors.push(String(e)));
  await opts.setViewportSize({ width: 900, height: 900 });
  await opts.goto(`chrome-extension://${id}/options/options.html`);
  await opts.waitForSelector("#rows tr");
  await opts.screenshot({ path: `${outDir}/chromium-options-${scheme}.png`, fullPage: true });

  console.log(scheme, "errors:", errors.length ? errors : "none");
  await ctx.close();
}
