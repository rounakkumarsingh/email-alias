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
  if (res.ok) return { ok: true };

  let errors = [];
  try {
    errors = (await res.json()).errors || [];
  } catch { /* body wasn't JSON */ }
  if (res.status === 401 || res.status === 403 || errors.some((e) => AUTH_CODES.has(e.code))) {
    return { ok: false, message: TOKEN_ERROR };
  }
  if (res.status === 404) return { ok: false, message: "Account ID or KV namespace ID not found. Check both in settings." };
  if (res.status === 429) return { ok: false, message: "Cloudflare is rate limiting requests. Try again in a minute." };
  const detail = errors[0]?.message ? `: ${String(errors[0].message).split(cfg.token).join("***")}` : "";
  return { ok: false, message: `Cloudflare returned an error (${res.status})${detail}` };
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
