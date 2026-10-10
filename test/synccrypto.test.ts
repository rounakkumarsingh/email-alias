import { describe, expect, test } from "bun:test";
import { decryptJson, deriveKeys, encryptJson, idFor, keysFromRaw, makeCheck, newSalt, verifyCheck } from "../src/lib/synccrypto.js";

const IT = 1000; // fast for tests; production uses ITERATIONS (600k)
const salt = newSalt();
const keys = await deriveKeys("correct horse", salt, IT);
const entry = { alias: "shop.abcde@example.com", tag: "shop", site: "shop.com", note: "my secret note", status: "active" };

describe("synccrypto", () => {
  test("round trip", async () => {
    const blob = await encryptJson(keys, entry, "reg:abc");
    expect(await decryptJson(keys, blob, "reg:abc")).toEqual(entry);
  });

  test("blob holds no plaintext", async () => {
    const blob = await encryptJson(keys, entry, "reg:abc");
    for (const s of ["shop", "example.com", "secret", "active"]) expect(blob).not.toContain(s);
    expect(Object.keys(JSON.parse(blob)).sort()).toEqual(["ct", "iv", "v"]);
  });

  test("fresh IV per encryption", async () => {
    const a = JSON.parse(await encryptJson(keys, entry, "k"));
    const b = JSON.parse(await encryptJson(keys, entry, "k"));
    expect(a.iv).not.toBe(b.iv);
    expect(a.ct).not.toBe(b.ct);
  });

  test("wrong passphrase fails", async () => {
    const blob = await encryptJson(keys, entry, "reg:abc");
    const wrong = await deriveKeys("wrong horse", salt, IT);
    await expect(decryptJson(wrong, blob, "reg:abc")).rejects.toThrow(/wrong passphrase/);
  });

  test("blob moved to another key fails (AAD)", async () => {
    const blob = await encryptJson(keys, entry, "reg:abc");
    await expect(decryptJson(keys, blob, "reg:other")).rejects.toThrow();
  });

  test("tampered ciphertext and garbage fail", async () => {
    const o = JSON.parse(await encryptJson(keys, entry, "k"));
    o.ct = o.ct.slice(0, -4) + (o.ct.endsWith("AAAA") ? "BBBB" : "AAAA");
    await expect(decryptJson(keys, JSON.stringify(o), "k")).rejects.toThrow();
    await expect(decryptJson(keys, "not json", "k")).rejects.toThrow();
    await expect(decryptJson(keys, JSON.stringify({ v: 2, iv: "", ct: "" }), "k")).rejects.toThrow();
  });

  test("same passphrase and salt derive the same keys; other salt does not", async () => {
    const again = await deriveKeys("correct horse", salt, IT);
    expect(again.raw).toBe(keys.raw);
    expect((await deriveKeys("correct horse", newSalt(), IT)).raw).not.toBe(keys.raw);
  });

  test("keys survive the session-storage round trip", async () => {
    const restored = await keysFromRaw(keys.raw);
    const blob = await encryptJson(keys, entry, "k");
    expect(await decryptJson(restored, blob, "k")).toEqual(entry);
    await expect(keysFromRaw("AAAA")).rejects.toThrow();
  });

  test("ids are deterministic, opaque, and separated by kind", async () => {
    const a = await idFor(keys, "reg", entry.alias);
    expect(a).toMatch(/^[0-9a-f]{32}$/);
    expect(await idFor(keys, "reg", entry.alias)).toBe(a);
    expect(await idFor(keys, "lbl", entry.alias)).not.toBe(a);
    expect(a).not.toContain("shop");
    const other = await deriveKeys("another", salt, IT);
    expect(await idFor(other, "reg", entry.alias)).not.toBe(a);
  });

  test("check blob verifies only with the right passphrase", async () => {
    const check = await makeCheck(keys);
    expect(await verifyCheck(keys, check)).toBe(true);
    await expect(verifyCheck(await deriveKeys("nope", salt, IT), check)).rejects.toThrow();
  });
});
