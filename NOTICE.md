# Third-party notices

`protocol/` is generated from the official `@openai/codex` distribution, version 0.164.0, maintained by OpenAI: https://github.com/openai/codex. It is an upstream protocol artifact, not hand-written Harness application code. Its original generated headers are retained. See `reference/PROVENANCE.json` for the verified package and generation commands.

Codex and all npm dependencies retain their respective upstream licenses. Their license files remain with the distributions in installed releases. The Harness application code is MIT licensed; this does not change any upstream project's license.

The optional service proxy downloads an unmodified Xray runtime from official [XTLS/Xray-core releases](https://github.com/XTLS/Xray-core/releases) when the server operator requests it. Xray-core is licensed under the [Mozilla Public License 2.0](https://github.com/XTLS/Xray-core/blob/main/LICENSE); the corresponding source is available from the selected release's tag. Xray source, binaries and routing-data files are not bundled in this repository. Downloaded components and routing data retain their upstream licenses; the Harness MIT license does not relicense them.

Official documentation is used as a reference, and is linked in the design and verification documents. Downloaded documentation and temporary runtimes are excluded from this repository.
