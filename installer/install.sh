#!/usr/bin/env bash
set -Eeuo pipefail

ROOT_DIR=$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)
INSTALLED_ROOT=/usr/local/share/shbvpn
MANAGE_BIN=/usr/local/sbin/shbvpn
CONFIG_DIR=/etc/shbvpn
CONFIG_FILE=$CONFIG_DIR/config.json
CREDS_FILE=$CONFIG_DIR/credentials
PROXY_BIN=/usr/local/bin/shbvpn-proxy
SNAP_CERTBOT=/snap/bin/certbot
VENV_DIR=$INSTALLED_ROOT/certbot-venv
VENV_CERTBOT=$VENV_DIR/bin/certbot
BACKEND_FILE=$CONFIG_DIR/certbot-backend
CERTBOT=$SNAP_CERTBOT
CERTBOT_OPTIONS=()
CERTBOT_LOG_DIR=
LINEAGE=/etc/letsencrypt/live/shbvpn
ACME_DIR=/var/lib/shbvpn/acme
HOOK=/etc/letsencrypt/renewal-hooks/deploy/shbvpn

usage() {
  cat <<'EOF'
Usage:
  sudo bash installer/install.sh --domain proxy.example.com [--port 443] [--email you@example.com]
  sudo bash installer/install.sh --ip PUBLIC_IPV4 [--port 443] [--email you@example.com]
  sudo bash installer/install.sh --show-key
  sudo bash installer/install.sh --rotate
  sudo bash installer/install.sh --uninstall

After installation: sudo shbvpn --show-key | --rotate | --uninstall

Supported hosts: Ubuntu 24.04 and 26.04. Ports 80/tcp and the proxy port must be reachable
from the internet for certificate issuance and browser connections respectively.
EOF
}

die() { printf 'Error: %s\n' "$*" >&2; exit 1; }

select_certbot_backend() {
  case "$1" in
    snap)
      CERTBOT=$SNAP_CERTBOT
      CERTBOT_OPTIONS=()
      CERTBOT_LOG_DIR=
      LINEAGE=/etc/letsencrypt/live/shbvpn
      HOOK=/etc/letsencrypt/renewal-hooks/deploy/shbvpn
      ;;
    venv)
      CERTBOT=$VENV_CERTBOT
      CERTBOT_LOG_DIR=/var/log/shbvpn/certbot
      CERTBOT_OPTIONS=(--config-dir "$CONFIG_DIR/letsencrypt" --work-dir /var/lib/shbvpn/certbot-work --logs-dir "$CERTBOT_LOG_DIR")
      LINEAGE=$CONFIG_DIR/letsencrypt/live/shbvpn
      HOOK=$CONFIG_DIR/letsencrypt/renewal-hooks/deploy/shbvpn
      ;;
    *) die "invalid Certbot backend" ;;
  esac
}

snapd_masked() {
  local unit state
  for unit in snapd.service snapd.socket; do
    state=$(systemctl is-enabled "$unit" 2>/dev/null || true)
    [[ $state == masked || $state == masked-runtime ]] && return 0
  done
  return 1
}

MODE=install
KIND=
HOST=
PORT=443
EMAIL=
PORT_SET=0
while (($#)); do
  case "$1" in
    --domain|--ip)
      (($# >= 2)) || die "$1 needs a value"
      [[ -z $KIND ]] || die "choose only one of --domain and --ip"
      KIND=${1#--}; HOST=$2; shift 2 ;;
    --port)
      (($# >= 2)) || die "--port needs a value"
      PORT=$2; PORT_SET=1; shift 2 ;;
    --email)
      (($# >= 2)) || die "--email needs a value"
      EMAIL=$2; shift 2 ;;
    --show-key) MODE=show-key; shift ;;
    --rotate) MODE=rotate; shift ;;
    --uninstall) MODE=uninstall; shift ;;
    -h|--help) usage; exit 0 ;;
    *) die "unknown option: $1" ;;
  esac
done

[[ $EUID -eq 0 ]] || die "run with sudo"

if [[ $MODE != install ]]; then
  [[ -z $KIND && $PORT_SET -eq 0 && -z $EMAIL ]] || die "management commands do not take install options"
  [[ -f $CONFIG_FILE ]] || die "installation not found"
fi

show_key() {
  [[ -f $CREDS_FILE ]] || die "credentials not found"
  python3 "$ROOT_DIR/installer/export-key.py"
}

make_credentials() {
  local temporary
  temporary=$(mktemp "$CONFIG_DIR/credentials.XXXXXX")
  python3 - > "$temporary" <<'PY'
import secrets
print("browser:" + secrets.token_urlsafe(32))
PY
  chown root:shbvpn "$temporary"
  chmod 0640 "$temporary"
  mv -f "$temporary" "$CREDS_FILE"
}

if [[ $MODE == show-key ]]; then
  show_key
  exit 0
fi

if [[ $MODE == rotate ]]; then
  BACKUP_CREDS=$(mktemp "$CONFIG_DIR/credentials.backup.XXXXXX")
  trap 'rm -f "$BACKUP_CREDS"' EXIT
  cp -p "$CREDS_FILE" "$BACKUP_CREDS"
  make_credentials
  if ! systemctl restart shbvpn-proxy.service || ! python3 "$ROOT_DIR/installer/healthcheck.py"; then
    mv -f "$BACKUP_CREDS" "$CREDS_FILE"
    systemctl restart shbvpn-proxy.service || true
    rm -f "$BACKUP_CREDS"
    die "rotation failed; previous credentials were restored"
  fi
  rm -f "$BACKUP_CREDS"
  trap - EXIT
  show_key
  exit 0
fi

remove_firewall_rule() {
  local name=$1
  if [[ -f /var/lib/shbvpn/"$name" ]] && command -v ufw >/dev/null 2>&1; then
    local rule
    rule=$(cat /var/lib/shbvpn/"$name")
    ufw --force delete allow "$rule/tcp" || true
  fi
}

if [[ $MODE == uninstall ]]; then
  if [[ -f $BACKEND_FILE ]]; then
    select_certbot_backend "$(cat "$BACKEND_FILE")"
  elif [[ -x $VENV_CERTBOT ]]; then
    select_certbot_backend venv
  else
    select_certbot_backend snap
  fi
  systemctl disable --now shbvpn-proxy.service shbvpn-acme.service shbvpn-renew.timer 2>/dev/null || true
  rm -f /etc/systemd/system/shbvpn-proxy.service /etc/systemd/system/shbvpn-acme.service /etc/systemd/system/shbvpn-renew.service /etc/systemd/system/shbvpn-renew.timer
  systemctl daemon-reload
  rm -f "$HOOK" "$PROXY_BIN"
  rm -f "$MANAGE_BIN"
  remove_firewall_rule ufw-proxy-added
  remove_firewall_rule ufw-http-added
  if [[ -x $CERTBOT ]]; then
    "$CERTBOT" "${CERTBOT_OPTIONS[@]}" delete --cert-name shbvpn --non-interactive || true
  fi
  rm -rf "$CONFIG_DIR" /var/lib/shbvpn "$INSTALLED_ROOT"
  if [[ -n $CERTBOT_LOG_DIR ]]; then rm -rf "$CERTBOT_LOG_DIR"; fi
  if id shbvpn >/dev/null 2>&1; then userdel shbvpn || true; fi
  printf 'SHB VPN removed. Certbot and Go packages were left installed.\n'
  exit 0
fi

[[ -n $KIND ]] || die "specify --domain or --ip"
[[ -r /etc/os-release ]] || die "Ubuntu 24.04 or 26.04 is required"
# shellcheck source=/dev/null
. /etc/os-release
[[ ${ID:-} == ubuntu && ( ${VERSION_ID:-} == 24.04 || ${VERSION_ID:-} == 26.04 ) ]] || die "this installer supports Ubuntu 24.04 and 26.04 only"

if [[ -f $BACKEND_FILE ]]; then
  CERTBOT_BACKEND=$(cat "$BACKEND_FILE")
elif [[ ${VERSION_ID:-} == 26.04 ]] && snapd_masked; then
  CERTBOT_BACKEND=venv
else
  CERTBOT_BACKEND=snap
fi
select_certbot_backend "$CERTBOT_BACKEND"

python3 - "$KIND" "$HOST" "$PORT" "$EMAIL" <<'PY' || exit 1
import ipaddress
import re
import sys
kind, host, port, email = sys.argv[1:]
if not port.isdecimal() or not (1 <= int(port) <= 65535) or int(port) == 80:
    sys.exit("Error: proxy port must be 1..65535 except 80")
if kind == "ip":
    try:
        ip = ipaddress.IPv4Address(host)
    except ipaddress.AddressValueError:
        sys.exit("Error: --ip requires a public IPv4 address")
    if not ip.is_global:
        sys.exit("Error: --ip requires a public IPv4 address")
elif kind == "domain":
    try:
        ipaddress.ip_address(host)
    except ValueError:
        pass
    else:
        sys.exit("Error: use --ip for an IP address")
    if len(host) > 253 or any(
        not re.fullmatch(r"[A-Za-z0-9](?:[A-Za-z0-9-]{0,61}[A-Za-z0-9])?", label)
        for label in host.split(".")
    ) or "." not in host:
        sys.exit("Error: --domain requires a DNS hostname such as proxy.example.com")
else:
    sys.exit("Error: unknown host kind")
if email and (len(email) > 254 or not re.fullmatch(r"[^\s@]+@[^\s@]+\.[^\s@]+", email)):
    sys.exit("Error: invalid email address")
PY

if [[ -f $CONFIG_FILE ]]; then
  python3 - "$CONFIG_FILE" "$KIND" "$HOST" "$PORT" <<'PY' || die "configuration changed; uninstall before changing host or port"
import json, sys
config = json.load(open(sys.argv[1], encoding="utf-8"))
if (config["kind"], config["host"], str(config["port"])) != tuple(sys.argv[2:]):
    sys.exit(1)
PY
else
  # Names are deliberately fixed. Never take over another service's user or lineage.
  if id shbvpn >/dev/null 2>&1 || [[ -e $LINEAGE || -e /etc/letsencrypt/renewal/shbvpn.conf || -e $PROXY_BIN || -e $MANAGE_BIN || -e $HOOK || -e $INSTALLED_ROOT || -e /etc/systemd/system/shbvpn-proxy.service || -e /etc/systemd/system/shbvpn-acme.service || -e /etc/systemd/system/shbvpn-renew.timer ]]; then
    die "existing SHB VPN resources conflict with a fresh installation"
  fi
  python3 - "$PORT" <<'PY' || die "ports 80 and $PORT must be free before installation"
import socket
import sys

for port in (80, int(sys.argv[1])):
    with socket.socket(socket.AF_INET, socket.SOCK_STREAM) as listener:
        try:
            listener.bind(("0.0.0.0", port))
        except OSError as error:
            sys.exit(f"Error: TCP port {port} is unavailable: {error}")
PY
fi

export DEBIAN_FRONTEND=noninteractive
PACKAGES=(golang-go python3 ca-certificates)
if [[ $CERTBOT_BACKEND == venv ]]; then
  PACKAGES+=(python3-venv)
else
  PACKAGES+=(snapd)
fi
MISSING_PACKAGES=()
for package in "${PACKAGES[@]}"; do
  if ! dpkg-query -W -f='${Status}' "$package" 2>/dev/null | grep -qx 'install ok installed'; then
    MISSING_PACKAGES+=("$package")
  fi
done
if ((${#MISSING_PACKAGES[@]})); then
  apt-get update
  apt-get -o DPkg::Lock::Timeout=300 install -y --no-install-recommends "${MISSING_PACKAGES[@]}"
fi
if [[ $CERTBOT_BACKEND == snap ]]; then
  systemctl enable --now snapd.socket
  timeout 180 snap wait system seed.loaded
  if ! snap list certbot >/dev/null 2>&1; then
    snap install --classic certbot
  fi
  [[ -x $CERTBOT ]] || die "Certbot snap was not installed"
fi

if ! id shbvpn >/dev/null 2>&1; then
  useradd --system --user-group --home-dir /var/lib/shbvpn --shell /usr/sbin/nologin shbvpn
fi
install -d -o root -g shbvpn -m 0750 /var/lib/shbvpn
install -d -o root -g shbvpn -m 0750 "$CONFIG_DIR" "$CONFIG_DIR/tls"
install -d -o root -g root -m 0755 "$ACME_DIR" "$ACME_DIR/.well-known" "$ACME_DIR/.well-known/acme-challenge"

if [[ ! -f $CONFIG_FILE ]]; then
  python3 - "$KIND" "$HOST" "$PORT" > "$CONFIG_FILE" <<'PY'
import json, sys
kind, host, port = sys.argv[1:]
json.dump({"kind": kind, "host": host, "port": int(port)}, sys.stdout, separators=(",", ":"))
sys.stdout.write("\n")
PY
  chmod 0600 "$CONFIG_FILE"
fi
if [[ ! -f $BACKEND_FILE ]]; then
  printf '%s\n' "$CERTBOT_BACKEND" > "$BACKEND_FILE"
  chmod 0600 "$BACKEND_FILE"
fi
if [[ $CERTBOT_BACKEND == venv ]]; then
  install -d -o root -g root -m 0755 "$INSTALLED_ROOT"
  install -d -o root -g root -m 0700 "$CONFIG_DIR/letsencrypt" /var/lib/shbvpn/certbot-work "$CERTBOT_LOG_DIR"
  install -d -o root -g root -m 0755 "$(dirname "$HOOK")"
  if [[ ! -x $CERTBOT ]]; then
    python3 -m venv "$VENV_DIR"
    "$VENV_DIR/bin/python" -m pip install --disable-pip-version-check --no-input 'certbot==5.8.0'
  fi
fi
[[ -x $CERTBOT ]] || die "Certbot was not installed"
if [[ $KIND == ip ]]; then
  CERTBOT_VERSION=$($CERTBOT --version | awk '{print $2}')
  dpkg --compare-versions "$CERTBOT_VERSION" ge 5.4 || die "IP certificates need Certbot 5.4 or newer; found $CERTBOT_VERSION. Update the selected Certbot backend separately, then retry"
fi
if [[ ! -f $CREDS_FILE ]]; then make_credentials; fi

TEMP_BIN=$(mktemp)
trap 'rm -f "$TEMP_BIN"' EXIT
(cd "$ROOT_DIR/server" && /usr/bin/go build -trimpath -o "$TEMP_BIN" .)
install -o root -g root -m 0755 "$TEMP_BIN" "$PROXY_BIN.new"
mv -f "$PROXY_BIN.new" "$PROXY_BIN"
if [[ $ROOT_DIR != "$INSTALLED_ROOT" ]]; then
  install -d -o root -g root -m 0755 "$INSTALLED_ROOT/server" "$INSTALLED_ROOT/installer"
  install -o root -g root -m 0644 "$ROOT_DIR/server/"*.go "$ROOT_DIR/server/go.mod" "$INSTALLED_ROOT/server/"
  install -o root -g root -m 0755 "$ROOT_DIR/installer/"*.sh "$ROOT_DIR/installer/"*.py "$INSTALLED_ROOT/installer/"
fi
cat > "$MANAGE_BIN" <<'EOF'
#!/usr/bin/env bash
exec bash /usr/local/share/shbvpn/installer/install.sh "$@"
EOF
chmod 0755 "$MANAGE_BIN"
install -d -o root -g root -m 0755 "$(dirname "$HOOK")"
install -o root -g root -m 0755 "$ROOT_DIR/installer/deploy-hook.sh" "$HOOK"

cat > /etc/systemd/system/shbvpn-acme.service <<EOF
[Unit]
Description=SHB VPN HTTP-01 certificate challenge server
After=network-online.target
Wants=network-online.target

[Service]
Type=simple
User=shbvpn
Group=shbvpn
ExecStart=$PROXY_BIN --acme-only --listen :80 --acme-webroot $ACME_DIR
Restart=on-failure
RestartSec=5s
AmbientCapabilities=CAP_NET_BIND_SERVICE
CapabilityBoundingSet=CAP_NET_BIND_SERVICE
NoNewPrivileges=yes
ProtectSystem=strict
ProtectHome=yes
PrivateTmp=yes
PrivateDevices=yes
RestrictAddressFamilies=AF_INET AF_INET6 AF_UNIX

[Install]
WantedBy=multi-user.target
EOF

cat > /etc/systemd/system/shbvpn-proxy.service <<EOF
[Unit]
Description=SHB VPN HTTPS forward proxy
After=network-online.target
Wants=network-online.target

[Service]
Type=simple
User=shbvpn
Group=shbvpn
ExecStart=$PROXY_BIN --listen :$PORT --cert $CONFIG_DIR/tls/fullchain.pem --key $CONFIG_DIR/tls/privkey.pem --credentials $CREDS_FILE
Restart=on-failure
RestartSec=5s
AmbientCapabilities=CAP_NET_BIND_SERVICE
CapabilityBoundingSet=CAP_NET_BIND_SERVICE
NoNewPrivileges=yes
ProtectSystem=strict
ProtectHome=yes
PrivateTmp=yes
PrivateDevices=yes
RestrictAddressFamilies=AF_INET AF_INET6 AF_UNIX

[Install]
WantedBy=multi-user.target
EOF

cat > /etc/systemd/system/shbvpn-renew.service <<EOF
[Unit]
Description=Renew SHB VPN certificate
After=network-online.target
Wants=network-online.target

[Service]
Type=oneshot
ExecStart=$CERTBOT ${CERTBOT_OPTIONS[*]} renew --cert-name shbvpn --quiet
EOF

cat > /etc/systemd/system/shbvpn-renew.timer <<'EOF'
[Unit]
Description=Check SHB VPN certificate renewal twice daily

[Timer]
OnCalendar=*-*-* 03:00:00
OnCalendar=*-*-* 15:00:00
RandomizedDelaySec=45m
Persistent=yes

[Install]
WantedBy=timers.target
EOF

systemctl daemon-reload

open_ufw_port() {
  local port=$1 marker=$2
  if command -v ufw >/dev/null 2>&1 && ufw status | grep -q '^Status: active'; then
    if ! ufw status | grep -Eq "^${port}/tcp[[:space:]]+ALLOW"; then
      ufw allow "$port/tcp" comment 'SHB VPN'
      printf '%s\n' "$port" > "/var/lib/shbvpn/$marker"
    fi
  fi
}
open_ufw_port 80 ufw-http-added
open_ufw_port "$PORT" ufw-proxy-added

systemctl enable --now shbvpn-acme.service
systemctl restart shbvpn-acme.service
systemctl is-active --quiet shbvpn-acme.service || die "ACME challenge service failed; check journalctl -u shbvpn-acme"

CERTBOT_ARGS=(certonly --non-interactive --agree-tos --webroot --webroot-path "$ACME_DIR" --cert-name shbvpn --keep-until-expiring)
if [[ -n $EMAIL ]]; then
  CERTBOT_ARGS+=(--email "$EMAIL")
else
  CERTBOT_ARGS+=(--register-unsafely-without-email)
fi
if [[ $KIND == ip ]]; then
  CERTBOT_ARGS+=(--preferred-profile shortlived --ip-address "$HOST")
else
  CERTBOT_ARGS+=(-d "$HOST")
fi
"$CERTBOT" "${CERTBOT_OPTIONS[@]}" "${CERTBOT_ARGS[@]}"
[[ -r $LINEAGE/fullchain.pem && -r $LINEAGE/privkey.pem ]] || die "certificate files were not created"
RENEWED_LINEAGE=$LINEAGE "$HOOK"
systemctl enable --now shbvpn-proxy.service
systemctl restart shbvpn-proxy.service
systemctl is-active --quiet shbvpn-proxy.service || die "proxy failed; check journalctl -u shbvpn-proxy"
python3 "$ROOT_DIR/installer/healthcheck.py"
PROXY_PID_BEFORE=$(systemctl show -p MainPID --value shbvpn-proxy.service)
"$CERTBOT" "${CERTBOT_OPTIONS[@]}" renew --dry-run --run-deploy-hooks --no-random-sleep-on-renew --cert-name shbvpn --quiet || die "certificate renewal dry run failed"
PROXY_PID_AFTER=$(systemctl show -p MainPID --value shbvpn-proxy.service)
[[ -n $PROXY_PID_AFTER && $PROXY_PID_AFTER != 0 && $PROXY_PID_AFTER != "$PROXY_PID_BEFORE" ]] || die "deploy hook did not restart the proxy during renewal dry run"
python3 "$ROOT_DIR/installer/healthcheck.py"
systemctl enable --now shbvpn-renew.timer
systemctl is-active --quiet shbvpn-renew.timer || die "certificate renewal timer failed"
systemctl is-enabled --quiet shbvpn-renew.timer || die "certificate renewal timer is not enabled"

printf '\nInstallation complete. Import this key in the Chrome extension:\n'
show_key
printf '\nKeep this key private. The proxy is listening on %s:%s.\n' "$HOST" "$PORT"
