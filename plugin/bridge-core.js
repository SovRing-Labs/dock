// bridge-core.js — the whole behaviour of the dock-bridge opencode plugin, in
// plain ESM with zero dependencies, so it can be executed and MEASURED by node
// instead of only by a TypeScript runtime the fleet does not have.
//
// The .ts wrapper at ~/.config/opencode/plugins/dock-bridge.ts does nothing but
// register these hooks. All logic lives here, beside dock, importing dock's own
// selection core — a second copy of the ranking logic is a second opinion about
// what is relevant, and the model would be served whichever one it happened to
// reach.
//
// Measured limit (2026-10-05, on this fleet's live 20 tools):
//   names 117 tok | descriptions 805 tok (33%) | schemas 1,547 tok (63%)
// opencode's `tool.definition` hook fires AFTER the tool list is built and hands
// us a mutable {description, parameters, jsonSchema}. It can rewrite a tool. It
// cannot remove one. So the surface cannot be made constant the way dockd makes
// it constant; it can only be made cheaper per entry.

import { buildIndex, search } from "../src/select.js";

// Collapsing a schema to an opaque object is where the money is (63% of the tax)
// and the only unproven risk: a mutated schema might change how a real call is
// validated. Opt-in, never default.
const OPAQUE = { type: "object", properties: {}, additionalProperties: true };

/**
 * Strip `description` from every level of a schema, keeping names, types, enums,
 * `required` and nesting exactly as they were.
 *
 * This is the middle mode, and it exists because measurement said so. Dropping
 * whole descriptions saved 0% — opencode's MCP tool descriptions are already
 * single sentences, so there was nothing to remove. The bulk of the schema cost
 * is prose living INSIDE property definitions: 425 of 1,547 tokens, 36% of it.
 *
 * What a model needs in order to call correctly is the property names and their
 * types. The prose is documentation. Removing it leaves a schema that is
 * structurally identical and still callable, which is a materially different
 * risk from replacing the schema with `{}`.
 *
 * Note the shape of the problem this exposed: one tool,
 * sovereign-kernel_fleet_exec, carries 844 of the 1,547 schema tokens. Its
 * `operations` union enumerates the whole fleet-exec surface. Flattening that
 * one tool's documentation is worth more than flattening every other tool.
 */
export function stripSchemaDescriptions(schema) {
  if (Array.isArray(schema)) return schema.map(stripSchemaDescriptions);
  if (!schema || typeof schema !== "object") return schema;
  const out = {};
  for (const [k, v] of Object.entries(schema)) {
    if (k === "description") continue;
    out[k] = stripSchemaDescriptions(v);
  }
  return out;
}

export const MODES = ["off", "safe", "thin"];

/** First sentence only — enough to recognise a tool, short enough to be cheap. */
export function compactDescription(description, limit = 160) {
  const text = String(description ?? "").trim();
  if (!text) return text;
  const stop = text.search(/[.!?](\s|$)/);
  const first = stop > 0 ? text.slice(0, stop + 1) : text;
  return first.length <= limit ? first : `${text.slice(0, limit - 1).trimEnd()}…`;
}

export function makeBridge({ mode = "safe", protectedPrefix = "dock_" } = {}) {
  if (!MODES.includes(mode)) throw new Error(`dock-bridge: unknown mode ${mode}`);
  const thin = mode === "thin";
  const catalog = new Map(); // toolID -> { qname, server, tool, description, inputSchema }
  let index = null;
  let dirty = true;

  function remember(toolID, description, schema) {
    const cut = String(toolID).indexOf("_");
    catalog.set(toolID, {
      qname: String(toolID),
      server: cut > 0 ? toolID.slice(0, cut) : "",
      tool: cut > 0 ? toolID.slice(cut + 1) : String(toolID),
      description: String(description ?? ""),
      inputSchema: schema ?? null,
    });
    dirty = true;
  }

  function current() {
    if (!index || dirty) {
      index = buildIndex([...catalog.values()]);
      dirty = false;
    }
    return index;
  }

  /**
   * The hook itself. Mutates `output` in place, exactly as opencode expects.
   *
   * The catalog is captured from the ORIGINAL definition before any compaction:
   * a search result must return the schema the tool really accepts, not the thin
   * version the model was shown.
   */
  async function toolDefinition(input, output) {
    const toolID = String(input?.toolID ?? "");
    if (!toolID) return;
    if (!catalog.has(toolID)) {
      remember(toolID, output.description, output.jsonSchema ?? output.parameters);
    }

    // Never thin dock's own search tool. It is the only way back to the full
    // definitions; thinning the escape hatch is how a model gets stranded.
    if (protectedPrefix && toolID.startsWith(protectedPrefix)) return;

    output.description = compactDescription(output.description);
    if (thin) {
      output.jsonSchema = OPAQUE;
      output.parameters = undefined;
      output.description = `${output.description} (arguments hidden by dock-bridge; call dock_find_tool for the schema)`;
    } else if (mode === "safe") {
      // Structurally faithful: names, types, enums and required survive intact,
      // only the prose goes. Properties stay callable.
      output.jsonSchema = stripSchemaDescriptions(output.jsonSchema);
      output.parameters = undefined;
    }
  }

  /** The exposed search tool's body. Returns a string, like an MCP tool result. */
  function findTool(args) {
    const query = String(args?.query ?? "");
    if (!query.trim()) return "Provide a query describing what you want to do.";
    if (!catalog.size) return "dock-bridge has not seen any tool definitions yet.";

    const out = search(current(), query);
    if (out.abstained) {
      // The refusal is the product. Plainly stated, not dressed up as results.
      return JSON.stringify({ abstained: true, reason: out.reason, catalogSize: catalog.size }, null, 2);
    }
    return JSON.stringify(
      {
        abstained: false,
        ambiguous: out.ambiguous,
        confidence: out.confidence,
        note: out.note,
        results: out.results.map((r) => ({
          tool: r.qname,
          description: r.description,
          inputSchema: r.inputSchema,
        })),
      },
      null,
      2
    );
  }

  return {
    toolDefinition,
    findTool,
    thin,
    mode,
    catalog,
    stats: () => ({ size: catalog.size, mode }),
  };
}