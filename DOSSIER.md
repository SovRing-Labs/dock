# dock — Dossier

*History, specification, metrics, tests and limits. Companion to `TECHNICAL-DISCLOSURE.md` and `README.md`.*

## What it is

An MCP server that sits in front of any number of other MCP servers and always shows the model exactly two tools: `search_tools`
and `call_tool`. A client's cost stays the same whether one server or forty are behind it, and the search **abstains** when nothing
fits instead of handing the model the least bad tool. In the stack it is the **switchboard** between agents and their tools. (Not the
"dock" of the ARC-reactor layout, which is a different thing in the author's vocabulary.) Stage (essay 07): tool → protocol.

## Creation history

| Date (2026) | Milestone |
|---|---|
| 10-05 | Built from a complaint the author's own fleet audit put a number on: about 10,000 tokens per turn spent listing 52 tools across three servers (a private script; not reproduced here) |
| 10-05 | Constant surface gated: 30 upstream tools reachable, 2 exposed, client bytes identical for 1 and 4 upstreams; licence decided Apache-2.0 |
| 10-05 | Abstention: relevance as a share of the best score this query could reach in this catalog; a design correction — ties return both tools marked ambiguous instead of abstaining |
| 10-05 | Stage 2: a guarded stemmer and synonym classes at query time, A/B on a pinned live catalog; `dock-bridge` for opencode |
| 10-05 | Negative result: a provider "code mode" is an empty surface for a tools-only fleet, not a substitute |
| 10-09 | Apache-2.0 confirmed; first public release prepared |

## Specification (summary)

* Upstreams spawned over stdio; tools addressed `server__tool`, split on the first `__`; an unknown tool is a tool-level error, a dead
  upstream is reported as disconnected.
* `search_tools`: Okapi BM25 over names and descriptions after stopword removal; abstains below 0.2 of the evidence ceiling;
  confidence `1 − runner_up / top`.
* `dock-bridge`: shortens tool definitions in opencode while the full schema stays in the search catalog (modes off / safe / thin).

## Metrics (from the project's gate document; to be re-run and saved under `test/results/` at release)

| Property | Result |
|---|---|
| Client tax, 30 tools behind dock | 205 tokens against 3,339 for naive listing |
| Stage 2 A/B, pinned 20-tool catalog | baseline 8/8 → 8/8; morphology and synonyms 3/5 → 5/5; nonsense leakage 0/5 → 0/5 |
| `dock-bridge` definition bytes | safe −25.4 %, thin −41.1 % |

## Tests

`npm test` (`test/gate.test.js` and the harnesses in `test/harness/`); the bridge test runs on Node ≥ 22.

## Limits

* Lexical search only; no semantic matching.
* Not measured: catalogs above 30 tools, `search_tools` latency, clients other than opencode.

## Lineage and credits

The meta-tool shape (Teradata, MuleSoft, OpenAI `tool_search`, MCP proposal #1923); Okapi BM25 (Robertson and Zaragoza, 2009); suffix
stripping (Porter, 1980); JSON-RPC 2.0 and MCP. `PROVENANCE.md`. Updates: weekly, recorded here with dates.
