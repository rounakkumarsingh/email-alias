const $ = (id) => document.getElementById(id);

let settings = DEFAULTS;
let host = "";
let rand = "";

function currentTag() {
  return sanitizeTag($("tag").value);
}

function currentAlias() {
  const tag = currentTag();
  return tag ? buildAlias(tag, rand, settings.domain) : "";
}

function render() {
  const tag = currentTag();
  const preview = $("preview");
  preview.classList.toggle("empty", !tag);
  preview.querySelector(".p-tag").textContent = tag || "tag";
  preview.querySelector(".p-rand").textContent = rand;
  preview.querySelector(".p-domain").textContent = "@" + settings.domain;
  $("rand").textContent = rand;
  $("fill").disabled = !tag;
  $("copy").disabled = !tag;
}

function say(message, kind = "ok") {
  const status = $("status");
  status.textContent = message;
  status.dataset.kind = kind;
}

async function renderRecent() {
  const { recent = [] } = await chrome.storage.local.get("recent");
  const list = $("recent");
  list.replaceChildren();
  if (recent.length === 0) {
    const li = document.createElement("li");
    li.className = "empty-note";
    li.textContent = "Aliases you fill or copy show up here.";
    list.append(li);
    return;
  }
  for (const item of recent) {
    const li = document.createElement("li");
    const btn = document.createElement("button");
    btn.type = "button";
    btn.title = "Copy " + item.alias;
    const addr = document.createElement("span");
    addr.className = "addr";
    addr.textContent = item.alias;
    const site = document.createElement("span");
    site.className = "site";
    site.textContent = (item.site || "").replace(/^www\./, "");
    btn.append(addr, site);
    btn.addEventListener("click", async () => {
      await navigator.clipboard.writeText(item.alias);
      say("Copied " + item.alias);
    });
    li.append(btn);
    list.append(li);
  }
}

async function copyAlias() {
  const alias = currentAlias();
  if (!alias) return;
  await navigator.clipboard.writeText(alias);
  await remember(alias, host);
  say("Copied. Paste it into the signup form.");
  renderRecent();
}

async function fillAlias() {
  const alias = currentAlias();
  if (!alias) return;
  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });

  try {
    if (await fillInTab(tab.id, alias)) {
      await remember(alias, host);
      say("Filled. 1Password will offer to save the login when you sign up.");
      renderRecent();
      return;
    }
    await navigator.clipboard.writeText(alias);
    await remember(alias, host);
    say("No email field found on this page. Alias copied instead.", "err");
  } catch (_) {
    await navigator.clipboard.writeText(alias);
    await remember(alias, host);
    say("This page can't be filled. Alias copied instead.", "err");
  }
  renderRecent();
}

async function copyBlockRule() {
  const value = $("block-input").value.trim();
  if (!isAlias(value)) {
    say("Paste a full alias, like github.x7k2qf@" + settings.domain, "err");
    return;
  }
  await navigator.clipboard.writeText(blockRule(value));
  say("Rule copied. Paste it at the top of your mail filters.");
}

async function init() {
  settings = await getSettings();
  rand = randomPart(settings.length);

  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  try {
    const url = new URL(tab.url);
    if (url.protocol === "http:" || url.protocol === "https:") host = url.hostname;
  } catch (_) {
    host = "";
  }

  const tagInput = $("tag");
  tagInput.value = tagFromHost(host);
  render();
  renderRecent();
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
  $("block-copy").addEventListener("click", copyBlockRule);
  $("open-options").addEventListener("click", (e) => {
    e.preventDefault();
    chrome.runtime.openOptionsPage();
  });
}

init();
