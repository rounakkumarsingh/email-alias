import { normaliseEntry } from "./registry.js";
import { DEFAULT_STAMP, CREATED, NEEDS } from "./labels.js";

// Pure merge logic for sync. Last write wins per record on its timestamp; on a tie a deletion wins.
// Local state is: registry (entries), tombstones {alias: deletedISO}, labels {tag: {status, updated}}.
// `pushed` records the stamp last written to the remote: {reg: {alias: stamp}, lbl: {tag: stamp}}.

const ms = (iso) => Date.parse(iso);

// One record per alias: {deleted, stamp, entry?}. The newer of entry and tombstone wins; a tie goes to the tombstone.
function localView(registry, tombstones) {
  const view = new Map();
  for (const e of registry) view.set(e.alias, { deleted: false, stamp: e.updated, entry: e });
  for (const [alias, stamp] of Object.entries(tombstones)) {
    const have = view.get(alias);
    if (!have || ms(stamp) >= ms(have.stamp)) view.set(alias, { deleted: true, stamp });
  }
  return view;
}

// Turns decrypted remote blobs into the same shape. Unusable blobs are skipped and counted.
export function remoteView(blobs) {
  const view = new Map();
  let skipped = 0;
  for (const b of blobs) {
    try {
      if (b && b.deleted === true) {
        const stamp = new Date(ms(b.updated)).toISOString();
        if (typeof b.alias !== "string" || Number.isNaN(ms(b.updated))) throw new Error("bad tombstone");
        view.set(b.alias.trim().toLowerCase(), { deleted: true, stamp });
      } else {
        const entry = normaliseEntry(b);
        view.set(entry.alias, { deleted: false, stamp: entry.updated, entry });
      }
    } catch {
      skipped++;
    }
  }
  return { view, skipped };
}

function winner(local, remote) {
  if (!local) return remote;
  if (!remote) return local;
  const a = ms(local.stamp);
  const b = ms(remote.stamp);
  if (a !== b) return a > b ? local : remote;
  return local.deleted ? local : remote.deleted ? remote : local;
}

// Returns the merged registry and tombstones, and whether anything local changed.
export function mergeRegistryState(registry, tombstones, remote) {
  const local = localView(registry, tombstones);
  const merged = new Map();
  for (const alias of new Set([...local.keys(), ...remote.keys()])) merged.set(alias, winner(local.get(alias), remote.get(alias)));

  const nextRegistry = [];
  const nextTombstones = {};
  for (const [alias, r] of merged) {
    if (r.deleted) nextTombstones[alias] = r.stamp;
    else nextRegistry.push(r.entry);
  }
  nextRegistry.sort((a, b) => ms(b.created) - ms(a.created));

  const changed = JSON.stringify([sortEntries(registry), sortKeys(tombstones)]) !== JSON.stringify([sortEntries(nextRegistry), sortKeys(nextTombstones)]);
  return { registry: nextRegistry, tombstones: nextTombstones, changed };
}

const sortEntries = (r) => [...r].sort((a, b) => (a.alias < b.alias ? -1 : 1));
const sortKeys = (o) => Object.fromEntries(Object.entries(o).sort(([a], [b]) => (a < b ? -1 : 1)));

// Registry records that differ from what was last pushed: [{alias, plain}] where plain is the blob content.
export function dirtyRegistry(registry, tombstones, pushed) {
  const out = [];
  for (const [alias, r] of localView(registry, tombstones)) {
    if (pushed[alias] === r.stamp) continue;
    out.push({ alias, stamp: r.stamp, plain: r.deleted ? { alias, deleted: true, updated: r.stamp } : r.entry });
  }
  return out;
}

// ---- labels ----

export function remoteLabels(blobs) {
  const out = {};
  let skipped = 0;
  for (const b of blobs) {
    const t = ms(b?.updated);
    if (!b || typeof b.tag !== "string" || !b.tag || (b.status !== NEEDS && b.status !== CREATED) || Number.isNaN(t)) {
      skipped++;
      continue;
    }
    out[b.tag] = { status: b.status, updated: new Date(t).toISOString() };
  }
  return { labels: out, skipped };
}

// Newer wins per tag. On a tie the local value is kept.
export function mergeLabelState(local, remote) {
  const next = { ...local };
  for (const [tag, v] of Object.entries(remote)) {
    if (!next[tag] || ms(v.updated) > ms(next[tag].updated)) next[tag] = v;
  }
  return { labels: next, changed: JSON.stringify(sortKeys(local)) !== JSON.stringify(sortKeys(next)) };
}

// Auto-added defaults (DEFAULT_STAMP) are never pushed.
export function dirtyLabels(labels, pushed) {
  return Object.entries(labels)
    .filter(([tag, v]) => v.updated !== DEFAULT_STAMP && pushed[tag] !== v.updated)
    .map(([tag, v]) => ({ tag, stamp: v.updated, plain: { tag, status: v.status, updated: v.updated } }));
}
