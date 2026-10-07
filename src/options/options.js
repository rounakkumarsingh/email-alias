import { exportRegistry, mergeRegistry, parseImport, removeEntry, search, setNote, setStatus, tagsOf } from "../lib/registry.js";
import { validateSettings } from "../lib/settings.js";
import { getLabels, getLinkerStatus, getRegistry, getSettings, saveLabels, saveRegistry, saveSettings, setLinkerStatus, syncedLabels } from "../lib/storage.js";
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
  const raw = { ...Object.fromEntries(TEXT_FIELDS.map((f) => [f, $(f).value])), labelMode: selectedMode() };
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
  const previous = await getSettings();
  await saveSettings(value);
  say("settings-status", "Settings saved.");
  await loadSettings();

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
        await saveRegistry(setStatus(await getRegistry(), e.alias, blocked ? "active" : "blocked"));
        await renderAll();
      }),
      " ",
      btn("Copy", () => navigator.clipboard.writeText(e.alias)),
      " ",
      btn("Delete", async () => {
        if (!confirm(`Remove ${e.alias} from the registry? A deleted alias is no longer blocked in the script.`)) return;
        await saveRegistry(removeEntry(await getRegistry(), e.alias));
        await renderAll();
      }),
    );
    tr.append(noteTd, actions);
    rows.append(tr);
  }
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
