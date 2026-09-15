#!/usr/bin/env bash
# Deploy Damla's API + trigger to the VPS. Run from the repo root on the Mac.
#   deployment/deploy.sh root@103.244.227.82
set -euo pipefail
HOST="${1:?usage: deploy.sh user@host}"
ssh "$HOST" 'id damla >/dev/null 2>&1 || useradd --system --home /opt/damla --shell /usr/sbin/nologin damla; mkdir -p /opt/damla /var/lib/damla /etc/damla; chown damla:damla /var/lib/damla; chmod 750 /var/lib/damla /etc/damla'
rsync -az --delete --exclude node_modules --exclude .git --exclude .env --exclude '*.db*' --exclude .vercel ./ "$HOST":/opt/damla/
ssh "$HOST" 'cd /opt/damla && npm ci --omit=dev --no-audit --no-fund && chown -R damla:damla /opt/damla && for u in damla damla-alert damla-backup damla-watch; do install -m 644 deployment/$u.service /etc/systemd/system/$u.service; done && install -m 644 deployment/damla-backup.timer /etc/systemd/system/ && install -m 644 deployment/damla-watch.timer /etc/systemd/system/ && systemctl daemon-reload && systemctl enable --now damla-backup.timer damla-watch.timer && systemctl enable damla && systemctl restart damla && sleep 2 && systemctl --no-pager --lines=5 status damla && curl -s 127.0.0.1:8944/api/health'
