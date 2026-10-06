import { parseAlias } from "./alias.js";

export const REGISTRY_VERSION = 1;

// Entry: {alias, tag, site, created, updated, status: "active"|"blocked", note}
export function addEntry(registry, { alias, site = "", note = "" }, now = () => new Date().toISOString()) {
  const parsed = parseAlias(alias);
  if (!parsed) throw new Error("Not a valid alias: " + alias);
  const key = alias.trim().toLowerCase();
  if (registry.some((e) => e.alias === key)) return registry;
  const t = now();
  const entry = {
    alias: key,
    tag: parsed.tag,
    site: String(site || "").replace(/^www\./, ""),
    created: t,
    updated: t,
    status: "active",
    note: String(note || ""),
  };
  return [entry, ...registry];
}

function patch(registry, alias, fields, now) {
  const key = alias.trim().toLowerCase();
  return registry.map((e) => (e.alias === key ? { ...e, ...fields, updated: now() } : e));
}

export function setStatus(registry, alias, status, now = () => new Date().toISOString()) {
  if (status !== "active" && status !== "blocked") throw new Error("Bad status: " + status);
  return patch(registry, alias, { status }, now);
}

export function setNote(registry, alias, note, now = () => new Date().toISOString()) {
  return patch(registry, alias, { note: String(note || "") }, now);
}

export function removeEntry(registry, alias) {
  const key = alias.trim().toLowerCase();
  return registry.filter((e) => e.alias !== key);
}

export function search(registry, query) {
  const q = String(query || "").trim().toLowerCase();
  if (!q) return registry;
  return registry.filter((e) => [e.alias, e.tag, e.site, e.note, e.status].some((f) => f.toLowerCase().includes(q)));
}

export function blockedAliases(registry) {
  return registry.filter((e) => e.status === "blocked").map((e) => e.alias).sort();
}

export function tagsOf(registry) {
  return [...new Set(registry.map((e) => e.tag))].sort();
}

export function exportRegistry(registry, now = () => new Date().toISOString()) {
  return JSON.stringify({ app: "alias-maker", version: REGISTRY_VERSION, exported: now(), entries: registry }, null, 2);
}

function normaliseEntry(raw) {
  if (!raw || typeof raw !== "object") throw new Error("Entry is not an object");
  const parsed = parseAlias(raw.alias);
  if (!parsed) throw new Error("Invalid alias: " + JSON.stringify(raw.alias));
  if (raw.status !== "active" && raw.status !== "blocked") throw new Error("Invalid status for " + raw.alias);
  const created = Date.parse(raw.created);
  if (Number.isNaN(created)) throw new Error("Invalid created date for " + raw.alias);
  const updated = raw.updated !== undefined ? Date.parse(raw.updated) : created;
  if (Number.isNaN(updated)) throw new Error("Invalid updated date for " + raw.alias);
  return {
    alias: raw.alias.trim().toLowerCase(),
    tag: parsed.tag,
    site: typeof raw.site === "string" ? raw.site : "",
    created: new Date(created).toISOString(),
    updated: new Date(updated).toISOString(),
    status: raw.status,
    note: typeof raw.note === "string" ? raw.note : "",
  };
}

// Parses and validates an exported file. Throws with a readable message on bad input.
export function parseImport(text) {
  let data;
  try {
    data = JSON.parse(text);
  } catch {
    throw new Error("That file is not valid JSON.");
  }
  if (!data || data.app !== "alias-maker" || !Array.isArray(data.entries)) {
    throw new Error("That file is not an Alias Maker export.");
  }
  if (data.version !== REGISTRY_VERSION) throw new Error("Unsupported export version: " + data.version);
  return data.entries.map(normaliseEntry);
}

// Merge by alias; the entry with the later `updated` wins.
export function mergeRegistry(current, incoming) {
  const map = new Map(current.map((e) => [e.alias, e]));
  let added = 0;
  let changed = 0;
  for (const e of incoming) {
    const have = map.get(e.alias);
    if (!have) {
      map.set(e.alias, e);
      added++;
    } else if (Date.parse(e.updated) > Date.parse(have.updated)) {
      map.set(e.alias, e);
      changed++;
    }
  }
  const registry = [...map.values()].sort((a, b) => Date.parse(b.created) - Date.parse(a.created));
  return { registry, added, changed };
}
