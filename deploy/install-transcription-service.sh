#!/usr/bin/env bash
set -euo pipefail

if [ "$(id -u)" -ne 0 ]; then
  printf 'Run this setup with sudo: sudo bash deploy/install-transcription-service.sh\n' >&2
  exit 1
fi

if [ "$(id -un sodro 2>/dev/null || true)" != "sodro" ]; then
  printf 'Expected the Linux account "sodro" to exist.\n' >&2
  exit 1
fi

repository="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")/.." && pwd)"
venv="/home/sodro/freecut-api-venv"
model_cache="/home/sodro/.cache/freecut-models"

if [ ! -f "$repository/server/requirements.txt" ] || [ ! -f "$repository/server/main.py" ]; then
  printf 'Run this script from the FreeCut GitHub checkout.\n' >&2
  exit 1
fi

apt-get update
DEBIAN_FRONTEND=noninteractive apt-get install -y python3-venv

if [ ! -x "$venv/bin/python" ]; then
  runuser -u sodro -- python3 -m venv "$venv"
fi
runuser -u sodro -- "$venv/bin/python" -m pip install --upgrade pip
runuser -u sodro -- "$venv/bin/python" -m pip install -r "$repository/server/requirements.txt"
runuser -u sodro -- "$venv/bin/python" -m unittest discover \
  -s "$repository/server" -p 'test_*.py'

install -d -o sodro -g sodro -m 750 "$model_cache"
install -o root -g root -m 644 \
  "$repository/deploy/freecut-transcription.service" \
  /etc/systemd/system/freecut-transcription.service
systemctl daemon-reload
systemctl enable --now freecut-transcription.service
systemctl restart freecut-transcription.service
systemctl --no-pager --full status freecut-transcription.service

printf '\nThe service listens only on 127.0.0.1:8765. Add the documented /api/ Nginx proxy before using transcription.\n'
