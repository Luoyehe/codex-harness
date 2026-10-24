# Repository working agreements

## Testing discipline

- For ordinary code changes, run only tests affected by the change, plus relevant type, build, lint, and security checks. State the selected tests and why they cover the changed behavior.
- Do not run the repository-wide test suite after each edit or each audit round.
- During a complete audit/remediation task, independently review the whole repository, fix confirmed findings, and run targeted regressions. Cover correctness, security, lifecycle/recovery, deployment, user workflows, accessibility, and missing essential behavior.
- Keep an explicit audit record. A clean round means no new actionable findings across the complete review scope. Any new finding or subsequent code change resets the consecutive-clean-round count.
- Only after three consecutive complete audit rounds produce no new findings may the final full test suite run. If it exposes an issue, repair it, run targeted tests, and repeat the clean-round gate before another full run.
- Never count skipped tests or untested external integrations as passed. Do not claim a clean audit proves the absence of all defects.

## Runtime and deployment

- Keep the pinned Codex CLI and generated `protocol/` schemas synchronized. Validate compatibility using an isolated CLI runtime and independent test homes, not the developer's account or sessions.
- No paid model or external MCP invocation without explicit authorization for that validation run.
- Use the 120 test environment when Linux/systemd validation is needed; do not use the retired 110 production environment. Preserve existing running services and data. Routine tests must use isolated directories/ports. Do not deploy or restart an online instance unless the task explicitly includes it.
- Preserve authentication, unknown-operation recovery, approval validation, capacity limits, and worker/control-plane isolation when changing the UI.
