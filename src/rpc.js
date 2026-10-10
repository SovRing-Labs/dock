// dock/rpc.js — JSON-RPC 2.0 over newline-delimited stdio.
//
// Why this file exists instead of @modelcontextprotocol/sdk: dock ships to the
// public with ZERO runtime dependencies. That is a deliberate custody choice —
// see README "Why no dependencies". Everything here is the subset of MCP we
// actually need to both speak to a client and drive upstream servers.
//
// MCP stdio framing is one JSON object per line on both directions. No
// Content-Length headers (that is LSP, not MCP). Keep it that way.

import { spawn } from "node:child_process";
import { EventEmitter } from "node:events";

export const PROTOCOL_VERSION = "2025-06-18";

/**
 * Shared request/response plumbing over a line-delimited pipe pair.
 *
 * `readable` is the stream frames arrive ON; `writable` is the stream replies
 * go OUT. For our server end these are process.stdin/process.stdout. For our
 * client end of an upstream they are child.stdout/child.stdin — note the swap,
 * which is why this takes two explicitly named streams rather than assuming
 * "stdin means peer output".
 */
class RpcPeer extends EventEmitter {
  constructor(readable, writable) {
    super();
    this._pending = new Map();
    this._nextId = 1;
    this._stdout = writable;
    this._closed = false;

    let buf = "";
    readable.setEncoding("utf8");
    readable.on("data", (chunk) => {
      buf += chunk;
      let nl;
      // A single data event can carry several frames, or half of one.
      while ((nl = buf.indexOf("\n")) >= 0) {
        const line = buf.slice(0, nl).trim();
        buf = buf.slice(nl + 1);
        if (line) this._onLine(line);
      }
    });
    readable.on("end", () => this._failAll(new Error("peer closed readable")));
    readable.on("close", () => this._failAll(new Error("peer closed readable")));
  }

  _failAll(err) {
    if (this._closed) return;
    this._closed = true;
    for (const [, p] of this._pending) p.reject(err);
    this._pending.clear();
    this.emit("close", err);
  }

  _onLine(line) {
    let msg;
    try {
      msg = JSON.parse(line);
    } catch (err) {
      // A malformed frame must not kill the peer; a server that dies on one bad
      // byte is a server that drops the client's whole tool catalog.
      this.emit("parseError", { line, err });
      return;
    }
    if (msg.jsonrpc !== "2.0") return;

    if (msg.id !== undefined && msg.method) {
      this._onRequest(msg);
      return;
    }
    if (msg.id !== undefined) {
      const p = this._pending.get(msg.id);
      if (!p) return; // late reply for a cancelled/timed-out call
      this._pending.delete(msg.id);
      if (msg.error) {
        const e = new Error(msg.error.message ?? "upstream error");
        e.code = msg.error.code;
        e.data = msg.error.data;
        p.reject(e);
      } else {
        p.resolve(msg.result);
      }
    }
    // Notifications (no id) are informational; consumers listen on the bus.
    else if (msg.method) this.emit("notification", msg);
  }

  _onRequest(msg) {
    const handler = this._requestHandler;
    if (!handler) {
      this._write({ jsonrpc: "2.0", id: msg.id, error: { code: -32601, message: "method not found" } });
      return;
    }
    Promise.resolve()
      .then(() => handler(msg.method, msg.params ?? {}))
      .then(
        (result) => this._write({ jsonrpc: "2.0", id: msg.id, result }),
        (err) =>
          this._write({
            jsonrpc: "2.0",
            id: msg.id,
            error: { code: err.code ?? -32603, message: String(err.message ?? err) },
          })
      );
  }

  setRequestHandler(fn) {
    this._requestHandler = fn;
  }

  _write(obj) {
    if (this._closed) return;
    try {
      this._stdout.write(JSON.stringify(obj) + "\n");
    } catch (err) {
      this.emit("writeError", err);
    }
  }

  /** Issue a request and await its reply. `timeoutMs` guards a wedged upstream. */
  request(method, params = {}, { timeoutMs = 30000 } = {}) {
    if (this._closed) return Promise.reject(new Error("peer is closed"));
    const id = this._nextId++;
    const payload = { jsonrpc: "2.0", id, method, params };
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this._pending.delete(id);
        // -32001 is the conventional JSON-RPC "server did not respond" code.
        const e = new Error(`${method} timed out after ${timeoutMs}ms`);
        e.code = -32001;
        reject(e);
      }, timeoutMs);
      timer.unref?.();
      this._pending.set(id, {
        resolve: (v) => { clearTimeout(timer); resolve(v); },
        reject: (e) => { clearTimeout(timer); reject(e); },
      });
      this._write(payload);
    });
  }

  notify(method, params = {}) {
    this._write({ jsonrpc: "2.0", method, params });
  }

  close() {
    this._failAll(new Error("peer closed"));
  }
}

/** Our end of a client connection: dock is the server, the harness is the client. */
export class ServerPeer extends RpcPeer {
  constructor(stdin = process.stdin, stdout = process.stdout) {
    super(stdin, stdout);
  }
}

/** Our end of an upstream connection: dock is the client of someone else's server. */
export class ClientPeer extends RpcPeer {}

/**
 * Spawn an upstream MCP server and complete the initialize handshake.
 * Returns { peer, child, serverInfo, capabilities } — caller owns child.
 */
export async function connectUpstream(spec, { timeoutMs = 20000 } = {}) {
  const child = spawn(spec.command, spec.args ?? [], {
    cwd: spec.cwd,
    env: { ...process.env, ...(spec.env ?? {}) },
    stdio: ["pipe", "pipe", "pipe"],
  });

  let stderr = "";
  child.stderr.setEncoding("utf8");
  child.stderr.on("data", (d) => {
    // Servers log freely on stderr; it must never reach our stdout or it
    // corrupts the frame stream.
    stderr += d;
    if (stderr.length > 8192) stderr = stderr.slice(-8192);
  });

  const exited = new Promise((_, reject) => {
    child.on("error", (err) => reject(new Error(`spawn ${spec.command}: ${err.message}`)));
    child.on("exit", (code, sig) =>
      reject(new Error(`${spec.command} exited (code=${code} signal=${sig})${stderr ? `: ${stderr.trim().slice(-400)}` : ""}`))
    );
  });

  // Readable = child's stdout (frames come back out), writable = child's stdin.
  const peer = new ClientPeer(child.stdout, child.stdin);

  const init = await Promise.race([
    peer
      .request(
        "initialize",
        {
          protocolVersion: PROTOCOL_VERSION,
          capabilities: {},
          clientInfo: { name: "dock", version: "0.1.0" },
        },
        { timeoutMs }
      )
      .catch((err) => {
        throw new Error(`initialize failed: ${err.message}`);
      }),
    exited,
  ]);

  // Both halves are required by the spec handshake: the server may not send
  // requests before it has seen ours, and `initialized` acknowledges ours.
  peer.notify("notifications/initialized", {});

  return {
    peer,
    child,
    serverInfo: init?.serverInfo ?? null,
    capabilities: init?.capabilities ?? {},
  };
}