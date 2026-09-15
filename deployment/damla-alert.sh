#!/usr/bin/env bash
# Called by systemd OnFailure= when damla.service dies.
. /etc/damla/env 2>/dev/null || true
MSG="damla.service failed: $(systemctl show damla -p Result -p ExecMainStatus --value | tr '\n' ' ')"
[ -n "${NTFY_TOPIC:-}" ] && curl -s -m 10 -H "Title: Damla" -H "Priority: urgent" -d "$MSG" "https://ntfy.sh/$NTFY_TOPIC" >/dev/null
echo "$MSG"
