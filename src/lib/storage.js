import { api } from "./browser.js";
import { DEFAULTS, validateSettings } from "./settings.js";
import { reconcile } from "./labels.js";

export async function getSettings() {
  const stored = await api.storage.sync.get(DEFAULTS);
  const checked = validateSettings(stored);
  // Fall back per field if something stored is invalid.
  const out = { ...DEFAULTS, ...stored };
  for (const k of Object.keys(checked.errors)) out[k] = DEFAULTS[k];
  return out;
}

export async function saveSettings(settings) {
  await api.storage.sync.set(settings);
}

export async function getRegistry() {
  const { registry = [] } = await api.storage.local.get("registry");
  return registry;
}

export async function saveRegistry(registry) {
  await api.storage.local.set({ registry });
}

export async function getLastCopiedHash() {
  const { lastCopiedHash = "" } = await api.storage.local.get("lastCopiedHash");
  return lastCopiedHash;
}

export async function setLastCopiedHash(hash) {
  await api.storage.local.set({ lastCopiedHash: hash });
}

export async function getLinkerStatus() {
  const { linkerStatus = null } = await api.storage.local.get("linkerStatus");
  return linkerStatus;
}

export async function setLinkerStatus({ ok, message }) {
  await api.storage.local.set({ linkerStatus: { ok, message, at: new Date().toISOString() } });
}

export async function getLabels() {
  const { labels = {} } = await api.storage.local.get("labels");
  return labels;
}

export async function saveLabels(labels) {
  await api.storage.local.set({ labels });
}

// Label statuses with every registry and category tag present (new tags start as needs-creating).
export async function syncedLabels() {
  const [labels, registry, settings] = await Promise.all([getLabels(), getRegistry(), getSettings()]);
  const next = reconcile(labels, registry, settings.categories);
  if (next !== labels) await saveLabels(next);
  return next;
}

// The Cloudflare API token lives only in local storage: never synced, never part of an export, never logged.
export async function getCfToken() {
  const { cfToken = "" } = await api.storage.local.get("cfToken");
  return cfToken;
}

export async function setCfToken(token) {
  if (token) await api.storage.local.set({ cfToken: token });
  else await api.storage.local.remove("cfToken");
}
