import { api } from "./browser.js";
import { badgeText, pendingTags } from "./labels.js";
import { getSettings, syncedLabels } from "./storage.js";

// Toolbar badge: number of tags still needing a Proton label (Manual mode only).
export async function refreshBadge() {
  try {
    const { labelMode } = await getSettings();
    const text = labelMode === "manual" ? badgeText(pendingTags(await syncedLabels()).length) : "";
    await api.action.setBadgeText({ text });
    if (text) await api.action.setBadgeBackgroundColor({ color: "#a33a2c" });
  } catch (err) {
    console.warn("Alias Maker could not update the badge:", err);
  }
}
