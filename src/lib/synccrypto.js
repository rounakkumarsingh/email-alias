// Client-side encryption for sync. Cloudflare only ever sees the output of these functions.
//
// One passphrase -> PBKDF2 -> 64 bytes: the first 32 are an AES-256-GCM key, the last 32 an HMAC-SHA256
// key used to turn an alias into an opaque KV key id. The passphrase itself is never kept.

export const ITERATIONS = 600_000;
export const FORMAT = 1;
const CHECK_TEXT = "alias-maker-sync-ok";

const enc = new TextEncoder();
const dec = new TextDecoder();

export function toB64(bytes) {
  let s = "";
  for (let i = 0; i < bytes.length; i += 0x8000) s += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
  return btoa(s);
}

export function fromB64(text) {
  const s = atob(text);
  const out = new Uint8Array(s.length);
  for (let i = 0; i < s.length; i++) out[i] = s.charCodeAt(i);
  return out;
}

export function randomBytes(n) {
  return crypto.getRandomValues(new Uint8Array(n));
}

export const newSalt = () => toB64(randomBytes(16));
export const newHead = () => [...randomBytes(16)].map((b) => b.toString(16).padStart(2, "0")).join("");

async function keysFromBits(bits) {
  const aes = await crypto.subtle.importKey("raw", bits.slice(0, 32), "AES-GCM", false, ["encrypt", "decrypt"]);
  const hmac = await crypto.subtle.importKey("raw", bits.slice(32, 64), { name: "HMAC", hash: "SHA-256" }, false, ["sign"]);
  return { aes, hmac, raw: toB64(bits) };
}

export async function deriveKeys(passphrase, saltB64, iterations = ITERATIONS) {
  const base = await crypto.subtle.importKey("raw", enc.encode(passphrase.normalize("NFKC")), "PBKDF2", false, ["deriveBits"]);
  const bits = new Uint8Array(await crypto.subtle.deriveBits(
    { name: "PBKDF2", hash: "SHA-256", salt: fromB64(saltB64), iterations }, base, 512));
  return keysFromBits(bits);
}

// Rebuilds keys from the base64 form kept in session storage (memory only).
export async function keysFromRaw(rawB64) {
  const bits = fromB64(rawB64);
  if (bits.length !== 64) throw new Error("Stored sync key is invalid.");
  return keysFromBits(bits);
}

// The KV key name is the AAD, so a blob can't be moved onto another key without failing to decrypt.
export async function encryptJson(keys, value, aad) {
  const iv = randomBytes(12);
  const ct = await crypto.subtle.encrypt(
    { name: "AES-GCM", iv, additionalData: enc.encode(aad) }, keys.aes, enc.encode(JSON.stringify(value)));
  return JSON.stringify({ v: FORMAT, iv: toB64(iv), ct: toB64(new Uint8Array(ct)) });
}

export async function decryptJson(keys, text, aad) {
  try {
    const blob = JSON.parse(text);
    if (blob.v !== FORMAT) throw new Error("format");
    const pt = await crypto.subtle.decrypt(
      { name: "AES-GCM", iv: fromB64(blob.iv), additionalData: enc.encode(aad) }, keys.aes, fromB64(blob.ct));
    return JSON.parse(dec.decode(pt));
  } catch {
    throw new Error("Could not decrypt (wrong passphrase or damaged data).");
  }
}

// Deterministic, opaque id (128 bits, hex) for an alias or tag. `kind` separates the two namespaces.
export async function idFor(keys, kind, value) {
  const sig = new Uint8Array(await crypto.subtle.sign("HMAC", keys.hmac, enc.encode(`${kind}\0${value}`)));
  return [...sig.subarray(0, 16)].map((b) => b.toString(16).padStart(2, "0")).join("");
}

export const makeCheck = (keys) => encryptJson(keys, CHECK_TEXT, "sync:meta");

export async function verifyCheck(keys, check) {
  return (await decryptJson(keys, check, "sync:meta")) === CHECK_TEXT;
}
