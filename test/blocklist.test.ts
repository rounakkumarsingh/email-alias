import { describe, expect, test } from "bun:test";
import { deleteAlias } from "../src/lib/blocklist.js";
import { PERMISSION_ERROR } from "../src/lib/cloudflare.js";
import { dirtyRegistry } from "../src/lib/syncmerge.js";

const ACC = "a".repeat(32);
const NS = "b".repeat(32);
const cfg = { accountId: ACC, namespaceId: NS, token: "tok" };
const ALIAS = "shop.abcde@example.com";
const STAMP = "2026-05-01T00:00:00.000Z";

function setup(opts: { status?: number; permitted?: boolean } = {}) {
  const calls: { url: string; method: string }[] = [];
  const fetch = async (url: string, init: any) => {
    calls.push({ url, method: init.method });
    const status = opts.status ?? 200;
    return { ok: status < 300, status, json: async () => ({}) } as any;
  };
  // Stand-in for storage: removeAlias writes the entry removal and the tombstone together.
  const state = { registry: [{ alias: ALIAS, updated: "2026-01-01T00:00:00.000Z", status: "active" }] as any[], tombstones: {} as Record<string, string> };
  const remove = async (alias: string) => {
    state.registry = state.registry.filter((e) => e.alias !== alias);
    state.tombstones = { ...state.tombstones, [alias]: STAMP };
  };
  const deps = { getConfig: async () => cfg, hasPermission: async () => opts.permitted ?? true, fetch, remove };
  return { calls, state, deps };
}

describe("deleteAlias", () => {
  test("delete + block writes the blocked key and the tombstone", async () => {
    const t = setup();
    const r = await deleteAlias(ALIAS, { block: true }, t.deps);
    expect(r.ok).toBe(true);
    expect(t.calls).toHaveLength(1);
    expect(t.calls[0].method).toBe("PUT");
    expect(decodeURIComponent(t.calls[0].url)).toContain(`/values/blocked:${ALIAS}`);
    expect(t.state.tombstones[ALIAS]).toBe(STAMP);
    expect(t.state.registry).toEqual([]);
  });

  test("delete alone never touches blocked: keys", async () => {
    const t = setup();
    const r = await deleteAlias(ALIAS, {}, t.deps);
    expect(r.ok).toBe(true);
    expect(t.calls).toEqual([]); // no PUT, no DELETE, no GET
    expect(t.state.tombstones[ALIAS]).toBe(STAMP);
  });

  test("deleting an already blocked alias leaves its blocked key alone", async () => {
    const t = setup();
    t.state.registry[0].status = "blocked";
    await deleteAlias(ALIAS, {}, t.deps);
    expect(t.calls).toEqual([]);
  });

  test("a failed block deletes nothing and writes no tombstone", async () => {
    for (const t of [setup({ status: 401 }), setup({ permitted: false })]) {
      const r = await deleteAlias(ALIAS, { block: true }, t.deps);
      expect(r.ok).toBe(false);
      expect(t.state.registry).toHaveLength(1);
      expect(t.state.tombstones).toEqual({});
    }
    expect((await deleteAlias(ALIAS, { block: true }, setup({ permitted: false }).deps)).message).toBe(PERMISSION_ERROR);
  });

  test("the pending sync after a delete pushes only the tombstone", async () => {
    const t = setup();
    await deleteAlias(ALIAS, {}, t.deps);
    const dirty = dirtyRegistry(t.state.registry, t.state.tombstones, { [ALIAS]: "2026-01-01T00:00:00.000Z" });
    expect(dirty).toHaveLength(1);
    expect(dirty[0].plain).toEqual({ alias: ALIAS, deleted: true, updated: STAMP });
  });
});
