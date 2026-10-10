// Pure routing decision for one recipient address. No I/O, so it is easy to test.
//
// Aliases look like tag.random@domain: tag = [a-z0-9-]{1,24}, random = [a-z0-9]{5,12}.
// Keep these limits in step with src/lib/alias.js (test/worker-route.test.ts checks they agree).

const ALIAS_LOCAL = /^([a-z0-9-]{1,24})\.([a-z0-9]{5,12})$/;

export function parseList(value) {
  return String(value ?? "").split(/[\s,]+/).map((v) => v.trim().toLowerCase()).filter(Boolean);
}

// env: { DOMAIN: "example.com", FIXED: "hello@example.com, me@example.com" }
// Returns { action: "fixed" | "alias" | "reject", alias, tag }. alias is the lowercased address.
export function decide(to, env) {
  const alias = String(to ?? "").trim().toLowerCase();
  const domain = String(env.DOMAIN ?? "").trim().toLowerCase();
  const reject = { action: "reject", alias, tag: null };

  if (!domain) return reject;
  if (parseList(env.FIXED).includes(alias)) return { action: "fixed", alias, tag: null };

  const at = alias.lastIndexOf("@");
  if (at < 1 || alias.slice(at + 1) !== domain) return reject;

  const m = ALIAS_LOCAL.exec(alias.slice(0, at));
  if (!m) return reject;
  return { action: "alias", alias, tag: m[1] };
}

export const blockKey = (alias) => `blocked:${alias}`;
