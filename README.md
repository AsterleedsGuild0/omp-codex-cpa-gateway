# codex-cpa-gateway

OMP 扩展：让内置 `openai-codex` provider 的对话和 `/live` 语音都走 [CLIProxyAPI](https://github.com/router-for-me/CLIProxyAPI)（CPA），语音支持主备两个渠道。

保留 `openai-codex` 这个 provider，模型的上下文窗口、兼容设置、Codex 网页搜索、服务档位等内置配置随 OMP 更新，无需在 `models.yml` 中逐个模型手写。

> [!NOTE]
> **已归档（2026-10-28）**：仓库转为只读，不再维护，也不接受 PR，作者暂时不使用 `/live` 语音。最后验证于 OMP 18.13.3（Tern 0.9.6 附带）和 CLIProxyAPI 8.0.44，对话地址覆盖和 `/live` 转接均可用。停止维护的原因：
>
> - `/live` 转接依赖 OMP 内部实现，升级后可能随时失效。
> - OMP 的 `/live` 把语音层写死为 `gpt-live-1-codex`，即第一代 GPT-Live；OpenAI 已推出后继的 GPT-Live-1.1。需要推理或调用工具时，语音层还要等当前会话的主模型跑完一整轮才能回答，实际使用时反应偏慢。
> - Tern 的 Carly 助手以 `--no-extensions` 启动；从 Tern 0.9.6 起，Carly 找 omp 不再经过 PATH，原先替换 `~/.local/bin/omp` 的适配办法很可能已失效，因此已删除该适配。
>
> 需要时可以 fork 继续使用。

## 功能

- **对话地址覆盖**：设置 `CODEX_CPA_BASE_URL` 后，会话启动时把 `openai-codex` 的地址覆盖为该值。只修改运行时配置，不写回 `models.yml`。
- **`/live` 转接**：OMP 的 `/live` 固定连接官方 Codex 并要求 OAuth。扩展在进程内把建立通话请求改发到 CPA 的 `/v1/live`，把事件通道改连 `/v1/live/{callId}`，并用 CPA Key 认证，因此不需要官方 OAuth 登录。即使登录了官方 Codex OAuth，只要配置了主渠道，`/live` 仍走 CPA，OAuth token 不会发出。
- **语音主备**：建立通话时先使用主渠道，按下表处理失败。

| 主渠道结果 | 处理 |
|---|---|
| 429 | 按响应中的 `reset_seconds` 冷却（缺失时依次使用 `Retry-After`、60 秒），本次改用备用渠道 |
| 5xx 或连接失败 | 本次改用备用渠道，不冷却 |
| 401、400 等其他错误 | 不切换，直接报错，以免掩盖配置问题 |
| 冷却中 | 直接使用备用渠道；冷却到期后自动回到主渠道 |

所有渠道都在冷却时，按恢复时间先后依次尝试。冷却状态只保存在当前 OMP 进程中。事件通道总是连回发出该通话 ID 的渠道。通话中额度耗尽时，本次通话结束，不会中途切换。

## 要求

- 已验证版本：OMP 18.13.2、18.13.3，CLIProxyAPI 8.0.44。CPA 需提供 `/v1/live`，并配置可用的 Codex OAuth 账号。
- `openai-codex` 已在 `models.yml` 中接到 CPA，例如：

```yaml
providers:
  openai-codex:
    baseUrl: http://localhost:8317/backend-api
    auth: apiKey
    apiKey: YOUR_CPA_KEY_ENV   # 环境变量名或字面值
```

## 安装

```sh
git clone https://github.com/AsterleedsGuild0/omp-codex-cpa-gateway.git ~/.omp/agent/extensions/codex-cpa-gateway
```

Windows PowerShell 将目标路径换成 `$HOME\.omp\agent\extensions\codex-cpa-gateway`。

OMP 会自动加载 `~/.omp/agent/extensions/` 下的扩展。如果 `~/.omp` 本身是 Git 仓库，且 `.gitignore` 忽略了该目录，自动发现会跳过它，需要在 `~/.omp/agent/config.yml` 中显式加载：

```yaml
extensions:
  - ~/.omp/agent/extensions/codex-cpa-gateway
```

更新：在扩展目录执行 `git pull`，然后重启 OMP。

## 配置

只读取以下环境变量。地址可以填 CPA 根地址，也可以填带 `/backend-api` 或 `/v1` 的地址。

| 变量 | 作用 |
|---|---|
| `CODEX_CPA_BASE_URL` | 覆盖 `openai-codex` 的对话地址；不设置则使用 `models.yml` 的配置 |
| `CODEX_CPA_LIVE_PRIMARY_URL` / `_KEY` | 语音主渠道；不设置则不转接 `/live` |
| `CODEX_CPA_LIVE_BACKUP_URL` / `_KEY` | 语音备用渠道，可选 |

每个渠道的 URL 和 Key 必须同时设置。只设置其中一项时，该渠道会被忽略，并写入警告日志。

可以把这些变量指向你已有的变量，例如：

```zsh
export CODEX_CPA_LIVE_PRIMARY_URL="$MY_LOCAL_CPA_URL"
export CODEX_CPA_LIVE_PRIMARY_KEY="$MY_LOCAL_CPA_KEY"
export CODEX_CPA_LIVE_BACKUP_URL="$MY_REMOTE_CPA_URL"
export CODEX_CPA_LIVE_BACKUP_KEY="$MY_REMOTE_CPA_KEY"

# 临时把对话切到另一台 CPA
omp-remote() { CODEX_CPA_BASE_URL="$MY_REMOTE_CPA_URL" omp "$@"; }
```

## 限制

- `/live` 转接依赖 OMP 内部实现：认证对象的 `oauth.access`，以及 `/live` 使用的全局 `fetch` 和 `WebSocket`。OMP 升级后如果失效，表现为 `/live` 报错，对话不受影响。升级后建议实际测试一次 `/live`。
- `openai-codex` 没有可用 OAuth 时，扩展会向 OMP 提供一个占位凭据，让 `/live` 通过检查。其他功能如果拿到这个凭据并请求官方地址，扩展会在本地返回 401，不发出请求。
- 转接后的 `/live` 请求直接连接 CPA，不使用 OMP 为官方地址解析的代理。
- 音频由本机与 OpenAI 媒体服务器直接通过 WebRTC 传输。除非 CPA 开启了 `codex.live-media-relay`，否则 CPA 只转发建立通话和事件通道。

## 开发

```sh
bun test
```

测试覆盖渠道选择、冷却解析和失败分类（`channels.ts`）。网络改写部分需要在隔离的 OMP 中实际运行 `/live` 验证。

## 许可证

[MIT](LICENSE)
