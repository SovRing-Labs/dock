// Stage 2 selection tests: morphology and synonym expansion.
//
// Each test here pins a specific failure that stage 2 could introduce. The
// stage-1 danger is documented and unchanged — an over-eager change fuses
// unrelated tools into a tie, the tie trips the ambiguity flag, and a clear
// query abstains. So the tests below are mostly about what must NOT happen.

import { test } from "node:test";
import assert from "node:assert/strict";
import { search, buildIndex, scoreQuery, stem } from "../src/select.js";

test("STEM: a verb matches its inflection, which is why stage 2 exists", () => {
  const index = buildIndex([
    { qname: "fs__read_file", server: "fs", tool: "read_file", description: "Reading a file from disk and returning its contents.", inputSchema: null },
  ]);
  // Stage 1 could not do this: "read" never matched "reading".
  const out = search(index, "read a file");
  assert.equal(out.abstained, false, `"read" failed to reach "Reading": ${out.reason ?? ""}`);
  assert.equal(out.results[0].qname, "fs__read_file");
});

test("STEM: plurals and -ed inflect to their base", () => {
  assert.equal(stem("files"), "file");
  assert.equal(stem("documents"), "document");
  assert.equal(stem("fetched"), "fetch");
  assert.equal(stem("queries"), "query");
  assert.equal(stem("running"), "run", "a doubled final consonant must be undone");
  assert.equal(stem("committing"), "commit");
});

test("STEM guards: words that must NOT be stemmed", () => {
  // Each of these is a real near-miss. Stripping them would fuse a tool that
  // should not match one that should, or invent a token no document contains.
  assert.equal(stem("less"), "less", "'less' must not become 'les'");
  assert.equal(stem("analysis"), "analysis", "-is is not a plural");
  assert.equal(stem("status"), "status", "-us is not a plural");
  assert.equal(stem("classes"), "class");
  assert.equal(stem("class"), "class", "-ss is not a plural");
  assert.equal(stem("set"), "set", "short words are never touched");
  assert.equal(stem("bed"), "bed", "-ed needs a vowel-bearing stem");
});

test("SYNONYM: a query verb reaches a document that only uses its synonym", () => {
  const index = buildIndex([
    { qname: "fs__read_file", server: "fs", tool: "read_file", description: "Read a file from disk and return its contents.", inputSchema: null },
    { qname: "mod__load", server: "mod", tool: "load", description: "Load a module from disk and return its contents.", inputSchema: null },
  ]);
  const out = scoreQuery(index, "read module");
  assert.ok(
    out.scored.some((r) => r.entry.qname === "mod__load"),
    "the query verb 'read' should reach the document that says 'load'"
  );
});

test("SYNONYM expansion must not inflate the evidence ceiling", () => {
  // The asymmetry is the safety property: expansion widens what can MATCH but
  // not what is DEMANDED. If a synonym leaked into the ceiling, `top/ceiling`
  // would shrink on every expanded query and the abstain gate would become a
  // hair trigger.
  const index = buildIndex([
    { qname: "fs__read_file", server: "fs", tool: "read_file", description: "Read a file from disk.", inputSchema: null },
    { qname: "mod__load", server: "mod", tool: "load", description: "Load a module from disk.", inputSchema: null },
  ]);
  const out = scoreQuery(index, "read module");
  const expected = (index.idf.get("read") ?? 0) + (index.idf.get("module") ?? 0);
  assert.equal(out.ceiling, expected, "ceiling must be built from the asked-for terms only");
  assert.deepEqual(out.tokens.sort(), ["module", "read"]);
});

test("SYNONYM expansion is symmetric, not head-to-tail", () => {
  // Regression: one-directional expansion measured INERT on the live catalog —
  // 0 recall gained — because it only helped when the query used the canonical
  // word. A model asking to "save a note" is asking a `write` tool, and that
  // query contains no substring of "write".
  const index = buildIndex([
    { qname: "fs__write", server: "fs", tool: "write", description: "Write text content to a file, overwriting if present.", inputSchema: null },
  ]);
  const out = scoreQuery(index, "save a note");
  assert.ok(
    out.scored.some((r) => r.entry.qname === "fs__write"),
    "query 'save' must reach a document that says 'write'"
  );
});

test("SYNONYM closure is transitive across a class", () => {
  // create -> make -> add -> new is one equivalence class, so a query for any
  // member reaches a document written with any other.
  const index = buildIndex([
    { qname: "fs__add", server: "fs", tool: "add", description: "Add an entry to a collection.", inputSchema: null },
  ]);
  const out = scoreQuery(index, "new");
  assert.ok(
    out.scored.some((r) => r.entry.qname === "fs__add"),
    "'new' and 'add' are in the same class and must reach each other"
  );
});

test("SYNONYM expansion cannot rescue an irrelevant query", () => {
  // The expansion must not become a back door around abstention.
  const index = buildIndex([
    { qname: "fs__read_file", server: "fs", tool: "read_file", description: "Read a file from disk.", inputSchema: null },
  ]);
  const out = search(index, "zzzz qqqq wubblefrotz");
  assert.equal(out.abstained, true);
  assert.deepEqual(out.results, []);
});

test("STEMING must not fuse two unrelated tools into an ambiguous tie", () => {
  // The stage-1 regression shape: two tools that should be distinguishable
  // becoming indistinguishable would flip a confident query to ambiguous.
  const index = buildIndex([
    { qname: "net__mail", server: "net", tool: "mail", description: "Send an email message to a recipient address.", inputSchema: null },
    { qname: "fs__read_file", server: "fs", tool: "read_file", description: "Read a file from disk and return its contents.", inputSchema: null },
  ]);
  const out = search(index, "send an email");
  assert.equal(out.abstained, false);
  assert.equal(out.ambiguous, false, `stemming caused a false tie: ${out.note ?? ""}`);
  assert.equal(out.results[0].qname, "net__mail");
});

test("a clear query still clears full evidence coverage", () => {
  const index = buildIndex([
    { qname: "net__mail", server: "net", tool: "mail", description: "Send an email message to a recipient address.", inputSchema: null },
    { qname: "fs__read_file", server: "fs", tool: "read_file", description: "Read a file from disk and return its contents.", inputSchema: null },
  ]);
  const out = search(index, "send an email");
  assert.equal(out.abstained, false);
  assert.equal(out.results[0].qname, "net__mail");
});

test("evidence is reported as coverage, never above 100%", () => {
  // Synonym boosts can push `top` past the ceiling; the clamp keeps the number
  // a model reads meaningful.
  const index = buildIndex([
    { qname: "fs__read", server: "fs", tool: "read", description: "Read a file. Load a file. Open a file. Parse a file.", inputSchema: null },
    { qname: "x__other", server: "x", tool: "other", description: "Unrelated widget calibration.", inputSchema: null },
  ]);
  const out = scoreQuery(index, "read");
  const evidence = Math.min(out.scored[0].score / out.ceiling, 1);
  assert.ok(evidence <= 1, `evidence ${evidence} exceeded full coverage`);
});