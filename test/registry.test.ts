import { describe, expect, test } from "bun:test";
import {
  addEntry, blockedAliases, exportRegistry, mergeRegistry, parseImport, search, setNote, setStatus, tagsOf,
} from "../src/lib/registry.js";

const t = (s: string) => () => s;
const A = "github.x7k2qf@example.com";
const B = "fin.k4v9qe@example.com";

describe("registry", () => {
  test("addEntry creates active entry, lowercases, strips www", () => {
    const r = addEntry([], { alias: "GitHub.X7K2QF@Example.com", site: "www.github.com" }, t("2026-01-01T00:00:00.000Z"));
    expect(r).toHaveLength(1);
    expect(r[0]).toMatchObject({ alias: A, tag: "github", site: "github.com", status: "active", note: "" });
  });
  test("addEntry is idempotent and rejects bad aliases", () => {
    const r = addEntry([], { alias: A });
    expect(addEntry(r, { alias: A })).toBe(r);
    expect(() => addEntry(r, { alias: "nope" })).toThrow();
  });
  test("block / unblock / note", () => {
    let r = addEntry(addEntry([], { alias: A }), { alias: B });
    r = setStatus(r, A, "blocked", t("2030-01-01T00:00:00.000Z"));
    expect(blockedAliases(r)).toEqual([A]);
    expect(r.find((e) => e.alias === A)!.updated).toBe("2030-01-01T00:00:00.000Z");
    r = setStatus(r, A, "active");
    expect(blockedAliases(r)).toEqual([]);
    expect(setNote(r, B, "bank").find((e) => e.alias === B)!.note).toBe("bank");
    expect(() => setStatus(r, A, "weird")).toThrow();
  });
  test("search across fields", () => {
    let r = addEntry(addEntry([], { alias: A, site: "github.com" }), { alias: B, site: "mybank.in" });
    r = setNote(r, B, "savings");
    expect(search(r, "bank")).toHaveLength(1);
    expect(search(r, "SAVINGS")).toHaveLength(1);
    expect(search(r, "")).toHaveLength(2);
    expect(search(r, "zzz")).toHaveLength(0);
  });
  test("tagsOf is unique and sorted", () => {
    const r = addEntry(addEntry(addEntry([], { alias: A }), { alias: B }), { alias: "github.abcde@example.com" });
    expect(tagsOf(r)).toEqual(["fin", "github"]);
  });
});

describe("import / export", () => {
  const base = addEntry(addEntry([], { alias: A, site: "github.com" }, t("2026-01-01T00:00:00.000Z")), { alias: B }, t("2026-02-01T00:00:00.000Z"));
  test("round trip", () => {
    const text = exportRegistry(base);
    expect(parseImport(text)).toEqual(base);
  });
  test("rejects garbage", () => {
    expect(() => parseImport("{")).toThrow(/JSON/);
    expect(() => parseImport(JSON.stringify({ entries: [] }))).toThrow(/export/);
    expect(() => parseImport(JSON.stringify({ app: "alias-maker", version: 99, entries: [] }))).toThrow(/version/);
  });
  test("rejects invalid entries", () => {
    const bad = (e: object) => JSON.stringify({ app: "alias-maker", version: 1, entries: [e] });
    expect(() => parseImport(bad({ alias: "x", status: "active", created: "2026-01-01" }))).toThrow(/alias/i);
    expect(() => parseImport(bad({ alias: A, status: "nope", created: "2026-01-01" }))).toThrow(/status/);
    expect(() => parseImport(bad({ alias: A, status: "active", created: "yesterday" }))).toThrow(/created/);
  });
  test("merge: adds new, newer updated wins, older ignored", () => {
    const blocked = setStatus(base, A, "blocked", t("2026-03-01T00:00:00.000Z"));
    const m1 = mergeRegistry(base, blocked);
    expect(m1.changed).toBe(1);
    expect(blockedAliases(m1.registry)).toEqual([A]);
    const m2 = mergeRegistry(blocked, base); // base is older
    expect(m2.changed).toBe(0);
    expect(blockedAliases(m2.registry)).toEqual([A]);
    const extra = addEntry([], { alias: "new.abcde@example.com" });
    const m3 = mergeRegistry(base, extra);
    expect(m3.added).toBe(1);
    expect(m3.registry).toHaveLength(3);
  });
});
