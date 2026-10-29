"""Real local TLS handshakes and proof responses; no remote services or homes."""
import contextlib
from datetime import datetime, timedelta, timezone
import hashlib
import hmac
import http.server
import json
import os
from pathlib import Path
import shutil
import socket
import ssl
import subprocess
import tempfile
import threading
import time
from types import SimpleNamespace
import unittest
from unittest.mock import patch
from urllib.parse import parse_qs, urlsplit

from deploy.common import DeployError, Layout, read_json, write_json
from deploy.https_health import https_health, require_https_ready


def certificates(directory: Path):
    """Use the OS test utility, or the bundled Windows cryptography runtime."""
    now = datetime.now(timezone.utc)
    openssl = shutil.which("openssl")
    if openssl:
        def run(*args):
            subprocess.run([openssl, *args], cwd=directory, check=True, stdout=subprocess.DEVNULL, stderr=subprocess.PIPE, timeout=15)
        run("req", "-x509", "-newkey", "rsa:2048", "-nodes", "-keyout", "ca.key", "-out", "ca.pem",
            "-subj", "/CN=Isolated HTTPS Test CA", "-days", "30", "-addext", "basicConstraints=critical,CA:TRUE",
            "-addext", "keyUsage=critical,keyCertSign,cRLSign")
        for label, host in (("valid", "work.example.test"), ("wrong", "other.example.test"),
                            ("expired", "work.example.test")):
            extension = directory / (label + ".ext")
            extension.write_text("subjectAltName=DNS:" + host + "\nbasicConstraints=critical,CA:FALSE\nkeyUsage=critical,digitalSignature,keyEncipherment\nextendedKeyUsage=serverAuth\n")
            run("req", "-newkey", "rsa:2048", "-nodes", "-keyout", label + ".key", "-out", label + ".csr", "-subj", "/CN=" + host)
            if label == "expired":
                # Modern OpenSSL rejects negative -days. Sign an ordered validity
                # interval wholly in the past using a fixture-local CA database.
                (directory / "expired-ca.index").write_text("")
                (directory / "expired-ca.serial").write_text("1000\n")
                (directory / "expired-ca.cnf").write_text(
                    "[ca]\ndefault_ca=fixture_ca\n[fixture_ca]\ncertificate=ca.pem\nprivate_key=ca.key\n"
                    "database=expired-ca.index\nserial=expired-ca.serial\nnew_certs_dir=.\ndefault_md=sha256\n"
                    "policy=fixture_policy\n[fixture_policy]\ncommonName=supplied\n[leaf]\n" + extension.read_text())
                run("ca", "-batch", "-notext", "-config", "expired-ca.cnf", "-extensions", "leaf",
                    "-in", "expired.csr", "-out", "expired.pem",
                    "-startdate", (now - timedelta(days=2)).strftime("%Y%m%d%H%M%SZ"),
                    "-enddate", (now - timedelta(days=1)).strftime("%Y%m%d%H%M%SZ"))
            else:
                run("x509", "-req", "-in", label + ".csr", "-CA", "ca.pem", "-CAkey", "ca.key", "-CAcreateserial", "-out", label + ".pem",
                    "-days", "7", "-extfile", extension.name)
        return
    try:
        from cryptography import x509
        from cryptography.hazmat.primitives import hashes, serialization
        from cryptography.hazmat.primitives.asymmetric import rsa
        from cryptography.x509.oid import NameOID, ExtendedKeyUsageOID
    except ImportError as error:
        raise unittest.SkipTest("Local TLS fixtures require openssl or the bundled cryptography runtime") from error
    ca_key = rsa.generate_private_key(public_exponent=65537, key_size=2048)
    ca_name = x509.Name([x509.NameAttribute(NameOID.COMMON_NAME, "Isolated HTTPS Test CA")])
    ca = (x509.CertificateBuilder().subject_name(ca_name).issuer_name(ca_name).public_key(ca_key.public_key())
          .serial_number(x509.random_serial_number()).not_valid_before(now - timedelta(days=2)).not_valid_after(now + timedelta(days=30))
          .add_extension(x509.BasicConstraints(ca=True, path_length=0), critical=True)
          .add_extension(x509.KeyUsage(False, False, False, False, False, True, True, False, False), critical=True)
          .sign(ca_key, hashes.SHA256()))
    (directory / "ca.pem").write_bytes(ca.public_bytes(serialization.Encoding.PEM))
    for label, host, end in (("valid", "work.example.test", now + timedelta(days=7)),
                             ("wrong", "other.example.test", now + timedelta(days=7)),
                             ("expired", "work.example.test", now - timedelta(days=1))):
        key = rsa.generate_private_key(public_exponent=65537, key_size=2048)
        cert = (x509.CertificateBuilder().subject_name(x509.Name([x509.NameAttribute(NameOID.COMMON_NAME, host)]))
                .issuer_name(ca_name).public_key(key.public_key()).serial_number(x509.random_serial_number())
                .not_valid_before(now - timedelta(days=2)).not_valid_after(end)
                .add_extension(x509.SubjectAlternativeName([x509.DNSName(host)]), critical=False)
                .add_extension(x509.BasicConstraints(ca=False, path_length=None), critical=True)
                .add_extension(x509.ExtendedKeyUsage([ExtendedKeyUsageOID.SERVER_AUTH]), critical=False)
                .sign(ca_key, hashes.SHA256()))
        (directory / (label + ".key")).write_bytes(key.private_bytes(serialization.Encoding.PEM, serialization.PrivateFormat.PKCS8, serialization.NoEncryption()))
        (directory / (label + ".pem")).write_bytes(cert.public_bytes(serialization.Encoding.PEM))


class HttpsHealthTests(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        root = Path.cwd() / ".work" / "https-health-tests"
        root.mkdir(parents=True, exist_ok=True)
        cls.temporary = tempfile.TemporaryDirectory(dir=root)
        cls.fixtures = Path(cls.temporary.name)
        cls.addClassCleanup(cls.temporary.cleanup)
        certificates(cls.fixtures)

    def setUp(self):
        self.directory = tempfile.TemporaryDirectory(dir=self.fixtures)
        self.addCleanup(self.directory.cleanup)
        self.layout = Layout("tlsfixture", Path(self.directory.name))
        self.layout.config.mkdir(parents=True)
        self.token = "synthetic-instance-proof-key-for-local-tests-only"
        (self.layout.config / "gateway-token").write_text(self.token)
        os.chmod(self.layout.config / "gateway-token", 0o640)
        self.manager = SimpleNamespace(layout=self.layout, config={"origin": "https://work.example.test", "gatewayGid": os.getgid() if hasattr(os, "getgid") else 0})
        self.metadata = {"host": "work.example.test", "tls": "provided", "httpsPort": 443, "authentication": "builtin", "phase": "active"}
        self.requests, self.server_names = [], []
        self.mode = "valid"
        if os.name == "posix" and os.geteuid() != 0:
            # Standard CI is unprivileged: only replace the two root-owned file
            # boundaries. TLS, certificate verification and proof HMAC stay real.
            def metadata(layout):
                try:
                    return read_json(layout.config / "https.json")
                except FileNotFoundError as error:
                    raise DeployError("not_installed", "No fixture HTTPS configuration") from error
            self.addCleanup(patch.stopall)
            patch("deploy.https.read_https_metadata", side_effect=metadata).start()
            patch("deploy.https_health.instance_proof_key", return_value=hashlib.sha256(self.token.encode()).digest()).start()

    def save_metadata(self):
        self.metadata.setdefault("publicOrigin", self.manager.config["origin"])
        write_json(self.layout.config / "https.json", self.metadata)

    @contextlib.contextmanager
    def server(self, certificate="valid"):
        owner = self

        class Handler(http.server.BaseHTTPRequestHandler):
            protocol_version = "HTTP/1.1"

            def log_message(self, *args):
                pass

            def do_GET(self):
                owner.requests.append({"method": "GET", "path": self.path, "headers": dict(self.headers)})
                nonce = parse_qs(urlsplit(self.path).query)["nonce"][0]
                key = hashlib.sha256(owner.token.encode()).digest()
                proof = hmac.new(key, ("codex-harness-account-proof-v1\0" + owner.manager.config["origin"] + "\0" + nonce).encode(), hashlib.sha256).hexdigest()
                value = {"nonce": nonce, "proof": "0" * 64 if owner.mode == "wrong-proof" else proof}
                if owner.mode == "large":
                    value["extra"] = "sensitive-response-never-returned" * 300
                body = json.dumps(value).encode()
                self.send_response(302 if owner.mode == "redirect" else 200)
                if owner.mode == "headers":
                    self.send_header("X-Large", "x" * 40000)
                if owner.mode == "chunked":
                    self.send_header("Transfer-Encoding", "chunked")
                else:
                    self.send_header("Content-Length", str(len(body)))
                self.end_headers()
                try:
                    if owner.mode == "slow":
                        for byte in body:
                            self.wfile.write(bytes([byte]))
                            self.wfile.flush()
                            time.sleep(0.04)
                    elif owner.mode == "chunked":
                        self.wfile.write((format(len(body), "x") + "\r\n").encode() + body + b"\r\n0\r\n\r\n")
                    else:
                        self.wfile.write(body)
                except (OSError, ssl.SSLError):
                    pass

        server = http.server.ThreadingHTTPServer(("127.0.0.1", 0), Handler)
        context = ssl.SSLContext(ssl.PROTOCOL_TLS_SERVER)
        context.load_cert_chain(self.fixtures / (certificate + ".pem"), self.fixtures / (certificate + ".key"))
        context.set_servername_callback(lambda connection, name, context: owner.server_names.append(name))
        server.socket = context.wrap_socket(server.socket, server_side=True)
        thread = threading.Thread(target=server.serve_forever, kwargs={"poll_interval": 0.02}, daemon=True)
        thread.start()
        self.metadata["httpsPort"] = server.server_port
        self.save_metadata()
        try:
            yield server.server_port
        finally:
            server.shutdown()
            server.server_close()
            thread.join(2)

    def probe(self, **kwargs):
        return https_health(self.manager, connect_address="127.0.0.1", ca_file=self.fixtures / "ca.pem", **kwargs)

    def test_real_tls_uses_origin_for_sni_host_and_proof_with_distinct_listener(self):
        with self.server():
            result = self.probe()
        self.assertTrue(result["ready"], result)
        self.assertTrue(result["tlsVerified"])
        self.assertTrue(result["instanceVerified"])
        self.assertEqual(self.server_names, ["work.example.test"])
        self.assertEqual(self.requests[0]["headers"]["Host"], "work.example.test")
        self.assertEqual(self.requests[0]["headers"]["Origin"], "https://work.example.test")
        self.assertEqual(result["certificate"]["subjectAlternativeNames"], [{"type": "DNS", "value": "work.example.test"}])
        self.assertGreater(result["certificate"]["daysRemaining"], 6)
        self.assertIn("notAfter", result["certificate"])
        self.assertEqual(result["renewal"], {"manager": "operator", "automatic": False, "mechanism": "provided",
                                           "challenge": None, "dnsProvider": None,
                                           "futureSuccessVerified": False, "evidence": "configuration-only",
                                           "requirements": ["The operator must renew and replace both PEM files through the managed HTTPS command before expiry."]})
        self.assertEqual(result["diagnostics"], [])
        self.assertFalse(result["vantage"]["independentPublicAcceptance"])
        serialized = json.dumps(result)
        self.assertNotIn(self.token, serialized)
        self.assertNotIn("PRIVATE KEY", serialized)
        self.assertNotIn("nonce", serialized)
        self.assertNotIn("Authorization", self.requests[0]["headers"])
        self.assertNotIn("Cookie", self.requests[0]["headers"])

    def test_origin_port_is_preserved_and_explicit_route_port_is_independent(self):
        self.manager.config["origin"] = "https://work.example.test:8443"
        with self.server() as port:
            self.metadata["httpsPort"] = 1
            self.save_metadata()
            result = self.probe(connect_port=port)
        self.assertTrue(result["ready"], result)
        self.assertEqual(self.requests[0]["headers"]["Host"], "work.example.test:8443")

    def test_unknown_ca_hostname_mismatch_and_expiry_fail_before_proof(self):
        for certificate in ("valid", "wrong", "expired"):
            with self.subTest(certificate=certificate), self.server(certificate):
                if certificate == "valid":
                    result = https_health(self.manager, connect_address="127.0.0.1")
                else:
                    result = self.probe()
                self.assertEqual(result["failure"], "certificate_validation_failed", result)
                self.assertFalse(result["ready"])
                self.assertFalse(result["tlsVerified"])
        self.assertEqual(self.requests, [])

    def test_expired_fixture_has_past_validity_and_fails_specifically_for_expiry(self):
        certificate = ssl._ssl._test_decode_cert(str(self.fixtures / "expired.pem"))
        starts = ssl.cert_time_to_seconds(certificate["notBefore"])
        ends = ssl.cert_time_to_seconds(certificate["notAfter"])
        self.assertLess(starts, ends)
        self.assertLess(ends, time.time())
        context = ssl.create_default_context(cafile=self.fixtures / "ca.pem")
        with self.server("expired") as port, socket.create_connection(("127.0.0.1", port), timeout=2) as connection:
            with self.assertRaises(ssl.SSLCertVerificationError) as caught:
                context.wrap_socket(connection, server_hostname="work.example.test")
        self.assertEqual(caught.exception.verify_code, 10)  # X509_V_ERR_CERT_HAS_EXPIRED
        self.assertEqual(self.requests, [])

    def test_invalid_proof_redirect_and_oversized_response_never_report_ready(self):
        for mode in ("wrong-proof", "redirect", "large"):
            with self.subTest(mode=mode), self.server():
                self.mode = mode
                result = self.probe()
                self.assertEqual(result["failure"], "instance_proof_failed", result)
                self.assertTrue(result["tlsVerified"])
                self.assertFalse(result["ready"])
                self.assertNotIn("sensitive-response", json.dumps(result))
        self.assertEqual(len(self.requests), 3)

    def test_chunked_proof_response_is_supported(self):
        self.mode = "chunked"
        with self.server():
            self.assertTrue(self.probe()["ready"])

    def test_response_header_bytes_have_a_total_budget(self):
        self.mode = "headers"
        with self.server():
            result = self.probe()
        self.assertFalse(result["ready"])
        self.assertEqual(result["failure"], "response_budget_exceeded")

    def test_slow_body_obeys_total_deadline_even_when_each_byte_is_timely(self):
        self.mode = "slow"
        with self.server():
            started = time.monotonic()
            result = self.probe(timeout=0.25)
            elapsed = time.monotonic() - started
        self.assertEqual(result["failure"], "timeout", result)
        self.assertLess(elapsed, 0.8)

    def test_dns_resolution_obeys_total_deadline(self):
        self.save_metadata()
        done = threading.Event()
        with patch("deploy.https_health.socket.getaddrinfo", side_effect=lambda *args, **kwargs: done.wait(1)):
            started = time.monotonic()
            result = https_health(self.manager, ca_file=self.fixtures / "ca.pem", timeout=0.1)
            done.set()
        self.assertEqual(result["failure"], "timeout", result)
        self.assertLess(time.monotonic() - started, 0.5)

    def test_internal_uses_only_instance_ca_and_reports_caddy_renewal_configuration(self):
        ca = self.layout.state / "caddy/.local/share/caddy/pki/authorities/local/root.crt"
        ca.parent.mkdir(parents=True)
        ca.write_bytes((self.fixtures / "ca.pem").read_bytes())
        self.metadata["tls"] = "internal"
        with self.server():
            result = https_health(self.manager, connect_address="127.0.0.1")
        self.assertTrue(result["ready"], result)
        self.assertEqual(result["trust"], "instance-caddy-ca")
        self.assertTrue(result["renewal"]["automatic"])
        self.assertFalse(result["renewal"]["futureSuccessVerified"])

    def test_provided_uses_managed_ca_selection_without_an_override(self):
        with self.server(), patch("deploy.https.tls_ca_path", return_value=self.fixtures / "ca.pem") as selected:
            result = https_health(self.manager, connect_address="127.0.0.1")
        self.assertTrue(result["ready"], result)
        self.assertEqual(result["trust"], "provided-ca")
        selected.assert_called_once_with(self.layout, self.metadata)

    def test_legacy_identity_reports_valid_tls_but_unverified_instance_without_a_login_attempt(self):
        self.metadata.pop("authentication")
        with self.server():
            result = self.probe()
        self.assertTrue(result["tlsVerified"])
        self.assertFalse(result["instanceVerified"])
        self.assertFalse(result["ready"])
        self.assertEqual(result["failure"], "legacy_identity_requires_migration")
        self.assertEqual(self.requests, [])

    def test_acme_rejects_private_test_ca_and_never_accepts_explicit_override(self):
        self.metadata["tls"] = "acme"
        with self.server():
            result = https_health(self.manager, connect_address="127.0.0.1")
            override = self.probe()
        self.assertEqual(result["failure"], "certificate_validation_failed")
        self.assertEqual(result["trust"], "system-ca")
        self.assertTrue(result["renewal"]["automatic"])
        self.assertEqual(override["failure"], "configuration_invalid")
        self.assertFalse(result["validation"]["publicReachabilityVerified"])
        self.assertIn("public ACME validation ports", " ".join(result["diagnostics"]))
        self.assertIn("hostname/SAN", " ".join(result["diagnostics"]))

    def test_bounded_readiness_rejects_wrong_instance_without_mutation(self):
        self.mode = "wrong-proof"
        with self.server():
            started = time.monotonic()
            # The final retry can consume its residual budget during TLS even
            # after earlier proofs were rejected. Its safe failure may therefore
            # be timeout; the required contract is never accepting this server.
            with self.assertRaisesRegex(DeployError, "HTTPS readiness failed") as caught:
                require_https_ready(self.manager, ca_file=self.fixtures / "ca.pem", timeout=1.25)
            self.assertEqual(caught.exception.code, "https_health")
            self.assertLess(time.monotonic() - started, 2.5)
        self.assertGreaterEqual(len(self.requests), 1)
        self.assertTrue(all(request["method"] == "GET" and request["path"].startswith("/api/account/proof?nonce=") for request in self.requests))

    def test_readiness_returns_verified_result(self):
        with self.server():
            result = require_https_ready(self.manager, ca_file=self.fixtures / "ca.pem", timeout=1)
        self.assertTrue(result["ready"])

    def test_missing_metadata_has_explicit_safe_result(self):
        result = https_health(self.manager)
        self.assertFalse(result["configured"])
        self.assertEqual(result["failure"], "not_configured")

    def test_origin_metadata_mismatch_fails_before_network_request(self):
        self.metadata["publicOrigin"] = "https://work.example.test:8443"
        with self.server():
            result = self.probe()
        self.assertEqual(result["failure"], "configuration_invalid")
        self.assertEqual(self.requests, [])
        self.assertEqual(self.server_names, [])


if __name__ == "__main__":
    unittest.main()
