import { api } from "./lib/browser.js";
import { buildAlias, randomPart, tagFromHost } from "./lib/alias.js";
import { fillInTab } from "./lib/fill.js";
import { getSettings } from "./lib/storage.js";
import { recordAlias } from "./lib/record.js";
import { refreshBadge } from "./lib/badge.js";
import { runSync } from "./lib/syncrunner.js";

const MENU_ID = "alias-fill";

api.runtime.onInstalled.addListener(() => {
  api.contextMenus.create({
    id: MENU_ID,
    title: "Fill new alias for this site",
    contexts: ["editable"],
  });
});

api.contextMenus.onClicked.addListener(async (info, tab) => {
  if (info.menuItemId !== MENU_ID || !tab || tab.id === undefined) return;

  const settings = await getSettings();
  let host = "";
  try {
    host = new URL(tab.url).hostname;
  } catch {
    // Pages without a normal URL keep the fallback tag.
  }

  const alias = buildAlias(tagFromHost(host) || "site", randomPart(settings.length), settings.domain);

  try {
    if (await fillInTab(tab.id, alias, info.frameId)) await recordAlias(alias, host);
  } catch (err) {
    console.warn("Alias Maker could not fill this field:", err);
  }
});

// Keep the badge in step with labels, registry and settings, whichever page changed them.
api.storage.onChanged.addListener((changes, area) => {
  if (changes.labels || changes.registry || changes.labelMode || changes.categories) refreshBadge();
});

// Sync a few seconds after any local change. Changes made while sync is locked stay queued and go out after unlock.
let syncTimer;
function syncSoon(delay = 3000) {
  clearTimeout(syncTimer);
  syncTimer = setTimeout(async () => {
    try {
      const r = await runSync();
      if (r && r.retry) syncSoon(1000);
    } catch (err) {
      console.warn("Alias Maker sync failed:", err);
    }
  }, delay);
}
api.storage.onChanged.addListener((changes, area) => {
  if (area === "local" && (changes.registry || changes.tombstones || changes.labels)) syncSoon();
});

api.runtime.onStartup.addListener(refreshBadge);
refreshBadge();
