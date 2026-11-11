import { describe, expect, test } from "bun:test";
import { fixedKey, syncFixed, PERMISSION_ERROR, TOKEN_ERROR } from "../src/lib/cloudflare.js";
import { pushFixed } from "../src/lib/blocklist.js";

const ACC = "a".repeat(32);
const NS = "b".repeat(32);
const TOKEN = "secret-token-123";
const cfg = { accountId: ACC, namespaceId: NS, token: TOKEN };
const base = `https://api.cloudflare.com/client/v4/accounts/${ACC}/storage/kv/namespaces/${NS}`;

// Fake KV: `remote` is the set of fixed: keys currently stored. Records every write.
function fakeKv(remote: string[]) {
  const calls: { url: string; method: string; body?: any }[] = [];
  const fn = async (url: string, init: any) => {
    const method = init.method;
    calls.push({ url, method, body: init.body ? JSON.parse(init.body) : undefined });
    const ok = (body: unknown) => ({ ok: true, status: 200, json: async () => body, text: async () => "" }) as any;
    if (url.startsWith(`${base}/keys`)) return ok({ result: remote.map((name) => ({ name })), result_info: {} });
    if (method === "PUT" && url === `${base}/bulk`) return ok({ result: { unsuccessful_keys: [] } });
    if (method === "DELETE") return ok({ result: null });
    throw new Error("unexpected " + method + " " + url);
  };
  const writes = () => calls.filter((c) => c.method !== "GET");
  return { fn, calls, writes };
}

describe("fixedKey", () => {
  test("prefixes, trims and lowercases", () => {
    expect(fixedKey("  GitHub@Example.com ")).toBe("fixed:github@example.com");
  });
});

describe("syncFixed", () => {
  test("puts the missing keys and deletes the extra ones", async () => {
    const f = fakeKv(["fixed:a@x.com", "fixed:old@x.com"]);
    const r = await syncFixed(cfg, ["A@x.com", "github@x.com"], f.fn);
    expect(r).toMatchObject({ ok: true, put: 1, deleted: 1 });
    const put = f.calls.find((c) => c.method === "PUT")!;
    expect(put.body).toEqual([{ key: "fixed:github@x.com", value: "1" }]);
    const del = f.calls.filter((c) => c.method === "DELETE");
    expect(del.map((c) => c.url)).toEqual([`${base}/values/${encodeURIComponent("fixed:old@x.com")}`]);
  });

  test("does nothing (no writes) when the sets are equal", async () => {
    const f = fakeKv(["fixed:a@x.com", "fixed:b@x.com"]);
    const r = await syncFixed(cfg, ["b@x.com", "a@x.com"], f.fn);
    expect(r).toMatchObject({ ok: true, put: 0, deleted: 0 });
    expect(f.writes()).toEqual([]);
  });

  test("only deletes when nothing is missing, only puts when nothing is extra", async () => {
    const onlyDel = fakeKv(["fixed:a@x.com", "fixed:b@x.com"]);
    await syncFixed(cfg, ["a@x.com"], onlyDel.fn);
    expect(onlyDel.writes().map((c) => c.method)).toEqual(["DELETE"]);
    const onlyPut = fakeKv(["fixed:a@x.com"]);
    await syncFixed(cfg, ["a@x.com", "b@x.com"], onlyPut.fn);
    expect(onlyPut.writes().map((c) => c.method)).toEqual(["PUT"]);
  });

  test("a 401 returns the token error without leaking the token", async () => {
    const fn = async () => ({ ok: false, status: 401, json: async () => ({ errors: [{ code: 10000, message: `bad ${TOKEN}` }] }) }) as any;
    const r = await syncFixed(cfg, ["a@x.com"], fn);
    expect(r.ok).toBe(false);
    expect(r.message).toBe(TOKEN_ERROR);
    expect(JSON.stringify(r)).not.toContain(TOKEN);
  });

  test("a network failure never leaks the token", async () => {
    const fn = async () => { throw new Error(`boom ${TOKEN}`); };
    const r = await syncFixed(cfg, ["a@x.com"], fn as any);
    expect(r.ok).toBe(false);
    expect(JSON.stringify(r)).not.toContain(TOKEN);
  });
});

describe("pushFixed", () => {
  test("no Cloudflare setup is a quiet success that does not sync", async () => {
    const r = await pushFixed(["a@x.com"], { getConfig: async () => ({ accountId: "", namespaceId: "", token: "" }) });
    expect(r).toEqual({ ok: true, message: "", synced: false });
  });

  test("half-configured is an error", async () => {
    const r = await pushFixed(["a@x.com"], { getConfig: async () => ({ accountId: ACC, namespaceId: "", token: "" }) });
    expect(r.ok).toBe(false);
  });

  test("missing permission returns PERMISSION_ERROR and makes no request", async () => {
    const f = fakeKv([]);
    const r = await pushFixed(["a@x.com"], { getConfig: async () => cfg, hasPermission: async () => false, fetch: f.fn });
    expect(r).toMatchObject({ ok: false, message: PERMISSION_ERROR, synced: false });
    expect(f.calls).toEqual([]);
  });

  test("configured and permitted syncs", async () => {
    const f = fakeKv([]);
    const r = await pushFixed(["a@x.com"], { getConfig: async () => cfg, hasPermission: async () => true, fetch: f.fn });
    expect(r).toMatchObject({ ok: true, synced: true, put: 1 });
  });
});
