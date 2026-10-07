import { api } from "./lib/browser.js";
import { buildAlias, randomPart, tagFromHost } from "./lib/alias.js";
import { fillInTab } from "./lib/fill.js";
import { getSettings } from "./lib/storage.js";
import { recordAlias } from "./lib/record.js";

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
