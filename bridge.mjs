#!/usr/bin/env node
// bridge.mjs — show OpenCode session progress in Atoll.
//
// Pipeline:
//   OpenCode SSE (/api/event) + session poll (/api/session)
//     -> per-session state (busy, phase, attention, tokens, ...)
//     -> Atoll Live Activities (collapsed notch, up to CAPACITY)
//     -> Atoll Notch Experience tab (expanded notch, minimal framework)
//
// Requirements: Node >= 18 (uses global WebSocket + fetch). No dependencies.
//
//   node bridge.mjs
//
// Env overrides:
//   ATOLL_RPC_URL     default ws://127.0.0.1:9020
//   ATOLL_BUNDLE_ID   default com.example.opencode-atoll
//   OPENCODE_API      auto-detected via `opencode service status`;
//                     fallback http://127.0.0.1:49374
//   ATOLL_CAPACITY    default 4   (Atoll's own live-activity capacity)
//   RPC_INTERVAL_MS   default 1100 (Atoll rate limit is ~1 call/sec)
//   SESSION_TTL_MS    default 120000 (drop sessions silent this long)
//   IDLE_HOLD_MS      default 10000  (keep an idle session this long)
//   NOTCH_ENABLED     default 1      (set 0 to disable the notch tab)
//   NOTCH_LOGO_PATH   default <script dir>/opencode-icon.png (OpenCode logo)
//   COMPLETE_HOLD_MS  default 4000   (show the "completed" Live Activity this long)
//   COMPLETION_LOTTIE_PATH  default <script dir>/completion.json (Lottie check)

import {
  readFileSync,
  writeSync,
  closeSync,
  openSync,
  unlinkSync,
  mkdirSync,
} from "node:fs";
import { homedir } from "node:os";
import { basename, join } from "node:path";
import { fileURLToPath } from "node:url";
import { execFileSync } from "node:child_process";

const ATOLL_WS = process.env.ATOLL_RPC_URL || "ws://127.0.0.1:9020";
const BUNDLE_ID = process.env.ATOLL_BUNDLE_ID || "com.example.opencode-atoll";
const CAPACITY = Number(process.env.ATOLL_CAPACITY || 4);
const RPC_INTERVAL_MS = Number(process.env.RPC_INTERVAL_MS || 1100);
const SESSION_TTL_MS = Number(process.env.SESSION_TTL_MS || 120000);
const IDLE_HOLD_MS = Number(process.env.IDLE_HOLD_MS || 10000);
const NOTCH_ENABLED = process.env.NOTCH_ENABLED !== "0";
const LOGO_PATH =
  process.env.NOTCH_LOGO_PATH ||
  fileURLToPath(new URL("opencode-icon.png", import.meta.url));
const COMPLETE_HOLD_MS = Number(process.env.COMPLETE_HOLD_MS || 4000);
const COMPLETION_LOTTIE_PATH =
  process.env.COMPLETION_LOTTIE_PATH ||
  fileURLToPath(new URL("completion.json", import.meta.url));
const POLL_MS = Number(process.env.POLL_MS || 5000);
const TICK_MS = Number(process.env.TICK_MS || 400);

const log = (...a) => console.log(new Date().toISOString(), ...a);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// ---------------------------------------------------------------------------
// OpenCode API endpoint
// ---------------------------------------------------------------------------
// The OpenCode background service picks its own port, so discover it through
// the CLI instead of hardcoding one. Falls back to $OPENCODE_API, then to the
// historical default when the CLI is unavailable.
function resolveOpenCodeApi({ quiet = false } = {}) {
  if (process.env.OPENCODE_API) return process.env.OPENCODE_API;
  try {
    const out = execFileSync("opencode", ["service", "status"], {
      encoding: "utf8",
      timeout: 4000,
      stdio: ["ignore", "pipe", "ignore"],
    });
    const m = String(out).match(/https?:\/\/[^\s]+/);
    if (m) {
      if (!quiet) log("OpenCode: service URL:", m[0]);
      return m[0];
    }
  } catch (e) {
    if (!quiet)
      log("WARN: `opencode service status` failed, using default:", e.message);
  }
  return "http://127.0.0.1:49374";
}

let OPENCODE_API = resolveOpenCodeApi();

// Re-resolve when the event stream drops (the service may have restarted on a
// different port). Logs only when the URL actually changes.
function refreshOpenCodeApi() {
  const next = resolveOpenCodeApi({ quiet: true });
  if (next !== OPENCODE_API) {
    log("OpenCode: API URL changed", OPENCODE_API, "->", next);
    OPENCODE_API = next;
  }
}

// ---------------------------------------------------------------------------
// OpenCode credentials
// ---------------------------------------------------------------------------
function loadAuth() {
  try {
    const raw = JSON.parse(
      readFileSync(join(homedir(), ".config/opencode/service.json"), "utf8")
    );
    const password = raw.password;
    if (!password) throw new Error("no password field");
    return "Basic " + Buffer.from("opencode:" + password).toString("base64");
  } catch (e) {
    log("FATAL: cannot read OpenCode service password:", e.message);
    process.exit(1);
  }
}
const AUTH = loadAuth();

// ---------------------------------------------------------------------------
// Singleton lock — only one bridge instance at a time
// ---------------------------------------------------------------------------
const LOCK_PATH =
  process.env.BRIDGE_LOCK_PATH ||
  join(homedir(), ".cache", "opencode-atoll-bridge.lock");

function acquireLock() {
  try {
    mkdirSync(join(homedir(), ".cache"), { recursive: true });
    const fd = openSync(LOCK_PATH, "wx");
    writeSync(fd, String(process.pid));
    closeSync(fd);
    return true;
  } catch (e) {
    if (e.code !== "EEXIST") throw e;
  }
  let alive = false;
  try {
    const pid = Number(readFileSync(LOCK_PATH, "utf8").trim());
    if (pid && pid !== process.pid) {
      try {
        process.kill(pid, 0);
        alive = true;
      } catch {}
    }
  } catch {}
  if (alive) return false;
  try {
    unlinkSync(LOCK_PATH);
  } catch {}
  return acquireLock();
}

function releaseLock() {
  try {
    unlinkSync(LOCK_PATH);
  } catch {}
}

// ---------------------------------------------------------------------------
// Rate limiter — Atoll enforces ~1 RPC call/second per bundle identifier.
// Every present/update/dismiss goes through this single serial queue.
// ---------------------------------------------------------------------------
class RateLimiter {
  constructor(interval) {
    this.interval = interval;
    this.last = 0;
    this.queue = [];
    this.timer = null;
  }
  add(fn) {
    return new Promise((resolve, reject) => {
      this.queue.push({ fn, resolve, reject });
      this.pump();
    });
  }
  pump() {
    if (this.timer || this.queue.length === 0) return;
    const wait = Math.max(0, this.last + this.interval - Date.now());
    this.timer = setTimeout(() => {
      this.timer = null;
      const item = this.queue.shift();
      this.last = Date.now();
      Promise.resolve()
        .then(item.fn)
        .then(item.resolve, item.reject)
        .finally(() => this.pump());
    }, wait);
  }
}

// ---------------------------------------------------------------------------
// Atoll JSON-RPC client (WebSocket, auto-reconnect)
// ---------------------------------------------------------------------------
class AtollClient {
  constructor(url, bundleId) {
    this.url = url;
    this.bundleId = bundleId;
    this.ws = null;
    this.nextId = 0;
    this.pending = new Map();
    this.closed = false;
    this.backoff = 1000;
    this.limiter = new RateLimiter(RPC_INTERVAL_MS);
    this.onNotification = () => {};
  }

  start() {
    this.connect();
  }

  connect() {
    if (this.closed) return;
    const ws = new WebSocket(this.url);
    this.ws = ws;
    log("Atoll: connecting", this.url);

    ws.addEventListener("open", async () => {
      log("Atoll: connected");
      this.backoff = 1000;
      try {
        const v = await this.call("atoll.getVersion", { bundleIdentifier: this.bundleId });
        log("Atoll: version", v?.version);
        const a = await this.call("atoll.requestAuthorization", {
          bundleIdentifier: this.bundleId,
        });
        log("Atoll: authorized =", a?.authorized);
      } catch (e) {
        log("Atoll: handshake failed:", e.message);
      }
    });

    ws.addEventListener("message", (ev) => {
      const raw = typeof ev.data === "string" ? ev.data : "";
      let msg;
      try {
        msg = JSON.parse(raw);
      } catch {
        return;
      }
      if (msg.id && this.pending.has(msg.id)) {
        const { resolve, reject } = this.pending.get(msg.id);
        this.pending.delete(msg.id);
        if (msg.error) reject(new Error(`${msg.error.code}: ${msg.error.message}`));
        else resolve(msg.result);
      } else if (msg.method) {
        this.onNotification(msg.method, msg.params || {});
      }
    });

    const reopen = () => {
      if (this.closed) return;
      this.pending.forEach((p) => p.reject(new Error("connection closed")));
      this.pending.clear();
      if (this.ws === ws) this.ws = null;
      setTimeout(() => this.connect(), this.backoff);
      this.backoff = Math.min(this.backoff * 2, 30000);
    };
    ws.addEventListener("close", reopen);
    ws.addEventListener("error", () => {
      try {
        ws.close();
      } catch {}
    });
  }

  request(method, params) {
    const id = String(++this.nextId);
    const ws = this.ws;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(new Error(`timeout: ${method}`));
      }, 8000);
      this.pending.set(id, {
        resolve: (v) => {
          clearTimeout(timer);
          resolve(v);
        },
        reject: (e) => {
          clearTimeout(timer);
          reject(e);
        },
      });
      try {
        ws.send(JSON.stringify({ jsonrpc: "2.0", id, method, params }));
      } catch (e) {
        clearTimeout(timer);
        this.pending.delete(id);
        reject(e);
      }
    });
  }

  call(method, params) {
    return this.limiter.add(() => this.request(method, params));
  }

  // Live Activities
  async present(descriptor) {
    return this.call("atoll.presentLiveActivity", { descriptor });
  }
  async update(descriptor) {
    return this.call("atoll.updateLiveActivity", { descriptor });
  }
  async dismiss(activityID) {
    return this.call("atoll.dismissLiveActivity", {
      activityID,
      bundleIdentifier: BUNDLE_ID,
    });
  }

  // Notch Experience
  async presentNotch(descriptor) {
    return this.call("atoll.presentNotchExperience", { descriptor });
  }
  async updateNotch(descriptor) {
    return this.call("atoll.updateNotchExperience", { descriptor });
  }
  async dismissNotch(experienceID) {
    return this.call("atoll.dismissNotchExperience", {
      experienceID,
      bundleIdentifier: BUNDLE_ID,
    });
  }

  async shutdown() {
    this.closed = true;
    try {
      this.ws?.close();
    } catch {}
  }
}

// ---------------------------------------------------------------------------
// Session state
// ---------------------------------------------------------------------------
// AtollWidgetContentElement.text requires a font (non-optional in the Swift
// decoder), so every text element carries this descriptor.
const FONT = { size: 13, weight: "medium", design: "default", isMonospacedDigit: false };

const COLORS = {
  blue: { red: 0.2, green: 0.6, blue: 1, alpha: 1 },
  orange: { red: 1, green: 0.6, blue: 0.1, alpha: 1 },
  green: { red: 0.2, green: 0.8, blue: 0.4, alpha: 1 },
  red: { red: 1, green: 0.3, blue: 0.3, alpha: 1 },
  gray: { red: 0.6, green: 0.6, blue: 0.6, alpha: 1 },
};

// OpenCode logo (PNG) as a base64 AtollIconDescriptor.image. Falls back to a
// symbol if the file is missing so the bridge still works.
let logoBase64 = "";
try {
  logoBase64 = readFileSync(LOGO_PATH).toString("base64");
} catch (e) {
  log("WARN: cannot read OpenCode logo:", LOGO_PATH, e.message);
}

function iconImage(size, cornerRadius) {
  if (!logoBase64) return { type: "symbol", name: "terminal", size };
  return {
    type: "image",
    data: logoBase64,
    // Atoll's AtollIconDescriptor.image takes a CGSize, which Codable
    // encodes/decodes as a 2-element array [width, height] — not {width,height}.
    size: [size, size],
    cornerRadius: cornerRadius ?? 0,
  };
}

// Completion Lottie (checkmark draw). Atoll renders trailingContent animations
// with ExtensionLottieView, which forces loopMode = .loop, so the check redraws
// continuously while the completed state is shown. Falls back to a symbol.
let completionBase64 = "";
try {
  completionBase64 = readFileSync(COMPLETION_LOTTIE_PATH).toString("base64");
} catch (e) {
  log("WARN: cannot read completion Lottie:", COMPLETION_LOTTIE_PATH, e.message);
}

function completionTrailing(size) {
  if (!completionBase64) {
    return {
      type: "icon",
      icon: { type: "symbol", name: "checkmark.circle.fill", size },
    };
  }
  return {
    type: "animation",
    data: completionBase64,
    // AtollTrailingContent.animation(data:size:); size is a CGSize -> [w,h].
    size: [size, size],
  };
}

const sessions = new Map();

function ensureSession(id) {
  let s = sessions.get(id);
  if (!s) {
    s = {
      sessionID: id,
      title: "",
      dirName: "",
      agent: "",
      model: "",
      busy: false,
      phase: "idle", // idle | step | thinking | tool | output | compacting
      toolName: "",
      steps: 0,
      tokens: 0,
      cost: 0,
      lastOutcome: null, // succeeded | failed | interrupted
      attention: false,
      attentionKind: "", // permission | form
      attentionText: "",
      createdAt: Date.now(),
      lastEventAt: Date.now(),
      idleSince: Date.now(),
      completedAt: null, // timestamp of the last succeeded turn (completion UI)
      completionPeeked: false, // sneak peek for the current completion already shown
      shownKind: "", // last rendered kind: working | completed | idle
      dirty: true,
    };
    sessions.set(id, s);
  }
  return s;
}

function touch(s) {
  s.lastEventAt = Date.now();
  s.dirty = true;
}

function markBusy(s) {
  s.busy = true;
  s.idleSince = null;
  // A new turn invalidates the previous completion.
  s.completedAt = null;
  s.completionPeeked = false;
  touch(s);
}

function markIdle(s, outcome) {
  s.busy = false;
  s.idleSince = Date.now();
  if (outcome) s.lastOutcome = outcome;
  // One completion per succeeded turn. `session.idle` fires right after
  // `session.execution.succeeded` without an outcome, so only set this when
  // there is no completion yet.
  if (outcome === "succeeded" && s.completedAt == null) {
    s.completedAt = Date.now();
    s.completionPeeked = false;
  }
  touch(s);
}

// True while the session is inside the completion window. Attention outranks
// completion (a permission/form prompt must stay visible).
function isCompleted(s) {
  return (
    !s.attention &&
    s.completedAt != null &&
    s.lastOutcome === "succeeded" &&
    Date.now() - s.completedAt <= COMPLETE_HOLD_MS
  );
}

// The rendered state, used to detect transitions that are not tied to an event
// (the completion window expiring).
function kindOf(s) {
  if (isCompleted(s)) return "completed";
  if (s.busy || s.attention) return "working";
  return "idle";
}

function truncate(str, n) {
  if (!str) return "";
  return str.length > n ? str.slice(0, n - 1) + "…" : str;
}

function phaseText(s) {
  if (s.attention) {
    if (s.attentionKind === "form") {
      return `需要选择：${s.attentionText || "表单"}`;
    }
    return `等待授权：${s.attentionText || "需要批准"}`;
  }
  if (s.busy) {
    switch (s.phase) {
      case "thinking":
        return "思考中";
      case "tool":
        return s.toolName ? `工具：${s.toolName}` : "调用工具";
      case "output":
        return "输出中";
      case "compacting":
        return "压缩上下文";
      case "step":
        return s.steps > 0 ? `第 ${s.steps} 步` : "进行中";
      default:
        return "进行中";
    }
  }
  if (s.lastOutcome === "succeeded") return "空闲 · 上一轮完成";
  if (s.lastOutcome === "failed") return "空闲 · 上一轮失败";
  if (s.lastOutcome === "interrupted") return "空闲 · 已中断";
  return "空闲";
}

function metaFor(s) {
  if (s.attention) {
    return { icon: "exclamationmark.triangle", color: COLORS.orange, priority: "high" };
  }
  if (s.busy) {
    return { icon: "terminal", color: COLORS.blue, priority: "normal" };
  }
  if (s.lastOutcome === "succeeded") {
    return { icon: "checkmark.circle", color: COLORS.green, priority: "low" };
  }
  if (s.lastOutcome === "failed") {
    return { icon: "xmark.octagon", color: COLORS.red, priority: "normal" };
  }
  if (s.lastOutcome === "interrupted") {
    return { icon: "stop.circle", color: COLORS.orange, priority: "normal" };
  }
  return { icon: "moon", color: COLORS.gray, priority: "low" };
}

function rankOf(s) {
  if (s.attention) return 4;
  if (s.busy) return 3;
  if (s.lastOutcome) return 2;
  return 1;
}

function sessionTitle(s) {
  return s.title || s.dirName || "OpenCode";
}

function buildDescriptor(s) {
  if (isCompleted(s)) {
    return {
      id: `opencode-${s.sessionID}`,
      bundleIdentifier: BUNDLE_ID,
      priority: "high",
      title: truncate(sessionTitle(s), 24),
      subtitle: "已完成",
      leadingIcon: iconImage(20, 5),
      // badgeIcon overlays the leading logo with a small checkmark.
      badgeIcon: { type: "symbol", name: "checkmark.circle.fill", size: 12 },
      // trailingContent takes precedence over progressIndicator, so the check
      // animation replaces the ring. Atoll loops it while the state is shown.
      // Note: progressIndicator + non-none trailingContent is rejected by
      // AtollLiveActivityDescriptor.isValid, so it is omitted here.
      trailingContent: completionTrailing(24),
      progress: 1,
      accentColor: COLORS.green,
      allowsMusicCoexistence: true,
      metadata: {
        sessionID: s.sessionID,
        busy: "false",
        attention: "false",
        completed: "true",
      },
      centerTextStyle: "inheritUser",
      sneakPeekConfig: {
        enabled: true,
        duration: 3,
        style: "standard",
        // present() triggers sneak peek only when showOnUpdate is true.
        showOnUpdate: true,
      },
    };
  }
  const meta = metaFor(s);
  const progress = s.busy ? Math.min(0.9, s.steps * 0.12) : 0;
  const prefix = s.dirName && s.dirName !== s.title ? `${s.dirName} · ` : "";
  return {
    id: `opencode-${s.sessionID}`,
    bundleIdentifier: BUNDLE_ID,
    priority: meta.priority,
    title: truncate(sessionTitle(s), 24),
    subtitle: truncate(`${prefix}${phaseText(s)}`, 32),
    leadingIcon: iconImage(20, 5),
    trailingContent: { type: "none" },
    progressIndicator: { type: "ring", diameter: 24, strokeWidth: 3 },
    progress,
    accentColor: meta.color,
    allowsMusicCoexistence: true,
    metadata: {
      sessionID: s.sessionID,
      busy: String(s.busy),
      attention: String(s.attention),
    },
    centerTextStyle: "inheritUser",
    sneakPeekConfig: {
      enabled: true,
      duration: 2.5,
      style: "standard",
      showOnUpdate: true,
    },
  };
}

// ---------------------------------------------------------------------------
// Notch Experience descriptor (minimal framework)
// ---------------------------------------------------------------------------
function buildNotchDescriptor(desired) {
  const sections = [];
  if (desired.length === 0) {
    sections.push({
      id: "empty",
      layout: "stack",
      elements: [{ type: "text", text: "当前无进行中的会话", font: FONT }],
    });
  } else {
    for (const s of desired) {
      const prefix =
        s.dirName && s.dirName !== s.title ? `${s.dirName} · ` : "";
      const label = truncate(
        `${sessionTitle(s)} · ${prefix}${phaseText(s)}`,
        44
      );
      sections.push({
        id: s.sessionID,
        layout: "columns",
        elements: [
          { type: "text", text: label, font: FONT },
          {
            type: "progress",
            indicator: { type: "ring", diameter: 20, strokeWidth: 2 },
            value: s.busy ? Math.min(0.9, s.steps * 0.12) : 0,
          },
        ],
      });
    }
  }

  return {
    id: "opencode-notch",
    bundleIdentifier: BUNDLE_ID,
    priority: "normal",
    accentColor: COLORS.blue,
    metadata: { app: "opencode", sessions: String(desired.length) },
    tab: {
      title: "OpenCode",
      iconSymbolName: "terminal",
      badgeIcon: iconImage(32, 8),
      allowWebInteraction: false,
      sections,
    },
  };
}

// ---------------------------------------------------------------------------
// OpenCode event ingestion
// ---------------------------------------------------------------------------
function handleEvent(type, data) {
  // form.created carries the payload under data.form
  if (type === "form.created" && data?.sessionID == null && data?.form?.sessionID) {
    data = { ...data, sessionID: data.form.sessionID };
  }
  const id = data?.sessionID;
  if (!id) return;
  const s = ensureSession(id);

  switch (type) {
    case "session.created":
      if (data.title) s.title = data.title;
      s.busy = false;
      s.phase = "idle";
      touch(s);
      break;
    case "session.renamed":
      if (data.title) s.title = data.title;
      touch(s);
      break;

    case "session.execution.started":
      s.steps = 0;
      s.toolName = "";
      s.phase = "step";
      markBusy(s);
      break;
    case "session.step.started":
      s.steps += 1;
      s.toolName = "";
      s.phase = "step";
      if (data.agent) s.agent = data.agent;
      if (data.model?.id) s.model = data.model.id;
      markBusy(s);
      break;
    case "session.step.first-token":
    case "session.step.streamed":
      markBusy(s);
      break;
    case "session.reasoning.started":
      s.phase = "thinking";
      markBusy(s);
      break;
    case "session.text.started":
      s.phase = "output";
      markBusy(s);
      break;
    case "session.compaction.started":
      s.phase = "compacting";
      markBusy(s);
      break;
    case "session.tool.input.started":
    case "session.tool.called":
      s.phase = "tool";
      if (data.name) s.toolName = data.name;
      markBusy(s);
      break;
    case "session.tool.progress":
      markBusy(s);
      break;
    case "session.tool.success":
    case "session.tool.failed":
      s.toolName = "";
      s.phase = "step";
      markBusy(s);
      break;

    case "permission.asked":
      s.attention = true;
      s.attentionKind = "permission";
      s.attentionText = data.action || data.message || "";
      markBusy(s); // keep it visible even though the agent is blocked
      break;
    case "permission.replied":
      s.attention = false;
      s.attentionText = "";
      break;
    case "form.created":
      s.attention = true;
      s.attentionKind = "form";
      s.attentionText = data?.form?.title || "";
      markBusy(s);
      break;
    case "form.replied":
    case "form.cancelled":
      s.attention = false;
      s.attentionText = "";
      break;

    case "session.execution.succeeded":
      markIdle(s, "succeeded");
      break;
    case "session.execution.failed":
      markIdle(s, "failed");
      break;
    case "session.execution.interrupted":
      markIdle(s, "interrupted");
      break;
    case "session.idle":
      markIdle(s);
      break;

    case "session.usage.updated":
      if (typeof data.cost === "number") s.cost = data.cost;
      if (data.tokens) {
        s.tokens =
          (data.tokens.input || 0) +
          (data.tokens.output || 0) +
          (data.tokens.reasoning || 0);
      }
      touch(s);
      break;
    case "session.deleted":
      sessions.delete(id);
      break;
    default:
      break;
  }
}

async function streamEvents(onEvent) {
  let backoff = 1000;
  for (;;) {
    try {
      const res = await fetch(OPENCODE_API + "/api/event", {
        headers: { Authorization: AUTH },
      });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      backoff = 1000;
      log("OpenCode: event stream connected");
      const reader = res.body.getReader();
      const dec = new TextDecoder();
      let buf = "";
      for (;;) {
        const { value, done } = await reader.read();
        if (done) break;
        buf += dec.decode(value, { stream: true });
        let idx;
        while ((idx = buf.indexOf("\n")) >= 0) {
          const line = buf.slice(0, idx).trim();
          buf = buf.slice(idx + 1);
          if (!line || line.startsWith(":")) continue;
          if (!line.startsWith("data:")) continue;
          const payload = line.slice(5).trim();
          try {
            const j = JSON.parse(payload);
            onEvent(j.type, j.data);
          } catch {}
        }
      }
    } catch (e) {
      if (stopping) return;
      refreshOpenCodeApi();
      log("OpenCode: event stream error:", e.message, `— retry in ${backoff}ms`);
      await sleep(backoff);
      backoff = Math.min(backoff * 2, 30000);
    }
  }
}

async function pollSessions() {
  let backoff = POLL_MS;
  for (;;) {
    try {
      const res = await fetch(OPENCODE_API + "/api/session", {
        headers: { Authorization: AUTH },
      });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      backoff = POLL_MS;
      const j = await res.json();
      const list = Array.isArray(j?.data) ? j.data : [];
      const seen = new Set();
      for (const item of list) {
        if (!item?.id) continue;
        seen.add(item.id);
        // Only track sessions we already know about (seen via an event).
        const s = sessions.get(item.id);
        if (!s) continue;
        if (item.title) s.title = item.title;
        if (item.agent) s.agent = item.agent;
        if (item.model?.id) s.model = item.model.id;
        const dir = item.location?.directory;
        if (dir) s.dirName = basename(dir);
        if (item.tokens) {
          s.tokens =
            (item.tokens.input || 0) +
            (item.tokens.output || 0) +
            (item.tokens.reasoning || 0);
        }
        if (item.cost != null) s.cost = item.cost;
        // `outcome` is the result of the last turn, NOT a terminal session
        // state — record it for colour only. Busy comes from the timestamps.
        if (item.outcome) s.lastOutcome = item.outcome;

        const t = item.time || {};
        if (typeof t.busy === "number" && typeof t.idle === "number") {
          const busy = t.busy > t.idle;
          if (busy !== s.busy) {
            s.busy = busy;
            s.idleSince = busy ? null : Date.now();
            if (busy) {
              // A new turn started: drop the previous completion.
              s.completedAt = null;
              s.completionPeeked = false;
            }
            s.dirty = true;
          }
        }
      }
      // Drop sessions we know that vanished from the list.
      for (const id of [...sessions.keys()]) {
        if (!seen.has(id) && Date.now() - sessions.get(id).lastEventAt > 5000) {
          sessions.delete(id);
        }
      }
    } catch (e) {
      if (stopping) return;
      log("OpenCode: session poll error:", e.message, `— retry in ${backoff}ms`);
      await sleep(backoff);
      backoff = Math.min(backoff * 2, 30000);
    }
    await sleep(POLL_MS);
  }
}

// ---------------------------------------------------------------------------
// Reconciliation
// ---------------------------------------------------------------------------
const displayed = new Map(); // sessionID -> { activityID }
let notchPresented = false;
let notchSignature = "";

function desiredSessions() {
  const now = Date.now();
  const list = [...sessions.values()].filter((s) => {
    if (now - s.lastEventAt > SESSION_TTL_MS) return false;
    if (s.attention || s.busy) return true;
    if (s.idleSince && now - s.idleSince <= IDLE_HOLD_MS) return true;
    return false;
  });
  list.sort((a, b) => {
    const ra = rankOf(a);
    const rb = rankOf(b);
    if (ra !== rb) return rb - ra;
    return b.lastEventAt - a.lastEventAt;
  });
  return list.slice(0, CAPACITY);
}

// The notch tab is persistent and only shows sessions that are actively
// working (busy or waiting on a permission/form) — no idle hold.
function notchSessions() {
  const now = Date.now();
  const list = [...sessions.values()].filter((s) => {
    if (now - s.lastEventAt > SESSION_TTL_MS) return false;
    return s.busy || s.attention;
  });
  list.sort((a, b) => {
    const ra = rankOf(a);
    const rb = rankOf(b);
    if (ra !== rb) return rb - ra;
    return b.lastEventAt - a.lastEventAt;
  });
  return list.slice(0, CAPACITY);
}

async function reconcile() {
  const desired = desiredSessions();
  const desiredIds = new Set(desired.map((s) => s.sessionID));

  // Dismiss activities that are no longer desired.
  for (const [id, info] of [...displayed.entries()]) {
    if (!desiredIds.has(id)) {
      displayed.delete(id);
      try {
        await atoll.dismiss(info.activityID);
        log("Atoll: dismissed", id);
      } catch (e) {
        log("Atoll: dismiss failed", id, e.message);
      }
    }
  }

  // Present new ones.
  for (const s of desired) {
    if (!displayed.has(s.sessionID)) {
      const kind = kindOf(s);
      const descriptor = buildDescriptor(s);
      try {
        await atoll.present(descriptor);
        displayed.set(s.sessionID, { activityID: descriptor.id });
        s.shownKind = kind;
        if (kind === "completed") {
          s.completionPeeked = true;
          log("Atoll: presented completion", s.sessionID, `(${sessionTitle(s)})`);
        } else {
          log("Atoll: presented", s.sessionID, `(${phaseText(s)})`);
        }
        s.dirty = false;
      } catch (e) {
        log("Atoll: present failed", s.sessionID, e.message);
      }
    }
  }

  // Update dirty ones, plus any whose rendered kind changed. The kind change
  // matters because the completion window expires on a timer, not an event.
  for (const s of desired) {
    if (!displayed.has(s.sessionID)) continue;
    const kind = kindOf(s);
    const kindChanged = kind !== s.shownKind;
    if (!s.dirty && !kindChanged) continue;
    const descriptor = buildDescriptor(s);
    try {
      if (kind === "completed") {
        // present() is the only call that triggers sneak peek. Fire once per
        // completion; otherwise fall back to a plain update.
        if (!s.completionPeeked) {
          await atoll.present(descriptor);
          s.completionPeeked = true;
          log("Atoll: completion peek", s.sessionID, `(${sessionTitle(s)})`);
        } else if (s.dirty) {
          await atoll.update(descriptor);
        }
      } else {
        await atoll.update(descriptor);
      }
      s.shownKind = kind;
      s.dirty = false;
    } catch (e) {
      log("Atoll: update failed", s.sessionID, e.message);
    }
  }

  // Notch Experience tab — persistent, decoupled from Live Activity's
  // idle-hold lifecycle. Shows only actively-working sessions.
  if (NOTCH_ENABLED) {
    const notchDesired = notchSessions();
    const descriptor = buildNotchDescriptor(notchDesired);
    const sig = JSON.stringify(descriptor);
    if (!notchPresented) {
      try {
        await atoll.presentNotch(descriptor);
        notchPresented = true;
        notchSignature = sig;
        log("Atoll: presented notch tab");
      } catch (e) {
        log("Atoll: notch present failed:", e.message);
      }
    } else if (sig !== notchSignature) {
      try {
        await atoll.updateNotch(descriptor);
        notchSignature = sig;
        log("Atoll: updated notch tab");
      } catch (e) {
        log("Atoll: notch update failed:", e.message);
      }
    }
  }
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------
let stopping = false;
const atoll = new AtollClient(ATOLL_WS, BUNDLE_ID);

atoll.onNotification = (method, params) => {
  if (method === "atoll.activityDidDismiss") {
    const id = params?.activityID;
    for (const [sid, info] of displayed.entries()) {
      if (info.activityID === id) displayed.delete(sid);
    }
    log("Atoll: server dismissed", id);
  } else if (method === "atoll.notchExperienceDidDismiss") {
    notchPresented = false;
    notchSignature = "";
    log("Atoll: server dismissed notch tab", params?.experienceID);
  }
};

async function main() {
  if (!acquireLock()) {
    log("another bridge instance is already running — exiting");
    process.exit(0);
  }
  log(
    `bridge starting (capacity=${CAPACITY}, rpc=${RPC_INTERVAL_MS}ms, notch=${NOTCH_ENABLED})`
  );
  atoll.start();
  streamEvents(handleEvent);
  pollSessions();

  let reconcileRunning = false;
  const timer = setInterval(() => {
    if (reconcileRunning) return; // a previous pass is still awaiting the rate limiter
    reconcileRunning = true;
    reconcile()
      .catch((e) => log("reconcile error:", e.message))
      .finally(() => {
        reconcileRunning = false;
      });
  }, TICK_MS);

  const stop = async () => {
    if (stopping) return;
    stopping = true;
    clearInterval(timer);
    log("shutting down — dismissing activities");
    for (const [sid, info] of [...displayed.entries()]) {
      try {
        await atoll.dismiss(info.activityID);
      } catch {}
      displayed.delete(sid);
    }
    if (notchPresented) {
      try {
        await atoll.dismissNotch("opencode-notch");
      } catch {}
      notchPresented = false;
    }
    await atoll.shutdown();
    releaseLock();
    process.exit(0);
  };
  process.on("SIGINT", stop);
  process.on("SIGTERM", stop);
}

main();
