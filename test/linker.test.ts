import { describe, expect, test } from "bun:test";
import { callHost, ensureLabels, explain, isNewTag, LinkerError, ping, syncAll } from "../src/lib/linker.js";
import { addEntry } from "../src/lib/registry.js";

const ok = (extra = {}) => async () => ({ ok: true, ...extra });

describe("linker", () => {
  test("callHost returns reply", async () => {
    expect(await callHost({ type: "ping" }, ok({ labels: 3 }))).toEqual({ ok: true, labels: 3 });
  });
  test("host error becomes LinkerError with the host's message", async () => {
    const send = async () => ({ ok: false, error: "Bridge down" });
    await expect(callHost({ type: "ping" }, send)).rejects.toThrow("Bridge down");
    await expect(callHost({ type: "ping" }, send)).rejects.toBeInstanceOf(LinkerError);
  });
  test("missing host gets an install hint", async () => {
    const send = async () => { throw new Error("Specified native messaging host not found."); };
    await expect(callHost({ type: "ping" }, send)).rejects.toThrow(/install\.sh/);
  });
  test("empty reply is an error", async () => {
    await expect(callHost({ type: "ping" }, async () => undefined)).rejects.toBeInstanceOf(LinkerError);
  });
  test("ensureLabels reports created labels and skips empty input", async () => {
    let sent: any;
    const r = await ensureLabels(["fin", "github"], async (m: any) => { sent = m; return { ok: true, created: ["fin"], existing: ["github"] }; });
    expect(sent).toEqual({ type: "ensure_labels", names: ["fin", "github"] });
    expect(r.message).toBe("Created 1 label: fin.");
    expect((await ensureLabels([], async () => { throw new Error("no call"); })).message).toBe("No labels to sync.");
  });
  test("syncAll sends every distinct tag", async () => {
    let sent: any;
    let reg = addEntry([], { alias: "github.abcde@x.com" });
    reg = addEntry(reg, { alias: "github.fghjk@x.com" });
    reg = addEntry(reg, { alias: "fin.abcde@x.com" });
    await syncAll(reg, async (m: any) => { sent = m; return { ok: true, created: [], existing: sent.names }; });
    expect(sent.names).toEqual(["fin", "github"]);
  });
  test("ping message", async () => expect(await ping(ok({ labels: 1 }))).toBe("Connected to Bridge (1 label)."));
  test("isNewTag", () => {
    const reg = addEntry([], { alias: "github.abcde@x.com" });
    expect(isNewTag(reg, "github")).toBe(false);
    expect(isNewTag(reg, "fin")).toBe(true);
  });
  test("explain falls back to message", () => expect(explain(new Error("boom"))).toBe("boom"));
});
