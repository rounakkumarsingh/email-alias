const domainInput = document.getElementById("domain");
const lengthInput = document.getElementById("length");
const statusEl = document.getElementById("status");

function say(message, kind = "ok") {
  statusEl.textContent = message;
  statusEl.dataset.kind = kind;
}

async function load() {
  const settings = await getSettings();
  domainInput.value = settings.domain;
  lengthInput.value = settings.length;
}

document.getElementById("save").addEventListener("click", async () => {
  const domain = domainInput.value.trim().toLowerCase();
  const length = Number(lengthInput.value);

  if (!isValidDomain(domain)) {
    say("Enter a domain like rounakkumarsingh.com, without @ or https://.", "err");
    return;
  }
  if (!Number.isInteger(length) || length < 5 || length > 12) {
    say("Random part length must be a whole number from 5 to 12.", "err");
    return;
  }

  await chrome.storage.sync.set({ domain, length });
  say("Settings saved.");
});

load();
