import { markCreated, pendingTags } from "./labels.js";

// Runs when the label mode changes. Switching to Bridge creates every label still marked
// "needs-creating" through `ensure(names)`; other switches do nothing. Never throws: a Bridge
// failure leaves the labels pending so they can be synced later.
export async function switchLabelMode({ from, to, labels, ensure }) {
  if (from === to || to !== "bridge") return { labels, ran: false, ok: true, message: "" };
  const tags = pendingTags(labels);
  if (!tags.length) return { labels, ran: false, ok: true, message: "No labels were waiting to be created." };
  try {
    const r = await ensure(tags);
    return { labels: markCreated(labels, tags), ran: true, ok: true, message: r.message };
  } catch (err) {
    return { labels, ran: true, ok: false, message: err.message || String(err) };
  }
}
