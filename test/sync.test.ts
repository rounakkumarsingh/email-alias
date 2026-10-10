import { describe, expect, test } from "bun:test";
import { syncNow, unlockVault } from "../src/lib/sync.js";
import { setStatus, setNote, addEntry } from "../src/lib/registry.js";
import { markCreated, ensureTag, reconcile } from "../src/lib/labels.js";

const IT = 1000;
const PASS = "correct horse battery";
const T = (n: number) => () => `2026-0${n}-01T00:00:00.000Z`;
const A = "shop.abcde@example.com";
const B = "fin.kkkkk@example.com";

// In-memory KV that records every call, like Cloudflare's would see them.
function memStore() {
  const data = new Map<string, string>();
  const log = { writes: [] as { key: string; value: string }[], gets: [] as string[], lists: [] as string[], bulkGets: [] as string[][] };
  return {
    data, log,
    async get(k: string) { log.gets.push(k); return data.get(k) ?? null; },
    async list(prefix: string) { log.lists.push(prefix); return [...data.keys()].filter((k) => k.startsWith(prefix)).sort(); },
    async getMany(keys: string[]) { log.bulkGets.push(keys); return Object.fromEntries(keys.filter((k) => data.has(k)).map((k) => [k, data.get(k)!])); },
    async putMany(items: { key: string; value: string }[]) { for (const i of items) { log.writes.push(i); data.set(i.key, i.value); } },
  };
}

// One simulated browser: local state + (optional) session keys.
function device(store: ReturnType<typeof memStore>) {
  const d: any = {
    keys: null,
    local: { registry: [], tombstones: {}, labels: {}, pushed: { reg: {}, lbl: {} }, lastHead: null },
    async unlock(pass = PASS, create = true) { d.keys = (await unlockVault(store, pass, { create, iterations: IT })).keys; },
    lock() { d.keys = null; },
    async sync() { const r = await syncNow({ store, keys: d.keys, local: d.local }); d.local = r.local; return r; },
    add(alias: string, now = T(1), extra: any = {}) { d.local.registry = addEntry(d.local.registry, { alias, ...extra }, now); },
    block(alias: string, now: () => string) { d.local.registry = setStatus(d.local.registry, alias, "blocked", now); },
    note(alias: string, note: string, now: () => string) { d.local.registry = setNote(d.local.registry, alias, note, now); },
    del(alias: string, now: () => string) {
      d.local.registry = d.local.registry.filter((e: any) => e.alias !== alias);
      d.local.tombstones = { ...d.local.tombstones, [alias]: now() };
    },
    aliases: () => d.local.registry.map((e: any) => e.alias).sort(),
  };
  return d;
}

describe("vault", () => {
  test("first device creates the vault, a second joins with the same passphrase", async () => {
    const s = memStore();
    await expect(unlockVault(s, PASS, { iterations: IT })).rejects.toMatchObject({ code: "no-vault" });
    expect(s.log.writes).toEqual([]);
    expect((await unlockVault(s, PASS, { create: true, iterations: IT })).created).toBe(true);
    expect((await unlockVault(s, PASS, { iterations: IT })).created).toBe(false);
  });

  test("wrong passphrase: clear error and nothing is written", async () => {
    const s = memStore();
    await unlockVault(s, PASS, { create: true, iterations: IT });
    const before = s.log.writes.length;
    await expect(unlockVault(s, "wrong", { iterations: IT })).rejects.toMatchObject({ code: "wrong-passphrase", message: expect.stringMatching(/Wrong sync passphrase/) });
    await expect(unlockVault(s, "wrong", { create: true, iterations: IT })).rejects.toMatchObject({ code: "wrong-passphrase" });
    expect(s.log.writes.length).toBe(before);
  });
});

describe("vault under Cloudflare's eventual consistency", () => {
  // Reads of sync:meta return nothing for a while after it is written (stale / negatively cached).
  function staleMeta(s: ReturnType<typeof memStore>) {
    let wrote = false;
    return {
      ...s,
      get: async (k: string) => (k === "sync:meta" && wrote ? null : s.get(k)),
      putMany: async (items: any[]) => { if (items.some((i) => i.key === "sync:meta")) wrote = true; return s.putMany(items); },
    };
  }

  test("a stale read right after creating the vault does not break creation", async () => {
    const s = memStore();
    const r = await unlockVault(staleMeta(s), PASS, { create: true, iterations: IT });
    expect(r.created).toBe(true);
    expect(s.data.has("sync:meta")).toBe(true);
    // Once the write has propagated, another browser opens the same vault with the same keys.
    const again = await unlockVault(s, PASS, { iterations: IT });
    expect(again.keys.raw).toBe(r.keys.raw);
  });

  test("create is refused, and writes nothing, when synced data exists but meta can't be read", async () => {
    const s = memStore();
    const a = device(s); await a.unlock(); a.add(A); await a.sync();
    const metaHidden = { ...s, get: async (k: string) => (k === "sync:meta" ? null : s.get(k)) };
    const metaBefore = s.data.get("sync:meta");
    s.log.writes.length = 0;
    await expect(unlockVault(metaHidden, PASS, { create: true, iterations: IT })).rejects.toMatchObject({ code: "vault-unreadable", message: expect.stringMatching(/Wait a minute/) });
    expect(s.log.writes).toEqual([]);
    expect(s.data.get("sync:meta")).toBe(metaBefore);
  });

  test("the no-vault message tells you to wait if you just set it up elsewhere", async () => {
    await expect(unlockVault(memStore(), PASS, { iterations: IT })).rejects.toMatchObject({ code: "no-vault", message: expect.stringMatching(/wait a minute/) });
  });

  test("two browsers creating at once: the one stored wins and the other adopts it", async () => {
    const s = memStore();
    const other = await unlockVault(s, "shared pass", { create: true, iterations: IT }); // already stored by the other browser
    const theirMeta = s.data.get("sync:meta")!;
    // Our create sees nothing, writes, then reads back THEIR meta (theirs landed last).
    const racing = {
      ...s,
      get: async (k: string) => (k === "sync:meta" && racing.step++ === 0 ? null : k === "sync:meta" ? theirMeta : s.get(k)),
      putMany: async () => {},
      step: 0,
    };
    const mine = await unlockVault(racing as any, "shared pass", { create: true, iterations: IT });
    expect(mine.created).toBe(false);
    expect(mine.keys.raw).toBe(other.keys.raw);
    racing.step = 0;
    await expect(unlockVault(racing as any, "different", { create: true, iterations: IT })).rejects.toMatchObject({ code: "wrong-passphrase" });
  });
});

describe("sync", () => {
  test("a second browser receives what the first pushed", async () => {
    const s = memStore();
    const a = device(s), b = device(s);
    await a.unlock(); a.add(A, T(1), { site: "shop.com", note: "n" }); a.add(B);
    await a.sync();
    await b.unlock(PASS, false);
    const r = await b.sync();
    expect(r.applied).toBe(true);
    expect(b.aliases()).toEqual([A, B].sort());
    expect(b.local.registry.find((e: any) => e.alias === A)).toMatchObject({ site: "shop.com", note: "n" });
    expect(r.wrote).toBe(0); // nothing echoed back
  });

  test("conflicting edits: the later one wins on both browsers", async () => {
    const s = memStore();
    const a = device(s), b = device(s);
    await a.unlock(); a.add(A); await a.sync();
    await b.unlock(PASS, false); await b.sync();
    a.note(A, "from A", T(2));
    b.note(A, "from B", T(3));
    await a.sync(); await b.sync(); await a.sync();
    expect(a.local.registry[0].note).toBe("from B");
    expect(b.local.registry[0].note).toBe("from B");
  });

  test("a delete propagates as a tombstone, and the tombstone is encrypted", async () => {
    const s = memStore();
    const a = device(s), b = device(s);
    await a.unlock(); a.add(A); await a.sync();
    await b.unlock(PASS, false); await b.sync();
    a.del(A, T(2)); await a.sync();
    await b.sync();
    expect(b.aliases()).toEqual([]);
    expect(b.local.tombstones[A]).toBe(T(2)());
    // The tombstone replaces the entry under the same opaque id: meta, head and one reg: blob.
    expect([...s.data.keys()].filter((k) => k.startsWith("reg:"))).toHaveLength(1);
    expect(s.data.size).toBe(3);
  });

  test("an edit made after the delete resurrects the alias", async () => {
    const s = memStore();
    const a = device(s), b = device(s);
    await a.unlock(); a.add(A, T(1)); await a.sync();
    await b.unlock(PASS, false); await b.sync();
    a.del(A, T(2)); await a.sync();
    b.note(A, "still using it", T(3));
    await b.sync(); await a.sync();
    expect(a.aliases()).toEqual([A]);
    expect(b.aliases()).toEqual([A]);
  });

  test("only changed records are written; an unchanged sync costs one read", async () => {
    const s = memStore();
    const a = device(s);
    await a.unlock(); a.add(A); a.add(B); await a.sync();
    await a.sync(); // pulls once (head moved by our own push)
    s.log.writes.length = 0; s.log.gets.length = 0; s.log.lists.length = 0; s.log.bulkGets.length = 0;
    const idle = await a.sync();
    expect(idle.wrote).toBe(0);
    expect(s.log.gets).toEqual(["sync:head"]);
    expect(s.log.lists).toEqual([]);
    a.note(A, "x", T(2));
    const one = await a.sync();
    expect(one.wrote).toBe(2); // the one entry + sync:head
    expect(s.log.writes.map((w) => w.key).filter((k) => k !== "sync:head")).toHaveLength(1);
  });

  test("labels sync; an auto-added default never overrides a real status", async () => {
    const s = memStore();
    const a = device(s), b = device(s);
    await a.unlock(); a.local.labels = markCreated(reconcile({}, [], ["fin"]), ["fin"], T(2)); await a.sync();
    await b.unlock(PASS, false);
    b.local.labels = reconcile({}, [], ["fin", "govt"]); // defaults on a fresh browser
    await b.sync();
    expect(b.local.labels.fin.status).toBe("created");
    expect(b.local.labels.govt.status).toBe("needs-creating");
    expect([...s.data.keys()].filter((k) => k.startsWith("lbl:"))).toHaveLength(1); // defaults aren't pushed
  });

  test("unreadable remote data is never overwritten", async () => {
    const s = memStore();
    const a = device(s);
    await a.unlock(); a.add(A); await a.sync();
    // Corrupt one remote blob, then sync a device that has local changes.
    const regKey = [...s.data.keys()].find((k) => k.startsWith("reg:"))!;
    s.data.set(regKey, "garbage");
    const b = device(s);
    b.keys = a.keys; b.add(B, T(2));
    s.log.writes.length = 0;
    const r = await b.sync();
    expect(r.ok).toBe(false);
    expect(r.unreadable).toBe(1);
    expect(s.log.writes).toEqual([]);
    expect(s.data.get(regKey)).toBe("garbage");
    expect(b.aliases()).toEqual([B]); // local data kept
  });
});

describe("locked mode", () => {
  test("locked sync touches nothing and reports what is queued", async () => {
    const s = memStore();
    const a = device(s); a.add(A); a.add(B);
    const r = await a.sync();
    expect(r.skipped).toBe("locked");
    expect(r.pending).toBe(2);
    expect(s.log.gets.length + s.log.lists.length + s.log.writes.length).toBe(0);
  });

  test("create, block, note and delete made while locked are all pushed after unlock", async () => {
    const s = memStore();
    const a = device(s), b = device(s);
    await a.unlock(); a.add(A, T(1)); a.add(B, T(1)); await a.sync();
    await b.unlock(PASS, false); await b.sync();
    b.lock();
    b.add("gov.mmmmm@example.com", T(2));
    b.block(A, T(2));
    b.del(B, T(2));
    expect((await b.sync()).skipped).toBe("locked");
    await b.unlock(PASS, false);
    const r = await b.sync();
    expect(r.ok).toBe(true);
    await a.sync();
    expect(a.aliases()).toEqual([A, "gov.mmmmm@example.com"].sort());
    expect(a.local.registry.find((e: any) => e.alias === A).status).toBe("blocked");
    expect(a.local.tombstones[B]).toBe(T(2)());
  });

  test("a delete made while locked keeps its time: a later edit elsewhere still wins", async () => {
    const s = memStore();
    const a = device(s), b = device(s);
    await a.unlock(); a.add(A, T(1)); await a.sync();
    await b.unlock(PASS, false); await b.sync();
    b.lock(); b.del(A, T(2));
    a.note(A, "kept", T(3)); await a.sync();
    await b.unlock(PASS, false); await b.sync(); // unlocking days later
    expect(b.aliases()).toEqual([A]);
    expect(b.local.registry[0].note).toBe("kept");
  });
});

describe("what Cloudflare sees", () => {
  test("no plaintext alias, tag, site, note or label name in any key or value written or read", async () => {
    const s = memStore();
    const a = device(s);
    await a.unlock();
    a.add(A, T(1), { site: "secretsite.com", note: "very private note" });
    a.add(B);
    a.local.labels = ensureTag(a.local.labels, "shop", T(1));
    a.del(B, T(2));
    await a.sync();
    const b = device(s); await b.unlock(PASS, false); await b.sync();

    const everything = [...s.log.writes.flatMap((w) => [w.key, w.value]), ...s.log.gets, ...s.log.lists, ...s.log.bulkGets.flat(), ...s.data.keys(), ...s.data.values()].join("\n");
    for (const secret of ["shop", "fin", "abcde", "kkkkk", "example.com", "secretsite", "very private", "active"]) {
      expect(everything).not.toContain(secret);
    }
    for (const w of s.log.writes) expect(w.key).toMatch(/^(reg:[0-9a-f]{32}|lbl:[0-9a-f]{32}|sync:meta|sync:head)$/);
  });

  test("sync never reads or writes blocked: keys", async () => {
    const s = memStore();
    s.data.set("blocked:" + A, "1");
    const a = device(s); await a.unlock(); a.add(A); a.block(A, T(2)); await a.sync();
    const touched = [...s.log.writes.map((w) => w.key), ...s.log.gets, ...s.log.lists, ...s.log.bulkGets.flat()];
    expect(touched.some((k) => k.startsWith("blocked:"))).toBe(false);
    expect(s.data.get("blocked:" + A)).toBe("1");
  });
});
