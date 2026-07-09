# codex-glm-proxy

轻量本地代理，用来让无头 Codex 调用 GLM-5.2 时复用 MultiCC 已验证过的稳定性逻辑，但不启动 MultiCC GUI。

## 作用

- 提供 `http://127.0.0.1:3017/v1/responses` 给 Codex 使用。
- 提供 `http://127.0.0.1:3017/v1/chat/completions` 给 AionUI/OpenAI 兼容客户端使用。
- 从仓库根目录的 `providers.json` 读取本地讯飞 MaaS provider 配置（API Key 建议通过环境变量注入）。
- 也可用 `GLM_PROVIDERS_JSON` / `XF_PROVIDERS_JSON` / `MULTICC_PROVIDERS_JSON` 覆盖。
- 不复制、不打印、不提交密钥。
- 对讯飞 `10012 / EngineInternalError:1105 / system busy` 做代理层重试。
- AionUI 使用 `/v1/chat/completions` 流式调用时，上游 408/429/500/502/503/504 或忙碌错误会直接在会话面板里显示代理重试提示；默认按稳态间隔持续重试，客户端关闭请求可立即停止。
- 如果上游有输出但缺少 `response.completed`，在代理层补齐，减少 Codex 外层断流。

## 常用命令

启动代理（默认 version1）：

```powershell
.\start-proxy.ps1
```

可选切换参数（两种优化方案）：

```powershell
# 兼容版（默认）：更偏向稳定，重试更保守
.\start-proxy.ps1 -Profile version1

# 稳健版：更偏向可用性，重试更积极/更长超时
.\start-proxy.ps1 -Profile version2
```

调用 GLM-5.2 最高档：

```powershell
.\invoke-glm52.ps1 -Workdir "C:\Users\shuai\Documents\Codex\Sedna" -Prompt "请用中文回答：GLM 链路正常。"
```

停止代理：

```powershell
.\stop-proxy.ps1
```

## 配置

默认值：

- 端口：`3017`
- provider：`5672307d-a380-433f-9a28-23c6b2ba95ea`
- provider 配置：`.\providers.json`

可用环境变量覆盖：

- `GLM_PROXY_PORT`
- `XF_PROVIDER_ID`
- `GLM_PROVIDERS_JSON`
- `XF_PROVIDERS_JSON`
- `MULTICC_PROVIDERS_JSON`
- `XF_BUSY_RETRY_MAX`：`/v1/responses` 的重试上限配置；当前实现会按 `responsesRetryMax` 对应的最高重试档位间隔持续重试，直到客户端中断。
- `XF_CHAT_BUSY_RETRY_MAX`：`/v1/chat/completions` 的重试上限配置；当前实现会按稳态间隔持续重试，直到客户端中断。
- `XF_CHAT_DIAGNOSTIC_EVERY`：每多少次失败在 AionUI 面板打印一次重试提示。
- `XF_CHAT_STEADY_RETRY_DELAY_MS`：`chat/completions` 持续重试间隔。
- `XF_UPSTREAM_TIMEOUT_MS`：上游请求超时（默认按 profile 下发）。
- `XF_MAX_JSON_BODY_BYTES`：请求体最大字节数（默认按 profile 下发）。
- `XF_CHAT_PANEL_DIAGNOSTICS`：默认开启；设为 `0` 可关闭 AionUI 面板里的代理诊断提示。
- `XF_MAAS_API_KEY`：优先用于认证，优先级高于 `providers.json` 内的 key 字段；建议在环境变量中配置（不建议在文件中明文放置 key）。
- `XF_MAAS_RESPONSES_URL`
- `XF_MAAS_CHAT_COMPLETIONS_URL`

## 边界

这个目录只负责无头 Codex -> GLM-5.2 的本地代理，不提供 MultiCC 的会话、GUI、aux、任务面板或历史记录。
