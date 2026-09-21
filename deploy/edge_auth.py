"""Conservative external-policy review, not a YAML parser or a login test.

Only the small unambiguous authenticated-default subset is proven here. Rules,
aliases and other YAML features require an administrator's explicit review in
addition to Authelia's own configuration validation and live health check.
"""
import argparse
import os
from pathlib import Path
import re
import sys

sys.dont_write_bytecode = True
sys.path.insert(0, str(Path(__file__).resolve().parent))
from bounded_read import read_text_bounded


MAX_AUTHELIA_CONFIGURATION_BYTES = 8 * 1024 * 1024


def review_policy(text, reviewed=False):
    lines = text.splitlines()
    starts = [i for i, line in enumerate(lines) if re.match(r'''^(?:access_control|"access_control"|'access_control')\s*:''', line)]
    if len(starts) != 1:
        raise ValueError("exactly one explicit access_control section is required")
    start = starts[0]
    body = []
    if not re.fullmatch(r"access_control\s*:\s*(?:#.*)?", lines[start]):
        body.append(lines[start])
    for line in lines[start + 1:]:
        if not line.strip() or line.lstrip().startswith("#"):
            continue
        if not line[0].isspace():
            break
        body.append(line.split("#", 1)[0].strip())
    defaults = [line.split(":", 1)[1].strip() for line in body if line.startswith("default_policy:")]
    # Other root-level YAML spellings may conceal aliases, documents or an
    # escaped duplicate key. Do not pretend to parse those without a parser.
    plain_root = all(not line or line[0].isspace() or line.startswith("#")
                     or re.match(r"^[A-Za-z_][A-Za-z_0-9]*\s*:", line) for line in lines)
    simple = plain_root and len(defaults) == 1 and all(
        re.fullmatch(r"default_policy:\s*(one_factor|two_factor|deny|bypass)", line)
        or re.fullmatch(r"rules:\s*\[\s*\]", line) for line in body
    ) and sum(line.startswith("rules:") for line in body) <= 1
    if simple:
        if defaults[0] not in ("one_factor", "two_factor"):
            raise ValueError("external policy must require authentication and allow the intended application")
        return "static-authenticated-default"
    if not reviewed:
        raise ValueError("complex external access_control requires administrator review: AUTHELIA_POLICY_REVIEWED=1")
    return "administrator-reviewed-not-live-verified"


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("configuration")
    args = parser.parse_args()
    configuration = read_text_bounded(args.configuration, MAX_AUTHELIA_CONFIGURATION_BYTES)
    print(review_policy(configuration, os.environ.get("AUTHELIA_POLICY_REVIEWED") == "1"))


if __name__ == "__main__":
    try:
        main()
    except (OSError, ValueError) as error:
        raise SystemExit(str(error)) from None
