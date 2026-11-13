import { z } from "zod";

// Data-only snapshot. It is never rendered as HTML or followed as instructions.
export const pageSnapshotSchema = z
  .object({
    provider: z.literal("firecrawl"),
    requestedUrl: z.string().max(2048).url(),
    finalUrl: z.string().max(2048).url(),
    capturedAt: z.string().datetime(),
    title: z.string().max(200),
    description: z.string().max(2000),
    text: z.string().min(1).max(30000),
    truncated: z.boolean(),
  })
  .strict()
  .refine((snapshot) =>
    Object.values(snapshot).every(
      (value) => typeof value !== "string" || !value.includes("\0"),
    ),
  );
export type PageSnapshot = z.infer<typeof pageSnapshotSchema>;
