#!/usr/bin/env bash
# Health watchdog: API must answer, the service must be running, the trigger must
# not be stuck. Alerts once per state change through ntfy (topic from /etc/damla/env).
set -uo pipefail
. /etc/damla/env 2>/dev/null || true
STATE=/var/lib/damla/watch.state
PROBLEMS=()
# a deploy restarts the service: give it 90 s before judging
STARTED=$(systemctl show damla -p ActiveEnterTimestampMonotonic --value 2>/dev/null || echo 0)
UP=$(( ($(cut -d. -f1 /proc/uptime) * 1000000 - ${STARTED:-0}) / 1000000 ))
if systemctl is-active --quiet damla && [ "$UP" -lt 90 ]; then echo "service restarted ${UP}s ago, skipping"; exit 0; fi
systemctl is-active --quiet damla || PROBLEMS+=("systemd: damla is not running")
H=$(curl -s -m 10 http://127.0.0.1:8944/api/health || true)
echo "$H" | grep -q '"ok":true' || PROBLEMS+=("api: /api/health failed (${H:0:80})")
# a purchase window that opened more than 15 minutes ago and is still pending with no attempt means the trigger is stuck
STUCK=$(python3 - <<'PY'
import sqlite3, time
db = sqlite3.connect('file:/var/lib/damla/damla.db?mode=ro', uri=True)
t = int(time.time())
n = db.execute("SELECT count(*) FROM txs t JOIN plans p ON p.id=t.plan_id WHERE p.status='active' AND t.kind='buy' AND t.status='pending' AND t.min_time < ? AND t.attempts = 0 AND (t.note IS NULL OR t.note NOT LIKE 'waiting:%')", (t-900,)).fetchone()[0]
print(n)
PY
)
[ "${STUCK:-0}" = "0" ] || PROBLEMS+=("trigger: $STUCK purchase(s) due >15min ago never attempted")
NOW="${#PROBLEMS[@]}"
PREV=$(cat "$STATE" 2>/dev/null || echo 0)
echo "$NOW" > "$STATE"
notify() { [ -n "${NTFY_TOPIC:-}" ] && curl -s -m 10 -H "Title: Damla" -H "Priority: $2" -d "$1" "https://ntfy.sh/$NTFY_TOPIC" >/dev/null; echo "$1"; }
if [ "$NOW" != "0" ]; then
  [ "$PREV" = "0" ] && notify "$(printf '%s\n' "${PROBLEMS[@]}")" high || echo "still failing: ${PROBLEMS[*]}"
elif [ "$PREV" != "0" ]; then
  notify "Damla recovered: service, API and trigger healthy" default
fi
exit 0
