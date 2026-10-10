#!/usr/bin/env node
// dockd — dock daemon. An MCP server that fronts N MCP servers behind two
// meta-tools, so a client pays a CONSTANT context cost no matter how many
// upstreams are docked.
//
// Exposed surface is exactly two tools: search_tools, call_tool.
// That surface size is the product claim — it is what the GATE test asserts.
//
// Transports: stdio (default, for a single local client) and --http (for shared
// use by several harnesses / a fleet).
//
// Zero runtime dependencies. See README "Why no dependencies".

import { createServer } from "node:http";
import { readFileSync } from "node:fs";
import { ServerPeer, PROTOCOL_VERSION } from "./rpc.js";
import { Registry, Upstream } from "./upstream.js";
import { buildIndex, search } from "./select.js";

const VERSION = "0.1.0";

/* ── the client-facing tools ──────────────────────────────────────────────
 * Descriptions are intentionally terse: these ship to every turn of every
 * conversation, so their own cost is the budget we are trying to protect. */

const SEARCH_TOOL = {
  name: "search_tools",
  description:
    "Find docked MCP tools by intent. Returns matches with a confidence score, " +
    "or abstains (empty results, abstained=true) when nothing matches well.",
  inputSchema: {
    type: "object",
    properties: {
      query: { type: "string", description: "What you want to do, in plain language." },
      k: { type: "integer", description: "Max results (default 8).", minimum: 1, maximum: 50 },
    },
    required: ["query"],
    additionalProperties: false,
  },
};

const CALL_TOOL = {
  name: "call_tool",
  description: "Invoke a docked MCP tool by its qualified 'server__tool' name.",
  inputSchema: {
    type: "object",
    properties: {
      tool: { type: "string", description: "Qualified name from search_tools, e.g. 'fs__read'." },
      arguments: { type: "object", description: "Arguments for the upstream tool." },
    },
    required: ["tool"],
    additionalProperties: false,
  },
};

/* ── core ──────────────────────────────────────────────────────────────── */

export class Dock {
  constructor({ minEvidence = 0.2, minConf = 0.75 } = {}) {
    this.registry = new Registry();
    this.index = buildIndex([]);
    this.minEvidence = minEvidence;
    this.minConf = minConf;
    this.calls = 0;
  }

  async addUpstream(name, spec) {
    const up = this.registry.add(new Upstream(name, spec));
    await up.connect();
    this.reindex();
    return up;
  }

  reindex() {
    this.index = buildIndex(this.registry.catalog());
  }

  get exposedTools() {
    return [SEARCH_TOOL, CALL_TOOL];
  }

  /** Freshness check + reindex, so a server that adds tools mid-session is seen. */
  async refresh() {
    for (const up of this.registry.list()) {
      if (!up.alive) continue;
      try {
        await up.refresh();
      } catch (err) {
        up.lastError = String(err.message ?? err);
      }
    }
    this.reindex();
    return this.registry.catalog().length;
  }

  async handle(method, params) {
    switch (method) {
      case "initialize":
        return {
          protocolVersion: PROTOCOL_VERSION,
          capabilities: { tools: { listChanged: false } },
          serverInfo: { name: "dock", version: VERSION },
        };

      case "notifications/initialized":
      case "notifications/cancelled":
        return {};

      case "ping":
        return {};

      case "tools/list":
        return { tools: this.exposedTools };

      case "tools/call": {
        const name = params?.name;
        if (name === "search_tools") return this.doSearch(params?.arguments ?? {});
        if (name === "call_tool") return this.doCall(params?.arguments ?? {});
        // Per MCP, an unknown tool name is a tool-level error RESULT, not a
        // protocol-level error: the model should see it and retry, not have the
        // whole conversation fail at the transport.
        return {
          content: [
            {
              type: "text",
              text:
                `dock exposes only search_tools and call_tool, not '${name}'. ` +
                `Call search_tools to discover what is docked.`,
            },
          ],
          isError: true,
        };
      }

      default:
        throw Object.assign(new Error(`method not found: ${method}`), { code: -32601 });
    }
  }

  doSearch(args) {
    const query = String(args?.query ?? "");
    if (!query.trim()) {
      return {
        content: [{ type: "text", text: "search_tools requires a non-empty query." }],
        isError: true,
      };
    }
    const out = search(this.index, query, {
      k: args?.k ?? 8,
      minEvidence: this.minEvidence,
      minConf: this.minConf,
    });
    return {
      content: [{ type: "text", text: JSON.stringify(out, null, 2) }],
      isError: false,
      // Machine-readable on the envelope too, so a client can branch without
      // parsing our prose.
      _meta: { confidence: out.confidence, abstained: out.abstained, count: out.results.length },
    };
  }

  async doCall(args) {
    const qname = String(args?.tool ?? "");
    if (!qname) {
      return { content: [{ type: "text", text: "call_tool requires 'tool'." }], isError: true };
    }
    let target;
    try {
      target = this.registry.resolve(qname);
    } catch (err) {
      return { content: [{ type: "text", text: String(err.message) }], isError: true };
    }
    this.calls++;
    try {
      const res = await target.upstream.call(target.toolName, args?.arguments ?? {});
      const text = (res?.content ?? [])
        .map((c) => (typeof c?.text === "string" ? c.text : JSON.stringify(c)))
        .join("\n");
      return {
        content: [{ type: "text", text: text || "(empty result)" }],
        isError: Boolean(res?.isError),
        _meta: { server: target.upstream.name, tool: target.toolName, dockCall: this.calls },
      };
    } catch (err) {
      return {
        content: [{ type: "text", text: `upstream '${target.upstream.name}' failed: ${err.message}` }],
        isError: true,
      };
    }
  }
}

/* ── wiring ────────────────────────────────────────────────────────────── */

/** Load upstreams from a JSON config: { upstreams: [{name, command, args, env}] }. */
export function loadConfig(path) {
  const raw = JSON.parse(readFileSync(path, "utf8"));
  return raw.upstreams ?? [];
}

export function parseArgs(argv) {
  const out = { http: null, config: null };
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === "--http") out.http = Number(argv[++i] ?? 8000);
    else if (argv[i] === "--config") out.config = argv[++i];
  }
  return out;
}

export async function main(argv, { dock = new Dock() } = {}) {
  const { http, config } = parseArgs(argv);

  if (config) {
    for (const spec of loadConfig(config)) {
      const { name, ...rest } = spec;
      await dock.addUpstream(name, rest);
    }
  }

  const total = dock.registry.catalog().length;
  const tools = dock.exposedTools.length;
  // The whole claim in one stderr line: N upstream tools are reachable
  // through a fixed 2-tool surface.
  process.stderr.write(
    `dock ${VERSION}: ${dock.registry.list().length} upstream(s), ${total} tool(s) reachable, ${tools} exposed\n`
  );

  if (http) {
    // Minimal streamable-HTTP framing: one JSON-RPC request per POST.
    const server = createServer((req, res) => {
      if (req.method !== "POST") {
        res.writeHead(405).end();
        return;
      }
      let body = "";
      req.on("data", (d) => (body += d));
      req.on("end", async () => {
        try {
          const msg = JSON.parse(body);
          const result = await dock.handle(msg.method, msg.params ?? {});
          res.writeHead(200, { "content-type": "application/json" });
          res.end(JSON.stringify({ jsonrpc: "2.0", id: msg.id, result }));
        } catch (err) {
          res.writeHead(200, { "content-type": "application/json" });
          res.end(
            JSON.stringify({
              jsonrpc: "2.0",
              id: null,
              error: { code: err.code ?? -32603, message: String(err.message ?? err) },
            })
          );
        }
      });
    });
    await new Promise((resolve) => server.listen(http, resolve));
    process.stderr.write(`dock listening on http://127.0.0.1:${http}\n`);
    return { dock, server };
  }

  const peer = new ServerPeer();
  peer.setRequestHandler((method, params) => dock.handle(method, params));
  return { dock, peer };
}

// Only run when executed directly, so tests can import without hijacking stdio.
if (import.meta.url === `file://${process.argv[1]}`) {
  main(process.argv.slice(2))
    .then(() => {
      // Say so on stderr: in stdio mode stdout is the protocol channel, so a
      // silent process is indistinguishable from a hung one.
      if (!parseArgs(process.argv.slice(2)).http) {
        process.stderr.write("dockd: ready on stdio\n");
      }
    })
    .catch((err) => {
      process.stderr.write(`dockd: ${err.stack ?? err}\n`);
      process.exit(1);
    });
}
