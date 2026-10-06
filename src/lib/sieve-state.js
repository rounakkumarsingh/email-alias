import { generateSieve, hashScript } from "./sieve.js";
import { getLastCopiedHash, getRegistry, getSettings, setLastCopiedHash } from "./storage.js";

// Current script plus whether it differs from the one last copied to the clipboard.
export async function sieveState() {
  const script = generateSieve(await getSettings(), await getRegistry());
  const hash = await hashScript(script);
  const last = await getLastCopiedHash();
  return { script, hash, stale: hash !== last, neverCopied: last === "" };
}

export async function copyScript() {
  const { script, hash } = await sieveState();
  await navigator.clipboard.writeText(script);
  await setLastCopiedHash(hash);
  return script;
}
