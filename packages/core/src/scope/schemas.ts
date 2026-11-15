import { z } from "zod";
import { boundedArray, boundedJson } from "../model/bounded-schema.js";

import { TOOL_SCHEMA_VERSION } from "../model/schemas.js";

export const ScopeModeSchema = z.enum(["all", "tag", "vpc", "seed"]);

export const ScopeInclusionReasonSchema = z
  .object({
    detail: z.string().min(1).optional(),
    sourceKey: z.string().min(1).optional(),
    type: z.enum(["mode", "dependency"]),
  })
  .strict();

export const ScopedResourceSchema = z
  .object({
    accountId: z
      .string()
      .regex(/^\d{12}$/)
      .optional(),
    identifier: z.string().min(1),
    inclusionReasons: boundedArray(ScopeInclusionReasonSchema, 1),
    key: z.string().min(1),
    region: z.string().min(1),
    sourceRegion: z.string().min(1).optional(),
    resourceType: z.string().regex(/^AWS::[A-Za-z0-9]+::[A-Za-z0-9]+$/),
    placement: z
      .object({
        vpcIds: boundedArray(z.string()),
        availabilityZones: boundedArray(z.string()),
      })
      .strict()
      .optional(),
  })
  .strict();

export const ScopeGraphNodeSchema = z
  .object({
    key: z.string().min(1),
  })
  .strict();

export const ScopeGraphEdgeSchema = z
  .object({
    from: z.string().min(1),
    path: z.string().min(1).optional(),
    to: z.string().min(1),
    type: z.enum(["reference", "schema", "service-rule"]),
    value: z.string().min(1).optional(),
    propertyPath: z.string().optional(),
    targetAttribute: z.string().optional(),
    valueSuffix: z.string().optional(),
  })
  .strict();

export const ScopeGraphSchema = z
  .object({
    cycles: boundedArray(boundedArray(z.string().min(1), 2)).default([]),
    edges: boundedArray(ScopeGraphEdgeSchema).default([]),
    nodes: boundedArray(ScopeGraphNodeSchema).default([]),
  })
  .strict();

export const BoundaryHandlingSchema = z.enum([
  "import-reference",
  "parameter",
  "include",
]);

export const ExternalReferenceSchema = z
  .object({
    boundaryHandling: BoundaryHandlingSchema.default("import-reference"),
    referencedBy: z.string().min(1),
    type: z.enum(["arn", "id"]),
    value: z.string().min(1),
    propertyPaths: boundedArray(z.string()).optional(),
    targetKey: z.string().optional(),
    targetResourceType: z.string().optional(),
    targetRegion: z.string().optional(),
    targetAttribute: z.string().optional(),
    valueSuffix: z.string().optional(),
    resolution: z.enum(["resolved", "missing", "ambiguous"]).optional(),
  })
  .strict();

export const ScopeWarningSchema = z
  .object({
    code: z.string().min(1),
    message: z.string().min(1),
    resourceKey: z.string().min(1).optional(),
  })
  .strict();

export const ScopeDocumentSchema = boundedJson(
  z
    .object({
      externalReferences: boundedArray(ExternalReferenceSchema).default([]),
      generatedAt: z.string().datetime().optional(),
      graph: ScopeGraphSchema.prefault({}),
      mode: ScopeModeSchema,
      resources: boundedArray(ScopedResourceSchema),
      schemaVersion: z.literal(TOOL_SCHEMA_VERSION),
      toolVersion: z.string().min(1),
      warnings: boundedArray(ScopeWarningSchema).default([]),
    })
    .strict(),
);

export type BoundaryHandling = z.infer<typeof BoundaryHandlingSchema>;
export type ExternalReference = z.infer<typeof ExternalReferenceSchema>;
export type ScopeDocument = z.infer<typeof ScopeDocumentSchema>;
export type ScopeGraph = z.infer<typeof ScopeGraphSchema>;
export type ScopeGraphEdge = z.infer<typeof ScopeGraphEdgeSchema>;
export type ScopeGraphNode = z.infer<typeof ScopeGraphNodeSchema>;
export type ScopeInclusionReason = z.infer<typeof ScopeInclusionReasonSchema>;
export type ScopeMode = z.infer<typeof ScopeModeSchema>;
export type ScopeWarning = z.infer<typeof ScopeWarningSchema>;
export type ScopedResource = z.infer<typeof ScopedResourceSchema>;
