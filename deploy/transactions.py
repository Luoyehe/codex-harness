"""One mutation gate for application and trusted-control transactions."""
from .common import Layout, read_json, require


def require_recovered(layout: Layout, installation: dict | None = None, *, control: bool = True) -> None:
    for path in (layout.state / "transactions").glob("*/state.json"):
        state = read_json(path)
        require(isinstance(state, dict), "Invalid management transaction", "corrupt_state")
        if state.get("phase") in ("committed", "recovered") or (state.get("phase") == "failed_first_start" and
                state.get("kind") == "release" and state.get("old") is None):
            continue
        # Only update/restart may retire a never-committed first-start attempt,
        # and they still confirm shutdown before changing any pointer or record.
        require(installation is not None and installation.get("phase") == "pending" and
                state.get("kind") == "release" and state.get("old") is None,
                "An unfinished management transaction requires repair before another mutation", "recovery_required")
    if control:
        records = layout.control.parent / ("." + layout.instance + "-control-transactions")
        for path in records.glob("*/state.json"):
            state = read_json(path, 32 * 1024 * 1024)
            require(isinstance(state, dict) and state.get("phase") in ("committed", "recovered"),
                    "Trusted control maintenance is unfinished; run control-recover", "recovery_required")
