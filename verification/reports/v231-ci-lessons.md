# v2.3.1 CI regression notes

The first full run (41299562756, commit c923ff9) failed the same two UI assertions on Linux and Windows. It remains failed; the coverage job correctly refused incomplete Linux evidence. Root deployment tests passed, as did ordinary deployment and Go groups subject to their recorded platform skips. Security checks passed separately; existing CodeQL dispositions do not mean zero alerts.

The device-login test waited for a closed-handoff message, then immediately assumed the subsequent account refresh had completed. The replacement test controls that second response, verifies that login remains disabled during reading, and only expects readiness after releasing the response. It preserves exact login/read counts and adds no delay, retry or timeout relaxation.

The shared-directory test still expected a saved explicit model/provider choice to wait for conversation defaults. That expectation contradicted the intended recovery behavior. The revised test checks the explicit choice against the current shared catalog while sending remains blocked, then checks account invalidation, draft preservation and rejection of a late response from an old runtime. Product code was unchanged.

For future changes to central account/model/session UI state, include consumers such as `shared-model-directory`, application lifecycle and draft restoration in affected testing. The existing selector already maps web changes to the web test partition; this release's narrower manual selection omitted one relevant integration test. After correcting both fixtures, the complete affected web partition passed 88 files and 1121 cases. That is targeted web verification, not a substitute for full repository CI.

CI2 is explicitly dispatched with the original reviewed release base so that the complete inventory is selected. A normal push containing only these test fixes would select a smaller affected scope. The `[skip ci]` marker avoids that duplicate automatic run; it does not waive the explicitly dispatched full test or security jobs. Release and deployment still require successful actual coverage reconciliation.
