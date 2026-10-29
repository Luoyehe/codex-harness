"""One mutation gate for application and trusted-control transactions."""
from .common import Layout, read_json, require


def require_initialization_complete(layout: Layout) -> None:
    """Read-only guard; call before creating/acquiring an instance management lock."""
    from .install_recovery import private_record, record_path, validate_state
    path = record_path(layout)
    if not path.exists() and not path.is_symlink():
        return
    state = private_record(path)
    require(state.get("format") == 1 and state.get("instance") == layout.instance and
            state.get("phase") in ("initializing", "initialized"), "Invalid initialization record", "corrupt_state")
    validate_state(layout, state)
    require(state["phase"] == "initialized", "Instance initialization is incomplete; run install-resume from its original reviewed checkout", "initialization_pending")


def require_recovered(layout: Layout, installation: dict | None = None, *, control: bool = True) -> None:
    require_initialization_complete(layout)
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
