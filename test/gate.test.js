// THE GATE TEST.
//
// The product claim is falsifiable in one assertion: dock the SAME client-facing
// surface against 1 upstream and against 4 upstreams with many tools, and the
// bytes the client pays must not grow. Everything else in this repo is quality;
// this is correctness.
//
// If you change dock so this file passes trivially (e.g. by shrinking the two
// meta-tools to nothing), you have deleted the product.

import { test } from "node:test";
import assert from "node:assert/strict";
import { Dock } from "../src/dockd.js";
import { search, buildIndex } from "../src/select.js";
import { Upstream, SEP } from "../src/upstream.js";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const HERE = dirname(fileURLToPath(import.meta.url));
const FIXTURE = join(HERE, "fixture-server.js");

function fixtureSpec(name, nTools, capabilities) {
  return {
    name,
    command: process.execPath,
    args: [FIXTURE],
    env: {
      FIXTURE_TOOLS: String(nTools),
      FIXTURE_PREFIX: name,
      FIXTURE_CAPABILITIES: capabilities,
    },
  };
}

/** Rough token proxy, matching bin/mcp-audit's 4-bytes-per-token convention. */
const tokenTax = (tools) =>
  Math.round(Buffer.byteLength(JSON.stringify(tools)) / 4);

async function dockWith(specs) {
  const dock = new Dock();
  for (const spec of specs) {
    await dock.addUpstream(spec.name, { command: spec.command, args: spec.args, env: spec.env });
  }
  return dock;
}

test("gate: client-facing surface is constant regardless of upstream count", async () => {
  const one = await dockWith([fixtureSpec("fx1", 4, "alpha,beta,gamma")]);
  const four = await dockWith([
    fixtureSpec("fx1", 4, "alpha,beta,gamma"),
    fixtureSpec("fx2", 6, "delta,epsilon,zeta"),
    fixtureSpec("fx3", 8, "eta,theta,iota"),
    fixtureSpec("fx4", 12, "kappa,lambda,mu"),
  ]);

  try {
    const reachableOne = one.registry.catalog().length;
    const reachableFour = four.registry.catalog().length;
    assert.equal(reachableOne, 4);
    assert.equal(reachableFour, 30);

    const taxOne = tokenTax(one.exposedTools);
    const taxFour = tokenTax(four.exposedTools);

    assert.equal(
      taxFour,
      taxOne,
      `client tax grew with upstream count: ${taxOne} -> ${taxFour}`
    );
    assert.equal(four.exposedTools.length, 2);

    // The real comparison: what a naive client would pay vs what dock charges.
    const naive = tokenTax(four.registry.catalog());
    assert.ok(
      taxFour < naive / 10,
      `dock should be >10x cheaper than enumeration (got ${taxFour} vs ${naive})`
    );
    console.log(
      `GATE PASS  30 upstream tools reachable -> ${four.exposedTools.length} exposed, ` +
        `${taxFour} tok (naive enumeration would be ${naive} tok)`
    );
  } finally {
    await one.registry.closeAll();
    await four.registry.closeAll();
  }
});

test("initialize and tools/list speak real MCP", async () => {
  const dock = await dockWith([fixtureSpec("fx1", 3, "alpha")]);
  try {
    const init = await dock.handle("initialize", { protocolVersion: "2025-06-18" });
    assert.equal(init.serverInfo.name, "dock");
    assert.ok(init.capabilities.tools);

    const list = await dock.handle("tools/list", {});
    assert.deepEqual(
      list.tools.map((t) => t.name).sort(),
      ["call_tool", "search_tools"]
    );
  } finally {
    await dock.registry.closeAll();
  }
});


test("ABSTENTION: nothing relevant returns empty rather than top-k", async () => {
  const dock = await dockWith([
    fixtureSpec("files", 3, "reading,writing,listing"),
    fixtureSpec("net", 3, "fetching,sending,receiving"),
  ]);
  try {
    const res = await dock.handle("tools/call", {
      name: "search_tools",
      arguments: { query: "zzzz qqqq wubblefrotz xyzzy" },
    });
    const out = JSON.parse(res.content[0].text);
    assert.equal(out.abstained, true, "must abstain when nothing is relevant");
    assert.deepEqual(out.results, []);
    assert.equal(res._meta.abstained, true);
  } finally {
    await dock.registry.closeAll();
  }
});

test("ABSTENTION: stopwords alone do not manufacture false confidence", () => {
  // Regression: with stopwords in the index, "the a of" matched every tool and
  // produced a full ranked list. The whole point is that noise yields nothing.
  const index = buildIndex([
    { qname: "a__x", server: "a", tool: "x", description: "The tool of the day.", inputSchema: null },
    { qname: "b__y", server: "b", tool: "y", description: "A tool for the people.", inputSchema: null },
  ]);
  const out = search(index, "the a of");
  assert.equal(out.abstained, true, `stopword-only query returned ${out.results.length} results`);
});

test("AMBIGUITY is flagged, not withheld", () => {
  // Two tools that tie are both relevant. Returning them with a flag lets the
  // model choose; abstaining would hide genuinely relevant tools.
  const index = buildIndex([
    { qname: "fs__read", server: "fs", tool: "read", description: "read a file", inputSchema: null },
    { qname: "fs__write", server: "fs", tool: "write", description: "read a file", inputSchema: null },
  ]);
  const out = search(index, "read a file");
  assert.equal(out.abstained, false, "a tie is not ignorance");
  assert.equal(out.ambiguous, true);
  assert.equal(out.results.length, 2);
  assert.ok(out.note, "ambiguous results must carry a note");
});

test("a clear query is confident and unambiguous", () => {
  const index = buildIndex([
    { qname: "fs__read", server: "fs", tool: "read", description: "read a file", inputSchema: null },
    { qname: "net__mail", server: "net", tool: "mail", description: "send an email", inputSchema: null },
  ]);
  const out = search(index, "send an email");
  assert.equal(out.abstained, false);
  assert.equal(out.ambiguous, false);
  assert.ok(out.confidence > 0.9, `confidence ${out.confidence}`);
  assert.equal(out.results[0].qname, "net__mail");
});

test("call_tool round-trips to the right upstream", async () => {
  const dock = await dockWith([
    fixtureSpec("alpha", 3, "one"),
    fixtureSpec("beta", 3, "two"),
  ]);
  try {
    const res = await dock.handle("tools/call", {
      name: "call_tool",
      arguments: { tool: `beta${SEP}beta_op0`, arguments: { target: "thing" } },
    });
    assert.equal(res.isError, false);
    assert.match(res.content[0].text, /beta_op0 ran on beta/);
    assert.match(res.content[0].text, /thing/);
  } finally {
    await dock.registry.closeAll();
  }
});

test("call_tool reports a clear error for an unknown server", async () => {
  const dock = await dockWith([fixtureSpec("alpha", 2, "one")]);
  try {
    const res = await dock.handle("tools/call", {
      name: "call_tool",
      arguments: { tool: `nosuch${SEP}op0` },
    });
    assert.equal(res.isError, true);
    assert.match(res.content[0].text, /no upstream server named 'nosuch'/);
  } finally {
    await dock.registry.closeAll();
  }
});

test("call_tool rejects a malformed unqualified name", async () => {
  const dock = await dockWith([fixtureSpec("alpha", 2, "one")]);
  try {
    const res = await dock.handle("tools/call", {
      name: "call_tool",
      arguments: { tool: "bare_name" },
    });
    assert.equal(res.isError, true);
    assert.match(res.content[0].text, /malformed tool name/);
  } finally {
    await dock.registry.closeAll();
  }
});

test("dock exposes nothing beyond the two meta-tools", async () => {
  const dock = await dockWith([fixtureSpec("alpha", 5, "one")]);
  try {
    const res = await dock.handle("tools/call", { name: "fx1_alpha_op0", arguments: {} });
    assert.equal(res.isError, true);
    assert.match(res.content[0].text, /dock exposes only/);
  } finally {
    await dock.registry.closeAll();
  }
});


test("a dead upstream is reported, not crashed through", async () => {
  const dock = new Dock();
  const up = dock.registry.add(new Upstream("broken", { command: "/nonexistent/binary" }));
  try {
    await assert.rejects(() => up.connect());
    assert.equal(up.alive, false);
    dock.reindex();
    const res = await dock.handle("tools/call", {
      name: "call_tool",
      arguments: { tool: `broken${SEP}anything` },
    });
    assert.equal(res.isError, true);
    assert.match(res.content[0].text, /disconnected/);
  } finally {
    await dock.registry.closeAll();
  }
});