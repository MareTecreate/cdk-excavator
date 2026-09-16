import type { InventoryDocument } from "../model/schemas.js";
import { inventoryResourceKey } from "../scan/inventory.js";
import { buildReferenceGraph } from "./graph.js";
import {
  extractResourceReferences,
  resourceAliases,
  resolveResourceReference,
  createReferenceResolver,
} from "./resource-references.js";
import { createPlacementResolver } from "./placement.js";
import { coreMessages } from "../messages.js";
import { createScopeDocument, createScopedResource } from "./scope-document.js";
import type {
  BoundaryHandling,
  ExternalReference,
  ScopeDocument,
  ScopeWarning,
  ScopedResource,
} from "./schemas.js";

const STACK_SPLIT_RESOURCE_THRESHOLD = 500;

export interface CreateAllScopeDocumentInput {
  readonly inventory: InventoryDocument;
  readonly regions?: readonly string[];
  readonly toolVersion?: string;
}

export interface ScopeTagFilter {
  readonly key: string;
  readonly value: string;
}

export type ScopeTagOperator = "and" | "or";

export interface CreateTagScopeDocumentInput {
  readonly inventory: InventoryDocument;
  readonly regions?: readonly string[];
  readonly operator: ScopeTagOperator;
  readonly tags: readonly ScopeTagFilter[];
  readonly toolVersion?: string;
  readonly withDependencies?: boolean;
}

export interface CreateVpcScopeDocumentInput {
  readonly inventory: InventoryDocument;
  readonly regions?: readonly string[];
  readonly toolVersion?: string;
  readonly vpcId: string;
}

export interface CreateSeedScopeDocumentInput {
  readonly depth: number;
  readonly inventory: InventoryDocument;
  readonly regions?: readonly string[];
  readonly seedIdentifier: string;
  readonly toolVersion?: string;
}

export interface BoundaryHandlingDecision {
  readonly boundaryHandling: BoundaryHandling;
  readonly referencedBy: string;
  readonly type: ExternalReference["type"];
  readonly value: string;
}

export interface ApplyBoundaryHandlingDecisionsInput {
  readonly decisions: readonly BoundaryHandlingDecision[];
  readonly document: ScopeDocument;
  readonly inventory: InventoryDocument;
}

export function createAllScopeDocument(
  input: CreateAllScopeDocumentInput,
): ScopeDocument {
  const selected = input.inventory.resources.filter((resource) =>
    inRegions(resource, input.regions),
  );
  const resources = createScopedResources(
    selected,
    "all",
    input.inventory.resources,
  );

  return createScopeDocument({
    externalReferences: createExternalReferences(
      selected,
      input.inventory.resources,
    ),
    graph: buildReferenceGraph(selected),
    mode: "all",
    resources,
    toolVersion: input.toolVersion ?? input.inventory.toolVersion,
    warnings: createStackSplitWarnings(resources),
  });
}

export function createTagScopeDocument(
  input: CreateTagScopeDocumentInput,
): ScopeDocument {
  if (input.tags.length === 0) {
    throw new Error("At least one tag filter is required for tag scope");
  }

  const tags = sortTagFilters(input.tags);
  const matchedResources = input.inventory.resources.filter(
    (resource) =>
      inRegions(resource, input.regions) &&
      matchesTags(resource.tags, tags, input.operator),
  );
  const resources = input.withDependencies
    ? collectDependencyResources(input.inventory.resources, matchedResources)
    : matchedResources;
  const scopedResources = createScopedResources(
    resources,
    `tag:${input.operator}:${formatTagFilters(tags)}${
      input.withDependencies ? ":with-deps" : ""
    }`,
    input.inventory.resources,
  );
  const matchedKeys = new Set(matchedResources.map(inventoryResourceKey));
  addDependencyReasons(
    scopedResources,
    matchedKeys,
    buildReferenceGraph(input.inventory.resources),
  );

  return createScopeDocument({
    externalReferences: createExternalReferences(
      resources,
      input.inventory.resources,
    ),
    graph: buildReferenceGraph(resources),
    mode: "tag",
    resources: scopedResources,
    toolVersion: input.toolVersion ?? input.inventory.toolVersion,
    warnings: createStackSplitWarnings(scopedResources),
  });
}

function collectDependencyResources(
  allResources: readonly InventoryDocument["resources"][number][],
  seedResources: readonly InventoryDocument["resources"][number][],
): InventoryDocument["resources"] {
  const inventoryGraph = buildReferenceGraph(allResources);
  const outgoingEdges = createOutgoingEdges(inventoryGraph.edges);
  const seedKeys = new Set(seedResources.map(inventoryResourceKey));
  const selectedKeys = collectReachableKeys(seedKeys, outgoingEdges);

  return allResources.filter((resource) =>
    selectedKeys.has(inventoryResourceKey(resource)),
  );
}

export function createSeedScopeDocument(
  input: CreateSeedScopeDocumentInput,
): ScopeDocument {
  if (!Number.isInteger(input.depth) || input.depth < 0) {
    throw new Error(
      `Seed depth must be a non-negative integer: ${input.depth}`,
    );
  }

  const seedKeys = new Set(
    input.inventory.resources
      .filter(
        (resource) =>
          inRegions(resource, input.regions) &&
          resourceAliases(resource).includes(input.seedIdentifier),
      )
      .map(inventoryResourceKey),
  );

  if (seedKeys.size === 0) {
    throw new Error(
      `Seed resource not found in inventory: ${input.seedIdentifier}`,
    );
  }
  if (seedKeys.size > 1)
    throw new Error(coreMessages.t("core.scope.ambiguous"));

  const inventoryGraph = buildReferenceGraph(input.inventory.resources);
  const outgoingEdges = createOutgoingEdges(inventoryGraph.edges);
  const selectedKeys = collectKeysByDepth(seedKeys, outgoingEdges, input.depth);
  const resources = input.inventory.resources.filter((resource) =>
    selectedKeys.has(inventoryResourceKey(resource)),
  );
  const scopedResources = createScopedResources(
    resources,
    `seed:${input.seedIdentifier}:depth=${input.depth}`,
    input.inventory.resources,
  );
  addDependencyReasons(scopedResources, seedKeys, inventoryGraph);

  return createScopeDocument({
    externalReferences: createExternalReferences(
      resources,
      input.inventory.resources,
    ),
    graph: buildReferenceGraph(resources),
    mode: "seed",
    resources: scopedResources,
    toolVersion: input.toolVersion ?? input.inventory.toolVersion,
    warnings: createStackSplitWarnings(scopedResources),
  });
}

export function createVpcScopeDocument(
  input: CreateVpcScopeDocumentInput,
): ScopeDocument {
  const inventoryGraph = buildReferenceGraph(input.inventory.resources);
  const targetVpcKeys = new Set(
    input.inventory.resources
      .filter(
        (resource) =>
          resource.resourceType === "AWS::EC2::VPC" &&
          inRegions(resource, input.regions) &&
          resource.identifier === input.vpcId,
      )
      .map(inventoryResourceKey),
  );

  if (targetVpcKeys.size === 0) {
    throw new Error(`VPC resource not found in inventory: ${input.vpcId}`);
  }
  if (targetVpcKeys.size > 1)
    throw new Error(coreMessages.t("core.scope.ambiguous"));
  const targetVpc = input.inventory.resources.find((resource) =>
    targetVpcKeys.has(inventoryResourceKey(resource)),
  )!;
  const placement = createPlacementResolver(
    input.inventory.resources,
    inventoryGraph,
  );

  const resources = input.inventory.resources.filter(
    (resource) =>
      resource.region === targetVpc.region &&
      placement(resource).vpcIds.includes(input.vpcId),
  );
  const scopedResources = createScopedResources(
    resources,
    `vpc:${input.vpcId}`,
    input.inventory.resources,
  );

  return createScopeDocument({
    externalReferences: createExternalReferences(
      resources,
      input.inventory.resources,
    ),
    graph: buildReferenceGraph(resources),
    mode: "vpc",
    resources: scopedResources,
    toolVersion: input.toolVersion ?? input.inventory.toolVersion,
    warnings: createStackSplitWarnings(scopedResources),
  });
}

export function canIncludeBoundaryReference(
  inventory: InventoryDocument,
  reference: ExternalReference,
): boolean {
  return resolveBoundaryTarget(inventory, reference) !== undefined;
}

export function applyBoundaryHandlingDecisions(
  input: ApplyBoundaryHandlingDecisionsInput,
): ScopeDocument {
  const decisionByReference = new Map<string, BoundaryHandlingDecision>();

  for (const decision of input.decisions) {
    const key = boundaryDecisionKey(decision);
    const existing = decisionByReference.get(key);

    if (existing && existing.boundaryHandling !== decision.boundaryHandling) {
      throw new Error(`Conflicting boundary decisions for ${decision.value}`);
    }

    decisionByReference.set(key, decision);
  }

  const scopedByKey = new Map(
    input.document.resources.map((resource) => [resource.key, resource]),
  );
  const selectedKeys = new Set(scopedByKey.keys());
  const includeReasons = new Map<
    string,
    Array<{ detail: string; sourceKey: string; type: "dependency" }>
  >();

  for (const reference of input.document.externalReferences) {
    const decision = decisionByReference.get(boundaryDecisionKey(reference));

    if (decision?.boundaryHandling !== "include") {
      continue;
    }

    const target = resolveBoundaryTarget(input.inventory, reference);

    if (!target) {
      throw new Error(
        `Boundary include target is missing or ambiguous: ${reference.value}`,
      );
    }

    const targetKey = inventoryResourceKey(target);
    selectedKeys.add(targetKey);
    const reasons = includeReasons.get(targetKey) ?? [];
    reasons.push({
      detail: `boundary:include:${reference.value}`,
      sourceKey: reference.referencedBy,
      type: "dependency",
    });
    includeReasons.set(targetKey, reasons);
  }

  const selectedResources = input.inventory.resources.filter((resource) =>
    selectedKeys.has(inventoryResourceKey(resource)),
  );
  const placement = createPlacementResolver(
    input.inventory.resources,
    buildReferenceGraph(input.inventory.resources),
  );
  const scopedResources = selectedResources.map((resource) => {
    const key = inventoryResourceKey(resource);
    const existing = scopedByKey.get(key);

    if (existing) {
      return existing;
    }

    return {
      ...createScopedResource({
        inclusionReasons: includeReasons.get(key) ?? [
          { detail: "boundary:include", type: "dependency" },
        ],
        resource,
      }),
      placement: placement(resource),
    };
  });
  const externalReferences = createExternalReferences(
    selectedResources,
    input.inventory.resources,
  ).map((reference) => ({
    ...reference,
    boundaryHandling:
      decisionByReference.get(boundaryDecisionKey(reference))
        ?.boundaryHandling ?? reference.boundaryHandling,
  }));
  const preservedWarnings = input.document.warnings.filter(
    (warning) => warning.code !== "SCOPE_STACK_SPLIT_RECOMMENDED",
  );

  return createScopeDocument({
    externalReferences,
    graph: buildReferenceGraph(selectedResources),
    mode: input.document.mode,
    resources: scopedResources,
    toolVersion: input.document.toolVersion,
    warnings: [
      ...preservedWarnings,
      ...createStackSplitWarnings(scopedResources),
    ],
  });
}

function createExternalReferences(
  scopedResources: readonly InventoryDocument["resources"][number][],
  allResources: readonly InventoryDocument["resources"][number][],
): ExternalReference[] {
  const includedKeys = new Set(scopedResources.map(inventoryResourceKey));
  const resolve = createReferenceResolver(allResources);
  const references = new Map<string, ExternalReference>();

  for (const source of scopedResources) {
    const sourceKey = inventoryResourceKey(source);

    for (const reference of extractResourceReferences(source)) {
      const targets = resolve(source, reference);
      const resolved = targets.length === 1 ? targets[0] : undefined;
      const targetKey = resolved
        ? inventoryResourceKey(resolved.target)
        : undefined;
      if (targetKey && includedKeys.has(targetKey)) continue;

      const externalReference: ExternalReference = {
        boundaryHandling: "import-reference",
        referencedBy: sourceKey,
        type: reference.type,
        value: reference.value,
        propertyPaths: reference.propertyPath ? [reference.propertyPath] : [],
        resolution: resolved
          ? "resolved"
          : targets.length
            ? "ambiguous"
            : "missing",
        ...(resolved
          ? {
              targetKey,
              targetResourceType: resolved.target.resourceType,
              targetRegion: resolved.target.region,
              targetAttribute: resolved.attribute,
              valueSuffix: resolved.suffix,
            }
          : {}),
      };
      const previous = references.get(externalReferenceKey(externalReference));
      if (previous) {
        externalReference.propertyPaths = [
          ...new Set([
            ...(previous.propertyPaths ?? []),
            ...(externalReference.propertyPaths ?? []),
          ]),
        ].sort();
        if (
          previous.targetKey !== externalReference.targetKey ||
          previous.resolution === "ambiguous"
        ) {
          externalReference.resolution = "ambiguous";
          delete externalReference.targetKey;
          delete externalReference.targetResourceType;
          delete externalReference.targetAttribute;
          delete externalReference.targetRegion;
          delete externalReference.valueSuffix;
        }
      }
      references.set(
        externalReferenceKey(externalReference),
        externalReference,
      );
    }
  }

  return [...references.values()].sort((left, right) =>
    externalReferenceKey(left).localeCompare(externalReferenceKey(right)),
  );
}

function resolveBoundaryTarget(
  inventory: InventoryDocument,
  reference: ExternalReference,
): InventoryDocument["resources"][number] | undefined {
  const source = inventory.resources.find(
    (resource) => inventoryResourceKey(resource) === reference.referencedBy,
  );
  if (!source || reference.resolution === "ambiguous") return undefined;
  const candidates = resolveResourceReference(
    source,
    { ...reference, targetType: reference.targetResourceType },
    inventory.resources,
  );
  return candidates.length === 1 && candidates[0]!.target !== source
    ? candidates[0]!.target
    : undefined;
}

function boundaryDecisionKey(
  reference: Pick<ExternalReference, "referencedBy" | "type" | "value">,
): string {
  return [reference.referencedBy, reference.type, reference.value].join(
    "\u0000",
  );
}

function externalReferenceKey(reference: ExternalReference): string {
  return [
    reference.referencedBy,
    reference.type,
    reference.value,
    reference.boundaryHandling,
  ].join("\u0000");
}

function createScopedResources(
  resources: InventoryDocument["resources"],
  detail: string,
  inventoryResources: InventoryDocument["resources"] = resources,
): ScopedResource[] {
  const graph = buildReferenceGraph(inventoryResources);
  const placement = createPlacementResolver(inventoryResources, graph);
  return resources.map((resource) => ({
    ...createScopedResource({
      inclusionReasons: [{ detail, type: "mode" }],
      resource,
    }),
    placement: placement(resource),
  }));
}

function addDependencyReasons(
  resources: ScopedResource[],
  roots: ReadonlySet<string>,
  graph: ScopeDocument["graph"],
): void {
  const selected = new Set(resources.map((resource) => resource.key));
  for (const resource of resources) {
    if (roots.has(resource.key)) continue;
    resource.inclusionReasons = graph.edges
      .filter((edge) => edge.to === resource.key && selected.has(edge.from))
      .map((edge) => ({
        type: "dependency" as const,
        sourceKey: edge.from,
        detail: edge.propertyPath ?? edge.path ?? edge.type,
      }));
  }
}

function createStackSplitWarnings(
  resources: readonly ScopedResource[],
): ScopeWarning[] {
  if (resources.length <= STACK_SPLIT_RESOURCE_THRESHOLD) {
    return [];
  }

  return [
    {
      code: "SCOPE_STACK_SPLIT_RECOMMENDED",
      message: `Scope contains ${resources.length} resources. Consider splitting generated CDK stacks before synthesis.`,
    },
  ];
}

function matchesTags(
  resourceTags: Record<string, string>,
  filters: readonly ScopeTagFilter[],
  operator: ScopeTagOperator,
): boolean {
  const matches = (filter: ScopeTagFilter) =>
    resourceTags[filter.key] === filter.value;

  return operator === "and" ? filters.every(matches) : filters.some(matches);
}

function sortTagFilters(filters: readonly ScopeTagFilter[]): ScopeTagFilter[] {
  return [...filters].sort((left, right) =>
    tagFilterKey(left).localeCompare(tagFilterKey(right)),
  );
}

function formatTagFilters(filters: readonly ScopeTagFilter[]): string {
  return filters.map(tagFilterKey).join(",");
}

function tagFilterKey(filter: ScopeTagFilter): string {
  return `${filter.key}=${filter.value}`;
}

function createOutgoingEdges(
  edges: ScopeDocument["graph"]["edges"],
): ReadonlyMap<string, readonly string[]> {
  const outgoingEdges = new Map<string, string[]>();

  for (const edge of edges) {
    const current = outgoingEdges.get(edge.from) ?? [];
    current.push(edge.to);
    outgoingEdges.set(edge.from, current);
  }

  return outgoingEdges;
}

function inRegions(
  resource: { region: string },
  regions?: readonly string[],
): boolean {
  return (
    !regions?.length ||
    resource.region === "global" ||
    regions.includes(resource.region)
  );
}

function collectKeysByDepth(
  seedKeys: ReadonlySet<string>,
  outgoingEdges: ReadonlyMap<string, readonly string[]>,
  depth: number,
): ReadonlySet<string> {
  const selectedKeys = new Set(seedKeys);
  const queue = [...seedKeys].map((key) => ({ depth: 0, key }));

  while (queue.length > 0) {
    const current = queue.shift();

    if (!current || current.depth >= depth) {
      continue;
    }

    for (const next of outgoingEdges.get(current.key) ?? []) {
      if (!selectedKeys.has(next)) {
        selectedKeys.add(next);
        queue.push({
          depth: current.depth + 1,
          key: next,
        });
      }
    }
  }

  return selectedKeys;
}

function collectReachableKeys(
  seedKeys: ReadonlySet<string>,
  outgoingEdges: ReadonlyMap<string, readonly string[]>,
): ReadonlySet<string> {
  const selectedKeys = new Set(seedKeys);
  const stack = [...seedKeys];

  while (stack.length > 0) {
    const current = stack.pop();

    if (!current) {
      continue;
    }

    for (const next of outgoingEdges.get(current) ?? []) {
      if (!selectedKeys.has(next)) {
        selectedKeys.add(next);
        stack.push(next);
      }
    }
  }

  return selectedKeys;
}
