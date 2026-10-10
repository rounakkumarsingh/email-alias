import { describe, expect, test } from "bun:test";
import { decide } from "../worker/src/route.js";
import { handle, REJECT_MESSAGE } from "../worker/src/index.js";
import { buildAlias, MAX_TAG, parseAlias, randomPart } from "../src/lib/alias.js";

const ENV = {
  DOMAIN: "example.com",
  DESTINATION: "me@proton.me",
  FIXED: "hello@example.com, Rounak@example.com",
};

describe("decide", () => {
  for (const to of ["hello@example.com", "HELLO@Example.COM", "rounak@example.com", "ROUNAK@EXAMPLE.COM"]) {
    test(`fixed address ${to}`, () => expect(decide(to, ENV).action).toBe("fixed"));
  }

  test("valid alias", () => {
    expect(decide("github.x7k2qf@example.com", ENV)).toEqual({ action: "alias", alias: "github.x7k2qf@example.com", tag: "github" });
  });
  test("uppercase alias is normalised", () => {
    expect(decide("GitHub.X7K2QF@Example.com", ENV)).toEqual({ action: "alias", alias: "github.x7k2qf@example.com", tag: "github" });
  });
  test("hyphenated tag and boundary lengths", () => {
    expect(decide("my-shop.abcde@example.com", ENV).tag).toBe("my-shop");
    expect(decide(`${"a".repeat(24)}.${"b".repeat(12)}@example.com`, ENV).action).toBe("alias");
  });

  const malformed = [
    "nodot@example.com",
    "tag.abcd@example.com", // random too short
    `tag.${"a".repeat(13)}@example.com`, // random too long
    `${"a".repeat(25)}.abcde@example.com`, // tag too long
    ".abcde@example.com", // empty tag
    "tag.@example.com",
    "a.b.abcde@example.com", // extra dot
    "tag_x.abcde@example.com",
    "tag.abcde@other.com", // wrong domain
    "tag.abcde@sub.example.com",
    "tag.abcde@",
    "@example.com",
    "",
    "unknown@example.com", // unknown fixed address
    "tag.abcde@example.com@example.com",
  ];
  for (const to of malformed) {
    test(`rejects ${JSON.stringify(to)}`, () => expect(decide(to, ENV).action).toBe("reject"));
  }

  const plus = ["tag.abcde+x@example.com", "hello+x@example.com", "tag+x.abcde@example.com", "rounak+news@example.com"];
  for (const to of plus) {
    test(`rejects plus-addressing ${to}`, () => expect(decide(to, ENV).action).toBe("reject"));
  }

  test("rejects everything when DOMAIN is unset", () => {
    expect(decide("hello@example.com", { FIXED: ENV.FIXED }).action).toBe("reject");
    expect(decide("tag.abcde@example.com", { FIXED: ENV.FIXED }).action).toBe("reject");
  });

  test("agrees with the extension's alias generator", () => {
    for (let len = 5; len <= 12; len++) {
      const alias = buildAlias("shop", randomPart(len), "example.com");
      expect(parseAlias(alias)).not.toBeNull();
      expect(decide(alias, ENV).action).toBe("alias");
    }
    expect(MAX_TAG).toBe(24);
  });
});

// ---- handler ----

function fakeMessage(to: string, opts: { forwardError?: Error } = {}) {
  const calls = { forward: [] as any[], reject: [] as string[] };
  return {
    calls,
    message: {
      to,
      from: "sender@gmail.com",
      // Reading any of these would be a privacy bug: tests below assert they stay untouched.
      get raw(): never { throw new Error("raw must not be read"); },
      get headers(): never { throw new Error("headers must not be read"); },
      setReject: (r: string) => void calls.reject.push(r),
      forward: async (to: string, headers?: Headers) => {
        if (opts.forwardError) throw opts.forwardError;
        calls.forward.push({ to, headers });
      },
    },
  };
}

const kv = (blocked: string[] = []) => ({ get: async (k: string) => (blocked.includes(k) ? "1" : null) });
const run = async (to: string, env: any, opts: any = {}) => {
  const logs: any[] = [];
  const f = fakeMessage(to, opts);
  let error: unknown;
  try {
    await handle(f.message, env, { log: (s: string) => logs.push(JSON.parse(s)), now: () => "T" });
  } catch (e) {
    error = e;
  }
  return { ...f.calls, logs, error };
};

describe("handle", () => {
  test("fixed address is forwarded unchanged, no extra headers", async () => {
    const r = await run("HELLO@example.com", { ...ENV, BLOCKLIST: kv() });
    expect(r.forward).toHaveLength(1);
    expect(r.forward[0].to).toBe("me@proton.me");
    expect(r.forward[0].headers).toBeUndefined();
    expect(r.logs).toEqual([{ ts: "T", alias: "hello@example.com", tag: null, action: "forward" }]);
  });

  test("valid alias is forwarded with X-Alias-Tag and X-Alias", async () => {
    const r = await run("Shop.ABCDE@example.com", { ...ENV, BLOCKLIST: kv() });
    expect(r.reject).toEqual([]);
    expect(r.forward[0].headers.get("X-Alias-Tag")).toBe("shop");
    expect(r.forward[0].headers.get("X-Alias")).toBe("shop.abcde@example.com");
    expect(r.logs).toEqual([{ ts: "T", alias: "shop.abcde@example.com", tag: "shop", action: "tag" }]);
  });

  test("blocked alias is rejected with the generic message and never forwarded", async () => {
    const r = await run("shop.abcde@example.com", { ...ENV, BLOCKLIST: kv(["blocked:shop.abcde@example.com"]) });
    expect(r.reject).toEqual([REJECT_MESSAGE]);
    expect(r.forward).toEqual([]);
    expect(r.logs[0].action).toBe("blocked");
  });

  test("blocked, malformed and unknown addresses get the same message", async () => {
    const env = { ...ENV, BLOCKLIST: kv(["blocked:shop.abcde@example.com"]) };
    const messages = new Set<string>();
    for (const to of ["shop.abcde@example.com", "nodot@example.com", "unknown@example.com", "x.y@other.com"]) {
      const r = await run(to, env);
      expect(r.forward).toEqual([]);
      for (const m of r.reject) messages.add(m);
    }
    expect([...messages]).toEqual(["Address not accepted"]);
  });

  test("KV read failure fails open, still tagged, logged as kv_error", async () => {
    const BLOCKLIST = { get: async () => { throw new Error("KV down"); } };
    const r = await run("shop.abcde@example.com", { ...ENV, BLOCKLIST });
    expect(r.reject).toEqual([]);
    expect(r.forward[0].headers.get("X-Alias-Tag")).toBe("shop");
    expect(r.logs[0].action).toBe("kv_error");
  });

  test("forward() failure rethrows and never calls setReject (sender retries)", async () => {
    const boom = new Error("forward failed");
    for (const to of ["shop.abcde@example.com", "hello@example.com"]) {
      const r = await run(to, { ...ENV, BLOCKLIST: kv() }, { forwardError: boom });
      expect(r.error).toBe(boom);
      expect(r.reject).toEqual([]);
      expect(r.logs[0].action).toBe("error");
    }
  });

  test("missing DESTINATION is an internal error, not a permanent reject", async () => {
    const r = await run("hello@example.com", { DOMAIN: ENV.DOMAIN, FIXED: ENV.FIXED, BLOCKLIST: kv() });
    expect(r.error).toBeInstanceOf(Error);
    expect(r.reject).toEqual([]);
  });

  test("logs contain only ts, alias, tag and action; raw and headers are never read", async () => {
    const r = await run("shop.abcde@example.com", { ...ENV, BLOCKLIST: kv() });
    expect(r.error).toBeUndefined();
    for (const l of r.logs) expect(Object.keys(l).sort()).toEqual(["action", "alias", "tag", "ts"]);
  });
});
