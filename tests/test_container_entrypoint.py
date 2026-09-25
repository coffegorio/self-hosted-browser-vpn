"""Container startup must wait for persisted state and pass it to Go unchanged."""

import importlib.util
import json
import tempfile
import unittest
from pathlib import Path
from unittest import mock


ROOT = Path(__file__).resolve().parents[1]
SPEC = importlib.util.spec_from_file_location("run_server", ROOT / "deploy/run_server.py")
run_server = importlib.util.module_from_spec(SPEC)
SPEC.loader.exec_module(run_server)


class ContainerEntrypointTests(unittest.TestCase):
    def test_proxy_arguments_preserve_persisted_host_and_extra_addresses(self):
        with mock.patch.object(run_server, "RUNTIME", Path("/mounted/runtime")):
            arguments = run_server.proxy_arguments({
                "host": "vpn.example.test",
                "self_addresses": ["1.1.1.1", "2606:4700:4700::1111"],
            })
        self.assertEqual(arguments, [
            run_server.SERVER,
            "--listen", ":8443",
            "--cert", "/mounted/runtime/tls/current/fullchain.pem",
            "--key", "/mounted/runtime/tls/current/privkey.pem",
            "--credentials", "/mounted/runtime/credentials",
            "--self-host", "vpn.example.test",
            "--self-address", "1.1.1.1",
            "--self-address", "2606:4700:4700::1111",
        ])

    def test_proxy_waits_until_manager_has_published_all_runtime_files(self):
        with tempfile.TemporaryDirectory() as temporary:
            runtime = Path(temporary)

            def publish_state(_delay):
                (runtime / "config.json").write_text(json.dumps({
                    "host": "vpn.example.test", "self_addresses": ["1.1.1.1"],
                }), encoding="utf-8")
                (runtime / "credentials").write_text("browser:secret\n", encoding="utf-8")
                tls = runtime / "tls/current"
                tls.mkdir(parents=True)
                (tls / "fullchain.pem").write_text("certificate", encoding="ascii")
                (tls / "privkey.pem").write_text("private key", encoding="ascii")

            with mock.patch.object(run_server, "RUNTIME", runtime), \
                    mock.patch.object(run_server.time, "sleep", side_effect=publish_state) as sleep, \
                    mock.patch.object(run_server.os, "execv") as execv:
                run_server.run_proxy()

            sleep.assert_called_once_with(2)
            executable, arguments = execv.call_args.args
            self.assertEqual(executable, run_server.SERVER)
            self.assertIn("vpn.example.test", arguments)
            self.assertEqual(arguments[-2:], ["--self-address", "1.1.1.1"])

    def test_runtime_file_replacement_race_retries(self):
        disappearing = mock.Mock()
        disappearing.is_file.return_value = True
        disappearing.stat.side_effect = FileNotFoundError("atomic replacement")
        self.assertFalse(run_server.runtime_ready((disappearing,)))

    def test_invalid_persisted_address_shape_is_rejected(self):
        with self.assertRaises(ValueError):
            run_server.proxy_arguments({"host": "vpn.example.test", "self_addresses": "1.1.1.1"})


if __name__ == "__main__":
    unittest.main()
