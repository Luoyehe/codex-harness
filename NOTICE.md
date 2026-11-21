# Third-party notices

`protocol/` is generated from the official `@openai/codex` distribution, version 0.169.0, maintained by OpenAI: https://github.com/openai/codex. It is an upstream protocol artifact, not hand-written Harness application code. Its original generated headers are retained. See `reference/PROVENANCE.json` for the verified package and generation commands.

Codex and all npm dependencies retain their respective upstream licenses. Their license files remain with the distributions in installed releases. The Harness application code is MIT licensed; this does not change any upstream project's license.

Harness applies a local security patch to [picomatch 4.0.7](https://github.com/micromatch/picomatch/releases/tag/4.0.7) for [GHSA-fc5q-39xc-vjpf](https://github.com/advisories/GHSA-fc5q-39xc-vjpf). The patch is distributed in `patches/picomatch@4.0.7.patch`. The installed package retains its upstream version and MIT license.

The optional service proxy downloads an unmodified Xray runtime from official [XTLS/Xray-core releases](https://github.com/XTLS/Xray-core/releases) when the server operator requests it. Xray-core is licensed under the [Mozilla Public License 2.0](https://github.com/XTLS/Xray-core/blob/main/LICENSE); the corresponding source is available from the selected release's tag. Xray source, binaries and routing-data files are not bundled in this repository. Downloaded components and routing data retain their upstream licenses; the Harness MIT license does not relicense them.

Official documentation is used as a reference, and is linked in the design and verification documents. Downloaded documentation and temporary runtimes are excluded from this repository.

The deployment package includes the pure-Python sources and MIT license from [Tomli 2.5.0](https://pypi.org/project/tomli/2.5.0/) under `deploy/_tomli/`. The local changes in `_re.py` retain year zero, leap seconds and fractional precision outside Python datetime’s range. The upstream source archive SHA256 is `264507556cd8b8c8e7c6ee037cdf443a463f03f4c958e57195e3d369711b8ff6`.
