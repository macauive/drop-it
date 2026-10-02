import { z } from "zod";
import { idSchema, views } from "./schema.js";
import { fileTypes } from "./files.js";

// These describe the JSON wire format, including dates serialized by the DB
// adapters. They deliberately exclude transport-only original file bytes.
const timestamp = z.string().datetime();
export const itemResultSchema = z
  .object({
    id: idSchema,
    sourceId: idSchema,
    title: z.string().min(1).max(200),
    summary: z.string().max(4000),
    category: z.string().min(1).max(60),
    isSaved: z.boolean(),
    trashedAt: timestamp.nullable(),
    deleteAfter: timestamp.nullable(),
    tags: z.array(z.string().min(1).max(40)).max(12),
    notes: z.string().max(8000),
    revision: z.number().int().positive(),
    createdAt: timestamp,
    updatedAt: timestamp,
    sourceUrl: z.string().max(2048),
    hasImage: z.boolean(),
    reviewedTranscription: z.string().max(50000).nullable().optional(),
    transcriptionUpdatedAt: timestamp.nullable().optional(),
    transcriptionProvenance: z.enum(["original", "reviewed"]).optional(),
    matchType: z.enum(["keyword", "semantic", "both"]).optional(),
    matchSnippet: z.string().max(182).optional(),
  })
  .strict();

export const sourceResultSchema = z
  .object({
    id: idSchema,
    originalText: z.string().max(50000),
    url: z.string().max(2048),
    createdAt: timestamp,
    attachmentId: idSchema.nullable().optional(),
    hasImage: z.boolean(),
    hasFile: z.boolean(),
    filename: z.string().max(255).nullable(),
    mime: z.enum(Object.values(fileTypes)).nullable(),
  })
  .strict();

export const detailResultSchema = z
  .object({
    item: itemResultSchema,
    source: sourceResultSchema,
  })
  .strict();
export const searchResultSchema = z
  .object({
    items: z.array(itemResultSchema).max(100),
    total: z.number().int().nonnegative(),
    counts: z.record(z.enum(views), z.number().int().nonnegative()),
    categories: z.array(z.string().min(1).max(60)),
    aiAvailable: z.boolean(),
    aiSearchEnabled: z.boolean().optional(),
    mode: z.enum(["keyword", "semantic", "hybrid"]),
    searchNotice: z.string().max(1000).optional(),
  })
  .strict();

export const draftOutputSchema = z
  .object({
    title: z.string().min(1).max(200),
    summary: z.string().max(4000),
    category: z.string().min(1).max(60),
    tags: z.array(z.string().min(1).max(40)).max(12),
    extractedText: z.string().max(12000),
    sourceUrl: z.string().max(2048),
  })
  .strict();

export const mcpOutputSchemas = {
  search_drops: searchResultSchema,
  draft_drop: z.object({ draft: draftOutputSchema }).strict(),
  get_drop: detailResultSchema,
  save_drop: detailResultSchema.extend({ replayed: z.boolean() }).strict(),
  update_drop: detailResultSchema,
  wipe_drop: z.object({ trashed: z.literal(true) }).strict(),
  restore_drop: detailResultSchema,
  upload_source: z
    .object({
      attachmentId: idSchema,
      originalText: z.string().max(50000),
    })
    .strict(),
  get_profile: z
    .object({
      id: idSchema,
      nickname: z.string().min(1).max(80).optional(),
    })
    .strict(),
} as const;
export type McpToolName = keyof typeof mcpOutputSchemas;

export const mcpErrorSchema = z
  .object({
    error: z.string().max(1000),
    code: z.string().max(100),
    items: z
      .array(z.object({ id: idSchema, title: z.string().max(200) }).strict())
      .max(5)
      .optional(),
  })
  .strict();
