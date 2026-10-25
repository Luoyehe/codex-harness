"""Bounded provider-scoped model discovery. An ID is not a capability claim."""
from __future__ import annotations

import http.client
import json
import signal
import socket
import time
import threading
from contextlib import contextmanager
from urllib.parse import urlsplit

from .common import DeployError, require
from .provider import provider_url, small_text

MAX_CATALOG_BYTES = 1024 * 1024
MAX_CATALOG_MODELS = 1000


@contextmanager
def deadline():
    # Linux management runs on its process main thread. SIGALRM also bounds DNS,
    # TLS and slow response headers, which per-socket timeouts cannot bound.
    supported = hasattr(signal, "setitimer")
    if supported:
        require(threading.current_thread() is threading.main_thread(), "Discovery requires the manager main thread")
        previous = signal.getsignal(signal.SIGALRM)
        def expired(signum, frame):
            raise DeployError("catalog_timeout", "Provider catalog deadline exceeded")
        signal.signal(signal.SIGALRM, expired)
        old_timer = signal.setitimer(signal.ITIMER_REAL, 15)
    try:
        yield
    finally:
        if supported:
            signal.setitimer(signal.ITIMER_REAL, *old_timer)
            signal.signal(signal.SIGALRM, previous)


def parse_ids(data: bytes) -> list[dict]:
    require(len(data) <= MAX_CATALOG_BYTES, "Provider catalog exceeds 1 MiB", "catalog_budget")
    try:
        document = json.loads(data)
    except (UnicodeError, ValueError) as exc:
        raise DeployError("catalog_invalid", "Provider returned invalid catalog JSON") from exc
    require(isinstance(document, dict) and document.get("has_more") is not True,
            "Provider catalog is not a complete single bounded response", "catalog_invalid")
    items = document.get("data", document.get("models"))
    require(isinstance(items, list) and len(items) <= MAX_CATALOG_MODELS, "Invalid or oversized provider model list", "catalog_budget")
    ids = set()
    models = []
    for item in items:
        require(isinstance(item, dict), "Invalid provider model entry", "catalog_invalid")
        ident = small_text(item.get("id", item.get("slug")), "provider model id")
        require(ident not in ids, "Duplicate provider model id", "catalog_invalid")
        ids.add(ident)
        # Never copy OpenAI/native/previous-model capability fields into newly
        # discovered IDs, even if a similarly named model was known previously.
        models.append({"id": ident, "defaultEffort": None, "efforts": []})
    return sorted(models, key=lambda item: item["id"])


def fetch_ids(current: dict) -> list[dict]:
    with deadline():
        return _fetch_ids(current)


def _fetch_ids(current: dict) -> list[dict]:
    require(current.get("kind") in ("responses", "zhipu-coding"), "This provider uses the native catalog")
    url = urlsplit(provider_url(current["baseUrl"], current.get("apiKey", ""), current.get("allowInsecureHttp", False)))
    path = url.path.rstrip("/") + "/models"
    started = time.monotonic()
    connection_type = http.client.HTTPSConnection if url.scheme == "https" else http.client.HTTPConnection
    connection = connection_type(url.hostname, url.port or (443 if url.scheme == "https" else 80), timeout=10)
    try:
        headers = {"Accept": "application/json", "User-Agent": "codex-harness-model-discovery/1", "Connection": "close"}
        if current.get("apiKey"):
            headers["Authorization"] = "Bearer " + current["apiKey"]
        connection.request("GET", path, headers=headers)
        response = connection.getresponse()
        # http.client deliberately does not follow Location. No credential can be
        # forwarded to a redirection target, including a same-host redirect.
        require(response.status == 200, "Provider catalog request failed or redirected", "catalog_http")
        length = response.getheader("Content-Length")
        require(length is None or (length.isdigit() and int(length) <= MAX_CATALOG_BYTES), "Catalog Content-Length exceeds budget", "catalog_budget")
        pieces, count = [], 0
        while True:
            require(time.monotonic() - started <= 15, "Provider catalog deadline exceeded", "catalog_timeout")
            piece = response.read1(min(65536, MAX_CATALOG_BYTES + 1 - count))
            if not piece:
                break
            pieces.append(piece)
            count += len(piece)
            require(count <= MAX_CATALOG_BYTES, "Provider catalog exceeds 1 MiB", "catalog_budget")
        return parse_ids(b"".join(pieces))
    except (OSError, http.client.HTTPException, ValueError) as exc:
        raise DeployError("catalog_unavailable", "Provider catalog request did not complete") from exc
    finally:
        connection.close()
