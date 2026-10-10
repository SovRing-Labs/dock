---
title: Gate tests
updated: 2026-10-05
weaver_hash: 857cda34c11e5c6104b4602855eb7fae4c3928227022df4643941340a69dbeba
weaver_imported: 2026-10-09T22:22:08+00:00
---
# Gate tests

Every claim dock makes that could be false, and the test that makes it true.
Run them all:

```bash
npm test
```

Test count is deliberately small. Each test earns its place by pinning a claim
that would otherwise rot silently.

**31 tests across three files** (was 11 in one):

| file | tests | pins |
|---|---|---|
| `test/gate.test.js` | 11 | the product gate, MCP conformance, abstention, ambiguity, call routing, failure isolation |
| `test/selection.test.js` | 12 | stage-2 stemming and synonym classes, incl. the guards that stop them fusing unrelated tools |
| `test/bridge.test.js` | 8 | dock-bridge mode integrity, and that the registered plugin actually loads |

### One test skips on old Node — read this before trusting a green suite

`the registered dock-bridge.ts loads and wires up` returns early below Node 22
because it needs `--experimental-strip-types`. So:

| runtime | result |
|---|---|
| Node 18 (default `PATH` here) | 30 pass / **1 skip** / 0 fail |
| Node >= 22 | **31 pass / 0 skip** / 0 fail |

`package.json` now declares `"engines": { "node": ">=22" }` so this surfaces as an
install-time warning rather than a silent skip. Run `npm run test:full` on Node 22
for the complete suite. The skipped test is the one guarding the worst available
failure: a plugin whose `default` export is a resolved Promise registers **zero
hooks silently** while the repo still claims a 25% saving.

---

## The product gate (this is the one that matters)

### `gate: client-facing surface is constant regardless of upstream count`

**Claim:** dock decouples client context cost from server count.

**Assertion:**

1. Dock 1 upstream (4 tools) and dock 4 upstreams (30 tools).
2. Compute client-facing token tax of `dock.exposedTools` for each.
3. **They must be exactly equal.**
4. `exposedTools.length === 2`.
5. Client tax must be **< 1/10** of what naive enumeration of all 30 upstream
   tools would cost.

Expected output:

```
GATE PASS  30 upstream tools reachable -> 2 exposed, 205 tok
           (naive enumeration would be 3339 tok)
```

Why it is shaped this way: assertion 3 is the falsifiable core. Everything else
in this repo is quality; this is correctness. If someone shrinks the two
meta-tools to nothing to make this pass, they have deleted the product — which
is why the test also asserts `exposedTools.length === 2`.

**How it could pass wrongly:** if `exposedTools` accidentally became `[]`, tax
would be 0 for both and assertion 3 would hold trivially. Assertion 4 is the
guard against that.

---

## Protocol conformance

### `initialize and tools/list speak real MCP`

Drives `initialize` and `tools/list` on a live dock and asserts a real
`serverInfo`, a `tools` capability, and exactly `["call_tool", "search_tools"]`
sorted. This is what makes "works with any MCP client" a checked claim rather
than an aspiration.

---

## Selection behaviour

### `search_tools finds an upstream tool by intent`

A query with real vocabulary overlap returns hits, includes the expected server,
and does **not** abstain.

The test uses overlapping vocabulary on purpose. Stage-1 selection is lexical
BM25 with no stemming, so `"reading"` matches `"reading"` but `"read"` would not
match `"reading"` by stem. This pins the **floor**, not the ceiling.

### `ABSTENTION: nothing relevant returns empty rather than top-k`

A query of pure noise (`"zzzz qqqq wubblefrotz xyzzy"`) must return
`results: []`, `abstained: true`, and `_meta.abstained === true`.

This is the reason dock exists. Every incumbent meta-tool is top-k search and must
return something; returning nothing correctly is the differentiator.

### `ABSTENTION: stopwords alone do not manufacture false confidence`

**Regression test.** A query of only stopwords (`"the a of"`) must abstain.

Without the stopword list, `"the a of"` matched every tool in the catalog,
produced a full ranked list, and would have satisfied "results exist" — the exact
opposite of the intended behaviour. Stopwords should be invisible, not decisive.

### `AMBIGUITY is flagged, not withheld`

**Regression test, and a design correction.** Two tools with identical
descriptions both match. Assert: `abstained === false`, `ambiguous === true`,
`results.length === 2`, and a `note` is present.

An earlier version abstained on ties. That was wrong: two equally good tools are
*both relevant*, and that is information the model can act on. Withholding
genuinely relevant tools is a worse failure than offering two when one was
wanted. Ambiguity is now flagged, not hidden.

### `a clear query is confident and unambiguous`

The positive control for the flag above: one clear winner yields
`confidence > 0.9`, `ambiguous: false`, correct top hit.

---

## Call path

### `call_tool round-trips to the right upstream`

`beta__beta_op0` must execute on the `beta` upstream and echo its arguments
back. Proves routing does not cross-contaminate between servers — the failure
mode when `server__tool` splitting is wrong.

### `call_tool reports a clear error for an unknown server`

`nosuch__op0` → `isError: true` and a message naming `nosuch`. Error clarity is
the difference between a model self-correcting and getting stuck.

### `call_tool rejects a malformed unqualified name`

A bare `bare_name` with no `server__` prefix → `isError: true`,
`malformed tool name`. Prevents silently guessing a server.

### `split/join round-trip on qualified names`

Property test on `server__tool` construction and parsing, including the
adversarial case `a__b__c` (splits to server `a`, tool `b__c` — split on the
**first** separator, not the last). Also asserts a no-separator name returns
`null` rather than throwing.

### `dock exposes nothing beyond the two meta-tools`

Calling an upstream tool name directly on dock must return a tool-level
`isError` result, not a protocol-level error. Per MCP, an unknown tool name is
something the model should see and retry on — a protocol error would fail the
whole conversation at the transport instead.

---

## Failure isolation

### `a dead upstream is reported, not crashed through`

Spawns a nonexistent binary. Asserts `connect()` rejects, `upstream.alive ===
false`, and that a `call_tool` against it returns `isError: true` with
`disconnected` in the message — rather than throwing and taking the whole dock
down. One broken upstream must not cost the user the other nine.

---

## Harnesses

These are the probes built alongside the tests. They are not part of `npm test`
because they print for eyeballing rather than asserting; keep them, they are how
a scoring change gets diagnosed.

| file | what it does |
|---|---|
| `test/fixture-server.js` | configurable upstream MCP server. `FIXTURE_TOOLS` (tool count), `FIXTURE_PREFIX` (name prefix), `FIXTURE_CAPABILITIES` (vocabulary). Stands in for a third-party server so the gate can scale the catalog. |
| `test/harness/stdio-probe.mjs` | drives `dockd` over **real stdio** the way a client does, with a `--config`. Reports initialize, tools/list, client tax, one search, one abstain. |
| `test/harness/probe-config.json` | 2 upstreams (`files`, `net`) with different vocabularies, so a search can be checked for hitting the right server. |
| `test/harness/selection-probe.mjs` | prints search outcomes for a spread of queries against a fixed 6-tool catalog — the quick way to see what a scoring change did. |
| `test/harness/codemode-probe.mjs` | enumerates the **live** `tools/list` of every real MCP server in `codemode-config.json` and captures the three arms (`naive` / `current` / `codemode`). Writes the raw capture the three benches below consume. |
| `test/harness/codemode-tokens.py` | tokenises that capture under `o200k_base` **and** `cl100k_base`, so the table is not a single-encoding artifact. Prints the calibration against the fleet's recorded 2,755 tok/turn. |
| `test/harness/stage2-bench.mjs` | **stage 1 vs stage 2 A/B** over the real catalog, measuring both recall and abstention leakage, because a change that lifts recall by leaking answers into nonsense queries is not an improvement. |
| `test/harness/bridge-bench.mjs` | drives the **real** `tool.definition` hook over the real catalog in all three modes, and checks the thing a byte count cannot: that the search catalog still holds the **full** schema after compaction. |
| `test/harness/codemode-config.json` | the live servers to enumerate, plus the code-mode resource meta-tool taxonomy read out of the shipped opencode binary. |
| `test/harness/fixtures/live-catalog-2026-10-05.json` | **pinned** capture of the live 20-tool catalog. The three benches default to this, so every number in the docs is reproducible offline and does not drift when an upstream schema changes. |

```bash
# offline + deterministic, against the pinned capture:
npm run bench:offline

# re-capture the current catalog and measure that instead:
npm run bench:live

# eyeball
npm run probe:stdio        # real end-to-end over stdio
npm run probe:selection    # scoring eyeball
```

Run from the `dock/` root; paths are repo-relative. The three benches take an
**optional** capture path — bare invocation uses the pinned fixture and prints a
note saying so. (They used to require the argument and died with an opaque
`ERR_INVALID_ARG_TYPE` stack trace; a bare invocation is the obvious first thing
anyone tries.)

---

## Fleet context

dock's numbers come from `bin/mcp-audit`, which measures live stdio JSON-RPC
`tools/list` payloads for every server in `opencode.jsonc` at ~4 bytes/token.

| server | tools | tok/turn |
|---|---|---|
| lightpanda | 32 | 7,760 |
| sovereign-kernel | 12 | 2,002 |
| omnid | 8 | 753 |
| **total** | **52** | **10,515** |

Lightpanda was 73.8% of that bill and was removed from the MCP config
(2026-10-05), leaving 20 tools / 2,755 tokens — below the ~10k break-even where
deferred loading starts paying for itself.

If you change a tool schema anywhere in the fleet, re-run `bin/mcp-audit` before
and after. The tax is a number, and the number is re-measurable in ~2 seconds.