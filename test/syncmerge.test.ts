import { describe, expect, test } from "bun:test";
import { dirtyLabels, dirtyRegistry, mergeLabelState, mergeRegistryState, remoteLabels, remoteView } from "../src/lib/syncmerge.js";
import { DEFAULT_STAMP, reconcile } from "../src/lib/labels.js";

const e = (alias: string, updated: string, over: any = {}) => ({
  alias, tag: alias.split(".")[0], site: "", created: "2026-01-01T00:00:00.000Z", updated, status: "active", note: "", ...over,
});
const A = "shop.abcde@example.com";
const T1 = "2026-02-01T00:00:00.000Z";
const T2 = "2026-03-01T00:00:00.000Z";
const T3 = "2026-04-01T00:00:00.000Z";
const rv = (...blobs: any[]) => remoteView(blobs).view;
const tomb = (alias: string, updated: string) => ({ alias, deleted: true, updated });

describe("registry merge", () => {
  test("remote-only entry is added, local-only is kept", () => {
    const r = mergeRegistryState([e(A, T1)], {}, rv(e("fin.kkkkk@example.com", T1)));
    expect(r.registry.map((x: any) => x.alias).sort()).toEqual([A, "fin.kkkkk@example.com"].sort());
    expect(r.changed).toBe(true);
  });
  test("newer wins in both directions", () => {
    expect(mergeRegistryState([e(A, T1, { note: "old" })], {}, rv(e(A, T2, { note: "new" }))).registry[0].note).toBe("new");
    const keep = mergeRegistryState([e(A, T2, { note: "new" })], {}, rv(e(A, T1, { note: "old" })));
    expect(keep.registry[0].note).toBe("new");
    expect(keep.changed).toBe(false);
  });
  test("remote tombstone removes an older local entry and is kept", () => {
    const r = mergeRegistryState([e(A, T1)], {}, rv(tomb(A, T2)));
    expect(r.registry).toEqual([]);
    expect(r.tombstones).toEqual({ [A]: T2 });
  });
  test("a newer local edit resurrects over an older remote tombstone", () => {
    const r = mergeRegistryState([e(A, T3)], {}, rv(tomb(A, T2)));
    expect(r.registry).toHaveLength(1);
    expect(r.tombstones).toEqual({});
  });
  test("a tie goes to the tombstone", () => {
    expect(mergeRegistryState([e(A, T2)], {}, rv(tomb(A, T2))).registry).toEqual([]);
    expect(mergeRegistryState([], { [A]: T2 }, rv(e(A, T2))).registry).toEqual([]);
  });
  test("a local tombstone beats an older remote entry (delete made while locked)", () => {
    const r = mergeRegistryState([], { [A]: T2 }, rv(e(A, T1)));
    expect(r.registry).toEqual([]);
    expect(r.tombstones[A]).toBe(T2);
  });
  test("a local tombstone keeps its original timestamp, so a later remote edit still wins", () => {
    const r = mergeRegistryState([], { [A]: T1 }, rv(e(A, T2)));
    expect(r.registry).toHaveLength(1);
  });
  test("unusable remote blobs are skipped and counted, never applied", () => {
    const { view, skipped } = remoteView([{ alias: "not an alias", status: "active" }, { deleted: true }, null]);
    expect(view.size).toBe(0);
    expect(skipped).toBe(3);
  });
});

describe("dirty sets", () => {
  test("nothing pushed yet: everything is dirty, including tombstones", () => {
    const d = dirtyRegistry([e(A, T1)], { "fin.kkkkk@example.com": T2 }, {});
    expect(d.map((x: any) => x.alias).sort()).toEqual([A, "fin.kkkkk@example.com"].sort());
    expect(d.find((x: any) => x.plain.deleted)?.plain).toEqual({ alias: "fin.kkkkk@example.com", deleted: true, updated: T2 });
  });
  test("only records whose stamp changed are dirty", () => {
    const pushed = { [A]: T1, "fin.kkkkk@example.com": T1 };
    const d = dirtyRegistry([e(A, T1), e("fin.kkkkk@example.com", T2)], {}, pushed);
    expect(d.map((x: any) => x.alias)).toEqual(["fin.kkkkk@example.com"]);
  });
  test("deleting an already pushed entry makes the tombstone dirty", () => {
    const d = dirtyRegistry([], { [A]: T2 }, { [A]: T1 });
    expect(d).toHaveLength(1);
    expect(d[0].plain.deleted).toBe(true);
  });
  test("a tombstone that was already pushed is not dirty", () => {
    expect(dirtyRegistry([], { [A]: T2 }, { [A]: T2 })).toEqual([]);
  });
});

describe("labels", () => {
  const l = (status: string, updated: string) => ({ status, updated });
  test("newer wins, ties keep local", () => {
    const r = mergeLabelState({ fin: l("needs-creating", T1) }, { fin: l("created", T2), x: l("created", T1) });
    expect(r.labels.fin.status).toBe("created");
    expect(r.labels.x).toBeDefined();
    expect(mergeLabelState({ fin: l("created", T1) }, { fin: l("needs-creating", T1) }).changed).toBe(false);
  });
  test("an auto-added default never overrides a real status from another browser", () => {
    const local = reconcile({}, [], ["fin"]); // default stamp
    expect(local.fin.updated).toBe(DEFAULT_STAMP);
    expect(mergeLabelState(local, { fin: l("created", T1) }).labels.fin.status).toBe("created");
    expect(dirtyLabels(local, {})).toEqual([]);
  });
  test("real changes are dirty until pushed", () => {
    const labels = { fin: l("created", T2), govt: l("needs-creating", DEFAULT_STAMP) };
    expect(dirtyLabels(labels, {}).map((x: any) => x.tag)).toEqual(["fin"]);
    expect(dirtyLabels(labels, { fin: T2 })).toEqual([]);
  });
  test("bad remote label blobs are skipped", () => {
    const r = remoteLabels([{ tag: "fin", status: "created", updated: T1 }, { tag: "", status: "created", updated: T1 }, { tag: "x", status: "bad", updated: T1 }]);
    expect(Object.keys(r.labels)).toEqual(["fin"]);
    expect(r.skipped).toBe(2);
  });
});
