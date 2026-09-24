#!/usr/bin/env bash
set -Eeuo pipefail

if [[ -f /etc/shbvpn/certbot-backend ]] && [[ $(cat /etc/shbvpn/certbot-backend) == venv ]]; then
  EXPECTED_LINEAGE=/etc/shbvpn/letsencrypt/live/shbvpn
else
  EXPECTED_LINEAGE=/etc/letsencrypt/live/shbvpn
fi
TARGET_DIR=/etc/shbvpn/tls

# Certbot invokes global hooks for every renewed certificate on this host.
if [[ "${RENEWED_LINEAGE:-}" != "$EXPECTED_LINEAGE" ]]; then
  exit 0
fi

install -o root -g shbvpn -m 0640 "$EXPECTED_LINEAGE/fullchain.pem" "$TARGET_DIR/fullchain.pem.new"
install -o root -g shbvpn -m 0640 "$EXPECTED_LINEAGE/privkey.pem" "$TARGET_DIR/privkey.pem.new"
mv -f "$TARGET_DIR/fullchain.pem.new" "$TARGET_DIR/fullchain.pem"
mv -f "$TARGET_DIR/privkey.pem.new" "$TARGET_DIR/privkey.pem"

if systemctl is-active --quiet shbvpn-proxy.service; then
  systemctl restart shbvpn-proxy.service
fi
