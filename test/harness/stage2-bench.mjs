// Stage 1 vs stage 2 A/B over the REAL docked catalog.
//
// The unit tests pin behaviour on fixtures. This measures whether stage 2
// actually earns its place on the tools this fleet really docks: sovereign-kernel
// (12) + omnid (8), enumerated live over stdio.
//
// Method: the live catalog is indexed twice — once through the shipped stage-2
// select.js, once through a stage-1 reconstruction (identity stemmer, no synonym
// expansion) — and both are asked the same questions. Stage 1 is reconstructed
// rather than checked out from git so the only variable is the selection logic.
//
// Two things are measured, because they trade off:
//   RECALL  — on-topic queries that return the intended tool.
//   ABSTAIN — off-topic queries that correctly return nothing. A change that
//             lifts recall by leaking answers into nonsense queries is not an
//             improvement; the whole product is the refusal.
//
// Run:  node test/harness/stage2-bench.mjs [codemode-raw.json]   (argv optional;
//                                          defaults to
//                                          fixtures/live-catalog-2026-10-05.json)

import { readFileSync } from "node:fs";
import { buildIndex as build2, search as search2 } from "../../src/select.js";

// --- input resolution ---------------------------------------------------------
// Bare invocation is the common case, so it must work. argv[2] is optional; with
// no argument we read the pinned capture committed alongside this harness, which
// keeps every number in the docs reproducible without live MCP servers (and
// without them drifting every time an upstream schema changes).
//
// To measure CURRENT state instead of the pin:
//   node test/harness/codemode-probe.mjs /tmp/codemode-raw.json
//   node test/harness/stage2-bench.mjs /tmp/codemode-raw.json
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

// --- stage-1 reconstruction --------------------------------------------------
const STOPWORDS = new Set([
  "a", "an", "and", "any", "are", "as", "at", "be", "but", "by", "can", "do",
  "does", "for", "from", "get", "give", "has", "have", "how", "i", "if", "in",
  "into", "is", "it", "its", "me", "my", "need", "no", "not", "of", "on", "or",
  "our", "out", "please", "should", "so", "some", "that", "the", "their",
  "them", "then", "there", "these", "they", "this", "to", "up", "us", "was",
  "we", "were", "what", "when", "where", "which", "who", "why", "will",
  "with", "would", "you", "your",
]);
const tok1 = (s) =>
  String(s ?? "").toLowerCase().split(/[^a-z0-9_]+/).filter((t) => t && !STOPWORDS.has(t));

const K1 = 1.2, B = 0.75;
function build1(catalog) {
  const docs = catalog.map((entry) => ({ entry, tf: new Map(), len: 0 }));
  const df = new Map();
  for (const d of docs) {
    const toks = tok1(`${d.entry.qname} ${d.entry.description}`);
    d.len = toks.length;
    for (const t of toks) {
      d.tf.set(t, (d.tf.get(t) ?? 0) + 1);
      df.set(t, (df.get(t) ?? 0) + 1);
    }
  }
  const N = docs.length || 1;
  const avgLen = docs.reduce((s, d) => s + d.len, 0) / N || 1;
  const idf = new Map();
  for (const [t, n] of df) idf.set(t, Math.log(1 + (N - n + 0.5) / (n + 0.5)));
  return { docs, idf, N, avgLen };
}
function search1(index, query, { k = 8, minEvidence = 0.2, minConf = 0.75 } = {}) {
  const q = [...new Set(tok1(query))];
  const scored = [];
  for (const d of index.docs) {
    let score = 0;
    for (const t of q) {
      const f = d.tf.get(t);
      if (!f) continue;
      score += (index.idf.get(t) ?? 0) * ((f * (K1 + 1)) / (f + K1 * (1 - B + B * (d.len / index.avgLen))));
    }
    if (score > 0) scored.push({ entry: d.entry, score });
  }
  let ceiling = 0;
  for (const t of q) if (index.idf.has(t)) ceiling += index.idf.get(t);
  if (!scored.length || ceiling <= 0) return { results: [], abstained: true };
  scored.sort((a, b) => b.score - a.score);
  const top = scored[0].score;
  if (top / ceiling < minEvidence) return { results: [], abstained: true };
  const second = scored[1]?.score ?? 0;
  const confidence = top > 0 ? 1 - Math.min(second / top, 1) : 1;
  return {
    results: scored.slice(0, k).map((r) => ({ qname: r.entry.qname, score: r.score })),
    abstained: false,
    ambiguous: confidence < minConf,
    confidence,
  };
}

// --- the live catalog --------------------------------------------------------
// Rebuild from the raw payloads: name, description and schema per upstream tool.
const catalog = [];
for (const arm of raw.payloads.current) {
  const [server, ...rest] = arm.name.split("_");
  catalog.push({
    qname: arm.name,
    server,
    tool: rest.join("_"),
    description: arm.description ?? "",
    inputSchema: arm.input_schema ?? null,
  });
}

const i1 = build1(catalog);
const i2 = build2(catalog);

// On-topic, phrased the way a model naturally asks. Every `expect` names a tool
// that ACTUALLY EXISTS in the catalog above — an earlier draft of this file
// asked for a "list" and a "git" tool, neither of which is docked, and scored
// the resulting misses as if they were selection failures.
const BASELINE = [
  ["read a file from disk", "read"],
  ["search the vault for notes", "shard_search"],
  ["write a note to disk", "write"],
  ["find text across many files", "grep"],
  ["fetch a url over http", "fetch"],
  ["run a sql query", "sql"],
  ["record something in memory", "shard"],
  ["show the dispatch board status", "board"],
];

// The queries stage 2 exists for: the ask is phrased with a DIFFERENT verb or
// inflection than the tool advertises. Stage 1 cannot answer these by
// construction — that is the point of measuring them separately, so a stage-2
// gain is never confused with a baseline regression.
const MORPH = [
  ["open a file", "read"],          // synonym: read -> open
  ["save a note", "write"],         // synonym: write -> save
  ["reading a config file", "read"],// inflection: reading -> read
  ["listings of files", "glob"],    // inflection: listings -> listing/list
  ["fetched documents", "fetch"],    // inflection: fetched -> fetch
];

// Off-topic: nothing docked can serve these. Correct behaviour is silence.
const OFF_TOPIC = [
  "book me a flight to lisbon",
  "what is the weather tomorrow",
  "translate this into french",
  "frobnicate the widget",
  "order two pizzas",
];

const hit = (out, expect) => !out.abstained && out.results.some((r) => r.qname.includes(expect));

function report(title, rows, tally) {
  console.log(`  ${title}`);
  for (const [q, expect] of rows) {
    const a = search1(i1, q), b = search2(i2, q);
    const ha = hit(a, expect), hb = hit(b, expect);
    tally.s1 += ha ? 1 : 0;
    tally.s2 += hb ? 1 : 0;
    const gain = hb && !ha ? "  <- stage 2 gained this" : ha && !hb ? "  <- REGRESSION" : "";
    console.log(
      `    ${hb ? "OK  " : "MISS"} ${q.padEnd(34)} expect~${expect.padEnd(14)}` +
        `stage1=${ha ? "hit " : "miss"} stage2=${hb ? "hit " : "miss"}${gain}`
    );
  }
}

const tb = { s1: 0, s2: 0 };
const tm = { s1: 0, s2: 0 };
let s1leak = 0, s2leak = 0;

console.log(`catalog: ${catalog.length} live tools from ${raw.servers.map((s) => s.name).join(" + ")}\n`);

report("BASELINE RECALL (ordinary asks — stage 2 must not regress)", BASELINE, tb);
console.log(`\n    stage 1 ${tb.s1}/${BASELINE.length}   stage 2 ${tb.s2}/${BASELINE.length}`);

report("MORPH/SYNONYM RECALL (the asks stage 2 exists for)", MORPH, tm);
console.log(`\n    stage 1 ${tm.s1}/${MORPH.length}   stage 2 ${tm.s2}/${MORPH.length}`);

console.log("\n  ABSTENTION (off-topic — it must still refuse)");
for (const q of OFF_TOPIC) {
  const a = search1(i1, q), b = search2(i2, q);
  const la = !a.abstained, lb = !b.abstained;   // answered == leaked
  if (la) s1leak++;
  if (lb) s2leak++;
  console.log(
    `    ${lb ? "LEAK" : "OK  "} ${q.padEnd(34)} ` +
      `stage1=${la ? "answered" : "refused"} stage2=${lb ? "answered" : "refused"}`
  );
}
console.log(`\n    stage 1 leaked ${s1leak}/${OFF_TOPIC.length}   stage 2 leaked ${s2leak}/${OFF_TOPIC.length}`);

const baseDelta = tb.s2 - tb.s1;
const morphDelta = tm.s2 - tm.s1;
console.log("\n  VERDICT");
if (s2leak > s1leak) {
  console.log(`    FAIL  stage 2 leaked ${s2leak - s1leak} extra answers into nonsense queries.`);
  console.log("          Expansion is too aggressive; the abstain gate is the product.");
} else if (baseDelta < 0) {
  console.log(`    FAIL  baseline recall fell by ${-baseDelta}. Stage 2 is a regression on ordinary asks.`);
} else if (morphDelta > 0) {
  console.log(`    PASS  baseline held (${baseDelta >= 0 ? "+" : ""}${baseDelta}), ` +
    `morph/synonym recall +${morphDelta} (${tm.s1}->${tm.s2}/${MORPH.length}), ` +
    `no new leakage (${s2leak}/${OFF_TOPIC.length}).`);
} else {
  console.log("    HOLD  no regression and no gain on the live catalog — stage 2 is");
  console.log("          inert here. Either the wording is already aligned or the");
  console.log("          stemmer is too timid for this catalog.");
}
process.exit(s2leak > s1leak || baseDelta < 0 ? 1 : 0);