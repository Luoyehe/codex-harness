"""Explicit Linux acceptance probe for a disposable, already installed crtest-* instance.

Does not restart gateway/worker, read token bytes, call models or access external
services. The only TCP traffic is a connection to this process's loopback listener.
Run after the affected deployment unit tests, not as a whole-repository suite.
"""
import argparse
import json
import os
import socket
import sys
import uuid
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[2]))

from deploy.build import Builder
from deploy.common import Layout, mkdir, read_json, require
from deploy.system import System, require_linux, run


PROBE = r'''
import json, os, resource, socket, subprocess, sys
from pathlib import Path
output, forbidden, source, port = sys.argv[1:]
result = {"uid": os.geteuid(), "groups": os.getgroups(), "nofile": resource.getrlimit(resource.RLIMIT_NOFILE)[0]}
try:
    with open(forbidden, "rb"):
        pass
    result["tokenOpened"] = True
except OSError:
    result["tokenOpened"] = False
try:
    with open(source, "ab"):
        pass
    result["sourceWritable"] = True
except OSError:
    result["sourceWritable"] = False
try:
    connection = socket.create_connection(("127.0.0.1", int(port)), timeout=2)
    connection.close()
    result["network"] = True
except OSError:
    result["network"] = False
result["environment"] = sorted(os.environ)
stats = os.statvfs(output)
result["diskBytes"] = stats.f_blocks * stats.f_frsize
child = subprocess.Popen(["/usr/bin/sleep", "120"])
result["childPid"] = child.pid
Path(output, "result.json").write_text(json.dumps(result))
'''


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("--instance", required=True)
    args = parser.parse_args()
    require_linux()
    require(args.instance.startswith("crtest-"), "Only explicitly named disposable crtest-* instances are permitted")
    layout = Layout(args.instance)
    settings = read_json(layout.config / "instance.json")
    system = System()
    builder = Builder(layout, system, settings["buildUid"], settings["buildGid"])
    identity = uuid.uuid4().hex
    stage = layout.work / ("isolation-evidence-" + identity)
    mkdir(stage, 0o755)
    script = stage / "probe.py"
    script.write_text(PROBE)
    os.chmod(script, 0o644)
    listener = socket.socket()
    listener.bind(("127.0.0.1", 0))
    listener.listen(4)
    port = listener.getsockname()[1]
    evidence = {}
    for network in (True, False):
        label = "online" if network else "offline"
        writable = stage / label
        image = builder.bounded_workspace(writable, 1)
        system.isolated(layout, "isolation-" + label + "-" + identity,
                        ["/usr/bin/python3", "-I", str(script), str(writable), str(layout.config / "gateway-token"), str(script), str(port)],
                        stage, writable, network=network, timeout=20)
        result = read_json(writable / "result.json")
        require(result["uid"] == settings["buildUid"] and result["uid"] != 0, "Unexpected candidate UID")
        require(result["tokenOpened"] is False and result["sourceWritable"] is False, "Candidate isolation failed")
        require(result["network"] == network, "Network phase isolation failed")
        require(result["nofile"] <= 4096 and result["diskBytes"] <= 1024**3, "Resource limits missing")
        require(not Path("/proc", str(result["childPid"])).exists(), "Child process survived completed stage")
        require(not any("KEY" in name or "TOKEN" in name or name.startswith("CODEX") for name in result["environment"]), "Credential environment inherited")
        evidence[label] = result
        run(["/usr/bin/umount", str(writable)])
        image.unlink()
    listener.close()
    (stage / "evidence.json").write_text(json.dumps(evidence, indent=2))
    print(json.dumps({"passed": True, "evidence": str(stage / "evidence.json"), "checks": ["uid", "token denied", "root source read-only", "network phases", "disk", "nofile", "child cleanup", "credential-free environment"]}))


if __name__ == "__main__":
    main()
