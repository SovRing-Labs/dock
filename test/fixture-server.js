// A minimal upstream MCP server used to test dock. It is NOT part of the
// release — it stands in for a third-party server so the gate test can dock
// several of them and prove the client-facing surface does not grow.
//
// Exposes a configurable number of tools so we can watch the catalog scale
// while dock's exposed surface stays at 2.

const N = Number(process.env.FIXTURE_TOOLS ?? 3);
const PREFIX = process.env.FIXTURE_PREFIX ?? "fx";

const CAPABILITIES = process.env.FIXTURE_CAPABILITIES?.split(",").filter(Boolean) ?? [
  "alpha",
  "beta",
  "gamma",
  "delta",
];

const tools = [];
for (let i = 0; i < N; i++) {
  const cap = CAPABILITIES[i % CAPABILITIES.length];
  tools.push({
    name: `${PREFIX}_op${i}`,
    description:
      `Fixture tool ${i} on capability '${cap}'. ` +
      `Use for ${cap} work in the dock gate test. ` +
      `This description is deliberately wordy so it costs real tokens when enumerated.`,
    inputSchema: {
      type: "object",
      properties: {
        target: { type: "string", description: "What to act on." },
        note: { type: "string", description: "Optional note, long enough to be realistic." },
      },
      required: ["target"],
    },
  });
}

let buf = "";
process.stdin.setEncoding("utf8");
process.stdin.on("data", (chunk) => {
  buf += chunk;
  let nl;
  while ((nl = buf.indexOf("\n")) >= 0) {
    const line = buf.slice(0, nl).trim();
    buf = buf.slice(nl + 1);
    if (!line) continue;
    let msg;
    try {
      msg = JSON.parse(line);
    } catch {
      continue;
    }
    handle(msg);
  }
});

function reply(id, result) {
  process.stdout.write(JSON.stringify({ jsonrpc: "2.0", id, result }) + "\n");
}

function error(id, code, message) {
  process.stdout.write(JSON.stringify({ jsonrpc: "2.0", id, error: { code, message } }) + "\n");
}

async function handle(msg) {
  const { id, method, params } = msg;
  if (id === undefined) return; // notification

  switch (method) {
    case "initialize":
      return reply(id, {
        protocolVersion: params?.protocolVersion ?? "2025-06-18",
        capabilities: { tools: {} },
        serverInfo: { name: `${PREFIX}-fixture`, version: "1.0.0" },
      });

    case "ping":
      return reply(id, {});

    case "tools/list":
      return reply(id, { tools });

    case "tools/call": {
      const name = params?.name;
      if (!tools.some((t) => t.name === name)) {
        return error(id, -32602, `unknown tool ${name}`);
      }
      return reply(id, {
        content: [
          {
            type: "text",
            text: `${name} ran on ${PREFIX} with ${JSON.stringify(params?.arguments ?? {})}`,
          },
        ],
      });
    }

    default:
      return error(id, -32601, `method not found: ${method}`);
  }
}