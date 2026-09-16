import { mkdir, writeFile } from "node:fs/promises";
import { dirname } from "node:path";
import {
  formatScopeDocument,
  toExternalReferenceJson,
} from "../scope/scope-writer.js";

import {
  GapDocumentSchema,
  NormalizationModelDocumentSchema,
  type GapDocument,
  type GapFinding,
  type NormalizationModelDocument,
  type NormalizedResource,
} from "./schemas.js";

export interface WriteGapDocumentFileInput {
  readonly document: GapDocument;
  readonly outputPath: string;
}

export interface WriteNormalizationModelFileInput {
  readonly document: NormalizationModelDocument;
  readonly outputPath: string;
}

export async function writeGapDocumentFile(
  input: WriteGapDocumentFileInput,
): Promise<void> {
  await mkdir(dirname(input.outputPath), { recursive: true });
  await writeFile(input.outputPath, formatGapDocument(input.document), {
    encoding: "utf8",
  });
}

export async function writeNormalizationModelFile(
  input: WriteNormalizationModelFileInput,
): Promise<void> {
  await mkdir(dirname(input.outputPath), { recursive: true });
  await writeFile(input.outputPath, formatNormalizationModel(input.document), {
    encoding: "utf8",
  });
}

export function formatGapDocument(document: GapDocument): string {
  const parsed = GapDocumentSchema.parse(document);

  return `${JSON.stringify(toGapDocumentJson(parsed), null, 2)}\n`;
}

export function formatNormalizationModel(
  document: NormalizationModelDocument,
): string {
  const parsed = NormalizationModelDocumentSchema.parse(document);

  return `${JSON.stringify(toNormalizationModelJson(parsed), null, 2)}\n`;
}

type JsonValue =
  | null
  | boolean
  | number
  | string
  | readonly JsonValue[]
  | { readonly [key: string]: JsonValue };

function toGapDocumentJson(document: GapDocument): Record<string, JsonValue> {
  return omitUndefined({
    schemaVersion: document.schemaVersion,
    toolVersion: document.toolVersion,
    generatedAt: document.generatedAt,
    coverage: toCoverageJson(document.coverage),
    gaps: document.gaps.map(toGapFindingJson),
  });
}

function toNormalizationModelJson(
  document: NormalizationModelDocument,
): Record<string, JsonValue> {
  return omitUndefined({
    schemaVersion: document.schemaVersion,
    toolVersion: document.toolVersion,
    generatedAt: document.generatedAt,
    coverage: toCoverageJson(document.coverage),
    scope: document.scope
      ? (JSON.parse(formatScopeDocument(document.scope)) as JsonValue)
      : undefined,
    externalReferences: document.externalReferences.map(
      toExternalReferenceJson,
    ),
    resources: document.resources.map(toNormalizedResourceJson),
  });
}

function toCoverageJson(
  coverage: GapDocument["coverage"],
): Record<string, JsonValue> {
  return {
    resources: {
      total: coverage.resources.total,
      codeable: coverage.resources.codeable,
      excluded: coverage.resources.excluded,
      score: coverage.resources.score,
    },
    properties: {
      total: coverage.properties.total,
      codeable: coverage.properties.codeable,
      excluded: coverage.properties.excluded,
      score: coverage.properties.score,
    },
  };
}

function toGapFindingJson(finding: GapFinding): Record<string, JsonValue> {
  return omitUndefined({
    code: finding.code,
    severity: finding.severity,
    source: finding.source,
    resourceKey: finding.resourceKey,
    resourceType: finding.resourceType,
    identifier: finding.identifier,
    region: finding.region,
    propertyPath: finding.propertyPath,
    message: finding.message,
    messageKey: finding.messageKey,
  });
}

function toNormalizedResourceJson(
  resource: NormalizedResource,
): Record<string, JsonValue> {
  return omitUndefined({
    key: resource.key,
    resourceType: resource.resourceType,
    identifier: resource.identifier,
    accountId: resource.accountId,
    region: resource.region,
    status: resource.status,
    gapCodes: resource.gapCodes,
    properties: toSortedJsonObject(resource.properties, "properties"),
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
      throw new Error(
        `Normalization JSON contains a non-finite number at ${path}`,
      );
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
    `Normalization JSON contains a non-serializable value at ${path}`,
  );
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  if (!value || typeof value !== "object") {
    return false;
  }

  const prototype = Object.getPrototypeOf(value) as unknown;
  return prototype === Object.prototype || prototype === null;
}
