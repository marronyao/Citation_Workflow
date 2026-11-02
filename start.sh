#!/bin/sh
cd "$(dirname "$0")" || exit 1
if ! command -v python3 >/dev/null 2>&1; then
  echo 'Python 3.10 or later is required. Install Python 3, then run sh start.sh again.'
  exit 1
fi
exec python3 server.py --origin https://marronyao.github.io --open-browser
