// Dev-only: drives the Chromium build through Manual label mode, then switches to Bridge mode
// against the real native host and a fake Bridge (scripts/dev/fake_bridge.py on :14143).
// Usage: bun run scripts/dev/e2e-linker.ts <e2e-dir>   (needs host-wrapper.sh)
import { chromium } from "playwright";
import { mkdirSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";

const E = resolve(process.argv[2]);
const ext = resolve(import.meta.dir, "../../dist/chrome");
const profile = join(E, "profile");
const CHROME_ID = "dneclkpdhgnjjjloeghcfpgcpabcpoag";
let failures = 0;
const check = (name: string, ok: boolean, detail = "") => {
  console.log(`${ok ? "PASS" : "FAIL"} ${name}${detail ? " - " + detail : ""}`);
  if (!ok) failures++;
};

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
check("extension id matches pinned key", id === CHROME_ID);

const badge = () => sw.evaluate(() => chrome.action.getBadgeText({}));
const waitBadge = async (want: string) => {
  for (let i = 0; i < 40; i++) { if ((await badge()) === want) return want; await new Promise((r) => setTimeout(r, 250)); }
  return badge();
};

const opts = await ctx.newPage();
await opts.goto(`chrome-extension://${id}/options/options.html`);
check("default mode is manual", await opts.isChecked('input[name=labelMode][value=manual]'));
check("Bridge section hidden in manual mode", await opts.isHidden("#linker"));
await opts.waitForSelector("#label-rows tr");
const rowText = async () => (await opts.locator("#label-rows tr").allInnerTexts()).map((t) => t.replace(/\s+/g, " ").trim());
let rows = await rowText();
check("category tags listed from the start as needing creation",
  rows.length === 2 && rows.every((r) => /needs creating/i.test(r)) && /fin/.test(rows[0]) && /govt/.test(rows[1]), JSON.stringify(rows));
check("badge shows 2 pending", (await waitBadge("2")) === "2");

// Popup: copy an alias with a new tag -> notice -> Copy label name -> Done.
const popup = await ctx.newPage();
await popup.goto(`chrome-extension://${id}/popup/popup.html`);
await popup.fill("#tag", "newtag");
await popup.click("#copy");
await popup.waitForSelector("#label-notice:not([hidden])");
check("notice names the tag", /Create the label\s+newtag\s+in Proton before mail arrives/.test((await popup.textContent("#label-notice"))!.replace(/\s+/g, " ")));
check("badge shows 3 pending", (await waitBadge("3")) === "3");
await popup.click("#notice-done");
check("notice hides after Done", await popup.isHidden("#label-notice"));
check("badge back to 2", (await waitBadge("2")) === "2");

// Re-copying a tag already marked created shows no notice.
await popup.fill("#tag", "newtag");
await popup.click("#regen");
await popup.click("#copy");
await popup.waitForTimeout(500);
check("no notice for a created label", await popup.isHidden("#label-notice"));

// Options: toggle a status by hand.
await opts.reload();
await opts.waitForSelector("#label-rows tr");
await opts.click('button[aria-label="Mark created: fin"]');
check("manual toggle updates badge to 1", (await waitBadge("1")) === "1");
await opts.click('button[aria-label="Mark as needs creating: fin"]');
check("toggle back updates badge to 2", (await waitBadge("2")) === "2");

// Switch to Bridge: ensure_labels runs for everything still needing creation.
await opts.check('input[name=labelMode][value=bridge]');
await opts.click('button[type=submit]');
await opts.waitForFunction(() => /Created|exist/.test(document.getElementById("linker-status")!.textContent!), null, { timeout: 15000 });
check("switch to Bridge reports result", /Created 2 labels: fin, govt/.test((await opts.textContent("#linker-status"))!), (await opts.textContent("#linker-status"))!.trim());
rows = await rowText();
check("all labels marked created after switch", rows.every((r) => /Created/.test(r)), JSON.stringify(rows));
check("badge cleared in Bridge mode", (await waitBadge("")) === "");
check("Bridge section visible in bridge mode", await opts.isVisible("#linker"));

// Bridge mode: a new tag creates its label via the host.
await popup.reload();
await popup.fill("#tag", "bridgetag");
await popup.click("#copy");
await popup.waitForTimeout(1500);
await opts.reload();
await opts.waitForSelector("#label-rows tr");
rows = await rowText();
check("new tag in Bridge mode is created", rows.some((r) => /bridgetag.*Created/.test(r)), JSON.stringify(rows));
check("no notice in Bridge mode", await popup.isHidden("#label-notice"));

await ctx.close();
process.exit(failures ? 1 : 0);
