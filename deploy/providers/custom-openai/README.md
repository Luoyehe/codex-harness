# 自定义 OpenAI 兼容 API 供应商预设

面向本地 **vLLM / 中转站**等提供 OpenAI **Responses API** 的服务。

> ⚠️ codex 0.149 起 `wire_api = "chat"` 已被移除，仅支持 Responses API——
> 端点必须提供 `POST <base_url>/responses`（较新的 vLLM 版本已内置支持；
> 纯 Chat Completions 的服务无法作为 codex 供应商使用）。

## 一键装配

```bash
bash deploy/providers/custom-openai/setup.sh
# 交互引导：base_url → API Key(可空) → 自动拉取模型列表并选择 →
#          是否支持图片输入 → 自动探测思考档位并选择默认档
# 无人值守：
CUSTOM_BASE_URL=http://127.0.0.1:8000/v1 CUSTOM_MODEL=my-model \
CUSTOM_API_KEY=sk-xxx CUSTOM_CTX=131072 CUSTOM_VISION=1 \
bash deploy/providers/custom-openai/setup.sh
```

行为要点：

- 写入 `model_provider = "custom"` + `[model_providers.custom]`（`wire_api = "responses"`）
- **排他激活**：剥离其它供应商的键与 MCP 服务器（留时间戳备份），与 OpenAI 原生/智谱预设互不干扰
- 生成单模型 `models.json` 目录，WebUI 的模型下拉会显示你的真实模型；`CUSTOM_CTX` 声明上下文窗口（默认 131072，按服务实际填写，例如 vLLM 的 `max_model_len`）
- **effort 档位自动探测**：setup 时对端点逐一探测 7 档（none/minimal/low/medium/high/xhigh/max）并写入 catalog——WebUI 输入框出现「思考程度」选择框，只列出端点实际接受的档位（实测 Qwen vLLM: none/low/medium/xhigh；DeepSeek: 全部 7 档）；`CUSTOM_EFFORT` 指定默认档（不在探测结果内会报错）
- `CUSTOM_VISION=1`（或交互选 y）声明图片输入：codex 会把上传的图片原生发给端点（vLLM 需 `--limit-mm-per-prompt.image`）；实测 Qwen 视觉描述准确
- 本地无鉴权服务 Key 留空即可（内部以占位值发送，vLLM 不校验）

实测矩阵（Qwen3.8-27B-FP8 @ vLLM，`--enable-auto-tool-choice --tool-call-parser qwen3_xml`）：纯对话 ✓、命令执行（模型自主跑 shell 并回报输出）✓、文件附件（模型 cat 读取）✓、图片附件（原生视觉）✓。注意：工具调用需 vLLM 开启 auto-tool-choice，否则模型无法执行命令/读文件。
