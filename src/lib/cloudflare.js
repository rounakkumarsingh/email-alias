// Writes and removes aliases in the Worker's KV blocklist through the Cloudflare REST API.
// Every function returns {ok, message}; messages never contain the API token.

const API = "https://api.cloudflare.com/client/v4";
export const ORIGIN = "https://api.cloudflare.com/*";
export const TOKEN_ERROR = "Cloudflare token invalid or expired";
export const PERMISSION_ERROR = "Allow access to api.cloudflare.com in Settings → Cloudflare blocklist first.";

// Cloudflare API error codes that mean the token is bad: authentication error, invalid access token, invalid request headers.
const AUTH_CODES = new Set([10000, 9109, 6003]);

export const blockKey = (alias) => `blocked:${String(alias).trim().toLowerCase()}`;

export function isConfigured(cfg) {
  return Boolean(cfg && cfg.accountId && cfg.namespaceId && cfg.token);
}

const nsUrl = (cfg) => `${API}/accounts/${cfg.accountId}/storage/kv/namespaces/${cfg.namespaceId}`;
const keyUrl = (cfg, alias) => `${nsUrl(cfg)}/values/${encodeURIComponent(blockKey(alias))}`;

async function call(cfg, url, init, fetchFn) {
  let res;
  try {
    res = await fetchFn(url, { ...init, headers: { ...init.headers, Authorization: `Bearer ${cfg.token}` } });
  } catch {
    return { ok: false, message: "Could not reach Cloudflare. Check your connection." };
  }
  if (res.ok) return { ok: true, res };

  let errors = [];
  try {
    errors = (await res.json()).errors || [];
  } catch { /* body wasn't JSON */ }
  if (res.status === 401 || res.status === 403 || errors.some((e) => AUTH_CODES.has(e.code))) {
    return { ok: false, message: TOKEN_ERROR };
  }
  if (res.status === 404) {
    return { ok: false, status: 404, code: errors[0]?.code, message: "Account ID or KV namespace ID not found. Check both in settings." };
  }
  if (res.status === 429) return { ok: false, message: "Cloudflare is rate limiting requests. Try again in a minute." };
  const detail = errors[0]?.message ? `: ${String(errors[0].message).split(cfg.token).join("***")}` : "";
  return { ok: false, message: `Cloudflare returned an error (${res.status})${detail}` };
}

// ---- generic KV store used by sync (values here are always client-side encrypted) ----

const KEY_NOT_FOUND = 10009;
const BULK_GET_MAX = 100;
const BULK_PUT_MAX = 10000;

// Throws Error(message) on any failure; messages never contain the token.
export function cfStore(cfg, fetchFn = globalThis.fetch) {
  const request = async (path, init = {}) => {
    const r = await call(cfg, `${nsUrl(cfg)}${path}`, { headers: {}, ...init }, fetchFn);
    if (!r.ok) {
      const err = new Error(r.message);
      err.status = r.status;
      err.code = r.code;
      throw err;
    }
    return r.res;
  };
  const jsonInit = (method, body) => ({ method, headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) });
  const chunks = (list, n) => Array.from({ length: Math.ceil(list.length / n) }, (_, i) => list.slice(i * n, (i + 1) * n));

  return {
    // The value as text, or null when the key doesn't exist.
    async get(key) {
      try {
        return await (await request(`/values/${encodeURIComponent(key)}`, { method: "GET" })).text();
      } catch (err) {
        if (err.status === 404 && err.code === KEY_NOT_FOUND) return null;
        throw err;
      }
    },

    // Every key name with the prefix, across pages.
    async list(prefix) {
      const names = [];
      let cursor = "";
      do {
        const q = `?prefix=${encodeURIComponent(prefix)}&limit=1000${cursor ? `&cursor=${encodeURIComponent(cursor)}` : ""}`;
        const body = await (await request(`/keys${q}`, { method: "GET" })).json();
        names.push(...(body.result || []).map((k) => k.name));
        cursor = body.result_info?.cursor || "";
      } while (cursor);
      return names;
    },

    // {key: text} for the keys that exist.
    async getMany(keys) {
      const out = {};
      for (const group of chunks(keys, BULK_GET_MAX)) {
        const body = await (await request("/bulk/get", jsonInit("POST", { keys: group, type: "text" }))).json();
        for (const [k, v] of Object.entries(body.result?.values || {})) if (typeof v === "string") out[k] = v;
      }
      return out;
    },

    // items: [{key, value}]. Throws if Cloudflare reports any key as not written.
    async putMany(items) {
      for (const group of chunks(items, BULK_PUT_MAX)) {
        const body = await (await request("/bulk", jsonInit("PUT", group.map(({ key, value }) => ({ key, value }))))).json();
        const failed = body.result?.unsuccessful_keys || [];
        if (failed.length) throw new Error(`Cloudflare did not write ${failed.length} of ${group.length} entries. Try Sync now again.`);
      }
    },

    // One DELETE per key (the long-documented endpoint). Deleting a missing key is not an error.
    async deleteMany(keys) {
      for (const key of keys) await request(`/values/${encodeURIComponent(key)}`, { method: "DELETE" });
    },
  };
}

export const fixedKey = (address) => `fixed:${String(address).trim().toLowerCase()}`;
const FIXED_PREFIX = "fixed:";

// Makes the fixed:<address> keys in KV match `fixed` (the extension's Fixed addresses setting).
// Writes only the difference, so an unchanged list costs reads only (the free plan allows 1,000 writes/day).
// Returns {ok, message, put, deleted}; messages never contain the token.
export async function syncFixed(cfg, fixed, fetchFn = globalThis.fetch) {
  try {
    const store = cfStore(cfg, fetchFn);
    const wanted = new Set(fixed.map(fixedKey));
    const remote = new Set(await store.list(FIXED_PREFIX));
    const missing = [...wanted].filter((k) => !remote.has(k));
    const extra = [...remote].filter((k) => !wanted.has(k));
    if (!missing.length && !extra.length) {
      return { ok: true, message: "Fixed addresses already up to date on Cloudflare.", put: 0, deleted: 0 };
    }
    if (missing.length) await store.putMany(missing.map((key) => ({ key, value: "1" })));
    if (extra.length) await store.deleteMany(extra);
    return { ok: true, message: "Fixed addresses updated on Cloudflare.", put: missing.length, deleted: extra.length };
  } catch (err) {
    return { ok: false, message: String(err?.message ?? err).split(cfg.token).join("***"), put: 0, deleted: 0 };
  }
}

export async function blockAlias(cfg, alias, fetchFn = globalThis.fetch) {
  const r = await call(cfg, keyUrl(cfg, alias), {
    method: "PUT",
    headers: { "Content-Type": "application/octet-stream" },
    body: "1",
  }, fetchFn);
  return r.ok ? { ok: true, message: "Blocked on Cloudflare." } : r;
}

export async function unblockAlias(cfg, alias, fetchFn = globalThis.fetch) {
  // Deleting a key that doesn't exist is fine: the alias is unblocked either way.
  const r = await call(cfg, keyUrl(cfg, alias), { method: "DELETE", headers: {} }, fetchFn);
  return r.ok ? { ok: true, message: "Unblocked on Cloudflare." } : r;
}

export async function testConnection(cfg, fetchFn = globalThis.fetch) {
  const r = await call(cfg, nsUrl(cfg), { method: "GET", headers: {} }, fetchFn);
  return r.ok ? { ok: true, message: "Connected to the KV namespace." } : r;
}

// Browser permission for api.cloudflare.com. Firefox MV3 does not grant host_permissions at install.
export async function hasPermission(api) {
  try {
    return await api.permissions.contains({ origins: [ORIGIN] });
  } catch {
    return false;
  }
}

// Must be called straight from a click handler (user gesture).
export async function requestPermission(api) {
  try {
    return await api.permissions.request({ origins: [ORIGIN] });
  } catch {
    return false;
  }
}
