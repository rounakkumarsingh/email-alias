import { api } from "./browser.js";
import { tagsOf } from "./registry.js";

export const HOST_NAME = "com.rounakkumarsingh.alias_maker";

export class LinkerError extends Error {}

// Turns browser/host failures into a single readable line.
export function explain(err) {
  const msg = String(err?.message || err || "");
  if (/not found|no such native|Specified native messaging host/i.test(msg)) {
    return "Native host not installed. Run native/install.sh and restart the browser.";
  }
  if (/forbidden|access to the specified native messaging host/i.test(msg)) {
    return "The browser is not allowed to use the host. Re-run native/install.sh.";
  }
  if (/exited|disconnected|closed/i.test(msg)) {
    return "The native host stopped unexpectedly. Check that python3 is installed.";
  }
  return msg || "Could not reach the native host.";
}

const defaultSend = (message) => api.runtime.sendNativeMessage(HOST_NAME, message);

// Sends one request; returns the reply or throws LinkerError with a readable message.
export async function callHost(message, send = defaultSend) {
  let reply;
  try {
    reply = await send(message);
  } catch (err) {
    throw new LinkerError(explain(err));
  }
  if (!reply || reply.ok !== true) throw new LinkerError(reply?.error || "The host returned an unexpected reply.");
  return reply;
}

export async function ping(send) {
  const r = await callHost({ type: "ping" }, send);
  return `Connected to Bridge (${r.labels} label${r.labels === 1 ? "" : "s"}).`;
}

// Ensures labels exist and describes the outcome in one line.
export async function ensureLabels(names, send) {
  if (!names.length) return { created: [], existing: [], message: "No labels to sync." };
  const r = await callHost({ type: "ensure_labels", names }, send);
  const message = r.created.length
    ? `Created ${r.created.length} label${r.created.length === 1 ? "" : "s"}: ${r.created.join(", ")}.`
    : "All labels already exist in Proton.";
  return { created: r.created, existing: r.existing, message };
}

export function syncAll(registry, send) {
  return ensureLabels(tagsOf(registry), send);
}

// True when this alias is the first one ever to use its tag.
export function isNewTag(registryBefore, tag) {
  return !registryBefore.some((e) => e.tag === tag);
}
