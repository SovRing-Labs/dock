# AGENTS.md — dock

For coding assistants (and people) setting this repository up. Plain steps; every command runs from the repo root.

## What it is
One MCP server for any number of MCP servers. Clients pay a constant context cost no matter how many are docked. Dock ten upstream servers. Your model still sees two tools.

## Install and check (3 commands)
```bash
git clone --depth 1 https://github.com/SovRing-Labs/dock && cd dock
# nothing to install beyond: node>=18
npm test   # expect: # fail 0
```
Needs: node>=18.
Measured: 18.6s on a fresh clone (Intel i5-8365U laptop, 2026-10-16, exit 0).
Note: package.json asks for Node 22+; the test suite also passed on Node 18.19 (census 2026-10-16).

## What the tests mean
`suite.json` lists every claim this repository makes with its verify command, the expected output, what passing means, how the number was obtained and how to use it in your own work (being written). `STATUS.md` says what works today, what is not yet tested and the known failures; the umbrella's `STATUS.md` has one row per repository.

## Where the evidence is
- `DOSSIER.md` — history, metrics and limits
- `TECHNICAL-DISCLOSURE.md` — the method, as dated prior art
- `CITATION.cff` — DOI 10.5281/zenodo.23282779

## Honest limits (from DOSSIER.md)
Lexical search only; no semantic matching. Not measured: catalogs above 30 tools, `search_tools` latency, clients other than opencode.

## Licence
Apache-2.0.

## Guided setup through MCP
The SovRing umbrella ships an MCP server that explains, checks readiness, clones and runs these tests: https://github.com/SovRing-Labs/SovRing (README → "Paste this to your assistant"). Zero-install docs endpoint: https://gitmcp.io/SovRing-Labs/dock
