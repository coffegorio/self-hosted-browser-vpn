#!/usr/bin/env bash
set -Eeuo pipefail

ROOT_DIR=$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)
INSTALLED_ROOT=/usr/local/share/shbvpn
MANAGE_BIN=/usr/local/sbin/shbvpn
CONFIG_DIR=/etc/shbvpn
STATE_DIR=/var/lib/shbvpn
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
ACME_DIR=$STATE_DIR/acme
UNIT_FILES=(
  /etc/systemd/system/shbvpn-acme.service
  /etc/systemd/system/shbvpn-proxy.service
  /etc/systemd/system/shbvpn-renew.service
  /etc/systemd/system/shbvpn-renew.timer
)

usage() {
  cat <<'EOF'
Usage:
  sudo bash installer/install.sh --domain proxy.example.com [--port 443] [--email you@example.com]
  sudo bash installer/install.sh --ip PUBLIC_IPV4 [--port 443] [--email you@example.com]
  Add --self-address PUBLIC_IP for each extra public ingress address on the VPS.
  On an existing installation, --clear-self-addresses removes saved extra addresses.
  sudo bash installer/install.sh --show-key
  sudo bash installer/install.sh --rotate
  sudo bash installer/install.sh --uninstall

After installation: sudo shbvpn --show-key | --rotate | --uninstall

Supported hosts: Ubuntu 24.04 and 26.04. Ports 80/tcp and the proxy port must be reachable
from the internet for certificate issuance and browser connections respectively.
EOF
}

die() { printf 'Error: %s\n' "$*" >&2; exit 1; }

lock_installation() {
  exec 9>/run/shbvpn-install.lock
  flock -n 9 || die "another SHB VPN management command is running"
}

select_certbot_backend() {
  local certbot_config
  case "$1" in
    snap)
      CERTBOT=$SNAP_CERTBOT
      CERTBOT_OPTIONS=()
      CERTBOT_LOG_DIR=
      certbot_config=/etc/letsencrypt
      ;;
    venv)
      CERTBOT=$VENV_CERTBOT
      CERTBOT_LOG_DIR=/var/log/shbvpn/certbot
      certbot_config=$CONFIG_DIR/letsencrypt
      CERTBOT_OPTIONS=(--config-dir "$certbot_config" --work-dir "$STATE_DIR/certbot-work" --logs-dir "$CERTBOT_LOG_DIR")
      ;;
    *) die "invalid Certbot backend" ;;
  esac
  LINEAGE=$certbot_config/live/shbvpn
  RENEWAL_FILE=$certbot_config/renewal/shbvpn.conf
  HOOK=$certbot_config/renewal-hooks/deploy/shbvpn
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
SELF_ADDRESSES=()
CLEAR_SELF_ADDRESSES=0
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
    --self-address)
      (($# >= 2)) || die "--self-address needs a value"
      SELF_ADDRESSES+=("$2"); shift 2 ;;
    --clear-self-addresses) CLEAR_SELF_ADDRESSES=1; shift ;;
    --show-key) MODE=show-key; shift ;;
    --rotate) MODE=rotate; shift ;;
    --uninstall) MODE=uninstall; shift ;;
    -h|--help) usage; exit 0 ;;
    *) die "unknown option: $1" ;;
  esac
done

[[ $EUID -eq 0 ]] || die "run with sudo"

if [[ $MODE == rotate || $MODE == uninstall ]]; then lock_installation; fi

if [[ $MODE != install ]]; then
  [[ -z $KIND && $PORT_SET -eq 0 && -z $EMAIL && ${#SELF_ADDRESSES[@]} -eq 0 && $CLEAR_SELF_ADDRESSES -eq 0 ]] || die "management commands do not take install options"
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

delete_ufw_rule() {
  local rule=$1
  shift
  if [[ $rule == ipv4:* ]]; then
    ufw --force delete allow from 0.0.0.0/0 to any port "${rule#ipv4:}" proto tcp "$@"
  else
    ufw --force delete allow "$rule/tcp" "$@"
  fi
}

remove_firewall_rule() {
  local name=$1
  if [[ -f $STATE_DIR/"$name" ]] && command -v ufw >/dev/null 2>&1; then
    local rule
    rule=$(cat "$STATE_DIR/$name")
    delete_ufw_rule "$rule" || true
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
  systemctl disable --now shbvpn-renew.timer 2>/dev/null || true
  systemctl stop shbvpn-renew.service 2>/dev/null || true
  systemctl disable --now shbvpn-proxy.service shbvpn-acme.service 2>/dev/null || true
  rm -f "${UNIT_FILES[@]}"
  systemctl daemon-reload
  rm -f "$HOOK" "$PROXY_BIN"
  rm -f "$MANAGE_BIN"
  remove_firewall_rule ufw-proxy-added
  remove_firewall_rule ufw-http-added
  if [[ -x $CERTBOT ]]; then
    "$CERTBOT" "${CERTBOT_OPTIONS[@]}" delete --cert-name shbvpn --non-interactive || true
  fi
  rm -rf "$CONFIG_DIR" "$STATE_DIR" "$INSTALLED_ROOT"
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

lock_installation

if [[ -f $BACKEND_FILE ]]; then
  CERTBOT_BACKEND=$(cat "$BACKEND_FILE")
elif [[ ${VERSION_ID:-} == 26.04 ]] && snapd_masked; then
  CERTBOT_BACKEND=venv
else
  CERTBOT_BACKEND=snap
fi
select_certbot_backend "$CERTBOT_BACKEND"

python3 - "$ROOT_DIR/installer" "$KIND" "$HOST" "$PORT" "$EMAIL" "${SELF_ADDRESSES[@]}" <<'PY' || exit 1
import ipaddress
import re
import sys
sys.path.insert(0, sys.argv[1])
from public_ip import is_public_ip

kind, host, port, email = sys.argv[2:6]
if not port.isdecimal() or not (1 <= int(port) <= 65535) or int(port) == 80:
    sys.exit("Error: proxy port must be 1..65535 except 80")
if kind == "ip":
    try:
        ip = ipaddress.IPv4Address(host)
    except ipaddress.AddressValueError:
        sys.exit("Error: --ip requires a public IPv4 address")
    if not is_public_ip(host):
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
addresses = sys.argv[6:]
for address in addresses:
    if not is_public_ip(address):
        sys.exit("Error: --self-address requires a public IP address")
if len(set(addresses)) != len(addresses):
    sys.exit("Error: duplicate --self-address")
PY

FRESH_INSTALL=0
if [[ -f $CONFIG_FILE ]]; then
  python3 - "$ROOT_DIR/installer" "$CONFIG_FILE" "$KIND" "$HOST" "$PORT" <<'PY' || die "configuration changed; uninstall before changing host or port"
import json, sys
sys.path.insert(0, sys.argv[1])
from public_ip import is_public_ip

config = json.load(open(sys.argv[2], encoding="utf-8"))
if (config["kind"], config["host"], str(config["port"])) != tuple(sys.argv[3:]):
    sys.exit(1)
addresses = config.get("self_addresses", [])
if not isinstance(addresses, list) or any(not is_public_ip(address) for address in addresses):
    sys.exit("Error: stored self_addresses are invalid")
PY
  if ((${#SELF_ADDRESSES[@]} == 0 && CLEAR_SELF_ADDRESSES == 0)); then
    mapfile -t SELF_ADDRESSES < <(python3 - "$CONFIG_FILE" <<'PY'
import json, sys
for address in json.load(open(sys.argv[1], encoding="utf-8")).get("self_addresses", []):
    print(address)
PY
)
  fi
else
  # Only reserve paths that can be removed safely if the fresh installation fails.
  FRESH_PATHS=("$CONFIG_DIR" "$STATE_DIR" "$INSTALLED_ROOT" "$PROXY_BIN" "$PROXY_BIN.new" "$MANAGE_BIN" "$HOOK" "${UNIT_FILES[@]}")
  if [[ -n $CERTBOT_LOG_DIR ]]; then FRESH_PATHS+=("$CERTBOT_LOG_DIR"); fi
  for path in "${FRESH_PATHS[@]}" "$LINEAGE" "$RENEWAL_FILE" /etc/letsencrypt/renewal/shbvpn.conf; do
    if [[ -e $path || -L $path ]]; then die "existing resource conflicts with a fresh installation: $path"; fi
  done
  if id shbvpn >/dev/null 2>&1 || getent group shbvpn >/dev/null; then
    die "existing shbvpn user or group conflicts with a fresh installation"
  fi
  for unit in "${UNIT_FILES[@]##*/}"; do
    if systemctl cat "$unit" >/dev/null 2>&1; then die "existing unit conflicts with a fresh installation: $unit"; fi
  done
  python3 - "$PORT" <<'PY' || die "ports 80 and $PORT must be free before installation"
import socket
import sys
import errno

for port in (80, int(sys.argv[1])):
    for family, host in ((socket.AF_INET, "0.0.0.0"), (socket.AF_INET6, "::")):
        try:
            with socket.socket(family, socket.SOCK_STREAM) as listener:
                if family == socket.AF_INET6:
                    listener.setsockopt(socket.IPPROTO_IPV6, socket.IPV6_V6ONLY, 1)
                listener.bind((host, port))
        except OSError as error:
            if family == socket.AF_INET6 and error.errno in (errno.EAFNOSUPPORT, errno.EPROTONOSUPPORT, errno.EADDRNOTAVAIL):
                # IPv6 is disabled; Go will use IPv4 only.
                continue
            sys.exit(f"Error: TCP port {port} is unavailable on {host}: {error}")
PY
  FRESH_INSTALL=1
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

UPDATING=0
UPDATE_READY=0
UPDATE_COMPLETE=0
UPDATE_BACKUP=
TEMP_BIN=
FRESH_FIREWALL_RULES=()
FRESH_ENABLED_UNITS=()
FRESH_UNITS_LOADED=0
FRESH_USER_ATTEMPTED=0
FRESH_CERTBOT_ATTEMPTED=0
UPDATE_PATHS=(
  "$PROXY_BIN" "$MANAGE_BIN" "$HOOK"
  "$CONFIG_FILE"
  "$CONFIG_DIR/tls/fullchain.pem" "$CONFIG_DIR/tls/privkey.pem"
  "${UNIT_FILES[@]}"
)
if [[ $ROOT_DIR != "$INSTALLED_ROOT" ]]; then
  UPDATE_PATHS+=("$INSTALLED_ROOT/server" "$INSTALLED_ROOT/installer")
fi

restore_update_path() {
  local path=$1 saved=$UPDATE_BACKUP$1
  if [[ $path == "$PROXY_BIN" && -e $saved ]]; then
    cp -a "$saved" "$path.rollback" || return 1
    mv -f "$path.rollback" "$path" || return 1
    return 0
  fi
  rm -rf "$path" || return 1
  if [[ -e $saved || -L $saved ]]; then
    mkdir -p "$(dirname "$path")" || return 1
    cp -a "$saved" "$path" || return 1
  fi
}

restore_unit_state() {
  local unit=$1
  if [[ ${UPDATE_ENABLED[$unit]} == 1 ]]; then
    systemctl enable "$unit" >/dev/null || return 1
  else
    systemctl disable "$unit" >/dev/null || return 1
  fi
  if [[ ${UPDATE_ACTIVE[$unit]} == 1 ]]; then
    systemctl restart "$unit" || return 1
  else
    systemctl stop "$unit" || return 1
  fi
}

refresh_rollback_tls() {
  [[ -r $LINEAGE/fullchain.pem && -r $LINEAGE/privkey.pem ]] || return 1
  if cmp -s "$LINEAGE/fullchain.pem" "$CONFIG_DIR/tls/fullchain.pem" && cmp -s "$LINEAGE/privkey.pem" "$CONFIG_DIR/tls/privkey.pem"; then
    return 0
  fi
  install -o root -g shbvpn -m 0640 "$LINEAGE/fullchain.pem" "$CONFIG_DIR/tls/fullchain.pem.new" || return 1
  install -o root -g shbvpn -m 0640 "$LINEAGE/privkey.pem" "$CONFIG_DIR/tls/privkey.pem.new" || return 1
  mv -f "$CONFIG_DIR/tls/fullchain.pem.new" "$CONFIG_DIR/tls/fullchain.pem" || return 1
  mv -f "$CONFIG_DIR/tls/privkey.pem.new" "$CONFIG_DIR/tls/privkey.pem" || return 1
}

rollback_fresh_install() {
  local rule unit failed=0
  echo "Installation failed; removing resources from this attempt" >&2
  for unit in "${FRESH_ENABLED_UNITS[@]}"; do
    systemctl disable --now "$unit" || failed=1
    if [[ $unit == shbvpn-renew.timer ]]; then systemctl stop shbvpn-renew.service || failed=1; fi
  done
  for rule in "${FRESH_FIREWALL_RULES[@]}"; do
    delete_ufw_rule "$rule" comment 'SHB VPN' || { echo "Could not remove the UFW rule for ${rule#ipv4:}/tcp" >&2; failed=1; }
  done
  if ((FRESH_CERTBOT_ATTEMPTED)) && [[ -e $LINEAGE || -L $LINEAGE || -e $RENEWAL_FILE || -L $RENEWAL_FILE ]]; then
    "$CERTBOT" "${CERTBOT_OPTIONS[@]}" delete --cert-name shbvpn --non-interactive || {
      echo "Could not remove the Certbot lineage at $LINEAGE" >&2
      failed=1
    }
  fi
  rm -rf -- "${FRESH_PATHS[@]}" || failed=1
  if ((FRESH_UNITS_LOADED)); then systemctl daemon-reload || failed=1; fi
  if ((FRESH_USER_ATTEMPTED)); then
    if id shbvpn >/dev/null 2>&1; then userdel shbvpn || failed=1; fi
    if getent group shbvpn >/dev/null; then groupdel shbvpn || failed=1; fi
  fi
  if ((failed)); then
    echo "Fresh installation rollback was incomplete; inspect the errors above before retrying" >&2
  else
    echo "Fresh installation rolled back" >&2
  fi
}

cleanup_install() {
  local status=$? path unit rollback_failed=0 keep_backup=0
  trap - EXIT INT TERM
  set +e
  [[ -z $TEMP_BIN ]] || rm -f "$TEMP_BIN"
  if ((FRESH_INSTALL)); then
    if ((status != 0 && UPDATE_COMPLETE == 0)); then rollback_fresh_install; fi
    exit "$status"
  fi
  rm -f "$PROXY_BIN.new"
  rm -f "$CONFIG_FILE.new"
  if [[ $status -ne 0 && $UPDATING -eq 1 && $UPDATE_READY -eq 1 && $UPDATE_COMPLETE -eq 0 ]]; then
    echo "Installation failed; restoring the previous SHB VPN installation" >&2
    for path in "${UPDATE_PATHS[@]}"; do
      restore_update_path "$path" || { echo "Could not restore $path" >&2; rollback_failed=1; }
    done
    if ! refresh_rollback_tls; then
      echo "Could not deploy the current certificate lineage during rollback" >&2
      restore_update_path "$CONFIG_DIR/tls/fullchain.pem" || true
      restore_update_path "$CONFIG_DIR/tls/privkey.pem" || true
      rollback_failed=1
    fi
    rm -f "$CONFIG_DIR/tls/fullchain.pem.new" "$CONFIG_DIR/tls/privkey.pem.new"
    systemctl daemon-reload || rollback_failed=1
    for unit in shbvpn-acme.service shbvpn-proxy.service shbvpn-renew.timer; do
      restore_unit_state "$unit" || { echo "Could not restore $unit" >&2; rollback_failed=1; }
    done
    if [[ ${UPDATE_ACTIVE[shbvpn-proxy.service]} == 1 ]]; then
      python3 "$INSTALLED_ROOT/installer/healthcheck.py" || rollback_failed=1
    fi
    if [[ $rollback_failed -eq 1 ]]; then
      keep_backup=1
      echo "Rollback was incomplete; snapshot retained at $UPDATE_BACKUP" >&2
      echo "Inspect journalctl -u shbvpn-proxy.service -u shbvpn-acme.service" >&2
    else
      echo "Previous installation restored" >&2
    fi
  fi
  if [[ -n $UPDATE_BACKUP && $keep_backup -eq 0 ]]; then rm -rf "$UPDATE_BACKUP"; fi
  exit "$status"
}

if ((FRESH_INSTALL)); then
  trap cleanup_install EXIT
  trap 'exit 130' INT
  trap 'exit 143' TERM
fi

if ! id shbvpn >/dev/null 2>&1; then
  FRESH_USER_ATTEMPTED=$FRESH_INSTALL
  useradd --system --user-group --home-dir "$STATE_DIR" --shell /usr/sbin/nologin shbvpn
fi
install -d -o root -g shbvpn -m 0750 "$STATE_DIR"
install -d -o root -g shbvpn -m 0750 "$CONFIG_DIR" "$CONFIG_DIR/tls"
install -d -o root -g root -m 0755 "$ACME_DIR" "$ACME_DIR/.well-known" "$ACME_DIR/.well-known/acme-challenge"

if [[ ! -f $CONFIG_FILE ]]; then
  python3 - "$KIND" "$HOST" "$PORT" "${SELF_ADDRESSES[@]}" > "$CONFIG_FILE" <<'PY'
import json, sys
kind, host, port = sys.argv[1:4]
json.dump({"kind": kind, "host": host, "port": int(port), "self_addresses": sys.argv[4:]}, sys.stdout, separators=(",", ":"))
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
  install -d -o root -g root -m 0700 "$CONFIG_DIR/letsencrypt" "$STATE_DIR/certbot-work" "$CERTBOT_LOG_DIR"
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

trap cleanup_install EXIT
TEMP_BIN=$(mktemp)
(cd "$ROOT_DIR/server" && /usr/bin/go build -trimpath -o "$TEMP_BIN" .)

if [[ -e $PROXY_BIN ]]; then
  UPDATING=1
  UPDATE_BACKUP=$(mktemp -d "$CONFIG_DIR/update-backup.XXXXXX")
  for path in "${UPDATE_PATHS[@]}"; do
    if [[ -e $path || -L $path ]]; then
      mkdir -p "$UPDATE_BACKUP$(dirname "$path")"
      cp -a "$path" "$UPDATE_BACKUP$path"
    fi
  done
  declare -A UPDATE_ACTIVE UPDATE_ENABLED
  for unit in shbvpn-acme.service shbvpn-proxy.service shbvpn-renew.timer; do
    UPDATE_ACTIVE[$unit]=0
    UPDATE_ENABLED[$unit]=0
    if systemctl is-active --quiet "$unit"; then UPDATE_ACTIVE[$unit]=1; fi
    if systemctl is-enabled --quiet "$unit"; then UPDATE_ENABLED[$unit]=1; fi
  done
  UPDATE_READY=1
fi

python3 - "$CONFIG_FILE" "${SELF_ADDRESSES[@]}" > "$CONFIG_FILE.new" <<'PY'
import json, sys
with open(sys.argv[1], encoding="utf-8") as source:
    config = json.load(source)
config["self_addresses"] = sys.argv[2:]
json.dump(config, sys.stdout, separators=(",", ":"))
sys.stdout.write("\n")
PY
chmod 0600 "$CONFIG_FILE.new"
mv -f "$CONFIG_FILE.new" "$CONFIG_FILE"

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

SELF_ADDRESS_OPTIONS=
for address in "${SELF_ADDRESSES[@]}"; do
  SELF_ADDRESS_OPTIONS+=" --self-address $address"
done

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
ExecStart=$PROXY_BIN --listen :$PORT --cert $CONFIG_DIR/tls/fullchain.pem --key $CONFIG_DIR/tls/privkey.pem --credentials $CREDS_FILE --self-host $HOST$SELF_ADDRESS_OPTIONS
Restart=on-failure
RestartSec=5s
AmbientCapabilities=CAP_NET_BIND_SERVICE
CapabilityBoundingSet=CAP_NET_BIND_SERVICE
NoNewPrivileges=yes
ProtectSystem=strict
ProtectHome=yes
PrivateTmp=yes
PrivateDevices=yes
RestrictAddressFamilies=AF_INET AF_INET6 AF_UNIX AF_NETLINK

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
ExecStart=$INSTALLED_ROOT/installer/renew.sh
Restart=on-failure
RestartSec=1h
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
FRESH_UNITS_LOADED=$FRESH_INSTALL

enable_install_unit() {
  # Reverse activation order for rollback, including units only partly enabled.
  if ((FRESH_INSTALL)); then FRESH_ENABLED_UNITS=("$1" "${FRESH_ENABLED_UNITS[@]}"); fi
  systemctl enable --now "$1"
}

open_ufw_port() {
  local port=$1 marker=$2 status rule=$1
  local -a allow=("$port/tcp")
  if ! command -v ufw >/dev/null 2>&1; then return; fi
  status=$(LC_ALL=C ufw status) || die "could not inspect UFW rules"
  if grep -q '^Status: active$' <<< "$status"; then
    if ((FRESH_INSTALL)) && grep -Eq "^${port}/tcp[[:space:]]+(DENY|REJECT|LIMIT)([[:space:]]+IN)?[[:space:]]+Anywhere([[:space:]]*(#.*)?)?$" <<< "$status"; then
      die "an existing UFW rule manages $port/tcp; review it before installing"
    fi
    # A rule limited to one source or interface does not expose the public listener.
    if ! grep -Eq "^${port}/tcp[[:space:]]+ALLOW([[:space:]]+IN)?[[:space:]]+Anywhere([[:space:]]*(#.*)?)?$" <<< "$status"; then
      # A generic UFW rule also edits IPv6. Leave any existing IPv6 rule alone.
      if grep -Eq "^${port}/tcp[[:space:]]+\(v6\)[[:space:]]+(ALLOW|DENY|REJECT|LIMIT)([[:space:]]+IN)?[[:space:]]+Anywhere[[:space:]]+\(v6\)([[:space:]]*(#.*)?)?$" <<< "$status"; then
        allow=(from 0.0.0.0/0 to any port "$port" proto tcp)
        rule=ipv4:$port
      fi
      ufw allow "${allow[@]}" comment 'SHB VPN'
      if ((FRESH_INSTALL)); then FRESH_FIREWALL_RULES+=("$rule"); fi
      printf '%s\n' "$rule" > "$STATE_DIR/$marker"
    fi
  fi
}
open_ufw_port 80 ufw-http-added
open_ufw_port "$PORT" ufw-proxy-added

enable_install_unit shbvpn-acme.service
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
FRESH_CERTBOT_ATTEMPTED=$FRESH_INSTALL
"$CERTBOT" "${CERTBOT_OPTIONS[@]}" "${CERTBOT_ARGS[@]}"
[[ -r $LINEAGE/fullchain.pem && -r $LINEAGE/privkey.pem ]] || die "certificate files were not created"
RENEWED_LINEAGE=$LINEAGE "$HOOK"
enable_install_unit shbvpn-proxy.service
systemctl restart shbvpn-proxy.service
systemctl is-active --quiet shbvpn-proxy.service || die "proxy failed; check journalctl -u shbvpn-proxy"
python3 "$ROOT_DIR/installer/healthcheck.py"
PROXY_PID_BEFORE=$(systemctl show -p MainPID --value shbvpn-proxy.service)
"$CERTBOT" "${CERTBOT_OPTIONS[@]}" renew --dry-run --run-deploy-hooks --no-random-sleep-on-renew --cert-name shbvpn --quiet || die "certificate renewal dry run failed"
PROXY_PID_AFTER=$(systemctl show -p MainPID --value shbvpn-proxy.service)
[[ -n $PROXY_PID_AFTER && $PROXY_PID_AFTER != 0 && $PROXY_PID_AFTER != "$PROXY_PID_BEFORE" ]] || die "deploy hook did not restart the proxy during renewal dry run"
python3 "$ROOT_DIR/installer/healthcheck.py"
enable_install_unit shbvpn-renew.timer
systemctl is-active --quiet shbvpn-renew.timer || die "certificate renewal timer failed"
systemctl is-enabled --quiet shbvpn-renew.timer || die "certificate renewal timer is not enabled"

printf '\nInstallation complete. Import this key in the Chrome extension:\n'
show_key
printf '\nKeep this key private. The proxy is listening on %s:%s.\n' "$HOST" "$PORT"
UPDATE_COMPLETE=1
