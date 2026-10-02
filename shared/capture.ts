import { z } from "zod";
import { urlSchema } from "./schema.js";

export const sharedCaptureSchema = z
  .object({
    title: z.string().max(200).default(""),
    text: z.string().max(50000).default(""),
    url: z.union([urlSchema, z.literal("")]).default(""),
  })
  .strict();
export type SharedCapture = z.infer<typeof sharedCaptureSchema>;
