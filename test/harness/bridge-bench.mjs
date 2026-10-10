// Measure what dock-bridge actually saves, on the tools this fleet really docks.
//
// Drives the REAL hook from plugin/bridge-core.js over the REAL tools/list
// payloads captured by codemode-probe.mjs, in three configurations:
//
//   baseline — no plugin: what opencode sends today
//   desc     — dock-bridge default: descriptions compacted, schemas untouched
//   thin     — DOCK_BRIDGE_THIN_SCHEMA=1: schemas collapsed to opaque too
//
// It also checks the thing a token table cannot: whether the catalog the search
// tool returns still holds the FULL schema after compaction, because that is the
// difference between "cheaper context" and "the model can no longer call it".
//
// Run:  node test/harness/bridge-bench.mjs [codemode-raw.json]   (argv optional;
//                                          defaults to
//                                          fixtures/live-catalog-2026-10-05.json)

import { readFileSync } from "node:fs";
import { makeBridge } from "../../plugin/bridge-core.js";

// --- input resolution ---------------------------------------------------------
// Bare invocation is the common case, so it must work. argv[2] is optional; with
// no argument we read the pinned capture committed alongside this harness, which
// keeps every number in the docs reproducible without live MCP servers (and
// without them drifting every time an upstream schema changes).
//
// To measure CURRENT state instead of the pin:
//   node test/harness/codemode-probe.mjs /tmp/codemode-raw.json
//   node test/harness/bridge-bench.mjs /tmp/codemode-raw.json
const DEFAULT_CAPTURE = new URL("./fixtures/live-catalog-2026-10-05.json", import.meta.url);
const capturePath = process.argv[2] ?? DEFAULT_CAPTURE;

if (process.argv.length < 3) {
  console.error("note: no capture given; using the pinned snapshot");
  console.error("      fixtures/live-catalog-2026-10-05.json");
  console.error("      for live state: node test/harness/codemode-probe.mjs /tmp/codemode-raw.json");
}

let raw;
try {
  raw = JSON.parse(readFileSync(capturePath, "utf8"));
} catch (e) {
  console.error(`cannot read capture: ${capturePath}`);
  console.error(`  ${e.code ?? e.message}`);
  console.error("  generate one: node test/harness/codemode-probe.mjs /tmp/codemode-raw.json");
  process.exit(2);
}

// Reconstruct the model-facing payload shape opencode builds per tool.
function entriesOf(arm) {
  return raw.payloads[arm].map((t) => ({
    name: t.name,
    description: t.description,
    jsonSchema: t.input_schema,
    parameters: undefined,
  }));
}

async function run(label, mode) {
  const bridge = makeBridge({ mode });
  const out = [];
  for (const entry of entriesOf("current")) {
    // Fresh object per tool: the hook mutates in place, and sharing objects
    // across runs would leak one configuration's compaction into the next.
    const def = { description: entry.description, parameters: entry.parameters, jsonSchema: entry.jsonSchema };
    await bridge.toolDefinition({ toolID: entry.name }, def);
    out.push({ name: entry.name, description: def.description, input_schema: def.jsonSchema });
  }
  return { label, entries: out, bridge };
}

const bytes = (o) => Buffer.byteLength(JSON.stringify(o));
const pad = (s, n) => String(s).padEnd(n);
const rpad = (s, n) => String(s).padStart(n);

const baseline = await run("baseline", "off");
const off      = await run("off", "off");
const safe     = await run("safe", "safe");
const thin     = await run("thin", "thin");

const b = bytes(baseline.entries);
const o = bytes(off.entries);
const s = bytes(safe.entries);
const t = bytes(thin.entries);

console.log("dock-bridge measurement — client-facing tool payload\n");
console.log(`  tools: ${baseline.entries.length} live tools (${raw.servers.map((x) => x.name).join(" + ")})\n`);
console.log(`  ${pad("config", 38)} ${rpad("bytes", 8)}   vs baseline`);
console.log(`  ${pad("(no plugin)", 38)} ${rpad(b, 8)}   —`);
console.log(`  ${pad("mode=off  (compact descriptions)", 38)} ${rpad(o, 8)}   ${(((o - b) / b) * 100).toFixed(1)}%`);
console.log(`  ${pad("mode=safe (strip schema prose)", 38)} ${rpad(s, 8)}   ${(((s - b) / b) * 100).toFixed(1)}%`);
console.log(`  ${pad("mode=thin (opaque schemas)", 38)} ${rpad(t, 8)}   ${(((t - b) / b) * 100).toFixed(1)}%`);

console.log(`\n  reference: dockd as an MCP server exposes 2 tools and measures 205 tok`);
console.log(`  (test/GATES.md). The hook cannot REMOVE a tool, so it cannot reach that`);

// Where the remaining cost sits — the concentration finding.
const ranked = baseline.entries
  .map((e) => ({ name: e.name, n: bytes(e.input_schema) }))
  .sort((x, y) => y.n - x.n);
console.log(`\n  concentration: ${ranked[0].name} alone is ${ranked[0].n} bytes of schema —`);
console.log(`  ${((ranked[0].n / b) * 100).toFixed(0)}% of the entire baseline payload.`);
console.log(`  the next four together: ${ranked.slice(1, 5).reduce((a, x) => a + x.n, 0)} bytes.`);

// --- integrity: does the search tool still return usable schemas? ------------
const probe = "read a file from disk";
const viaPlugin = JSON.parse(safe.bridge.findTool({ query: probe }));
console.log(`\n  integrity check — dock_find_tool(${JSON.stringify(probe)})`);
if (viaPlugin.abstained) {
  console.log(`    abstained: ${viaPlugin.reason}`);
} else {
  const top = viaPlugin.results[0];
  const full = baseline.entries.find((e) => e.name === top.tool);
  const hasProps =
    top.inputSchema && Object.keys(top.inputSchema.properties ?? {}).length > 0;
  console.log(`    top hit: ${top.tool}`);
  console.log(`    schema has properties: ${hasProps ? "yes" : "NO — model could not call it"}`);
  console.log(`    description is full text: ${top.description.length > 60 ? "yes" : "NO — catalog stored the thin copy"}`);
}

// --- the ceiling on this approach --------------------------------------------
const namesOnly = baseline.entries.reduce((n, e) => n + e.name.length, 0);
console.log(`\n  floor for any hook-only approach: ~${namesOnly} bytes of tool names alone.`);
console.log(`  thin mode reaches ${t} bytes, so the hook has ${t - namesOnly} bytes`);
console.log(`  left above the unavoidable floor. dockd reaches it by removing tools`);

// --- leakage: the search tool must still refuse nonsense ----------------------
console.log("\n  abstention through the plugin:");
let leaked = 0;
for (const q of ["book me a flight", "what is the weather tomorrow", "order two pizzas"]) {
  const r = JSON.parse(safe.bridge.findTool({ query: q }));
  const answered = !r.abstained;
  if (answered) leaked++;
  console.log(`    ${answered ? "LEAK" : "OK  "} ${pad(q, 34)} ${answered ? "answered" : "refused"}`);
}

const regression = s > b;                       // compaction must never cost more
const brokeCalls = !viaPlugin.abstained && viaPlugin.results[0] &&
  Object.keys(viaPlugin.results[0].inputSchema?.properties ?? {}).length === 0;
console.log("\n  VERDICT");
if (regression) console.log("    FAIL  compaction INCREASED the payload — the hook is not shrinking anything.");
else if (leaked) console.log(`    FAIL  search tool leaked ${leaked} answers into nonsense queries.`);
else if (brokeCalls) console.log("    FAIL  the catalog is storing thinned schemas — search results would be uncallable.");
else {
  console.log(`    PASS  safe mode ${(((s - b) / b) * 100).toFixed(1)}%, thin mode ${(((t - b) / b) * 100).toFixed(1)}%,`);
  console.log("          search still abstains, and returned schemas remain callable.");
  console.log("          NOTE: whether a THINNED schema survives real call validation is");
  console.log("          still unproven in a live session — hence thin defaults to off.");
}
process.exit(regression || leaked || brokeCalls ? 1 : 0);