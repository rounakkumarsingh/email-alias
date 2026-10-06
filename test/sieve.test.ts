import { describe, expect, test } from "bun:test";
import { addEntry, setStatus } from "../src/lib/registry.js";
import { escapeSieve, generateSieve, hashScript } from "../src/lib/sieve.js";
import { DEFAULTS } from "../src/lib/settings.js";

const A = "github.x7k2qf@rounakkumarsingh.com";
const B = "fin.k4v9qe@rounakkumarsingh.com";
const reg = (...blocked: string[]) => {
  let r = addEntry(addEntry([], { alias: A }), { alias: B });
  for (const b of blocked) r = setStatus(r, b, "blocked");
  return r;
};

describe("escapeSieve", () => {
  test("escapes quote and backslash", () => expect(escapeSieve('a"b\\c')).toBe('a\\"b\\\\c'));
  test("leaves plain text", () => expect(escapeSieve("Spam")).toBe("Spam"));
});

describe("generateSieve", () => {
  test("rules appear in the required order", () => {
    const s = generateSieve(DEFAULTS, reg(A));
    const idx = [
      s.indexOf("discard;"),
      s.indexOf('"hello@rounakkumarsingh.com"'),
      s.indexOf('fileinto "${1}"'),
      s.indexOf('fileinto "Spam"'),
    ];
    expect(idx.every((i) => i > 0)).toBe(true);
    expect([...idx].sort((a, b) => a - b)).toEqual(idx);
  });
  test("requires fileinto and variables", () => {
    expect(generateSieve(DEFAULTS, [])).toStartWith('require ["fileinto", "variables"];');
  });
  test("blocked: only blocked aliases, discard + stop", () => {
    const s = generateSieve(DEFAULTS, reg(A));
    expect(s).toContain(`if address :is "to" "${A}" {\n    discard;\n    stop;\n}`);
    expect(s).not.toContain(B);
  });
  test("multiple blocked become a sorted list", () => {
    const s = generateSieve(DEFAULTS, reg(A, B));
    expect(s).toContain(`["${B}", "${A}"]`);
  });
  test("no blocked: no discard", () => {
    expect(generateSieve(DEFAULTS, reg())).not.toContain("discard");
  });
  test("generic tag rule uses localpart :matches and ${1}", () => {
    const s = generateSieve(DEFAULTS, []);
    expect(s).toContain('address :localpart :matches "to" "*.*"');
    expect(s).toContain('fileinto "${1}";');
  });
  test("fixed addresses list", () => {
    const s = generateSieve({ ...DEFAULTS, fixed: ["a@x.com", "b@x.com"] }, []);
    expect(s).toContain('address :is "to" ["a@x.com", "b@x.com"]');
  });
  test("empty fixed list emits no rule", () => {
    const s = generateSieve({ ...DEFAULTS, fixed: [] }, []);
    expect(s).not.toContain("hello@");
    expect(s).toContain("(none configured)");
  });
  test("spam folder is escaped", () => {
    const s = generateSieve({ ...DEFAULTS, spamFolder: 'Junk "Mail"' }, []);
    expect(s).toContain('fileinto "Junk \\"Mail\\"";');
  });
  test("spam rule is scoped to the domain", () => {
    expect(generateSieve({ ...DEFAULTS, domain: "example.com" }, [])).toContain('address :domain :is "to" "example.com"');
  });
  test("is deterministic", () => {
    expect(generateSieve(DEFAULTS, reg(A))).toBe(generateSieve(DEFAULTS, reg(A)));
  });
});

describe("hashScript", () => {
  test("changes when blocks change, not when notes/active entries change", async () => {
    const h0 = await hashScript(generateSieve(DEFAULTS, reg()));
    const h1 = await hashScript(generateSieve(DEFAULTS, reg(A)));
    const h2 = await hashScript(generateSieve(DEFAULTS, addEntry(reg(), { alias: "new.abcde@rounakkumarsingh.com" })));
    expect(h1).not.toBe(h0);
    expect(h2).toBe(h0);
    expect(h0).toMatch(/^[0-9a-f]{64}$/);
  });
});
