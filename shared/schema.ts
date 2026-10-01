import { z } from "zod";

export const categorySchema = z
  .string()
  .max(120)
  // Keep Unicode checks at runtime: JSON Schema cannot carry the JS `u` flag,
  // and some MCP clients reject Unicode property escapes in schema patterns.
  .refine(
    (value) => /^[\p{L}\p{M}\p{N} &+/'().,-]+$/u.test(value),
    "Use a short pool name without special control characters.",
  )
  .transform((value) => value.normalize("NFKC").trim().replace(/ +/g, " "))
  .pipe(
    z
      .string()
      .min(1)
      .max(60)
      .refine((value) => /[\p{L}\p{N}]/u.test(value)),
  );
export const views = ["All drops", "Saved", "Trash"] as const;
export const settingsSchema = z
  .object({
    aiConfigured: z.boolean(),
    connectedApps: z.number().int().nonnegative(),
    trashRetentionDays: z.literal(7),
  })
  .strict();
export type LibrarySettings = z.infer<typeof settingsSchema>;
export const idSchema = z.string().uuid();
export const currentPasswordSchema = z.string().min(1).max(128);
export const newPasswordSchema = z.string().min(15).max(128);
export const usernameSchema = z
  .string()
  .trim()
  .toLowerCase()
  .min(3)
  .max(40)
  .regex(
    /^[a-z0-9][a-z0-9_-]*$/,
    "Use letters, numbers, underscores or hyphens.",
  );
export const recoveryCodeSchema = z
  .string()
  .max(100)
  .trim()
  .regex(/^[A-Za-z0-9_-]{43}$/);
export const securityInfoSchema = z
  .object({
    recoveryEnabled: z.boolean(),
    recoveryCreatedAt: z.string().datetime().nullable(),
    sessions: z
      .array(
        z
          .object({
            id: idSchema,
            label: z.string().min(1).max(80),
            createdAt: z.string().datetime(),
            lastSeenAt: z.string().datetime(),
            expiresAt: z.string().datetime(),
            current: z.boolean(),
          })
          .strict(),
      )
      .max(50),
  })
  .strict();
export type SecurityInfo = z.infer<typeof securityInfoSchema>;
export const urlSchema = z
  .string()
  .trim()
  .max(2048)
  .url()
  .refine((value) => {
    try {
      const url = new URL(value);
      return (
        ["https:", "http:"].includes(url.protocol) &&
        !url.username &&
        !url.password
      );
    } catch {
      return false;
    }
  }, "Use an HTTP or HTTPS URL without credentials.");
export const fieldsSchema = z.object({
  title: z.string().trim().min(1).max(200),
  summary: z.string().trim().max(4000).default(""),
  category: categorySchema.default("Uncategorized"),
  tags: z
    .array(z.string().trim().min(1).max(40))
    .max(12)
    .default([])
    .transform((tags) => [...new Set(tags.map((tag) => tag.toLowerCase()))]),
  notes: z.string().trim().max(8000).default(""),
});
export const sourceInputSchema = z
  .object({
    originalText: z.string().max(50000).default(""),
    url: z.union([urlSchema, z.literal("")]).default(""),
    attachmentId: idSchema.optional(),
  })
  .strict();
export const draftSchema = z
  .object({ source: sourceInputSchema })
  .strict()
  .refine(
    ({ source }) =>
      Boolean(source.originalText.trim() || source.url || source.attachmentId),
    "Add text, a link, or a file first.",
  );
export const draftResultSchema = z
  .object({
    title: z.string().trim().min(1).max(200),
    summary: z.string().trim().max(4000),
    category: categorySchema,
    tags: z.array(z.string().trim().min(1).max(40)).max(12),
    extractedText: z.string().max(12000),
    sourceUrl: z.union([urlSchema, z.literal("")]).default(""),
  })
  .strict();
export type DraftResult = z.infer<typeof draftResultSchema>;
export const saveSchema = fieldsSchema
  .extend({
    requestId: idSchema,
    source: sourceInputSchema.optional(),
    sourceId: idSchema.optional(),
    allowDuplicate: z.boolean().default(false),
  })
  .strict()
  .refine(
    (v) => Boolean(v.source) !== Boolean(v.sourceId),
    "Provide source or sourceId, not both.",
  );
export const searchSchema = z
  .object({
    query: z.string().trim().max(300).default(""),
    mode: z.enum(["keyword", "semantic", "hybrid"]).default("hybrid"),
    category: categorySchema.optional(),
    view: z.enum(views).default("All drops"),
    tag: z.string().trim().max(40).optional(),
    before: z.string().datetime().optional(),
    after: z.string().datetime().optional(),
    limit: z.number().int().min(1).max(100).default(30),
    offset: z.number().int().min(0).max(100000).default(0),
  })
  .strict();
export const updateSchema = z
  .object({
    title: z.string().trim().min(1).max(200).optional(),
    summary: z.string().trim().max(4000).optional(),
    category: categorySchema.optional(),
    tags: z
      .array(z.string().trim().min(1).max(40))
      .max(12)
      .transform((tags) => [...new Set(tags.map((tag) => tag.toLowerCase()))])
      .optional(),
    notes: z.string().trim().max(8000).optional(),
    id: idSchema,
    revision: z.number().int().positive(),
    isSaved: z.boolean().optional(),
  })
  .strict();
export const deleteSchema = z
  .object({ id: idSchema, revision: z.number().int().positive() })
  .strict();
export const fileParamSchema = z
  .object({
    download_url: z.string().url().max(4096),
    file_id: z.string().min(1).max(300),
    file_name: z.string().min(1).max(255).optional(),
    // Compatibility for already-open widgets using the previous descriptor.
    filename: z.string().min(1).max(255).optional(),
    mime_type: z
      .enum([
        "image/png",
        "image/jpeg",
        "image/webp",
        "application/pdf",
        "text/plain",
        "text/markdown",
        "text/csv",
        "application/json",
        "application/octet-stream",
      ])
      .optional(),
  })
  .strict();
export type SaveInput = z.input<typeof saveSchema>;
export type SearchInput = z.input<typeof searchSchema>;
export type Item = {
  id: string;
  sourceId: string;
  title: string;
  summary: string;
  category: string;
  isSaved: boolean;
  trashedAt: string | null;
  deleteAfter: string | null;
  tags: string[];
  notes: string;
  revision: number;
  createdAt: string;
  updatedAt: string;
  sourceUrl: string;
  hasImage: boolean;
};
export type Source = {
  id: string;
  originalText: string;
  url: string;
  createdAt: string;
  hasImage: boolean;
  hasFile: boolean;
  filename: string | null;
  mime: string | null;
};
export type SearchResult = {
  items: Item[];
  total: number;
  counts: Record<string, number>;
  categories: string[];
  aiAvailable: boolean;
  mode: "keyword" | "semantic" | "hybrid";
  searchNotice?: string;
};
