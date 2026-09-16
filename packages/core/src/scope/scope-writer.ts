import { mkdir, writeFile } from "node:fs/promises";
import { dirname } from "node:path";

import {
  ScopeDocumentSchema,
  type ExternalReference,
  type ScopeDocument,
  type ScopeGraph,
  type ScopeGraphEdge,
  type ScopeGraphNode,
  type ScopeInclusionReason,
  type ScopeWarning,
  type ScopedResource,
} from "./schemas.js";

export interface WriteScopeDocumentFileInput {
  readonly document: ScopeDocument;
  readonly outputPath: string;
}

export async function writeScopeDocumentFile(
  input: WriteScopeDocumentFileInput,
): Promise<void> {
  await mkdir(dirname(input.outputPath), { recursive: true });
  await writeFile(input.outputPath, formatScopeDocument(input.document), {
    encoding: "utf8",
  });
}

export function formatScopeDocument(document: ScopeDocument): string {
  const parsed = ScopeDocumentSchema.parse(document);

  return `${JSON.stringify(toScopeDocumentJson(parsed), null, 2)}\n`;
}

type JsonValue =
  | null
  | boolean
  | number
  | string
  | readonly JsonValue[]
  | { readonly [key: string]: JsonValue };

function toScopeDocumentJson(
  document: ScopeDocument,
): Record<string, JsonValue> {
  return omitUndefined({
    schemaVersion: document.schemaVersion,
    toolVersion: document.toolVersion,
    generatedAt: document.generatedAt,
    mode: document.mode,
    resources: document.resources.map(toScopedResourceJson),
    externalReferences: document.externalReferences.map(
      toExternalReferenceJson,
    ),
    graph: toScopeGraphJson(document.graph),
    warnings: document.warnings.map(toScopeWarningJson),
  });
}

function toScopedResourceJson(
  resource: ScopedResource,
): Record<string, JsonValue> {
  return omitUndefined({
    key: resource.key,
    resourceType: resource.resourceType,
    identifier: resource.identifier,
    accountId: resource.accountId,
    region: resource.region,
    sourceRegion: resource.sourceRegion,
    placement: resource.placement,
    inclusionReasons: resource.inclusionReasons.map(toInclusionReasonJson),
  });
}

function toInclusionReasonJson(
  reason: ScopeInclusionReason,
): Record<string, JsonValue> {
  return omitUndefined({
    type: reason.type,
    sourceKey: reason.sourceKey,
    detail: reason.detail,
  });
}

export function toExternalReferenceJson(
  reference: ExternalReference,
): Record<string, JsonValue> {
  return omitUndefined({
    referencedBy: reference.referencedBy,
    type: reference.type,
    value: reference.value,
    boundaryHandling: reference.boundaryHandling,
    propertyPaths: reference.propertyPaths,
    targetKey: reference.targetKey,
    targetResourceType: reference.targetResourceType,
    targetRegion: reference.targetRegion,
    targetAttribute: reference.targetAttribute,
    valueSuffix: reference.valueSuffix,
    resolution: reference.resolution,
  });
}

function toScopeGraphJson(graph: ScopeGraph): Record<string, JsonValue> {
  return {
    nodes: graph.nodes.map(toScopeGraphNodeJson),
    edges: graph.edges.map(toScopeGraphEdgeJson),
    cycles: graph.cycles.map((cycle) => [...cycle]),
  };
}

function toScopeGraphNodeJson(node: ScopeGraphNode): Record<string, JsonValue> {
  return {
    key: node.key,
  };
}

function toScopeGraphEdgeJson(edge: ScopeGraphEdge): Record<string, JsonValue> {
  return omitUndefined({
    from: edge.from,
    to: edge.to,
    type: edge.type,
    path: edge.path,
    value: edge.value,
    propertyPath: edge.propertyPath,
    targetAttribute: edge.targetAttribute,
    valueSuffix: edge.valueSuffix,
  });
}

function toScopeWarningJson(warning: ScopeWarning): Record<string, JsonValue> {
  return omitUndefined({
    code: warning.code,
    message: warning.message,
    resourceKey: warning.resourceKey,
  });
}

function omitUndefined(
  value: Record<string, JsonValue | undefined>,
): Record<string, JsonValue> {
  const result: Record<string, JsonValue> = {};

  for (const [key, entry] of Object.entries(value)) {
    if (entry !== undefined) {
      result[key] = entry;
    }
  }

  return result;
}
