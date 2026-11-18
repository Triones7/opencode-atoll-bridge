#!/usr/bin/env node
// Minimal PoC: connect to Atoll's extension RPC (WebSocket JSON-RPC 2.0 on
// ws://127.0.0.1:9020) and drive one Live Activity.
//
//   node poc.mjs
//
// Env overrides: ATOLL_RPC_URL, ATOLL_BUNDLE_ID.

const URL = process.env.ATOLL_RPC_URL || "ws://127.0.0.1:9020";
const BUNDLE_ID = process.env.ATOLL_BUNDLE_ID || "com.example.opencode-atoll";

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const log = (...a) => console.log(new Date().toISOString(), ...a);

const ws = new WebSocket(URL);
let nextId = 0;
const pending = new Map();

function send(method, params = {}) {
  const id = String(++nextId);
  const req = { jsonrpc: "2.0", id, method, params };
  return new Promise((resolve, reject) => {
    pending.set(id, { resolve, reject });
    ws.send(JSON.stringify(req));
    setTimeout(() => {
      if (pending.has(id)) {
        pending.delete(id);
        reject(new Error(`timeout waiting for ${method}`));
      }
    }, 5000);
  });
}

ws.addEventListener("open", async () => {
  log("connected:", URL);
  try {
    log("getVersion ->", await send("atoll.getVersion", { bundleIdentifier: BUNDLE_ID }));
    log("requestAuthorization ->", await send("atoll.requestAuthorization", { bundleIdentifier: BUNDLE_ID }));

    // Client wire format: enums use { "type": <case>, ...params }; Atoll's
    // transformClientJSON converts them to Swift's Codable representation.
    const base = {
      id: "opencode-poc",
      bundleIdentifier: BUNDLE_ID,
      priority: "normal",
      title: "OpenCode",
      subtitle: "PoC 连接成功",
      leadingIcon: { type: "symbol", name: "terminal", size: 16 },
      trailingContent: { type: "none" },
      progressIndicator: { type: "ring", diameter: 24, strokeWidth: 3 },
      progress: 0.4,
      accentColor: { red: 0.2, green: 0.6, blue: 1, alpha: 1 },
      allowsMusicCoexistence: true,
      metadata: {},
    };

    log("presentLiveActivity ->", await send("atoll.presentLiveActivity", { descriptor: base }));

    await sleep(3000);
    log(
      "updateLiveActivity ->",
      await send("atoll.updateLiveActivity", {
        descriptor: { ...base, progress: 1, subtitle: "完成" },
      })
    );

    await sleep(3000);
    log(
      "dismissLiveActivity ->",
      await send("atoll.dismissLiveActivity", {
        activityID: "opencode-poc",
        bundleIdentifier: BUNDLE_ID,
      })
    );
  } catch (e) {
    log("ERROR:", e.message);
  } finally {
    setTimeout(() => {
      try {
        ws.close();
      } catch {}
      process.exit(0);
    }, 500);
  }
});

ws.addEventListener("message", (ev) => {
  const raw = typeof ev.data === "string" ? ev.data : ev.data?.toString?.() ?? "";
  let msg;
  try {
    msg = JSON.parse(raw);
  } catch {
    log("non-JSON message:", raw);
    return;
  }
  if (msg.id && pending.has(msg.id)) {
    const { resolve, reject } = pending.get(msg.id);
    pending.delete(msg.id);
    if (msg.error) reject(new Error(`${msg.error.code}: ${msg.error.message}`));
    else resolve(msg.result);
  } else {
    log("notification:", msg.method, msg.params);
  }
});

ws.addEventListener("error", (e) => log("ws error:", e?.message || e));
ws.addEventListener("close", (e) => log("ws close:", e.code, e.reason));
