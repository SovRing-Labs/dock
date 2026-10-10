# dock — Technical Disclosure, Part 1 (2026-10-10): constant-surface MCP front, abstaining tool search

Dated prior art. Everything below was built and measured on the author's laptop CPU with Node; harnesses are in `test/` and
`test/harness/` (paths named per item). **Status of evidence:** the tests and the offline benches were re-run on 2026-10-10 and
their output is saved under `test/results/` (`npm-test.2026-10-10.txt`, 31/31 pass; `bridge-bench.2026-10-10.txt`;
`stage2-bench.2026-10-10.txt`). The code-mode probe (§5) needs a live session and `tiktoken` and was not re-run; its numbers
are marked **(not re-run)**. Bars were stated before the harnesses in the project's gate document; a FIELD PREDICTS line is given
where published practice predicts the outcome. Terms are the field's: an "MCP server" exposes tools to a model client; a "meta-tool"
is a tool whose job is to find or call other tools.

Author: Juan Carlos De Santiago, with the Sovereign Raptor fleet (AI-assisted). Dated by the release commit and Zenodo DOI.
Licence: Apache-2.0 (this file included).

## 1. A constant client-facing surface (`src/dockd.js`, `src/rpc.js`)
- **Description.** `dockd` is an MCP server (stdio, or HTTP for several clients) that spawns each configured upstream MCP server over stdio, reads each
  `tools/list`, and exposes exactly two tools whatever N is: `search_tools` and `call_tool`. Upstream tools are addressed
  `server__tool`, split on the **first** `__` (`a__b__c` = server `a`, tool `b__c`). An unknown tool name returns a tool-level
  `isError` result, not a protocol error, so the model can retry. A dead upstream is reported (`disconnected`), never crashed through.
- **FIELD PREDICTS.** Vendors' meta-tool gateways (Teradata progressive MCP, MuleSoft Omni Gateway, OpenAI `tool_search`, MCP
  proposal #1923) predict that listing tools lazily makes client cost independent of server count.
- **G1 (the product gate).** 30 upstream tools reachable → 2 exposed, 205 tokens vs 3,339 for naive enumeration; client-facing
  bytes **identical** for 1 upstream (4 tools) and for 4 upstreams (30 tools); exposed tool count asserted `== 2`; client
  tax asserted `< 1/10` of naive. Harness `test/gate.test.js`; saved result: `test/results/npm-test.2026-10-10.txt` ("GATE PASS … 205 tok (naive enumeration would be 3339 tok)").
- **Negative / guard.** If the two meta-tools were emptied the tax would be 0 for both and equality would hold trivially;
  the `== 2` assertion exists for that reason.

## 2. Abstention (`src/select.js`)
- **Description.** `search_tools` scores tools by Okapi BM25 over names and descriptions, after removing English and MCP stopwords.
  Relevance is the **per-query evidence ceiling**: `top / ceiling`, where the ceiling is the best score this query's
  terms can reach in this catalog (exact definition to be checked against `src/select.js`; scale-free: a term present in every document of a two-document catalog has IDF ≈ 0, so a
  fixed absolute floor would reject a perfect match). Below `0.2` the answer is `abstained: true`, `results: []`, with a reason
  string. Confidence is ratio-based, `1 − runner_up/top` (a difference-based measure reported ~0.5 for a clear query merely
  because a second tool tied). Equal scores return both tools with `ambiguous: true` and a note.
- **FIELD PREDICTS.** Top-k search cannot decline; a model will use the least bad tool.
- **Gates** (`test/gate.test.js`; all pass in `test/results/npm-test.2026-10-10.txt`): noise query `"zzzz qqqq wubblefrotz xyzzy"` → abstains; stopwords-only
  `"the a of"` → abstains (without the stopword list it matched every tool); two identical-description tools → both returned,
  `ambiguous: true`; one clear winner → `confidence > 0.9`, `ambiguous: false`.
- **Design correction (disclosed).** An earlier version abstained on ties. Wrong: two equally good tools are both relevant, and
  withholding them is worse than offering two.

## 3. Stage 2 selection: conservative stemmer + synonym equivalence classes
- **Description.** Applied at query time only. Stemmer guards keep `less` ≠ `les` and leave `analysis`, `status`, `class` intact;
  `-ing` / `-ed` strip only when the remaining stem contains a vowel. Synonym classes are symmetric with transitive closure.
- **G2 (A/B over a pinned live 20-tool catalog, `test/harness/stage2-bench.mjs`, fixture `test/harness/fixtures/live-catalog-2026-10-05.json`,
  result `test/results/stage2-bench.2026-10-10.txt`):** baseline recall 8/8 → 8/8 (no regression); morphology/synonym recall 3/5 → 5/5; abstention leakage on
  nonsense queries 0/5 → 0/5. The bench measures leakage because a recall gain that leaks answers into nonsense queries is not an improvement.
- **Stage 1 limit (disclosed).** Lexical only: `"read"` does not match `"reading"` without the stemmer; no semantic matching.

## 4. `dock-bridge`: an in-process fast path (`plugin/bridge-core.js`)
- **Description.** A plugin for opencode that shortens tool definitions through the `tool.definition` hook while the full schema
  stays in the search catalog. Modes `off` (no-op), `safe` (default), `thin`.
- **G3 (`test/harness/bridge-bench.mjs`, result `test/results/bridge-bench.2026-10-10.txt`):** baseline 9,185 B; `off` 9,185 B (0.0%); `safe` 6,856 B (−25.4%);
  `thin` 5,414 B (−41.1%, off by default). The bench checks that the search catalog still holds the full schema after compaction.
- **Limit (disclosed).** The hook fires after the tool list is built and can rewrite a tool but not remove one, so it cannot reach
  `dockd`'s constant 2-tool surface (205 tok). A bug found and fixed: `export default (async () => {…})()` makes the default a
  resolved Promise and the host registers **zero hooks silently**; a test pins the fix (it runs on Node ≥ 22 only; below that it skips).

## 5. Negative result: provider "code mode" does not replace selection
`test/harness/codemode-probe.mjs` + `codemode-tokens.py` (**not re-run**): `current` 20 tools / 2,653 tokens vs `codemode`
3 tools / 169 tokens (−93.9%). The 169-token arm is an **empty surface**: it drops all 20 schemas and its meta-tools are gated on
the MCP `resources` capability, which both servers in the test declare as `[]`. For a tools-only fleet it is not a substitute for
dock's selection layer. Counted under two encodings (`o200k_base`, `cl100k_base`) so the table is not a single-encoding artifact.

## 6. Open / unmeasured
k-NN selection over outcome marks with the same abstain contract (designed only); verifiable receipts on `call_tool` by
independent judges (designed only); behaviour with real-world catalogs larger than 30 tools; latency of `search_tools`; any
measurement on a client other than opencode; the author's own fleet audit (52 tools / 10,515 tokens per turn across three servers)
— produced by a private script, **unsupported** in this repository.

## 7. Provenance (borrowed / ours)
Borrowed: the meta-tool *shape* (Teradata, MuleSoft, OpenAI `tool_search`, MCP #1923); Okapi BM25 (Robertson and Zaragoza,
2009); the idea of suffix stripping (Porter, 1980); JSON-RPC 2.0 and MCP. Ours: the abstention contract, evidence ceiling and
ratio confidence, the constant-surface gate, the guarded stemmer and synonym classes, `dock-bridge`. Clean-room statement: see
`PROVENANCE.md` (two items still to be confirmed against the source).
