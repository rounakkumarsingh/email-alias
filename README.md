# Alias Maker

Makes `tag.random@yourdomain` email aliases (e.g. `github.x7k2qf@rounakkumarsingh.com`), fills them into signup forms, keeps a registry of every alias, and generates the Proton Sieve filter that labels, blocks and spam-filters them. Works in Firefox (and forks such as Zen) and Chromium-based browsers. Optionally creates the Proton labels for you through Proton Bridge.

## Build

Needs [Bun](https://bun.sh).

```sh
bun install
bun run build      # writes dist/chrome and dist/firefox
bun test           # extension logic
bun run test:host  # native host (Python, stdlib only)
bun run lint       # build + web-ext lint on the Firefox build
```

## Install

**Firefox / Zen, temporary:** open `about:debugging#/runtime/this-firefox`, choose **Load Temporary Add-on**, and pick `dist/firefox/manifest.json`. It is removed when the browser restarts. Needs Firefox 140 or newer.

**Firefox, permanent (signed):** release Firefox only installs signed add-ons. Create AMO API keys, then:

```sh
bunx web-ext sign -s dist/firefox --channel=unlisted --api-key=... --api-secret=...
```

Open the signed `.xpi` in `web-ext-artifacts/` with Firefox. Unlisted signing is for self-distribution and usually takes minutes to a day.

**Chromium, Chrome, Brave, Edge:** open `chrome://extensions`, turn on **Developer mode**, click **Load unpacked**, and pick `dist/chrome`. The build pins an extension key, so the ID is always `dneclkpdhgnjjjloeghcfpgcpabcpoag`.

Press `Alt+Shift+E` to open the popup (change it at `chrome://extensions/shortcuts` or `about:addons`).

## Using it

- **Popup:** the tag is taken from the site. Edit it, use a category chip (`fin`, `govt`, configurable), regenerate the random part, then **Fill on page** or **Copy**. Tags are `a-z`, `0-9` and hyphens, up to 24 characters, never dots.
- **Right-click** an editable field and choose **Fill new alias for this site**.
- **Registry:** every alias you fill or copy is recorded with tag, site, date, status and note. Search it in the popup or on the options page. Export and import it as JSON to share between browsers; entries merge by alias and the most recently changed one wins.
- **Settings** (options page): domain, random length (5 to 12), fixed addresses, category tags, spam folder name and label mode (below).

## Proton filter script (for a future Proton Mail Plus move)

This is the alternative to the Cloudflare Worker below, for when you are on a Proton plan with custom filters. With the Worker in place you do not need it.

1. Open the options page and click **Copy full script**.
2. In Proton Mail: **Settings → Filters → Add filter → Add Sieve filter**. Paste, name it, save.
3. Create a Proton label for each tag (see "Proton labels" below). Proton does not create labels from `fileinto`, and the filter's label has to exist.

The script runs in this order: blocked aliases are discarded, fixed addresses pass through, everything of the form `tag.random@domain` is filed under the label `tag`, and any other address at your domain goes to the spam folder. The **Out of date** badge appears whenever blocks or settings changed since you last copied the script.

## Proton labels

Mail only gets labelled if a label named after the tag exists in Proton. There are two modes, set under **Settings → Proton labels**.

### Manual (default, no Bridge needed)

The extension tracks every tag as **created** or **needs creating**. A tag starts as "needs creating" the first time an alias uses it, and your category tags (`fin`, `govt`) are listed from the start.

1. Fill or copy an alias. If its tag still needs a label, the popup shows *Create the label `github` in Proton before mail arrives*.
2. Click **Copy label name**, then in Proton go to **Settings → Folders and labels → Add a label** and paste the name.
3. Click **Done** in the popup. The tag is now marked created.

The toolbar icon shows a red badge with the number of tags still needing a label. The **Labels** section of the options page lists every tag with its status, a button to mark it created (or back to needs creating), and a button to copy its name. Statuses are included in the registry export and merged on import.

### Bridge linker

Pick **Bridge linker** and save. Every tag still marked "needs creating" is created through Bridge straight away, and later new tags get their label automatically. If Bridge is unreachable the tags stay marked "needs creating" and the status line says why, so you can fall back to Manual or use **Sync labels** later. Setup is in the next section.

### Blocking a leaked alias

Click **Block** next to the alias in the popup or the options page. With the Cloudflare Worker set up, that is all: the alias is rejected at the door. Without it, copy the script again and replace the filter in Proton. Blocked aliases are discarded before anything else runs. **Unblock** reverses it.

**Deleting** an alias from the registry never removes its `blocked:` key, so a blocked alias stays blocked. Deleting an alias that is still active (with the Cloudflare blocklist set up) asks **Block it too?** with *Delete and block* as the default, because the catch-all keeps accepting a deleted alias otherwise.

## Cloudflare mail router (Email Worker)

A Worker in `worker/` sits behind your catch-all address and decides what happens to each message:

| Recipient | Result |
|---|---|
| A fixed address (`FIXED` in `worker/wrangler.toml`), any case | Forwarded unchanged to your Proton address |
| `tag.random@domain` (tag `[a-z0-9-]{1,24}`, random `[a-z0-9]{5,12}`), any case | Forwarded with headers `X-Alias-Tag` and `X-Alias`, unless the alias is in the KV blocklist |
| Blocked alias, malformed address, plus-addressing, unknown address | Rejected with the single message `Address not accepted` |

The Subject is **not** rewritten. Cloudflare's `forward()` can only add `X-` headers, and re-sending a modified copy would break the sender's DKIM/SPF/DMARC results, replace the From address and risk the free plan's 10 ms CPU limit. The Worker never reads message bodies or subjects and logs only `{ts, alias, tag, action}`.

If `forward()` fails the Worker rethrows instead of rejecting, so the sender is not told "permanent failure". If the KV read fails it forwards anyway (action `kv_error`). A newly blocked alias can keep delivering for up to about a minute because KV is eventually consistent.

### Setup

1. `bunx wrangler login` (you run this yourself).
2. `bunx wrangler kv namespace create BLOCKLIST` and paste the printed `id` into `worker/wrangler.toml`.
3. In `worker/wrangler.toml` set `DESTINATION` (your verified Proton address), `DOMAIN` and `FIXED`.
4. Deploy with one command: `bun run deploy:worker`.

### Switch Email Routing to the Worker (dashboard)

Nothing here is changed for you.

1. Cloudflare dashboard, your domain, **Email → Email Routing → Routing rules**.
2. On **Catch-all address** choose **Edit**, set the action to **Send to a Worker**, pick `alias-router`, and save. Make sure the catch-all is enabled.
3. Delete or disable any old custom rules that forward `hello@` or `rounak@` straight to Proton (the Worker handles them now).

### Token for Block/Unblock in the extension

1. Dashboard home: copy the **Account ID**. **Storage & databases → KV**: open `BLOCKLIST` and copy the namespace **ID**.
2. **My Profile → API Tokens → Create Token → Create Custom Token.**
3. Permission: **Account → Workers KV Storage → Edit**, and nothing else. Cloudflare applies it to the whole account; it cannot be limited to one namespace.
4. Account Resources: **Include → your account**.
5. Optional: set a TTL. When it expires the extension says "Cloudflare token invalid or expired" and you make a new one. Leave Client IP Address Filtering empty.
6. In the extension options, **Cloudflare blocklist**: paste the IDs and token, click **Save** (Firefox asks you to allow `api.cloudflare.com`; allow it), then **Test connection**.

The token stays in local extension storage: never synced, never exported, never logged.

### Test checklist

- [ ] `bun test` passes.
- [ ] Optional local run: `cd worker && bunx wrangler dev`, then `curl -X POST 'http://localhost:8787/cdn-cgi/local/email' --url-query 'from=a@b.com' --url-query 'to=shop.abcde@yourdomain.com' --data-raw $'From: a@b.com\r\nTo: shop.abcde@yourdomain.com\r\nSubject: t\r\n\r\nhi'`.
- [ ] After deploy and the dashboard switch, send mail to `hello@`, a live alias, and `junk@`. The first two arrive in Proton; `junk@` bounces with `Address not accepted`.
- [ ] From a Gmail account, send a test to a valid alias. In Proton open **More → View headers** and confirm `X-Alias-Tag` and `X-Alias` are present.
- [ ] Block that alias in the extension, wait a minute, send again: it bounces with `Address not accepted`. Unblock and confirm delivery returns.
- [ ] `bunx wrangler kv key list --binding BLOCKLIST -c worker/wrangler.toml` shows `blocked:<alias>` while blocked.
- [ ] Failure behaviour: Cloudflare's docs do not say which SMTP code an uncaught exception produces. Check once (for example by temporarily setting `DESTINATION` to an unverified address) that the sender gets a temporary failure, not a permanent one. Undo it afterwards.
- [ ] Watch activity with `bunx wrangler tail alias-router`; lines show only alias, tag, action and time.

### Retiring the Worker (moving to Proton Mail Plus)

1. Copy the Sieve script from the options page into a Proton filter.
2. Dashboard, **Email Routing**: set the catch-all back to **Send to an email** (your Proton address).
3. `bunx wrangler delete -c worker/wrangler.toml`, then optionally delete the `BLOCKLIST` namespace and the API token, and clear the Cloudflare fields in the extension options.

## Sync between browsers (encrypted)

The alias registry and the Proton label statuses can be kept the same in every browser through the same Cloudflare KV namespace. Everything is encrypted in the browser first, so Cloudflare only stores ciphertext.

### What is stored, and what Cloudflare can see

| KV key | Content |
|---|---|
| `reg:<id>` | One encrypted registry entry (or deletion marker), `id` = a keyed hash of the alias |
| `lbl:<id>` | One encrypted label status, `id` = a keyed hash of the tag |
| `sync:meta` | Random salt, iteration count and an encrypted check value (plaintext salt only) |
| `sync:head` | A random value rewritten on every push, so other browsers can tell something changed |
| `blocked:<alias>` | Unchanged, plaintext, read by the Worker. **Block and Unblock still write these**, and sync never touches them |

Each blob is AES-256-GCM with a fresh random IV, keyed from your passphrase with PBKDF2-SHA256 (600,000 iterations), and bound to its key name so it can't be moved to another key. Cloudflare can see how many entries exist, their sizes, when they change, and the `blocked:` aliases. It cannot see aliases, tags, sites, notes or label names under `reg:`/`lbl:`. There is **no passphrase recovery**: if you lose it, the synced data is unreadable, so keep a JSON export (Export/Import still work as an offline backup). Changing the passphrase is not supported yet.

### Setting up the first browser

1. Set up the Cloudflare blocklist (account ID, namespace ID, token) as described above.
2. In **Sync between browsers**, enter a passphrase and click **Unlock**. Because no sync data exists yet you are asked to type it again; then click **Create sync vault**.

### Adding a second browser

1. Install the extension and enter the **same account ID, namespace ID and API token** in *Cloudflare blocklist* (the same token, or a new one with the same Workers KV Storage Edit permission). Save, allow `api.cloudflare.com` when Firefox asks, and click *Test connection*.
2. In *Sync between browsers* enter the **same passphrase** and click **Unlock**. A wrong passphrase gives "Wrong sync passphrase" and changes nothing remotely.

### How it behaves

- **When it syncs:** when the popup or options page opens, on **Sync now**, and a few seconds after every change. An unchanged check costs one KV read.
- **Conflicts:** last write wins per entry, using each entry's `updated` time, so keep your computers' clocks roughly right. Deleting leaves a deletion marker so it propagates; an edit made later than the deletion brings the alias back.
- **Locked mode:** the key is kept only in memory (below), so after a browser restart sync is locked until you enter the passphrase in the popup or the options page. While locked, creating, filling, copying and blocking aliases all keep working. Changes queue locally, nothing is dropped (deletions keep the time you made them), and they are sent after you unlock.
- **Free-plan limits:** only changed entries are written, in one bulk call, plus one write for `sync:head`. Cloudflare's free plan allows 1,000 KV writes a day (Block and Unblock also write one key each). Automatic sync pauses at 800 writes in a UTC day and says so; **Sync now** still works. KV is eventually consistent, so another browser can take up to about a minute to see a change.
- **Unreadable data:** if some synced items can't be decrypted, the extension keeps your local data, writes nothing, and reports how many items it could not read.

### Where the key lives

The passphrase is never stored. The derived keys are kept only in `storage.session` (memory only, cleared when the browser closes) and the extension sets its access level to trusted contexts explicitly, so content scripts on web pages cannot read it. Both the Chrome and MDN docs say session storage is not exposed to content scripts by default, but neither names the default level, so this was checked rather than assumed:

- **Chromium 152** (`scripts/dev/e2e-sync.ts`): a content script on a web page reads `storage.session` and gets "Access to storage is not allowed from this context", while `storage.local` works as the control.
- **Zen 1.23.2b**, a Firefox fork (`scripts/dev/probe-session-firefox.ts`): in a content script `browser.storage.session` is `undefined`, both with the default access level and after setting `TRUSTED_CONTEXTS`.
- Stock Firefox was not available to test; the Zen result and the MDN statement are what the Firefox claim rests on. Re-run the probe with `bun run scripts/dev/probe-session-firefox.ts <dir> /path/to/firefox` to check yours.

### Wiping remote sync data

Delete the `reg:`, `lbl:` and `sync:` keys (never `blocked:`), for example with `bunx wrangler kv key list --binding BLOCKLIST --remote -c worker/wrangler.toml` and `bunx wrangler kv bulk delete`. Then click *Turn off on this browser* on each browser.

## Bridge linker setup (optional)

Only needed for Bridge mode, which requires a paid Proton plan. A small Python host talks to the Proton Bridge IMAP server and creates labels as `Labels/<tag>`. It needs Proton Bridge running, Python 3, and `secret-tool` (libsecret). Nothing about your mail is stored in the extension: the Bridge password stays in the system keyring and TLS verification is always on.

1. In Bridge: **Settings → Advanced settings → Export TLS certificates**, and note the IMAP username and password under your account's mailbox configuration.
2. Install the host (it also stores the password in the keyring when you pass `--store-password`):

   ```sh
   native/install.sh --user YOUR_BRIDGE_IMAP_USERNAME --cert /path/to/cert.pem --store-password
   ```

   Add `--port` or `--security ssl` if you changed Bridge's defaults (127.0.0.1, port 1143, STARTTLS). Firefox, Zen, Chrome, Chromium and Brave manifests are written for whichever are present.
3. Restart the browser, open the options page, and use **Check connection**.
4. Set **Settings → Proton labels** to **Bridge linker** and save. Waiting labels are created at once, and each new tag gets its label the first time it is used. **Sync labels** re-checks every tag. If Bridge or the host is unavailable the status line says why and aliases are still created normally.

Remove everything with `native/uninstall.sh` (`--purge` also deletes the config and keyring entry).

The host accepts only `ping`, `list_labels`, `create_label` and `ensure_labels`, and rejects any other request or invalid label name.

## Development notes

- `scripts/dev/fake_bridge.py` is a fake STARTTLS IMAP server, and `scripts/dev/e2e-linker.ts` drives the Chromium build against the real host and it.
- `scripts/dev/e2e-sync.ts <dir>` drives two Chromium profiles through encrypted sync against a local mock of the Cloudflare KV API (needs `openssl`), including the locked-mode queue and the `storage.session` content-script probe.
- `scripts/shots.ts` takes Chromium screenshots of the popup and options page.
