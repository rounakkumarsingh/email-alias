// Dev-only: drives the Chromium build through encrypted sync against a local mock of the Cloudflare KV API.
// The mock is an HTTPS server on :8443 reached via --host-resolver-rules, so the background service
// worker is intercepted too. It records every request so we can assert no plaintext ever leaves the browser.
// Also runs the storage.session probe: a content script must not be able to read the sync key.
// Usage: bun run scripts/dev/e2e-sync.ts <work-dir>
import { chromium, type BrowserContext, type Page } from "playwright";
import { cpSync, mkdirSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { execFileSync } from "node:child_process";

const E = resolve(process.argv[2]);
mkdirSync(E, { recursive: true });
const dist = resolve(import.meta.dir, "../../dist/chrome");
const probeExt = join(E, "ext-probe");
let failures = 0;
const check = (name: string, ok: boolean, detail = "") => {
  console.log(`${ok ? "PASS" : "FAIL"} ${name}${detail ? " - " + detail : ""}`);
  if (!ok) failures++;
};

// ---- mock Cloudflare KV ----
execFileSync("openssl", ["req", "-x509", "-newkey", "rsa:2048", "-nodes", "-keyout", join(E, "k.pem"), "-out", join(E, "c.pem"),
  "-subj", "/CN=api.cloudflare.com", "-addext", "subjectAltName=DNS:api.cloudflare.com", "-days", "1"], { stdio: "ignore" });
const ACC = "a".repeat(32), NS = "b".repeat(32), TOKEN = "faketoken-e2e";
const kv = new Map<string, string>();
const log: { method: string; path: string; body: string }[] = [];
const env = (result: unknown) => Response.json({ success: true, errors: [], messages: [], result });
const server = Bun.serve({
  port: 8443,
  tls: { cert: Bun.file(join(E, "c.pem")), key: Bun.file(join(E, "k.pem")) },
  async fetch(req) {
    const url = new URL(req.url);
    const body = req.method === "GET" || req.method === "DELETE" ? "" : await req.text();
    const path = decodeURIComponent(url.pathname + url.search);
    log.push({ method: req.method, path, body });
    if (req.headers.get("authorization") !== `Bearer ${TOKEN}`) return Response.json({ success: false, errors: [{ code: 10000, message: "Authentication error" }] }, { status: 403 });
    const base = `/client/v4/accounts/${ACC}/storage/kv/namespaces/${NS}`;
    if (!url.pathname.startsWith(base)) return Response.json({ success: false, errors: [{ code: 7003, message: "no route" }] }, { status: 404 });
    const rest = decodeURIComponent(url.pathname.slice(base.length));
    if (rest === "") return env({ id: NS, title: "BLOCKLIST" });
    if (rest.startsWith("/values/")) {
      const key = rest.slice(8);
      if (req.method === "PUT") { kv.set(key, body); return env(null); }
      if (req.method === "DELETE") { kv.delete(key); return env(null); }
      return kv.has(key) ? new Response(kv.get(key)) : Response.json({ success: false, errors: [{ code: 10009, message: "get: 'key not found'" }] }, { status: 404 });
    }
    if (rest === "/keys") {
      const prefix = url.searchParams.get("prefix") ?? "";
      return Response.json({ success: true, errors: [], messages: [], result: [...kv.keys()].filter((k) => k.startsWith(prefix)).map((name) => ({ name })), result_info: { cursor: "" } });
    }
    if (rest === "/bulk/get") {
      const { keys } = JSON.parse(body);
      return env({ values: Object.fromEntries(keys.filter((k: string) => kv.has(k)).map((k: string) => [k, kv.get(k)])) });
    }
    if (rest === "/bulk" && req.method === "PUT") {
      for (const { key, value } of JSON.parse(body)) kv.set(key, value);
      return env({ successful_key_count: JSON.parse(body).length, unsuccessful_keys: [] });
    }
    return Response.json({ success: false, errors: [{ code: 7003, message: "no route " + rest }] }, { status: 404 });
  },
});
const writes = () => log.filter((r) => r.method !== "GET" && !r.path.includes("/bulk/get")).length;
const blockedWrites = () => log.filter((r) => r.path.includes("/values/blocked:") && r.method !== "GET");

// ---- browsers ----
async function launch(profile: string, ext = dist): Promise<{ ctx: BrowserContext; id: string }> {
  const ctx = await chromium.launchPersistentContext(join(E, profile), {
    executablePath: "/usr/bin/chromium", headless: false,
    args: [`--disable-extensions-except=${ext}`, `--load-extension=${ext}`, "--headless=new", "--no-sandbox",
      "--host-resolver-rules=MAP api.cloudflare.com 127.0.0.1:8443", "--ignore-certificate-errors"],
  });
  let [sw] = ctx.serviceWorkers();
  sw ??= await ctx.waitForEvent("serviceworker");
  return { ctx, id: sw.url().split("/")[2] };
}
const options = async (ctx: BrowserContext, id: string) => {
  const p = await ctx.newPage();
  await p.goto(`chrome-extension://${id}/options/options.html`);
  return p;
};
const statusHas = (p: Page, text: string, sel = "#sync-status") =>
  p.waitForFunction(([s, t]) => document.querySelector(s as string)?.textContent?.includes(t as string), [sel, text] as const, { timeout: 15000 });
const store = (p: Page, area: "local" | "sync", key: string) => p.evaluate(([a, k]) => (chrome.storage as any)[a].get(k).then((r: any) => r[k]), [area, key] as const);
const configure = async (p: Page) => {
  await p.evaluate(async ([a, n, t]) => {
    await chrome.storage.sync.set({ cfAccountId: a, cfNamespaceId: n });
    await chrome.storage.local.set({ cfToken: t });
  }, [ACC, NS, TOKEN] as const);
  await p.reload();
};
const submitSync = async (p: Page, pass: string, pass2?: string) => {
  await p.fill("#syncPass", pass);
  if (pass2 !== undefined) await p.fill("#syncPass2", pass2);
  await p.click("#sync-unlock");
};

const E1 = "shop.abcde@example.com", E2 = "fin.kkkkk@example.com", E3 = "gov.mmmmm@example.com";
const entry = (alias: string, updated: string, over: any = {}) => ({ alias, tag: alias.split(".")[0], site: "secretsite.com", created: updated, updated, status: "active", note: "very private note", ...over });

// ===== Browser A: create the vault =====
let A = await launch("profA");
let a = await options(A.ctx, A.id);
await configure(a);
await a.evaluate(([x, y]) => chrome.storage.local.set({ registry: [x, y], labels: { fin: { status: "created", updated: "2026-03-01T00:00:00.000Z" } } }), [entry(E1, "2026-02-01T00:00:00.000Z"), entry(E2, "2026-02-02T00:00:00.000Z")] as any);
await a.reload();
await submitSync(a, "pw-one");
await statusHas(a, "No sync data");
check("first unlock asks to confirm the passphrase", await a.isVisible("#syncPass2-field"));
const writesBefore = writes();
await submitSync(a, "pw-one", "different");
await statusHas(a, "don't match");
check("mismatched confirmation writes nothing", writes() === writesBefore);
await submitSync(a, "pw-one", "pw-one");
await statusHas(a, "Unlocked and synced");
const keys = [...kv.keys()];
check("vault keys exist", keys.includes("sync:meta") && keys.includes("sync:head"));
check("2 encrypted reg: keys and 1 lbl: key", keys.filter((k) => k.startsWith("reg:")).length === 2 && keys.filter((k) => k.startsWith("lbl:")).length === 1, keys.join(","));
const blob = JSON.parse(kv.get(keys.find((k) => k.startsWith("reg:"))!)!);
check("reg: value is just {v,iv,ct}", Object.keys(blob).sort().join() === "ct,iv,v");

// ===== Browser B: wrong passphrase, then join =====
const B1 = await launch("profB");
let b = await options(B1.ctx, B1.id);
await configure(b);
const w0 = writes();
await submitSync(b, "nope");
await statusHas(b, "Wrong sync passphrase");
check("wrong passphrase: nothing written", writes() === w0, log.slice(-4).map((r) => r.method + " " + r.path.slice(-60)).join(" | "));
check("wrong passphrase: no create-vault prompt", await b.isHidden("#syncPass2-field"));
await submitSync(b, "pw-one");
await statusHas(b, "Unlocked and synced");
const bReg = (await store(b, "local", "registry")) as any[];
check("B received both aliases", bReg.map((e) => e.alias).sort().join() === [E1, E2].sort().join());
check("B received the label status", ((await store(b, "local", "labels")) as any).fin?.status === "created");
await B1.ctx.close();

// ===== Browser B restarts: locked, but everything still works and queues =====
const B2 = await launch("profB");
const bp = await B2.ctx.newPage();
await bp.goto(`chrome-extension://${B2.id}/popup/popup.html`);
await bp.waitForSelector("#sync-row:not([hidden])");
check("after restart the popup shows sync locked", /Sync locked/.test((await bp.textContent("#sync-text")) || ""));
b = await options(B2.ctx, B2.id);
await b.evaluate((e) => chrome.storage.local.get("registry").then(({ registry }) => chrome.storage.local.set({ registry: [e, ...registry] })), entry(E3, "2026-05-01T00:00:00.000Z") as any);
const w1 = writes();
await b.reload();
// Delete only (E2): must not touch blocked: keys.
b.on("dialog", (d) => d.accept());
const rowFor = (alias: string) => b.locator("#rows tr", { hasText: alias });
await rowFor(E2).getByRole("button", { name: /^Delete/ }).click();
await b.waitForSelector("#del-dialog[open]");
await b.click('#del-dialog button[value="delete"]');
await statusHas(b, "Deleted.", "#registry-status");
check("delete only makes no blocked: write", blockedWrites().length === 0);
// Delete and block (E1).
await rowFor(E1).getByRole("button", { name: /^Delete/ }).click();
await b.waitForSelector("#del-dialog[open]");
await b.click('#del-dialog button[value="block"]');
await statusHas(b, "Deleted and blocked", "#registry-status");
check("delete + block wrote the blocked: key", blockedWrites().length === 1 && kv.get("blocked:" + E1) === "1");
await b.waitForTimeout(4500); // background debounce fires: locked, so it must not sync
check("locked: nothing synced to Cloudflare", ![...kv.keys()].some((k) => k.startsWith("reg:") && false) && writes() === w1 + 1);
const tomb = (await store(b, "local", "tombstones")) as Record<string, string>;
check("both deletes recorded as tombstones locally", !!tomb[E1] && !!tomb[E2]);
await b.reload();
await statusHas(b, "waiting to sync", "#sync-detail");
check("options shows queued changes while locked", /3 changes? waiting/.test((await b.textContent("#sync-detail")) || ""), await b.textContent("#sync-detail") || "");
await submitSync(b, "pw-one");
await statusHas(b, "Unlocked and synced");
check("unlock pushed the queue", writes() > w1 + 1);

// ===== Browser A syncs and converges =====
await a.reload();
await a.click("#sync-now");
await statusHas(a, "Synced");
const aReg = ((await store(a, "local", "registry")) as any[]).map((e) => e.alias);
check("A sees the new alias and both deletions", aReg.join() === E3, aReg.join());

// ===== No plaintext anywhere that Cloudflare saw =====
const seen = log.map((r) => r.path.replace(/blocked:[^/]*$/, "blocked:<alias>") + "\n" + (r.path.includes("/values/blocked:") ? "" : r.body)).join("\n") + [...kv.entries()].filter(([k]) => !k.startsWith("blocked:")).map(([k, v]) => k + v).join("\n");
const leaks = ["abcde", "kkkkk", "mmmmm", "shop", "example.com", "secretsite", "very private", "gov", "fin"].filter((s) => seen.includes(s));
check("no plaintext alias, tag, site or note reached Cloudflare", leaks.length === 0, leaks.join(","));
check("every non-blocked key is reg:/lbl:/sync:", [...kv.keys()].filter((k) => !k.startsWith("blocked:")).every((k) => /^(reg:[0-9a-f]{32}|lbl:[0-9a-f]{32}|sync:meta|sync:head)$/.test(k)));
await B2.ctx.close();
await A.ctx.close();

// ===== storage.session probe: a content script must not read the sync key =====
cpSync(dist, probeExt, { recursive: true });
writeFileSync(join(probeExt, "probe.js"), `(async () => {
  const out = { sessionApi: typeof (chrome.storage && chrome.storage.session) };
  try { const r = await chrome.storage.session.get("syncKey"); out.sessionRead = Object.keys(r || {}); } catch (e) { out.sessionError = String(e.message || e); }
  const l = await chrome.storage.local.get("registry"); out.localControl = Array.isArray(l.registry);
  document.documentElement.dataset.probe = JSON.stringify(out);
})();`);
const mf = JSON.parse(await Bun.file(join(probeExt, "manifest.json")).text());
mf.content_scripts = [{ matches: ["http://127.0.0.1:8099/*"], js: ["probe.js"], run_at: "document_idle" }];
writeFileSync(join(probeExt, "manifest.json"), JSON.stringify(mf));
const page = Bun.serve({ port: 8099, fetch: () => new Response("<!doctype html><title>probe</title>", { headers: { "content-type": "text/html" } }) });
const P = await launch("profP", probeExt);
const pp = await options(P.ctx, P.id);
await configure(pp);
await pp.evaluate(() => chrome.storage.local.set({ registry: [] }));
await pp.reload();
await submitSync(pp, "pw-one");
await statusHas(pp, "Unlocked and synced");
const canary = await pp.evaluate(() => chrome.storage.session.get("syncKey").then((r) => !!r.syncKey));
check("probe setup: the sync key is in storage.session for extension pages", canary);
const web = await P.ctx.newPage();
await web.goto("http://127.0.0.1:8099/");
await web.waitForFunction(() => document.documentElement.dataset.probe, null, { timeout: 15000 });
const probe = JSON.parse(await web.evaluate(() => document.documentElement.dataset.probe!));
console.log("probe result:", JSON.stringify(probe));
check("content script control: it can use storage.local", probe.localControl === true);
check("content script cannot read the sync key from storage.session", !(probe.sessionRead || []).includes("syncKey"));
await P.ctx.close();

page.stop(true);
server.stop(true);
console.log(failures ? `\n${failures} check(s) FAILED` : "\nall checks passed");
process.exit(failures ? 1 : 0);
