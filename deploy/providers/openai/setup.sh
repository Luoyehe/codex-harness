#!/usr/bin/env bash
# OpenAI (ChatGPT account) provider: native defaults via an empty managed config.
# The transaction preserves public aliases and publishes one new generation;
# prior configuration and other provider sets remain in private snapshots.
#
# ChatGPT login itself: codex login --device-auth  (or the WebUI login button)
set -euo pipefail
exec bash "$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)/activate-config.sh" openai
