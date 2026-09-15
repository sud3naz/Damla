#!/usr/bin/env bash
# Consistent SQLite backup (works with WAL), keeps 14 days.
set -euo pipefail
SRC=/var/lib/damla/damla.db
DST_DIR=/var/backups/damla
mkdir -p "$DST_DIR"; chmod 700 "$DST_DIR"
DST="$DST_DIR/damla-$(date -u +%Y%m%d-%H%M%S).db"
python3 - "$SRC" "$DST" <<'PY'
import sqlite3, sys
src = sqlite3.connect(sys.argv[1]); dst = sqlite3.connect(sys.argv[2])
src.backup(dst); dst.close(); src.close()
PY
chmod 600 "$DST"
find "$DST_DIR" -name 'damla-*.db' -mtime +14 -delete
echo "backup $DST ($(stat -c %s "$DST") bytes)"
