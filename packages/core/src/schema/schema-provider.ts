import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";

import {
  CloudFormationClient,
  DescribeTypeCommand,
  type DescribeTypeCommandOutput,
} from "@aws-sdk/client-cloudformation";
import { fromIni } from "@aws-sdk/credential-provider-ini";

import {
  CfnResourceSchemaSchema,
  type CfnResourceSchema,
} from "../normalize/schemas.js";

export interface ResourceSchemaProvider {
  fetch(resourceType: string): Promise<CfnResourceSchema>;
}

export interface ResourceSchemaSdkClient {
  send(command: DescribeTypeCommand): Promise<DescribeTypeCommandOutput>;
}

export interface CreateAwsResourceSchemaProviderInput {
  readonly profile?: string;
  readonly region: string;
}

export interface WriteResourceSchemasInput {
  readonly outputDirectory: string;
  readonly schemas: readonly CfnResourceSchema[];
}

export class AwsResourceSchemaProvider implements ResourceSchemaProvider {
  constructor(private readonly client: ResourceSchemaSdkClient) {}

  async fetch(resourceType: string): Promise<CfnResourceSchema> {
    const output = await this.client.send(
      new DescribeTypeCommand({
        Type: "RESOURCE",
        TypeName: resourceType,
      }),
    );

    if (!output.Schema) {
      throw new Error(`CloudFormation returned no schema for ${resourceType}.`);
    }

    const schema = CfnResourceSchemaSchema.parse(
      JSON.parse(output.Schema) as unknown,
    );
    if (schema.typeName !== resourceType)
      throw new Error(
        "Returned schema does not match the requested resource type.",
      );
    return schema;
  }
}

export function createAwsResourceSchemaProvider(
  input: CreateAwsResourceSchemaProviderInput,
): ResourceSchemaProvider {
  return new AwsResourceSchemaProvider(
    new CloudFormationClient({
      credentials: input.profile
        ? fromIni({ profile: input.profile })
        : undefined,
      region: input.region,
    }),
  );
}

export async function writeResourceSchemas(
  input: WriteResourceSchemasInput,
): Promise<readonly string[]> {
  await mkdir(input.outputDirectory, { recursive: true });
  const outputs: string[] = [];

  for (const schema of [...input.schemas].sort((left, right) =>
    left.typeName.localeCompare(right.typeName),
  )) {
    const parsed = CfnResourceSchemaSchema.parse(schema);
    const outputPath = join(
      input.outputDirectory,
      `${resourceSchemaFileName(parsed.typeName)}.json`,
    );
    await writeFile(
      outputPath,
      `${JSON.stringify(sortJsonValue(parsed), null, 2)}\n`,
      "utf8",
    );
    outputs.push(outputPath);
  }

  return outputs;
}

export function resourceSchemaFileName(resourceType: string): string {
  return resourceType.toLowerCase().replaceAll("::", "-");
}

function sortJsonValue(value: unknown): unknown {
  if (Array.isArray(value)) {
    return value.map(sortJsonValue);
  }
  if (value && typeof value === "object") {
    return Object.fromEntries(
      Object.entries(value as Record<string, unknown>)
        .sort(([left], [right]) => left.localeCompare(right))
        .map(([key, nested]) => [key, sortJsonValue(nested)]),
    );
  }
  return value;
}
