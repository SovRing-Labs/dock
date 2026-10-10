# dock changelog

## 0.1.0 (2026-10-10)
First public release. dock is one MCP server for any number of MCP servers: the client sees two tools (`search_tools`,
`call_tool`) whatever the upstream count. Tool search abstains (`abstained: true`) instead of returning a least-bad top-k,
and flags ties (`ambiguous: true`). Stage 2 selection: BM25 + conservative stemmer + synonym classes. Zero runtime
dependencies; Node 22+. Licence: Apache-2.0. Technical Disclosure (prior art) included.
- Gate: 30 upstream tools reachable through 2 exposed, 205 tokens vs 3,339 naive; surface identical for 1 and 4 upstreams.
- Stage 2 A/B on a pinned 20-tool catalog: recall 8/8 → 8/8, morphology/synonym 3/5 → 5/5, abstention leak 0/5 → 0/5.
- `dock-bridge` (opencode plugin): −25.4% payload in `safe` mode; complement to `dockd`, not a substitute.
- Tests: 31 (`npm test`, Node 22).
