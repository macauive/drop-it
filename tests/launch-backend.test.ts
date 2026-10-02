import { after, before, test } from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { PGlite } from "@electric-sql/pglite";
import { migrate, type Database } from "../server/db.js";
import { Library, type LibraryLimits } from "../server/library.js";
import { cleanupExpired } from "../server/maintenance.js";
import {
  dimensions,
  type AIProvider,
  type DraftContext,
} from "../server/ai.js";
import { AppError } from "../server/errors.js";

let db: Database;
const draft = {
  title: "Draft",
  summary: "",
  category: "Audit",
  tags: [],
  extractedText: "",
  sourceUrl: "",
};
const contexts: DraftContext[] = [];
const embeddings: string[][] = [];
const ai: AIProvider = {
  draft: async (value) => {
    contexts.push(value);
    return draft;
  },
  embed: async (texts) => {
    embeddings.push(texts);
    return texts.map(() =>
      Array.from({ length: dimensions }, (_, i) => Number(i === 0)),
    );
  },
};
const rejected = (code: string) => (error: unknown) =>
  error instanceof AppError && error.code === code;
async function account(
  limits: Partial<LibraryLimits> = {},
  provider: AIProvider = ai,
) {
  const owner = randomUUID();
  await db.query(
    "INSERT INTO users(id,singleton,password_hash,username) VALUES($1,NULL,'synthetic-not-a-password',$2)",
    [owner, `audit-${owner.slice(0, 8)}`],
  );
  return { owner, lib: new Library(db, provider, limits) };
}
const input = (text: string) => ({
  requestId: randomUUID(),
  title: "Audit",
  source: { originalText: text },
});
before(async () => {
  const raw = new PGlite();
  await raw.waitReady;
  db = {
    query: (sql, params) => raw.query(sql, params),
    transaction: (run) => raw.transaction(run),
    close: () => raw.close(),
  };
  await migrate(db);
});
after(async () => db.close());

test("expired originals cannot be drafted or reused at the exact deadline, including cleanup races", async () => {
  const { owner, lib } = await account();
  const attachment = await lib.upload(
    owner,
    Buffer.from("SYNTHETIC expired original"),
    "text/plain",
    "audit.txt",
  );
  const item = await lib.save(owner, {
    ...input(""),
    source: { attachmentId: attachment.attachmentId },
  });
  await db.query(
    "UPDATE items SET trashed_at=clock_timestamp()-interval '7 days' WHERE id=$1",
    [item.item.id],
  );
  const draftCount = contexts.length;
  await assert.rejects(
    lib.draft(owner, { source: { attachmentId: attachment.attachmentId } }),
    rejected("NOT_FOUND"),
  );
  await assert.rejects(
    lib.save(owner, {
      ...input(""),
      source: { attachmentId: attachment.attachmentId },
    }),
    rejected("NOT_FOUND"),
  );
  assert.equal(contexts.length, draftCount);
  const results = await Promise.allSettled([
    cleanupExpired(db),
    lib.save(owner, {
      ...input(""),
      source: { attachmentId: attachment.attachmentId },
    }),
  ]);
  assert.equal(results[0].status, "fulfilled");
  assert.equal(results[1].status, "rejected");
  assert.equal((await lib.search(owner, {})).total, 0);
});

test("attachment eligibility preserves live shared originals and bounds fresh upload grace", async () => {
  const { owner, lib } = await account();
  const file = await lib.upload(
    owner,
    Buffer.from("Shared original"),
    "text/plain",
    "shared.txt",
  );
  await lib.draft(owner, { source: { attachmentId: file.attachmentId } });
  const first = await lib.save(owner, {
    ...input(""),
    source: { attachmentId: file.attachmentId },
  });
  await lib.save(owner, {
    requestId: randomUUID(),
    title: "Other use",
    sourceId: first.source.id,
  });
  await db.query(
    "UPDATE items SET trashed_at=clock_timestamp()-interval '7 days' WHERE id=$1",
    [first.item.id],
  );
  await lib.draft(owner, { source: { attachmentId: file.attachmentId } });
  await lib.save(owner, {
    ...input(""),
    source: { attachmentId: file.attachmentId },
    allowDuplicate: true,
  });
  const old = await lib.upload(
    owner,
    Buffer.from("Abandoned"),
    "text/plain",
    "old.txt",
  );
  await db.query(
    "UPDATE attachments SET created_at=clock_timestamp()-interval '24 hours' WHERE id=$1",
    [old.attachmentId],
  );
  await assert.rejects(
    lib.draft(owner, { source: { attachmentId: old.attachmentId } }),
    rejected("NOT_FOUND"),
  );
  await assert.rejects(
    lib.save(owner, {
      ...input(""),
      source: { attachmentId: old.attachmentId },
    }),
    rejected("NOT_FOUND"),
  );
});

test("source URLs retain fragments while duplicate keys normalize them separately", async () => {
  const { owner, lib } = await account();
  const first = await lib.save(owner, {
    ...input("Original"),
    source: {
      url: "https://example.com/article?edition=1#:~:text=keep%20this",
    },
  });
  assert.equal(
    first.source.url,
    "https://example.com/article?edition=1#:~:text=keep%20this",
  );
  await assert.rejects(
    lib.save(owner, {
      ...input(""),
      source: { url: "https://example.com/article?edition=1#another" },
    }),
    rejected("DUPLICATE"),
  );
  const second = await lib.save(owner, {
    ...input(""),
    source: { url: "https://example.com/article?edition=1#another" },
    allowDuplicate: true,
  });
  assert.equal(
    second.source.url,
    "https://example.com/article?edition=1#another",
  );
});

test("reviewed transcription edits only one drop, preserves source, invalidates embeddings and searches corrected text", async () => {
  const { owner, lib } = await account();
  const first = await lib.save(owner, input("Original transcription mistkae"));
  const second = await lib.save(owner, {
    requestId: randomUUID(),
    title: "Second",
    sourceId: first.source.id,
  });
  await lib.setPreferences(owner, { aiSearchEnabled: true });
  await lib.search(owner, { query: "transcription" });
  assert.ok(
    (
      await db.query("SELECT item_id FROM item_embeddings WHERE owner=$1", [
        owner,
      ])
    ).rows.length,
  );
  const corrected = await lib.update(owner, {
    id: first.item.id,
    revision: 1,
    reviewedTranscription: "Reviewed transcription correctword",
  });
  assert.equal(corrected.source.originalText, "Original transcription mistkae");
  assert.equal(corrected.item.transcriptionProvenance, "reviewed");
  assert.ok(corrected.item.transcriptionUpdatedAt);
  assert.equal(
    (await lib.get(owner, second.item.id)).item.reviewedTranscription,
    null,
  );
  assert.equal(
    (
      await db.query(
        "SELECT item_id FROM item_embeddings WHERE owner=$1 AND item_id=$2",
        [owner, first.item.id],
      )
    ).rows.length,
    0,
  );
  assert.deepEqual(
    (
      await lib.search(owner, { query: "correctword", mode: "keyword" })
    ).items.map((i) => i.id),
    [first.item.id],
  );
  assert.deepEqual(
    (await lib.search(owner, { query: "mistkae", mode: "keyword" })).items.map(
      (i) => i.id,
    ),
    [second.item.id],
  );
  await assert.rejects(
    lib.update(owner, {
      id: first.item.id,
      revision: 1,
      reviewedTranscription: "stale",
    }),
    rejected("CONFLICT"),
  );
  const reset = await lib.update(owner, {
    id: first.item.id,
    revision: 2,
    reviewedTranscription: null,
  });
  assert.equal(reset.item.transcriptionProvenance, "original");
  assert.equal(reset.item.transcriptionUpdatedAt, null);
});

test("AI search is explicit owner-scoped opt-in, keyword mode never calls provider, and disabling clears cached vectors", async () => {
  const { owner, lib } = await account();
  const other = await account();
  await lib.save(owner, input("needle source"));
  const before = embeddings.length;
  assert.equal(
    (await lib.search(owner, { query: "needle", mode: "semantic" })).mode,
    "keyword",
  );
  assert.equal(embeddings.length, before);
  await lib.setPreferences(owner, { aiSearchEnabled: true });
  assert.equal(
    (await other.lib.preferences(other.owner)).aiSearchEnabled,
    false,
  );
  await lib.search(owner, { query: "needle", mode: "keyword" });
  assert.equal(embeddings.length, before);
  const enabled = await lib.search(owner, { query: "needle" });
  assert.equal(enabled.aiSearchEnabled, true);
  assert.equal(enabled.items[0].matchType, "both");
  assert.ok(embeddings.length > before);
  await lib.setPreferences(owner, { aiSearchEnabled: false });
  assert.equal(
    (
      await db.query("SELECT item_id FROM item_embeddings WHERE owner=$1", [
        owner,
      ])
    ).rows.length,
    0,
  );
  await assert.rejects(
    lib.setPreferences(owner, { aiSearchEnabled: true, owner: other.owner }),
  );
});

test("turning AI search off during indexing prevents cache writes and later provider calls", async () => {
  const { owner } = await account();
  let calls = 0;
  const lib = new Library(db, {
    ...ai,
    embed: async (texts) => {
      calls++;
      await lib.setPreferences(owner, { aiSearchEnabled: false });
      return texts.map(() =>
        Array.from({ length: dimensions }, (_, i) => Number(i === 0)),
      );
    },
  });
  await lib.save(owner, input("private query"));
  await lib.setPreferences(owner, { aiSearchEnabled: true });
  assert.equal((await lib.search(owner, { query: "private" })).mode, "keyword");
  assert.equal(calls, 1);
  assert.equal(
    (
      await db.query("SELECT item_id FROM item_embeddings WHERE owner=$1", [
        owner,
      ])
    ).rows.length,
    0,
  );
});

test("storage counts shared files once and discard cannot delete referenced or foreign originals", async () => {
  const { owner, lib } = await account();
  const other = await account();
  const file = await lib.upload(
    owner,
    Buffer.from("123456"),
    "text/plain",
    "six.txt",
  );
  assert.equal((await lib.storage(owner)).abandonedBytes, 6);
  assert.equal(
    (await other.lib.discardUpload(other.owner, file.attachmentId)).discarded,
    false,
  );
  const first = await lib.save(owner, {
    ...input(""),
    source: { attachmentId: file.attachmentId },
  });
  const second = await lib.save(owner, {
    requestId: randomUUID(),
    title: "Shared",
    sourceId: first.source.id,
  });
  assert.equal((await lib.storage(owner)).activeBytes, 6);
  assert.equal(
    (await lib.discardUpload(owner, file.attachmentId)).discarded,
    false,
  );
  await lib.delete(owner, { id: first.item.id, revision: 1 });
  assert.equal((await lib.storage(owner)).activeBytes, 6);
  await lib.delete(owner, { id: second.item.id, revision: 1 });
  assert.equal((await lib.storage(owner)).trashBytes, 6);
  const abandoned = await lib.upload(
    owner,
    Buffer.from("abc"),
    "text/plain",
    "three.txt",
  );
  assert.equal(
    (await lib.discardUpload(owner, abandoned.attachmentId)).discarded,
    true,
  );
  assert.equal((await lib.storage(owner)).attachmentBytes, 6);
});

test("racing discard and save never produce a drop with a missing original", async () => {
  const { owner, lib } = await account();
  const file = await lib.upload(
    owner,
    Buffer.from("race"),
    "text/plain",
    "race.txt",
  );
  const [discard, save] = await Promise.allSettled([
    lib.discardUpload(owner, file.attachmentId),
    lib.save(owner, {
      ...input(""),
      source: { attachmentId: file.attachmentId },
    }),
  ]);
  if (save.status === "fulfilled") {
    assert.equal(
      discard.status === "fulfilled" && discard.value.discarded,
      false,
    );
    assert.equal(
      (await lib.file(owner, save.value.source.id)).bytes.toString(),
      "race",
    );
  } else
    assert.equal(
      discard.status === "fulfilled" && discard.value.discarded,
      true,
    );
});

test("drop, text and attachment limits roll back rejected writes including save retry records", async () => {
  const { owner, lib } = await account({
    ownerDropCount: 1,
    ownerTextBytes: 100,
    ownerAttachmentBytes: 5,
  });
  const first = await lib.save(owner, input("one"));
  await assert.rejects(lib.save(owner, input("two")), rejected("DROP_QUOTA"));
  await assert.rejects(
    lib.update(owner, {
      id: first.item.id,
      revision: 1,
      reviewedTranscription: "x".repeat(101),
    }),
    rejected("TEXT_QUOTA"),
  );
  assert.equal((await lib.get(owner, first.item.id)).item.revision, 1);
  await assert.rejects(
    lib.upload(owner, Buffer.from("123456"), "text/plain", "six.txt"),
    rejected("QUOTA"),
  );
  const usage = await lib.storage(owner);
  assert.equal(usage.attachmentBytes, 0);
  assert.equal(usage.dropCount, 1);
  assert.equal(
    (
      await db.query("SELECT request_id FROM save_requests WHERE owner=$1", [
        owner,
      ])
    ).rows.length,
    1,
  );
});

test("aggregate attachment limit serializes concurrent uploads across owners", async () => {
  const total = await db.query<{ bytes: string }>(
    "SELECT COALESCE(sum(octet_length(bytes)),0) AS bytes FROM attachments",
  );
  const limit = Number(total.rows[0].bytes) + 10;
  const a = await account({ serviceAttachmentBytes: limit });
  const b = await account({ serviceAttachmentBytes: limit });
  const result = await Promise.allSettled([
    a.lib.upload(a.owner, Buffer.from("123456"), "text/plain", "a.txt"),
    b.lib.upload(b.owner, Buffer.from("123456"), "text/plain", "b.txt"),
  ]);
  assert.equal(result.filter((r) => r.status === "fulfilled").length, 1);
  assert.equal(
    result.filter(
      (r) => r.status === "rejected" && rejected("SERVICE_CAPACITY")(r.reason),
    ).length,
    1,
  );
});

test("service-wide AI concurrency applies across owners and releases after provider failure", async () => {
  const a = await account();
  const b = await account();
  let release!: () => void;
  const waiting = new Promise<void>((resolve) => {
    release = resolve;
  });
  const lib = new Library(
    db,
    {
      ...ai,
      draft: async () => {
        await waiting;
        throw new Error("synthetic provider failure");
      },
    },
    { aiConcurrent: 1 },
  );
  const first = lib.draft(a.owner, { source: { originalText: "synthetic" } });
  await new Promise((resolve) => setImmediate(resolve));
  await assert.rejects(
    lib.draft(b.owner, { source: { originalText: "synthetic" } }),
    rejected("AI_BUSY"),
  );
  release();
  await assert.rejects(first, /synthetic provider failure/);
  await assert.rejects(
    lib.draft(b.owner, { source: { originalText: "synthetic" } }),
    /synthetic provider failure/,
  );
});

test("meaning-only search excludes unrelated literal matches while hybrid retains them", async () => {
  const { owner } = await account();
  const lib = new Library(db, {
    ...ai,
    embed: async (texts) =>
      texts.map((text) => {
        const aligned = text === "literalneedle" || text.includes("Garden");
        return Array.from({ length: dimensions }, (_, i) =>
          Number(i === (aligned ? 0 : 1)),
        );
      }),
  });
  await lib.setPreferences(owner, { aiSearchEnabled: true });
  const literal = await lib.save(owner, {
    ...input("literalneedle"),
    title: "Literal result",
  });
  const related = await lib.save(owner, {
    ...input("Garden reference"),
    title: "Garden result",
  });
  const semantic = await lib.search(owner, {
    query: "literalneedle",
    mode: "semantic",
  });
  assert.deepEqual(
    semantic.items.map((item) => item.id),
    [related.item.id],
  );
  assert.equal(semantic.items[0].matchType, "semantic");
  assert.equal(semantic.items[0].matchSnippet, undefined);
  const hybrid = await lib.search(owner, {
    query: "literalneedle",
    mode: "hybrid",
  });
  assert.deepEqual(
    hybrid.items.map((item) => item.id),
    [literal.item.id, related.item.id],
  );
  assert.equal(hybrid.items[0].matchType, "keyword");
  assert.equal(hybrid.items[0].matchSnippet, "literalneedle");
  assert.ok(!("matchText" in hybrid.items[0]));
});

test("lowered capacity limits permit reducing old content without allowing further growth", async () => {
  const { owner, lib } = await account();
  const saved = await lib.save(owner, {
    ...input("source"),
    notes: "x".repeat(150),
  });
  const limited = new Library(db, ai, { ownerTextBytes: 100 });
  const reduced = await limited.update(owner, {
    id: saved.item.id,
    revision: 1,
    notes: "x".repeat(120),
  });
  assert.equal(reduced.item.revision, 2);
  await assert.rejects(
    limited.update(owner, {
      id: saved.item.id,
      revision: 2,
      notes: "x".repeat(125),
    }),
    rejected("TEXT_QUOTA"),
  );
  assert.equal(
    (
      await limited.update(owner, {
        id: saved.item.id,
        revision: 2,
        isSaved: true,
      })
    ).item.isSaved,
    true,
  );
});

test("service AI start limits apply across owners and reset after their fixed window", async (t) => {
  const a = await account(),
    b = await account();
  let now = Date.now();
  t.mock.method(Date, "now", () => now);
  const lib = new Library(db, ai, { aiStartsPerMinute: 1 });
  await lib.draft(a.owner, { source: { originalText: "synthetic first" } });
  await assert.rejects(
    lib.draft(b.owner, { source: { originalText: "synthetic second" } }),
    rejected("AI_BUSY"),
  );
  now += 60001;
  await lib.draft(b.owner, { source: { originalText: "synthetic retry" } });
});
