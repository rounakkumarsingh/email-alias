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

## Proton filter script

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

Click **Block** next to the alias in the popup or the options page, copy the script again, and replace the filter in Proton. Blocked aliases are discarded before anything else runs. **Unblock** reverses it.

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
- `scripts/shots.ts` takes Chromium screenshots of the popup and options page.
