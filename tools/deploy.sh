#!/usr/bin/env bash
#
# Push the repo to vm-webserver and publish the site.
#
#   tools/deploy.sh            # sync everything, then publish site/
#   tools/deploy.sh --site     # publish site/ only (fast path)
#   tools/deploy.sh --dry-run  # show what would change
#
# The server keeps two ZFS datasets under tank/arc:
#   /arc/repo   the source tree
#   /arc/site   what Caddy serves (arctools.mynodes.xyz)
#
# Publishing is a separate rsync rather than pointing Caddy at /arc/repo/site,
# so a half-finished edit in the repo is never live.

set -euo pipefail

HOST="${ARC_DEPLOY_HOST:-vm-webserver}"
REPO_DIR="/arc/repo"
SITE_DIR="/arc/site"

cd "$(dirname "$0")/.."

dry=""
site_only=0
for arg in "$@"; do
  case "$arg" in
    --dry-run) dry="--dry-run" ;;
    --site) site_only=1 ;;
    -h|--help) sed -n '2,20p' "$0" | sed 's/^# \?//'; exit 0 ;;
    *) echo "deploy: unknown option $arg" >&2; exit 2 ;;
  esac
done

# Never ship a site that fails its own linter or tests.
if [ -z "$dry" ]; then
  echo "→ checking"
  npm test --silent >/dev/null
  node packages/arc-lint/src/cli.ts . >/dev/null
  echo "  tests and lint pass"
fi

if [ "$site_only" -eq 0 ]; then
  echo "→ syncing repo to $HOST:$REPO_DIR"
  rsync -a --delete $dry \
    --exclude 'node_modules/' --exclude '.DS_Store' --exclude '*.log' \
    --exclude 'arc-lint.json' --exclude 'arc-lint.sarif' --exclude 'reports/' \
    ./ "$HOST:$REPO_DIR/"
fi

echo "→ publishing site to $HOST:$SITE_DIR"
rsync -a --delete $dry ./site/ "$HOST:$SITE_DIR/"

if [ -z "$dry" ]; then
  ssh "$HOST" "
    chown -R root:root $SITE_DIR
    find $SITE_DIR -type d -exec chmod 755 {} +
    find $SITE_DIR -type f -exec chmod 644 {} +
  "
  echo "→ live at https://arctools.mynodes.xyz"
fi
