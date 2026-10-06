import { describe, expect, test } from "bun:test";
import { DEFAULTS, validateSettings } from "../src/lib/settings.js";

const ok = (over = {}) => validateSettings({ ...DEFAULTS, ...over });

describe("validateSettings", () => {
  test("defaults are valid", () => expect(ok().ok).toBe(true));
  test("normalises domain", () => expect(ok({ domain: " Example.COM " }).value.domain).toBe("example.com"));
  for (const d of ["", "https://x.com", "@x.com", "nodot"]) {
    test(`bad domain ${JSON.stringify(d)}`, () => expect(ok({ domain: d }).errors.domain).toBeDefined());
  }
  for (const l of [4, 13, 6.5, "abc", ""]) {
    test(`bad length ${JSON.stringify(l)}`, () => expect(ok({ length: l }).errors.length).toBeDefined());
  }
  test("length bounds ok", () => {
    expect(ok({ length: 5 }).ok).toBe(true);
    expect(ok({ length: 12 }).ok).toBe(true);
  });
  test("fixed accepts comma/newline text and dedupes", () => {
    const r = ok({ fixed: "A@x.com,\n a@x.com b@x.com" });
    expect(r.ok).toBe(true);
    expect(r.value.fixed).toEqual(["a@x.com", "b@x.com"]);
  });
  test("bad fixed address", () => expect(ok({ fixed: ["nope"] }).errors.fixed).toContain("nope"));
  test("bad category", () => {
    expect(ok({ categories: ["fin", "a.b"] }).errors.categories).toContain("a.b");
    expect(ok({ categories: ["x".repeat(25)] }).errors.categories).toBeDefined();
  });
  for (const s of ["", "a\"b", "a\\b", "${1}", "a\nb"]) {
    test(`bad spam folder ${JSON.stringify(s)}`, () => expect(ok({ spamFolder: s }).errors.spamFolder).toBeDefined());
  }
  test("spam folder with spaces ok", () => expect(ok({ spamFolder: "Junk Mail" }).ok).toBe(true));
});
