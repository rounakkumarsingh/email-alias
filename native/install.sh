#!/usr/bin/env bash
# Installs the Alias Maker native messaging host for Firefox, Chrome, Chromium and Brave (Linux).
set -euo pipefail

NAME="com.rounakkumarsingh.alias_maker"
GECKO_ID="alias-maker@rounakkumarsingh.com"
SRC="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
DEST="${XDG_DATA_HOME:-$HOME/.local/share}/alias-maker"
CONF="${XDG_CONFIG_HOME:-$HOME/.config}"
HOST_CONF="$CONF/alias-maker/host.json"

user="" cert="" port=1143 security=starttls store_password=0 all=0
usage() {
  cat <<USAGE
Usage: install.sh --user BRIDGE_USERNAME --cert /path/to/cert.pem [options]
  --user NAME         IMAP username shown in Bridge (usually your Proton address)
  --cert PATH         Certificate exported from Bridge (Settings > Advanced > Export TLS certificates)
  --port N            Bridge IMAP port (default 1143)
  --security MODE     starttls (default) or ssl, matching Bridge's connection mode
  --store-password    Prompt for the Bridge password and save it in the keyring (secret-tool)
  --all               Install manifests for every browser, even if its config dir is missing
Run with no --user/--cert to only (re)write browser manifests from an existing config.
USAGE
}
while [[ $# -gt 0 ]]; do
  case "$1" in
    --user) user="$2"; shift 2 ;;
    --cert) cert="$2"; shift 2 ;;
    --port) port="$2"; shift 2 ;;
    --security) security="$2"; shift 2 ;;
    --store-password) store_password=1; shift ;;
    --all) all=1; shift ;;
    -h|--help) usage; exit 0 ;;
    *) echo "Unknown option: $1" >&2; usage >&2; exit 2 ;;
  esac
done

command -v python3 >/dev/null || { echo "python3 is required" >&2; exit 1; }

mkdir -p "$DEST"
install -m 755 "$SRC/alias_maker_host.py" "$DEST/alias_maker_host.py"
HOST_PATH="$DEST/alias_maker_host.py"

if [[ -n "$user" || -n "$cert" ]]; then
  [[ -n "$user" && -n "$cert" ]] || { echo "--user and --cert go together" >&2; exit 2; }
  [[ -f "$cert" ]] || { echo "Certificate not found: $cert" >&2; exit 1; }
  [[ "$security" == starttls || "$security" == ssl ]] || { echo "--security must be starttls or ssl" >&2; exit 2; }
  [[ "$port" =~ ^[0-9]+$ ]] || { echo "--port must be a number" >&2; exit 2; }
  mkdir -p "$(dirname "$HOST_CONF")"
  # Values are passed via the environment, never interpolated into code.
  U="$user" C="$(realpath "$cert")" P="$port" S="$security" python3 -I - "$HOST_CONF" <<'PY'
import json, os, sys
cfg = {"user": os.environ["U"], "host": "127.0.0.1", "port": int(os.environ["P"]),
       "security": os.environ["S"], "cert": os.environ["C"]}
with open(sys.argv[1], "w") as f:
    json.dump(cfg, f, indent=2)
    f.write("\n")
PY
  chmod 600 "$HOST_CONF"
  echo "Wrote $HOST_CONF"
elif [[ ! -f "$HOST_CONF" ]]; then
  echo "Note: $HOST_CONF does not exist yet. Re-run with --user and --cert." >&2
fi

if [[ $store_password -eq 1 ]]; then
  command -v secret-tool >/dev/null || { echo "secret-tool not found (install libsecret)" >&2; exit 1; }
  echo "Enter the Bridge password (Bridge > your account > Mailbox configuration), then press Enter:"
  secret-tool store --label="Alias Maker (Proton Bridge)" service alias-maker-bridge
fi

# Chromium-family extension ID is derived from the pinned public key in the Chrome build.
CHROME_ID="$(python3 -I - "$SRC/chrome-key.txt" <<'PY'
import base64, hashlib, sys
der = base64.b64decode(open(sys.argv[1]).read().strip())
h = hashlib.sha256(der).hexdigest()[:32]
print("".join(chr(ord("a") + int(c, 16)) for c in h))
PY
)"

write_manifest() { # dir, key, json-array-value
  local dir="$1" key="$2" value="$3"
  mkdir -p "$dir"
  cat > "$dir/$NAME.json" <<JSON
{
  "name": "$NAME",
  "description": "Alias Maker: creates Proton labels through Proton Bridge",
  "path": "$HOST_PATH",
  "type": "stdio",
  "$key": $value
}
JSON
  echo "Installed $dir/$NAME.json"
}

want() { [[ $all -eq 1 || -d "$1" ]]; }

# Firefox (and the Zen fork, which keeps its own profile dir).
write_manifest "$HOME/.mozilla/native-messaging-hosts" allowed_extensions "[\"$GECKO_ID\"]"
[[ -d "$HOME/.zen" ]] && write_manifest "$HOME/.zen/native-messaging-hosts" allowed_extensions "[\"$GECKO_ID\"]"

ORIGINS="[\"chrome-extension://$CHROME_ID/\"]"
want "$CONF/google-chrome" && write_manifest "$CONF/google-chrome/NativeMessagingHosts" allowed_origins "$ORIGINS"
want "$CONF/chromium" && write_manifest "$CONF/chromium/NativeMessagingHosts" allowed_origins "$ORIGINS"
want "$CONF/BraveSoftware/Brave-Browser" && write_manifest "$CONF/BraveSoftware/Brave-Browser/NativeMessagingHosts" allowed_origins "$ORIGINS"

echo "Done. Chromium extension ID: $CHROME_ID"
echo "Restart the browser if it was running."
