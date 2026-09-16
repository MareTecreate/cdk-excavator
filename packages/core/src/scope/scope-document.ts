import type { InventoryResource } from "../model/schemas.js";
import { TOOL_SCHEMA_VERSION } from "../model/schemas.js";
import { inventoryResourceKey } from "../scan/inventory.js";
import {
  ScopeDocumentSchema,
  type ExternalReference,
  type ScopeDocument,
  type ScopeGraph,
  type ScopeGraphEdge,
  type ScopeGraphNode,
  type ScopeInclusionReason,
  type ScopeMode,
  type ScopeWarning,
  type ScopedResource,
} from "./schemas.js";

export interface CreateScopedResourceInput {
  readonly inclusionReasons: readonly ScopeInclusionReason[];
  readonly resource: InventoryResource;
}

export interface CreateScopeDocumentInput {
  readonly externalReferences?: readonly ExternalReference[];
  readonly graph?: Partial<ScopeGraph>;
  readonly mode: ScopeMode;
  readonly resources: readonly ScopedResource[];
  readonly toolVersion: string;
  readonly warnings?: readonly ScopeWarning[];
}

export function createScopedResource(
  input: CreateScopedResourceInput,
): ScopedResource {
  return {
    accountId: input.resource.accountId,
    identifier: input.resource.identifier,
    inclusionReasons: sortInclusionReasons(input.inclusionReasons),
    key: inventoryResourceKey(input.resource),
    region: input.resource.region,
    ...(input.resource.sourceRegion
      ? { sourceRegion: input.resource.sourceRegion }
      : {}),
    resourceType: input.resource.resourceType,
  };
}

export function createScopeDocument(
  input: CreateScopeDocumentInput,
): ScopeDocument {
  const resources = sortScopedResources(input.resources);
  const graph = normalizeGraph(input.graph, resources);

  return ScopeDocumentSchema.parse({
    externalReferences: sortExternalReferences(input.externalReferences ?? []),
    graph,
    mode: input.mode,
    resources,
    schemaVersion: TOOL_SCHEMA_VERSION,
    toolVersion: input.toolVersion,
    warnings: sortWarnings(input.warnings ?? []),
  });
}

export function scopedResourceKey(resource: ScopedResource): string {
  return resource.key;
}

function normalizeGraph(
  graph: Partial<ScopeGraph> | undefined,
  resources: readonly ScopedResource[],
): ScopeGraph {
  const resourceNodes = resources.map((resource) => ({
    key: scopedResourceKey(resource),
  }));

  return {
    cycles: sortCycles(graph?.cycles ?? []),
    edges: sortGraphEdges(graph?.edges ?? []),
    nodes: sortGraphNodes(graph?.nodes ?? resourceNodes),
  };
}

function sortScopedResources(
  resources: readonly ScopedResource[],
): ScopedResource[] {
  return [...resources].sort((left, right) =>
    scopedResourceKey(left).localeCompare(scopedResourceKey(right)),
  );
}

function sortInclusionReasons(
  reasons: readonly ScopeInclusionReason[],
): ScopeInclusionReason[] {
  return [...reasons].sort((left, right) =>
    inclusionReasonKey(left).localeCompare(inclusionReasonKey(right)),
  );
}

function sortGraphNodes(nodes: readonly ScopeGraphNode[]): ScopeGraphNode[] {
  return [...nodes].sort((left, right) => left.key.localeCompare(right.key));
}

function sortGraphEdges(edges: readonly ScopeGraphEdge[]): ScopeGraphEdge[] {
  return [...edges].sort((left, right) =>
    graphEdgeKey(left).localeCompare(graphEdgeKey(right)),
  );
}

function sortCycles(cycles: readonly (readonly string[])[]): string[][] {
  return cycles
    .map((cycle) => [...cycle])
    .sort((left, right) =>
      left.join("\u0000").localeCompare(right.join("\u0000")),
    );
}

function sortExternalReferences(
  references: readonly ExternalReference[],
): ExternalReference[] {
  return [...references].sort((left, right) =>
    externalReferenceKey(left).localeCompare(externalReferenceKey(right)),
  );
}

function sortWarnings(warnings: readonly ScopeWarning[]): ScopeWarning[] {
  return [...warnings].sort((left, right) =>
    warningKey(left).localeCompare(warningKey(right)),
  );
}

function inclusionReasonKey(reason: ScopeInclusionReason): string {
  return [reason.type, reason.sourceKey ?? "", reason.detail ?? ""].join(
    "\u0000",
  );
}

function graphEdgeKey(edge: ScopeGraphEdge): string {
  return [
    edge.from,
    edge.to,
    edge.type,
    edge.path ?? "",
    edge.value ?? "",
  ].join("\u0000");
}

function externalReferenceKey(reference: ExternalReference): string {
  return [
    reference.referencedBy,
    reference.type,
    reference.value,
    reference.boundaryHandling,
  ].join("\u0000");
}

function warningKey(warning: ScopeWarning): string {
  return [warning.resourceKey ?? "", warning.code, warning.message].join(
    "\u0000",
  );
}
