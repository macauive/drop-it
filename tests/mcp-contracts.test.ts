import { test } from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { createMcpServer } from "../server/mcp.js";
import type { Library } from "../server/library.js";
import type { Config } from "../server/config.js";
import { AppError } from "../server/errors.js";
import { mcpOutputSchemas, mcpErrorSchema } from "../shared/mcp-results.js";

const owner = randomUUID(),
  id = randomUUID(),
  sourceId = randomUUID(),
  attachmentId = randomUUID();
const item = {
  id,
  sourceId,
  title: "Synthetic contract sample",
  summary: "Reviewed summary",
  category: "Projects",
  isSaved: false,
  trashedAt: null,
  deleteAfter: null,
  tags: ["test"],
  notes: "Synthetic notes",
  revision: 1,
  createdAt: new Date("2026-10-01T00:00:00.000Z"),
  updatedAt: new Date("2026-10-01T00:00:00.000Z"),
  sourceUrl: "",
  hasImage: false,
  reviewedTranscription: null,
  transcriptionUpdatedAt: null,
  transcriptionProvenance: "original",
};
const source = {
  id: sourceId,
  originalText: "Synthetic original",
  url: "",
  attachmentId,
  createdAt: new Date("2026-10-01T00:00:00.000Z"),
  hasImage: false,
  hasFile: true,
  filename: "synthetic.txt",
  mime: "text/plain",
};
const draft = {
  title: "Synthetic draft",
  summary: "Draft summary",
  category: "Projects",
  tags: [],
  extractedText: "Synthetic original",
  sourceUrl: "",
};
const fixture = () => ({
  search: async () => ({
    items: [item],
    total: 1,
    counts: { "All drops": 1, Saved: 0, Trash: 0 },
    categories: ["Projects"],
    aiAvailable: true,
    aiSearchEnabled: false,
    mode: "keyword",
  }),
  get: async () => ({ item, source }),
  file: async () => ({
    bytes: Buffer.from("Synthetic original"),
    mime: "text/plain",
    filename: "synthetic.txt",
  }),
  save: async () => ({ item, source, replayed: false }),
  update: async () => ({ item, source }),
  delete: async () => ({ trashed: true }),
  restore: async () => ({ item, source }),
  draft: async () => ({ draft }),
  upload: async () => ({ attachmentId, originalText: "Synthetic original" }),
  profile: async (resolvedOwner: string) => ({
    id: resolvedOwner,
    username: "synthetic-reviewer",
  }),
});
async function connect(
  library = fixture(),
  scopes = ["library:read", "library:write"],
) {
  const server = createMcpServer(
    library as unknown as Library,
    {
      origin: "https://synthetic.example.test",
      local: false,
    } as Config,
    "<html>synthetic</html>",
    owner,
    scopes,
  );
  const client = new Client({ name: "contract-test", version: "1" });
  const [ct, st] = InMemoryTransport.createLinkedPair();
  await server.connect(st);
  await client.connect(ct);
  return {
    client,
    close: async () => {
      await client.close();
      await server.close();
    },
  };
}

test("all nine MCP tools publish success schemas and only useful results attach widgets", async () => {
  const { client, close } = await connect();
  try {
    const { tools } = await client.listTools();
    assert.equal(tools.length, 9);
    for (const tool of tools) {
      assert.equal(tool.outputSchema?.type, "object", tool.name);
      assert.equal(tool.outputSchema?.additionalProperties, false, tool.name);
      assert.equal(
        Boolean(tool._meta?.ui),
        !["upload_source", "get_profile"].includes(tool.name),
        tool.name,
      );
    }
    const profile = tools.find((tool) => tool.name === "get_profile")!;
    assert.equal(profile._meta?.["openai/profile"], true);
    assert.deepEqual(profile.outputSchema?.required, ["id"]);
  } finally {
    await close();
  }
});

test("successful tool results validate, serialize DB timestamps and keep source bytes out of model context", async (t) => {
  const { client, close } = await connect();
  t.mock.method(
    globalThis,
    "fetch",
    async () =>
      new Response("Synthetic original", {
        headers: { "content-type": "text/plain", "content-length": "18" },
      }),
  );
  try {
    const calls = [
      {
        name: "search_drops",
        arguments: {
          query: "synthetic",
          view: "Saved",
          category: "Projects",
          limit: 10,
        },
      },
      {
        name: "draft_drop",
        arguments: { source: { originalText: "Synthetic original" } },
      },
      { name: "get_drop", arguments: { id } },
      {
        name: "save_drop",
        arguments: {
          requestId: randomUUID(),
          title: "Synthetic",
          source: { originalText: "Synthetic original" },
        },
      },
      {
        name: "update_drop",
        arguments: { id, revision: 1, notes: "Synthetic notes" },
      },
      { name: "wipe_drop", arguments: { id, revision: 1 } },
      { name: "restore_drop", arguments: { id, revision: 1 } },
      {
        name: "upload_source",
        arguments: {
          file: {
            download_url: "https://files.oaiusercontent.com/synthetic.txt",
            file_id: "synthetic",
            file_name: "synthetic.txt",
            mime_type: "text/plain",
          },
        },
      },
      { name: "get_profile", arguments: {} },
    ] as const;
    for (const call of calls) {
      const result = await client.callTool(call);
      assert.notEqual(
        result.isError,
        true,
        `${call.name}: ${JSON.stringify(result.structuredContent)}`,
      );
      assert.equal(
        mcpOutputSchemas[call.name].safeParse(result.structuredContent).success,
        true,
        call.name,
      );
      assert.equal(
        JSON.stringify(result.structuredContent).includes(
          "data:text/plain;base64",
        ),
        false,
      );
      if (call.name === "get_drop") {
        assert.equal(
          result._meta?.fileData,
          `data:text/plain;base64,${Buffer.from("Synthetic original").toString("base64")}`,
        );
        assert.equal(
          mcpOutputSchemas.get_drop.parse(result.structuredContent).item
            .createdAt,
          "2026-10-01T00:00:00.000Z",
        );
      }
      if (call.name === "search_drops")
        assert.deepEqual(result._meta?.dropIt, {
          tool: "search_drops",
          input: { ...call.arguments, mode: "hybrid", offset: 0 },
        });
      if (call.name === "get_profile")
        assert.deepEqual(result.structuredContent, {
          id: owner,
          nickname: "synthetic-reviewer",
        });
    }
  } finally {
    await close();
  }
});

test("MCP output validation rejects unexpected database fields without leaking them", async () => {
  const lib = fixture();
  lib.get = async () => ({
    item: { ...item, unexpected: "sensitive unexpected field" },
    source,
  });
  const { client, close } = await connect(lib);
  try {
    const result = await client.callTool({
      name: "get_drop",
      arguments: { id },
    });
    assert.equal(result.isError, true);
    assert.equal(
      mcpErrorSchema.parse(result.structuredContent).code,
      "INVALID_RESPONSE",
    );
    assert.equal(
      JSON.stringify(result).includes("sensitive unexpected field"),
      false,
    );
  } finally {
    await close();
  }
});

test("MCP errors preserve only safe duplicate details and scope failures never call profile lookup", async () => {
  const lib = fixture();
  lib.save = async () => {
    throw new AppError(
      409,
      "DUPLICATE",
      "This source is already in your library.",
      {
        items: [{ id, title: "Synthetic duplicate" }],
        internal: "must not leak",
      },
    );
  };
  const full = await connect(lib);
  try {
    const result = await full.client.callTool({
      name: "save_drop",
      arguments: {
        requestId: randomUUID(),
        title: "Synthetic",
        source: { originalText: "Synthetic" },
      },
    });
    assert.equal(result.isError, true);
    assert.deepEqual(result.structuredContent, {
      error: "This source is already in your library.",
      code: "DUPLICATE",
      items: [{ id, title: "Synthetic duplicate" }],
    });
  } finally {
    await full.close();
  }
  lib.profile = async () => {
    throw new Error("Must not read profile without read scope");
  };
  const denied = await connect(lib, ["library:write"]);
  try {
    const result = await denied.client.callTool({
      name: "get_profile",
      arguments: {},
    });
    assert.equal(result.isError, true);
    assert.ok(result._meta?.["mcp/www_authenticate"]);
  } finally {
    await denied.close();
  }
});
