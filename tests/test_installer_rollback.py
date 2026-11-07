"""Run the Ubuntu installer against a temporary host with stubbed services."""

import json
import os
import re
import shutil
import subprocess
import tempfile
import unittest
from pathlib import Path


ROOT = Path(__file__).resolve().parents[1]

COMMANDS = r"""
# macOS Bash 3 treats an initialized empty array as unset under nounset.
if ((BASH_VERSINFO[0] < 4 || BASH_VERSINFO[0] == 4 && BASH_VERSINFO[1] < 4)); then set +u; fi
flock() { :; }
id() { [[ -e $MOCK/user ]]; }
getent() { [[ -e $MOCK/group ]]; }
useradd() { touch "$MOCK/user" "$MOCK/group"; }
userdel() { rm "$MOCK/user"; }
groupdel() { rm "$MOCK/group"; }
chown() { :; }
dpkg-query() { echo 'install ok installed'; }
snap() { :; }
timeout() { :; }
install() {
  local -a args=()
  while (($#)); do
    case "$1" in
      -o|-g) shift 2 ;;
      *) args+=("$1"); shift ;;
    esac
  done
  command install "${args[@]}"
}
python3() {
  if [[ $1 == - && $# == 2 && $2 == [0-9]* ]]; then cat >/dev/null; return; fi
  if [[ $1 == */healthcheck.py ]]; then return 0; fi
  command python3 "$@"
}
systemctl() {
  echo "systemctl $*" >> "$MOCK/commands"
  case "$1" in
    cat) return 1 ;;
    enable) touch "$MOCK/enabled.$3" "$MOCK/active.$3" ;;
    restart) touch "$MOCK/active.$2" ;;
    is-active) [[ -e $MOCK/active.$3 ]] ;;
    is-enabled) [[ -e $MOCK/enabled.$3 ]] ;;
    show) if [[ -e $MOCK/renewed ]]; then echo 12; else echo 11; fi ;;
    stop) rm -f "$MOCK/active.$2" ;;
    disable)
      shift 2
      local unit
      for unit in "$@"; do rm -f "$MOCK/enabled.$unit" "$MOCK/active.$unit"; done ;;
  esac
}
ufw() {
  echo "ufw $*" >> "$MOCK/commands"
  if [[ $1 == status ]]; then
    printf 'Status: active\n80/tcp ALLOW Anywhere\n443/tcp (v6) ALLOW Anywhere (v6) # original\n'
  fi
}
"""


class InstallerRollbackTests(unittest.TestCase):
    def setUp(self):
        temporary = tempfile.TemporaryDirectory()
        self.addCleanup(temporary.cleanup)
        self.host = Path(temporary.name)
        self.config = self.host / "etc/shbvpn/config.json"
        self.lineage = self.host / "etc/letsencrypt/live/shbvpn"
        self.original_certificate = self.host / "etc/letsencrypt/live/other/fullchain.pem"
        self.write(self.original_certificate, "original certificate")
        self.write(self.host / "etc/os-release", "ID=ubuntu\nVERSION_ID=24.04\n")
        (self.host / "etc/systemd/system").mkdir(parents=True)
        (self.host / "run").mkdir()
        (self.host / "usr/local/bin").mkdir(parents=True)
        (self.host / "usr/local/sbin").mkdir(parents=True)
        self.write(self.host / "checkout/server/go.mod", "module fixture\n")
        self.write(self.host / "checkout/server/main.go", "package main\n")
        self.write(self.host / "checkout/installer/export-key.py", "print('fixture key')\n")
        self.executable("checkout/installer/deploy-hook.sh", "exit 0\n")
        shutil.copy(ROOT / "installer/public_ip.py", self.host / "checkout/installer")
        self.executable("usr/bin/go", '[[ $FAIL_AT != build ]] || exit 17\nprintf binary > "$4"\n')
        self.executable("snap/bin/certbot", r'''
set -e
echo "certbot $*" >> "$MOCK/commands"
case "$1" in
  certonly)
    [[ $FAIL_AT != issuance ]] || exit 19
    mkdir -p "$MOCK/etc/letsencrypt/live/shbvpn"
    touch "$MOCK/etc/letsencrypt/live/shbvpn/"{fullchain.pem,privkey.pem} ;;
  renew)
    [[ $FAIL_AT != dry-run ]] || exit 21
    touch "$MOCK/renewed" ;;
  delete)
    [[ $2 == --cert-name && $3 == shbvpn ]] || exit 22
    rm -r "$MOCK/etc/letsencrypt/live/shbvpn" ;;
esac
''')
        source = (ROOT / "installer/install.sh").read_text(encoding="utf-8")
        source = re.sub(r"/etc/|/var/|/usr/local/|/usr/bin/go|/run/|/snap/", lambda match: str(self.host) + match[0], source)
        source = source.replace('[[ $EUID -eq 0 ]]', 'true')
        source = source.replace("set -Eeuo pipefail\n", "set -Eeuo pipefail\n" + COMMANDS, 1)
        self.script = self.host / "checkout/installer/install.sh"
        self.write(self.script, source)

    def write(self, path, text):
        path.parent.mkdir(parents=True, exist_ok=True)
        path.write_text(text, encoding="utf-8")

    def executable(self, path, body):
        path = self.host / path
        self.write(path, "#!/usr/bin/env bash\n" + body)
        path.chmod(0o700)

    def run_install(self, fail_at="", host="proxy.example.com"):
        return subprocess.run(
            ["bash", str(self.script), "--domain", host],
            env={**os.environ, "MOCK": str(self.host), "FAIL_AT": fail_at},
            text=True, capture_output=True, timeout=15,
        )

    def commands(self):
        return (self.host / "commands").read_text(encoding="utf-8")

    def assert_clean(self):
        for path in (
            "etc/shbvpn", "var/lib/shbvpn", "usr/local/share/shbvpn", "usr/local/bin/shbvpn-proxy",
            "usr/local/sbin/shbvpn", "etc/letsencrypt/renewal-hooks/deploy/shbvpn", "user", "group",
        ):
            self.assertFalse((self.host / path).exists(), path)
        self.assertFalse(list((self.host / "etc/systemd/system").glob("shbvpn-*")))
        self.assertFalse(list(self.host.glob("active.shbvpn-*")))
        self.assertFalse(list(self.host.glob("enabled.shbvpn-*")))
        self.assertTrue(self.original_certificate.is_file())
        self.assertFalse(self.lineage.exists())

    def test_build_failure_cleans_bootstrap_state_without_touching_services(self):
        result = self.run_install("build")
        self.assertEqual(result.returncode, 17, result.stderr)
        self.assertIn("Fresh installation rolled back", result.stderr)
        self.assertNotIn("systemctl disable", self.commands())
        self.assertNotIn("certbot delete", self.commands())
        self.assert_clean()

    def test_issuance_failure_reverses_only_the_added_ufw_rule(self):
        result = self.run_install("issuance")
        self.assertEqual(result.returncode, 19, result.stderr)
        commands = self.commands()
        self.assertIn("systemctl enable --now shbvpn-acme.service", commands)
        self.assertNotIn("certbot delete", commands)
        self.assertEqual(
            [line for line in commands.splitlines() if line.startswith("ufw --force")],
            ["ufw --force delete allow from 0.0.0.0/0 to any port 443 proto tcp"],
        )
        self.assert_clean()

    def test_dry_run_failure_cleans_issued_certificate_and_allows_corrected_retry(self):
        result = self.run_install("dry-run")
        self.assertEqual(result.returncode, 1, result.stderr)
        self.assertIn("certificate renewal dry run failed", result.stderr)
        commands = self.commands()
        self.assertIn("systemctl enable --now shbvpn-proxy.service", commands)
        self.assertNotIn("systemctl enable --now shbvpn-renew.timer", commands)
        self.assertIn("certbot delete --cert-name shbvpn --non-interactive", commands)
        self.assert_clean()

        retry = self.run_install(host="corrected.example.com")
        self.assertEqual(retry.returncode, 0, retry.stderr)
        self.assertIn("systemctl enable --now shbvpn-renew.timer", self.commands())
        self.assertEqual(json.loads(self.config.read_text())["host"], "corrected.example.com")

    def test_existing_configuration_is_preserved_when_installation_is_refused(self):
        original = '{"kind":"domain","host":"old.example.com","port":443}'
        self.write(self.config, original)
        result = self.run_install()
        self.assertEqual(result.returncode, 1, result.stderr)
        self.assertIn("configuration changed", result.stderr)
        self.assertEqual(self.config.read_text(), original)
        self.assertFalse((self.host / "commands").exists())


if __name__ == "__main__":
    unittest.main()
