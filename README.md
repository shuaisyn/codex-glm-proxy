# codex-glm-proxy

轻量本地代理，用来让无头 Codex 调用 GLM-5.2 时复用 MultiCC 已验证过的稳定性逻辑，但不启动 MultiCC GUI。

## 作用

- 提供 `http://127.0.0.1:3017/v1/responses` 给 Codex 使用。
- 提供 `http://127.0.0.1:3017/v1/chat/completions` 给 AionUI/OpenAI 兼容客户端使用。
- 从 `..\MultiCC\providers.json` 读取本地讯飞 MaaS provider 配置和密钥。
- 不复制、不打印、不提交密钥。
- 对讯飞 `10012 / EngineInternalError:1105 / system busy` 做代理层重试。
- 如果上游有输出但缺少 `response.completed`，在代理层补齐，减少 Codex 外层断流。

## 常用命令

启动代理：

```powershell
.\start-proxy.ps1
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
- provider 配置：`..\MultiCC\providers.json`

可用环境变量覆盖：

- `GLM_PROXY_PORT`
- `XF_PROVIDER_ID`
- `MULTICC_PROVIDERS_JSON`
- `XF_BUSY_RETRY_MAX`
- `XF_MAAS_API_KEY`
- `XF_MAAS_RESPONSES_URL`

## 边界

这个目录只负责无头 Codex -> GLM-5.2 的本地代理，不提供 MultiCC 的会话、GUI、aux、任务面板或历史记录。
