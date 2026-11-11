import { blockKey, decide, fixedKey, isOwnAddress } from "./route.js";

// One generic message for every rejection, so a sender can't tell a blocked alias from one that never existed.
export const REJECT_MESSAGE = "Address not accepted";

// Logs only the alias, tag, action and a timestamp. Never touches message.raw, the subject or the body.
function logEvent(log, now, { alias, tag, action }) {
  log(JSON.stringify({ ts: now(), alias: String(alias).slice(0, 120), tag, action }));
}

export async function handle(message, env, { log = console.log, now = () => new Date().toISOString() } = {}) {
  const d = decide(message.to, env);
  const record = (action) => logEvent(log, now, { alias: d.alias, tag: d.tag, action });

  // Forward failures and missing config are not the sender's fault, so they must not be a permanent
  // reject: log and rethrow so the invocation fails and the sender can retry.
  const forward = async (headers, action) => {
    try {
      if (!env.DESTINATION) throw new Error("DESTINATION is not configured");
      await message.forward(env.DESTINATION, headers);
      record(action);
    } catch (err) {
      record("error");
      throw err;
    }
  };

  if (d.action === "reject") {
    // Fixed addresses pushed from the extension live in KV as fixed:<address>. Only a rejected address
    // on our own domain is looked up, so valid tag.random aliases and foreign domains cost no extra read.
    if (isOwnAddress(d.alias, env)) {
      let isFixed = false;
      let kvError = false;
      try {
        isFixed = (await env.BLOCKLIST.get(fixedKey(d.alias))) !== null;
      } catch {
        // Fail closed: never forward an address we could not confirm.
        kvError = true;
      }
      if (isFixed) return forward(undefined, "forward");
      message.setReject(REJECT_MESSAGE);
      record(kvError ? "kv_error" : "reject");
      return;
    }
    message.setReject(REJECT_MESSAGE);
    record("reject");
    return;
  }

  if (d.action === "fixed") return forward(undefined, "forward");

  let action = "tag";
  let blocked = false;
  try {
    blocked = (await env.BLOCKLIST.get(blockKey(d.alias))) !== null;
  } catch {
    // KV is down or unbound: fail open so real mail is never lost because of the blocklist.
    action = "kv_error";
  }
  if (blocked) {
    message.setReject(REJECT_MESSAGE);
    record("blocked");
    return;
  }

  // forward() only accepts X- headers, so the tag travels as a header instead of a subject prefix.
  return forward(new Headers({ "X-Alias-Tag": d.tag, "X-Alias": d.alias }), action);
}

export default {
  async email(message, env) {
    await handle(message, env);
  },
};
