# Alias Maker

Makes `tag.random@rounakkumarsingh.com` aliases and fills them into signup forms. Pair it with a catch-all on your domain and the Sieve script below, and every alias is labelled automatically.

## Install (Chrome, Brave, Edge, Chromium)

1. Open `chrome://extensions` and turn on **Developer mode**.
2. Click **Load unpacked** and pick this `alias-maker` folder.
3. Pin the extension. Open **Settings** from the popup and check the domain.

To change the keyboard shortcut (default `Alt+Shift+E`), go to `chrome://extensions/shortcuts`.

Firefox needs one change: in `manifest.json`, replace `"service_worker": "background.js"` with `"scripts": ["alias.js", "background.js"]`, and remove the `importScripts` line from `background.js`.

## Using it

- **Popup:** on a signup page, press `Alt+Shift+E`. The tag is taken from the site (e.g. `github`), so press Enter to fill the email field. Change the tag first for sensitive accounts, e.g. `fin` for banks.
- **Right-click:** in any email field, choose **Fill new alias for this site**.
- **Leaked alias:** open **Block a leaked alias**, paste it, copy the rule, and add it to section 1 of your filters.

1Password offers to save the login as usual, so the alias ends up in the right item.

## Mail filter (Sieve)

Turn on catch-all for the domain at your mail host, then add this as a Sieve filter. Check your host's Sieve docs for supported extensions, the spam folder name, and whether labels must exist before `fileinto` can use them.

```sieve
require ["fileinto", "variables"];

# 1. Blocked aliases: paste rules from the extension here, newest at the top.
# if address :is "to" "github.x7k2qf@rounakkumarsingh.com" { discard; stop; }

# 2. Fixed addresses: deliver normally.
if address :is "to" ["hello@rounakkumarsingh.com", "rounak@rounakkumarsingh.com"] {
    stop;
}

# 3. Aliases: label by the tag before the dot.
if address :localpart :matches "to" "*.*" {
    fileinto "${1}";
    stop;
}

# 4. Anything else at the domain was guessed by a spammer.
if address :domain :is "to" "rounakkumarsingh.com" {
    fileinto "Spam";
}
```

Notes:

- `stop` ends filtering for that message, so place this script before any other filters you want to keep running, or remove the `stop` lines.
- Mail that arrives without your alias in the To field (some newsletters use BCC) skips the label and lands in the inbox unlabelled.
- Tags never contain dots; the extension strips them so rule 3 always works.
