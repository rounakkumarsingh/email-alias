import { blockedAliases } from "./registry.js";

// Sieve quoted-string escaping: only backslash and double quote are special.
export function escapeSieve(s) {
  return String(s).replace(/\\/g, "\\\\").replace(/"/g, '\\"');
}

const q = (s) => `"${escapeSieve(s)}"`;
const list = (items) => (items.length === 1 ? q(items[0]) : `[${items.map(q).join(", ")}]`);

// Builds the full Proton filter script. Order matters: block, fixed, tag label, spam.
export function generateSieve(settings, registry) {
  const blocked = blockedAliases(registry);
  const out = [];

  out.push('require ["fileinto", "variables"];', "");

  out.push("# 1. Blocked aliases: drop silently.");
  if (blocked.length) {
    out.push(`if address :is "to" ${list(blocked)} {`, "    discard;", "    stop;", "}");
  } else {
    out.push("# (none blocked)");
  }
  out.push("");

  out.push("# 2. Fixed addresses: deliver normally.");
  if (settings.fixed.length) {
    out.push(`if address :is "to" ${list(settings.fixed)} {`, "    stop;", "}");
  } else {
    out.push("# (none configured)");
  }
  out.push("");

  out.push("# 3. Aliases: label by the tag before the first dot.");
  out.push('if address :localpart :matches "to" "*.*" {', '    fileinto "${1}";', "    stop;", "}", "");

  out.push("# 4. Anything else at the domain was guessed by a spammer.");
  out.push(`if address :domain :is "to" ${q(settings.domain)} {`, `    fileinto ${q(settings.spamFolder)};`, "}", "");

  return out.join("\n");
}

export async function hashScript(script) {
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(script));
  return [...new Uint8Array(digest)].map((b) => b.toString(16).padStart(2, "0")).join("");
}
