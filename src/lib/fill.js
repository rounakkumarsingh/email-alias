import { api } from "./browser.js";

// Injected into the page. Must stay self-contained (no outside references).
export function fillEmailField(value, allowSearch) {
  const usable = (el) =>
    el && el.tagName === "INPUT" && !el.disabled && !el.readOnly &&
    ["email", "text", ""].includes((el.getAttribute("type") || "").toLowerCase());

  let el = document.activeElement;
  if (!usable(el)) {
    if (!allowSearch) return false;
    el = document.querySelector('input[type="email"]:not([disabled]):not([readonly])') ||
      Array.from(document.querySelectorAll("input")).find((i) =>
        usable(i) &&
        /mail/i.test([i.name, i.id, i.autocomplete, i.placeholder].join(" ")));
  }
  if (!el) return false;

  // Use the native setter so React/Vue-style forms register the change.
  const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value").set;
  setter.call(el, value);
  el.dispatchEvent(new Event("input", { bubbles: true }));
  el.dispatchEvent(new Event("change", { bubbles: true }));
  el.focus();
  return true;
}

// Tries the focused field in every frame first, then searches the target frame.
export async function fillInTab(tabId, value, frameId) {
  const target = frameId === undefined ? { tabId, allFrames: true } : { tabId, frameIds: [frameId] };
  const first = await api.scripting.executeScript({ target, func: fillEmailField, args: [value, false] });
  if (first.some((r) => r.result)) return true;

  const second = await api.scripting.executeScript({
    target: { tabId, frameIds: [frameId ?? 0] },
    func: fillEmailField,
    args: [value, true],
  });
  return second.some((r) => r.result);
}
