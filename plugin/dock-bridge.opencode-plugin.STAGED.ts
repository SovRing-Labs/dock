import type { Plugin } from "@opencode-ai/plugin";

// dock-bridge — an in-process dock for this fleet's own seats.
//
// dock (projects/dock) fronts N MCP servers behind two meta-tools. As an MCP
// server that costs a process and a stdio round trip per call. This plugin is the
// same idea with the round trip removed: it captures the real tool definitions
// opencode is already sending to the model, indexes them with dock's OWN
// selection core, and exposes one search tool so a model can find the right tool
// without reasoning across twenty schemas every turn.
//
// ALL LOGIC LIVES IN projects/dock/plugin/bridge-core.js. This file only
// registers it. That split is deliberate: a second copy of the selection logic is
// a second opinion about what is relevant, and the model gets served whichever
// one it happened to reach. It also means the behaviour is executable by node and
// covered by `npm test`, which a .ts file could not be on this fleet (no bun,
// no tsx, no ts-node).
//
// MEASURED, NOT ASSUMED (2026-10-05, this fleet's live 20 tools, see
// test/harness/bridge-bench.mjs):
//
//   baseline payload ......................... 9185 bytes
//   mode=off   compact tool descriptions ..... 9185 bytes   0.0%   <- no-op
//   mode=safe  strip schema prose ............ 6856 bytes  -25.4%   <- DEFAULT
//   mode=thin  opaque schemas ................. 5414 bytes  -41.1%
//
// mode=off saving nothing is the finding that shaped this file: opencode's MCP
// tool descriptions are already single sentences, so there is no prose to trim
// at the top level. The cost lives inside the schemas.
//
// THE LIMIT, STATED PLAINLY. opencode fires `tool.definition` AFTER the tool list
// is built, with a mutable {description, parameters, jsonSchema}. It can REWRITE
// a tool; it cannot REMOVE one. So this plugin cannot make the context cost
// constant in the way dockd makes it constant — dockd measures 205 tok by
// deleting 19 tools' worth of schemas, and deleting is the whole trick. At
// -25.4% this is a complement to dockd, not a substitute for it.
//
// mode=thin defaults OFF because whether a mutated schema survives real call
// validation is unproven in a live session. mode=safe is default because it keeps
// every property name, type, enum and `required` — it removes documentation, not
// structure, so a call built from it is still structurally valid.
//
// STAGED, NOT CUT OVER. This plugin is deliberately NOT registered in
// opencode.jsonc. It is not loaded by any seat. Adding it to the live config
// affects every running agent, and plugin config is a commander grey-zone
// decision, not a dev-seat one.
//
// Env: DOCK_BRIDGE_MODE = off | safe | thin   (default safe)
//      DOCK_BRIDGE_THIN_SCHEMA=1              (legacy alias for mode=thin)

import { makeBridge, MODES } from "./bridge-core.js";

const MODE = process.env.DOCK_BRIDGE_THIN_SCHEMA === "1" ? "thin" : process.env.DOCK_BRIDGE_MODE ?? "safe";

if (!MODES.includes(MODE)) {
  // Loud, because a typo must not silently become "safe" and surprise someone
  // later with a payload shape they never asked for.
  console.error(`[dock-bridge] DOCK_BRIDGE_MODE=${MODE} is not one of ${MODES.join(", ")}; using "safe".`);
}

const bridge = makeBridge({ mode: MODES.includes(MODE) ? MODE : "safe" });

export default (async () => {
  return {
    "tool.definition": async (input: Record<string, unknown>, output: Record<string, unknown>) => {
      await bridge.toolDefinition(input, output);
    },

    tool: {
      dock_find_tool: {
        description:
          "Search every tool available in this session by what you want to DO, and get " +
          "back the full input schema of the best matches. Prefer this over reading " +
          "every tool definition. Returns abstained:true when nothing relevant exists — " +
          "that is a real answer, not a failure, so do not retry it with looser wording.",
        args: {
          query: { type: "string", description: "What you want to do, in plain language." },
        },
        async execute(args: Record<string, unknown>) {
          return bridge.findTool(args);
        },
      },
    },
  } satisfies Plugin;
});