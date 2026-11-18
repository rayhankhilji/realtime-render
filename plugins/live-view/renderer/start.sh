#!/bin/sh
# Starts the Live View renderer in the background, installing its
# dependencies the first time. Usage: start.sh <socket path> <log path>
set -e
cd "$(dirname "$0")"
SOCK="$1"
LOG="$2"
if [ ! -d node_modules/three ] || [ ! -d node_modules/playwright-core ]; then
  npm install --no-audit --no-fund --loglevel=error >>"$LOG" 2>&1 || true
fi
nohup node server.mjs "$SOCK" >>"$LOG" 2>&1 </dev/null &
