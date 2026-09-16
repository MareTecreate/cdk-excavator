import {
  CloudFormationClient,
  type CloudFormationClientConfig as AwsCloudFormationClientConfig,
  DescribeStackResourcesCommand,
  DescribeStacksCommand,
  type DescribeStackResourcesCommandOutput,
  type DescribeStacksCommandOutput,
  type Stack,
  type StackResource,
} from "@aws-sdk/client-cloudformation";

import { mapWithConcurrency } from "./concurrency.js";
import { paginateByToken } from "./pagination.js";
import { retryWithBackoff, type RetryOptions } from "./retry.js";

export const CLOUDFORMATION_STACK_ID_TAG = "aws:cloudformation:stack-id";

export interface CloudFormationReadClientConfig {
  readonly concurrency?: number;
  readonly credentials?: AwsCloudFormationClientConfig["credentials"];
  readonly region: string;
  readonly retry?: RetryOptions;
}

export interface CloudFormationReadClientOptions {
  readonly concurrency?: number;
  readonly retry?: RetryOptions;
}

export interface CloudFormationStack {
  readonly stackId: string;
  readonly stackName: string;
}

export interface CloudFormationStackResourceInput {
  readonly stackId?: string;
  readonly stackName?: string;
}

export interface CloudFormationManagedResource {
  readonly logicalResourceId: string;
  readonly physicalResourceId: string;
  readonly resourceType: string;
  readonly stackId: string;
  readonly stackName: string;
}

export interface ListCloudFormationManagedResourcesInput {
  readonly concurrency?: number;
}

export interface CloudFormationManagedResourceLookupInput {
  readonly physicalResourceId?: string;
  readonly tags?: Record<string, string>;
}

export interface CloudFormationManagedResourceIndex {
  readonly byPhysicalId: ReadonlyMap<
    string,
    readonly CloudFormationManagedResource[]
  >;
  findManagedResources(
    input: CloudFormationManagedResourceLookupInput,
  ): readonly CloudFormationManagedResource[];
  isManaged(input: CloudFormationManagedResourceLookupInput): boolean;
}

export interface CloudFormationSdkClient {
  send(command: DescribeStacksCommand): Promise<DescribeStacksCommandOutput>;
  send(
    command: DescribeStackResourcesCommand,
  ): Promise<DescribeStackResourcesCommandOutput>;
}

export class CloudFormationReadClient {
  constructor(
    private readonly client: CloudFormationSdkClient,
    private readonly options: CloudFormationReadClientOptions = {},
  ) {}

  async *listStacks(): AsyncGenerator<CloudFormationStack> {
    const stacks = paginateByToken<Stack>({
      fetchPage: async (nextToken) => {
        const output = await retryWithBackoff(
          () =>
            this.client.send(
              new DescribeStacksCommand({
                NextToken: nextToken,
              }),
            ),
          this.options.retry,
        );

        return {
          items: output.Stacks ?? [],
          nextToken: output.NextToken,
        };
      },
    });

    for await (const stack of stacks) {
      yield normalizeStack(stack);
    }
  }

  async listStackResources(
    input: CloudFormationStackResourceInput,
  ): Promise<readonly CloudFormationManagedResource[]> {
    const stackName = input.stackId ?? input.stackName;

    if (!stackName) {
      throw new Error("CloudFormation stackId or stackName is required");
    }

    const output = await retryWithBackoff(
      () =>
        this.client.send(
          new DescribeStackResourcesCommand({
            StackName: stackName,
          }),
        ),
      this.options.retry,
    );

    return (output.StackResources ?? [])
      .map((resource) => normalizeStackResource(resource, input))
      .filter(isDefined);
  }

  async listManagedResources(
    input: ListCloudFormationManagedResourcesInput = {},
  ): Promise<readonly CloudFormationManagedResource[]> {
    const stacks: CloudFormationStack[] = [];

    for await (const stack of this.listStacks()) {
      stacks.push(stack);
    }

    const resourcesByStack = await mapWithConcurrency(
      stacks,
      async (stack) =>
        this.listStackResources({
          stackId: stack.stackId,
          stackName: stack.stackName,
        }),
      {
        concurrency: input.concurrency ?? this.options.concurrency,
      },
    );

    return resourcesByStack.flat();
  }
}

export function createCloudFormationReadClient(
  config: CloudFormationReadClientConfig,
): CloudFormationReadClient {
  return new CloudFormationReadClient(
    new CloudFormationClient({
      credentials: config.credentials,
      region: config.region,
    }),
    { concurrency: config.concurrency, retry: config.retry },
  );
}

export function createCloudFormationManagedResourceIndex(
  resources: readonly CloudFormationManagedResource[],
): CloudFormationManagedResourceIndex {
  const byPhysicalId = new Map<string, CloudFormationManagedResource[]>();

  for (const resource of resources) {
    const values = byPhysicalId.get(resource.physicalResourceId) ?? [];
    values.push(resource);
    byPhysicalId.set(resource.physicalResourceId, values);
  }

  const findManagedResources = (
    input: CloudFormationManagedResourceLookupInput,
  ): readonly CloudFormationManagedResource[] =>
    input.physicalResourceId
      ? (byPhysicalId.get(input.physicalResourceId) ?? [])
      : [];

  return {
    byPhysicalId,
    findManagedResources,
    isManaged(input) {
      return (
        hasCloudFormationStackIdTag(input.tags) ||
        findManagedResources(input).length > 0
      );
    },
  };
}

export function hasCloudFormationStackIdTag(
  tags: Record<string, string> | undefined,
): boolean {
  return Boolean(tags?.[CLOUDFORMATION_STACK_ID_TAG]);
}

function normalizeStack(stack: Stack): CloudFormationStack {
  if (!stack.StackId || !stack.StackName) {
    throw new Error("CloudFormation stack is missing StackId or StackName");
  }

  return {
    stackId: stack.StackId,
    stackName: stack.StackName,
  };
}

function normalizeStackResource(
  resource: StackResource,
  stack: CloudFormationStackResourceInput,
): CloudFormationManagedResource | undefined {
  if (
    !resource.LogicalResourceId ||
    !resource.PhysicalResourceId ||
    !resource.ResourceType
  ) {
    return undefined;
  }

  return {
    logicalResourceId: resource.LogicalResourceId,
    physicalResourceId: resource.PhysicalResourceId,
    resourceType: resource.ResourceType,
    stackId: resource.StackId ?? stack.stackId ?? "",
    stackName: resource.StackName ?? stack.stackName ?? "",
  };
}

function isDefined<T>(value: T | undefined): value is T {
  return value !== undefined;
}
