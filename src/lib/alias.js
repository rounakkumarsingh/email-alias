// Pure alias logic. Aliases look like: tag.random@domain (e.g. github.x7k2qf@rounakkumarsingh.com)

// No 0/o, 1/l/i: easy to read aloud or type from a screen.
export const ALIAS_ALPHABET = "abcdefghjkmnpqrstuvwxyz23456789";
export const MAX_TAG = 24;

// Second-level suffixes where the site name sits one label further left.
export const TWO_LEVEL_SUFFIXES = new Set([
  "co.in", "gov.in", "ac.in", "org.in", "net.in", "nic.in", "edu.in",
  "co.uk", "org.uk", "ac.uk", "gov.uk",
  "com.au", "co.jp", "com.br", "co.nz", "com.sg", "co.za",
]);

export function randomPart(length, rng = (buf) => crypto.getRandomValues(buf)) {
  const n = ALIAS_ALPHABET.length;
  const limit = 256 - (256 % n); // rejection sampling keeps every character equally likely
  const out = [];
  while (out.length < length) {
    const buf = new Uint8Array(length * 2);
    rng(buf);
    for (const b of buf) {
      if (b < limit) out.push(ALIAS_ALPHABET[b % n]);
      if (out.length === length) break;
    }
  }
  return out.join("");
}

// Tags must not contain dots: the mail filter splits on the first dot.
export function sanitizeTag(raw) {
  return (raw || "")
    .toLowerCase()
    .replace(/[^a-z0-9-]/g, "")
    .replace(/^-+|-+$/g, "")
    .slice(0, MAX_TAG)
    .replace(/-+$/g, "");
}

export function tagFromHost(hostname) {
  const parts = (hostname || "").toLowerCase().replace(/^www\./, "").split(".").filter(Boolean);
  if (parts.length === 0) return "";
  if (parts.length === 1) return sanitizeTag(parts[0]);
  const lastTwo = parts.slice(-2).join(".");
  const label = TWO_LEVEL_SUFFIXES.has(lastTwo) && parts.length >= 3
    ? parts[parts.length - 3]
    : parts[parts.length - 2];
  return sanitizeTag(label);
}

export function buildAlias(tag, random, domain) {
  return `${tag}.${random}@${domain}`;
}

const ALIAS_PATTERN = /^([a-z0-9-]{1,24})\.([a-z0-9]+)@((?:[a-z0-9](?:[a-z0-9-]*[a-z0-9])?\.)+[a-z]{2,})$/;

// Returns {tag, random, domain} or null. Case-insensitive; output is lowercase.
export function parseAlias(text) {
  const m = ALIAS_PATTERN.exec((text || "").trim().toLowerCase());
  return m ? { tag: m[1], random: m[2], domain: m[3] } : null;
}

export function isAlias(text) {
  return parseAlias(text) !== null;
}

export function isValidDomain(domain) {
  return /^(?=.{3,253}$)([a-z0-9]([a-z0-9-]*[a-z0-9])?\.)+[a-z]{2,}$/i.test(domain || "");
}
