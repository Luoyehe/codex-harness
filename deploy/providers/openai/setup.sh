#!/usr/bin/env bash
# OpenAI (ChatGPT account) provider: codex-native mode, NO config file.
# Under the config-set layout this simply DEACTIVATES the live config link
# (any existing config.toml — regular file from the pre-set era — is backed
# up, never destroyed). The other modes' sets under providers/ are untouched.
#
# ChatGPT login itself: codex login --device-auth  (or the WebUI login button)
set -euo pipefail
exec bash "$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)/activate-config.sh" openai
