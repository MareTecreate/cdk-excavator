import { z } from "zod";
import {
  boundedArray,
  boundedJson,
  boundedRecord,
} from "../model/bounded-schema.js";

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
    vpcIds: boundedArray(z.string()),
    availabilityZones: boundedArray(z.string()),
    resourceKeys: boundedArray(z.string()),
    reviewReasons: boundedArray(z.string()),
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

export const GenerationPlanSchema = boundedJson(
  z
    .object({
      schemaVersion: z.literal(TOOL_SCHEMA_VERSION),
      maxResourcesPerStack: z.number().int().positive().max(500),
      stacks: boundedArray(GenerationStackSchema),
      references: boundedArray(GenerationReferenceSchema),
      warnings: boundedArray(z.string()),
    })
    .strict(),
);

export const GeneratedCfnResourceSchema = z
  .object({
    DeletionPolicy: z.literal("Retain"),
    Metadata: z
      .object({
        "cdk-excavator": z
          .object({
            gapCodes: boundedArray(z.string().min(1)).default([]),
            identifier: z.string().min(1),
            resourceKey: z.string().min(1),
            referenceNotes: boundedArray(z.string()).optional(),
          })
          .strict(),
      })
      .strict(),
    Properties: boundedRecord(z.string(), z.unknown()).default({}),
    DependsOn: boundedArray(z.string()).optional(),
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

export const GeneratedCfnTemplateSchema = boundedJson(
  z
    .object({
      AWSTemplateFormatVersion: z.literal("2010-09-09"),
      Description: z.string().min(1),
      Parameters: boundedRecord(
        z.string(),
        GeneratedCfnParameterSchema,
      ).optional(),
      Outputs: boundedRecord(
        z.string(),
        z
          .object({
            Value: z.unknown().optional(),
            Export: z.object({ Name: z.string() }).strict(),
          })
          .strict(),
      ).optional(),
      Resources: boundedRecord(z.string(), GeneratedCfnResourceSchema),
    })
    .strict(),
);

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
    importIdentifiers: boundedRecord(z.string(), z.string().min(1)),
    logicalId: z.string().min(1),
    region: z.string().min(1),
    resourceKey: z.string().min(1),
    resourceType: z.string().regex(/^AWS::[A-Za-z0-9]+::[A-Za-z0-9]+$/),
    reviewReasons: boundedArray(z.string().min(1)).default([]),
    status: ImportStatusSchema,
    stackName: z.string().optional(),
  })
  .strict();

export const CdkImportMapDocumentSchema = boundedJson(
  z
    .object({
      externalReferences: boundedArray(ImportBoundaryReferenceSchema).default(
        [],
      ),
      resources: boundedArray(ImportMapResourceSchema),
      schemaVersion: z.literal(TOOL_SCHEMA_VERSION),
      stackName: z.string().min(1),
      toolVersion: z.string().min(1),
      plan: GenerationPlanSchema.optional(),
    })
    .strict(),
);

export const CdkResourceMappingSchema = boundedJson(
  boundedRecord(z.string(), boundedRecord(z.string(), z.string().min(1))),
);

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
