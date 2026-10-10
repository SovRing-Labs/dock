# dock — Provenance

**Licence:** Apache-2.0 (`LICENSE`, `LICENSING.md`). **Disclosure:** published as dated prior art (`TECHNICAL-DISCLOSURE.md`); no patents filed.

## How this code was written
Written by Juan Carlos De Santiago with the Sovereign Raptor fleet (AI-assisted), from the MCP and JSON-RPC specifications and published
method descriptions; no third-party source file was copied or adapted. Zero runtime dependencies beyond Node.

## Ideas this builds on (cited, not copied)
| Idea | Source |
|---|---|
| A meta-tool front for many tool servers | Teradata progressive MCP, MuleSoft Omni Gateway, OpenAI `tool_search`, MCP proposal #1923 (the shape, observed) |
| Ranking | Okapi BM25 (Robertson and Zaragoza, 2009) |
| Suffix stripping | Porter, 1980 |
| Protocols | JSON-RPC 2.0; Model Context Protocol |

Ours: the abstention contract (evidence ceiling, ratio confidence, ties returned as ambiguous), the constant-surface gate, the guarded stemmer
and synonym classes, `dock-bridge`.

## Checks to run on the export tree (before release)
Re-run the gates and save their output under `test/results/`; ScanCode with snippet matching and gitleaks.
