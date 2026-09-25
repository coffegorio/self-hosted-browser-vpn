"""Portable path and connection options for the installer helper scripts."""

import base64
import contextlib
import importlib.util
import io
import json
import subprocess
import sys
import tempfile
import unittest
from pathlib import Path
from unittest import mock


ROOT = Path(__file__).resolve().parents[1]
PEM = "-----BEGIN CERTIFICATE-----\nAQID\n-----END CERTIFICATE-----\n"


def load_helper(name):
    spec = importlib.util.spec_from_file_location(name, ROOT / "installer" / (name + ".py"))
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


class InstallerHelperTests(unittest.TestCase):
    def make_config(self, directory, addresses=None):
        directory.mkdir(parents=True, exist_ok=True)
        (directory / "config.json").write_text(json.dumps({
            "host": "vpn.example.test", "port": 8443,
            "self_addresses": addresses or [],
        }), encoding="utf-8")
        (directory / "credentials").write_text("alice:pass:with:colons\n", encoding="utf-8")
        (directory / "tls").mkdir()
        (directory / "tls/fullchain.pem").write_text(PEM, encoding="ascii")

    def test_export_key_reads_alternate_config_directory(self):
        with tempfile.TemporaryDirectory() as temporary:
            config_dir = Path(temporary) / "mounted-config"
            self.make_config(config_dir)
            result = subprocess.run(
                [sys.executable, str(ROOT / "installer/export-key.py"),
                 "--config-dir", str(config_dir)],
                capture_output=True, text=True, check=True,
            )
            self.assertEqual(result.stderr, "")
            self.assertTrue(result.stdout.startswith("shbvpn1:"))
            encoded = result.stdout.strip().split(":", 1)[1]
            payload = json.loads(base64.urlsafe_b64decode(encoded + "=" * (-len(encoded) % 4)))
            self.assertEqual(payload, {
                "v": 1, "host": "vpn.example.test", "port": 8443,
                "username": "alice", "password": "pass:with:colons",
            })

    def test_export_key_no_argument_call_uses_default_directory(self):
        export_key = load_helper("export-key")
        with tempfile.TemporaryDirectory() as temporary:
            config_dir = Path(temporary)
            self.make_config(config_dir)
            output = io.StringIO()
            with mock.patch.object(export_key, "DEFAULT_CONFIG_DIR", config_dir):
                with contextlib.redirect_stdout(output):
                    export_key.main([])
            self.assertTrue(output.getvalue().startswith("shbvpn1:"))

    def test_healthcheck_uses_mounted_config_and_connection_overrides(self):
        healthcheck = load_helper("healthcheck")
        with tempfile.TemporaryDirectory() as temporary:
            config_dir = Path(temporary) / "mounted-config"
            self.make_config(config_dir, ["1.1.1.1", "2606:4700:4700::1111"])
            alternate_cert = Path(temporary) / "custom-fullchain.pem"
            alternate_cert.write_text(PEM.replace("AQID", "BAUG"), encoding="ascii")
            calls = []

            def fake_request(*args, **kwargs):
                calls.append((args, kwargs))
                return 407 if len(calls) == 1 else 403

            output = io.StringIO()
            with mock.patch.object(healthcheck, "request", side_effect=fake_request):
                with contextlib.redirect_stdout(output):
                    healthcheck.main([
                        "--config-dir", str(config_dir),
                        "--connect-host", "proxy-container",
                        "--connect-port", "9443",
                        "--tls-cert", str(alternate_cert),
                    ])

            self.assertEqual(output.getvalue(), "TLS, authentication and destination guards: OK\n")
            self.assertEqual(len(calls), 5)
            for args, kwargs in calls:
                self.assertEqual(args[:3], ("vpn.example.test", 9443, b"\x04\x05\x06"))
                self.assertEqual(kwargs["connect_host"], "proxy-container")
            self.assertEqual(calls[0][0][3:], ())
            self.assertEqual(calls[2][1]["method"], "CONNECT")
            self.assertEqual(calls[2][1]["target"], "vpn.example.test:443")
            self.assertEqual(calls[3][1]["target"], "1.1.1.1:443")
            self.assertEqual(calls[4][1]["target"], "[2606:4700:4700::1111]:443")

    def test_healthcheck_defaults_to_config_port_localhost_and_config_tls(self):
        healthcheck = load_helper("healthcheck")
        with tempfile.TemporaryDirectory() as temporary:
            config_dir = Path(temporary)
            self.make_config(config_dir)
            calls = []

            def fake_request(*args, **kwargs):
                calls.append((args, kwargs))
                return 407 if len(calls) == 1 else 403

            with mock.patch.object(healthcheck, "DEFAULT_CONFIG_DIR", config_dir):
                with mock.patch.object(healthcheck, "request", side_effect=fake_request):
                    with contextlib.redirect_stdout(io.StringIO()):
                        healthcheck.main([])

            self.assertEqual(len(calls), 3)
            for args, kwargs in calls:
                self.assertEqual(args[:3], ("vpn.example.test", 8443, b"\x01\x02\x03"))
                self.assertEqual(kwargs["connect_host"], "127.0.0.1")

    def test_request_connects_to_override_but_verifies_configured_hostname(self):
        healthcheck = load_helper("healthcheck")
        raw = mock.MagicMock()
        raw.__enter__.return_value = raw
        connection = mock.MagicMock()
        connection.__enter__.return_value = connection
        connection.getpeercert.return_value = b"certificate"
        connection.makefile.return_value = io.BytesIO(b"HTTP/1.1 407 Proxy Authentication Required\r\n")
        context = mock.MagicMock()
        context.wrap_socket.return_value = connection
        with mock.patch.object(healthcheck.socket, "create_connection", return_value=raw) as connect:
            with mock.patch.object(healthcheck.ssl, "create_default_context", return_value=context):
                status = healthcheck.request("vpn.example.test", 9443, b"certificate",
                                             connect_host="proxy-container")
        self.assertEqual(status, 407)
        connect.assert_called_once_with(("proxy-container", 9443), timeout=10)
        context.wrap_socket.assert_called_once_with(raw, server_hostname="vpn.example.test")
        self.assertIn(b"Host: 127.0.0.1\r\n", connection.sendall.call_args.args[0])


if __name__ == "__main__":
    unittest.main()
