#!/usr/bin/env bash
set -Eeuo pipefail

MODE=hook
if (($#)); then
  [[ $# -eq 1 && $1 == --reconcile ]] || { echo "Usage: $0 [--reconcile]" >&2; exit 2; }
  MODE=reconcile
fi

if [[ -f /etc/shbvpn/certbot-backend ]] && [[ $(cat /etc/shbvpn/certbot-backend) == venv ]]; then
  EXPECTED_LINEAGE=/etc/shbvpn/letsencrypt/live/shbvpn
else
  EXPECTED_LINEAGE=/etc/letsencrypt/live/shbvpn
fi
TARGET_DIR=/etc/shbvpn/tls

# Certbot invokes global hooks for every renewed certificate on this host.
if [[ $MODE == hook && "${RENEWED_LINEAGE:-}" != "$EXPECTED_LINEAGE" ]]; then
  exit 0
fi

[[ -r $EXPECTED_LINEAGE/fullchain.pem && -r $EXPECTED_LINEAGE/privkey.pem ]] || {
  echo "SHB VPN certificate lineage is missing or unreadable: $EXPECTED_LINEAGE" >&2
  exit 1
}

CHANGED=0
if [[ $MODE == hook ]] || ! cmp -s "$EXPECTED_LINEAGE/fullchain.pem" "$TARGET_DIR/fullchain.pem" || ! cmp -s "$EXPECTED_LINEAGE/privkey.pem" "$TARGET_DIR/privkey.pem"; then
  install -o root -g shbvpn -m 0640 "$EXPECTED_LINEAGE/fullchain.pem" "$TARGET_DIR/fullchain.pem.new"
  install -o root -g shbvpn -m 0640 "$EXPECTED_LINEAGE/privkey.pem" "$TARGET_DIR/privkey.pem.new"
  mv -f "$TARGET_DIR/fullchain.pem.new" "$TARGET_DIR/fullchain.pem"
  mv -f "$TARGET_DIR/privkey.pem.new" "$TARGET_DIR/privkey.pem"
  CHANGED=1
fi

if [[ $MODE == hook ]]; then
  if systemctl is-active --quiet shbvpn-proxy.service; then
    systemctl restart shbvpn-proxy.service
  fi
  exit 0
fi

if [[ $CHANGED -eq 1 ]]; then
  systemctl restart shbvpn-proxy.service
fi
if ! python3 /usr/local/share/shbvpn/installer/healthcheck.py; then
  # Files can match while a still-running process serves the previous cert.
  if [[ $CHANGED -eq 0 ]]; then
    systemctl restart shbvpn-proxy.service
    python3 /usr/local/share/shbvpn/installer/healthcheck.py
  else
    exit 1
  fi
fi
