import { createHash } from "node:crypto";
import { TOOL_SCHEMA_VERSION } from "../model/schemas.js";
import { assertCdkJsonRepresentable } from "../model/json-safety.js";
import type {
  GapDocument,
  GapFinding,
  NormalizationModelDocument,
  NormalizedResource,
} from "../normalize/schemas.js";
import {
  CdkImportMapDocumentSchema,
  CdkResourceMappingSchema,
  GeneratedCfnTemplateSchema,
  type CdkImportMapDocument,
  type CdkResourceMapping,
  type GeneratedCfnResource,
  type GeneratedCfnParameter,
  type GeneratedCfnTemplate,
  type ImportBoundaryReference,
  type ImportMapResource,
  type ImportStatus,
  type GenerationStack,
} from "./schemas.js";
import { resourceGroupName, toPascalIdentifier } from "./naming.js";
import {
  createStackPlan,
  findValuePaths,
  replacePointer,
} from "./stack-plan.js";
import { coreMessages } from "../messages.js";

const DEFAULT_STACK_NAME = "ExcavatedStack";

const IMPORT_IDENTIFIER_BY_TYPE: Readonly<Record<string, string>> = {
  "AWS::CloudFront::Distribution": "Id",
  "AWS::EC2::SecurityGroup": "GroupId",
  "AWS::EC2::Subnet": "SubnetId",
  "AWS::EC2::VPC": "VpcId",
  "AWS::RDS::DBInstance": "DBInstanceIdentifier",
  "AWS::S3::Bucket": "BucketName",
  "AWS::SNS::Topic": "TopicArn",
  "AWS::SQS::Queue": "QueueUrl",
};

export interface CreateGenerationDocumentsInput {
  readonly gaps: GapDocument;
  readonly model: NormalizationModelDocument;
  readonly stackName?: string;
  readonly toolVersion?: string;
}

export interface GenerationDocuments {
  readonly importMap: CdkImportMapDocument;
  readonly resourceMapping: CdkResourceMapping;
  readonly template: GeneratedCfnTemplate;
  readonly stack?: GenerationStack;
  readonly stacks?: readonly GeneratedStackDocuments[];
}

export interface GeneratedStackDocuments extends GenerationDocuments {
  readonly stack: GenerationStack;
}

interface LogicalIdAssignment {
  readonly logicalId: string;
  readonly resource: NormalizedResource;
}

interface BoundaryParameterAssignment {
  readonly logicalId: string;
  readonly type: ImportBoundaryReference["type"];
  readonly value: string;
}

export function createGenerationDocuments(
  input: CreateGenerationDocumentsInput,
): GenerationDocuments {
  const stackName = input.stackName ?? DEFAULT_STACK_NAME;
  if (!/^[A-Za-z][A-Za-z0-9-]{0,127}$/.test(stackName))
    throw new Error(coreMessages.t("core.generate.stackName"));
  const resources = input.model.resources.filter(
    (resource) => resource.status === "codeable",
  );
  for (const resource of resources)
    assertCdkJsonRepresentable(resource.properties);
  const assignments = createLogicalIdAssignments(resources);
  const plan = createStackPlan(input.model, stackName);
  const gapsByResourceKey = groupGapsByResourceKey(input.gaps.gaps);
  const toolVersion = input.toolVersion ?? input.model.toolVersion;
  const logicalIdsByResourceKey = new Map(
    assignments.map((assignment) => [
      assignment.resource.key,
      assignment.logicalId,
    ]),
  );
  const externalReferences: ImportBoundaryReference[] =
    input.model.externalReferences
      .map((reference) => ({
        ...reference,
        referencedByLogicalId: logicalIdsByResourceKey.get(
          reference.referencedBy,
        ),
      }))
      .sort((left, right) =>
        `${left.referencedBy}:${left.type}:${left.value}`.localeCompare(
          `${right.referencedBy}:${right.type}:${right.value}`,
        ),
      );
  const unresolvedIncludes = externalReferences.filter(
    (reference) => reference.boundaryHandling === "include",
  );

  if (unresolvedIncludes.length > 0) {
    throw new Error(
      `Boundary include decision was not resolved during scope selection: ${unresolvedIncludes
        .map((reference) => reference.value)
        .join(", ")}`,
    );
  }

  const stacks = plan.stacks.map((stack): GeneratedStackDocuments => {
    const selectedKeys = new Set(stack.resourceKeys);
    const stackReferences = externalReferences.filter((reference) =>
      selectedKeys.has(reference.referencedBy),
    );
    const boundaryParameters =
      createBoundaryParameterAssignments(stackReferences);
    const boundaryParameterByValue = new Map(
      boundaryParameters.map((parameter) => [
        boundaryParameterKey(parameter),
        parameter,
      ]),
    );

    const templateResources: Record<string, GeneratedCfnResource> = {};
    const importResources: ImportMapResource[] = [];
    const parameters = createTemplateParameters(boundaryParameters);
    const outputs: NonNullable<GeneratedCfnTemplate["Outputs"]> = {};
    for (const assignment of assignments.filter((assignment) =>
      selectedKeys.has(assignment.resource.key),
    )) {
      const resourceGaps = gapsByResourceKey.get(assignment.resource.key) ?? [];
      templateResources[assignment.logicalId] = createTemplateResource({
        boundaryParameterByValue,
        externalReferences: stackReferences,
        resource: assignment.resource,
      });
      importResources.push(
        createImportMapResource({
          logicalId: assignment.logicalId,
          resource: assignment.resource,
          resourceGaps,
          stackName: stack.stackName,
        }),
      );
    }

    for (const reference of plan.references) {
      const sourceId = logicalIdsByResourceKey.get(reference.from);
      const targetId = reference.to
        ? logicalIdsByResourceKey.get(reference.to)
        : undefined;
      if (
        reference.disposition === "cross-stack-token" &&
        reference.targetStack === stack.stackName &&
        reference.exportName &&
        targetId
      ) {
        outputs[
          reference.exportName.slice(reference.exportName.lastIndexOf(":") + 1)
        ] = {
          Value: referenceToken(targetId, reference.targetAttribute!),
          Export: { Name: reference.exportName },
        };
      }
      if (!sourceId || reference.sourceStack !== stack.stackName) continue;
      const templateResource = templateResources[sourceId]!;
      let replacement: unknown;
      if (reference.disposition === "internal-token" && targetId)
        replacement = referenceToken(
          targetId,
          reference.targetAttribute!,
          reference.valueSuffix,
        );
      if (reference.disposition === "cross-stack-token")
        replacement = withSuffix(
          { "Fn::ImportValue": reference.exportName },
          reference.valueSuffix,
        );
      if (reference.disposition === "cycle-boundary") {
        const name = `ReviewReference${plan.references.indexOf(reference) + 1}`;
        parameters[name] = {
          Type: "String",
          Default: reference.value,
          Description: coreMessages.t("core.generate.cycleParameter"),
        };
        replacement = { Ref: name };
      }
      if (replacement)
        replacePointer(
          templateResource.Properties,
          reference.propertyPath,
          reference.value,
          replacement,
        );
      if (reference.reason && reference.disposition !== "excluded-property") {
        const metadata = templateResource.Metadata["cdk-excavator"];
        metadata.referenceNotes = [
          ...new Set([...(metadata.referenceNotes ?? []), reference.reason]),
        ].sort();
        const entry = importResources.find(
          (resource) => resource.logicalId === sourceId,
        )!;
        entry.reviewReasons = [
          ...new Set([
            ...entry.reviewReasons,
            `reference-review:${reference.reason}`,
          ]),
        ].sort();
        if (entry.status === "ready") entry.status = "needs-review";
      }
    }
    addGatewayAttachmentDependencies(templateResources);
    if (
      Object.keys(parameters).length > 200 ||
      Object.keys(outputs).length > 200
    )
      throw new Error(coreMessages.t("core.generate.quota"));

    const importMap = CdkImportMapDocumentSchema.parse({
      externalReferences: stackReferences,
      resources: importResources.sort((left, right) =>
        left.logicalId.localeCompare(right.logicalId),
      ),
      schemaVersion: TOOL_SCHEMA_VERSION,
      stackName: stack.stackName,
      toolVersion,
      plan,
    });

    return {
      importMap,
      stack,
      resourceMapping: createReadyResourceMapping(importMap.resources),
      template: GeneratedCfnTemplateSchema.parse({
        AWSTemplateFormatVersion: "2010-09-09",
        Description: coreMessages.t("core.generate.description"),
        ...(Object.keys(parameters).length > 0
          ? { Parameters: sortRecord(parameters) }
          : {}),
        ...(Object.keys(outputs).length
          ? { Outputs: sortRecord(outputs) }
          : {}),
        Resources: sortRecord(templateResources),
      }),
    };
  });
  if (stacks.length === 1) return { ...stacks[0]!, stacks };
  return {
    stacks,
    importMap: CdkImportMapDocumentSchema.parse({
      externalReferences,
      resources: stacks
        .flatMap((stack) => stack.importMap.resources)
        .sort((a, b) => a.logicalId.localeCompare(b.logicalId)),
      schemaVersion: TOOL_SCHEMA_VERSION,
      stackName,
      toolVersion,
      plan,
    }),
    resourceMapping: {},
    // Aggregate for counts and previews only. Writers emit each real stack separately.
    template: {
      AWSTemplateFormatVersion: "2010-09-09",
      Description: coreMessages.t("core.generate.aggregate"),
      Resources: sortRecord(
        Object.fromEntries(
          stacks.flatMap((stack) => Object.entries(stack.template.Resources)),
        ),
      ),
    },
  };
}

function createTemplateResource(input: {
  readonly boundaryParameterByValue: ReadonlyMap<
    string,
    BoundaryParameterAssignment
  >;
  readonly externalReferences: readonly ImportBoundaryReference[];
  readonly resource: NormalizedResource;
}): GeneratedCfnResource {
  const properties = sortJsonObject(input.resource.properties);

  for (const reference of input.externalReferences) {
    if (
      reference.boundaryHandling !== "parameter" ||
      reference.referencedBy !== input.resource.key
    ) {
      continue;
    }

    const parameter = input.boundaryParameterByValue.get(
      boundaryParameterKey(reference),
    );

    if (!parameter) {
      continue;
    }

    for (const pointer of reference.propertyPaths ??
      findValuePaths(properties, reference.value)) {
      replacePointer(properties, pointer, reference.value, {
        Ref: parameter.logicalId,
      });
    }
  }

  return {
    DeletionPolicy: "Retain",
    Metadata: {
      "cdk-excavator": {
        gapCodes: input.resource.gapCodes,
        identifier: input.resource.identifier,
        resourceKey: input.resource.key,
      },
    },
    Properties: properties,
    Type: input.resource.resourceType,
    UpdateReplacePolicy: "Retain",
  };
}

function createBoundaryParameterAssignments(
  references: readonly ImportBoundaryReference[],
): BoundaryParameterAssignment[] {
  const values = new Map<
    string,
    Pick<BoundaryParameterAssignment, "type" | "value">
  >();

  for (const reference of references) {
    if (
      reference.boundaryHandling !== "parameter" ||
      !reference.referencedByLogicalId
    ) {
      continue;
    }

    values.set(boundaryParameterKey(reference), {
      type: reference.type,
      value: reference.value,
    });
  }

  return [...values.entries()]
    .sort(([left], [right]) => left.localeCompare(right))
    .map(([, value], index) => ({
      ...value,
      logicalId: `BoundaryParameter${index + 1}`,
    }));
}

function createTemplateParameters(
  assignments: readonly BoundaryParameterAssignment[],
): Record<string, GeneratedCfnParameter> {
  return sortRecord(
    Object.fromEntries(
      assignments.map((assignment) => [
        assignment.logicalId,
        {
          Description: coreMessages.t("core.generate.boundaryParameter"),
          Type: "String" as const,
        },
      ]),
    ),
  );
}

function boundaryParameterKey(
  value: Pick<ImportBoundaryReference, "type" | "value">,
): string {
  return `${value.type}\u0000${value.value}`;
}

function referenceToken(
  logicalId: string,
  attribute: string,
  suffix?: string,
): unknown {
  return withSuffix(
    attribute === "Ref"
      ? { Ref: logicalId }
      : { "Fn::GetAtt": [logicalId, attribute] },
    suffix,
  );
}

function withSuffix(value: unknown, suffix?: string): unknown {
  return suffix ? { "Fn::Join": ["", [value, suffix]] } : value;
}

function addGatewayAttachmentDependencies(
  resources: Record<string, GeneratedCfnResource>,
): void {
  for (const resource of Object.values(resources)) {
    if (resource.Type !== "AWS::EC2::Route" || !resource.Properties.GatewayId)
      continue;
    const attachments = Object.entries(resources)
      .filter(
        ([, target]) =>
          target.Type === "AWS::EC2::VPCGatewayAttachment" &&
          JSON.stringify(target.Properties.InternetGatewayId) ===
            JSON.stringify(resource.Properties.GatewayId),
      )
      .map(([id]) => id)
      .sort();
    if (attachments.length) resource.DependsOn = attachments;
  }
}

function createImportMapResource(input: {
  readonly logicalId: string;
  readonly resource: NormalizedResource;
  readonly resourceGaps: readonly GapFinding[];
  readonly stackName: string;
}): ImportMapResource {
  const importIdentifiers = inferImportIdentifiers(input.resource);
  const reviewReasons = createReviewReasons(
    input.resource,
    input.resourceGaps,
    hasConfiguredImportIdentifier(input.resource.resourceType),
  );
  const status = createImportStatus(importIdentifiers, reviewReasons);

  return {
    accountId: input.resource.accountId,
    cdkPath: `${input.stackName}/${resourceGroupName(input.resource.resourceType)}/${input.logicalId}`,
    identifier: input.resource.identifier,
    importIdentifiers,
    logicalId: input.logicalId,
    region: input.resource.region,
    resourceKey: input.resource.key,
    resourceType: input.resource.resourceType,
    reviewReasons,
    status,
    stackName: input.stackName,
  };
}

function inferImportIdentifiers(
  resource: NormalizedResource,
): Record<string, string> {
  const configuredIdentifier = IMPORT_IDENTIFIER_BY_TYPE[resource.resourceType];

  if (configuredIdentifier) {
    return {
      [configuredIdentifier]: resource.identifier,
    };
  }

  const fallbackName = resource.resourceType.split("::").at(-1) ?? "Resource";
  return {
    [`${fallbackName}Id`]: resource.identifier,
  };
}

function createReviewReasons(
  resource: NormalizedResource,
  gaps: readonly GapFinding[],
  hasVerifiedIdentifier: boolean,
): string[] {
  const reasons: string[] = [];

  for (const gap of gaps) {
    if (gap.severity === "blocking") {
      reasons.push(`blocking-gap:${gap.code}`);
    } else if (gap.severity === "manual-action") {
      reasons.push(`manual-action-gap:${gap.code}`);
    } else if (gap.code === "GAP-7") {
      reasons.push(`replacement-risk:${gap.code}`);
    }
  }

  if (resource.gapCodes.length > 0) {
    reasons.push(`resource-gap-codes:${resource.gapCodes.join(",")}`);
  }

  if (isStatefulResource(resource.resourceType)) {
    reasons.push("stateful-resource:retain-required");
  }

  if (!hasVerifiedIdentifier) {
    reasons.push(`import-identifier-unverified:${resource.resourceType}`);
  }

  return [...new Set(reasons)].sort();
}

function createReadyResourceMapping(
  resources: readonly ImportMapResource[],
): CdkResourceMapping {
  const mapping: Record<string, Record<string, string>> = {};

  for (const resource of resources) {
    if (resource.status === "ready") {
      mapping[resource.logicalId] = resource.importIdentifiers;
    }
  }

  return CdkResourceMappingSchema.parse(sortRecord(mapping));
}

function hasConfiguredImportIdentifier(resourceType: string): boolean {
  return Object.hasOwn(IMPORT_IDENTIFIER_BY_TYPE, resourceType);
}

function isStatefulResource(resourceType: string): boolean {
  return [
    "AWS::DynamoDB::Table",
    "AWS::EFS::FileSystem",
    "AWS::RDS::DBCluster",
    "AWS::RDS::DBInstance",
    "AWS::S3::Bucket",
    "AWS::SQS::Queue",
  ].includes(resourceType);
}

function createImportStatus(
  importIdentifiers: Readonly<Record<string, string>>,
  reviewReasons: readonly string[],
): ImportStatus {
  if (Object.keys(importIdentifiers).length === 0) {
    return "blocked";
  }

  return reviewReasons.some((reason) => reason.startsWith("blocking-gap:"))
    ? "blocked"
    : reviewReasons.length > 0
      ? "needs-review"
      : "ready";
}

function createLogicalIdAssignments(
  resources: readonly NormalizedResource[],
): LogicalIdAssignment[] {
  const used = new Set<string>();

  return [...resources]
    .sort((left, right) => left.key.localeCompare(right.key))
    .map((resource) => {
      const base = createLogicalIdBase(resource);
      let logicalId = base;
      let suffix = 2;

      while (used.has(logicalId)) {
        logicalId = `${base}${suffix}`;
        suffix += 1;
      }

      used.add(logicalId);
      return {
        logicalId,
        resource,
      };
    });
}

function createLogicalIdBase(resource: NormalizedResource): string {
  const identifierPart = toPascalIdentifier(resource.identifier);

  if (identifierPart) {
    return identifierPart.length <= 200
      ? identifierPart
      : `${identifierPart.slice(0, 180)}${createHash("sha256").update(resource.key).digest("hex").slice(0, 16)}`;
  }

  return toPascalIdentifier(resource.resourceType.replaceAll("::", "-"));
}

function groupGapsByResourceKey(
  gaps: readonly GapFinding[],
): ReadonlyMap<string, readonly GapFinding[]> {
  const grouped = new Map<string, GapFinding[]>();

  for (const gap of gaps) {
    const current = grouped.get(gap.resourceKey) ?? [];
    current.push(gap);
    grouped.set(gap.resourceKey, current);
  }

  for (const [key, entries] of grouped.entries()) {
    grouped.set(
      key,
      [...entries].sort((left, right) =>
        `${left.code}:${left.propertyPath ?? ""}`.localeCompare(
          `${right.code}:${right.propertyPath ?? ""}`,
        ),
      ),
    );
  }

  return grouped;
}

function sortRecord<T>(record: Readonly<Record<string, T>>): Record<string, T> {
  const result: Record<string, T> = {};

  for (const key of Object.keys(record).sort()) {
    result[key] = record[key] as T;
  }

  return result;
}

function sortJsonObject(
  value: Record<string, unknown>,
): Record<string, unknown> {
  const result: Record<string, unknown> = {};

  for (const key of Object.keys(value).sort()) {
    Object.defineProperty(result, key, {
      value: sortJsonValue(value[key]),
      enumerable: true,
      writable: true,
      configurable: true,
    });
  }

  return result;
}

function sortJsonValue(value: unknown): unknown {
  if (Array.isArray(value)) {
    return value.map(sortJsonValue);
  }

  if (isPlainObject(value)) {
    return sortJsonObject(value);
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
