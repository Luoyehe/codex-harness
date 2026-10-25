import unittest

from deploy.common import DeployError
from deploy.units import validate_origin


class OriginTests(unittest.TestCase):
    def test_browser_canonical_origin_is_used_for_default_ports_and_ipv6(self):
        cases = {
            "http://LOCALHOST:80/": "http://localhost",
            "https://Work.Example.test:443/": "https://work.example.test",
            "http://127.0.0.1:33125": "http://127.0.0.1:33125",
            "http://[0:0:0:0:0:0:0:1]:80": "http://[::1]",
            "https://[fd00:0000::1]:18443": "https://[fd00::1]:18443",
        }
        for value, expected in cases.items():
            with self.subTest(value=value):
                self.assertEqual(validate_origin(value), expected)

    def test_unsupported_plain_http_and_ambiguous_origins_fail_before_install(self):
        for value in ("http://192.168.1.120:3300", "http://example.test", "http://127.1:3300",
                      "http://localhost./", "https://user@example.test", "https://example.test/path",
                      "https://[broken", "https://example.test:70000", "https://example.test?token=x",
                      "https://127.1", "https://2130706433", "https://0x7f000001", "https://[v1.foo]", None):
            with self.subTest(value=value):
                with self.assertRaises(DeployError):
                    validate_origin(value)


if __name__ == "__main__":
    unittest.main()
