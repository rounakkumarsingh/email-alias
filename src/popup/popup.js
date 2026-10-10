import { api } from "../lib/browser.js";
import { buildAlias, randomPart, sanitizeTag, tagFromHost } from "../lib/alias.js";
import { fillInTab } from "../lib/fill.js";
import { search, setStatus } from "../lib/registry.js";
import { getLabels, getRegistry, getSettings, saveLabels, saveRegistry, syncedLabels } from "../lib/storage.js";
import { markCreated, NEEDS } from "../lib/labels.js";
import { recordAlias } from "../lib/record.js";
import { sieveState } from "../lib/sieve-state.js";
import { setAliasBlocked } from "../lib/blocklist.js";

const $ = (id) => document.getElementById(id);

let settings;
let host = "";
let rand = "";

const currentTag = () => sanitizeTag($("tag").value);
const currentAlias = () => (currentTag() ? buildAlias(currentTag(), rand, settings.domain) : "");

function say(message, kind = "ok") {
  $("status").textContent = message;
  $("status").dataset.kind = kind;
}

function render() {
  const tag = currentTag();
  $("preview").classList.toggle("empty", !tag);
  document.querySelector(".p-tag").textContent = tag || "tag";
  document.querySelector(".p-rand").textContent = rand;
  document.querySelector(".p-domain").textContent = "@" + settings.domain;
  $("rand").textContent = rand;
  $("fill").disabled = !tag;
  $("copy").disabled = !tag;
}

async function renderList() {
  const registry = await getRegistry();
  const items = search(registry, $("search").value);
  const list = $("list");
  list.replaceChildren();
  if (items.length === 0) {
    const li = document.createElement("li");
    li.className = "empty-note";
    li.textContent = registry.length ? "No matches." : "Aliases you fill or copy show up here.";
    list.append(li);
  }
  for (const e of items.slice(0, 50)) {
    const li = document.createElement("li");
    li.className = e.status;

    const copy = document.createElement("button");
    copy.type = "button";
    copy.className = "copy";
    copy.title = "Copy " + e.alias;
    const addr = document.createElement("span");
    addr.className = "addr";
    addr.textContent = e.alias;
    const site = document.createElement("span");
    site.className = "site";
    site.textContent = e.site;
    copy.append(addr, site);
    copy.addEventListener("click", async () => {
      await navigator.clipboard.writeText(e.alias);
      say("Copied " + e.alias);
    });

    const block = document.createElement("button");
    block.type = "button";
    block.className = "small";
    const blocked = e.status === "blocked";
    block.textContent = blocked ? "Unblock" : "Block";
    block.setAttribute("aria-label", `${block.textContent} ${e.alias}`);
    block.addEventListener("click", async () => {
      const r = await setAliasBlocked(e.alias, !blocked);
      if (!r.ok) return say(r.message, "err");
      await saveRegistry(setStatus(await getRegistry(), e.alias, blocked ? "active" : "blocked"));
      say(r.synced ? r.message : blocked ? "Unblocked." : "Blocked. Copy the updated filter script from Registry & settings.");
      await renderList();
      await renderStale();
    });

    li.append(copy, block);
    list.append(li);
  }
}

async function renderStale() {
  const s = await sieveState();
  $("stale").hidden = !s.stale || s.neverCopied;
}

// Manual mode: remind the user to create the Proton label for a tag that still needs one.
async function showLabelNotice(tag) {
  const notice = $("label-notice");
  notice.hidden = true;
  if (!tag || settings.labelMode !== "manual") return;
  const labels = await syncedLabels();
  if (labels[tag]?.status !== NEEDS) return;
  $("notice-tag").textContent = tag;
  notice.dataset.tag = tag;
  notice.hidden = false;
}

async function copyAlias() {
  const alias = currentAlias();
  if (!alias) return;
  await navigator.clipboard.writeText(alias);
  await recordAlias(alias, host);
  say("Copied. Paste it into the signup form.");
  await renderList();
  await showLabelNotice(currentTag());
}

async function fillAlias() {
  const alias = currentAlias();
  if (!alias) return;
  const [tab] = await api.tabs.query({ active: true, currentWindow: true });
  try {
    if (await fillInTab(tab.id, alias)) {
      await recordAlias(alias, host);
      say("Filled. 1Password will offer to save the login when you sign up.");
      await renderList();
      await showLabelNotice(currentTag());
      return;
    }
    await navigator.clipboard.writeText(alias);
    await recordAlias(alias, host);
    say("No email field found on this page. Alias copied instead.", "err");
  } catch {
    await navigator.clipboard.writeText(alias);
    await recordAlias(alias, host);
    say("This page can't be filled. Alias copied instead.", "err");
  }
  await renderList();
  await showLabelNotice(currentTag());
}

async function init() {
  settings = await getSettings();
  rand = randomPart(settings.length);

  try {
    const [tab] = await api.tabs.query({ active: true, currentWindow: true });
    const url = new URL(tab.url);
    if (url.protocol === "http:" || url.protocol === "https:") host = url.hostname;
  } catch {
    host = "";
  }

  const tagInput = $("tag");
  tagInput.value = tagFromHost(host);

  for (const cat of settings.categories) {
    const b = document.createElement("button");
    b.type = "button";
    b.className = "chip";
    b.textContent = cat;
    b.addEventListener("click", () => {
      tagInput.value = cat;
      render();
      tagInput.focus();
    });
    $("chips").append(b);
  }

  render();
  await renderList();
  await renderStale();
  tagInput.focus();
  tagInput.select();

  tagInput.addEventListener("input", render);
  tagInput.addEventListener("keydown", (e) => {
    if (e.key === "Enter") fillAlias();
  });
  $("regen").addEventListener("click", () => {
    rand = randomPart(settings.length);
    render();
  });
  $("fill").addEventListener("click", fillAlias);
  $("copy").addEventListener("click", copyAlias);
  $("search").addEventListener("input", renderList);
  $("notice-copy").addEventListener("click", async () => {
    await navigator.clipboard.writeText($("label-notice").dataset.tag);
    say("Label name copied.");
  });
  $("notice-done").addEventListener("click", async () => {
    const tag = $("label-notice").dataset.tag;
    await saveLabels(markCreated(await getLabels(), [tag]));
    $("label-notice").hidden = true;
    say(`Marked "${tag}" as created.`);
  });
  for (const id of ["open-options", "stale"]) {
    $(id).addEventListener("click", (e) => {
      e.preventDefault();
      api.runtime.openOptionsPage();
    });
  }
}

init();
