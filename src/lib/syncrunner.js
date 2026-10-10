import { api } from "./browser.js";
import { cfStore, hasPermission, isConfigured, PERMISSION_ERROR } from "./cloudflare.js";
import { syncNow, unlockVault } from "./sync.js";
import { keysFromRaw } from "./synccrypto.js";
import { dirtyLabels, dirtyRegistry } from "./syncmerge.js";
import { getCfToken, getLabels, getRegistry, getSettings, getSyncState, getTombstones, saveSyncState } from "./storage.js";

// Browser glue for sync: where the key lives, locking, the daily write budget, and persisting results.
// The passphrase is never stored. Only the derived keys (base64) are kept, in storage.session:
// memory only, cleared when the browser closes, and limited to extension pages (set explicitly below).

export const AUTO_WRITE_LIMIT = 800; // free plan allows 1,000 KV writes a day; automatic sync stops here
const LOCK_MS = 60_000;

const session = () => api.storage.session;
const today = () => new Date().toISOString().slice(0, 10);

let accessSet;
function restrictSession() {
  accessSet ??= (async () => {
    try {
      await session().setAccessLevel({ accessLevel: "TRUSTED_CONTEXTS" });
    } catch {
      // Older browsers lack the method; their default already hides session storage from content scripts.
    }
  })();
  return accessSet;
}

async function sessionKeys() {
  try {
    await restrictSession();
    const { syncKey } = await session().get("syncKey");
    return syncKey ? await keysFromRaw(syncKey) : null;
  } catch {
    return null;
  }
}

async function config() {
  const s = await getSettings();
  return { accountId: s.cfAccountId, namespaceId: s.cfNamespaceId, token: await getCfToken() };
}

async function loadLocal(state) {
  const [registry, tombstones, labels] = await Promise.all([getRegistry(), getTombstones(), getLabels()]);
  return {
    registry, tombstones, labels,
    pushed: { reg: state.pushed?.reg ?? {}, lbl: state.pushed?.lbl ?? {} },
    lastHead: state.lastHead ?? null,
  };
}

export async function pendingCount() {
  const local = await loadLocal(await getSyncState());
  return dirtyRegistry(local.registry, local.tombstones, local.pushed.reg).length + dirtyLabels(local.labels, local.pushed.lbl).length;
}

export async function syncStatus() {
  const state = await getSyncState();
  const cfg = await config();
  return {
    configured: isConfigured(cfg),
    enabled: Boolean(state.enabled),
    locked: !(await sessionKeys()),
    pending: await pendingCount(),
    lastSync: state.lastSync ?? null,
    lastError: state.lastError ?? null,
    writesToday: state.writes?.day === today() ? state.writes.n : 0,
  };
}

// Only one sync at a time across the background and open pages. A manual sync waits a few seconds for a
// running one to finish instead of failing; automatic syncs just skip (the next change or open retries).
async function withLock(fn, { wait = false } = {}) {
  await restrictSession();
  const deadline = Date.now() + (wait ? 15_000 : 0);
  for (;;) {
    const { syncLock } = await session().get("syncLock");
    if (!syncLock || Date.now() - syncLock >= LOCK_MS) break;
    if (Date.now() >= deadline) return { skipped: "busy" };
    await new Promise((r) => setTimeout(r, 400));
  }
  await session().set({ syncLock: Date.now() });
  try {
    return await fn();
  } finally {
    await session().remove("syncLock");
  }
}

// One sync pass. Safe to call from any page. `manual` ignores the automatic daily write limit.
export async function runSync({ manual = false } = {}) {
  let state = await getSyncState();
  if (!state.enabled) return { skipped: "disabled" };
  const cfg = await config();
  if (!isConfigured(cfg)) return { skipped: "not-configured" };
  if (!(await hasPermission(api))) return { skipped: "permission", error: PERMISSION_ERROR };

  const keys = await sessionKeys();
  if (!keys) return { skipped: "locked", pending: await pendingCount() };

  const used = state.writes?.day === today() ? state.writes.n : 0;
  if (!manual && used >= AUTO_WRITE_LIMIT) {
    return { skipped: "quota", error: `Automatic sync paused: ${used} of 1,000 daily Cloudflare writes used. Use Sync now, or wait until tomorrow (UTC).` };
  }

  return withLock(async () => {
    // Re-read after waiting for the lock: a sync that just finished may have changed the saved state.
    state = await getSyncState();
    const usedNow = state.writes?.day === today() ? state.writes.n : 0;
    const before = await loadLocal(state);
    let r;
    try {
      r = await syncNow({ store: cfStore(cfg), keys, local: before });
    } catch (err) {
      await saveSyncState({ ...state, lastError: err.message });
      return { ok: false, error: err.message };
    }

    // If something changed locally while we were talking to Cloudflare, drop this result and try again
    // rather than overwrite it. Nothing is lost: the pass is simply repeated.
    const after = await loadLocal(state);
    const same = (a, b) => JSON.stringify(a) === JSON.stringify(b);
    if (!same(after.registry, before.registry) || !same(after.tombstones, before.tombstones) || !same(after.labels, before.labels)) {
      return { ok: true, retry: true };
    }

    if (r.applied) {
      await api.storage.local.set({ registry: r.local.registry, tombstones: r.local.tombstones, labels: r.local.labels });
    }
    await saveSyncState({
      ...state,
      pushed: r.local.pushed,
      lastHead: r.local.lastHead,
      writes: { day: today(), n: usedNow + r.wrote },
      lastSync: r.ok ? new Date().toISOString() : state.lastSync,
      lastError: r.ok ? null : r.error,
    });
    return { ok: r.ok, error: r.error, applied: r.applied, wrote: r.wrote, unreadable: r.unreadable };
  }, { wait: manual });
}

// Derives and checks the key against the stored vault, keeps it in session storage, then syncs the queue.
// Throws SyncError: "no-vault" (ask the user to confirm, then call again with create), "wrong-passphrase".
export async function unlock(passphrase, { create = false } = {}) {
  const cfg = await config();
  if (!isConfigured(cfg)) throw new Error("Set up the Cloudflare blocklist above first.");
  if (!(await hasPermission(api))) throw new Error(PERMISSION_ERROR);
  const { keys } = await unlockVault(cfStore(cfg), passphrase, { create });
  await restrictSession();
  await session().set({ syncKey: keys.raw });
  await saveSyncState({ ...(await getSyncState()), enabled: true });
  return runSync({ manual: true });
}

// Forget the key. Local changes keep queuing and are pushed after the next unlock.
export async function lock() {
  await restrictSession();
  await session().remove("syncKey");
}

// Turn sync off on this browser (remote data is left alone).
export async function disableSync() {
  await lock();
  await saveSyncState({ ...(await getSyncState()), enabled: false });
}
