import { z } from "zod";

export const onboardingActionSchema = z
  .object({
    action: z.enum(["dismiss", "reopen", "use-website", "choose-connection"]),
  })
  .strict();

export const onboardingSchema = z
  .object({
    dismissed: z.boolean(),
    found: z.boolean(),
    websiteOnly: z.boolean(),
    firstDrop: z
      .object({ id: z.string().uuid(), title: z.string().max(200) })
      .strict()
      .nullable(),
    connections: z
      .object({ extension: z.boolean(), chatgpt: z.boolean() })
      .strict(),
    extensionAvailable: z.boolean(),
    chatgptAvailable: z.boolean(),
  })
  .strict();
export type Onboarding = z.infer<typeof onboardingSchema>;
