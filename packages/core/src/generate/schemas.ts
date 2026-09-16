import { z } from "zod";

import { TOOL_SCHEMA_VERSION } from "../model/schemas.js";
import { ExternalReferenceSchema } from "../scope/schemas.js";

export const GenerationStackSchema = z
  .object({
    stackName: z.string().min(1),
    fileBase: z.string().regex(/^[a-z0-9-]+$/),
    account: z
      .string()
      .regex(/^\d{12}$/)
      .optional(),
    region: z.string().min(1).optional(),
    kind: z.enum(["vpc", "regional", "global", "unresolved"]),
    vpcIds: z.array(z.string()),
    availabilityZones: z.array(z.string()),
    resourceKeys: z.array(z.string()),
    reviewReasons: z.array(z.string()),
  })
  .strict();

export const GenerationReferenceSchema = z
  .object({
    from: z.string(),
    to: z.string().optional(),
    propertyPath: z.string(),
    value: z.string(),
    targetAttribute: z.string().optional(),
    targetResourceType: z.string().optional(),
    valueSuffix: z.string().optional(),
    sourceStack: z.string(),
    targetStack: z.string().optional(),
    exportName: z.string().optional(),
    disposition: z.enum([
      "internal-token",
      "cross-stack-token",
      "parameter",
      "import-reference",
      "unresolved",
      "cycle-boundary",
      "excluded-property",
    ]),
    reason: z.string().optional(),
  })
  .strict();

export const GenerationPlanSchema = z
  .object({
    schemaVersion: z.literal(TOOL_SCHEMA_VERSION),
    maxResourcesPerStack: z.number().int().positive().max(500),
    stacks: z.array(GenerationStackSchema),
    references: z.array(GenerationReferenceSchema),
    warnings: z.array(z.string()),
  })
  .strict();

export const GeneratedCfnResourceSchema = z
  .object({
    DeletionPolicy: z.literal("Retain"),
    Metadata: z
      .object({
        "cdk-excavator": z
          .object({
            gapCodes: z.array(z.string().min(1)).default([]),
            identifier: z.string().min(1),
            resourceKey: z.string().min(1),
            referenceNotes: z.array(z.string()).optional(),
          })
          .strict(),
      })
      .strict(),
    Properties: z.record(z.unknown()).default({}),
    DependsOn: z.array(z.string()).optional(),
    Type: z.string().regex(/^AWS::[A-Za-z0-9]+::[A-Za-z0-9]+$/),
    UpdateReplacePolicy: z.literal("Retain"),
  })
  .strict();

export const GeneratedCfnParameterSchema = z
  .object({
    Description: z.string().min(1),
    Type: z.literal("String"),
    Default: z.string().optional(),
  })
  .strict();

export const GeneratedCfnTemplateSchema = z
  .object({
    AWSTemplateFormatVersion: z.literal("2010-09-09"),
    Description: z.string().min(1),
    Parameters: z.record(GeneratedCfnParameterSchema).optional(),
    Outputs: z
      .record(
        z
          .object({
            Value: z.unknown(),
            Export: z.object({ Name: z.string() }).strict(),
          })
          .strict(),
      )
      .optional(),
    Resources: z.record(GeneratedCfnResourceSchema),
  })
  .strict();

export const ImportStatusSchema = z.enum(["blocked", "needs-review", "ready"]);

export const ImportBoundaryReferenceSchema = ExternalReferenceSchema.extend({
  referencedByLogicalId: z.string().min(1).optional(),
}).strict();

export const ImportMapResourceSchema = z
  .object({
    accountId: z
      .string()
      .regex(/^\d{12}$/)
      .optional(),
    cdkPath: z.string().min(1),
    identifier: z.string().min(1),
    importIdentifiers: z.record(z.string().min(1)),
    logicalId: z.string().min(1),
    region: z.string().min(1),
    resourceKey: z.string().min(1),
    resourceType: z.string().regex(/^AWS::[A-Za-z0-9]+::[A-Za-z0-9]+$/),
    reviewReasons: z.array(z.string().min(1)).default([]),
    status: ImportStatusSchema,
    stackName: z.string().optional(),
  })
  .strict();

export const CdkImportMapDocumentSchema = z
  .object({
    externalReferences: z.array(ImportBoundaryReferenceSchema).default([]),
    resources: z.array(ImportMapResourceSchema),
    schemaVersion: z.literal(TOOL_SCHEMA_VERSION),
    stackName: z.string().min(1),
    toolVersion: z.string().min(1),
    plan: GenerationPlanSchema.optional(),
  })
  .strict();

export const CdkResourceMappingSchema = z.record(z.record(z.string().min(1)));

export type CdkImportMapDocument = z.infer<typeof CdkImportMapDocumentSchema>;
export type CdkResourceMapping = z.infer<typeof CdkResourceMappingSchema>;
export type GeneratedCfnResource = z.infer<typeof GeneratedCfnResourceSchema>;
export type GeneratedCfnParameter = z.infer<typeof GeneratedCfnParameterSchema>;
export type GeneratedCfnTemplate = z.infer<typeof GeneratedCfnTemplateSchema>;
export type ImportMapResource = z.infer<typeof ImportMapResourceSchema>;
export type ImportBoundaryReference = z.infer<
  typeof ImportBoundaryReferenceSchema
>;
export type ImportStatus = z.infer<typeof ImportStatusSchema>;
export type GenerationPlan = z.infer<typeof GenerationPlanSchema>;
export type GenerationStack = z.infer<typeof GenerationStackSchema>;
export type GenerationReference = z.infer<typeof GenerationReferenceSchema>;
