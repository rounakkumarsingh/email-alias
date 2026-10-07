import { addEntry } from "./registry.js";
import { ensureLabels, isNewTag } from "./linker.js";
import { getRegistry, getSettings, saveRegistry, setLinkerStatus } from "./storage.js";
import { parseAlias } from "./alias.js";

// Saves an alias to the registry. When it introduces a new tag and the linker is on, asks the
// host to create the Proton label. Linker failures never affect alias creation.
export async function recordAlias(alias, site) {
  const before = await getRegistry();
  const next = addEntry(before, { alias, site });
  if (next === before) return next;
  await saveRegistry(next);

  const tag = parseAlias(alias).tag;
  try {
    const { autoLabels } = await getSettings();
    if (autoLabels && isNewTag(before, tag)) {
      const r = await ensureLabels([tag]);
      await setLinkerStatus({ ok: true, message: r.message });
    }
  } catch (err) {
    await setLinkerStatus({ ok: false, message: err.message || String(err) });
  }
  return next;
}
