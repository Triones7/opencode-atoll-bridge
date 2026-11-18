# opencode-atoll-bridge

把 [OpenCode](https://opencode.ai) 的会话进度显示到 macOS 上的 [Atoll](https://github.com/Ebullioscopic)（灵动岛）里。

[English](README.md)

- **收起态**：Live Activity（胶囊），显示「哪个会话 · 当前阶段」，繁忙期间常驻。
- **展开态**：常驻的 **Notch Experience** 标签页「OpenCode」，列出所有进行中的会话 + 进度环。
- **完成态**：一轮对话结束时，Live Activity 弹出任务名 + 循环对勾 Lottie 动画，随后回到空闲态。

这是一个零依赖的小型 Node.js 桥接程序，连接 OpenCode 本机 HTTP API 与 Atoll 扩展 RPC 协议。

> ⚠️ **非官方**。社区项目，与 OpenCode / Atoll 作者无隶属关系。见 [NOTICE](NOTICE)。

## 前置条件

- 安装 [Atoll](https://github.com/Ebullioscopic) 的 macOS（实测 v2.3.3）。
- [OpenCode](https://opencode.ai) v2，且后台服务在运行（`opencode service status`）。
- Node.js ≥ 18（用到全局 `WebSocket` 与 `fetch`）。无需 npm 包。

## 工作原理

```
OpenCode SSE (/api/event) + 轮询 (/api/session)
  → 每会话状态（busy、阶段、attention、tokens…）
  → Atoll Live Activity（收起态，最多 ATOLL_CAPACITY 个）
  → Atoll Notch Experience（展开态，常驻标签页）
```

- OpenCode API 地址通过 `opencode service status` **自动发现**，无需硬编码端口。
- 认证使用 `~/.config/opencode/service.json` 里的 HTTP Basic 密码。
- Atoll RPC 默认 `ws://127.0.0.1:9020`。

## 安装

请克隆到 **TCC 安全**的位置：macOS 会阻止 LaunchAgent 读取 `~/Documents` 下的脚本，因此默认用 `~/.opencode-atoll-bridge`：

```sh
git clone https://github.com/Triones7/opencode-atoll-bridge.git ~/.opencode-atoll-bridge
~/.opencode-atoll-bridge/install.sh
```

`install.sh` 会把仓库复制到位（如需要）、写入 LaunchAgent plist 并启动。参数：

```sh
./install.sh --no-launch   # 只安装文件，不动 launchd
./install.sh --uninstall   # 停止并移除 LaunchAgent（保留文件）
```

验证：

```sh
launchctl list | grep opencode-bridge
tail -f ~/.opencode-atoll-bridge/bridge.log
```

想用其他安装目录：运行前设置 `BRIDGE_DIR`。

## 配置

全部为可选环境变量，可在启动前 export，或写进 plist。

| 变量 | 默认值 | 说明 |
|------|--------|------|
| `ATOLL_RPC_URL` | `ws://127.0.0.1:9020` | Atoll 扩展 RPC 地址 |
| `ATOLL_BUNDLE_ID` | `com.example.opencode-atoll` | 扩展身份标识（Atoll 按此授权/限速） |
| `OPENCODE_API` | 由 `opencode service status` 自动发现（回退 `http://127.0.0.1:49374`） | OpenCode 本机 API |
| `ATOLL_CAPACITY` | `4` | 同时显示的 Live Activity 上限 |
| `RPC_INTERVAL_MS` | `1100` | 相邻 RPC 调用最小间隔（Atoll 限速约 1 次/秒） |
| `SESSION_TTL_MS` | `120000` | 会话静默多久后不再显示 |
| `IDLE_HOLD_MS` | `10000` | 会话空闲后保留显示多久再 dismiss |
| `POLL_MS` | `5000` | 轮询 `/api/session` 的间隔 |
| `TICK_MS` | `400` | reconcile  tick |
| `NOTCH_ENABLED` | `1` | 设为 `0` 关闭 Notch Experience 标签页 |
| `NOTCH_LOGO_PATH` | `<脚本目录>/opencode-icon.png` | OpenCode logo（PNG）；缺失时回退 SF Symbol |
| `COMPLETE_HOLD_MS` | `4000` | 完成态显示多久后回到空闲态 |
| `COMPLETION_LOTTIE_PATH` | `<脚本目录>/completion.json` | 完成态对勾 Lottie；缺失时回退 SF Symbol |
| `BRIDGE_LOCK_PATH` | `~/.cache/opencode-atoll-bridge.lock` | 单例锁路径 |

## 状态模型

繁忙判定用 `/api/session` 的 `time.busy > time.idle`，**不**依赖 `Session.Info.outcome`（它只是**上一轮**的结果，会在会话仍在工作时就变成 `succeeded`）。

| 阶段 | 触发事件 | 字幕 |
|------|----------|------|
| 步骤 | `session.step.started` | 第 N 步 |
| 思考 | `session.reasoning.started` | 思考中 |
| 工具 | `session.tool.input.started` / `session.tool.called` | 工具：\<name\> |
| 输出 | `session.text.started` | 输出中 |
| 压缩 | `session.compaction.started` | 压缩上下文 |
| 空闲 | `session.idle` / `execution.succeeded\|failed\|interrupted` | 空闲 · 上一轮完成/失败/已中断 |

标题为会话 `title`（空则用项目目录名），副标题前缀项目目录名，保证多会话可区分。

| 状态 | Live Activity |
|------|---------------|
| 繁忙 | OpenCode logo 图标（20×20，圆角 5），圆环进度随步数增长，**常驻不自动消失** |
| `permission.asked` | 橙色 accent，priority `high` + sneak peek，字幕「等待授权：\<action\>」 |
| `form.created` | 字幕「需要选择：\<title\>」 |
| 完成 | 见下节 |
| 空闲 | 保留 `IDLE_HOLD_MS`（默认 10s）后 dismiss |

多会话按 attention > busy > 有结果 > 其他排序，最多 `ATOLL_CAPACITY`（默认 4）个。

### 完成态

`session.execution.succeeded` 后，Live Activity 会弹一次完成态，持续 `COMPLETE_HOLD_MS`（默认 4s）：

- 标题 = 会话标题（空则目录名），副标题 = 「已完成」
- leading logo 上叠加对勾徽章（`badgeIcon`）
- 右侧 `trailingContent` 换成循环对勾 Lottie（`completion.json`）
- accent 绿色、`priority = high`、`progress = 1`
- 每次完成用 **`present`**（不是 `update`）触发一次 sneak peek

失败 / 被中断不弹完成态。新一轮 `session.execution.started` 会清掉上一轮完成态。

## Notch Experience（展开态）

常驻标签页「OpenCode」（header 图标 = OpenCode logo 32×32 圆角 8；标签**切换器**只认 SF Symbol，所以仍是 `terminal`）。bridge 运行期间一直存在，与 Live Activity 的 idle 保留策略解耦，只列出**正在进行**的会话（`busy` 或等待授权/选择）：

- 每个会话一个 section，`layout: "columns"`：左 `标题 · 目录 · 阶段`，右圆环进度（直径 20）。
- 无进行中会话时，单个 stack section 显示「当前无进行中的会话」。

## 安全提示

Atoll 2.3.3 的 RPC 服务在 `*:9020` 上**通配监听**，且仅凭客户端自报的 `bundleIdentifier` 授权，协议本身没有鉴权。建议在 macOS 上用 Application Firewall 阻断 Atoll 的入站连接：

```sh
/usr/libexec/ApplicationFirewall/socketfilterfw --blockapp /Applications/Atoll.app
```

注意：ALF 是**按 App 全端口**封锁，会一并阻断 Atoll 内置的 LocalSend 快传（UDP `53317` / 组播 `224.0.0.167`）。若需保留 LocalSend，改用 pf 只封 TCP `9020`（需管理员权限）。

## 故障排查

| 现象 | 检查 |
|---|---|
| 完全没显示 | `launchctl list \| grep opencode-bridge`；`tail ~/.opencode-atoll-bridge/bridge.err.log` |
| 报「cannot read OpenCode service password」 | `~/.config/opencode/service.json` 需含 `password` 字段 |
| 连不上 OpenCode | `opencode service status` 应打印 `http://127.0.0.1:<port>`；bridge 日志会打印它探测到的 URL |
| 重复显示 | 同时只能有一个实例；单例锁在 `~/.cache/opencode-atoll-bridge.lock` |
| 图标/动画缺失 | 确认 `opencode-icon.png` / `completion.json` 与 `bridge.mjs` 同目录 |

## 项目结构

```
bridge.mjs                        主程序
run.sh                            LaunchAgent 包装（解析 node，运行 bridge.mjs）
install.sh                        安装脚本（写 plist + launchctl）
ai.atoll.opencode-bridge.plist.template
completion.json                   完成态对勾 Lottie
opencode-icon.png                 OpenCode logo（见 NOTICE）
examples/poc.mjs                  最小 RPC present/update/dismiss 示例
examples/capture-events.mjs       抓取 OpenCode SSE 事件（调试用）
```

## 许可证

MIT — 见 [LICENSE](LICENSE)。商标与归属说明见 [NOTICE](NOTICE)。
