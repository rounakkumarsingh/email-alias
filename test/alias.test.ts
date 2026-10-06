import { describe, expect, test } from "bun:test";
import {
  ALIAS_ALPHABET, buildAlias, isAlias, isValidDomain, parseAlias, randomPart, sanitizeTag, tagFromHost,
} from "../src/lib/alias.js";

describe("tagFromHost", () => {
  const cases: [string, string][] = [
    ["github.com", "github"],
    ["www.github.com", "github"],
    ["accounts.google.com", "google"],
    ["onlinesbi.sbi.co.in", "sbi"],
    ["incometax.gov.in", "incometax"],
    ["bbc.co.uk", "bbc"],
    ["www.amazon.co.uk", "amazon"],
    ["co.uk", "co"],
    ["localhost", "localhost"],
    ["", ""],
    ["My_Site-1.com", "mysite-1"],
  ];
  for (const [host, tag] of cases) test(host || "(empty)", () => expect(tagFromHost(host)).toBe(tag));
});

describe("sanitizeTag", () => {
  test("lowercases and strips", () => expect(sanitizeTag("Git.Hub!")).toBe("github"));
  test("no dots ever", () => expect(sanitizeTag("a.b.c")).toBe("abc"));
  test("trims hyphens", () => expect(sanitizeTag("--fin--")).toBe("fin"));
  test("caps at 24 without trailing hyphen", () => {
    const t = sanitizeTag("a".repeat(23) + "-bbbb");
    expect(t.length).toBeLessThanOrEqual(24);
    expect(t.endsWith("-")).toBe(false);
  });
  test("handles null", () => expect(sanitizeTag(null as any)).toBe(""));
});

describe("randomPart", () => {
  test("length and alphabet", () => {
    for (const len of [5, 6, 12]) {
      const r = randomPart(len);
      expect(r).toHaveLength(len);
      for (const c of r) expect(ALIAS_ALPHABET).toContain(c);
    }
  });
  test("alphabet is unambiguous", () => {
    for (const c of "01oli") expect(ALIAS_ALPHABET).not.toContain(c);
  });
  test("roughly uniform (chi-square)", () => {
    const counts = new Map<string, number>();
    const total = 120_000;
    const s = Array.from({ length: total / 12 }, () => randomPart(12)).join("");
    for (const c of s) counts.set(c, (counts.get(c) ?? 0) + 1);
    const n = ALIAS_ALPHABET.length;
    const expected = total / n;
    let chi = 0;
    for (const c of ALIAS_ALPHABET) chi += ((counts.get(c) ?? 0) - expected) ** 2 / expected;
    // df = 30; critical value at p=0.0001 is about 63.
    expect(chi).toBeLessThan(63);
  });
  test("rejection sampling discards biased bytes", () => {
    // Bytes >= limit (217 for n=31) must never be mapped; feed them first.
    let call = 0;
    const rng = (buf: Uint8Array) => {
      buf.fill(call++ === 0 ? 255 : 0);
    };
    expect(randomPart(5, rng)).toBe(ALIAS_ALPHABET[0].repeat(5));
  });
});

describe("alias validation", () => {
  test("build + parse round trip", () => {
    const a = buildAlias("github", "x7k2qf", "rounakkumarsingh.com");
    expect(a).toBe("github.x7k2qf@rounakkumarsingh.com");
    expect(parseAlias(a)).toEqual({ tag: "github", random: "x7k2qf", domain: "rounakkumarsingh.com" });
  });
  test("normalises case and whitespace", () => {
    expect(parseAlias("  GitHub.X7K2QF@Example.com ")?.tag).toBe("github");
  });
  for (const bad of ["", "github@x.com", "a.b.c@x.com", "git hub.abc@x.com", "a.b@x", "a.b@-x.com", "x".repeat(25) + ".abc@x.com"]) {
    test(`rejects ${JSON.stringify(bad)}`, () => expect(isAlias(bad)).toBe(false));
  }
});

describe("isValidDomain", () => {
  test("accepts", () => expect(isValidDomain("rounakkumarsingh.com")).toBe(true));
  for (const bad of ["", "@x.com", "https://x.com", "x", "x.c", "-x.com", "x..com"]) {
    test(`rejects ${JSON.stringify(bad)}`, () => expect(isValidDomain(bad)).toBe(false));
  }
});
