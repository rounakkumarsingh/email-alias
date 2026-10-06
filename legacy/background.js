importScripts("alias.js");

chrome.runtime.onInstalled.addListener(() => {
  chrome.contextMenus.create({
    id: "alias-fill",
    title: "Fill new alias for this site",
    contexts: ["editable"],
  });
});

chrome.contextMenus.onClicked.addListener(async (info, tab) => {
  if (info.menuItemId !== "alias-fill" || !tab || tab.id === undefined) return;

  const settings = await getSettings();
  let host = "";
  try {
    host = new URL(tab.url).hostname;
  } catch (_) {
    // Pages without a normal URL keep the fallback tag.
  }

  const tag = tagFromHost(host) || "site";
  const alias = buildAlias(tag, randomPart(settings.length), settings.domain);

  try {
    if (await fillInTab(tab.id, alias, info.frameId)) await remember(alias, host);
  } catch (err) {
    console.warn("Alias Maker could not fill this field:", err);
  }
});
