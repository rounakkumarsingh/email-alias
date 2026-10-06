// Shared logic for the popup and the background worker.
// Aliases look like: tag.random@domain  (e.g. github.x7k2qf@rounakkumarsingh.com)

const DEFAULTS = { domain: "rounakkumarsingh.com", length: 6 };

// No 0/o, 1/l/i: easy to read aloud or type from a screen.
const ALIAS_ALPHABET = "abcdefghjkmnpqrstuvwxyz23456789";

// Second-level suffixes where the site name sits one label further left.
const TWO_LEVEL_SUFFIXES = new Set([
  "co.in", "gov.in", "ac.in", "org.in", "net.in", "nic.in", "edu.in",
  "co.uk", "org.uk", "ac.uk", "gov.uk",
  "com.au", "co.jp", "com.br", "co.nz", "com.sg", "co.za",
]);

function randomPart(length) {
  const n = ALIAS_ALPHABET.length;
  const limit = 256 - (256 % n); // rejection sampling keeps every character equally likely
  const out = [];
  while (out.length < length) {
    const buf = new Uint8Array(length * 2);
    crypto.getRandomValues(buf);
    for (const b of buf) {
      if (b < limit) out.push(ALIAS_ALPHABET[b % n]);
      if (out.length === length) break;
    }
  }
  return out.join("");
}

// Tags must not contain dots: the mail filter splits on the first dot.
function sanitizeTag(raw) {
  return (raw || "")
    .toLowerCase()
    .replace(/[^a-z0-9-]/g, "")
    .replace(/^-+|-+$/g, "")
    .slice(0, 24);
}

function tagFromHost(hostname) {
  const parts = (hostname || "").toLowerCase().replace(/^www\./, "").split(".").filter(Boolean);
  if (parts.length === 0) return "";
  if (parts.length === 1) return sanitizeTag(parts[0]);
  const lastTwo = parts.slice(-2).join(".");
  const label = TWO_LEVEL_SUFFIXES.has(lastTwo) && parts.length >= 3
    ? parts[parts.length - 3]
    : parts[parts.length - 2];
  return sanitizeTag(label);
}

function buildAlias(tag, random, domain) {
  return `${tag}.${random}@${domain}`;
}

const ALIAS_PATTERN = /^[a-z0-9-]+\.[a-z0-9]+@[a-z0-9.-]+\.[a-z]{2,}$/i;

function isAlias(text) {
  return ALIAS_PATTERN.test((text || "").trim());
}

function blockRule(alias) {
  return `if address :is "to" "${alias.trim().toLowerCase()}" { discard; stop; }`;
}

function isValidDomain(domain) {
  return /^(?=.{3,253}$)([a-z0-9]([a-z0-9-]*[a-z0-9])?\.)+[a-z]{2,}$/i.test(domain || "");
}

async function getSettings() {
  return chrome.storage.sync.get(DEFAULTS);
}

async function remember(alias, site) {
  const { recent = [] } = await chrome.storage.local.get("recent");
  recent.unshift({ alias, site, at: Date.now() });
  await chrome.storage.local.set({ recent: recent.slice(0, 20) });
}

// Injected into the page. Must stay self-contained (no outside references).
function fillEmailField(value, allowSearch) {
  const usable = (el) =>
    el && el.tagName === "INPUT" && !el.disabled && !el.readOnly &&
    ["email", "text", ""].includes((el.getAttribute("type") || "").toLowerCase());

  let el = document.activeElement;
  if (!usable(el)) {
    if (!allowSearch) return false;
    el = document.querySelector('input[type="email"]:not([disabled]):not([readonly])') ||
      Array.from(document.querySelectorAll("input")).find((i) =>
        usable(i) &&
        /mail/i.test([i.name, i.id, i.autocomplete, i.placeholder].join(" ")));
  }
  if (!el) return false;

  // Use the native setter so React/Vue-style forms register the change.
  const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value").set;
  setter.call(el, value);
  el.dispatchEvent(new Event("input", { bubbles: true }));
  el.dispatchEvent(new Event("change", { bubbles: true }));
  el.focus();
  return true;
}

// Tries the focused field in every frame first, then searches the target frame.
async function fillInTab(tabId, value, frameId) {
  const target = frameId === undefined ? { tabId, allFrames: true } : { tabId, frameIds: [frameId] };
  const first = await chrome.scripting.executeScript({ target, func: fillEmailField, args: [value, false] });
  if (first.some((r) => r.result)) return true;

  const second = await chrome.scripting.executeScript({
    target: { tabId, frameIds: [frameId ?? 0] },
    func: fillEmailField,
    args: [value, true],
  });
  return second.some((r) => r.result);
}
