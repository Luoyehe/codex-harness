"""Built-in account operator inputs and bounded loopback authentication probe."""
import hashlib
import hmac
import http.server
import io
import json
import unittest
import threading
from urllib.parse import parse_qs, urlsplit
from types import SimpleNamespace
from unittest.mock import MagicMock, patch

from deploy.accounts import account_request, bootstrap, read_password, validate_credentials, verify_account_login
from deploy.cli import parser
from deploy.common import DeployError


class AccountCredentialsTests(unittest.TestCase):
    def test_scrypt_bootstrap_uses_independent_salts_and_preserves_password_spaces(self):
        password = "  synthetic account password  "
        first, second = bootstrap("admin", password), bootstrap("admin", password)
        self.assertNotEqual(first["revision"], second["revision"])
        self.assertNotEqual(first["passwordHash"]["salt"], second["passwordHash"]["salt"])
        value = first["passwordHash"]
        self.assertEqual(value["N"], 32768)
        actual = hashlib.scrypt(password.encode(), salt=bytes.fromhex(value["salt"]), n=value["N"], r=value["r"],
                                p=value["p"], dklen=64, maxmem=64 * 1024 * 1024)
        self.assertEqual(actual.hex(), value["hash"])
        self.assertNotIn(password, json.dumps(first))

    def test_password_validation_uses_unicode_codepoints_and_rejects_invalid_text(self):
        validate_credentials("A.d_m-1", "😀" * 256)
        for password in ("short", "😀" * 257, "x" * 11 + "\0", "x" * 12 + "\ud800", 123):
            with self.subTest(password_type=type(password).__name__), self.assertRaises(DeployError):
                validate_credentials("admin", password)
        for username in ("", "has space", "a" * 65, "名字", "../admin"):
            with self.subTest(username=username), self.assertRaises(DeployError):
                validate_credentials(username, "synthetic-password")

    def test_password_stdin_is_bounded_single_line_and_never_strips_spaces(self):
        with patch("deploy.accounts.sys.stdin", io.StringIO("  synthetic password  \n")):
            self.assertEqual(read_password(from_stdin=True), "  synthetic password  ")
        for value in ("x" * 1026, "synthetic password\nsecond line\n"):
            with patch("deploy.accounts.sys.stdin", io.StringIO(value)), self.assertRaises(DeployError):
                read_password(from_stdin=True)

    def test_new_https_parser_needs_no_auth_domain_or_email(self):
        args = parser().parse_args(["https", "--host", "work.example.test", "--password-stdin"])
        self.assertIsNone(args.auth_host)
        self.assertIsNone(args.cookie_domain)
        self.assertIsNone(args.email)
        reset = parser().parse_args(["account-reset", "--password-stdin", "--username", "operator"])
        self.assertEqual(reset.username, "operator")
        self.assertTrue(reset.password_stdin)


class AccountProbeTests(unittest.TestCase):
    def setUp(self):
        self.manager = SimpleNamespace(config={"origin": "https://work.example.test:18443", "port": 3300})

    def test_login_probe_revokes_its_session_and_preserves_second_factor(self):
        responses = [({"authenticationMode": "account", "initialized": True}, None),
                     ({"authenticated": True, "csrf": "synthetic-csrf"}, "harness_fixture=synthetic-session; Path=/; HttpOnly"),
                     ({"authenticated": False}, None)]
        with patch("deploy.accounts.account_request", side_effect=responses) as call:
            verify_account_login(self.manager, "admin", "synthetic-password", "123456")
        self.assertEqual(call.call_args_list[1].args[2], {"username": "admin", "password": "synthetic-password", "otp": "123456"})
        self.assertEqual(call.call_args_list[2].kwargs, {"cookie": "harness_fixture=synthetic-session", "csrf": "synthetic-csrf"})

    def test_legacy_or_uninitialized_gateway_never_receives_password(self):
        for status in ({"authenticated": False}, {"authenticationMode": "account", "initialized": False}):
            with patch("deploy.accounts.account_request", return_value=(status, None)) as call, self.assertRaises(DeployError):
                verify_account_login(self.manager, "admin", "synthetic-password")
            self.assertEqual(call.call_count, 1)

    def test_requests_are_fixed_loopback_with_exact_origin_and_no_redirects(self):
        connection = MagicMock()
        response = connection.getresponse.return_value
        response.status = 200
        response.read.return_value = b'{"initialized":true,"authenticationMode":"account"}'
        response.getheader.return_value = None
        with patch("deploy.accounts.http.client.HTTPConnection", return_value=connection) as constructor, patch("deploy.accounts.verify_server"):
            result, _ = account_request(self.manager, "GET")
        constructor.assert_called_once_with("127.0.0.1", 3300, timeout=15)
        self.assertEqual(connection.request.call_args.kwargs["headers"]["Host"], "work.example.test:18443")
        self.assertTrue(result["initialized"])
        connection.close.assert_called_once()
        response.status = 302
        with patch("deploy.accounts.http.client.HTTPConnection", return_value=connection), patch("deploy.accounts.verify_server"), self.assertRaises(DeployError):
            account_request(self.manager, "GET")

    def test_oversized_or_nonobject_probe_output_cannot_confirm_authentication(self):
        for body in (b"x" * (16 * 1024 + 1), b"[]", b"not json"):
            connection = MagicMock()
            connection.getresponse.return_value.status = 200
            connection.getresponse.return_value.read.return_value = body
            with patch("deploy.accounts.http.client.HTTPConnection", return_value=connection), patch("deploy.accounts.verify_server"), self.assertRaises(DeployError):
                account_request(self.manager, "GET")


class ProofListenerTests(unittest.TestCase):
    def setUp(self):
        self.key = hashlib.sha256(b"synthetic-proof-key-only").digest()
        self.requests = []
        self.nonces = []
        self.mode = "valid"
        self.origin = "https://work.example.test:18443"
        owner = self
        class Listener(http.server.BaseHTTPRequestHandler):
            protocol_version = "HTTP/1.1"
            def log_message(self, *args):
                pass
            def respond(self, value):
                encoded = json.dumps(value).encode()
                self.send_response(200)
                self.send_header("Content-Type", "application/json")
                self.send_header("Content-Length", str(len(encoded)))
                if owner.mode == "close":
                    self.send_header("Connection", "close")
                    self.close_connection = True
                self.end_headers()
                self.wfile.write(encoded)
            def do_GET(self):
                if self.path == "/api/session":
                    owner.requests.append(("GET_SESSION", self.client_address[1], self.headers.get("Cookie")))
                    self.respond({"authenticationMode": "account", "initialized": False})
                    return
                owner.requests.append(("GET", self.client_address[1], self.headers.get("Cookie")))
                nonce = parse_qs(urlsplit(self.path).query)["nonce"][0]
                owner.nonces.append(nonce)
                signed_nonce = "0" * 64 if owner.mode == "replay" else nonce
                proof = hmac.new(owner.key, ("codex-harness-account-proof-v1\0" + owner.origin + "\0" + signed_nonce).encode(), hashlib.sha256).hexdigest()
                self.respond({"nonce": nonce, "proof": "0" * 64 if owner.mode == "forged" else proof})
            def do_POST(self):
                self.rfile.read(int(self.headers["Content-Length"]))
                owner.requests.append(("POST", self.client_address[1], self.headers.get("Cookie")))
                self.respond({"authenticated": True})
            def do_DELETE(self):
                owner.requests.append(("DELETE", self.client_address[1], self.headers.get("Cookie")))
                self.respond({"authenticated": False})
        self.server = http.server.ThreadingHTTPServer(("127.0.0.1", 0), Listener)
        self.thread = threading.Thread(target=self.server.serve_forever, daemon=True)
        self.thread.start()
        self.manager = SimpleNamespace(config={"origin": self.origin, "port": self.server.server_port})
        self.key_patch = patch("deploy.accounts.instance_proof_key", return_value=self.key)
        self.key_patch.start()

    def tearDown(self):
        self.key_patch.stop()
        self.server.shutdown()
        self.server.server_close()
        self.thread.join(timeout=5)

    def test_correct_proof_and_password_share_the_same_tcp_connection(self):
        account_request(self.manager, "POST", {"username": "admin", "password": "synthetic-password"})
        self.assertEqual([row[0] for row in self.requests], ["GET", "POST"])
        self.assertEqual(self.requests[0][1], self.requests[1][1])
        account_request(self.manager, "DELETE", cookie="harness_fixture=synthetic-session", csrf="synthetic-csrf")
        self.assertNotEqual(self.nonces[0], self.nonces[1])
        self.assertIsNone(self.requests[2][2])
        self.assertEqual(self.requests[3][2], "harness_fixture=synthetic-session")

    def test_forged_replayed_or_closed_proof_sends_no_password(self):
        for mode in ("forged", "replay", "close"):
            self.mode = mode
            self.requests.clear()
            with self.subTest(mode=mode), self.assertRaises(DeployError):
                account_request(self.manager, "POST", {"username": "admin", "password": "synthetic-password"})
            self.assertEqual([row[0] for row in self.requests], ["GET"])

    def test_forged_listener_cannot_supply_initialization_status(self):
        self.mode = "forged"
        with self.assertRaises(DeployError):
            account_request(self.manager, "GET")
        self.assertEqual([row[0] for row in self.requests], ["GET"])


if __name__ == "__main__":
    unittest.main()
