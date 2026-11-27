"""Inspect historical audit JSON in the verified offline evidence archive."""
import argparse
import hashlib
import json
from pathlib import Path
import re
import sys
from zipfile import ZipFile

NAME = re.compile(r"verification/audit-evidence/[\w-]+/[\w-]+\.json", re.ASCII)


def digest(file: Path) -> str:
    with file.open("rb") as stream:
        checksum = hashlib.sha256()
        for chunk in iter(lambda: stream.read(1024 * 1024), b""):
            checksum.update(chunk)
        return checksum.hexdigest()


def main() -> None:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--archive", type=Path, required=True, help="local historical ZIP with its original adjacent JSON manifest")
    action = parser.add_mutually_exclusive_group(required=True)
    action.add_argument("--list", action="store_true", help="list original repository-relative names")
    action.add_argument("--show", metavar="PATH", help="write one original JSON record to stdout")
    action.add_argument("--verify", action="store_true", help="verify every original byte and Git blob identity")
    action.add_argument("--restore", type=Path, metavar="NEW_DIRECTORY", help="restore all records below a new directory")
    args = parser.parse_args()
    manifest = json.loads(args.archive.with_suffix(".json").read_bytes())
    files = manifest["files"]
    if manifest["format"] != 1 or digest(args.archive) != manifest["archiveSha256"]:
        raise ValueError("Evidence archive digest mismatch")
    with ZipFile(args.archive) as bundle:
        if sorted(bundle.namelist()) != sorted(files) or any(not NAME.fullmatch(name) for name in files):
            raise ValueError("Evidence archive inventory mismatch")
        if args.list:
            print("\n".join(sorted(files)))
            return
        if args.show and args.show not in files:
            parser.error("Path is absent from the historical index")
        output = args.restore
        if output:
            output.mkdir(parents=True, exist_ok=False)
        for name in [args.show] if args.show else sorted(files):
            item = files[name]
            if bundle.getinfo(name).file_size != item["size"] or not 0 <= item["size"] <= 16 * 1024**2:
                raise ValueError("Invalid evidence size for " + name)
            raw = bundle.read(name)
            oid = hashlib.sha1(b"blob " + str(len(raw)).encode() + b"\0" + raw).hexdigest()
            if hashlib.sha256(raw).hexdigest() != item["sha256"] or oid != item["gitBlob"]:
                raise ValueError("Historical evidence changed: " + name)
            if args.show:
                sys.stdout.buffer.write(raw)
            if output:
                dest = output / name
                dest.parent.mkdir(parents=True, exist_ok=True)
                with dest.open("xb") as stream:
                    stream.write(raw)
        if not args.show:
            print(f"Verified {len(files)} historical audit records from {manifest['commit']}")


if __name__ == "__main__":
    main()
