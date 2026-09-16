import { createHash } from "node:crypto";

import { TOOL_SCHEMA_VERSION } from "../model/schemas.js";
import { coreMessages } from "../messages.js";
import type {
  NormalizationModelDocument,
  NormalizedResource,
} from "../normalize/schemas.js";
import { extractResourceReferences } from "../scope/resource-references.js";
import { toKebabIdentifier, toPascalIdentifier } from "./naming.js";
import {
  GenerationPlanSchema,
  type GenerationPlan,
  type GenerationReference,
  type GenerationStack,
} from "./schemas.js";
import { canImportReference } from "./project-references.js";

const MAX_RESOURCES = 500;

export function createStackPlan(
  model: NormalizationModelDocument,
  baseName: string,
): GenerationPlan {
  const resources = model.resources
    .filter((resource) => resource.status === "codeable")
    .sort((a, b) => a.key.localeCompare(b.key));
  if (
    new Set(resources.map((resource) => resource.key)).size !== resources.length
  )
    throw new Error(coreMessages.t("core.scope.duplicate"));
  const scoped = new Map(
    model.scope?.resources.map((resource) => [resource.key, resource]) ?? [],
  );
  const partitions = new Map<
    string,
    {
      stack: Omit<GenerationStack, "stackName" | "fileBase">;
      resources: NormalizedResource[];
    }
  >();
  for (const resource of resources) {
    const scope = scoped.get(resource.key);
    const vpcIds = scope?.placement?.vpcIds ?? [];
    const kind =
      resource.region === "global"
        ? "global"
        : vpcIds.length === 1
          ? "vpc"
          : vpcIds.length > 1
            ? "unresolved"
            : "regional";
    const observedRegion =
      resource.region === "global" ? scope?.sourceRegion : resource.region;
    const region =
      observedRegion && /^[a-z]{2}(?:-[a-z]+)+-\d+$/.test(observedRegion)
        ? observedRegion
        : undefined;
    const key = JSON.stringify([
      resource.accountId ?? null,
      region ?? null,
      kind,
      vpcIds,
    ]);
    const current = partitions.get(key) ?? {
      stack: {
        kind,
        region,
        account: resource.accountId,
        vpcIds,
        availabilityZones: [],
        resourceKeys: [],
        reviewReasons: [],
      },
      resources: [],
    };
    current.resources.push(resource);
    current.stack.availabilityZones.push(
      ...(scope?.placement?.availabilityZones ?? []),
    );
    if (!region)
      current.stack.reviewReasons.push("environment-region-unresolved");
    if (!resource.accountId)
      current.stack.reviewReasons.push("environment-account-unresolved");
    if (!scope?.placement)
      current.stack.reviewReasons.push("placement-evidence-unavailable");
    if (vpcIds.length > 1)
      current.stack.reviewReasons.push("multiple-vpc-placement");
    partitions.set(key, current);
  }
  const stacks: GenerationStack[] = [];
  for (const [key, partition] of [...partitions].sort(([a], [b]) =>
    a.localeCompare(b),
  )) {
    const ordered = dependencyOrder(partition.resources, model);
    for (let offset = 0; offset < ordered.length; offset += MAX_RESOURCES) {
      const stackName = `${baseName.slice(0, 50)}${toPascalIdentifier(partition.stack.region ?? "Unresolved")}${toPascalIdentifier(partition.stack.kind)}${digest(key)}Part${Math.floor(offset / MAX_RESOURCES) + 1}`;
      stacks.push({
        ...partition.stack,
        stackName,
        fileBase: toKebabIdentifier(stackName),
        resourceKeys: ordered
          .slice(offset, offset + MAX_RESOURCES)
          .map((resource) => resource.key),
        availabilityZones: unique(
          ordered
            .slice(offset, offset + MAX_RESOURCES)
            .flatMap(
              (resource) =>
                scoped.get(resource.key)?.placement?.availabilityZones ?? [],
            ),
        ),
        reviewReasons: unique(partition.stack.reviewReasons),
      });
    }
  }
  if (stacks.length === 0)
    stacks.push({
      stackName: baseName,
      fileBase: toKebabIdentifier(baseName),
      kind: "unresolved",
      resourceKeys: [],
      vpcIds: [],
      availabilityZones: [],
      reviewReasons: ["empty-scope"],
    });
  if (stacks.length === 1) {
    stacks[0]!.stackName = baseName;
    stacks[0]!.fileBase = toKebabIdentifier(baseName);
  }

  const stackByResource = new Map(
    stacks.flatMap((stack) =>
      stack.resourceKeys.map((key) => [key, stack] as const),
    ),
  );
  const byKey = new Map(resources.map((resource) => [resource.key, resource]));
  const acceptedResources = new Map<string, Set<string>>();
  const acceptedStacks = new Map<string, Set<string>>();
  const references: GenerationReference[] = [];
  for (const edge of [...(model.scope?.graph.edges ?? [])].sort((a, b) =>
    JSON.stringify([a.from, a.to, a.propertyPath]).localeCompare(
      JSON.stringify([b.from, b.to, b.propertyPath]),
    ),
  )) {
    const source = byKey.get(edge.from);
    const sourceStack = stackByResource.get(edge.from);
    if (!source || !sourceStack || !edge.value) continue;
    const targetStack = stackByResource.get(edge.to);
    const reference: GenerationReference = {
      from: edge.from,
      to: edge.to,
      propertyPath: edge.propertyPath ?? "",
      value: edge.value,
      targetAttribute: edge.targetAttribute,
      targetResourceType: byKey.get(edge.to)?.resourceType,
      valueSuffix: edge.valueSuffix,
      sourceStack: sourceStack.stackName,
      targetStack: targetStack?.stackName,
      disposition: "unresolved",
    };
    if (
      !edge.propertyPath ||
      readPointer(source.properties, edge.propertyPath) !== edge.value
    ) {
      reference.disposition = "excluded-property";
      reference.reason = "reference-property-not-in-normalized-model";
    } else if (!targetStack) reference.reason = "target-not-codeable";
    else if (!edge.targetAttribute)
      reference.reason = "target-attribute-unverified";
    else if (reaches(edge.to, edge.from, acceptedResources)) {
      reference.disposition = "cycle-boundary";
      reference.reason = "resource-cycle-needs-review";
    } else if (sourceStack === targetStack) {
      reference.disposition = "internal-token";
      connect(acceptedResources, edge.from, edge.to);
    } else if (!sameEnvironment(sourceStack, targetStack)) {
      reference.disposition = "import-reference";
      reference.reason = "cross-environment-existing-reference";
    } else if (
      reaches(targetStack.stackName, sourceStack.stackName, acceptedStacks)
    ) {
      reference.disposition = "cycle-boundary";
      reference.reason = "stack-cycle-needs-review";
    } else {
      reference.disposition = "cross-stack-token";
      reference.exportName = `${targetStack.stackName}:Cdkx${digest(`${edge.to}:${edge.targetAttribute}`)}`;
      connect(acceptedResources, edge.from, edge.to);
      connect(acceptedStacks, sourceStack.stackName, targetStack.stackName);
    }
    references.push(reference);
  }
  for (const boundary of model.externalReferences) {
    const source = byKey.get(boundary.referencedBy);
    const stack = stackByResource.get(boundary.referencedBy);
    if (!source || !stack) continue;
    for (const path of boundary.propertyPaths ??
      findValuePaths(source.properties, boundary.value)) {
      const present = readPointer(source.properties, path) === boundary.value;
      references.push({
        from: source.key,
        to: boundary.targetKey,
        propertyPath: path,
        value: boundary.value,
        targetAttribute: boundary.targetAttribute,
        targetResourceType: boundary.targetResourceType,
        valueSuffix: boundary.valueSuffix,
        sourceStack: stack.stackName,
        disposition: !present
          ? "excluded-property"
          : boundary.resolution === "ambiguous"
            ? "unresolved"
            : boundary.boundaryHandling === "parameter"
              ? "parameter"
              : "import-reference",
        reason: !present
          ? "reference-property-not-in-normalized-model"
          : boundary.resolution === "ambiguous"
            ? "ambiguous-reference"
            : boundary.resolution === "missing"
              ? "unresolved-target"
              : undefined,
      });
    }
  }
  for (const resource of resources) {
    for (const path of extractResourceReferences(resource)
      .filter((reference) => reference.value === resource.identifier)
      .map((reference) => reference.propertyPath!)) {
      if (
        !references.some(
          (reference) =>
            reference.from === resource.key && reference.propertyPath === path,
        )
      )
        references.push({
          from: resource.key,
          to: resource.key,
          propertyPath: path,
          value: resource.identifier,
          sourceStack: stackByResource.get(resource.key)!.stackName,
          disposition: "cycle-boundary",
          reason: "self-identity-or-reference-needs-review",
        });
    }
  }
  for (const reference of references) {
    if (
      reference.disposition === "import-reference" &&
      !reference.reason &&
      !canImportReference(reference)
    )
      reference.reason = "literal-reference-no-import-helper";
  }
  return GenerationPlanSchema.parse({
    schemaVersion: TOOL_SCHEMA_VERSION,
    maxResourcesPerStack: MAX_RESOURCES,
    stacks,
    references: references.sort((a, b) =>
      JSON.stringify([a.from, a.propertyPath, a.to]).localeCompare(
        JSON.stringify([b.from, b.propertyPath, b.to]),
      ),
    ),
    warnings: unique([
      ...(model.scope ? [] : ["legacy-model-without-scope-evidence"]),
      ...references.flatMap((reference) =>
        reference.disposition === "unresolved" ||
        reference.disposition === "cycle-boundary"
          ? [reference.reason!]
          : [],
      ),
    ]),
  });
}

export function readPointer(value: unknown, pointer: string): unknown {
  if (!pointer.startsWith("/")) return undefined;
  let current = value;
  for (const key of pointer.slice(1).split("/").map(unescapePointer)) {
    if (!current || typeof current !== "object" || !Object.hasOwn(current, key))
      return undefined;
    current = (current as Record<string, unknown>)[key];
  }
  return current;
}

export function replacePointer(
  value: Record<string, unknown>,
  pointer: string,
  expected: string,
  replacement: unknown,
): void {
  if (readPointer(value, pointer) !== expected) return;
  const keys = pointer.slice(1).split("/").map(unescapePointer);
  let current: unknown = value;
  for (const key of keys.slice(0, -1))
    current = (current as Record<string, unknown>)[key];
  Object.defineProperty(current, keys.at(-1)!, {
    value: replacement,
    enumerable: true,
    writable: true,
    configurable: true,
  });
}

export function findValuePaths(
  value: unknown,
  target: string,
  prefix = "",
): string[] {
  if (value === target) return [prefix];
  if (!value || typeof value !== "object") return [];
  return Object.entries(value).flatMap(([key, entry]) =>
    findValuePaths(
      entry,
      target,
      `${prefix}/${key.replaceAll("~", "~0").replaceAll("/", "~1")}`,
    ),
  );
}

function dependencyOrder(
  resources: NormalizedResource[],
  model: NormalizationModelDocument,
): NormalizedResource[] {
  const byKey = new Map(resources.map((resource) => [resource.key, resource]));
  const adjacency = new Map<string, Set<string>>();
  for (const edge of model.scope?.graph.edges ?? [])
    if (byKey.has(edge.from) && byKey.has(edge.to))
      connect(adjacency, edge.from, edge.to);
  const visited = new Set<string>();
  const result: NormalizedResource[] = [];
  const visit = (key: string): void => {
    if (visited.has(key)) return;
    visited.add(key);
    for (const next of [...(adjacency.get(key) ?? [])].sort()) visit(next);
    result.push(byKey.get(key)!);
  };
  for (const key of [...byKey.keys()].sort()) visit(key);
  return result;
}

function sameEnvironment(a: GenerationStack, b: GenerationStack): boolean {
  return Boolean(
    a.account && a.region && a.account === b.account && a.region === b.region,
  );
}
function reaches(
  from: string,
  to: string,
  edges: ReadonlyMap<string, ReadonlySet<string>>,
): boolean {
  const pending = [from],
    visited = new Set<string>();
  while (pending.length) {
    const key = pending.pop()!;
    if (key === to) return true;
    if (visited.has(key)) continue;
    visited.add(key);
    pending.push(...(edges.get(key) ?? []));
  }
  return false;
}
function connect(
  edges: Map<string, Set<string>>,
  from: string,
  to: string,
): void {
  const targets = edges.get(from) ?? new Set<string>();
  targets.add(to);
  edges.set(from, targets);
}
function unique(values: string[]): string[] {
  return [...new Set(values)].sort();
}
function digest(value: string): string {
  return createHash("sha256").update(value).digest("hex").slice(0, 16);
}
function unescapePointer(value: string): string {
  return value.replaceAll("~1", "/").replaceAll("~0", "~");
}
