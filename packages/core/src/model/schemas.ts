import { z } from "zod";

export const TOOL_SCHEMA_VERSION = "0.1.0";

export const SourceApiSchema = z
  .object({
    service: z.string().min(1),
    operation: z.string().min(1),
  })
  .strict();

export const ScanErrorSchema = z
  .object({
    code: z.string().min(1),
    message: z.string().min(1),
    retryable: z.boolean().default(false),
  })
  .strict();

export const InventoryResourceSchema = z
  .object({
    resourceType: z.string().regex(/^AWS::[A-Za-z0-9]+::[A-Za-z0-9]+$/),
    identifier: z.string().min(1),
    accountId: z
      .string()
      .regex(/^\d{12}$/)
      .optional(),
    region: z.string().min(1),
    sourceRegion: z.string().min(1).optional(),
    properties: z.record(z.unknown()).default({}),
    tags: z.record(z.string()).default({}),
    sourceApi: SourceApiSchema,
    isCloudFormationManaged: z.boolean().default(false),
    errors: z.array(ScanErrorSchema).default([]),
    collectionNotes: z
      .array(
        z
          .object({
            code: z.enum(["GAP-1", "GAP-4"]),
            propertyPath: z.string().min(1),
            messageKey: z.enum([
              "core.gap.ec2Mapped",
              "core.gap.ec2Split",
              "core.gap.ec2Managed",
              "core.gap.unmapped",
            ]),
          })
          .strict(),
      )
      .optional(),
  })
  .strict();

export const InventoryDocumentSchema = z
  .object({
    schemaVersion: z.literal(TOOL_SCHEMA_VERSION),
    toolVersion: z.string().min(1),
    generatedAt: z.string().datetime().optional(),
    resources: z.array(InventoryResourceSchema),
  })
  .strict();

export type SourceApi = z.infer<typeof SourceApiSchema>;
export type ScanError = z.infer<typeof ScanErrorSchema>;
export type InventoryResource = z.infer<typeof InventoryResourceSchema>;
export type InventoryDocument = z.infer<typeof InventoryDocumentSchema>;
