import {
  CloudControlClient,
  type CloudControlClientConfig as AwsCloudControlClientConfig,
  GetResourceCommand,
  ListResourcesCommand,
  type GetResourceCommandOutput,
  type ListResourcesCommandOutput,
  type ResourceDescription,
} from "@aws-sdk/client-cloudcontrol";

import { mapWithConcurrency } from "./concurrency.js";
import type { ScanError } from "../model/schemas.js";
import { paginateByToken } from "./pagination.js";
import {
  isRetryableError,
  retryWithBackoff,
  type RetryOptions,
} from "./retry.js";

export interface CloudControlReadClientConfig {
  readonly concurrency?: number;
  readonly credentials?: AwsCloudControlClientConfig["credentials"];
  readonly retry?: RetryOptions;
  readonly region: string;
}

export interface CloudControlReadClientOptions {
  readonly concurrency?: number;
  readonly retry?: RetryOptions;
}

export interface CloudControlListResourcesInput {
  readonly maxResults?: number;
  readonly resourceModel?: Record<string, unknown>;
  readonly roleArn?: string;
  readonly typeName: string;
}

export interface CloudControlGetResourceInput {
  readonly identifier: string;
  readonly roleArn?: string;
  readonly typeName: string;
}

export interface CloudControlGetResourcesInput {
  readonly onProgress?: (
    completed: number,
    total: number,
    identifier: string,
  ) => void;
  readonly concurrency?: number;
  readonly resources: readonly CloudControlGetResourceInput[];
}

export interface CloudControlResource {
  readonly errors?: readonly ScanError[];
  readonly identifier: string;
  readonly properties: Record<string, unknown>;
  readonly rawProperties?: string;
}

export interface CloudControlSdkClient {
  send(command: ListResourcesCommand): Promise<ListResourcesCommandOutput>;
  send(command: GetResourceCommand): Promise<GetResourceCommandOutput>;
}

export class CloudControlReadClient {
  constructor(
    private readonly client: CloudControlSdkClient,
    private readonly options: CloudControlReadClientOptions = {},
  ) {}

  async *listResources(
    input: CloudControlListResourcesInput,
  ): AsyncGenerator<CloudControlResource> {
    const descriptions = paginateByToken<ResourceDescription>({
      fetchPage: async (nextToken) => {
        const commandInput = {
          MaxResults: input.maxResults,
          NextToken: nextToken,
          ResourceModel: input.resourceModel
            ? JSON.stringify(input.resourceModel)
            : undefined,
          RoleArn: input.roleArn,
          TypeName: input.typeName,
        };
        const output = await retryWithBackoff(
          () => this.client.send(new ListResourcesCommand(commandInput)),
          this.options.retry,
        );

        return {
          items: output.ResourceDescriptions ?? [],
          nextToken: output.NextToken,
        };
      },
    });

    for await (const description of descriptions) {
      yield normalizeResourceDescription(description);
    }
  }

  async getResource(
    input: CloudControlGetResourceInput,
  ): Promise<CloudControlResource> {
    const commandInput = {
      Identifier: input.identifier,
      RoleArn: input.roleArn,
      TypeName: input.typeName,
    };
    const output = await retryWithBackoff(
      () => this.client.send(new GetResourceCommand(commandInput)),
      this.options.retry,
    );

    if (!output.ResourceDescription) {
      throw new Error(
        `Cloud Control returned no resource description for ${input.typeName}`,
      );
    }

    return normalizeResourceDescription(output.ResourceDescription);
  }

  async getResources(
    input: CloudControlGetResourcesInput,
  ): Promise<readonly CloudControlResource[]> {
    let completed = 0;
    return mapWithConcurrency(
      input.resources,
      async (resourceInput) => {
        try {
          return await this.getResource(resourceInput);
        } catch (error) {
          const name = error instanceof Error ? error.name : "";
          const code =
            name === "AccessDeniedException" || name === "AccessDenied"
              ? "AccessDenied"
              : name === "ResourceNotFoundException" ||
                  name === "NotFoundException"
                ? "ResourceNotFound"
                : "ResourceReadFailed";
          // SDK messages can echo resource properties; store only classified metadata.
          return {
            identifier: resourceInput.identifier,
            properties: {},
            errors: [
              { code, message: code, retryable: isRetryableError(error) },
            ],
          };
        } finally {
          completed += 1;
          input.onProgress?.(
            completed,
            input.resources.length,
            resourceInput.identifier,
          );
        }
      },
      {
        concurrency: input.concurrency ?? this.options.concurrency,
      },
    );
  }
}

export function createCloudControlReadClient(
  config: CloudControlReadClientConfig,
): CloudControlReadClient {
  return new CloudControlReadClient(
    new CloudControlClient({
      credentials: config.credentials,
      region: config.region,
    }),
    { concurrency: config.concurrency, retry: config.retry },
  );
}

function normalizeResourceDescription(
  description: ResourceDescription,
): CloudControlResource {
  if (!description.Identifier) {
    throw new Error("Cloud Control resource description is missing Identifier");
  }

  return {
    identifier: description.Identifier,
    properties: parseResourceProperties(description.Properties),
    rawProperties: description.Properties,
  };
}

function parseResourceProperties(properties?: string): Record<string, unknown> {
  if (!properties) {
    return {};
  }

  const parsed = JSON.parse(properties) as unknown;

  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
    throw new Error("Cloud Control resource properties must be a JSON object");
  }

  return parsed as Record<string, unknown>;
}
