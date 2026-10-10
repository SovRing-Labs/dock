// Plugin-core tests.
//
// These exist because the plugin is the part of dock most likely to be wrong in a
// way the token table will not show: a schema that gets mutated too far, or a
// search catalog that stores the thinned copy instead of the real one, either of
// which leaves a model unable to call a tool it was just told about.

import { test } from "node:test";
import assert from "node:assert/strict";
import { makeBridge, stripSchemaDescriptions, compactDescription } from "../plugin/bridge-core.js";

const SCHEMA = {
  type: "object",
  properties: {
    query: { type: "string", description: "What you want to do, in plain language." },
    limit: { type: "integer", description: "How many results to return.", minimum: 1 },
    mode: { type: "string", enum: ["a", "b"], description: "Which mode to use." },
    nested: {
      type: "object",
      description: "A nested thing.",
      properties: { inner: { type: "string", description: "Inner value." } },
    },
  },
  required: ["query"],
};

test("stripSchemaDescriptions removes prose but keeps every callable structure", () => {
  const out = stripSchemaDescriptions(SCHEMA);
  // Structure survives — this is the whole point of the "safe" mode.
  assert.deepEqual(Object.keys(out.properties), ["query", "limit", "mode", "nested"]);
  assert.equal(out.properties.query.type, "string");
  assert.equal(out.properties.limit.type, "integer");
  assert.equal(out.properties.limit.minimum, 1);
  assert.deepEqual(out.properties.mode.enum, ["a", "b"]);
  assert.deepEqual(out.required, ["query"]);
  assert.equal(out.properties.nested.properties.inner.type, "string", "nesting must survive");
  // Prose is gone at every level.
  assert.equal(out.description, undefined);
  assert.equal(out.properties.query.description, undefined);
  assert.equal(out.properties.nested.description, undefined);
  assert.equal(out.properties.nested.properties.inner.description, undefined);
});

test("the catalog stores the ORIGINAL schema, never the thinned one", () => {
  // Regression shape: if the catalog captured post-compaction schemas, a search
  // hit would hand the model a schema with no properties and no way to call it.
  for (const mode of ["off", "safe", "thin"]) {
    const bridge = makeBridge({ mode });
    const def = { description: "Read a file from disk.", parameters: undefined, jsonSchema: SCHEMA };
    bridge.toolDefinition({ toolID: "fs__read" }, def);
    const stored = bridge.catalog.get("fs__read");
    assert.ok(stored, `${mode}: tool was not captured`);
    assert.deepEqual(
      stored.inputSchema,
      SCHEMA,
      `${mode}: catalog must keep the full schema`
    );
    assert.ok(Object.keys(stored.inputSchema.properties).length > 0, `${mode}: captured schema is empty`);
  }
});

test("a search hit returns a callable schema in every mode", async () => {
  const bridge = makeBridge({ mode: "thin" });
  bridge.toolDefinition({ toolID: "fs__read" }, { description: "Read a file from disk.", jsonSchema: SCHEMA });
  bridge.toolDefinition({ toolID: "net__mail" }, { description: "Send an email message.", jsonSchema: { type: "object", properties: { to: { type: "string" } } } });
  const out = JSON.parse(bridge.findTool({ query: "read a file from disk" }));
  assert.equal(out.abstained, false);
  const top = out.results[0];
  assert.equal(top.tool, "fs__read");
  assert.ok(Object.keys(top.inputSchema.properties).length > 0, "top hit must carry a real schema");
});

test("dock's own tools are never thinned", () => {
  // The escape hatch must stay usable: if dock_find_tool's own definition is
  // stripped, a model can search and still be unable to act.
  const bridge = makeBridge({ mode: "thin" });
  const def = { description: "Search every tool available in this session.", jsonSchema: SCHEMA };
  bridge.toolDefinition({ toolID: "dock_find_tool" }, def);
  assert.deepEqual(def.jsonSchema, SCHEMA, "protected tool schema was mutated");
  assert.equal(def.description, "Search every tool available in this session.");
});

test("abstention survives the plugin path", () => {
  const bridge = makeBridge({ mode: "safe" });
  bridge.toolDefinition({ toolID: "fs__read" }, { description: "Read a file from disk.", jsonSchema: SCHEMA });
  const out = JSON.parse(bridge.findTool({ query: "book me a flight to lisbon" }));
  assert.equal(out.abstained, true, "the search tool must still refuse nonsense");
  assert.equal(out.catalogSize, 1);
});

test("an empty query and an empty catalog are answered, not crashed on", () => {
  const bridge = makeBridge({ mode: "safe" });
  assert.match(bridge.findTool({ query: "   " }), /Provide a query/);
  assert.match(bridge.findTool({ query: "read a file" }), /not seen any tool definitions/);
});

test("an unknown mode is rejected rather than silently defaulted", () => {
  // A typo in DOCK_BRIDGE_MODE must not quietly turn into "safe" and surprise
  // someone later with a payload they did not expect.
  assert.throws(() => makeBridge({ mode: "aggressive" }), /unknown mode/);
});

test("compactDescription keeps the first sentence and respects the limit", () => {
  assert.equal(compactDescription("Read a file. Then do other things."), "Read a file.");
  assert.equal(compactDescription("No terminator here"), "No terminator here");
  const long = compactDescription("x".repeat(400), 50);
  assert.ok(long.length <= 50, `length ${long.length}`);
  assert.ok(long.endsWith("…"));
  assert.equal(compactDescription(""), "");
});

// The registered plugin is a TypeScript file, so `npm test` cannot simply import
// it. But "the plugin fails to load" is the single worst failure mode available
// here: opencode would skip it silently and every seat would quietly keep paying
// full price while the repo claimed a 25% saving. Node 22 can strip types, so
// the registered file is loaded and driven for real here.
const PLUGIN = new URL("../plugin/dock-bridge.opencode-plugin.STAGED.ts", import.meta.url).pathname; // the shipped plugin file

test("the registered dock-bridge.ts loads and wires up", async (t) => {
  const major = Number(process.versions.node.split(".")[0]);
  if (major < 22) return t.skip("needs node >= 22 for --experimental-strip-types");

  const script = `
    const m = await import(${JSON.stringify(PLUGIN)});
    if (typeof m.default !== "function") {
      throw new Error("default export is " + typeof m.default + ", not a Plugin function");
    }
    const hooks = await m.default({});
    if (!hooks["tool.definition"]) throw new Error("tool.definition hook missing");
    if (!hooks.tool?.dock_find_tool) throw new Error("dock_find_tool missing");
    const def = { description: "Read a file from disk. Returns contents.", jsonSchema: {
      type: "object", properties: { path: { type: "string", description: "absolute path" } }, required: ["path"] } };
    await hooks["tool.definition"]({ toolID: "fs__read" }, def);
    const hit = JSON.parse(await hooks.tool.dock_find_tool.execute({ query: "read a file from disk" }));
    const miss = JSON.parse(await hooks.tool.dock_find_tool.execute({ query: "book a flight" }));
    process.stdout.write(JSON.stringify({
      description: def.description,
      schema: def.jsonSchema,
      hitAbstained: hit.abstained, hitTool: hit.results?.[0]?.tool,
      hitHasProps: Object.keys(hit.results?.[0]?.inputSchema?.properties ?? {}).length > 0,
      missAbstained: miss.abstained,
    }));
  `;
  const { execFileSync } = await import("node:child_process");
  let raw;
  try {
    raw = execFileSync(
      process.execPath,
      ["--experimental-strip-types", "--no-warnings", "--input-type=module", "-e", script],
      { encoding: "utf8", timeout: 60000 }
    );
  } catch (e) {
    assert.fail(`dock-bridge.ts failed to load: ${e.stderr || e.message}`);
  }
  const got = JSON.parse(raw);

  // The exact bug this test was written for: an invoked async IIFE makes `default`
  // a resolved Promise, and opencode then never registers a single hook.
  assert.equal(typeof got, "object");
  assert.equal(got.hitAbstained, false, "search must reach the tool");
  assert.equal(got.hitTool, "fs__read");
  assert.equal(got.hitHasProps, true, "search must return a callable schema");
  assert.equal(got.missAbstained, true, "search must still abstain");
  assert.equal(got.description, "Read a file from disk.", "description should be compacted");
  assert.deepEqual(got.schema, { type: "object", properties: { path: { type: "string" } }, required: ["path"] },
    "safe mode must keep structure and drop only prose");
});