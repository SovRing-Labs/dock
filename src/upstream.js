// dock/upstream.js — the N-in side: manage upstream MCP servers, keep a
// namespaced catalog of their tools.
//
// The catalog is the thing that must not grow into the client's context. It
// lives here, in dock's memory, and the client only ever sees two meta-tools.
//
// Naming: every tool is addressed "server__tool" (double underscore) because MCP
// permits single underscores in tool names, so "__" cannot collide with a
// server name or a tool name in a way that is ambiguous to split.

import { connectUpstream } from "./rpc.js";

export const SEP = "__";

/** One upstream MCP server + its tools. */
export class Upstream {
  constructor(name, spec) {
    this.name = name;
    this.spec = spec;
    this.peer = null;
    this.child = null;
    this.tools = []; // raw upstream tool descriptors
    this.serverInfo = null;
    this.status = "disconnected";
    this.lastError = null;
    this.callCount = 0;
    this.lastUsed = 0;
  }

  get alive() {
    return this.status === "connected";
  }

  /** Qualified name a client uses: `server__tool`. */
  qname(toolName) {
    return `${this.name}${SEP}${toolName}`;
  }

  async connect() {
    const { peer, child, serverInfo } = await connectUpstream(this.spec);
    this.peer = peer;
    this.child = child;
    this.serverInfo = serverInfo;
    this.status = "connected";
    this.lastError = null;
    await this.refresh();
    return this;
  }

  /** Pull tools/list. Upstream servers may grow their catalog at runtime. */
  async refresh() {
    if (!this.peer) return this.tools;
    const res = await this.peer.request("tools/list", {});
    this.tools = Array.isArray(res?.tools) ? res.tools : [];
    return this.tools;
  }

  /** Split a qualified name back into (server, tool), or null if malformed. */
  static split(qname) {
    const i = qname.indexOf(SEP);
    if (i <= 0) return null;
    return { server: qname.slice(0, i), tool: qname.slice(i + SEP.length) };
  }

  async call(toolName, args) {
    this.callCount++;
    this.lastUsed = Date.now();
    return this.peer.request("tools/call", { name: toolName, arguments: args ?? {} });
  }

  async close() {
    this.status = "disconnected";
    try { this.peer?.close(); } catch {}
    try { this.child?.kill(); } catch {}
    this.peer = null;
    this.child = null;
  }
}

/** All connected upstreams, plus a flat qualified catalog. */
export class Registry {
  constructor() {
    this.upstreams = new Map(); // name -> Upstream
  }

  add(upstream) {
    this.upstreams.set(upstream.name, upstream);
    return upstream;
  }

  get(name) {
    return this.upstreams.get(name);
  }

  list() {
    return [...this.upstreams.values()];
  }

  /** Flattened catalog: [{ qname, server, tool, description, inputSchema }] */
  catalog() {
    const out = [];
    for (const up of this.upstreams.values()) {
      for (const t of up.tools) {
        out.push({
          qname: up.qname(t.name),
          server: up.name,
          tool: t.name,
          description: t.description ?? "",
          inputSchema: t.inputSchema ?? t.parameters ?? null,
        });
      }
    }
    return out;
  }

  /** Lookup by qualified name; throws a JSON-RPC-ish error if not resolvable. */
  resolve(qname) {
    const split = Upstream.split(qname);
    if (!split) {
      const err = new Error(`malformed tool name '${qname}' — expected server${SEP}tool`);
      err.code = -32602;
      throw err;
    }
    const up = this.upstreams.get(split.server);
    if (!up) {
      const err = new Error(`no upstream server named '${split.server}'`);
      err.code = -32602;
      throw err;
    }
    if (!up.alive) {
      const err = new Error(`upstream '${split.server}' is ${up.status}: ${up.lastError ?? "unknown"}`);
      err.code = -32002;
      throw err;
    }
    return { upstream: up, toolName: split.tool };
  }

  async closeAll() {
    for (const up of this.upstreams.values()) await up.close();
  }
}