#!/usr/bin/env bash
set -euo pipefail

cd "$(dirname "$0")"
mkdir -p state
python3 -m py_compile server.py
