> **Status: under development — pre-alpha.** Interfaces, numbers and file layout can change without notice.

# dock — status

Last checked: 2026-10-16, Linux laptop (Intel i5-8365U, 8 threads), on a clean copy of this repo. 5 of 7 suite tests work today; 6 of 7 can run without special hardware. Each line below names its test id in `suite.json` and the evidence file it rests on.
Quick test `npm test`: PASS (`# fail 0`, fresh copy, empty HOME).


## Works today

- **D1** Unit and gate suite: 31 tests, 30 pass + 1 documented skip on Node 18 — PASS 2026-10-16 (`# skipped 1`); evidence: `test/results/npm-test.2026-10-10.txt`, `test/GATES.md`.
- **D2** Constant-surface gate: 30 upstream tools behind 2 exposed, 205 tokens — PASS 2026-10-16 (`# GATE PASS  30 upstream tools reachable -> 2 exposed, 205 tok (naive enumeration would be 3339 tok)`); evidence: `test/results/npm-test.2026-10-10.txt`, `test/GATES.md`.
- **D3** Abstention, ambiguity flag and failure isolation tests pass (saved log) — PASS 2026-10-16 (`ok 20 - a dead upstream is reported, not crashed through`); evidence: `test/results/npm-test.2026-10-10.txt`.
- **D4** Stage-2 selection A/B: morphology recall 3/5 -> 5/5, no leakage — PASS 2026-10-16 (`PASS  baseline held (+0), morph/synonym recall +2 (3->5/5), no new leakage (0/5).`); evidence: `test/results/stage2-bench.2026-10-10.txt`, `test/harness/fixtures/live-catalog-2026-10-05.json`.
- **D5** dock-bridge plugin payload: safe -25.4 %, thin -41.1 % (thin off by default) — PASS 2026-10-16 (`PASS  safe mode -25.4%, thin mode -41.1%,`); evidence: `test/results/bridge-bench.2026-10-10.txt`, `test/harness/fixtures/live-catalog-2026-10-05.json`.

## Not yet tested

- **D7** dock-bridge loads and registers hooks (needs Node >= 22) — external: needs something the test laptop does not have; needs: node >= 22

## Known failures and honest negatives

- **D6** Honest negative: provider code mode is an empty surface for a tools-only fleet. Not re-run for the repo release; depends on the opencode version and a tiktoken install, so it is not run here. Whether a resource-publishing fleet would make code mode a better choice is stated by the disclosure as a different case. Recorded and re-checked 2026-10-16 (PASS); evidence: `TECHNICAL-DISCLOSURE.md`, `test/harness/codemode-tokens.py`
- The dock-bridge plugin needs Node >= 22 (D7).

## Corrections

- No corrections touch this repo.

## How to re-check

- One file, any python3 >= 3.8: download [`sovring-suite.pyz`](https://github.com/SovRing-Labs/SovRing/releases/latest/download/sovring-suite.pyz), then `python3 sovring-suite.pyz --run dock` (headless) or `python3 sovring-suite.pyz` (local page on 127.0.0.1).
- From this checkout: `bash install.sh` (checks python, prepares a venv, runs the suite headless, then opens the page; `--no-gui` to skip the page).
- Quick test only: `node --test test/*.test.js`.

## Defensive publication

- `TECHNICAL-DISCLOSURE.md` — on public GitHub since 2026-10-10
- DOI: [10.5281/zenodo.23282779](https://doi.org/10.5281/zenodo.23282779) (Zenodo, see `CITATION.cff`)
- Licence: Apache-2.0 (LICENSE, LICENSING.md)
