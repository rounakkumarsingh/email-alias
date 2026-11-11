import { exportRegistry, mergeRegistry, parseImport, search, setNote, setStatus, tagsOf } from "../lib/registry.js";
import { validateSettings } from "../lib/settings.js";
import { getCfToken, getLabels, getLinkerStatus, getRegistry, getSettings, saveLabels, saveRegistry, saveSettings, setCfToken, setLinkerStatus, syncedLabels } from "../lib/storage.js";
import { api } from "../lib/browser.js";
import { hasPermission, isConfigured, requestPermission, testConnection } from "../lib/cloudflare.js";
import { blocklistConfigured, deleteAlias, pushFixed, setAliasBlocked } from "../lib/blocklist.js";
import { disableSync, lock, runSync, syncStatus, unlock } from "../lib/syncrunner.js";
import { CREATED, markCreated, mergeLabels, NEEDS, parseLabels, pendingTags, setLabelStatus, tagList } from "../lib/labels.js";
import { switchLabelMode } from "../lib/modeswitch.js";
import { ensureLabels, ping } from "../lib/linker.js";
import { copyScript, sieveState } from "../lib/sieve-state.js";

const $ = (id) => document.getElementById(id);
const TEXT_FIELDS = ["domain", "length", "fixed", "categories", "spamFolder"];
const FIELDS = [...TEXT_FIELDS, "labelMode"];
const selectedMode = () => document.querySelector("input[name=labelMode]:checked")?.value;

function say(id, message, kind = "ok") {
  $(id).textContent = message;
  $(id).dataset.kind = kind;
}

async function loadSettings() {
  const s = await getSettings();
  $("domain").value = s.domain;
  $("length").value = s.length;
  $("fixed").value = s.fixed.join("\n");
  $("categories").value = s.categories.join(", ");
  $("spamFolder").value = s.spamFolder;
  for (const r of document.querySelectorAll("input[name=labelMode]")) r.checked = r.value === s.labelMode;
  $("linker").hidden = s.labelMode !== "bridge";
}

$("settings").addEventListener("submit", async (ev) => {
  ev.preventDefault();
  const previous = await getSettings();
  const raw = { ...previous, ...Object.fromEntries(TEXT_FIELDS.map((f) => [f, $(f).value])), labelMode: selectedMode() };
  const { ok, errors, value } = validateSettings(raw);
  for (const f of FIELDS) {
    $("e-" + f).textContent = errors[f] || "";
    $(f).setAttribute("aria-invalid", errors[f] ? "true" : "false");
  }
  if (!ok) {
    say("settings-status", "Fix the highlighted fields.", "err");
    $(FIELDS.find((f) => errors[f])).focus();
    return;
  }
  await saveSettings(value);
  say("settings-status", "Settings saved.");
  await loadSettings();

  // Mirror the fixed addresses to the Worker's KV. Local save has already succeeded, so a failure only warns.
  const push = await pushFixed(value.fixed).catch((err) => ({ ok: false, message: String(err?.message ?? err), synced: false }));
  if (push.synced) say("settings-status", `Settings saved. ${push.message}`);
  else if (!push.ok) say("settings-status", `Settings saved locally, but Cloudflare was not updated: ${push.message}`, "err");

  // Switching to Bridge creates every label still marked "needs creating".
  const sw = await switchLabelMode({
    from: previous.labelMode, to: value.labelMode, labels: await syncedLabels(),
    ensure: (names) => ensureLabels(names),
  });
  if (sw.ran) {
    await saveLabels(sw.labels);
    await setLinkerStatus({ ok: sw.ok, message: sw.message });
    await showLinkerStatus();
  }
  await renderAll();
});

async function renderRegistry() {
  const registry = await getRegistry();
  const rows = $("rows");
  rows.replaceChildren();
  const items = search(registry, $("search").value);
  if (!items.length) {
    const tr = document.createElement("tr");
    const td = document.createElement("td");
    td.colSpan = 6;
    td.className = "empty-note";
    td.textContent = registry.length ? "No matches." : "No aliases yet. Fill or copy one from the popup.";
    tr.append(td);
    rows.append(tr);
  }
  for (const e of items) {
    const tr = document.createElement("tr");
    tr.className = e.status;
    const cell = (text, cls) => {
      const td = document.createElement("td");
      td.textContent = text;
      if (cls) td.className = cls;
      return td;
    };
    tr.append(cell(e.alias, "mono"), cell(e.site), cell(e.created.slice(0, 10)), cell(e.status));

    const noteTd = document.createElement("td");
    const note = document.createElement("input");
    note.value = e.note;
    note.setAttribute("aria-label", "Note for " + e.alias);
    note.addEventListener("change", async () => {
      await saveRegistry(setNote(await getRegistry(), e.alias, note.value));
    });
    noteTd.append(note);

    const actions = document.createElement("td");
    const btn = (label, fn) => {
      const b = document.createElement("button");
      b.type = "button";
      b.className = "small";
      b.textContent = label;
      b.setAttribute("aria-label", `${label} ${e.alias}`);
      b.addEventListener("click", fn);
      return b;
    };
    const blocked = e.status === "blocked";
    actions.append(
      btn(blocked ? "Unblock" : "Block", async () => {
        const r = await setAliasBlocked(e.alias, !blocked);
        if (!r.ok) return say("registry-status", r.message, "err");
        await saveRegistry(setStatus(await getRegistry(), e.alias, blocked ? "active" : "blocked"));
        say("registry-status", r.synced ? r.message : blocked ? "Unblocked." : "Blocked.");
        await renderAll();
      }),
      " ",
      btn("Copy", () => navigator.clipboard.writeText(e.alias)),
      " ",
      btn("Delete", async () => {
        // Deleting never touches the blocked: key. For an active alias, offer to block it so the catch-all stops accepting it.
        let block = false;
        if (e.status === "active" && (await blocklistConfigured())) {
          const choice = await askDelete(e.alias);
          if (choice === "cancel") return;
          block = choice === "block";
        } else if (!confirm(`Remove ${e.alias} from the registry? A deleted alias is no longer blocked in the script.`)) {
          return;
        }
        const r = await deleteAlias(e.alias, { block });
        say("registry-status", r.message, r.ok ? "ok" : "err");
        await renderAll();
      }),
    );
    tr.append(noteTd, actions);
    rows.append(tr);
  }
}

// Resolves to "block", "delete" or "cancel" (Enter picks the default, Escape cancels).
function askDelete(alias) {
  const dlg = $("del-dialog");
  $("del-text").textContent = alias;
  return new Promise((resolve) => {
    dlg.addEventListener("close", () => resolve(dlg.returnValue === "block" || dlg.returnValue === "delete" ? dlg.returnValue : "cancel"), { once: true });
    dlg.returnValue = "";
    dlg.showModal();
  });
}

async function renderSieve() {
  const s = await sieveState();
  $("script").textContent = s.script;
  $("stale").hidden = !s.stale;
  $("stale").textContent = s.neverCopied ? "Not copied yet" : "Out of date";
}

async function renderLabels() {
  const labels = await syncedLabels();
  const pending = pendingTags(labels);
  const badge = $("labels-badge");
  badge.hidden = pending.length === 0;
  badge.textContent = `${pending.length} still need${pending.length === 1 ? "s" : ""} creating`;

  const rows = $("label-rows");
  rows.replaceChildren();
  for (const { tag, status } of tagList(labels)) {
    const tr = document.createElement("tr");
    const name = document.createElement("td");
    name.className = "mono";
    name.textContent = tag;

    const st = document.createElement("td");
    const pill = document.createElement("span");
    const done = status === CREATED;
    pill.className = "pill" + (done ? " done" : "");
    pill.textContent = done ? "Created" : "Needs creating";
    st.append(pill);

    const actions = document.createElement("td");
    const btn = (label, fn) => {
      const b = document.createElement("button");
      b.type = "button";
      b.className = "small";
      b.textContent = label;
      b.setAttribute("aria-label", `${label}: ${tag}`);
      b.addEventListener("click", fn);
      return b;
    };
    actions.append(
      btn(done ? "Mark as needs creating" : "Mark created", async () => {
        await saveLabels(setLabelStatus(await getLabels(), tag, done ? NEEDS : CREATED));
        await renderLabels();
      }),
      " ",
      btn("Copy name", async () => {
        await navigator.clipboard.writeText(tag);
        say("labels-status", `Copied "${tag}".`);
      }),
    );
    tr.append(name, st, actions);
    rows.append(tr);
  }
}

async function renderAll() {
  await renderRegistry();
  await renderLabels();
  await renderSieve();
}

$("search").addEventListener("input", renderRegistry);

$("copy-script").addEventListener("click", async () => {
  try {
    await copyScript();
    say("sieve-status", "Script copied.");
  } catch {
    say("sieve-status", "Could not write to the clipboard.", "err");
  }
  await renderSieve();
});

$("export").addEventListener("click", async () => {
  const blob = new Blob([exportRegistry(await getRegistry(), undefined, await syncedLabels())], { type: "application/json" });
  const a = document.createElement("a");
  a.href = URL.createObjectURL(blob);
  a.download = `alias-registry-${new Date().toISOString().slice(0, 10)}.json`;
  a.click();
  setTimeout(() => URL.revokeObjectURL(a.href), 1000);
});

$("import").addEventListener("click", () => $("import-file").click());
$("import-file").addEventListener("change", async (ev) => {
  const file = ev.target.files[0];
  ev.target.value = "";
  if (!file) return;
  try {
    const text = await file.text();
    const incoming = parseImport(text);
    const incomingLabels = parseLabels(JSON.parse(text).labels);
    const { registry, added, changed } = mergeRegistry(await getRegistry(), incoming);
    await saveRegistry(registry);
    await saveLabels(mergeLabels(await getLabels(), incomingLabels));
    say("registry-status", `Imported: ${added} added, ${changed} updated.`);
    await renderAll();
  } catch (err) {
    say("registry-status", err.message, "err");
  }
});


loadSettings().then(renderAll);

// ---- Cloudflare blocklist ----

async function loadCf() {
  const s = await getSettings();
  $("cfAccountId").value = s.cfAccountId;
  $("cfNamespaceId").value = s.cfNamespaceId;
  $("cfToken").value = "";
  $("cfToken").placeholder = (await getCfToken()) ? "Token saved (hidden)" : "";
  const granted = await hasPermission(api);
  say("cf-permission", granted ? "Permission for api.cloudflare.com: granted." : "Permission for api.cloudflare.com: not granted yet. Save or Test connection will ask for it.", granted ? "ok" : "err");
}

async function cfConfig() {
  const s = await getSettings();
  return { accountId: s.cfAccountId, namespaceId: s.cfNamespaceId, token: await getCfToken() };
}

$("cf").addEventListener("submit", async (ev) => {
  ev.preventDefault();
  // Ask first: permissions.request() only works directly inside the click handler.
  const wantsApi = $("cfAccountId").value.trim() || $("cfNamespaceId").value.trim() || $("cfToken").value;
  const granted = wantsApi ? await requestPermission(api) : await hasPermission(api);
  const previous = await getSettings();
  const raw = { ...previous, cfAccountId: $("cfAccountId").value, cfNamespaceId: $("cfNamespaceId").value };
  const { errors, value } = validateSettings(raw);
  for (const f of ["cfAccountId", "cfNamespaceId"]) {
    $("e-" + f).textContent = errors[f] || "";
    $(f).setAttribute("aria-invalid", errors[f] ? "true" : "false");
  }
  if (errors.cfAccountId || errors.cfNamespaceId) {
    say("cf-status", "Fix the highlighted fields.", "err");
    return;
  }
  await saveSettings(value);
  const typed = $("cfToken").value.trim();
  if (typed) await setCfToken(typed);
  else if (!value.cfAccountId && !value.cfNamespaceId) await setCfToken("");
  say("cf-status", "Saved.");
  await loadCf();
  if (wantsApi && !granted) say("cf-status", "Saved, but access to api.cloudflare.com was not allowed. Block and Unblock will not reach Cloudflare until you allow it.", "err");
});

$("cf-test").addEventListener("click", async () => {
  const granted = await requestPermission(api);
  await loadCf();
  if (!granted) return say("cf-status", "Allow access to api.cloudflare.com to test the connection.", "err");
  const cfg = await cfConfig();
  const typed = $("cfToken").value.trim();
  const test = { ...cfg, accountId: $("cfAccountId").value.trim().toLowerCase() || cfg.accountId, namespaceId: $("cfNamespaceId").value.trim().toLowerCase() || cfg.namespaceId, token: typed || cfg.token };
  if (!isConfigured(test)) return say("cf-status", "Enter the account ID, namespace ID and token first.", "err");
  say("cf-status", "Testing...");
  const r = await testConnection(test);
  say("cf-status", r.message, r.ok ? "ok" : "err");
});

$("cf-push-fixed").addEventListener("click", async () => {
  const granted = await requestPermission(api);
  await loadCf();
  if (!granted) return say("cf-status", "Allow access to api.cloudflare.com to push fixed addresses.", "err");
  if (!(await blocklistConfigured())) return say("cf-status", "Save the account ID, namespace ID and token first.", "err");
  say("cf-status", "Pushing...");
  const r = await pushFixed((await getSettings()).fixed);
  say("cf-status", r.message, r.ok ? "ok" : "err");
});

loadCf();

// ---- Proton label linker ----

async function showLinkerStatus() {
  const st = await getLinkerStatus();
  if (!st) return say("linker-status", "Not used yet.");
  say("linker-status", `${st.message} (${new Date(st.at).toLocaleString()})`, st.ok ? "ok" : "err");
}

async function runLinker(action, button) {
  button.disabled = true;
  say("linker-status", "Working...");
  try {
    const message = await action();
    await setLinkerStatus({ ok: true, message });
  } catch (err) {
    await setLinkerStatus({ ok: false, message: err.message });
  }
  button.disabled = false;
  await showLinkerStatus();
}

$("sync-labels").addEventListener("click", (e) =>
  runLinker(async () => {
    const labels = await syncedLabels();
    const r = await ensureLabels([...new Set([...tagsOf(await getRegistry()), ...pendingTags(labels)])].sort());
    await saveLabels(markCreated(labels, [...r.created, ...r.existing]));
    await renderLabels();
    return r.message;
  }, e.currentTarget));
$("check-linker").addEventListener("click", (e) => runLinker(() => ping(), e.currentTarget));

showLinkerStatus();


// ---- Sync ----

let creating = false;

function setCreating(on) {
  creating = on;
  $("syncPass2-field").hidden = !on;
  $("sync-unlock").textContent = on ? "Create sync vault" : "Unlock";
}

async function renderSync() {
  const st = await syncStatus();
  const lines = [];
  if (!st.configured) lines.push("Set up the Cloudflare blocklist above first.");
  else if (!st.enabled) lines.push("Sync is off on this browser. Enter your passphrase to start.");
  else lines.push(st.locked ? "Locked. Enter the passphrase to sync." : "Unlocked.");
  if (st.enabled && st.pending) lines.push(`${st.pending} change${st.pending === 1 ? "" : "s"} waiting to sync.`);
  if (st.lastSync) lines.push("Last synced " + new Date(st.lastSync).toLocaleString() + ".");
  if (st.lastError) lines.push("Last problem: " + st.lastError);
  lines.push(`Cloudflare writes today: ${st.writesToday} of 1,000.`);
  $("sync-detail").textContent = lines.join(" ");
  $("sync-now").disabled = !st.enabled || st.locked;
  $("sync-lock").disabled = !st.enabled || st.locked;
  $("sync-off").disabled = !st.enabled;
  $("sync-unlock").disabled = !st.configured;
}

function reportSync(r, okMessage) {
  if (r.skipped === "busy") return say("sync-status", "Another sync is running. Try again in a moment.", "err");
  if (r.error) return say("sync-status", r.error, "err");
  say("sync-status", okMessage);
}

$("sync").addEventListener("submit", async (ev) => {
  ev.preventDefault();
  const pass = $("syncPass").value;
  if (creating && pass !== $("syncPass2").value) return say("sync-status", "The two passphrases don't match.", "err");
  say("sync-status", "Working (deriving the key takes a moment)...");
  try {
    const r = await unlock(pass, { create: creating });
    $("syncPass").value = "";
    $("syncPass2").value = "";
    setCreating(false);
    reportSync(r, "Unlocked and synced.");
  } catch (err) {
    if (err.code === "no-vault") {
      setCreating(true);
      say("sync-status", err.message, "err");
      $("syncPass2").focus();
    } else {
      say("sync-status", err.message, "err");
    }
  }
  await renderAll();
  await renderSync();
});

$("sync-now").addEventListener("click", async () => {
  say("sync-status", "Syncing...");
  try {
    reportSync(await runSync({ manual: true }), "Synced.");
  } catch (err) {
    say("sync-status", err.message, "err");
  }
  await renderAll();
  await renderSync();
});

$("sync-lock").addEventListener("click", async () => {
  await lock();
  say("sync-status", "Locked. Changes keep queuing and are sent after you unlock.");
  await renderSync();
});

$("sync-off").addEventListener("click", async () => {
  if (!confirm("Turn sync off on this browser? Data already in Cloudflare is left alone.")) return;
  await disableSync();
  say("sync-status", "Sync is off on this browser.");
  await renderSync();
});

// Opening the page syncs once (a no-op while locked or off).
renderSync().then(async () => {
  try {
    const r = await runSync();
    if (r.applied) await renderAll();
  } catch {
    // The status line below reports the problem.
  }
  await renderSync();
});
