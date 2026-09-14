# 自定义 OpenAI 兼容 API 供应商预设

面向本地 **vLLM / 中转站**等提供 OpenAI **Responses API** 的服务。

> ⚠️ codex 0.149 起 `wire_api = "chat"` 已被移除，仅支持 Responses API——
> 端点必须提供 `POST <base_url>/responses`（较新的 vLLM 版本已内置支持；
> 纯 Chat Completions 的服务无法作为 codex 供应商使用）。

## 一键装配

```bash
sudo codex-harness provider custom
```

交互向导依次询问 `base_url`、API Key（隐藏输入，可留空）、模型和图片能力；管理命令会以 systemd 服务用户及其真实 `HOME` / `CODEX_HOME` 执行并自动重启。优先使用此方式，避免把 Key 写进 shell 历史、进程参数或 `/root/.codex`。

行为要点：

- 写入 `model_provider = "custom"` + `[model_providers.custom]`（`wire_api = "responses"`）
- **排他激活**：替换供应商选择和本项目管理的智谱 MCP 设置，保留其它用户配置与自定义 MCP；与 OpenAI 原生/智谱预设互不干扰
- 首次生成所选模型的 `models.json` 条目；同一端点再配置其它模型时保留各自已声明的能力。WebUI 下拉仅显示已配置的真实模型；`CUSTOM_CTX` 声明该模型的上下文窗口（默认 131072，按服务实际填写，例如 vLLM 的 `max_model_len`）
- **effort 档位默认不探测**：按配置的默认档生成 catalog，不产生推理请求。只有明确接受真实 API 请求及可能费用时，才用 `sudo PROBE_REASONING=1 codex-harness provider custom` 逐一探测 7 档（none/minimal/low/medium/high/xhigh/max）；`CUSTOM_EFFORT` 可指定默认档
- **同步目录不等于重配**：WebUI 同步会读取端点 `/models`，保留当前模型和各已配置模型自己的能力。只返回 ID 的新模型记入 `unconfigured_models`，能力标记为未知，不能继承当前模型的窗口、图片、工具或 effort，也不会直接出现在可用模型下拉中；先按该模型的实际规格单独配置再使用。当前模型不在返回目录中或获取失败时不提交；同步永不发付费探测，内容不变时不重启。
- `CUSTOM_VISION=1`（或交互选 y）声明图片输入：codex 会把上传的图片原生发给端点（vLLM 需 `--limit-mm-per-prompt.image`）；实测 Qwen 视觉描述准确
- 本地无鉴权服务 Key 留空即可；生成的 provider 配置会省略 `env_key`，请求也不会发送 `Authorization` 头。为空表示明确使用无鉴权，不会沿用其它端点的旧 Key

实测矩阵（Qwen3.8-27B-FP8 @ vLLM，`--enable-auto-tool-choice --tool-call-parser qwen3_xml`）：纯对话 ✓、命令执行（模型自主跑 shell 并回报输出）✓、文件附件（模型 cat 读取）✓、图片附件（原生视觉）✓。注意：工具调用需 vLLM 开启 auto-tool-choice，否则模型无法执行命令/读文件。

配置写入使用完整 TOML 语义解析，保留值和未知用户字段；注释与排版会规范化，原版本仍在私有快照中。配置、目录和规范 EnvironmentFile 先在 `<CODEX_HOME>/providers/.versions/` 生成并验证，再通过 `.active` 指针一次提交；失败不替换活动版本。不要手动把公开配置或 EnvironmentFile 的受管理链接替换成普通文件。
