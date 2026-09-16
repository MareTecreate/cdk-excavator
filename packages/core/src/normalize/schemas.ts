import { z } from "zod";

import { TOOL_SCHEMA_VERSION } from "../model/schemas.js";
import {
  ExternalReferenceSchema,
  ScopeDocumentSchema,
} from "../scope/schemas.js";

export const GapCodeSchema = z.enum([
  "GAP-1",
  "GAP-2",
  "GAP-3",
  "GAP-4",
  "GAP-5",
  "GAP-6",
  "GAP-7",
]);

export const GapSeveritySchema = z.enum([
  "info",
  "warning",
  "manual-action",
  "blocking",
]);

export const GapSourceSchema = z.enum(["inventory", "rule", "schema"]);

export const CfnResourceSchemaSchema = z
  .object({
    createOnlyProperties: z.array(z.string().min(1)).default([]),
    primaryIdentifier: z.array(z.string().min(1)).default([]),
    properties: z.record(z.unknown()).default({}),
    readOnlyProperties: z.array(z.string().min(1)).default([]),
    required: z.array(z.string().min(1)).default([]),
    typeName: z.string().regex(/^AWS::[A-Za-z0-9]+::[A-Za-z0-9]+$/),
    writeOnlyProperties: z.array(z.string().min(1)).default([]),
  })
  .passthrough();

export const GapPropertyRuleSchema = z
  .object({
    code: GapCodeSchema,
    message: z.string().min(1),
    propertyPath: z.string().min(1),
    resourceType: z.string().regex(/^AWS::[A-Za-z0-9]+::[A-Za-z0-9]+$/),
    severity: GapSeveritySchema.default("warning"),
  })
  .strict();

export const GapResourceRuleSchema = z
  .object({
    code: GapCodeSchema,
    message: z.string().min(1),
    regionsIn: z.array(z.string().min(1)).optional(),
    regionsNotIn: z.array(z.string().min(1)).optional(),
    resourceType: z.string().regex(/^AWS::[A-Za-z0-9]+::[A-Za-z0-9]+$/),
    severity: GapSeveritySchema.default("warning"),
  })
  .strict();

export const GapRuleSetSchema = z
  .object({
    propertyRules: z.array(GapPropertyRuleSchema).default([]),
    resourceRules: z.array(GapResourceRuleSchema).default([]),
    version: z.string().min(1).optional(),
  })
  .strict();

export const GapSuppressionSchema = z
  .object({
    code: GapCodeSchema.optional(),
    identifier: z.string().min(1).optional(),
    propertyPath: z.string().min(1).optional(),
    reason: z.string().min(1),
    resourceKey: z.string().min(1).optional(),
    resourceType: z
      .string()
      .regex(/^AWS::[A-Za-z0-9]+::[A-Za-z0-9]+$/)
      .optional(),
  })
  .strict()
  .refine(
    (suppression) =>
      suppression.code ||
      suppression.identifier ||
      suppression.propertyPath ||
      suppression.resourceKey ||
      suppression.resourceType,
    {
      message:
        "At least one of code, identifier, propertyPath, resourceKey, or resourceType is required.",
    },
  );

export const GapSuppressionSetSchema = z
  .object({
    suppressions: z.array(GapSuppressionSchema).default([]),
    version: z.string().min(1).optional(),
  })
  .strict();

export const GapFindingSchema = z
  .object({
    code: GapCodeSchema,
    identifier: z.string().min(1),
    message: z.string().min(1),
    messageKey: z.string().min(1).optional(),
    propertyPath: z.string().min(1).optional(),
    region: z.string().min(1),
    resourceKey: z.string().min(1),
    resourceType: z.string().regex(/^AWS::[A-Za-z0-9]+::[A-Za-z0-9]+$/),
    severity: GapSeveritySchema,
    source: GapSourceSchema,
  })
  .strict();

export const NormalizedResourceStatusSchema = z.enum([
  "codeable",
  "excluded",
  "manual",
]);

export const NormalizedResourceSchema = z
  .object({
    accountId: z
      .string()
      .regex(/^\d{12}$/)
      .optional(),
    gapCodes: z.array(GapCodeSchema).default([]),
    identifier: z.string().min(1),
    key: z.string().min(1),
    properties: z.record(z.unknown()).default({}),
    region: z.string().min(1),
    resourceType: z.string().regex(/^AWS::[A-Za-z0-9]+::[A-Za-z0-9]+$/),
    status: NormalizedResourceStatusSchema,
  })
  .strict();

export const CoverageSegmentSchema = z
  .object({
    codeable: z.number().int().nonnegative(),
    excluded: z.number().int().nonnegative(),
    score: z.number().min(0).max(1),
    total: z.number().int().nonnegative(),
  })
  .strict();

export const CoverageSummarySchema = z
  .object({
    properties: CoverageSegmentSchema,
    resources: CoverageSegmentSchema,
  })
  .strict();

export const NormalizationModelDocumentSchema = z
  .object({
    coverage: CoverageSummarySchema,
    externalReferences: z.array(ExternalReferenceSchema).default([]),
    generatedAt: z.string().datetime().optional(),
    resources: z.array(NormalizedResourceSchema),
    scope: ScopeDocumentSchema.optional(),
    schemaVersion: z.literal(TOOL_SCHEMA_VERSION),
    toolVersion: z.string().min(1),
  })
  .strict();

export const GapDocumentSchema = z
  .object({
    coverage: CoverageSummarySchema,
    gaps: z.array(GapFindingSchema),
    generatedAt: z.string().datetime().optional(),
    schemaVersion: z.literal(TOOL_SCHEMA_VERSION),
    toolVersion: z.string().min(1),
  })
  .strict();

export type CfnResourceSchema = z.infer<typeof CfnResourceSchemaSchema>;
export type CoverageSegment = z.infer<typeof CoverageSegmentSchema>;
export type CoverageSummary = z.infer<typeof CoverageSummarySchema>;
export type GapCode = z.infer<typeof GapCodeSchema>;
export type GapDocument = z.infer<typeof GapDocumentSchema>;
export type GapFinding = z.infer<typeof GapFindingSchema>;
export type GapPropertyRule = z.infer<typeof GapPropertyRuleSchema>;
export type GapResourceRule = z.infer<typeof GapResourceRuleSchema>;
export type GapRuleSet = z.infer<typeof GapRuleSetSchema>;
export type GapSeverity = z.infer<typeof GapSeveritySchema>;
export type GapSource = z.infer<typeof GapSourceSchema>;
export type GapSuppression = z.infer<typeof GapSuppressionSchema>;
export type GapSuppressionSet = z.infer<typeof GapSuppressionSetSchema>;
export type NormalizationModelDocument = z.infer<
  typeof NormalizationModelDocumentSchema
>;
export type NormalizedResource = z.infer<typeof NormalizedResourceSchema>;
export type NormalizedResourceStatus = z.infer<
  typeof NormalizedResourceStatusSchema
>;
