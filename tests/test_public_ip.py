"""Guard installer inputs that become proxy addresses and systemd arguments."""

import sys
import unittest
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[1] / "installer"))
from public_ip import is_public_ip


class PublicIPTests(unittest.TestCase):
    def test_accepts_public_ingress_addresses(self):
        for address in ("1.1.1.1", "2606:4700:4700::1111", "::ffff:1.1.1.1"):
            with self.subTest(address=address):
                self.assertTrue(is_public_ip(address))

    def test_rejects_special_and_scoped_addresses(self):
        for address in (
            "127.0.0.1", "192.0.0.9", "192.88.99.1", "224.0.0.1",
            "::ffff:239.1.2.3", "2002::1", "64:ff9b:1::1",
            "2001:4860::1%eth0\nInjected=1",
        ):
            with self.subTest(address=address):
                self.assertFalse(is_public_ip(address))


if __name__ == "__main__":
    unittest.main()
