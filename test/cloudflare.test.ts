import { describe, expect, test } from "bun:test";
import { blockAlias, blockKey, cfStore, hasPermission, isConfigured, PERMISSION_ERROR, requestPermission, testConnection, TOKEN_ERROR, unblockAlias } from "../src/lib/cloudflare.js";
import { setAliasBlocked } from "../src/lib/blocklist.js";
import { DEFAULTS, validateSettings } from "../src/lib/settings.js";
import { exportRegistry } from "../src/lib/registry.js";

const ACC = "a".repeat(32);
const NS = "b".repeat(32);
const TOKEN = "secret-token-123";
const cfg = { accountId: ACC, namespaceId: NS, token: TOKEN };
const ALIAS = "Shop.ABCDE@example.com";

function fakeFetch(status: number, body: unknown = { success: true, errors: [] }) {
  const calls: any[] = [];
  const fn = async (url: string, init: any) => {
    calls.push({ url, init });
    return { ok: status >= 200 && status < 300, status, json: async () => body } as any;
  };
  return { fn, calls };
}

describe("cloudflare KV client", () => {
  test("blockAlias PUTs the encoded lowercase key with the bearer token", async () => {
    const f = fakeFetch(200);
    const r = await blockAlias(cfg, ALIAS, f.fn);
    expect(r.ok).toBe(true);
    expect(f.calls[0].init.method).toBe("PUT");
    expect(f.calls[0].url).toBe(
      `https://api.cloudflare.com/client/v4/accounts/${ACC}/storage/kv/namespaces/${NS}/values/blocked%3Ashop.abcde%40example.com`,
    );
    expect(f.calls[0].init.headers.Authorization).toBe(`Bearer ${TOKEN}`);
  });

  test("key format matches the Worker's", () => {
    expect(blockKey(ALIAS)).toBe("blocked:shop.abcde@example.com");
  });

  test("unblockAlias sends DELETE", async () => {
    const f = fakeFetch(200);
    expect((await unblockAlias(cfg, ALIAS, f.fn)).ok).toBe(true);
    expect(f.calls[0].init.method).toBe("DELETE");
  });

  for (const [status, body] of [[401, {}], [403, {}], [400, { errors: [{ code: 9109, message: "Invalid access token" }] }], [400, { errors: [{ code: 10000 }] }]] as const) {
    test(`auth failure ${status} ${JSON.stringify(body)} shows the token message`, async () => {
      const r = await blockAlias(cfg, ALIAS, fakeFetch(status, body).fn);
      expect(r).toEqual({ ok: false, message: TOKEN_ERROR });
    });
  }

  test("404 points at the IDs", async () => {
    const r = await unblockAlias(cfg, ALIAS, fakeFetch(404, {}).fn);
    expect(r.ok).toBe(false);
    expect(r.message).toContain("namespace ID");
  });

  test("network failure is a readable error", async () => {
    const r = await blockAlias(cfg, ALIAS, (async () => { throw new TypeError("fetch failed"); }) as any);
    expect(r.ok).toBe(false);
    expect(r.message).toContain("Could not reach Cloudflare");
  });

  test("error messages never contain the token", async () => {
    const r = await blockAlias(cfg, ALIAS, fakeFetch(500, { errors: [{ code: 1, message: `bad ${TOKEN} here` }] }).fn);
    expect(r.ok).toBe(false);
    expect(r.message).not.toContain(TOKEN);
  });

  test("testConnection GETs the namespace", async () => {
    const f = fakeFetch(200);
    expect((await testConnection(cfg, f.fn)).ok).toBe(true);
    expect(f.calls[0].init.method).toBe("GET");
    expect(f.calls[0].url.endsWith(`/namespaces/${NS}`)).toBe(true);
  });

  test("isConfigured needs all three values", () => {
    expect(isConfigured(cfg)).toBe(true);
    expect(isConfigured({ ...cfg, token: "" })).toBe(false);
  });
});

describe("browser permission", () => {
  test("hasPermission reflects permissions.contains and survives errors", async () => {
    expect(await hasPermission({ permissions: { contains: async () => true } })).toBe(true);
    expect(await hasPermission({ permissions: { contains: async () => false } })).toBe(false);
    expect(await hasPermission({ permissions: { contains: async () => { throw new Error("x"); } } })).toBe(false);
  });
  test("requestPermission asks for the Cloudflare origin", async () => {
    let asked: any;
    const ok = await requestPermission({ permissions: { request: async (p: any) => ((asked = p), true) } });
    expect(ok).toBe(true);
    expect(asked).toEqual({ origins: ["https://api.cloudflare.com/*"] });
  });
});

describe("setAliasBlocked", () => {
  const ready = { getConfig: async () => cfg, hasPermission: async () => true };

  test("no Cloudflare setup: succeeds locally without calling the API", async () => {
    const f = fakeFetch(200);
    const r = await setAliasBlocked(ALIAS, true, { getConfig: async () => ({ accountId: "", namespaceId: "", token: "" }), fetch: f.fn });
    expect(r).toMatchObject({ ok: true, synced: false });
    expect(f.calls).toHaveLength(0);
  });

  test("half-configured is an error, not a silent skip", async () => {
    const r = await setAliasBlocked(ALIAS, true, { getConfig: async () => ({ ...cfg, token: "" }) });
    expect(r.ok).toBe(false);
  });

  test("missing browser permission blocks the change with a clear message", async () => {
    const f = fakeFetch(200);
    const r = await setAliasBlocked(ALIAS, true, { ...ready, hasPermission: async () => false, fetch: f.fn });
    expect(r).toMatchObject({ ok: false, message: PERMISSION_ERROR });
    expect(f.calls).toHaveLength(0);
  });

  test("block and unblock use PUT and DELETE", async () => {
    const f = fakeFetch(200);
    expect((await setAliasBlocked(ALIAS, true, { ...ready, fetch: f.fn })).synced).toBe(true);
    expect((await setAliasBlocked(ALIAS, false, { ...ready, fetch: f.fn })).synced).toBe(true);
    expect(f.calls.map((c) => c.init.method)).toEqual(["PUT", "DELETE"]);
  });

  test("API failure reports not ok so the registry stays unchanged", async () => {
    const r = await setAliasBlocked(ALIAS, true, { ...ready, fetch: fakeFetch(401, {}).fn });
    expect(r).toMatchObject({ ok: false, message: TOKEN_ERROR });
  });
});

describe("settings and secrecy", () => {
  test("defaults stay valid and Cloudflare IDs are optional", () => {
    expect(validateSettings(DEFAULTS).ok).toBe(true);
  });
  test("IDs must be 32 hex characters", () => {
    expect(validateSettings({ ...DEFAULTS, cfAccountId: "nope" }).errors.cfAccountId).toBeDefined();
    expect(validateSettings({ ...DEFAULTS, cfNamespaceId: "z".repeat(32) }).errors.cfNamespaceId).toBeDefined();
    expect(validateSettings({ ...DEFAULTS, cfAccountId: ACC.toUpperCase(), cfNamespaceId: NS }).ok).toBe(true);
  });
  test("settings never carry a token field", () => {
    expect(Object.keys(validateSettings({ ...DEFAULTS, cfToken: TOKEN }).value)).not.toContain("cfToken");
    expect(exportRegistry([], undefined, {})).not.toContain("cfToken");
  });
});

describe("cfStore (sync KV access)", () => {
  const base = `https://api.cloudflare.com/client/v4/accounts/${ACC}/storage/kv/namespaces/${NS}`;
  const json = (body: unknown, status = 200) => ({ ok: status < 300, status, json: async () => body, text: async () => JSON.stringify(body) }) as any;

  function router(handlers: Record<string, (init: any, url: string) => any>) {
    const calls: { url: string; init: any }[] = [];
    const fn = async (url: string, init: any) => {
      calls.push({ url, init });
      for (const [prefix, h] of Object.entries(handlers)) if (url.startsWith(base + prefix)) return h(init, url);
      throw new Error("unexpected " + url);
    };
    return { fn, calls };
  }

  test("get returns text, null for a missing key, and throws for other errors", async () => {
    const f = router({ "/values/": (_i, url) => url.includes("missing")
      ? json({ errors: [{ code: 10009, message: "key not found" }] }, 404)
      : ({ ok: true, status: 200, text: async () => "blob" }) });
    const s = cfStore(cfg, f.fn);
    expect(await s.get("reg:abc")).toBe("blob");
    expect(await s.get("missing")).toBeNull();
    const bad = cfStore(cfg, fakeFetch(401, {}).fn);
    await expect(bad.get("x")).rejects.toThrow(TOKEN_ERROR);
  });

  test("a 404 that is not 'key not found' is an error, not a missing key", async () => {
    const s = cfStore(cfg, fakeFetch(404, { errors: [{ code: 10013, message: "namespace not found" }] }).fn);
    await expect(s.get("x")).rejects.toThrow(/namespace ID/);
  });

  test("list follows the cursor and returns all names", async () => {
    let n = 0;
    const f = router({ "/keys": (_i, url) => {
      n++;
      return n === 1
        ? json({ result: [{ name: "reg:a" }], result_info: { cursor: "CUR" } })
        : json({ result: [{ name: "reg:b" }], result_info: { cursor: "" } });
    } });
    expect(await cfStore(cfg, f.fn).list("reg:")).toEqual(["reg:a", "reg:b"]);
    expect(f.calls[0].url).toContain("prefix=reg%3A");
    expect(f.calls[1].url).toContain("cursor=CUR");
  });

  test("getMany chunks at 100 keys and skips missing ones", async () => {
    const f = router({ "/bulk/get": (init) => {
      const keys: string[] = JSON.parse(init.body).keys;
      return json({ result: { values: Object.fromEntries(keys.filter((k) => k !== "k5").map((k) => [k, "v-" + k])) } });
    } });
    const keys = Array.from({ length: 250 }, (_, i) => "k" + i);
    const out = await cfStore(cfg, f.fn).getMany(keys);
    expect(f.calls).toHaveLength(3);
    expect(Object.keys(out)).toHaveLength(249);
    expect(out.k5).toBeUndefined();
    expect(JSON.parse(f.calls[0].init.body).type).toBe("text");
  });

  test("putMany sends one bulk PUT and fails loudly on unsuccessful keys", async () => {
    const ok = router({ "/bulk": () => json({ result: { successful_key_count: 2, unsuccessful_keys: [] } }) });
    await cfStore(cfg, ok.fn).putMany([{ key: "reg:a", value: "1" }, { key: "reg:b", value: "2" }]);
    expect(ok.calls).toHaveLength(1);
    expect(ok.calls[0].init.method).toBe("PUT");
    expect(JSON.parse(ok.calls[0].init.body)).toEqual([{ key: "reg:a", value: "1" }, { key: "reg:b", value: "2" }]);
    const bad = router({ "/bulk": () => json({ result: { successful_key_count: 1, unsuccessful_keys: ["reg:b"] } }) });
    await expect(cfStore(cfg, bad.fn).putMany([{ key: "reg:a", value: "1" }, { key: "reg:b", value: "2" }])).rejects.toThrow(/did not write 1 of 2/);
  });

  test("errors never include the token", async () => {
    const s = cfStore(cfg, fakeFetch(500, { errors: [{ code: 1, message: `oops ${TOKEN}` }] }).fn);
    await expect(s.list("reg:")).rejects.toThrow();
    try { await s.list("reg:"); } catch (e: any) { expect(e.message).not.toContain(TOKEN); }
  });
});
