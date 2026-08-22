# OpenAI（ChatGPT 账号）供应商预设

这是 codex 的原生形态：**不需要写任何 `config.toml`**，登录即可用。

## 一键切换到本模式

```bash
bash deploy/providers/openai/setup.sh
```

切换到原生 OpenAI 模式只需移除 live config 软链（恢复零配置）。其它模式的配置集保留在 ~/.codex/providers/<mode>/，API 密钥不会被清除——如需彻底删除，手动删除对应目录。安装器选择 `PROVIDER=openai` 时会自动执行。

## 登录（无头服务器友好）

```bash
sudo systemctl stop codex-harness   # 网关持有 codex 子进程时先停
codex login --device-auth           # 按提示在任意浏览器完成设备码授权
sudo systemctl start codex-harness
```

也可以直接在 WebUI 里点右上角「登录」按钮走设备码流程（API-Key 模式之外自动出现）。

## 可选覆盖

如需固定模型等，可创建 `~/.codex/config.toml`：

```toml
model = "gpt-5.2-codex"
```

更多键见官方 config 文档。**不要**设置 `model_provider` / `model_providers.*` / `model_catalog_json`——那是第三方供应商（如智谱预设）使用的键；误配置后重跑本目录 `setup.sh` 即可清理。

## 注意

- ChatGPT 账号登录有地区限制，服务器需在可访问 OpenAI 的网络内
- MCP 服务器配置（若需要）与供应商无关，参照主 README；`[features]` 开关只在智谱四件套场景必需
