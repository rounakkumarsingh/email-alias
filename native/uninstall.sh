#!/usr/bin/env bash
# Removes the Alias Maker native host, its manifests and (optionally) its config and stored password.
set -euo pipefail

NAME="com.rounakkumarsingh.alias_maker"
DEST="${XDG_DATA_HOME:-$HOME/.local/share}/alias-maker"
CONF="${XDG_CONFIG_HOME:-$HOME/.config}"
purge=0
[[ "${1:-}" == "--purge" ]] && purge=1

for f in \
  "$HOME/.mozilla/native-messaging-hosts/$NAME.json" \
  "$HOME/.zen/native-messaging-hosts/$NAME.json" \
  "$CONF/google-chrome/NativeMessagingHosts/$NAME.json" \
  "$CONF/chromium/NativeMessagingHosts/$NAME.json" \
  "$CONF/BraveSoftware/Brave-Browser/NativeMessagingHosts/$NAME.json"; do
  [[ -e "$f" ]] && { rm -f "$f"; echo "Removed $f"; }
done

rm -rf "$DEST" && echo "Removed $DEST"

if [[ $purge -eq 1 ]]; then
  rm -rf "$CONF/alias-maker" && echo "Removed $CONF/alias-maker"
  if command -v secret-tool >/dev/null && secret-tool clear service alias-maker-bridge; then echo "Cleared stored Bridge password"; else echo "Could not clear the keyring entry; remove it manually (service=alias-maker-bridge)."; fi
else
  echo "Kept $CONF/alias-maker and the keyring entry. Use --purge to remove them too."
fi
