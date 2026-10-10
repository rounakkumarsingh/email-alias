import { decryptJson, deriveKeys, encryptJson, idFor, ITERATIONS, makeCheck, newHead, newSalt, verifyCheck } from "./synccrypto.js";
import { dirtyLabels, dirtyRegistry, mergeLabelState, mergeRegistryState, remoteLabels, remoteView } from "./syncmerge.js";

// Sync engine. No browser APIs: the KV `store` ({get, list, getMany, putMany}) and the clock are injected,
// and local state goes in and comes out as plain data, so everything here is testable.
//
// KV keys: sync:meta (salt + encrypted check), sync:head (random nonce rewritten on each push),
// reg:<id> and lbl:<id> (encrypted blobs). `blocked:<alias>` keys are never read or written here.

export const META_KEY = "sync:meta";
export const HEAD_KEY = "sync:head";

export class SyncError extends Error {
  constructor(code, message) {
    super(message);
    this.code = code;
  }
}

// Opens the vault. Wrong passphrase throws before anything is written. With no vault yet, `create`
// decides: false throws code "no-vault" (so the UI can ask for confirmation), true creates it.
export async function unlockVault(store, passphrase, { create = false, iterations = ITERATIONS } = {}) {
  if (!passphrase) throw new SyncError("empty", "Enter the sync passphrase.");
  const open = async (meta) => {
    const keys = await deriveKeys(passphrase, meta.salt, meta.iterations);
    try {
      if (!(await verifyCheck(keys, meta.check))) throw new Error();
    } catch {
      throw new SyncError("wrong-passphrase", "Wrong sync passphrase. Nothing was changed.");
    }
    return keys;
  };

  const text = await store.get(META_KEY);
  if (text) return { keys: await open(JSON.parse(text)), created: false };
  if (!create) {
    throw new SyncError("no-vault", "No sync data found. If you just set it up in another browser, wait a minute and try again; otherwise confirm the passphrase to create it.");
  }

  // Cloudflare KV is eventually consistent, so "no meta" can be a stale read of a vault that exists. Creating over it
  // would replace its salt and make everything already synced unreadable. If any synced data exists, refuse and wait.
  if ((await store.list("reg:")).length || (await store.list("lbl:")).length) {
    throw new SyncError("vault-unreadable", "Sync data already exists, but its settings can't be read yet (Cloudflare can take up to a minute to catch up). Nothing was changed. Wait a minute and click Unlock again.");
  }

  const salt = newSalt();
  const keys = await deriveKeys(passphrase, salt, iterations);
  const meta = { v: 1, salt, iterations, check: await makeCheck(keys) };
  await store.putMany([{ key: META_KEY, value: JSON.stringify(meta) }]);

  // Best-effort check for two browsers creating at the same moment. A read right after a write can be stale
  // (missing, or the previous value), so anything we can't read is treated as ours; a different salt means theirs won.
  let stored = null;
  try {
    const t = await store.get(META_KEY);
    stored = t ? JSON.parse(t) : null;
  } catch {
    // unreadable: keep ours
  }
  if (stored && stored.salt && stored.salt !== salt) return { keys: await open(stored), created: false };
  return { keys, created: true };
}

const blank = () => ({ registry: [], tombstones: {}, labels: {}, pushed: { reg: {}, lbl: {} }, lastHead: null });

// One sync pass. `local` = {registry, tombstones, labels, pushed: {reg, lbl}, lastHead}.
// Returns {skipped?, ok, error?, local, applied, pulled, wrote, unreadable, pending}.
// Without keys it returns "locked" and touches nothing: local changes stay queued in `local`.
export async function syncNow({ store, keys, local: input }) {
  const local = { ...blank(), ...input, pushed: { reg: {}, lbl: {}, ...input.pushed } };
  const pendingOf = (l) => dirtyRegistry(l.registry, l.tombstones, l.pushed.reg).length + dirtyLabels(l.labels, l.pushed.lbl).length;
  if (!keys) return { skipped: "locked", ok: true, local, applied: false, pulled: false, wrote: 0, unreadable: 0, pending: pendingOf(local) };

  const head = await store.get(HEAD_KEY);
  let next = local;
  let applied = false;
  let pulled = false;
  let unreadable = 0;

  if (head !== local.lastHead) {
    pulled = true;
    const names = [...(await store.list("reg:")), ...(await store.list("lbl:"))];
    const raw = await store.getMany(names);
    const regBlobs = [];
    const lblBlobs = [];
    for (const name of names) {
      if (raw[name] === undefined) continue;
      try {
        (name.startsWith("reg:") ? regBlobs : lblBlobs).push(await decryptJson(keys, raw[name], name));
      } catch {
        unreadable++;
      }
    }
    const rv = remoteView(regBlobs);
    const rl = remoteLabels(lblBlobs);
    unreadable += rv.skipped + rl.skipped;

    const reg = mergeRegistryState(local.registry, local.tombstones, rv.view);
    const lbl = mergeLabelState(local.labels, rl.labels);
    applied = reg.changed || lbl.changed;
    next = { ...local, registry: reg.registry, tombstones: reg.tombstones, labels: lbl.labels };

    // Whatever the remote already holds at the winning stamp needs no push (avoids echoing it back).
    const have = new Map([...reg.registry.map((e) => [e.alias, e.updated]), ...Object.entries(reg.tombstones)]);
    const pushed = { reg: { ...local.pushed.reg }, lbl: { ...local.pushed.lbl } };
    for (const [alias, r] of rv.view) if (have.get(alias) === r.stamp) pushed.reg[alias] = r.stamp;
    for (const [tag, v] of Object.entries(rl.labels)) if (lbl.labels[tag]?.updated === v.updated) pushed.lbl[tag] = v.updated;
    next.pushed = pushed;
  }

  // Never overwrite data we couldn't read: keep what we merged, write nothing, retry the pull next time.
  if (unreadable > 0) {
    return {
      ok: false, local: next, applied, pulled, wrote: 0, unreadable, pending: pendingOf(next),
      error: `${unreadable} synced item${unreadable === 1 ? "" : "s"} could not be read. Nothing was written. Check the passphrase.`,
    };
  }

  const dReg = dirtyRegistry(next.registry, next.tombstones, next.pushed.reg);
  const dLbl = dirtyLabels(next.labels, next.pushed.lbl);
  if (dReg.length + dLbl.length === 0) {
    return { ok: true, local: { ...next, lastHead: head }, applied, pulled, wrote: 0, unreadable: 0, pending: 0 };
  }

  const items = [];
  for (const r of dReg) {
    const key = `reg:${await idFor(keys, "reg", r.alias)}`;
    items.push({ key, value: await encryptJson(keys, r.plain, key) });
  }
  for (const l of dLbl) {
    const key = `lbl:${await idFor(keys, "lbl", l.tag)}`;
    items.push({ key, value: await encryptJson(keys, l.plain, key) });
  }
  items.push({ key: HEAD_KEY, value: newHead() });
  await store.putMany(items);

  const pushed = {
    reg: { ...next.pushed.reg, ...Object.fromEntries(dReg.map((r) => [r.alias, r.stamp])) },
    lbl: { ...next.pushed.lbl, ...Object.fromEntries(dLbl.map((l) => [l.tag, l.stamp])) },
  };
  // lastHead stays the head we read, so the next sync pulls once more and can't miss another browser's write.
  return { ok: true, local: { ...next, pushed, lastHead: head }, applied, pulled, wrote: items.length, unreadable: 0, pending: 0 };
}
