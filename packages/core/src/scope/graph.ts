import type { InventoryResource } from "../model/schemas.js";
import { inventoryResourceKey } from "../scan/inventory.js";
import {
  extractResourceReferences,
  createReferenceResolver,
} from "./resource-references.js";
import { coreMessages } from "../messages.js";
import {
  ScopeGraphSchema,
  type ScopeGraph,
  type ScopeGraphEdge,
  type ScopeGraphNode,
} from "./schemas.js";

export interface BuildResourceGraphInput {
  readonly edges?: readonly ScopeGraphEdge[];
  readonly resources: readonly InventoryResource[];
}

export function buildResourceGraph(input: BuildResourceGraphInput): ScopeGraph {
  const nodes = sortGraphNodes(input.resources.map(toScopeGraphNode));
  if (new Set(nodes.map((node) => node.key)).size !== nodes.length)
    throw new Error(coreMessages.t("core.scope.duplicate"));
  const edges = sortGraphEdges(input.edges ?? []);

  return ScopeGraphSchema.parse({
    cycles: detectCycles({ edges, nodes }),
    edges,
    nodes,
  });
}

export function buildReferenceGraph(
  resources: readonly InventoryResource[],
): ScopeGraph {
  return buildResourceGraph({
    edges: createReferenceEdges(resources),
    resources,
  });
}

export function toScopeGraphNode(resource: InventoryResource): ScopeGraphNode {
  return {
    key: inventoryResourceKey(resource),
  };
}

export function detectCycles(input: {
  readonly edges: readonly ScopeGraphEdge[];
  readonly nodes: readonly ScopeGraphNode[];
}): string[][] {
  const adjacency = createAdjacency(input);
  const visited = new Set<string>();
  const visiting = new Set<string>();
  const path: string[] = [];
  const cycles = new Map<string, string[]>();

  for (const node of sortGraphNodes(input.nodes)) {
    visitNode(node.key, {
      adjacency,
      cycles,
      path,
      visited,
      visiting,
    });
  }

  return [...cycles.values()].sort((left, right) =>
    cycleKey(left).localeCompare(cycleKey(right)),
  );
}

function visitNode(
  key: string,
  context: {
    readonly adjacency: ReadonlyMap<string, readonly string[]>;
    readonly cycles: Map<string, string[]>;
    readonly path: string[];
    readonly visited: Set<string>;
    readonly visiting: Set<string>;
  },
): void {
  if (context.visiting.has(key)) {
    const cycleStart = context.path.indexOf(key);
    if (cycleStart >= 0) {
      const cycle = [...context.path.slice(cycleStart), key];
      context.cycles.set(canonicalCycleKey(cycle), cycle);
    }
    return;
  }

  if (context.visited.has(key)) {
    return;
  }

  context.visiting.add(key);
  context.path.push(key);

  for (const next of context.adjacency.get(key) ?? []) {
    visitNode(next, context);
  }

  context.path.pop();
  context.visiting.delete(key);
  context.visited.add(key);
}

function createAdjacency(input: {
  readonly edges: readonly ScopeGraphEdge[];
  readonly nodes: readonly ScopeGraphNode[];
}): ReadonlyMap<string, readonly string[]> {
  const nodeKeys = new Set(input.nodes.map((node) => node.key));
  const adjacency = new Map<string, string[]>();

  for (const nodeKey of nodeKeys) {
    adjacency.set(nodeKey, []);
  }

  for (const edge of input.edges) {
    if (!nodeKeys.has(edge.from) || !nodeKeys.has(edge.to)) {
      continue;
    }

    adjacency.get(edge.from)?.push(edge.to);
  }

  for (const [nodeKey, nextKeys] of adjacency.entries()) {
    adjacency.set(nodeKey, [...new Set(nextKeys)].sort());
  }

  return adjacency;
}

function createReferenceEdges(
  resources: readonly InventoryResource[],
): ScopeGraphEdge[] {
  const edges: ScopeGraphEdge[] = [];
  const resolve = createReferenceResolver(resources);

  for (const source of resources) {
    const sourceKey = inventoryResourceKey(source);

    for (const reference of extractResourceReferences(source)) {
      const resolved = resolve(source, reference);
      if (resolved.length !== 1) continue;

      for (const { target, attribute, suffix } of resolved) {
        const targetKey = inventoryResourceKey(target);

        if (targetKey === sourceKey) {
          continue;
        }

        edges.push({
          from: sourceKey,
          path: reference.path,
          to: targetKey,
          type: "reference",
          value: reference.value,
          propertyPath: reference.propertyPath,
          targetAttribute: attribute,
          valueSuffix: suffix,
        });
      }
    }
  }

  return edges;
}

function sortGraphNodes(nodes: readonly ScopeGraphNode[]): ScopeGraphNode[] {
  return [...nodes].sort((left, right) => left.key.localeCompare(right.key));
}

function sortGraphEdges(edges: readonly ScopeGraphEdge[]): ScopeGraphEdge[] {
  return [...edges].sort((left, right) =>
    graphEdgeKey(left).localeCompare(graphEdgeKey(right)),
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

function canonicalCycleKey(cycle: readonly string[]): string {
  const body = cycle[0] === cycle.at(-1) ? cycle.slice(0, -1) : [...cycle];
  const rotations = body.map((_, index) => [
    ...body.slice(index),
    ...body.slice(0, index),
  ]);
  const canonicalBody = rotations
    .map((rotation) => rotation.join("\u0000"))
    .sort()[0];

  return canonicalBody ?? cycleKey(cycle);
}

function cycleKey(cycle: readonly string[]): string {
  return cycle.join("\u0000");
}
