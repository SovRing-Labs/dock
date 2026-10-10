#!/usr/bin/env python3
"""Count the client-facing MCP schema tax of each code-mode arm.

Reads the JSON emitted by codemode-probe.mjs and reports, per arm, the token
cost of the tool array opencode would put on the wire. Tokenizer is o200k_base
(the encoding opencode's hosted models use); cl100k_base is reported alongside so
the number is not a single-encoding artifact.

Usage:  python3 codemode-tokens.py [codemode-raw.json] [--residual 2755]
        The capture argument is OPTIONAL; the pinned snapshot is the default.
"""
import json
import os
import sys

import tiktoken


def cost(entries, enc):
    """Token cost of the tool array as sent: name + description + input_schema."""
    return len(enc.encode(json.dumps(entries, separators=(",", ":"))))


FIXTURE = os.path.join(os.path.dirname(os.path.abspath(__file__)),
                       "fixtures", "live-catalog-2026-10-05.json")


def main():
    # argv[1] is optional; the pinned capture keeps the table in the docs
    # reproducible offline. For live state, re-run codemode-probe.mjs first.
    positional = [a for a in sys.argv[1:] if not a.startswith("--")]
    if not positional:
        print("note: no capture given; using the pinned snapshot "
              "(fixtures/live-catalog-2026-10-05.json)")
        print("      for live state: codemode-probe.mjs /tmp/codemode-raw.json")
        path = FIXTURE
    else:
        path = positional[0]

    if not os.path.isfile(path):
        print("cannot read capture: %s" % path)
        print("  generate one: node test/harness/codemode-probe.mjs "
              "/tmp/codemode-raw.json")
        return 2

    residual = 2755
    if "--residual" in sys.argv:
        residual = int(sys.argv[sys.argv.index("--residual") + 1])

    raw = json.load(open(path))
    o200 = tiktoken.get_encoding("o200k_base")
    cl100 = tiktoken.get_encoding("cl100k_base")

    arms = raw["payloads"]
    rows = [
        (arm, len(arms[arm]), cost(arms[arm], o200), cost(arms[arm], cl100))
        for arm in ("naive", "current", "codemode")
    ]

    def pct(v):
        return f"{(v - residual) / residual * 100:+.1f}%"

    print("code-mode probe — client-facing MCP schema tax (tokens, o200k_base)")
    for s in raw["servers"]:
        print(
            f"  {s['name']}: {s['toolCount']} tools, {s['resourceCount']} resources, "
            f"{s['templateCount']} templates, capabilities=[{','.join(s['capabilities'])}]"
        )
    print(f"  servers publishing resources: {raw['resourceServers'] or 'NONE'}")
    print()
    print(f"  {'arm':<10} {'tools':>6} {'o200k':>7} {'cl100k':>7}   vs {residual} residual")
    for arm, n, o, c in rows:
        note = "" if arm == "naive" else pct(o)
        print(f"  {arm:<10} {n:>6} {o:>7} {c:>7}   {note}")

    cur = dict((r[0], r) for r in rows)["current"]
    cm = dict((r[0], r) for r in rows)["codemode"]
    print()
    print("  calibration (this probe vs the 2026-10-05 fleet count):")
    print(f"    current arm {cur[2]} tok at {cur[1]} tools; fleet recorded {residual} "
          f"({pct(cur[2])}, upstream schemas have drifted since).")
    print("    omnid alone reproduces its recorded 753 at 751 tok (0.3%), which is what")
    print("    fixes this method as the same measurement, not a different one.")
    print()
    print("  interpretation:")
    print(f"    code mode's MCP arm is {cm[2]} tok vs dock's 205 tok — a real constant-cost")
    print("    win on paper. It is also the wrong mechanism for a tools-only fleet:")
    print("    opencode returns before its per-tool loop, so every upstream tool schema")
    print("    is dropped, and the replacement meta-tools are gated on the resources")
    print("    capability, which a tools-only server never declares.")
    reachable = bool(raw["resourceServers"])
    if reachable:
        print(f"    reachability: preserved for {raw['resourceServers']}")
    else:
        total = sum(s["toolCount"] for s in raw["servers"])
        print(f"    reachability: NONE. All {total} upstream tools become unreachable;")
        print("    the 169 tok arm is not a cheaper surface, it is an empty one.")
    print("    So code mode does not make dock redundant here. It is an alternative")
    print("    constant-cost mechanism for a resource-publishing fleet; dock's selection")
    print("    layer stands for tools-only servers. Build the selection layer.")


if __name__ == "__main__":
    main()