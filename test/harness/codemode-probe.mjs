// Code-mode probe: enumerates the real tools/list surface of every live MCP
// server named in probe-config.json, then computes the client-facing MCP schema
// tax of three arms:
//
//   naive    — every upstream tool exposed as its own schema (no broker)
//   current  — what opencode sends today: one entry per upstream tool. This is
//              the residual dock exists to remove.
//   codemode — what opencode sends with experimentalCodeMode on. Read out of the
//              shipped binary (ToolRegistry.state / SessionTools.resolve, 1.18.34):
//              the per-tool loop is guarded by `if(u.experimentalCodeMode)return o;`
//              so every MCP tool schema is dropped, and what remains is three MCP
//              *resource* meta-tools plus one `execute` tool.
//
// Only the MCP part is counted. opencode's builtin tools are byte-identical in
// all three arms, so they cancel in the comparison; probe-config.json carries
// their measured cost as an additive constant for the absolute totals.
//
// Code mode is the control experiment for dock: it claims the same
// constant-cost property by a different mechanism. If it alone collapses the
// residual, dock's selection layer is largely redundant.
//
// Run from the dock/ root:  node test/harness/codemode-probe.mjs [outfile.json]
// Config is its own file: probe-config.json belongs to the stdio probe and its
// shape (fixture upstreams) is not this probe's.
import { readFileSync, writeFileSync } from "node:fs";
import { spawn } from "node:child_process";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const cfg = JSON.parse(readFileSync(join(here, "codemode-config.json"), "utf8"));

// --- MCP stdio client: initialize, initialized, tools/list, resources/list -----
function talk(command, methods) {
  return new Promise((resolve, reject) => {
    const [cmd, ...args] = command;
    const child = spawn(cmd, args, { stdio: ["pipe", "pipe", "ignore"] });
    let buf = "";
    const pending = [];
    child.on("error", reject);
    child.stdout.on("data", (d) => {
      buf += d.toString();
      let i;
      while ((i = buf.indexOf("\n")) >= 0) {
        const line = buf.slice(0, i).trim();
        buf = buf.slice(i + 1);
        if (!line) continue;
        let msg;
        try {
          msg = JSON.parse(line);
        } catch {
          continue; // a server logging to stdout corrupts the frame stream; skip it
        }
        if (msg.id != null) {
          const want = pending.find((p) => p.id === msg.id);
          if (want) want.resolve(msg);
        }
      }
    });
    let id = 0;
    const send = (method, params) =>
      new Promise((res, rej) => {
        const myId = ++id;
        const timer = setTimeout(() => rej(new Error(`${method} timed out`)), 20000);
        pending.push({
          id: myId,
          resolve: (m) => {
            clearTimeout(timer);
            res(m);
          },
        });
        child.stdin.write(JSON.stringify({ jsonrpc: "2.0", id: myId, method, params }) + "\n");
      });
    (async () => {
      const init = await send("initialize", {
        protocolVersion: cfg.protocolVersion,
        capabilities: {},
        clientInfo: { name: "dock-codemode-probe", version: "1" },
      });
      child.stdin.write(JSON.stringify({ jsonrpc: "2.0", method: "notifications/initialized" }) + "\n");
      const out = { params: init.result?.params ?? {}, results: {}, errors: {} };
      for (const m of methods) {
        try {
          const r = await send(m);
          out.results[m] = r.result ?? null;
        } catch (e) {
          out.errors[m] = String(e.message ?? e); // not every server implements every list
        }
      }
      child.kill();
      resolve(out);
    })().catch((e) => {
      child.kill();
      reject(e);
    });
  });
}

// --- what opencode puts on the wire for one tool entry -----------------------
// schema is derived from the upstream inputSchema; description passes through.
function toolEntry(name, description, schema) {
  return { name, description, input_schema: schema ?? { type: "object", properties: {} } };
}

// opencode namespaces an MCP tool under its client with an underscore. The exact
// spelling is presentation with no token cost; the probe fixes it and states it.
const mcpName = (server, tool) => `${server}_${tool}`;

const servers = [];
for (const [name, command] of Object.entries(cfg.mcpServers)) {
  const r = await talk(command, ["tools/list", "resources/list"]);
  const tools = r.results["tools/list"]?.tools ?? [];
  const resources = r.results["resources/list"]?.resources ?? [];
  const templates = r.results["resources/templates/list"]?.resourceTemplates ?? [];
  servers.push({
    name,
    tools,
    resources,
    templates,
    capabilities: Object.keys(r.params.capabilities ?? {}),
    errors: r.errors,
  });
  process.stderr.write(
    `# ${name}: ${tools.length} tools, ${resources.length} resources, ` +
      `${templates.length} templates, capabilities=[${servers.at(-1).capabilities.join(",")}]\n`
  );
}

const allUpstream = servers.flatMap((s) => s.tools);
// Code mode's three meta-tools are gated on getServerCapabilities().resources,
// so an arm is only reachable for servers that actually publish resources.
const resourceServers = servers.filter((s) => s.capabilities.includes("resources"));

const naive = allUpstream.map((t) => toolEntry(mcpName("server", t.name), t.description, t.inputSchema));
const current = servers.flatMap((s) =>
  s.tools.map((t) => toolEntry(mcpName(s.name, t.name), t.description, t.inputSchema))
);
// Under experimentalCodeMode opencode returns before the per-tool loop, so the
// MCP arm is exactly these three — regardless of how many servers are docked.
const codemode = cfg.codeModeResourceTools.map((id) => toolEntry(id, id, cfg.resourceMetaSchema));

const out = {
  probe: "codemode",
  protocolVersion: cfg.protocolVersion,
  servers: servers.map((s) => ({
    name: s.name,
    toolCount: s.tools.length,
    toolNames: s.tools.map((t) => t.name),
    resourceCount: s.resources.length,
    templateCount: s.templates.length,
    capabilities: s.capabilities,
    errors: s.errors,
  })),
  resourceServers: resourceServers.map((s) => s.name),
  builtinTokenCost: cfg.builtinTokenCost,
  mcpCounts: { naive: naive.length, current: current.length, codemode: codemode.length },
  payloads: { naive, current, codemode },
};

const target = process.argv[2];
if (target) {
  writeFileSync(target, JSON.stringify(out, null, 2));
  process.stderr.write(`# wrote ${target}\n`);
} else {
  process.stdout.write(JSON.stringify(out, null, 2) + "\n");
}