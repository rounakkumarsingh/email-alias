// Dev-only: checks that a content script cannot read browser.storage.session in a Firefox-family browser.
// Runs the extension with web-ext in a throwaway profile, once with the default access level and once after
// setAccessLevel("TRUSTED_CONTEXTS"). The content script POSTs what it saw to a local server.
// Usage: bun run scripts/dev/probe-session-firefox.ts <work-dir> [/path/to/firefox-or-fork]
import { cpSync, mkdirSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";

const E = resolve(process.argv[2]);
const binary = process.argv[3] ?? "firefox";
const dist = resolve(import.meta.dir, "../../dist/firefox");
mkdirSync(E, { recursive: true });
let failures = 0;
const check = (name: string, ok: boolean, detail = "") => {
  console.log(`${ok ? "PASS" : "FAIL"} ${name}${detail ? " - " + detail : ""}`);
  if (!ok) failures++;
};

let expected = "";
let resolveResult: (v: any) => void;
let result: Promise<any>;
const server = Bun.serve({
  port: 8099,
  async fetch(req) {
    const url = new URL(req.url);
    if (process.env.PROBE_DEBUG) console.log("  request:", req.method, url.pathname);
    if (url.pathname === "/stage") return new Response("ok");
    if (url.pathname === "/result") {
      const got = JSON.parse(await req.text());
      if (got.variant === expected) resolveResult(got); // ignore late reports from a previous run
      return new Response("ok");
    }
    // web-ext opens the start URL before the add-on is installed, so reload until the content script runs.
    return new Response("<!doctype html><title>probe</title><script>const n = +(sessionStorage.n || 0); if (n < 12) { sessionStorage.n = n + 1; setTimeout(() => location.reload(), 2500); }</script>", { headers: { "content-type": "text/html" } });
  },
});

async function runVariant(name: "default" | "explicit") {
  const dir = join(E, "ext-" + name);
  cpSync(dist, dir, { recursive: true });
  writeFileSync(join(dir, "probe-bg.js"), `(async () => {
    ${name === "explicit" ? 'try { await browser.storage.session.setAccessLevel({ accessLevel: "TRUSTED_CONTEXTS" }); } catch (e) {}' : ""}
    await browser.storage.session.set({ syncKey: "CANARY" });
    await browser.storage.local.set({ registry: [] });
  })();`);
  writeFileSync(join(dir, "probe.js"), `(async () => {
    fetch("http://127.0.0.1:8099/stage?start");
    const out = { variant: ${JSON.stringify(name)}, sessionApi: typeof (browser.storage && browser.storage.session) };
    await new Promise((r) => setTimeout(r, 1500));
    fetch("http://127.0.0.1:8099/stage?reading");
    try { const r = await browser.storage.session.get("syncKey"); out.sessionRead = r && r.syncKey ? "CANARY-VISIBLE" : "empty"; } catch (e) { out.sessionError = String(e.message || e); }
    try { const l = await browser.storage.local.get("registry"); out.localControl = Array.isArray(l.registry); } catch (e) { out.localControl = false; }
    await fetch("http://127.0.0.1:8099/result", { method: "POST", body: JSON.stringify(out) });
  })();`);
  const mf = JSON.parse(await Bun.file(join(dir, "manifest.json")).text());
  mf.background = { scripts: ["probe-bg.js"] };
  mf.content_scripts = [{ matches: ["http://127.0.0.1/*"], js: ["probe.js"], run_at: "document_idle" }];
  writeFileSync(join(dir, "manifest.json"), JSON.stringify(mf));

  const prof = join(E, "prof-" + name);
  mkdirSync(prof, { recursive: true });
  expected = name;
  result = new Promise((r) => (resolveResult = r));
  const proc = Bun.spawn(["bunx", "web-ext", "run", "-s", dir, "--firefox", binary, "--firefox-profile", prof, "--profile-create-if-missing", "--start-url", "http://127.0.0.1:8099/", "--no-reload", "--no-input"], {
    env: { ...process.env, MOZ_HEADLESS: "1" }, stdout: "pipe", stderr: "pipe",
  });
  const timeout = new Promise((r) => setTimeout(() => r({ timeout: true }), 90000));
  const got: any = await Promise.race([result, timeout]);
  proc.kill();
  await proc.exited;
  // web-ext leaves the browser running when killed. Stop only this throwaway profile (never the user's own browser).
  Bun.spawnSync(["pkill", "-f", `-profile ${prof}`]);
  await new Promise((r) => setTimeout(r, 1500));
  return got;
}

for (const name of ["default", "explicit"] as const) {
  const got = await runVariant(name);
  console.log(`${name} access level ->`, JSON.stringify(got));
  if (got.timeout) { check(`${name}: probe reported back`, false, "timed out"); continue; }
  check(`${name}: result came from this variant's run`, got.variant === name, `got ${got.variant}`);
  check(`${name}: content script control can use storage.local`, got.localControl === true);
  check(`${name}: content script cannot read the canary from storage.session`, got.sessionRead !== "CANARY-VISIBLE", got.sessionApi === "undefined" ? "storage.session is not even exposed to content scripts" : "");
}
server.stop(true);
console.log(failures ? `\n${failures} check(s) FAILED` : "\nall checks passed");
process.exit(failures ? 1 : 0);
