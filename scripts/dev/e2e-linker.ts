// Dev-only: drives the Chromium build against the real native host and a fake Bridge.
// Usage: bun run scripts/dev/e2e-linker.ts <e2e-dir>   (needs host-wrapper.sh + fake bridge on :14143)
import { chromium } from "playwright";
import { mkdirSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";

const E = resolve(process.argv[2]);
const ext = resolve(import.meta.dir, "../../dist/chrome");
const profile = join(E, "profile");
const CHROME_ID = "dneclkpdhgnjjjloeghcfpgcpabcpoag";

mkdirSync(join(profile, "NativeMessagingHosts"), { recursive: true });
writeFileSync(join(profile, "NativeMessagingHosts/com.rounakkumarsingh.alias_maker.json"), JSON.stringify({
  name: "com.rounakkumarsingh.alias_maker", description: "e2e", path: join(E, "host-wrapper.sh"),
  type: "stdio", allowed_origins: [`chrome-extension://${CHROME_ID}/`],
}));

const ctx = await chromium.launchPersistentContext(profile, {
  executablePath: "/usr/bin/chromium", headless: false,
  args: [`--disable-extensions-except=${ext}`, `--load-extension=${ext}`, "--headless=new", "--no-sandbox"],
});
let [sw] = ctx.serviceWorkers();
sw ??= await ctx.waitForEvent("serviceworker");
const id = sw.url().split("/")[2];
console.log("extension id matches pinned key:", id === CHROME_ID, id);

const opts = await ctx.newPage();
await opts.goto(`chrome-extension://${id}/options/options.html`);
const status = async () => (await opts.textContent("#linker-status"))!.trim();
const waitStatus = async (re: RegExp) => { await opts.waitForFunction((s) => new RegExp(s).test(document.getElementById("linker-status")!.textContent!), re.source, { timeout: 15000 }); return status(); };

await opts.click("#check-linker");
console.log("ping:", await waitStatus(/Connected|Native|not|Bridge|host/i));

// Alias creation from the popup with the linker ON creates the label for a new tag.
await opts.check("#autoLabels");
const popup = await ctx.newPage();
await popup.goto(`chrome-extension://${id}/popup/popup.html`);
await popup.fill("#tag", "newtag");
await popup.click("#copy");
await popup.waitForSelector("#list li .addr");
await opts.reload();
console.log("after popup copy:", await waitStatus(/label|reach/i));
console.log("aliases in registry:", await sw.evaluate(async () => (await chrome.storage.local.get("registry")).registry.length));

await opts.click("#sync-labels");
console.log("sync:", await waitStatus(/label|reach/i));
await ctx.close();
