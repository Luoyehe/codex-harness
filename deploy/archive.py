"""Resource limits at the tar parser boundary, before extension processing."""
from __future__ import annotations

import bz2
import gzip
import lzma
import os
import tarfile
from contextlib import ExitStack, contextmanager
from pathlib import Path

from .common import DeployError, require

MAX_INPUT = 4 * 1024**3
MAX_METADATA = 64 * 1024
MAX_METADATA_TOTAL = 64 * 1024**2
MAX_EXTENSION_DEPTH = 16
MAX_READ = 1024**2
XZ_MEMORY = 128 * 1024**2
EXTENSIONS = {tarfile.XHDTYPE, tarfile.XGLTYPE, tarfile.SOLARIS_XHDTYPE,
              tarfile.GNUTYPE_LONGNAME, tarfile.GNUTYPE_LONGLINK}


class LimitedReader:
    def __init__(self, source, limit: int):
        self.source, self.limit, self.used = source, limit, 0

    def read(self, size: int) -> bytes:
        require(0 <= size <= MAX_READ, "Archive parser read exceeds budget", "budget")
        data = self.source.read(min(size, self.limit - self.used + 1))
        self.used += len(data)
        require(self.used <= self.limit, "Archive stream exceeds byte budget", "budget")
        return data


class XzReader:
    """LZMAFile has no decoder-memory limit; bound both dictionary and output.

    Concatenated streams and four-byte XZ stream padding remain supported.
    """
    def __init__(self, source):
        self.source, self.decoder, self.pending = source, None, b""
        self.padding = 0
        self.started = False

    def read(self, size: int) -> bytes:
        parts, remaining = [], size
        while remaining:
            if self.decoder is None or self.decoder.needs_input:
                data = self.pending or self.source.read(64 * 1024)
                self.pending = b""
                if self.decoder is None:
                    # Zero padding belongs between complete streams only.
                    padding = len(data) - len(data.lstrip(b"\0")) if self.started else 0
                    self.padding += padding
                    data = data[padding:]
                    if not data:
                        if padding:
                            continue
                        require(self.padding % 4 == 0, "Invalid XZ stream padding", "unsafe_path")
                        break
                    require(self.padding % 4 == 0, "Invalid XZ stream padding", "unsafe_path")
                    self.padding = 0
                    self.decoder = lzma.LZMADecompressor(memlimit=XZ_MEMORY)
                    self.started = True
                else:
                    require(bool(data), "Truncated compressed archive", "unsafe_path")
            else:
                data = b""
            block = self.decoder.decompress(data, max_length=min(remaining, 64 * 1024))
            if block:
                parts.append(block)
            remaining -= len(block)
            if self.decoder.eof:
                self.pending = self.decoder.unused_data
                self.decoder = None
        return b"".join(parts)


def metadata_size(values: dict) -> int:
    # PAX decoding can retain non-UTF8 bytes as surrogate escapes. Preserve
    # those bytes while bounding UTF8 metadata by bytes rather than characters.
    return sum(len(field.encode("utf-8", "surrogateescape")) for pair in values.items() for field in pair)


def guarded_info(max_file: int, max_members: int):
    # TarInfo._proc_member is reached for every physical header, including
    # recursive PAX/GNU headers, before tarfile reads their variable payload.
    # Keep the guard here rather than after TarFile.next() has already parsed it.
    physical = metadata = depth = 0

    class GuardedInfo(tarfile.TarInfo):
        def _proc_member(self, archive):
            nonlocal physical, metadata, depth
            physical += 1
            require(physical <= 3 * max_members, "Archive has too many physical headers", "budget")
            require(metadata_size(archive.pax_headers) <= MAX_METADATA,
                    "Archive global metadata exceeds budget", "budget")
            extension = self.type in EXTENSIONS
            if extension:
                require(0 <= self.size <= MAX_METADATA, "Archive extension exceeds budget", "budget")
                metadata += self.size
                require(metadata <= MAX_METADATA_TOTAL, "Archive metadata exceeds budget", "budget")
                require(depth < MAX_EXTENSION_DEPTH, "Archive extension chain exceeds budget", "budget")
                depth += 1
            else:
                require(self.type in (tarfile.REGTYPE, tarfile.AREGTYPE, tarfile.CONTTYPE,
                                      tarfile.DIRTYPE, tarfile.SYMTYPE),
                        "Hardlinks, sparse files and special archive members are prohibited", "unsafe_path")
                require(0 <= self.size <= max_file, "Archive file exceeds budget", "budget")
            try:
                member = super()._proc_member(archive)
                # PAX (including global PAX) can replace the stored size. Check
                # the effective value before tarfile can seek/read that payload.
                require(0 <= member.size <= max_file, "Archive file exceeds budget", "budget")
                require(member.isreg() or member.size == 0, "Non-file archive payload", "unsafe_path")
                require(metadata_size(member.pax_headers) <= MAX_METADATA,
                        "Archive effective metadata exceeds budget", "budget")
                return member
            finally:
                if extension:
                    depth -= 1

        def _proc_gnusparse_00(self, *args):
            raise DeployError("unsafe_path", "Sparse archive members are prohibited")

        _proc_gnusparse_01 = _proc_gnusparse_00
        _proc_gnusparse_10 = _proc_gnusparse_00

    return GuardedInfo


@contextmanager
def open_archive(path: Path, *, max_file: int, max_members: int, max_bytes: int):
    """Open sequentially; callers use next() and discard cached TarInfo records.

    Decode outside tarfile's r|* implementation, which can decompress a whole
    compressed block without an output limit. Standard gzip/bz2 buffered readers
    cap decoder output; XZ additionally needs an explicit dictionary limit.
    """
    with ExitStack() as stack:
        raw = stack.enter_context(path.open("rb"))
        require(os.fstat(raw.fileno()).st_size <= MAX_INPUT, "Archive input exceeds byte budget", "budget")
        signature = raw.read(6)
        raw.seek(0)
        incoming = LimitedReader(raw, MAX_INPUT)
        if signature.startswith(b"\x1f\x8b"):
            decoded = stack.enter_context(gzip.GzipFile(fileobj=incoming, mode="rb"))
        elif signature.startswith(b"BZh"):
            decoded = stack.enter_context(bz2.BZ2File(incoming, mode="rb"))
        elif signature.startswith(b"\xfd7zXZ\x00") or path.suffix.lower() == ".lzma":
            decoded = XzReader(incoming)
        else:
            decoded = incoming
        # Account for data, extension payloads, every physical header/padding,
        # and a conventional final tar record, including skipped members.
        limit = max_bytes + MAX_METADATA_TOTAL + 3 * max_members * 2 * tarfile.BLOCKSIZE + tarfile.RECORDSIZE
        stream = LimitedReader(decoded, limit)
        archive = stack.enter_context(tarfile.open(fileobj=stream, mode="r|",
                                                 tarinfo=guarded_info(max_file, max_members)))
        yield archive
