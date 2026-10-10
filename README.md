# dock

**One MCP server for any number of MCP servers.** Clients pay a constant context cost no matter how many are docked.

```jsonc
// opencode.jsonc (or claude_desktop_config.json, etc.)
{ "mcp": { "dock": { "type": "local", "command": ["dockd", "--config", "./dock.json"], "enabled": true } } }
```

Dock ten upstream servers. Your model still sees **two** tools.

## The problem
Every MCP client asks every connected server for its full tool list, on every turn. The cost is additive and it lands
before the model reads a word of the task. On the author's own setup, three servers (32, 12 and 8 tools) cost 10,515
tokens per turn, 73.8% of it from one server. *(Measured with a private audit script that is not part of this repository;
the numbers you can reproduce yourself are the ones under "Measured" below.)*

Several vendors converged on the same mitigation, a meta-tool that searches for tools instead of listing them (Teradata
`POST /mcp/progressive`, MuleSoft Omni Gateway `search_tools`, OpenAI `tool_search` with `defer_loading`, MCP spec proposal
#1923). **dock implements that shape.** Where it differs is below.

## What it does
```
  your harness  ──MCP──▶  dock  ──MCP──▶  upstream × N
   (sees 2 tools)         (2 meta-tools)   (unchanged)
```
`dock` is itself an MCP server, so it works with anything that speaks MCP: no new protocol, no client changes. Upstreams
dock unchanged; dock speaks plain MCP to them and keeps no per-client state, so one instance serves every client.

- **`search_tools`** — find tools by intent. Returns matches with a confidence score, or **abstains**.
- **`call_tool`** — invoke one by its qualified `server__tool` name (split on the first `__`).

## Abstention
Keyword search cannot decline: it must return a top-k, so a query with no good match yields a ranked list of the *least
bad* tools, and a model will use one confidently. dock returns `abstained: true` with an empty result set when nothing
is relevant:

```json
{ "results": [], "confidence": 0, "abstained": true,
  "reason": "nothing relevant: best match covers only 6% of the query (min 20%)" }
```
**Ambiguity is flagged, not withheld.** If two tools match equally well, both come back with `ambiguous: true` and a note.

## Measured
`npm test` asserts the whole claim:
```
GATE PASS  30 upstream tools reachable -> 2 exposed, 205 tok
           (naive enumeration would be 3339 tok)
```
Client-facing bytes are asserted identical for 1 upstream and for 4. `npm run bench:offline` reproduces the remaining tables
from a pinned capture of a 20-tool catalog (`test/harness/fixtures/`), with no MCP servers running. Per-test breakdown:
`test/GATES.md`. Full account, including what did not work: `TECHNICAL-DISCLOSURE.md`.

## Install
Node 22+. No runtime dependencies.
```bash
git clone https://github.com/SovRing-Labs/dock && cd dock
npm test               # 31 tests, includes the gate
npm run bench:offline  # token / recall tables, offline
npm link               # puts `dockd` on your PATH
```
`dock.json`:
```json
{ "upstreams": [
  { "name": "filesystem", "command": "npx", "args": ["-y", "@modelcontextprotocol/server-filesystem", "/tmp/workspace"] },
  { "name": "sqlite", "command": "uvx", "args": ["mcp-server-sqlite", "--db-path", "/tmp/workspace/data.db"] } ] }
```
```bash
dockd --config dock.json              # stdio, one local client
dockd --config dock.json --http 8000  # shared by several clients
```

## How selection works (stage 2)
Lexical BM25 over tool names and descriptions, with stopwords removed, a per-query evidence ceiling (`top/ceiling`, not an
absolute floor), ratio-based confidence (`1 − runner_up/top`), a conservative stemmer and synonym equivalence classes
applied at query time only. Abstain when `top/ceiling < 0.2`. Semantic (k-NN) selection is on the roadmap, not the claim.

## Roadmap
- [x] N-in / 2-out surface, proven by the gate test · [x] abstention · [x] upstream failure isolation · [x] zero dependencies
- [x] stage 2 selection (stemmer + synonym classes)
- [x] `dock-bridge`: an in-process plugin for opencode over the same selection code (−25.4% payload in `safe` mode). A
  complement to `dockd`, not a substitute: its hook can rewrite a tool but not remove one.
- [ ] k-NN selection over outcome marks, same abstain contract
- [ ] verifiable receipts on `call_tool` (independent judges)

## Why no dependencies
The wire format is newline-delimited JSON-RPC; `src/rpc.js` is the honest subset we use. Zero transitive dependencies means
no supply chain to audit and a fork you can read in an afternoon.

## Licence
**Apache License 2.0** — see `LICENSE`, and `LICENSING.md` for how this relates to the author's other repositories.
Published as prior art; no patents are filed.

## Dossier

History, specification, metrics, tests and limits: [`DOSSIER.md`](DOSSIER.md). The research record and essays: github.com/SovRing-Labs/omniring-research.
