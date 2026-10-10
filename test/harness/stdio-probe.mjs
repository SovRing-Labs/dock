// End-to-end stdio probe: drives dockd exactly as a harness would.
import { spawn } from "node:child_process";

// Usage: node test/harness/stdio-probe.mjs [dockd.js] [config.json]
// Defaults assume you are running from the dock/ root.
const dockd = process.argv[2] ?? "src/dockd.js";
const config = process.argv[3] ?? "test/harness/probe-config.json";

const child = spawn(process.execPath, [dockd, "--config", config], {
  stdio: ["pipe", "pipe", "pipe"],
});
let buf = "", stderr = "";
child.stderr.on("data", (d) => (stderr += d));
child.stdout.setEncoding("utf8");
const pending = new Map();
let id = 1;
child.stdout.on("data", (c) => {
  buf += c;
  let nl;
  while ((nl = buf.indexOf("\n")) >= 0) {
    const line = buf.slice(0, nl).trim();
    buf = buf.slice(nl + 1);
    if (!line) continue;
    const m = JSON.parse(line);
    const p = pending.get(m.id);
    if (p) { pending.delete(m.id); p(m); }
  }
});
const req = (method, params) =>
  new Promise((r) => { const i = id++; pending.set(i, r);
    child.stdin.write(JSON.stringify({ jsonrpc: "2.0", id: i, method, params }) + "\n"); });

await new Promise((r) => setTimeout(r, 1500));
const init = await req("initialize", { protocolVersion: "2025-06-18", capabilities: {}, clientInfo: { name: "probe", version: "1" } });
console.log("initialize  ->", JSON.stringify(init.result.serverInfo));
const list = await req("tools/list", {});
console.log("tools/list  ->", list.result.tools.map((t) => t.name).join(", "));
console.log("client tax  ->", Math.round(Buffer.byteLength(JSON.stringify(list.result.tools)) / 4), "tok");
const sr = await req("tools/call", { name: "search_tools", arguments: { query: "fetching" } });
console.log("search      ->", sr.result.content[0].text.replace(/\s+/g, " ").slice(0, 130));
const ab = await req("tools/call", { name: "search_tools", arguments: { query: "qqqq zzzz wubble" } });
console.log("abstain     ->", ab.result.content[0].text.replace(/\s+/g, " ").slice(0, 110));
console.log("dock stderr ->", stderr.trim());
child.kill();
process.exit(0);
