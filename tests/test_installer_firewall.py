"""Exercise the installer's UFW decisions without root or a real firewall."""

import os
import shlex
import subprocess
import tempfile
import unittest
from pathlib import Path


ROOT = Path(__file__).resolve().parents[1]
INSTALLER = (ROOT / "installer/install.sh").read_text(encoding="utf-8")
START = INSTALLER.index("open_ufw_port() {")
FUNCTION = INSTALLER[START:INSTALLER.index("\nopen_ufw_port 80", START)]


class InstallerFirewallTests(unittest.TestCase):
    def run_rule(self, status, port="80", fail_status=False, fail_allow=False):
        with tempfile.TemporaryDirectory() as temporary:
            directory = Path(temporary)
            function = FUNCTION.replace("/var/lib/shbvpn/", str(directory) + "/")
            script = """set -Eeuo pipefail
die() { printf '%s\\n' "$*" >&2; exit 1; }
ufw() {
  if [[ $1 == status ]]; then
    [[ $FAIL_STATUS == 0 ]] || return 1
    printf '%s\\n' "$UFW_STATUS"
  else
    [[ $FAIL_ALLOW == 0 ]] || return 1
    printf '%s\\n' "$*"
  fi
}
""" + function + "\nopen_ufw_port " + shlex.quote(port) + " ufw-added\n"
            result = subprocess.run(
                ["bash"], input=script, text=True, capture_output=True,
                env={**os.environ, "UFW_STATUS": status,
                     "FAIL_STATUS": str(int(fail_status)), "FAIL_ALLOW": str(int(fail_allow))},
            )
            marker = directory / "ufw-added"
            return result, marker.read_text() if marker.exists() else None

    def test_source_or_interface_limited_rules_do_not_skip_public_allow(self):
        for rule in (
            "80/tcp                     ALLOW       203.0.113.7",
            "80/tcp                     ALLOW IN    10.0.0.0/8",
            "80/tcp on eth1             ALLOW       Anywhere",
            "8080/tcp                   ALLOW       Anywhere",
        ):
            with self.subTest(rule=rule):
                result, marker = self.run_rule("Status: active\n\n" + rule)
                self.assertEqual(result.returncode, 0, result.stderr)
                self.assertEqual(result.stdout, "allow 80/tcp comment SHB VPN\n")
                self.assertEqual(marker, "80\n")

    def test_existing_public_rule_is_preserved_without_an_ownership_marker(self):
        for rule in (
            "80/tcp                     ALLOW       Anywhere",
            "80/tcp                     ALLOW IN    Anywhere",
            "80/tcp                     ALLOW       Anywhere                   # existing rule",
        ):
            with self.subTest(rule=rule):
                result, marker = self.run_rule("Status: active\n\n" + rule)
                self.assertEqual(result.returncode, 0, result.stderr)
                self.assertEqual(result.stdout, "")
                self.assertIsNone(marker)

    def test_inactive_firewall_is_not_enabled(self):
        result, marker = self.run_rule("Status: inactive")
        self.assertEqual(result.returncode, 0, result.stderr)
        self.assertEqual(result.stdout, "")
        self.assertIsNone(marker)

    def test_custom_proxy_port_is_opened(self):
        result, marker = self.run_rule("Status: active\n8443/tcp ALLOW 203.0.113.7", "8443")
        self.assertEqual(result.returncode, 0, result.stderr)
        self.assertEqual(result.stdout, "allow 8443/tcp comment SHB VPN\n")
        self.assertEqual(marker, "8443\n")

    def test_ufw_failures_are_reported_without_claiming_rule_ownership(self):
        for failure in ("fail_status", "fail_allow"):
            with self.subTest(failure=failure):
                result, marker = self.run_rule("Status: active", **{failure: True})
                self.assertNotEqual(result.returncode, 0)
                self.assertIsNone(marker)


if __name__ == "__main__":
    unittest.main()
