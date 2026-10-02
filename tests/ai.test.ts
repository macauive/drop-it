import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { randomBytes, randomUUID } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import sharp from "sharp";
import { openDatabase, migrate, type Database } from "../server/db.js";
import { Library } from "../server/library.js";
import {
  OpenAIProvider,
  dimensions,
  type AIProvider,
  type DraftContext,
} from "../server/ai.js";
import { AppError } from "../server/errors.js";
import { pdfFixture } from "./pdf-fixture.js";

const draftResult = {
  title: "Indoor herbs",
  summary: "Grow basil in a sunny window.",
  category: "Gardening",
  tags: ["basil"],
  extractedText: "",
  sourceUrl: "",
};
const vector = (garden: boolean) =>
  Array.from({ length: dimensions }, (_, i) =>
    i === (garden ? 0 : 1) ? 1 : 0,
  );
const calls: string[][] = [];
const draftContexts: DraftContext[] = [];
const mock: AIProvider = {
  draft: async (context) => {
    draftContexts.push(context);
    return { ...draftResult };
  },
  embed: async (texts) => {
    calls.push(texts);
    return texts.map((text) => vector(/basil|herbs|garden/i.test(text)));
  },
};
let dir: string, db: Database, library: Library;
const owner = randomUUID(),
  other = randomUUID();
const errorCode = (code: string) => (error: unknown) =>
  error instanceof AppError && error.code === code;
const save = (title: string, category = "Gardening") => ({
  requestId: randomUUID(),
  title,
  category,
  source: { originalText: title },
});
before(async () => {
  dir = await mkdtemp(join(tmpdir(), "drop-it-ai-"));
  db = await openDatabase({ dataDir: dir });
  await migrate(db);
  await db.query(
    "INSERT INTO users(id,singleton,password_hash) VALUES($1,NULL,$3),($2,NULL,$3)",
    [owner, other, randomBytes(32).toString("hex")],
  );
  library = new Library(db, mock);
  // Search tests deliberately exercise the explicitly enabled AI path.
  await library.setPreferences(owner, { aiSearchEnabled: true });
});
after(async () => {
  await db?.close();
  await rm(dir, { recursive: true, force: true });
});

test("AI drafts use owned images, strip URL query data, and never save items", async () => {
  await library.save(
    other,
    save("Other owner confidential source", "Private Topic"),
  );
  const image = await library.upload(
    owner,
    await sharp({
      create: { width: 4, height: 4, channels: 3, background: "white" },
    })
      .png()
      .toBuffer(),
    "image/png",
  );
  await assert.rejects(
    library.draft(other, { source: { attachmentId: image.attachmentId } }),
    errorCode("NOT_FOUND"),
  );
  assert.equal(draftContexts.length, 0);
  const result = await library.draft(owner, {
    source: {
      originalText: "Grow basil",
      url: "https://example.com/herbs?access=private#part",
      attachmentId: image.attachmentId,
    },
  });
  assert.deepEqual(result.draft, {
    ...draftResult,
    sourceUrl: "https://example.com/herbs?access=private#part",
  });
  assert.equal(draftContexts[0].url, "https://example.com/herbs");
  assert.match(draftContexts[0].image ?? "", /^data:image\/jpeg;base64,/);
  assert.ok(!draftContexts[0].categories.includes("Private Topic"));
  assert.equal((await library.search(owner, {})).total, 0);
  await assert.rejects(library.draft(owner, { source: {}, owner: other }));
  await assert.rejects(library.draft(owner, { source: {} }));
});

test("semantic search ranks synonyms, respects filters and owners, and caches embeddings", async () => {
  const herb = await library.save(owner, save("Basil in a sunny window"));
  await library.save(owner, save("Repair a bicycle", "Repairs"));
  calls.length = 0;
  const found = await library.search(owner, {
    query: "herbs",
    mode: "semantic",
  });
  assert.deepEqual(
    found.items.map((i) => i.id),
    [herb.item.id],
  );
  assert.equal(found.mode, "semantic");
  assert.equal(found.aiAvailable, true);
  assert.ok(!calls.flat().some((text) => text.includes("confidential")));
  assert.equal(calls.length, 2);
  assert.equal(
    (await library.search(owner, { query: "herbs", mode: "keyword" })).total,
    0,
  );
  await library.search(owner, { query: "herbs", mode: "semantic" });
  assert.equal(calls.length, 3);
  const filtered = await library.search(owner, {
    query: "herbs",
    mode: "semantic",
    category: "Repairs",
  });
  assert.equal(filtered.total, 0);
  await library.update(owner, {
    id: herb.item.id,
    revision: 1,
    summary: "Basil garden planning",
  });
  assert.equal(
    (
      await db.query(
        "SELECT item_id FROM item_embeddings WHERE owner=$1 AND item_id=$2",
        [owner, herb.item.id],
      )
    ).rows.length,
    0,
  );
  const before = calls.length;
  await library.search(owner, { query: "herbs", mode: "semantic" });
  assert.equal(calls.length, before + 2);
  await library.delete(owner, { id: herb.item.id, revision: 2 });
  assert.equal(
    (
      await db.query(
        "SELECT item_id FROM item_embeddings WHERE owner=$1 AND item_id=$2",
        [owner, herb.item.id],
      )
    ).rows.length,
    0,
  );
});

test("hybrid search includes low-similarity keywords, URLs, long source text and semantic matches without duplicates", async () => {
  const topic = "Hybrid checks";
  const semantic = await library.save(
    owner,
    save("Basil semantic result", topic),
  );
  const keyword = await library.save(owner, {
    ...save("Literal identifier", topic),
    source: { originalText: "x".repeat(7000) + " herbs" },
  });
  const url = await library.save(owner, {
    ...save("URL identifier", topic),
    source: { url: "https://example.com/herbs" },
  });
  await library.save(other, save("herbs private result", topic));
  const found = await library.search(owner, {
    query: "herbs",
    category: topic,
  });
  assert.equal(found.mode, "hybrid");
  assert.equal(found.total, 3);
  assert.deepEqual(
    new Set(found.items.map((item) => item.id)),
    new Set([semantic.item.id, keyword.item.id, url.item.id]),
  );
  assert.equal(found.items[2].id, semantic.item.id);
  const secondPage = await library.search(owner, {
    query: "herbs",
    category: topic,
    offset: 2,
    limit: 1,
  });
  assert.equal(secondPage.total, 3);
  assert.equal(secondPage.items[0].id, semantic.item.id);
  const overlap = await library.search(owner, {
    query: "basil",
    category: topic,
  });
  assert.equal(
    new Set(overlap.items.map((item) => item.id)).size,
    overlap.total,
  );
  for (const saved of [semantic, keyword, url])
    await library.delete(owner, { id: saved.item.id, revision: 1 });
});

test("hybrid search falls back to keyword results when AI is absent or fails", async () => {
  const manual = new Library(db);
  const saved = await manual.save(owner, save("Fallback needle", "Fallback"));
  for (const engine of [
    manual,
    new Library(db, {
      ...mock,
      embed: async () => {
        throw new AppError(502, "AI_FAILED", "AI failed.");
      },
    }),
  ]) {
    const found = await engine.search(owner, {
      query: "needle",
      category: "Fallback",
    });
    assert.equal(found.mode, "keyword");
    assert.match(found.searchNotice ?? "", /keyword matches/);
    assert.deepEqual(
      found.items.map((item) => item.id),
      [saved.item.id],
    );
  }
  await manual.delete(owner, { id: saved.item.id, revision: 1 });
});

test("missing AI or provider failure leaves manual workflows intact", async () => {
  const manual = new Library(db);
  await assert.rejects(
    manual.draft(owner, { source: { originalText: "herbs" } }),
    errorCode("AI_UNAVAILABLE"),
  );
  await assert.rejects(
    manual.search(owner, { query: "herbs", mode: "semantic" }),
    errorCode("AI_UNAVAILABLE"),
  );
  assert.equal((await manual.search(owner, {})).aiAvailable, false);
  const failing = new Library(db, {
    ...mock,
    draft: async () => {
      throw new AppError(502, "AI_FAILED", "AI failed.");
    },
  });
  const count = (await manual.search(owner, {})).total;
  await assert.rejects(
    failing.draft(owner, { source: { originalText: "herbs" } }),
    errorCode("AI_FAILED"),
  );
  assert.equal((await manual.search(owner, {})).total, count);
});

test("deleted items are not reintroduced when indexing finishes late", async () => {
  const saved = await library.save(owner, save("Delayed basil index"));
  let deleted = false;
  const late = new Library(db, {
    ...mock,
    embed: async (texts) => {
      if (!deleted) {
        deleted = true;
        await library.delete(owner, { id: saved.item.id, revision: 1 });
      }
      return mock.embed(texts);
    },
  });
  const found = await late.search(owner, {
    query: "herbs",
    category: "Gardening",
    mode: "semantic",
  });
  assert.equal(found.total, 0);
  assert.equal(
    (
      await db.query("SELECT item_id FROM item_embeddings WHERE item_id=$1", [
        saved.item.id,
      ])
    ).rows.length,
    0,
  );
});

test("provider sends strict, non-stored drafts only to the fixed OpenAI endpoint", async () => {
  let body: Record<string, unknown> | undefined;
  const transport: typeof fetch = async (url, init) => {
    assert.equal(url, "https://api.openai.com/v1/responses");
    assert.equal(init?.redirect, "error");
    body = JSON.parse(String(init?.body));
    return Response.json({
      status: "completed",
      output: [
        {
          type: "message",
          content: [{ type: "output_text", text: JSON.stringify(draftResult) }],
        },
      ],
    });
  };
  const provider = new OpenAIProvider(
    { apiKey: randomBytes(32).toString("hex"), model: "test-model" },
    transport,
  );
  assert.deepEqual(
    await provider.draft({ text: "herbs", url: "", categories: [] }),
    draftResult,
  );
  assert.equal(body?.store, false);
  assert.equal(
    (body?.text as { format: { strict: boolean } }).format.strict,
    true,
  );
  await provider.draft({
    text: "",
    url: "",
    categories: [],
    pdf: { filename: "notes.pdf", data: "data:application/pdf;base64,fixture" },
  });
  const content = (body?.input as { content: Record<string, unknown>[] }[])[0]
    .content;
  assert.deepEqual(
    content.find((part) => part.type === "input_file"),
    {
      type: "input_file",
      filename: "notes.pdf",
      file_data: "data:application/pdf;base64,fixture",
    },
  );
});

test("file drafts and downloads preserve bytes, owner boundaries and source URLs", async () => {
  const bytes = pdfFixture();
  const pdf = await library.upload(
    owner,
    bytes,
    "application/pdf",
    "notes.pdf",
  );
  const text = await library.upload(
    owner,
    Buffer.from("# Full source\nGrow basil"),
    "text/markdown",
    "notes.md",
  );
  await assert.rejects(
    library.draft(other, { source: { attachmentId: pdf.attachmentId } }),
    errorCode("NOT_FOUND"),
  );
  await library.draft(owner, { source: { attachmentId: pdf.attachmentId } });
  assert.equal(
    draftContexts.at(-1)?.pdf?.data,
    `data:application/pdf;base64,${bytes.toString("base64")}`,
  );
  await library.draft(owner, { source: { attachmentId: text.attachmentId } });
  assert.equal(draftContexts.at(-1)?.text, "# Full source\nGrow basil");
  const detector = new Library(db, {
    ...mock,
    draft: async () => ({
      ...draftResult,
      sourceUrl: "https://example.com/basil",
    }),
  });
  const proposal = await detector.draft(owner, {
    source: { attachmentId: pdf.attachmentId },
  });
  assert.equal(proposal.draft.sourceUrl, "https://example.com/basil");
  const manual = await detector.draft(owner, {
    source: { url: "https://example.org/mine", originalText: "manual source" },
  });
  assert.equal(manual.draft.sourceUrl, "https://example.org/mine");
  const saved = await library.save(owner, {
    ...save("File check"),
    source: { attachmentId: pdf.attachmentId, url: proposal.draft.sourceUrl },
  });
  assert.equal(saved.source.url, proposal.draft.sourceUrl);
  assert.equal(saved.source.hasImage, false);
  assert.equal(saved.source.hasFile, true);
  assert.equal(saved.source.filename, "notes.pdf");
  assert.deepEqual((await library.file(owner, saved.source.id)).bytes, bytes);
  await assert.rejects(
    library.file(other, saved.source.id),
    errorCode("NOT_FOUND"),
  );
  await assert.rejects(
    library.image(owner, saved.source.id),
    errorCode("NOT_FOUND"),
  );
  const savedText = await library.save(owner, {
    ...save("Text file check"),
    source: { attachmentId: text.attachmentId },
  });
  assert.equal(savedText.source.originalText, "# Full source\nGrow basil");
  const exported = await library.export(owner);
  assert.equal(
    exported.sources.find((source) => source.id === saved.source.id)
      ?.fileBase64,
    bytes.toString("base64"),
  );
  for (const entry of [saved, savedText])
    await library.delete(owner, { id: entry.item.id, revision: 1 });
  assert.deepEqual((await library.file(owner, saved.source.id)).bytes, bytes);
});

test("AI source URLs reject executable schemes and embedded credentials", async () => {
  for (const sourceUrl of [
    "javascript:alert(1)",
    "data:text/html,hello",
    "https://user:pass@example.com/",
  ]) {
    const provider = new OpenAIProvider(
      { apiKey: "test", model: "test" },
      async () =>
        Response.json({
          status: "completed",
          output: [
            {
              type: "message",
              content: [
                {
                  type: "output_text",
                  text: JSON.stringify({ ...draftResult, sourceUrl }),
                },
              ],
            },
          ],
        }),
    );
    await assert.rejects(
      provider.draft({ text: "source", url: "", categories: [] }),
      errorCode("AI_FAILED"),
    );
  }
});

test("rate limits and timeouts after upload allow retry or manual save without duplicate items", async () => {
  let attempts = 0;
  const provider = new OpenAIProvider(
    { apiKey: randomBytes(24).toString("hex"), model: "test" },
    async () => {
      attempts++;
      if (attempts === 1)
        return new Response("Injected limit", { status: 429 });
      if (attempts === 2 || attempts === 4)
        throw new DOMException("Injected timeout", "TimeoutError");
      return Response.json({
        status: "completed",
        output: [
          {
            type: "message",
            content: [
              { type: "output_text", text: JSON.stringify(draftResult) },
            ],
          },
        ],
      });
    },
  );
  const recovering = new Library(db, provider);
  const initial = (await recovering.search(owner, {})).total;
  const attachment = await recovering.upload(
    owner,
    Buffer.from("Recovery source"),
    "text/plain",
    "recovery.txt",
  );
  const input = { source: { attachmentId: attachment.attachmentId } };
  await assert.rejects(recovering.draft(owner, input), errorCode("AI_LIMIT"));
  await assert.rejects(recovering.draft(owner, input), errorCode("AI_FAILED"));
  assert.equal((await recovering.search(owner, {})).total, initial);
  const proposal = await recovering.draft(owner, input);
  const saveInput = { ...save(proposal.draft.title), source: input.source };
  const saved = await recovering.save(owner, saveInput);
  assert.equal(
    (await recovering.save(owner, saveInput)).item.id,
    saved.item.id,
  );
  assert.equal((await recovering.search(owner, {})).total, initial + 1);
  assert.equal(
    (await recovering.file(owner, saved.source.id)).bytes.toString(),
    "Recovery source",
  );
  const manualAttachment = await recovering.upload(
    owner,
    Buffer.from("Manual recovery source"),
    "text/plain",
    "manual.txt",
  );
  await assert.rejects(
    recovering.draft(owner, {
      source: { attachmentId: manualAttachment.attachmentId },
    }),
    errorCode("AI_FAILED"),
  );
  const manual = await recovering.save(owner, {
    ...save("Manual recovery"),
    source: { attachmentId: manualAttachment.attachmentId },
  });
  assert.equal(manual.source.originalText, "Manual recovery source");
  assert.equal((await recovering.search(owner, {})).total, initial + 2);
  for (const item of [saved, manual])
    await recovering.delete(owner, { id: item.item.id, revision: 1 });
});

test("provider rejects malformed drafts, refusals, vectors and upstream errors without leaking content", async () => {
  const marker = randomBytes(16).toString("hex");
  for (const payload of [
    { status: "incomplete", output: [] },
    {
      status: "completed",
      output: [{ type: "message", content: [{ type: "refusal" }] }],
    },
    {
      status: "completed",
      output: [
        {
          type: "message",
          content: [
            {
              type: "output_text",
              text: JSON.stringify({ ...draftResult, category: "<script>" }),
            },
          ],
        },
      ],
    },
  ]) {
    const provider = new OpenAIProvider(
      { apiKey: marker, model: "test" },
      async () => Response.json(payload),
    );
    await assert.rejects(
      provider.draft({ text: "test", url: "", categories: [] }),
      errorCode("AI_FAILED"),
    );
  }
  const badVectors = new OpenAIProvider(
    { apiKey: marker, model: "test" },
    async () => Response.json({ data: [{ index: 0, embedding: [1, 2] }] }),
  );
  await assert.rejects(badVectors.embed(["test"]), errorCode("AI_FAILED"));
  for (const status of [401, 429, 500]) {
    const provider = new OpenAIProvider(
      { apiKey: marker, model: "test" },
      async () => new Response(marker, { status }),
    );
    await assert.rejects(
      provider.embed(["test"]),
      (error: unknown) =>
        error instanceof AppError && !error.message.includes(marker),
    );
  }
});
