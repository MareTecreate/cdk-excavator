import * as cdk from "aws-cdk-lib";
import * as s3 from "aws-cdk-lib/aws-s3";
import * as sns from "aws-cdk-lib/aws-sns";
import * as sqs from "aws-cdk-lib/aws-sqs";

import type { GeneratedCfnResource } from "./schemas.js";

const L2_RESOURCE_TYPES = new Set([
  "AWS::S3::Bucket",
  "AWS::SNS::Topic",
  "AWS::SQS::Queue",
]);

export type L2LiftStatus = "fallback" | "lifted" | "not-eligible";

export interface L2LiftCandidate {
  readonly importAlias: string;
  readonly importPath: string;
  readonly pythonImportPath: string;
  readonly renderPython: (variableName: string) => readonly string[];
  readonly renderTypeScript: (variableName: string) => readonly string[];
}

export interface L2LiftEvaluation {
  readonly candidate?: L2LiftCandidate;
  readonly differences: readonly string[];
  readonly logicalId: string;
  readonly reason: string;
  readonly resourceType: string;
  readonly status: L2LiftStatus;
}

interface CandidateDefinition {
  readonly importAlias: string;
  readonly importPath: string;
  readonly l2TypeName: string;
  readonly l1TypeName: string;
  readonly pythonImportPath: string;
  readonly pythonPropsSource: readonly string[];
  readonly instantiate: (scope: cdk.Stack, id: string) => cdk.CfnResource;
  readonly propsSource: readonly string[];
}

export function isL2LiftResourceType(resourceType: string): boolean {
  return L2_RESOURCE_TYPES.has(resourceType);
}

export function evaluateL2Lift(
  logicalId: string,
  resource: GeneratedCfnResource,
): L2LiftEvaluation {
  if (!isL2LiftResourceType(resource.Type)) {
    return {
      differences: [],
      logicalId,
      reason: "resource-type-not-eligible",
      resourceType: resource.Type,
      status: "not-eligible",
    };
  }

  const definition = createCandidateDefinition(resource);

  if ("reason" in definition) {
    return {
      differences: [],
      logicalId,
      reason: definition.reason,
      resourceType: resource.Type,
      status: "fallback",
    };
  }

  try {
    const synthesized = synthesizeCandidate(logicalId, resource, definition);
    const differences = compareJson(resource, synthesized);

    if (differences.length > 0) {
      return {
        differences,
        logicalId,
        reason: "synth-template-diff",
        resourceType: resource.Type,
        status: "fallback",
      };
    }

    return {
      candidate: {
        importAlias: definition.importAlias,
        importPath: definition.importPath,
        pythonImportPath: definition.pythonImportPath,
        renderPython: (variableName) =>
          renderPythonCandidateSource(
            logicalId,
            resource,
            definition,
            variableName,
          ),
        renderTypeScript: (variableName) =>
          renderTypeScriptCandidateSource(
            logicalId,
            resource,
            definition,
            variableName,
          ),
      },
      differences: [],
      logicalId,
      reason: "synth-template-identical",
      resourceType: resource.Type,
      status: "lifted",
    };
  } catch (error) {
    return {
      differences: [],
      logicalId,
      reason: `synth-error:${errorMessage(error)}`,
      resourceType: resource.Type,
      status: "fallback",
    };
  }
}

function createCandidateDefinition(
  resource: GeneratedCfnResource,
): CandidateDefinition | { readonly reason: string } {
  if (resource.Type === "AWS::S3::Bucket") {
    const value = validateNamedResourceProperties(
      resource.Properties,
      "BucketName",
    );
    if ("reason" in value) {
      return value;
    }

    return {
      importAlias: "s3",
      importPath: "aws-cdk-lib/aws-s3",
      l2TypeName: "Bucket",
      l1TypeName: "CfnBucket",
      pythonImportPath: "aws_cdk.aws_s3",
      pythonPropsSource: [`bucket_name=${pythonString(value.name)},`],
      instantiate: (scope, id) =>
        new s3.Bucket(scope, id, { bucketName: value.name }).node
          .defaultChild as s3.CfnBucket,
      propsSource: [`bucketName: ${JSON.stringify(value.name)},`],
    };
  }

  if (resource.Type === "AWS::SQS::Queue") {
    const value = validateNamedResourceProperties(
      resource.Properties,
      "QueueName",
    );
    if ("reason" in value) {
      return value;
    }

    return {
      importAlias: "sqs",
      importPath: "aws-cdk-lib/aws-sqs",
      l2TypeName: "Queue",
      l1TypeName: "CfnQueue",
      pythonImportPath: "aws_cdk.aws_sqs",
      pythonPropsSource: [`queue_name=${pythonString(value.name)},`],
      instantiate: (scope, id) =>
        new sqs.Queue(scope, id, { queueName: value.name }).node
          .defaultChild as sqs.CfnQueue,
      propsSource: [`queueName: ${JSON.stringify(value.name)},`],
    };
  }

  if (resource.Type === "AWS::SNS::Topic") {
    const value = validateNamedResourceProperties(
      resource.Properties,
      "TopicName",
    );
    if ("reason" in value) {
      return value;
    }

    return {
      importAlias: "sns",
      importPath: "aws-cdk-lib/aws-sns",
      l2TypeName: "Topic",
      l1TypeName: "CfnTopic",
      pythonImportPath: "aws_cdk.aws_sns",
      pythonPropsSource: [`topic_name=${pythonString(value.name)},`],
      instantiate: (scope, id) =>
        new sns.Topic(scope, id, { topicName: value.name }).node
          .defaultChild as sns.CfnTopic,
      propsSource: [`topicName: ${JSON.stringify(value.name)},`],
    };
  }

  return { reason: "resource-type-not-eligible" };
}

function validateNamedResourceProperties(
  properties: Readonly<Record<string, unknown>>,
  nameProperty: string,
): { readonly name: string } | { readonly reason: string } {
  const keys = Object.keys(properties).sort();

  if (keys.length !== 1 || keys[0] !== nameProperty) {
    return {
      reason: `unsupported-properties:${keys.join(",") || "none"}`,
    };
  }

  const name = properties[nameProperty];

  return typeof name === "string" && name.length > 0
    ? { name }
    : { reason: `unsupported-property-value:${nameProperty}` };
}

function synthesizeCandidate(
  logicalId: string,
  resource: GeneratedCfnResource,
  definition: CandidateDefinition,
): unknown {
  const app = new cdk.App({ analyticsReporting: false });
  const stack = new cdk.Stack(app, "L2Validation", {
    synthesizer: new cdk.BootstraplessSynthesizer(),
  });
  const l1 = definition.instantiate(stack, logicalId);
  l1.cfnOptions.metadata = resource.Metadata;
  l1.overrideLogicalId(logicalId);
  l1.applyRemovalPolicy(cdk.RemovalPolicy.RETAIN);
  const assembly = app.synth();
  const template = assembly.getStackByName(stack.stackName).template as {
    Resources?: Record<string, unknown>;
  };

  return template.Resources?.[logicalId];
}

function renderTypeScriptCandidateSource(
  logicalId: string,
  resource: GeneratedCfnResource,
  definition: CandidateDefinition,
  variableName: string,
): string[] {
  const l1VariableName = `${variableName}L1`;
  const metadata = indentJson(resource.Metadata, 4);

  return [
    `    const ${variableName} = new ${definition.importAlias}.${definition.l2TypeName}(this, '${escapeSingleQuoted(logicalId)}', {`,
    ...definition.propsSource.map((line) => `      ${line}`),
    "    });",
    `    const ${l1VariableName} = ${variableName}.node.defaultChild as ${definition.importAlias}.${definition.l1TypeName};`,
    `    ${l1VariableName}.cfnOptions.metadata = ${metadata};`,
    `    ${l1VariableName}.overrideLogicalId('${escapeSingleQuoted(logicalId)}');`,
    `    ${l1VariableName}.applyRemovalPolicy(cdk.RemovalPolicy.RETAIN);`,
  ];
}

function renderPythonCandidateSource(
  logicalId: string,
  resource: GeneratedCfnResource,
  definition: CandidateDefinition,
  variableName: string,
): string[] {
  const l1VariableName = `${variableName}_l1`;
  const metadataEntries = Object.entries(resource.Metadata ?? {}).sort(
    ([a], [b]) => a.localeCompare(b),
  );

  return [
    `    ${variableName} = ${definition.importAlias}.${definition.l2TypeName}(`,
    "      self,",
    `      ${pythonString(logicalId)},`,
    ...definition.pythonPropsSource.map((line) => `      ${line}`),
    "    )",
    `    ${l1VariableName} = ${variableName}.node.default_child`,
    ...metadataEntries.map(
      ([key, value]) =>
        `    ${l1VariableName}.add_metadata(${pythonString(key)}, ${pythonLiteral(value)})`,
    ),
    `    ${l1VariableName}.override_logical_id(${pythonString(logicalId)})`,
    `    ${l1VariableName}.apply_removal_policy(cdk.RemovalPolicy.RETAIN)`,
  ];
}

function compareJson(expected: unknown, actual: unknown): string[] {
  const differences: string[] = [];
  collectJsonDifferences(expected, actual, "$", differences);
  return differences.slice(0, 20);
}

function collectJsonDifferences(
  expected: unknown,
  actual: unknown,
  path: string,
  differences: string[],
): void {
  if (Object.is(expected, actual)) {
    return;
  }

  if (Array.isArray(expected) && Array.isArray(actual)) {
    if (expected.length !== actual.length) {
      differences.push(`${path}.length`);
    }

    const length = Math.max(expected.length, actual.length);
    for (let index = 0; index < length; index += 1) {
      collectJsonDifferences(
        expected[index],
        actual[index],
        `${path}[${index}]`,
        differences,
      );
    }
    return;
  }

  if (isRecord(expected) && isRecord(actual)) {
    const keys = [
      ...new Set([...Object.keys(expected), ...Object.keys(actual)]),
    ].sort();

    for (const key of keys) {
      collectJsonDifferences(
        expected[key],
        actual[key],
        `${path}.${key}`,
        differences,
      );
    }
    return;
  }

  differences.push(path);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function indentJson(value: unknown, spaces: number): string {
  const padding = " ".repeat(spaces);
  return JSON.stringify(value, null, 2).replaceAll("\n", `\n${padding}`);
}

function escapeSingleQuoted(value: string): string {
  return value.replaceAll("\\", "\\\\").replaceAll("'", "\\'");
}

function pythonLiteral(value: unknown): string {
  if (value === null) {
    return "None";
  }

  if (typeof value === "string") {
    return pythonString(value);
  }

  if (typeof value === "number" || typeof value === "boolean") {
    return typeof value === "boolean"
      ? value
        ? "True"
        : "False"
      : String(value);
  }

  if (Array.isArray(value)) {
    return `[${value.map((item) => pythonLiteral(item)).join(", ")}]`;
  }

  if (isRecord(value)) {
    return `{${Object.entries(value)
      .sort(([a], [b]) => a.localeCompare(b))
      .map(([key, item]) => `${pythonString(key)}: ${pythonLiteral(item)}`)
      .join(", ")}}`;
  }

  throw new Error(`Unsupported Python literal: ${String(value)}`);
}

function pythonString(value: string): string {
  return JSON.stringify(value);
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
