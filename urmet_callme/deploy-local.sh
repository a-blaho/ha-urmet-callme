#!/usr/bin/env bash
# One-command deploy of this add-on to a Home Assistant box's LOCAL add-ons folder, over SSH, so a
# working-tree build can be tested on real hardware BEFORE tagging a release. Nothing is published:
# it copies the add-on onto your HA machine, where the Supervisor builds it from the Dockerfile.
# Uses tar-over-SSH (the HA add-on shell has no rsync).
#
# The staged copy differs from the repo in two ways, both on purpose:
#   - config.yaml `image:` is REMOVED. With it set, the Supervisor pulls the pre-built GHCR image
#     and ignores the local Dockerfile entirely, so nothing local would be tested.
#   - config.yaml `name:` gets a " (local dev)" suffix so the local build is distinguishable from
#     the store one. The slug stays `urmet_callme`; HA namespaces local add-ons separately
#     (local_urmet_callme), so both can be installed - but STOP the store one while the local one
#     runs: they would bind the same host-network ports and publish the same MQTT entities.
#
# Usage:  ./deploy-local.sh [ha-host]
#   e.g.  ./deploy-local.sh                    # defaults to homeassistant.local
#         ./deploy-local.sh 192.168.1.50
#         HA_USER=root HA_PORT=22 HA_KEY=~/.ssh/homeassistant ./deploy-local.sh homeassistant.local
#         DRY_RUN=1 ./deploy-local.sh          # stage only; show what would be sent, touch no host
#
# Needs on the HA box: the "Terminal & SSH" (or "Advanced SSH & Web Terminal") add-on, with your SSH
# public key added and port 22 enabled. Prefer no SSH? Copy the folder via the Samba share instead.
set -euo pipefail

if [ "${1:-}" = "-h" ] || [ "${1:-}" = "--help" ]; then
  # print the header comment block (every #-line after the shebang, up to the first code line)
  awk 'NR>1 && /^#/ {sub(/^# ?/,""); print; next} NR>1 {exit}' "$0"
  exit 0
fi

HA_HOST="${1:-${HA_HOST:-homeassistant.local}}"
HA_USER="${HA_USER:-root}"
HA_PORT="${HA_PORT:-22}"
HA_ADDONS="${HA_ADDONS:-auto}"             # "auto" = ask the box (see the resolution below)
HA_KEY="${HA_KEY:-$HOME/.ssh/homeassistant}"
DRY_RUN="${DRY_RUN:-}"
HERE="$(cd "$(dirname "$0")" && pwd)"

# --- preflight: local tools we rely on ---
for t in rsync ssh tar sed; do
  command -v "$t" >/dev/null 2>&1 ||
    { echo "error: '$t' is not installed on this machine - please install it and re-run." >&2; exit 1; }
done

# One multiplexed connection for the preflight AND the upload, so a passphrase-protected key (not
# in the agent) prompts once, not twice. No BatchMode: that would silently refuse to prompt for the
# passphrase and fail with a misleading "Permission denied (publickey)".
CTRL="$(mktemp -d)/ctl"
SSH_OPTS=(-p "$HA_PORT" -o ConnectTimeout=8
          -o ControlMaster=auto -o ControlPath="$CTRL" -o ControlPersist=120)
key="${HA_KEY/#\~/$HOME}"
[ -f "$key" ] && SSH_OPTS+=(-i "$key" -o IdentitiesOnly=yes)

# --- stage a clean copy (rsync exists locally), patch the manifest for a local build ---
STAGE="$(mktemp -d)"
trap 'rm -rf "$STAGE"; ssh -o ControlPath="$CTRL" -O exit "$HA_USER@$HA_HOST" 2>/dev/null; rm -rf "$(dirname "$CTRL")"' EXIT
rsync -a \
  --exclude 'node_modules/' --exclude 'dist/' --exclude '.dev-data/' --exclude '.env' \
  --exclude 'deploy-local.sh' \
  "$HERE/" "$STAGE/urmet_callme/"
cfg="$STAGE/urmet_callme/config.yaml"
sed -i.bak -E \
  -e '/^image:/d' \
  -e 's/^(name:[[:space:]]*)(.*)$/\1\2 (local dev)/' \
  "$cfg" && rm -f "$cfg.bak"
grep -q '^image:' "$cfg" && { echo "error: failed to strip image: from the staged config.yaml" >&2; exit 1; }
grep -q 'local dev' "$cfg" || { echo "error: failed to rename the staged add-on" >&2; exit 1; }

if [ -n "$DRY_RUN" ]; then
  echo "DRY RUN - staged add-on (nothing sent):"
  (cd "$STAGE" && find urmet_callme -type f | sort | sed 's/^/  /')
  echo "staged config.yaml header:"
  sed -n '1,8p' "$cfg" | sed 's/^/  /'
  exit 0
fi

# --- preflight: can we actually reach the box and write to /addons? ---
echo "Checking SSH to $HA_USER@$HA_HOST:$HA_PORT (you may be asked for your key's passphrase) ..."

# WHICH directory does this Supervisor actually build local add-ons from? Newer Supervisors
# migrated from /addons to /local_apps (their CLI now warns "The use of 'addons' is deprecated,
# please use 'apps' instead" and their log says supervisor.apps.app). They build from
# /local_apps and IGNORE /addons -- so deploying to /addons on such a box looks like it worked,
# the Supervisor even reports "Build ... done", and the container keeps running the previous
# code. That silent staleness is very expensive to debug, so ask the box instead of guessing.
if [ "$HA_ADDONS" = auto ]; then
  HA_ADDONS="$(ssh "${SSH_OPTS[@]}" "$HA_USER@$HA_HOST" \
    'if [ -d /local_apps ]; then echo /local_apps; else echo /addons; fi')" || {
      echo "error: could not reach $HA_USER@$HA_HOST to detect the local add-ons directory." >&2
      exit 1; }
  case "$HA_ADDONS" in /local_apps|/addons) ;; *)
      echo "error: unexpected add-ons directory '$HA_ADDONS' reported by the box." >&2; exit 1;; esac
  echo "Local add-ons directory on the box: $HA_ADDONS"
fi
if ! ssh "${SSH_OPTS[@]}" "$HA_USER@$HA_HOST" "mkdir -p '$HA_ADDONS'"; then
  cat >&2 <<EOF
error: could not SSH to $HA_USER@$HA_HOST:$HA_PORT with key auth, or '$HA_ADDONS' isn't writable.

If it said "Permission denied (publickey)" and your key has a passphrase, load it into the agent
once and re-run (then no prompt is needed):  ssh-add --apple-use-keychain $key

Otherwise, on your Home Assistant:
  1. Install the "Terminal & SSH" (or "Advanced SSH & Web Terminal") add-on.
  2. In its config, paste your SSH PUBLIC key (e.g. the contents of ~/.ssh/id_ed25519.pub),
     make sure port 22 is enabled, and Start it.
  3. Re-run:  ./deploy-local.sh $HA_HOST
     (override with HA_USER=... HA_PORT=... HA_KEY=/path/to/key if your setup differs.)

Prefer not to use SSH? Copy the 'urmet_callme' folder into the Samba 'addons' share instead
(install the "Samba share" add-on, then drop the folder into \\\\$HA_HOST\\addons\\).
EOF
  exit 1
fi

echo "Uploading add-on -> $HA_USER@$HA_HOST:$HA_ADDONS/urmet_callme/ ..."
# rm -rf the remote dir before extracting so files deleted locally don't linger on the box
# (a plain tar-extract overwrites but never deletes -> stale sources fail the container build).
# Safe: the add-on's persistent state lives in the /data volume, not in this source folder.
# COPYFILE_DISABLE: keep macOS tar from adding ._* AppleDouble metadata files to the archive.
COPYFILE_DISABLE=1 tar -cf - -C "$STAGE" urmet_callme \
  | ssh "${SSH_OPTS[@]}" "$HA_USER@$HA_HOST" "rm -rf '$HA_ADDONS/urmet_callme' && mkdir -p '$HA_ADDONS' && tar -xf - -C '$HA_ADDONS' && echo '  extracted:' && ls '$HA_ADDONS/urmet_callme'"

cat <<EOF

Done - the add-on is on your HA box. Next, in Home Assistant:
  1. STOP the store-installed "Urmet CallMe (Unofficial)" if it is running (same ports + entities).
  2. Settings -> Add-ons -> Add-on Store -> (top-right) 3-dots -> Check for updates
  3. Under "Local add-ons" open "Urmet CallMe (Unofficial) (local dev)" -> Install
     (first build ~10-15 min on HA hardware: it compiles liblinphone helpers; updates are fast)
  4. Its Configuration tab -> set email / password (+ video: true, log_level: debug to test video)
     -> Start, then watch the Log tab.
Already installed? Use the add-on's 3-dots -> Rebuild to pick up this update.
EOF
