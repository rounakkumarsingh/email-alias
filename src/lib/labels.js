import { sanitizeTag } from "./alias.js";

// Per-tag Proton label status: {[tag]: {status: "needs-creating" | "created", updated: ISO}}.
export const NEEDS = "needs-creating";
export const CREATED = "created";
export const LABEL_MODES = ["manual", "bridge"];

const iso = () => new Date().toISOString();

// A tag starts as "needs-creating" the first time it is seen. Returns the same object if unchanged.
export function ensureTag(labels, tag, now = iso) {
  if (!tag || labels[tag]) return labels;
  return { ...labels, [tag]: { status: NEEDS, updated: now() } };
}

// Adds every tag from the registry and the configured category tags.
export function reconcile(labels, registry, categories = [], now = iso) {
  let out = labels;
  for (const tag of [...categories, ...registry.map((e) => e.tag)]) out = ensureTag(out, tag, now);
  return out;
}

export function setLabelStatus(labels, tag, status, now = iso) {
  if (status !== NEEDS && status !== CREATED) throw new Error("Bad label status: " + status);
  if (labels[tag]?.status === status) return labels;
  return { ...labels, [tag]: { status, updated: now() } };
}

export function markCreated(labels, tags, now = iso) {
  return tags.reduce((acc, t) => setLabelStatus(acc, t, CREATED, now), labels);
}

export const pendingTags = (labels) =>
  Object.keys(labels).filter((t) => labels[t].status === NEEDS).sort();

export const tagList = (labels) =>
  Object.keys(labels).sort().map((tag) => ({ tag, status: labels[tag].status }));

// Toolbar badge text: empty when nothing is pending.
export const badgeText = (count) => (count > 0 ? (count > 99 ? "99+" : String(count)) : "");

// Per tag, the newer `updated` wins.
export function mergeLabels(current, incoming) {
  const out = { ...current };
  for (const [tag, v] of Object.entries(incoming)) {
    if (!out[tag] || Date.parse(v.updated) > Date.parse(out[tag].updated)) out[tag] = v;
  }
  return out;
}

// Validates a labels object from an import file. Throws with a readable message.
export function parseLabels(raw) {
  if (raw === undefined) return {};
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) throw new Error("Labels must be an object.");
  const out = {};
  for (const [tag, v] of Object.entries(raw)) {
    if (!tag || sanitizeTag(tag) !== tag) throw new Error("Invalid label tag: " + JSON.stringify(tag));
    if (!v || (v.status !== NEEDS && v.status !== CREATED)) throw new Error("Invalid label status for " + tag);
    const t = Date.parse(v.updated);
    if (Number.isNaN(t)) throw new Error("Invalid label date for " + tag);
    out[tag] = { status: v.status, updated: new Date(t).toISOString() };
  }
  return out;
}
