import { z } from "zod";
import { categorySchema, idSchema, urlSchema } from "./schema.js";

// The archive is data only. No account identity, credentials, or executable paths.
export const archiveFormat = "drop-it";
export const archiveChunkBytes = 64 * 1024;
export const maxArchiveBytes = 512 * 1024 * 1024;
export const previewLifetimeMs = 15 * 60 * 1000;
export const portableDate = z.string().datetime({ offset: true });
const archiveText = (maximum: number) =>
  z
    .string()
    .max(maximum)
    .refine((value) => !value.includes("\0"));
export const portableItemSchema = z
  .object({
    id: idSchema,
    sourceId: idSchema,
    title: archiveText(200).refine((value) => value.trim().length > 0),
    summary: archiveText(4000),
    category: categorySchema,
    tags: z
      .array(archiveText(40).refine((value) => value.trim().length > 0))
      .max(12),
    notes: archiveText(8000),
    isSaved: z.boolean(),
    trashedAt: portableDate.nullable(),
    revision: z.number().int().positive().max(2147483647),
    createdAt: portableDate,
    updatedAt: portableDate,
    reviewedTranscription: archiveText(50000).nullable().default(null),
    transcriptionUpdatedAt: portableDate.nullable().default(null),
  })
  .strict();
export const portableSourceSchema = z
  .object({
    id: idSchema,
    originalText: archiveText(50000),
    url: z.union([urlSchema, z.literal("")]),
    createdAt: portableDate,
    attachmentId: idSchema.nullable(),
  })
  .strict();
export const portableFileSchema = z
  .object({
    id: idSchema,
    filename: z.string().min(1).max(180),
    mime: z.enum([
      "image/png",
      "image/jpeg",
      "image/webp",
      "application/pdf",
      "text/plain",
      "text/markdown",
      "text/csv",
      "application/json",
    ]),
    bytes: z
      .number()
      .int()
      .positive()
      .max(10 * 1024 * 1024),
    sha256: z.string().regex(/^[a-f0-9]{64}$/),
    createdAt: portableDate,
  })
  .strict();
export const manifestSchema = z
  .object({
    type: z.literal("manifest"),
    format: z.literal(archiveFormat),
    version: z.literal(3),
    exportedAt: portableDate,
  })
  .strict();
export const chunkSchema = z
  .object({
    type: z.literal("chunk"),
    id: idSchema,
    index: z.number().int().nonnegative(),
    data: z
      .string()
      .min(4)
      .max(4 * Math.ceil(archiveChunkBytes / 3)),
  })
  .strict();
export const endSchema = z
  .object({
    type: z.literal("end"),
    items: z.number().int().nonnegative(),
    sources: z.number().int().nonnegative(),
    files: z.number().int().nonnegative(),
    fileBytes: z.number().int().nonnegative(),
    sha256: z.string().regex(/^[a-f0-9]{64}$/),
  })
  .strict();
export const applyImportSchema = z
  .object({
    previewId: idSchema,
    requestId: idSchema,
    confirm: z.literal(true),
  })
  .strict()
  .refine((value) => value.previewId === value.requestId);
export type PortableItem = z.infer<typeof portableItemSchema>;
export type PortableSource = z.infer<typeof portableSourceSchema>;
export type PortableFile = z.infer<typeof portableFileSchema>;
export type ImportPreview = {
  previewId: string;
  requestId: string;
  expiresAt: string;
  version: 2 | 3;
  items: number;
  sources: number;
  files: number;
  fileBytes: number;
  expiredItems: number;
  duplicateItems: number;
  warnings: string[];
};
export type ImportResult = {
  imported: number;
  sources: number;
  files: number;
  replayed: boolean;
};
export const importPreviewSchema = z
  .object({
    previewId: idSchema,
    requestId: idSchema,
    expiresAt: portableDate,
    version: z.union([z.literal(2), z.literal(3)]),
    items: z.number().int().nonnegative(),
    sources: z.number().int().nonnegative(),
    files: z.number().int().nonnegative(),
    fileBytes: z.number().int().nonnegative(),
    expiredItems: z.number().int().nonnegative(),
    duplicateItems: z.number().int().nonnegative(),
    warnings: z.array(z.string().max(500)).max(12),
  })
  .strict();
export const importResultSchema = z
  .object({
    imported: z.number().int().nonnegative(),
    sources: z.number().int().nonnegative(),
    files: z.number().int().nonnegative(),
    replayed: z.boolean(),
  })
  .strict();
