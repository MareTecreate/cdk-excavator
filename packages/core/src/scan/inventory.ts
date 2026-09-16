import {
  InventoryDocumentSchema,
  TOOL_SCHEMA_VERSION,
  type InventoryDocument,
  type InventoryResource,
} from "../model/schemas.js";

export interface CreateInventoryDocumentInput {
  readonly toolVersion: string;
  readonly resources: readonly InventoryResource[];
}

export function createInventoryDocument(
  input: CreateInventoryDocumentInput,
): InventoryDocument {
  return InventoryDocumentSchema.parse({
    schemaVersion: TOOL_SCHEMA_VERSION,
    toolVersion: input.toolVersion,
    resources: [...input.resources].sort(compareInventoryResources),
  });
}

export function compareInventoryResources(
  left: InventoryResource,
  right: InventoryResource,
): number {
  return inventoryResourceKey(left).localeCompare(inventoryResourceKey(right));
}

export function inventoryResourceKey(resource: InventoryResource): string {
  return [resource.region, resource.resourceType, resource.identifier].join(
    "\u0000",
  );
}
