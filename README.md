# opencode-atoll-bridge

Show [OpenCode](https://opencode.ai) session progress inside [Atoll](https://github.com/Ebullioscopic) on macOS — in the Dynamic Island (notch).

[简体中文](README.zh.md)

- **Collapsed**: a Live Activity (capsule) that shows *which session* and *which phase*, and stays put while work is running.
- **Expanded**: a persistent **Notch Experience** tab, “OpenCode”, listing every active session with a progress ring.
- **Completion**: when a turn finishes, the Live Activity pops the task name with a looping check-mark Lottie animation, then returns to idle.

It is a small, dependency-free Node.js bridge between the OpenCode local HTTP API and the Atoll extension RPC protocol.

> ⚠️ **Unofficial.** This is a community project, not affiliated with or endorsed by the OpenCode or Atoll authors. See [NOTICE](NOTICE).

## Requirements

- macOS with [Atoll](https://github.com/Ebullioscopic) installed (v2.3.3 tested).
- [OpenCode](https://opencode.ai) v2 with its background service running (`opencode service status`).
- Node.js ≥ 18 (uses the global `WebSocket` and `fetch`). No npm packages.

## How it works

```
OpenCode SSE (/api/event) + session poll (/api/session)
  → per-session state (busy, phase, attention, tokens, …)
  → Atoll Live Activities   (collapsed, up to ATOLL_CAPACITY)
  → Atoll Notch Experience  (expanded, persistent tab)
```

- The OpenCode API endpoint is discovered automatically via `opencode service status` (no hardcoded port).
- Authentication uses the HTTP Basic password stored in `~/.config/opencode/service.json`.
- The Atoll RPC endpoint defaults to `ws://127.0.0.1:9020`.

## Install

Clone into a **TCC-safe** location. macOS blocks LaunchAgents from reading `~/Documents`, so use `~/.opencode-atoll-bridge`:

```sh
git clone https://github.com/Triones7/opencode-atoll-bridge.git ~/.opencode-atoll-bridge
~/.opencode-atoll-bridge/install.sh
```

`install.sh` copies the repo into place (if needed), writes a LaunchAgent property list, and starts it. Flags:

```sh
./install.sh --no-launch   # install files only
./install.sh --uninstall   # stop and remove the LaunchAgent (keeps files)
```

Verify:

```sh
launchctl list | grep opencode-bridge
tail -f ~/.opencode-atoll-bridge/bridge.log
```

To use a different install directory, set `BRIDGE_DIR` before running `install.sh`.

## Configuration

All settings are optional; everything below is an environment variable you can export before launching, or add to the plist.

| Variable | Default | Description |
|------|--------|------|
| `ATOLL_RPC_URL` | `ws://127.0.0.1:9020` | Atoll extension RPC address |
| `ATOLL_BUNDLE_ID` | `com.example.opencode-atoll` | Extension identity (Atoll authorizes/throttles by this) |
| `OPENCODE_API` | auto-detected via `opencode service status` (fallback `http://127.0.0.1:49374`) | OpenCode local API |
| `ATOLL_CAPACITY` | `4` | Max simultaneous Live Activities |
| `RPC_INTERVAL_MS` | `1100` | Minimum gap between RPC calls (Atoll rate limit ≈ 1/sec) |
| `SESSION_TTL_MS` | `120000` | Drop sessions silent this long |
| `IDLE_HOLD_MS` | `10000` | Keep an idle session this long before dismissing |
| `POLL_MS` | `5000` | `/api/session` poll interval |
| `TICK_MS` | `400` | Reconcile tick |
| `NOTCH_ENABLED` | `1` | Set `0` to disable the Notch Experience tab |
| `NOTCH_LOGO_PATH` | `<script dir>/opencode-icon.png` | OpenCode logo (PNG); falls back to an SF Symbol |
| `COMPLETE_HOLD_MS` | `4000` | How long the “completed” Live Activity is shown |
| `COMPLETION_LOTTIE_PATH` | `<script dir>/completion.json` | Check-mark Lottie; falls back to an SF Symbol |
| `BRIDGE_LOCK_PATH` | `~/.cache/opencode-atoll-bridge.lock` | Singleton lock path |

## Status model

Busy is derived from `/api/session` (`time.busy > time.idle`), **not** from `Session.Info.outcome` (which only reports the *previous* turn and can already read `succeeded` while work continues).

| Phase | Trigger | Subtitle |
|------|----------|----------|
| Step | `session.step.started` | 第 N 步 |
| Thinking | `session.reasoning.started` | 思考中 |
| Tool | `session.tool.input.started` / `session.tool.called` | 工具：\<name\> |
| Output | `session.text.started` | 输出中 |
| Compacting | `session.compaction.started` | 压缩上下文 |
| Idle | `session.idle` / `execution.succeeded\|failed\|interrupted` | 空闲 · 上一轮完成/失败/已中断 |

Title is the session `title` (or the project directory name when empty); the subtitle is prefixed with the directory name so multiple sessions stay distinguishable.

| State | Live Activity |
|------|---------------|
| Busy | OpenCode logo (20×20, radius 5), ring progress grows with steps, **does not disappear** |
| `permission.asked` | Orange accent, priority `high` + sneak peek, subtitle “等待授权：\<action\>” |
| `form.created` | Subtitle “需要选择：\<title\>” |
| Completed | See below |
| Idle | Kept for `IDLE_HOLD_MS` (default 10s), then dismissed |

Up to `ATOLL_CAPACITY` (default 4) activities, ordered by attention > busy > has-result > other.

### Completion state

On `session.execution.succeeded` the Live Activity pops a completion state for `COMPLETE_HOLD_MS` (default 4s):

- title = session title (or directory name), subtitle = “已完成”
- the leading logo gets a check-mark badge (`badgeIcon`)
- the right side shows a looping check-mark Lottie animation (`completion.json`)
- green accent, `priority = high`, `progress = 1`
- `present()` (not `update()`) is used once per completion to trigger the sneak peek

Failed/interrupted turns do **not** show the completion animation. A new `session.execution.started` clears the previous completion.

## Notch Experience (expanded)

Persistent tab “OpenCode” (header icon = OpenCode logo 32×32, radius 8; the tab *switcher* icon must be an SF Symbol, so it stays `terminal`). It is shown for as long as the bridge runs, decoupled from the Live Activity idle hold, and only lists **actively working** sessions (`busy` or waiting on a permission/form):

- one section per session, `layout: "columns"`: `title · directory · phase` on the left, a progress ring (diameter 20) on the right;
- when nothing is active, a single stack section reads “当前无进行中的会话”.

## Security

Atoll 2.3.3’s RPC service listens on `*:9020` (wildcard) and authorizes clients purely by their self-declared `bundleIdentifier`; the protocol has no authentication. On macOS, block inbound connections to Atoll with the Application Firewall:

```sh
/usr/libexec/ApplicationFirewall/socketfilterfw --blockapp /Applications/Atoll.app
```

Note this blocks **all** ports for Atoll, including its LocalSend feature (UDP `53317` / multicast `224.0.0.167`). To keep LocalSend, use `pf` to block only TCP `9020` instead (requires admin).

## Troubleshooting

| Symptom | Check |
|---|---|
| Nothing appears | `launchctl list \| grep opencode-bridge`; `tail ~/.opencode-atoll-bridge/bridge.err.log` |
| “cannot read OpenCode service password” | `~/.config/opencode/service.json` must contain a `password` field |
| Not connecting to OpenCode | `opencode service status` should print `http://127.0.0.1:<port>`; the bridge logs the URL it detected |
| Duplicate activities | Only one instance may run; the singleton lock is `~/.cache/opencode-atoll-bridge.lock` |
| Icon/animation missing | Confirm `opencode-icon.png` / `completion.json` sit next to `bridge.mjs` |

## Project layout

```
bridge.mjs                        main program
run.sh                            LaunchAgent wrapper (resolves node, runs bridge.mjs)
install.sh                        installer (plist + launchctl)
ai.atoll.opencode-bridge.plist.template
completion.json                   check-mark Lottie for the completion state
opencode-icon.png                 OpenCode logo (see NOTICE)
examples/poc.mjs                  minimal RPC present/update/dismiss demo
examples/capture-events.mjs       dump the OpenCode SSE stream (debugging)
```

## License

MIT — see [LICENSE](LICENSE). Trademarks and attribution: [NOTICE](NOTICE).
