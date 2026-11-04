#!/usr/bin/env bash
set -euo pipefail

repository="https://github.com/rodrigolincoleos/freecut.git"
branch="main"
base="/home/sodro/freecut"

for command in git node npm mktemp cp mkdir ln mv rm date id; do
  if ! command -v "$command" >/dev/null 2>&1; then
    printf 'Required command not found: %s\n' "$command" >&2
    exit 1
  fi
done

node_version="$(node -p 'process.versions.node.split(".").map(Number).join(" ")')"
set -- $node_version
if [ "$1" -lt 22 ] || { [ "$1" -eq 22 ] && [ "$2" -lt 12 ]; }; then
  printf 'Node.js 22.12 or newer is required; found %s.\n' "$(node --version)" >&2
  exit 1
fi

if [ "$(id -u)" -eq 0 ]; then
  printf 'Run this deployment as sodro, not as root.\n' >&2
  exit 1
fi

for variable in VITE_AUTH0_DOMAIN VITE_AUTH0_CLIENT_ID VITE_AUTH0_AUDIENCE; do
  if [ -z "${!variable:-}" ]; then
    printf 'Required Auth0 build configuration is missing: %s\n' "$variable" >&2
    exit 1
  fi
done

mkdir -p "$base/releases"
workdir="$(mktemp -d)"
release_tmp=""
link_tmp=""

cleanup() {
  rm -rf -- "$workdir"
  if [ -n "$release_tmp" ] && [ -d "$release_tmp" ]; then
    rm -rf -- "$release_tmp"
  fi
  if [ -n "$link_tmp" ] && [ -L "$link_tmp" ]; then
    rm -f -- "$link_tmp"
  fi
}
trap cleanup EXIT

git clone --quiet --depth 1 --branch "$branch" -- "$repository" "$workdir/source"
cd "$workdir/source"
npm ci
npm run build

if [ ! -s dist/index.html ]; then
  printf 'Build did not produce dist/index.html.\n' >&2
  exit 1
fi

commit="$(git rev-parse --short=12 HEAD)"
release_id="${commit}-$(date -u +%Y%m%d%H%M%S)-$$"
release="$base/releases/$release_id"
release_tmp="$base/releases/.${release_id}.tmp"
link_tmp="$base/.current.next.$$"

mkdir "$release_tmp"
cp -a dist "$release_tmp/dist"
mv -T -- "$release_tmp" "$release"
release_tmp=""

ln -s -- "$release" "$link_tmp"
mv -Tf -- "$link_tmp" "$base/current"
link_tmp=""

printf 'Deployed %s to %s\n' "$commit" "$release"
