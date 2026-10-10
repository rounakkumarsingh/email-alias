import { api } from "./browser.js";
import { getCfToken, getSettings, removeAlias } from "./storage.js";
import { blockAlias, hasPermission, isConfigured, PERMISSION_ERROR, unblockAlias } from "./cloudflare.js";

async function defaultConfig() {
  const s = await getSettings();
  return { accountId: s.cfAccountId, namespaceId: s.cfNamespaceId, token: await getCfToken() };
}

// Mirrors a Block/Unblock click to the Cloudflare KV blocklist before the registry changes.
// Returns {ok, message, synced}. ok=false means "don't change the registry". With no Cloudflare
// setup this succeeds with synced=false, so Sieve-only users keep working as before.
export async function setAliasBlocked(alias, blocked, deps = {}) {
  const getConfig = deps.getConfig ?? defaultConfig;
  const permitted = deps.hasPermission ?? (() => hasPermission(api));
  const cfg = await getConfig();
  if (!cfg.accountId && !cfg.namespaceId && !cfg.token) return { ok: true, message: "", synced: false };
  if (!isConfigured(cfg)) {
    return { ok: false, message: "Cloudflare blocklist is half set up. Fill in the account ID, namespace ID and token in settings.", synced: false };
  }
  if (!(await permitted())) return { ok: false, message: PERMISSION_ERROR, synced: false };
  const r = await (blocked ? blockAlias : unblockAlias)(cfg, alias, deps.fetch);
  return { ...r, synced: r.ok };
}

// Is the Cloudflare blocklist fully set up? (Used to decide whether "Block it too?" makes sense.)
export async function blocklistConfigured(deps = {}) {
  return isConfigured(await (deps.getConfig ?? defaultConfig)());
}

// Deletes an alias from the registry (leaving a tombstone for sync). Deleting never touches the
// blocked:<alias> key. With {block: true} the alias is blocked first, so a failed block deletes nothing.
export async function deleteAlias(alias, { block = false } = {}, deps = {}) {
  if (block) {
    const r = await setAliasBlocked(alias, true, deps);
    if (!r.ok) return r;
  }
  await (deps.remove ?? removeAlias)(alias);
  return { ok: true, message: block ? "Deleted and blocked." : "Deleted." };
}
