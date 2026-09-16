import type { InventoryDocument, InventoryResource } from "../model/schemas.js";
import { TOOL_SCHEMA_VERSION } from "../model/schemas.js";
import { coreMessages } from "../messages.js";
import { inventoryResourceKey } from "../scan/inventory.js";
import type { ScopeDocument } from "../scope/schemas.js";
import {
  CfnResourceSchemaSchema,
  GapDocumentSchema,
  GapRuleSetSchema,
  GapSuppressionSetSchema,
  NormalizationModelDocumentSchema,
  type CfnResourceSchema,
  type CoverageSummary,
  type GapCode,
  type GapDocument,
  type GapFinding,
  type GapResourceRule,
  type GapRuleSet,
  type GapSeverity,
  type GapSource,
  type GapSuppression,
  type GapSuppressionSet,
  type NormalizationModelDocument,
  type NormalizedResource,
  type NormalizedResourceStatus,
} from "./schemas.js";

export interface CreateNormalizationDocumentsInput {
  readonly gapRules?: GapRuleSet;
  readonly inventory: InventoryDocument;
  readonly schemas: readonly CfnResourceSchema[];
  readonly scope: ScopeDocument;
  readonly suppressions?: GapSuppressionSet;
  readonly toolVersion?: string;
}

export interface NormalizationDocuments {
  readonly gaps: GapDocument;
  readonly model: NormalizationModelDocument;
}

interface ResourceNormalization {
  readonly gaps: readonly GapFinding[];
  readonly normalized: NormalizedResource;
  readonly propertyCodeableCount: number;
  readonly propertyTotalCount: number;
}

export function createNormalizationDocuments(
  input: CreateNormalizationDocumentsInput,
): NormalizationDocuments {
  const schemasByType = createSchemasByType(input.schemas);
  const gapRules = GapRuleSetSchema.parse(input.gapRules ?? {});
  const suppressions = GapSuppressionSetSchema.parse(input.suppressions ?? {});
  const inventoryResources = createInventoryResourcesByKey(input.inventory);
  const normalizedResources: NormalizedResource[] = [];
  const gaps: GapFinding[] = [];
  let propertyCodeableCount = 0;
  let propertyTotalCount = 0;

  for (const scopedResource of input.scope.resources) {
    const resource = inventoryResources.get(scopedResource.key);

    if (!resource) {
      throw new Error(
        `Scoped resource is missing from inventory: ${scopedResource.key}`,
      );
    }

    const result = normalizeResource({
      gapRules,
      resource,
      schema: schemasByType.get(resource.resourceType),
      suppressions,
    });

    normalizedResources.push(result.normalized);
    gaps.push(...result.gaps);
    propertyCodeableCount += result.propertyCodeableCount;
    propertyTotalCount += result.propertyTotalCount;
  }

  const coverage = createCoverageSummary({
    normalizedResources,
    propertyCodeableCount,
    propertyTotalCount,
  });
  const toolVersion = input.toolVersion ?? input.scope.toolVersion;
  const scope = redactExcludedReferenceValues(input.scope, normalizedResources);
  const model = NormalizationModelDocumentSchema.parse({
    coverage,
    externalReferences: scope.externalReferences,
    resources: sortNormalizedResources(normalizedResources),
    scope,
    schemaVersion: TOOL_SCHEMA_VERSION,
    toolVersion,
  });
  const gapDocument = GapDocumentSchema.parse({
    coverage,
    gaps: sortGapFindings(dedupeGapFindings(gaps)),
    schemaVersion: TOOL_SCHEMA_VERSION,
    toolVersion,
  });

  return {
    gaps: gapDocument,
    model,
  };
}

function redactExcludedReferenceValues(
  scope: ScopeDocument,
  resources: readonly NormalizedResource[],
): ScopeDocument {
  const byKey = new Map(resources.map((resource) => [resource.key, resource]));
  const matches = (
    key: string,
    expected: string,
    pointer?: string,
  ): boolean => {
    const properties = byKey.get(key)?.properties;
    if (!properties) return false;
    if (!pointer) return containsValue(properties, expected);
    let current: unknown = properties;
    for (const part of pointer
      .slice(1)
      .split("/")
      .map(decodeJsonPointerSegment)) {
      if (
        !current ||
        typeof current !== "object" ||
        !Object.hasOwn(current, part)
      )
        return false;
      current = (current as Record<string, unknown>)[part];
    }
    return current === expected;
  };
  return {
    ...scope,
    externalReferences: scope.externalReferences.flatMap((reference) => {
      if (!reference.propertyPaths)
        return matches(reference.referencedBy, reference.value)
          ? [reference]
          : [];
      const paths = reference.propertyPaths.filter((path) =>
        matches(reference.referencedBy, reference.value, path),
      );
      return paths.length ? [{ ...reference, propertyPaths: paths }] : [];
    }),
    graph: {
      ...scope.graph,
      edges: scope.graph.edges.map((edge) => {
        if (
          !edge.value ||
          (edge.propertyPath &&
            matches(edge.from, edge.value, edge.propertyPath))
        )
          return edge;
        const redacted = { ...edge };
        delete redacted.value;
        return redacted;
      }),
    },
  };
}

function containsValue(value: unknown, expected: string): boolean {
  return (
    value === expected ||
    Boolean(
      value &&
      typeof value === "object" &&
      Object.values(value).some((entry) => containsValue(entry, expected)),
    )
  );
}

function createSchemasByType(
  schemas: readonly CfnResourceSchema[],
): ReadonlyMap<string, CfnResourceSchema> {
  const result = new Map<string, CfnResourceSchema>();

  for (const schema of schemas) {
    const parsed = CfnResourceSchemaSchema.parse(schema);
    if (result.has(parsed.typeName))
      throw new Error(`Duplicate CloudFormation schema: ${parsed.typeName}`);
    result.set(parsed.typeName, parsed);
  }

  return result;
}

function createInventoryResourcesByKey(
  inventory: InventoryDocument,
): ReadonlyMap<string, InventoryResource> {
  const result = new Map<string, InventoryResource>();

  for (const resource of inventory.resources) {
    result.set(inventoryResourceKey(resource), resource);
  }

  return result;
}

function normalizeResource(input: {
  readonly gapRules: GapRuleSet;
  readonly resource: InventoryResource;
  readonly schema?: CfnResourceSchema;
  readonly suppressions: GapSuppressionSet;
}): ResourceNormalization {
  const gaps: GapFinding[] = [];
  for (const note of input.resource.collectionNotes ?? []) {
    gaps.push(
      createGapFinding({
        ...note,
        message: coreMessages.t(note.messageKey),
        resource: input.resource,
        severity: note.code === "GAP-1" ? "manual-action" : "info",
        source: "inventory",
      }),
    );
  }

  if (input.resource.errors.length > 0) {
    gaps.push(
      createGapFinding({
        code: "GAP-3",
        messageKey: "core.gap.incomplete",
        message: coreMessages.t("core.gap.incomplete"),
        resource: input.resource,
        severity: "blocking",
        source: "inventory",
      }),
    );
  }

  if (!input.schema) {
    gaps.push(
      createGapFinding({
        code: "GAP-1",
        messageKey: "core.gap.unsupported",
        message: coreMessages.t("core.gap.unsupported"),
        resource: input.resource,
        severity: "blocking",
        source: "schema",
      }),
    );
  }

  if (input.resource.isCloudFormationManaged) {
    gaps.push(
      createGapFinding({
        code: "GAP-5",
        messageKey: "core.gap.managed",
        message: coreMessages.t("core.gap.managed"),
        resource: input.resource,
        severity: "manual-action",
        source: "inventory",
      }),
    );
  }

  if (input.schema) {
    gaps.push(...createSchemaGapFindings(input.resource, input.schema));
    gaps.push(
      ...createPropertyRuleGapFindings(input.resource, input.gapRules),
      ...createResourceRuleGapFindings(input.resource, input.gapRules),
    );
    const excluded = createExcludedPropertyPaths(
      input.resource,
      input.schema,
      input.gapRules,
    );
    for (const name of Object.keys(input.resource.properties).sort()) {
      const propertyPath = `/properties/${encodeJsonPointerSegment(name)}`;
      if (
        !Object.hasOwn(input.schema.properties, name) &&
        !excluded.has(propertyPath)
      ) {
        gaps.push(
          createGapFinding({
            code: "GAP-1",
            messageKey: "core.gap.unmapped",
            message: coreMessages.t("core.gap.unmapped"),
            propertyPath,
            resource: input.resource,
            severity: "manual-action",
            source: "schema",
          }),
        );
      }
    }
    for (const propertyPath of excluded) {
      if (
        pathExists(input.resource.properties, propertyPath) &&
        !gaps.some((gap) => gap.propertyPath === propertyPath)
      ) {
        gaps.push(
          createGapFinding({
            code: "GAP-4",
            messageKey: "core.gap.excluded",
            message: coreMessages.t("core.gap.excluded"),
            propertyPath,
            resource: input.resource,
            severity: "info",
            source: "schema",
          }),
        );
      }
    }
  }

  const visibleGaps = gaps.filter(
    (gap) => !isSuppressedGap(gap, input.suppressions.suppressions),
  );
  const status = createNormalizedResourceStatus(input.resource, input.schema);
  const excludedPropertyPaths = createExcludedPropertyPaths(
    input.resource,
    input.schema,
    input.gapRules,
  );
  const properties =
    input.schema && status === "codeable"
      ? projectProperties(input.resource.properties, input.schema, {
          excludedPropertyPaths,
        })
      : {};
  const propertyTotalCount =
    input.schema && !input.resource.isCloudFormationManaged
      ? Object.keys(input.resource.properties).length
      : 0;
  const propertyCodeableCount = Object.keys(properties).length;

  return {
    gaps: visibleGaps,
    normalized: {
      accountId: input.resource.accountId,
      gapCodes: sortGapCodes(visibleGaps.map((gap) => gap.code)),
      identifier: input.resource.identifier,
      key: inventoryResourceKey(input.resource),
      properties,
      region: input.resource.region,
      resourceType: input.resource.resourceType,
      status,
    },
    propertyCodeableCount,
    propertyTotalCount,
  };
}

function createSchemaGapFindings(
  resource: InventoryResource,
  schema: CfnResourceSchema,
): GapFinding[] {
  const gaps: GapFinding[] = [];
  const writeOnlyProperties = new Set(schema.writeOnlyProperties);

  for (const propertyPath of schema.writeOnlyProperties) {
    const required = schema.required.some(
      (name) =>
        propertyPath === `/properties/${encodeJsonPointerSegment(name)}`,
    );
    gaps.push(
      createGapFinding({
        code: "GAP-2",
        messageKey: required
          ? "core.gap.requiredWriteOnly"
          : "core.gap.optionalWriteOnly",
        message: coreMessages.t(
          required
            ? "core.gap.requiredWriteOnly"
            : "core.gap.optionalWriteOnly",
        ),
        propertyPath,
        resource,
        severity: required ? "manual-action" : "warning",
        source: "schema",
      }),
    );
  }

  for (const propertyName of [...schema.required].sort()) {
    const propertyPath = `/properties/${encodeJsonPointerSegment(propertyName)}`;

    if (
      !writeOnlyProperties.has(propertyPath) &&
      !Object.hasOwn(resource.properties, propertyName)
    ) {
      gaps.push(
        createGapFinding({
          code: "GAP-3",
          messageKey: "core.gap.requiredMissing",
          message: coreMessages.t("core.gap.requiredMissing"),
          propertyPath,
          resource,
          severity: "manual-action",
          source: "schema",
        }),
      );
    }
  }

  for (const propertyPath of schema.createOnlyProperties) {
    if (pathExists(resource.properties, propertyPath)) {
      gaps.push(
        createGapFinding({
          code: "GAP-7",
          messageKey: "core.gap.createOnly",
          message: coreMessages.t("core.gap.createOnly"),
          propertyPath,
          resource,
          severity: "warning",
          source: "schema",
        }),
      );
    }
  }

  return gaps;
}

function createPropertyRuleGapFindings(
  resource: InventoryResource,
  gapRules: GapRuleSet,
): GapFinding[] {
  return gapRules.propertyRules
    .filter(
      (rule) =>
        rule.resourceType === resource.resourceType &&
        pathExists(resource.properties, rule.propertyPath),
    )
    .map((rule) =>
      createGapFinding({
        code: rule.code,
        message: rule.message,
        propertyPath: rule.propertyPath,
        resource,
        severity: rule.severity,
        source: "rule",
      }),
    );
}

function createResourceRuleGapFindings(
  resource: InventoryResource,
  gapRules: GapRuleSet,
): GapFinding[] {
  return gapRules.resourceRules
    .filter((rule) => resourceRuleMatches(resource, rule))
    .map((rule) =>
      createGapFinding({
        code: rule.code,
        message: rule.message,
        resource,
        severity: rule.severity,
        source: "rule",
      }),
    );
}

function resourceRuleMatches(
  resource: InventoryResource,
  rule: GapResourceRule,
): boolean {
  if (rule.resourceType !== resource.resourceType) {
    return false;
  }

  if (rule.regionsIn && !rule.regionsIn.includes(resource.region)) {
    return false;
  }

  if (rule.regionsNotIn && rule.regionsNotIn.includes(resource.region)) {
    return false;
  }

  return true;
}

function createNormalizedResourceStatus(
  resource: InventoryResource,
  schema: CfnResourceSchema | undefined,
): NormalizedResourceStatus {
  if (resource.isCloudFormationManaged) {
    return "excluded";
  }

  if (resource.errors.length > 0) return "manual";

  if (!schema) {
    return "manual";
  }

  return "codeable";
}

function createExcludedPropertyPaths(
  resource: InventoryResource,
  schema: CfnResourceSchema | undefined,
  gapRules: GapRuleSet,
): ReadonlySet<string> {
  const excluded = new Set(schema?.readOnlyProperties ?? []);

  for (const propertyPath of schema?.writeOnlyProperties ?? []) {
    excluded.add(propertyPath);
  }

  for (const rule of gapRules.propertyRules) {
    if (
      rule.code === "GAP-4" &&
      rule.resourceType === resource.resourceType &&
      pathExists(resource.properties, rule.propertyPath)
    ) {
      excluded.add(rule.propertyPath);
    }
  }

  return excluded;
}

function projectProperties(
  properties: Record<string, unknown>,
  schema: CfnResourceSchema,
  options: { readonly excludedPropertyPaths: ReadonlySet<string> },
): Record<string, unknown> {
  const result: Record<string, unknown> = {};
  const schemaPropertyNames = new Set(Object.keys(schema.properties));
  const excludedPaths = [...options.excludedPropertyPaths].map((pointer) => {
    const segments = parsePropertyPointer(pointer);
    if (!segments) throw new Error("Invalid property exclusion pointer.");
    return segments;
  });

  for (const propertyName of Object.keys(properties).sort()) {
    const propertyPath = `/properties/${encodeJsonPointerSegment(propertyName)}`;

    if (
      schemaPropertyNames.has(propertyName) &&
      !options.excludedPropertyPaths.has(propertyPath)
    ) {
      const projected = projectValue(
        properties[propertyName],
        childPaths(excludedPaths, propertyName),
      );
      if (projected !== OMIT_PROPERTY) {
        Object.defineProperty(result, propertyName, {
          value: projected,
          enumerable: true,
        });
      }
    }
  }

  return result;
}

function createCoverageSummary(input: {
  readonly normalizedResources: readonly NormalizedResource[];
  readonly propertyCodeableCount: number;
  readonly propertyTotalCount: number;
}): CoverageSummary {
  const totalResources = input.normalizedResources.length;
  const codeableResources = input.normalizedResources.filter(
    (resource) => resource.status === "codeable",
  ).length;
  const excludedResources = totalResources - codeableResources;
  const excludedProperties =
    input.propertyTotalCount - input.propertyCodeableCount;

  return {
    properties: {
      codeable: input.propertyCodeableCount,
      excluded: excludedProperties,
      score: createScore(input.propertyCodeableCount, input.propertyTotalCount),
      total: input.propertyTotalCount,
    },
    resources: {
      codeable: codeableResources,
      excluded: excludedResources,
      score: createScore(codeableResources, totalResources),
      total: totalResources,
    },
  };
}

function createScore(codeable: number, total: number): number {
  if (total === 0) {
    return 1;
  }

  return Math.round((codeable / total) * 10_000) / 10_000;
}

function createGapFinding(input: {
  readonly code: GapCode;
  readonly message: string;
  readonly messageKey?: string;
  readonly propertyPath?: string;
  readonly resource: InventoryResource;
  readonly severity: GapSeverity;
  readonly source: GapSource;
}): GapFinding {
  return {
    code: input.code,
    identifier: input.resource.identifier,
    message: input.message,
    ...(input.messageKey ? { messageKey: input.messageKey } : {}),
    propertyPath: input.propertyPath,
    region: input.resource.region,
    resourceKey: inventoryResourceKey(input.resource),
    resourceType: input.resource.resourceType,
    severity: input.severity,
    source: input.source,
  };
}

function isSuppressedGap(
  gap: GapFinding,
  suppressions: readonly GapSuppression[],
): boolean {
  return suppressions.some((suppression) =>
    suppressionMatchesGap(suppression, gap),
  );
}

function suppressionMatchesGap(
  suppression: GapSuppression,
  gap: GapFinding,
): boolean {
  return (
    matchesOptional(suppression.code, gap.code) &&
    matchesOptional(suppression.identifier, gap.identifier) &&
    matchesOptional(suppression.propertyPath, gap.propertyPath) &&
    matchesOptional(suppression.resourceKey, gap.resourceKey) &&
    matchesOptional(suppression.resourceType, gap.resourceType)
  );
}

function matchesOptional<T>(
  expected: T | undefined,
  actual: T | undefined,
): boolean {
  return expected === undefined || expected === actual;
}

function pathExists(
  properties: Record<string, unknown>,
  pointer: string,
): boolean {
  const segments = parsePropertyPointer(pointer);

  if (!segments) {
    return false;
  }

  return pathExistsAt(properties, segments);
}

function parsePropertyPointer(pointer: string): string[] | undefined {
  if (!pointer.startsWith("/properties/") || /~(?![01])/.test(pointer))
    return undefined;
  const segments = pointer.split("/").slice(1).map(decodeJsonPointerSegment);

  if (segments[0] !== "properties" || segments.length < 2) {
    return undefined;
  }

  return segments.slice(1);
}

function encodeJsonPointerSegment(segment: string): string {
  return segment.replaceAll("~", "~0").replaceAll("/", "~1");
}

function decodeJsonPointerSegment(segment: string): string {
  return segment.replaceAll("~1", "/").replaceAll("~0", "~");
}

function sortNormalizedResources(
  resources: readonly NormalizedResource[],
): NormalizedResource[] {
  return [...resources].sort((left, right) =>
    left.key.localeCompare(right.key),
  );
}

function sortGapCodes(codes: readonly GapCode[]): GapCode[] {
  return [...new Set(codes)].sort();
}

function dedupeGapFindings(gaps: readonly GapFinding[]): GapFinding[] {
  const result = new Map<string, GapFinding>();

  for (const gap of gaps) {
    result.set(gapFindingKey(gap), gap);
  }

  return [...result.values()];
}

function sortGapFindings(gaps: readonly GapFinding[]): GapFinding[] {
  return [...gaps].sort((left, right) =>
    gapFindingKey(left).localeCompare(gapFindingKey(right)),
  );
}

function gapFindingKey(gap: GapFinding): string {
  return [
    gap.code,
    gap.resourceKey,
    gap.propertyPath ?? "",
    gap.source,
    gap.message,
  ].join("\u0000");
}

const OMIT_PROPERTY = Symbol("omitted-property");

function childPaths(paths: readonly string[][], key: string): string[][] {
  return paths
    .filter((path) => path[0] === key || path[0] === "*")
    .map((path) => path.slice(1));
}

function pathExistsAt(value: unknown, segments: readonly string[]): boolean {
  if (segments.length === 0) return true;
  if (value === null || typeof value !== "object") return false;
  const [head, ...tail] = segments;
  if (head === "*")
    return Object.values(value).some((item) => pathExistsAt(item, tail));
  return (
    head !== undefined &&
    Object.hasOwn(value, head) &&
    pathExistsAt((value as Record<string, unknown>)[head], tail)
  );
}

function projectValue(value: unknown, excluded: readonly string[][]): unknown {
  if (excluded.some((path) => path.length === 0)) return OMIT_PROPERTY;
  if (Array.isArray(value)) {
    return value
      .map((item, index) =>
        projectValue(item, childPaths(excluded, String(index))),
      )
      .filter((item) => item !== OMIT_PROPERTY);
  }

  if (isPlainObject(value)) {
    const result: Record<string, unknown> = {};

    for (const key of Object.keys(value).sort()) {
      const projected = projectValue(value[key], childPaths(excluded, key));
      if (projected !== OMIT_PROPERTY) {
        Object.defineProperty(result, key, {
          value: projected,
          enumerable: true,
        });
      }
    }

    return result;
  }

  return value;
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  if (!value || typeof value !== "object") {
    return false;
  }

  const prototype = Object.getPrototypeOf(value) as unknown;
  return prototype === Object.prototype || prototype === null;
}
