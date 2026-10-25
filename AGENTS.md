# Clean-room rewrite agreements

This directory is a new implementation. Do not inspect, copy, adapt or import code, tests, assets, build files or Git history from any previous codex-harness checkout. The sibling archival repository is not an implementation reference. PROBLEM-ACCEPTANCE.md supplies historical failure scenarios; reference/PROTOCOL-CONTRACT.md and freshly generated protocol/ supply the official upstream contract. Existing user-facing functionality is a requirement, not an architecture template.

Use narrow modules with explicit ownership. Never substitute a mock, placeholder or disabled feature for a required real workflow without documenting the incomplete work. Preserve single-administrator authentication, separate worker and control identities, persistent receipts, unknown outcomes, approval validation, bounded resources, and recovery after disconnection or restart.

During implementation run only affected tests and necessary type/build/security checks. Do not run a full suite until three consecutive independent full-repository audits of an unchanged source snapshot report no new actionable issue. Any fix resets that count. Record scope, evidence, skips and untested integrations honestly. If full tests reveal a defect, fix it and repeat this gate.

Do not read personal CODEX_HOME or credentials for tests; no paid inference or real external MCP calls in this run. Use isolated homes and local protocol substitutes. Linux/systemd tests use isolated paths/ports on 192.168.1.120; leave existing services running. Do not use the retired 110 deployment. No deployment or migration of an online instance as part of routine tests.

All temporary tools, downloaded runtimes and evidence belong under ignored reference/runtime, reference/evidence or .work. Pin dependencies and CLI versions. Regenerate protocol only from verified official distributions. Secrets, sessions, private keys and generated runtime homes must never enter Git.
