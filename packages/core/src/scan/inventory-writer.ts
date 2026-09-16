import { mkdir, writeFile } from "node:fs/promises";
import { dirname } from "node:path";

import {
  InventoryDocumentSchema,
  type InventoryDocument,
  type InventoryResource,
  type ScanError,
  type SourceApi,
} from "../model/schemas.js";

export interface WriteInventoryFileInput {
  readonly document: InventoryDocument;
  readonly outputPath: string;
}

export async function writeInventoryFile(
  input: WriteInventoryFileInput,
): Promise<void> {
  await mkdir(dirname(input.outputPath), { recursive: true });
  await writeFile(input.outputPath, formatInventoryDocument(input.document), {
    encoding: "utf8",
  });
}

export function formatInventoryDocument(document: InventoryDocument): string {
  const parsed = InventoryDocumentSchema.parse(document);

  return `${JSON.stringify(toInventoryDocumentJson(parsed), null, 2)}\n`;
}

type JsonValue =
  | null
  | boolean
  | number
  | string
  | readonly JsonValue[]
  | { readonly [key: string]: JsonValue };

function toInventoryDocumentJson(
  document: InventoryDocument,
): Record<string, JsonValue> {
  return omitUndefined({
    schemaVersion: document.schemaVersion,
    toolVersion: document.toolVersion,
    generatedAt: document.generatedAt,
    resources: document.resources.map(toInventoryResourceJson),
  });
}

function toInventoryResourceJson(
  resource: InventoryResource,
): Record<string, JsonValue> {
  return omitUndefined({
    resourceType: resource.resourceType,
    identifier: resource.identifier,
    accountId: resource.accountId,
    region: resource.region,
    sourceRegion: resource.sourceRegion,
    collectionNotes: resource.collectionNotes,
    properties: toSortedJsonObject(resource.properties, "properties"),
    tags: toSortedJsonObject(resource.tags, "tags"),
    sourceApi: toSourceApiJson(resource.sourceApi),
    isCloudFormationManaged: resource.isCloudFormationManaged,
    errors: resource.errors.map(toScanErrorJson),
  });
}

function toSourceApiJson(sourceApi: SourceApi): Record<string, JsonValue> {
  return {
    service: sourceApi.service,
    operation: sourceApi.operation,
  };
}

function toScanErrorJson(error: ScanError): Record<string, JsonValue> {
  return {
    code: error.code,
    message: error.message,
    retryable: error.retryable,
  };
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

function toSortedJsonObject(
  value: Record<string, unknown>,
  path: string,
): Record<string, JsonValue> {
  const result: Record<string, JsonValue> = {};

  for (const key of Object.keys(value).sort()) {
    Object.defineProperty(result, key, {
      value: toJsonValue(value[key], `${path}.${key}`),
      enumerable: true,
      configurable: true,
      writable: true,
    });
  }

  return result;
}

function toJsonValue(value: unknown, path: string): JsonValue {
  if (
    value === null ||
    typeof value === "string" ||
    typeof value === "boolean"
  ) {
    return value;
  }

  if (typeof value === "number") {
    if (!Number.isFinite(value)) {
      throw new Error(`Inventory JSON contains a non-finite number at ${path}`);
    }

    return value;
  }

  if (Array.isArray(value)) {
    return value.map((entry, index) => toJsonValue(entry, `${path}[${index}]`));
  }

  if (isPlainObject(value)) {
    return toSortedJsonObject(value, path);
  }

  throw new Error(
    `Inventory JSON contains a non-serializable value at ${path}`,
  );
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  if (!value || typeof value !== "object") {
    return false;
  }

  const prototype = Object.getPrototypeOf(value) as unknown;
  return prototype === Object.prototype || prototype === null;
}
