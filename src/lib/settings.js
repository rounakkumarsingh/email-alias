import { isValidDomain, sanitizeTag, MAX_TAG } from "./alias.js";
import { LABEL_MODES } from "./labels.js";

export const DEFAULTS = {
  domain: "rounakkumarsingh.com",
  length: 6,
  fixed: ["hello@rounakkumarsingh.com", "rounak@rounakkumarsingh.com"],
  categories: ["fin", "govt"],
  spamFolder: "Spam",
  labelMode: "manual",
  cfAccountId: "",
  cfNamespaceId: "",
};

const EMAIL = /^[a-z0-9._+-]+@(?:[a-z0-9](?:[a-z0-9-]*[a-z0-9])?\.)+[a-z]{2,}$/;

// Accepts raw form values (strings for list fields are split on commas/newlines).
export function parseList(value) {
  if (Array.isArray(value)) return value.map((v) => String(v).trim()).filter(Boolean);
  return String(value || "").split(/[\s,]+/).map((v) => v.trim()).filter(Boolean);
}

// Returns {ok, errors: {field: message}, value: normalised settings}.
export function validateSettings(raw) {
  const errors = {};
  const value = {};

  const domain = String(raw.domain ?? "").trim().toLowerCase();
  if (!isValidDomain(domain)) errors.domain = "Enter a domain like example.com, without @ or https://.";
  value.domain = domain;

  const length = Number(raw.length);
  if (!Number.isInteger(length) || length < 5 || length > 12) {
    errors.length = "Random part length must be a whole number from 5 to 12.";
  }
  value.length = length;

  const fixed = parseList(raw.fixed).map((a) => a.toLowerCase());
  const badFixed = fixed.filter((a) => !EMAIL.test(a));
  if (badFixed.length) errors.fixed = `Not a valid address: ${badFixed[0]}`;
  value.fixed = [...new Set(fixed)];

  const categories = parseList(raw.categories).map((c) => c.toLowerCase());
  const badCat = categories.find((c) => sanitizeTag(c) !== c || !c);
  if (badCat) errors.categories = `"${badCat}" is not a valid tag. Use a-z, 0-9 and hyphens, up to ${MAX_TAG} characters.`;
  value.categories = [...new Set(categories)];

  const spam = String(raw.spamFolder ?? "").trim();
  if (!spam || spam.length > 100) errors.spamFolder = "Enter a folder or label name (up to 100 characters).";
  else if (/["\\\u0000-\u001f]|\$\{/.test(spam)) errors.spamFolder = 'The name can\'t contain ", \\, ${ or control characters.';
  value.spamFolder = spam;

  const mode = raw.labelMode ?? DEFAULTS.labelMode;
  if (!LABEL_MODES.includes(mode)) errors.labelMode = "Choose Manual or Bridge linker.";
  value.labelMode = mode;

  // Cloudflare blocklist is optional: both IDs empty means "not used". The API token is stored separately.
  for (const [field, label] of [["cfAccountId", "account ID"], ["cfNamespaceId", "KV namespace ID"]]) {
    const id = String(raw[field] ?? "").trim().toLowerCase();
    if (id && !/^[0-9a-f]{32}$/.test(id)) errors[field] = `The ${label} is 32 hex characters (0-9, a-f).`;
    value[field] = id;
  }

  return { ok: Object.keys(errors).length === 0, errors, value };
}
