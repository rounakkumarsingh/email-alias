import { addEntry } from "./registry.js";
import { ensureLabels, isNewTag } from "./linker.js";
import { ensureTag, markCreated } from "./labels.js";
import { getLabels, getRegistry, getSettings, saveLabels, saveRegistry, setLinkerStatus } from "./storage.js";
import { parseAlias } from "./alias.js";

// Saves an alias to the registry and tracks its tag's label status (a new tag starts as
// "needs-creating"). In Bridge mode a new tag also asks the host to create the Proton label.
// Linker failures never affect alias creation.
export async function recordAlias(alias, site) {
  const before = await getRegistry();
  const next = addEntry(before, { alias, site });
  if (next === before) return next;
  await saveRegistry(next);

  const tag = parseAlias(alias).tag;
  let labels = ensureTag(await getLabels(), tag);
  try {
    const { labelMode } = await getSettings();
    if (labelMode === "bridge" && isNewTag(before, tag)) {
      const r = await ensureLabels([tag]);
      labels = markCreated(labels, [tag]);
      await setLinkerStatus({ ok: true, message: r.message });
    }
  } catch (err) {
    await setLinkerStatus({ ok: false, message: err.message || String(err) });
  }
  await saveLabels(labels);
  return next;
}
