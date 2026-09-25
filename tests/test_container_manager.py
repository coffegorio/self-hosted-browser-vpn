"""Portable container manager behavior without Docker, ACME, or network access."""

import importlib.util
import io
import json
import os
import tempfile
import unittest
from contextlib import redirect_stderr
from pathlib import Path
from unittest import mock


ROOT = Path(__file__).resolve().parents[1]
SPEC = importlib.util.spec_from_file_location("container_manager", ROOT / "deploy/manager.py")
manager = importlib.util.module_from_spec(SPEC)
SPEC.loader.exec_module(manager)


def settings(**updates):
    values = {"SHBVPN_KIND": "domain", "SHBVPN_HOST": "vpn.example.com",
              "SHBVPN_PORT": "8443", "SHBVPN_EMAIL": "admin@example.com"}
    values.update(updates)
    return values


class ManagerTests(unittest.TestCase):
    def setUp(self):
        self.temporary = tempfile.TemporaryDirectory()
        self.addCleanup(self.temporary.cleanup)
        base = Path(self.temporary.name)
        for name, path in (("RUNTIME", base / "runtime"),
                           ("CERTBOT_STATE", base / "certbot"),
                           ("ACME", base / "acme")):
            patcher = mock.patch.object(manager, name, path)
            patcher.start()
            self.addCleanup(patcher.stop)
        for name in ("chown", "fchown"):
            patcher = mock.patch.object(manager.os, name)
            patcher.start()
            self.addCleanup(patcher.stop)
        manager.STOP.clear()

    def test_validate_identity_and_public_extra_addresses(self):
        result = manager.validate_settings(settings(
            SHBVPN_SELF_ADDRESSES="1.1.1.1, 2606:4700:4700::1111"))
        self.assertEqual(result["self_addresses"], ["1.1.1.1", "2606:4700:4700::1111"])
        self.assertEqual(result["host"], "vpn.example.com")
        ip = manager.validate_settings(settings(SHBVPN_KIND="ip", SHBVPN_HOST="8.8.8.8"))
        self.assertEqual(ip["host"], "8.8.8.8")
        for extra in ("127.0.0.1", "192.0.2.1", "1.1.1.1,1.1.1.1", "1.1.1.1,",
                      "fe80::1", "8.8.8.8%bad"):
            with self.subTest(extra=extra), self.assertRaises(manager.ManagerError):
                manager.validate_settings(settings(SHBVPN_SELF_ADDRESSES=extra))
        for changes in ({"SHBVPN_KIND": "ip", "SHBVPN_HOST": "10.0.0.1"},
                        {"SHBVPN_KIND": "domain", "SHBVPN_HOST": "127.0.0.1"},
                        {"SHBVPN_PORT": "80"}, {"SHBVPN_PORT": "65536"},
                        {"SHBVPN_EMAIL": "bad address"},
                        {"SHBVPN_CLEAR_SELF_ADDRESSES": "1",
                         "SHBVPN_SELF_ADDRESSES": "1.1.1.1"}):
            with self.subTest(changes=changes), self.assertRaises(manager.ManagerError):
                manager.validate_settings(settings(**changes))

    def test_config_preserves_extras_unless_changed_or_explicitly_cleared(self):
        manager.prepare_directories()
        initial = manager.validate_settings(settings(SHBVPN_SELF_ADDRESSES="1.1.1.1"))
        manager.ensure_config(initial)
        self.assertEqual(manager.ensure_config(manager.validate_settings(settings()))[
            "self_addresses"], ["1.1.1.1"])
        self.assertEqual(manager.ensure_config(manager.validate_settings(settings(
            SHBVPN_SELF_ADDRESSES="")))["self_addresses"], ["1.1.1.1"])
        self.assertEqual(manager.ensure_config(manager.validate_settings(settings(
            SHBVPN_CLEAR_SELF_ADDRESSES="1")))["self_addresses"], [])
        self.assertEqual(json.loads((manager.RUNTIME / "config.json").read_text())[
            "self_addresses"], [])
        with self.assertRaises(manager.ManagerError):
            manager.ensure_config(manager.validate_settings(settings(SHBVPN_PORT="9443")))
        with self.assertRaises(manager.ManagerError):
            manager.ensure_config(manager.validate_settings(settings(SHBVPN_HOST="other.example.com")))

    def test_config_symlink_is_rejected(self):
        manager.prepare_directories()
        other = manager.RUNTIME / "outside.json"
        other.write_text("{}")
        (manager.RUNTIME / "config.json").symlink_to(other)
        with self.assertRaises(manager.ManagerError):
            manager.ensure_config(manager.validate_settings(settings()))

    def test_credentials_created_once_with_proxy_group_mode(self):
        manager.prepare_directories()
        manager.ensure_credentials()
        credentials = manager.RUNTIME / "credentials"
        first = credentials.read_text()
        self.assertRegex(first, r"^browser:[A-Za-z0-9_-]+\n$")
        self.assertEqual(credentials.stat().st_mode & 0o777, 0o640)
        manager.ensure_credentials()
        self.assertEqual(credentials.read_text(), first)
        credentials.write_text("browser:password\n\n")
        with self.assertRaises(manager.ManagerError):
            manager.ensure_credentials()

    def test_certbot_uses_persistent_state_and_explicit_ip_profile(self):
        config = {"kind": "ip", "host": "8.8.8.8", "port": 8443}
        command = manager.certbot_command(config, "", True)
        self.assertEqual(command[:2], ["certbot", "--config-dir"])
        for value in (str(manager.CERTBOT_STATE / "config"),
                      str(manager.CERTBOT_STATE / "work"),
                      str(manager.CERTBOT_STATE / "logs"),
                      "--ip-address", "8.8.8.8", "--preferred-profile", "shortlived",
                      "--webroot-path", str(manager.ACME),
                      "--register-unsafely-without-email"):
            self.assertIn(value, command)
        self.assertNotIn("-d", command)
        domain = manager.certbot_command({"kind": "domain", "host": "vpn.example.com"},
                                         "admin@example.com", True)
        self.assertIn("-d", domain)
        self.assertIn("vpn.example.com", domain)
        self.assertNotIn("--ip-address", domain)
        renew = manager.certbot_command(config, "", False)
        self.assertEqual(renew[-5:], ["renew", "--cert-name", "shbvpn",
                                     "--no-random-sleep-on-renew", "--quiet"])

    def test_publish_switches_both_files_by_one_symlink_and_keeps_old_version(self):
        manager.prepare_directories()
        cert, key = manager.lineage_paths()
        cert.parent.mkdir(parents=True)
        cert.write_bytes(b"cert-one")
        key.write_bytes(b"key-one")
        with mock.patch.object(manager, "validate_pair") as validate:
            self.assertIsNone(manager.publish_certificate())
            first_version = os.readlink(manager.RUNTIME / "tls/current")
            self.assertEqual((manager.RUNTIME / "tls/current/fullchain.pem").read_bytes(), b"cert-one")
            self.assertEqual((manager.RUNTIME / "tls/current/privkey.pem").read_bytes(), b"key-one")
            self.assertEqual((manager.RUNTIME / "tls/current/privkey.pem").stat().st_mode & 0o777,
                             0o640)
            self.assertIsNone(manager.publish_certificate())
            self.assertEqual(validate.call_count, 1)
            cert.write_bytes(b"cert-two")
            key.write_bytes(b"key-two")
            self.assertEqual(manager.publish_certificate(), first_version)
        self.assertNotEqual(os.readlink(manager.RUNTIME / "tls/current"), first_version)
        self.assertEqual((manager.RUNTIME / "tls/current/fullchain.pem").read_bytes(), b"cert-two")
        self.assertEqual((manager.RUNTIME / "tls/current/privkey.pem").read_bytes(), b"key-two")
        self.assertEqual((manager.RUNTIME / "tls" / first_version / "fullchain.pem").read_bytes(),
                         b"cert-one")

    def test_invalid_new_pair_does_not_change_current_symlink(self):
        manager.prepare_directories()
        cert, key = manager.lineage_paths()
        cert.parent.mkdir(parents=True)
        cert.write_bytes(b"cert-one")
        key.write_bytes(b"key-one")
        with mock.patch.object(manager, "validate_pair"):
            manager.publish_certificate()
        original = os.readlink(manager.RUNTIME / "tls/current")
        cert.write_bytes(b"bad-cert")
        with mock.patch.object(manager, "validate_pair", side_effect=manager.ManagerError("bad pair")):
            with self.assertRaises(manager.ManagerError):
                manager.publish_certificate()
        self.assertEqual(os.readlink(manager.RUNTIME / "tls/current"), original)

    def test_run_cycle_rolls_back_published_version_when_live_check_fails(self):
        with mock.patch.multiple(manager, prepare_directories=mock.DEFAULT,
                                 ensure_config=mock.DEFAULT, ensure_credentials=mock.DEFAULT,
                                 wait_for_acme=mock.DEFAULT, run_external=mock.DEFAULT,
                                 publish_certificate=mock.DEFAULT,
                                 run_healthcheck=mock.DEFAULT,
                                 switch_to_version=mock.DEFAULT) as patched:
            patched["ensure_config"].return_value = {"kind": "domain", "host": "vpn.example.com"}
            patched["publish_certificate"].return_value = "version-old"
            patched["run_healthcheck"].side_effect = manager.ManagerError("health failed")
            with self.assertRaises(manager.ManagerError):
                manager.run_cycle(settings())
            patched["switch_to_version"].assert_called_once_with("version-old")
            self.assertIn("certonly", patched["run_external"].call_args.args[0])

    def test_certbot_failure_still_reconciles_written_lineage(self):
        cert, key = manager.lineage_paths()
        cert.parent.mkdir(parents=True)
        cert.write_text("issued cert")
        key.write_text("issued key")
        with mock.patch.multiple(manager, prepare_directories=mock.DEFAULT,
                                 ensure_config=mock.DEFAULT, ensure_credentials=mock.DEFAULT,
                                 wait_for_acme=mock.DEFAULT, run_external=mock.DEFAULT,
                                 publish_certificate=mock.DEFAULT,
                                 run_healthcheck=mock.DEFAULT) as patched:
            patched["ensure_config"].return_value = {"kind": "domain", "host": "vpn.example.com"}
            patched["run_external"].side_effect = manager.ManagerError("Certbot failed (exit 1)")
            with self.assertRaisesRegex(manager.ManagerError, "Certbot failed"):
                manager.run_cycle(settings())
            patched["publish_certificate"].assert_called_once()
            patched["run_healthcheck"].assert_called_once()
            self.assertIn("renew", patched["run_external"].call_args.args[0])

    def test_health_subcommand_calls_live_healthcheck_and_returns_failure(self):
        with mock.patch.object(manager, "verify_published_pair") as verify:
            with mock.patch.object(manager, "run_healthcheck") as health:
                self.assertEqual(manager.main(["health"]), 0)
                verify.assert_called_once()
                health.assert_called_once()
                health.side_effect = manager.ManagerError("secret-safe failure")
                output = io.StringIO()
                with redirect_stderr(output):
                    self.assertEqual(manager.main(["health"]), 1)
                self.assertEqual(output.getvalue(), "Container proxy health check failed\n")

    def test_live_healthcheck_retries_transient_startup_or_tls_switch(self):
        with mock.patch.object(manager, "run_external", side_effect=[
            manager.ManagerError("old certificate"), None,
        ]) as run:
            with mock.patch.object(manager.STOP, "wait", return_value=False):
                manager.run_healthcheck(timeout=15)
        self.assertEqual(run.call_count, 2)
        self.assertEqual(run.call_args.args[0][-1],
                         str(manager.RUNTIME / "tls/current/fullchain.pem"))

    def test_rotate_replaces_key_and_calls_export_helper(self):
        manager.prepare_directories()
        manager.ensure_config(manager.validate_settings(settings()))
        manager.ensure_credentials()
        before = (manager.RUNTIME / "credentials").read_text()
        with mock.patch.object(manager.subprocess, "run") as command:
            with redirect_stderr(io.StringIO()):
                manager.rotate_credentials()
        self.assertNotEqual((manager.RUNTIME / "credentials").read_text(), before)
        self.assertEqual(command.call_args.args[0][-2:], ["--config-dir", str(manager.RUNTIME)])


if __name__ == "__main__":
    unittest.main()
