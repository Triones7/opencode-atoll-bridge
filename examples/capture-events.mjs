// Capture OpenCode SSE events for N seconds and print them.
//   node capture-events.mjs [seconds]
const seconds = Number(process.argv[2] || 20);
const base = process.env.OPENCODE_API || "http://127.0.0.1:49374";
const password = JSON.parse(
  (await import("node:fs")).readFileSync(
    (await import("node:os")).homedir() + "/.config/opencode/service.json",
    "utf8"
  )
).password;
const auth = "Basic " + Buffer.from("opencode:" + password).toString("base64");

const res = await fetch(base + "/api/event", { headers: { Authorization: auth } });
if (!res.ok) {
  console.error("HTTP", res.status, await res.text());
  process.exit(1);
}
console.log("connected, capturing", seconds, "s");
const reader = res.body.getReader();
const dec = new TextDecoder();
let buf = "";
const timer = setTimeout(() => process.exit(0), seconds * 1000);
try {
  while (true) {
    const { value, done } = await reader.read();
    if (done) break;
    buf += dec.decode(value, { stream: true });
    let idx;
    while ((idx = buf.indexOf("\n")) >= 0) {
      const line = buf.slice(0, idx).trim();
      buf = buf.slice(idx + 1);
      if (!line || line.startsWith(":")) continue;
      if (line.startsWith("data:")) {
        const payload = line.slice(5).trim();
        try {
          const j = JSON.parse(payload);
          console.log(j.type, JSON.stringify(j.data));
        } catch {
          console.log("raw:", payload);
        }
      }
    }
  }
} finally {
  clearTimeout(timer);
}
