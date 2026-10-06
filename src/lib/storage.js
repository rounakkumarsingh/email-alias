import { api } from "./browser.js";
import { DEFAULTS, validateSettings } from "./settings.js";
import { addEntry } from "./registry.js";

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

export async function remember(alias, site) {
  const next = addEntry(await getRegistry(), { alias, site });
  await saveRegistry(next);
  return next;
}

export async function getLastCopiedHash() {
  const { lastCopiedHash = "" } = await api.storage.local.get("lastCopiedHash");
  return lastCopiedHash;
}

export async function setLastCopiedHash(hash) {
  await api.storage.local.set({ lastCopiedHash: hash });
}
