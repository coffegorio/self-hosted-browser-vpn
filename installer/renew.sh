#!/usr/bin/env bash
set -Eeuo pipefail

case "$(cat /etc/shbvpn/certbot-backend)" in
  snap)
    CERTBOT_COMMAND=(/snap/bin/certbot)
    ;;
  venv)
    CERTBOT_COMMAND=(/usr/local/share/shbvpn/certbot-venv/bin/certbot --config-dir /etc/shbvpn/letsencrypt --work-dir /var/lib/shbvpn/certbot-work --logs-dir /var/log/shbvpn/certbot)
    ;;
  *) echo "Invalid SHB VPN Certbot backend" >&2; exit 1 ;;
esac

CERTBOT_STATUS=0
"${CERTBOT_COMMAND[@]}" renew --cert-name shbvpn --quiet || CERTBOT_STATUS=$?

# Certbot does not report a deploy-hook failure as a renewal failure. Always
# compare the deployed pair with the lineage and verify the live proxy.
RECONCILE_STATUS=0
/usr/local/share/shbvpn/installer/deploy-hook.sh --reconcile || RECONCILE_STATUS=$?

if [[ $CERTBOT_STATUS -ne 0 ]]; then
  echo "Certbot renewal failed with status $CERTBOT_STATUS" >&2
fi
if [[ $RECONCILE_STATUS -ne 0 ]]; then
  echo "Certificate reconciliation or proxy health check failed with status $RECONCILE_STATUS" >&2
fi
if [[ $CERTBOT_STATUS -ne 0 ]]; then
  exit "$CERTBOT_STATUS"
fi
if [[ $RECONCILE_STATUS -ne 0 ]]; then
  exit "$RECONCILE_STATUS"
fi
