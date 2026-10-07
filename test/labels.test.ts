import { describe, expect, test } from "bun:test";
import {
  badgeText, CREATED, ensureTag, markCreated, mergeLabels, NEEDS, parseLabels, pendingTags, reconcile, setLabelStatus, tagList,
} from "../src/lib/labels.js";
import { addEntry, exportRegistry } from "../src/lib/registry.js";
import { switchLabelMode } from "../src/lib/modeswitch.js";
import { DEFAULTS, validateSettings } from "../src/lib/settings.js";

const T = (s: string) => () => s;

describe("label status tracking", () => {
  test("a tag starts as needs-creating the first time it is seen", () => {
    const l = ensureTag({}, "github", T("2026-01-01T00:00:00.000Z"));
    expect(l.github).toEqual({ status: NEEDS, updated: "2026-01-01T00:00:00.000Z" });
  });
  test("ensureTag never resets an existing tag and returns the same object", () => {
    const l = markCreated(ensureTag({}, "github"), ["github"]);
    expect(ensureTag(l, "github")).toBe(l);
    expect(ensureTag(l, "github").github.status).toBe(CREATED);
    expect(ensureTag(l, "")).toBe(l);
  });
  test("categories are included from the start", () => {
    const l = reconcile({}, [], ["fin", "govt"]);
    expect(pendingTags(l)).toEqual(["fin", "govt"]);
  });
  test("registry tags are added; reconcile is stable and keeps created", () => {
    const reg = addEntry([], { alias: "github.abcde@x.com" });
    let l = reconcile({}, reg, ["fin"]);
    l = markCreated(l, ["github"]);
    const again = reconcile(l, reg, ["fin"]);
    expect(again).toBe(l);
    expect(pendingTags(again)).toEqual(["fin"]);
  });
  test("a category removed from settings keeps its status", () => {
    const l = markCreated(reconcile({}, [], ["fin"]), ["fin"]);
    expect(reconcile(l, [], []).fin.status).toBe(CREATED);
  });
  test("toggle created and back", () => {
    let l = ensureTag({}, "fin");
    l = setLabelStatus(l, "fin", CREATED, T("2026-02-01T00:00:00.000Z"));
    expect(l.fin).toEqual({ status: CREATED, updated: "2026-02-01T00:00:00.000Z" });
    l = setLabelStatus(l, "fin", NEEDS);
    expect(pendingTags(l)).toEqual(["fin"]);
    expect(setLabelStatus(l, "fin", NEEDS)).toBe(l);
    expect(() => setLabelStatus(l, "fin", "weird")).toThrow();
  });
  test("pending count and badge text", () => {
    const l = reconcile({}, [], ["fin", "govt", "github"]);
    expect(pendingTags(l)).toHaveLength(3);
    expect(badgeText(3)).toBe("3");
    expect(badgeText(0)).toBe("");
    expect(badgeText(150)).toBe("99+");
    expect(pendingTags(markCreated(l, ["fin", "govt", "github"]))).toHaveLength(0);
  });
  test("tagList is sorted with statuses", () => {
    const l = markCreated(reconcile({}, [], ["govt", "fin"]), ["fin"]);
    expect(tagList(l)).toEqual([{ tag: "fin", status: CREATED }, { tag: "govt", status: NEEDS }]);
  });
  test("merge: newer wins per tag", () => {
    const a = { fin: { status: NEEDS, updated: "2026-01-01T00:00:00.000Z" } };
    const b = { fin: { status: CREATED, updated: "2026-02-01T00:00:00.000Z" }, x: { status: NEEDS, updated: "2026-01-01T00:00:00.000Z" } };
    expect(mergeLabels(a, b).fin.status).toBe(CREATED);
    expect(mergeLabels(b, a).fin.status).toBe(CREATED);
    expect(Object.keys(mergeLabels(a, b))).toEqual(["fin", "x"]);
  });
  test("export includes labels and parseLabels round trips", () => {
    const labels = markCreated(reconcile({}, [], ["fin"]), ["fin"]);
    const data = JSON.parse(exportRegistry([], undefined, labels));
    expect(parseLabels(data.labels)).toEqual(labels);
    expect(parseLabels(undefined)).toEqual({});
  });
  test("parseLabels rejects bad data", () => {
    expect(() => parseLabels([])).toThrow();
    expect(() => parseLabels({ "a.b": { status: NEEDS, updated: "2026-01-01" } })).toThrow(/tag/);
    expect(() => parseLabels({ fin: { status: "done", updated: "2026-01-01" } })).toThrow(/status/);
    expect(() => parseLabels({ fin: { status: NEEDS, updated: "nope" } })).toThrow(/date/);
  });
});

describe("label mode setting", () => {
  test("defaults to manual", () => expect(DEFAULTS.labelMode).toBe("manual"));
  test("accepts manual and bridge, rejects anything else", () => {
    expect(validateSettings({ ...DEFAULTS, labelMode: "bridge" }).ok).toBe(true);
    expect(validateSettings({ ...DEFAULTS, labelMode: "manual" }).ok).toBe(true);
    expect(validateSettings({ ...DEFAULTS, labelMode: "auto" }).errors.labelMode).toBeDefined();
  });
  test("missing mode falls back to manual", () => {
    const { labelMode: _drop, ...rest } = DEFAULTS;
    expect(validateSettings(rest).value.labelMode).toBe("manual");
  });
});

describe("switching to Bridge mode", () => {
  const pending = () => markCreated(reconcile({}, [], ["fin", "govt", "github"]), ["github"]);

  test("ensures every tag marked needs-creating, then marks them created", async () => {
    let sent: string[] = [];
    const r = await switchLabelMode({
      from: "manual", to: "bridge", labels: pending(),
      ensure: async (names: string[]) => { sent = names; return { message: "Created 2 labels: fin, govt." }; },
    });
    expect(sent).toEqual(["fin", "govt"]);
    expect(r).toMatchObject({ ran: true, ok: true, message: "Created 2 labels: fin, govt." });
    expect(pendingTags(r.labels)).toEqual([]);
  });
  test("a Bridge failure keeps tags pending and does not throw", async () => {
    const r = await switchLabelMode({
      from: "manual", to: "bridge", labels: pending(),
      ensure: async () => { throw new Error("Bridge down"); },
    });
    expect(r).toMatchObject({ ran: true, ok: false, message: "Bridge down" });
    expect(pendingTags(r.labels)).toEqual(["fin", "govt"]);
  });
  test("nothing pending means no Bridge call", async () => {
    const r = await switchLabelMode({
      from: "manual", to: "bridge", labels: markCreated(pending(), ["fin", "govt"]),
      ensure: async () => { throw new Error("must not be called"); },
    });
    expect(r.ran).toBe(false);
    expect(r.ok).toBe(true);
  });
  test("no call when the mode did not change or when switching to manual", async () => {
    const ensure = async () => { throw new Error("must not be called"); };
    expect((await switchLabelMode({ from: "bridge", to: "bridge", labels: pending(), ensure })).ran).toBe(false);
    expect((await switchLabelMode({ from: "bridge", to: "manual", labels: pending(), ensure })).ran).toBe(false);
    expect((await switchLabelMode({ from: "manual", to: "manual", labels: pending(), ensure })).ran).toBe(false);
  });
});
