import { fromIni } from "@aws-sdk/credential-provider-ini";
import { loadBundledCfnSchemas } from "../defaults/normalization-defaults.js";
import { coreMessages } from "../messages.js";

import type { InventoryResource } from "../model/schemas.js";
import {
  type CloudControlGetResourcesInput,
  type CloudControlListResourcesInput,
  type CloudControlResource,
  createCloudControlReadClient,
} from "./cloud-control-client.js";
import {
  createCloudFormationManagedResourceIndex,
  createCloudFormationReadClient,
  type CloudFormationManagedResource,
  type ListCloudFormationManagedResourcesInput,
} from "./cloudformation-client.js";
import {
  createEc2VpcReadClient,
  EC2_VPC_RESOURCE_TYPES,
} from "./ec2-vpc-client.js";
import { Ec2VpcResourceCollector } from "./ec2-vpc-collector.js";
import { EC2_CONNECTION_RESOURCE_TYPES } from "./ec2-cfn-projection.js";
import { createInventoryDocument, inventoryResourceKey } from "./inventory.js";
import { toInventoryPropertyRecord } from "./inventory-properties.js";
import type { RetryOptions } from "./retry.js";
import type {
  ResourceCollector,
  ScanEngine,
  ScanLogger,
  ScanRequest,
} from "./types.js";

export const DEFAULT_SCAN_RESOURCE_TYPES: readonly string[] = [
  ...new Set([
    ...EC2_VPC_RESOURCE_TYPES,
    ...loadBundledCfnSchemas()
      .map((schema) => schema.typeName)
      .filter((type) => type !== "AWS::IAM::Policy"),
  ]),
];

export interface CloudControlInventorySource {
  listResources(
    input: CloudControlListResourcesInput,
  ): AsyncIterable<CloudControlResource>;
  getResources(
    input: CloudControlGetResourcesInput,
  ): Promise<readonly CloudControlResource[]>;
}

export interface CloudFormationManagementSource {
  listManagedResources(
    input?: ListCloudFormationManagedResourcesInput,
  ): Promise<readonly CloudFormationManagedResource[]>;
}

export interface ScanRegionSourceContext {
  readonly region: string;
  readonly request: ScanRequest;
}

export interface ScanRegionSources {
  readonly cloudControl: CloudControlInventorySource;
  readonly cloudFormation: CloudFormationManagementSource;
  readonly collectors?: readonly ResourceCollector[];
}

export interface AwsScanEngineConfig {
  readonly listEnabledRegions?: (
    request: ScanRequest,
  ) => Promise<readonly string[]>;
  readonly createRegionSources: (
    context: ScanRegionSourceContext,
  ) => ScanRegionSources;
  readonly logger?: ScanLogger;
  readonly resourceTypes?: readonly string[];
  readonly toolVersion: string;
}

export interface CreateAwsReadOnlyScanEngineConfig {
  readonly logger?: ScanLogger;
  readonly resourceTypes?: readonly string[];
  readonly retry?: RetryOptions;
  readonly toolVersion: string;
}

export class AwsScanEngine implements ScanEngine {
  private readonly logger: ScanLogger;
  private readonly resourceTypes: readonly string[];

  constructor(private readonly config: AwsScanEngineConfig) {
    this.logger = config.logger ?? createNoopLogger();
    this.resourceTypes = config.resourceTypes ?? DEFAULT_SCAN_RESOURCE_TYPES;
  }

  async scan(request: ScanRequest) {
    const resources: InventoryResource[] = [];
    const globalRegion = request.regions[0];
    if (!globalRegion) throw new Error("A scan region is required.");
    if (request.allRegions && !this.config.listEnabledRegions) {
      throw new Error("Enabled-region discovery is unavailable.");
    }
    if (request.allRegions)
      request.onProgress?.({
        operation: "DescribeRegions",
        region: globalRegion,
      });
    const regions = [
      ...new Set(
        request.allRegions
          ? await this.config.listEnabledRegions!(request)
          : request.regions,
      ),
    ].sort();
    if (regions.length === 0)
      throw new Error("No enabled regions were returned.");
    const resourceTypes = (request.resourceTypes ?? this.resourceTypes).filter(
      (type) => !request.excludeResourceTypes?.includes(type),
    );
    const globalTypes = resourceTypes.filter(isGlobalResourceType);
    const regionalTypes = resourceTypes.filter(
      (type) => !isGlobalResourceType(type),
    );
    const mode = request.globalServices ?? "include";
    const targets = [
      ...(mode === "only"
        ? []
        : regions.map((region) => ({
            region,
            resourceTypes: regionalTypes,
            global: false,
          }))),
      ...(mode !== "exclude" && globalTypes.length > 0
        ? [{ region: globalRegion, resourceTypes: globalTypes, global: true }]
        : []),
    ];
    request.onRegionsResolved?.(
      [
        ...new Set(
          targets.map((target) => (target.global ? "global" : target.region)),
        ),
      ].sort(),
    );

    for (const target of targets) {
      const { region } = target;
      request.onProgress?.({
        operation: "DescribeStacks/DescribeStackResources",
        region,
      });
      const sources = this.config.createRegionSources({ region, request });
      const managedResources =
        await sources.cloudFormation.listManagedResources({
          concurrency: request.concurrency,
        });
      const managedIndex =
        createCloudFormationManagedResourceIndex(managedResources);

      resources.push(
        ...(await this.collectCloudControlResources({
          cloudControl: sources.cloudControl,
          resourceTypes: target.resourceTypes.filter(
            (type) =>
              !sources.collectors?.some(
                (collector) => collector.id === "ec2-vpc",
              ) || !EC2_CONNECTION_RESOURCE_TYPES.includes(type),
          ),
          managedIndex,
          region: target.global ? "global" : region,
          ...(target.global ? { sourceRegion: region } : {}),
          request,
        })),
        ...(await this.collectResourceCollectors({
          collectors: target.global ? [] : (sources.collectors ?? []),
          managedIndex,
          region,
          request,
        })),
      );
    }

    return createInventoryDocument({
      resources: dedupeInventoryResources(resources),
      toolVersion: this.config.toolVersion,
    });
  }

  private async collectCloudControlResources(
    input: CollectCloudControlResourcesInput,
  ): Promise<readonly InventoryResource[]> {
    const resources: InventoryResource[] = [];
    const listedByType = new Map<string, readonly CloudControlResource[]>();
    const listResources = async (
      resourceType: string,
    ): Promise<readonly CloudControlResource[]> => {
      const cached = listedByType.get(resourceType);
      if (cached) return cached;
      let models: Array<Record<string, unknown> | undefined> = [undefined];
      if (resourceType === "AWS::ElasticLoadBalancingV2::Listener") {
        const parentType = "AWS::ElasticLoadBalancingV2::LoadBalancer";
        if (input.request.excludeResourceTypes?.includes(parentType)) {
          throw new Error(coreMessages.t("core.scan.listenerParentExcluded"));
        }
        // Listener LIST requires observed parent context, even in a listener-only scan.
        const parents = await listResources(parentType);
        models = [...new Set(parents.map((parent) => parent.identifier))]
          .sort()
          .map((LoadBalancerArn) => ({ LoadBalancerArn }));
      }
      input.request.onProgress?.({
        operation: "ListResources",
        resourceType,
        region: input.region,
      });
      const listedResources: CloudControlResource[] = [];
      for (const resourceModel of models) {
        for await (const resource of input.cloudControl.listResources({
          typeName: resourceType,
          ...(resourceModel ? { resourceModel } : {}),
        })) {
          listedResources.push(resource);
        }
      }
      listedByType.set(resourceType, listedResources);
      return listedResources;
    };

    for (const resourceType of input.resourceTypes) {
      // Cloud Control also lists AWS-owned IAM policies; they are existing references, not account resources.
      const listedResources = (await listResources(resourceType)).filter(
        (resource) =>
          resourceType !== "AWS::IAM::ManagedPolicy" ||
          !/^arn:[^:]+:iam::aws:policy\//.test(resource.identifier),
      );
      const detailedResources = await input.cloudControl.getResources({
        ...(input.request.onProgress
          ? {
              onProgress: (
                completed: number,
                total: number,
                identifier: string,
              ) =>
                input.request.onProgress?.({
                  operation: "GetResource",
                  resourceType,
                  region: input.region,
                  identifier,
                  completed,
                  total,
                }),
            }
          : {}),
        concurrency: input.request.concurrency,
        resources: listedResources.map((resource) => ({
          identifier: resource.identifier,
          typeName: resourceType,
        })),
      });

      input.request.onProgress?.({
        operation: "GetResource",
        resourceType,
        region: input.region,
        completed: detailedResources.length,
        total: listedResources.length,
      });

      for (const resource of detailedResources) {
        const inventoryResource = applyManagedState(
          toCloudControlInventoryResource({
            region: input.region,
            sourceRegion: input.sourceRegion,
            resource,
            resourceType,
          }),
          input.managedIndex,
        );

        if (shouldIncludeResource(inventoryResource, input.request)) {
          resources.push(inventoryResource);
        }
      }
    }

    return resources;
  }

  private async collectResourceCollectors(
    input: CollectResourceCollectorsInput,
  ): Promise<readonly InventoryResource[]> {
    const resources: InventoryResource[] = [];

    for (const collector of input.collectors) {
      const selectedTypes = collector.resourceTypes.filter(
        (type) =>
          (!input.request.resourceTypes ||
            input.request.resourceTypes.includes(type)) &&
          !input.request.excludeResourceTypes?.includes(type),
      );
      if (selectedTypes.length === 0) continue;
      input.request.onProgress?.({
        operation: `collector:${collector.id}`,
        region: input.region,
      });
      this.logger.debug("Running scan collector", {
        collectorId: collector.id,
        region: input.region,
        resourceTypes: collector.resourceTypes,
      });

      const collectedResources = await collector.collect({
        resourceTypes: selectedTypes,
        logger: this.logger,
        region: input.region,
      });

      for (const resource of collectedResources) {
        const inventoryResource = applyManagedState(
          resource,
          input.managedIndex,
        );

        if (
          selectedTypes.includes(resource.resourceType) &&
          shouldIncludeResource(inventoryResource, input.request)
        ) {
          resources.push(inventoryResource);
        }
      }
    }

    return resources;
  }
}

export function createAwsReadOnlyScanEngine(
  config: CreateAwsReadOnlyScanEngineConfig,
): AwsScanEngine {
  return new AwsScanEngine({
    listEnabledRegions(request) {
      return createEc2VpcReadClient({
        credentials: request.profile
          ? fromIni({ profile: request.profile })
          : undefined,
        region: request.regions[0]!,
        retry: config.retry,
      }).listEnabledRegions();
    },
    createRegionSources({ region, request }) {
      const credentials = request.profile
        ? fromIni({ profile: request.profile })
        : undefined;

      return {
        cloudControl: createCloudControlReadClient({
          concurrency: request.concurrency,
          credentials,
          region,
          retry: config.retry,
        }),
        cloudFormation: createCloudFormationReadClient({
          concurrency: request.concurrency,
          credentials,
          region,
          retry: config.retry,
        }),
        collectors: [
          new Ec2VpcResourceCollector(
            createEc2VpcReadClient({
              credentials,
              region,
              retry: config.retry,
            }),
          ),
        ],
      };
    },
    logger: config.logger,
    resourceTypes: config.resourceTypes,
    toolVersion: config.toolVersion,
  });
}

interface CollectCloudControlResourcesInput {
  readonly sourceRegion?: string;
  readonly resourceTypes: readonly string[];
  readonly cloudControl: CloudControlInventorySource;
  readonly managedIndex: CloudFormationManagedResourceIndexLike;
  readonly region: string;
  readonly request: ScanRequest;
}

interface CollectResourceCollectorsInput {
  readonly collectors: readonly ResourceCollector[];
  readonly managedIndex: CloudFormationManagedResourceIndexLike;
  readonly region: string;
  readonly request: ScanRequest;
}

interface CloudFormationManagedResourceIndexLike {
  isManaged(input: {
    readonly physicalResourceId?: string;
    readonly tags?: Record<string, string>;
  }): boolean;
}

function toCloudControlInventoryResource(input: {
  readonly sourceRegion?: string;
  readonly region: string;
  readonly resource: CloudControlResource;
  readonly resourceType: string;
}): InventoryResource {
  const properties = toInventoryPropertyRecord(
    input.resource.properties,
    `cloudControl.${input.resourceType}.${input.resource.identifier}`,
  );

  return {
    errors: [...(input.resource.errors ?? [])],
    identifier: input.resource.identifier,
    isCloudFormationManaged: false,
    properties,
    region: input.region,
    ...(input.sourceRegion ? { sourceRegion: input.sourceRegion } : {}),
    resourceType: input.resourceType,
    sourceApi: {
      operation: "GetResource",
      service: "CloudControl",
    },
    tags: extractInventoryTags(properties),
  };
}

function applyManagedState(
  resource: InventoryResource,
  managedIndex: CloudFormationManagedResourceIndexLike,
): InventoryResource {
  const isCloudFormationManaged = managedIndex.isManaged({
    physicalResourceId: resource.identifier,
    tags: resource.tags,
  });

  return {
    ...resource,
    isCloudFormationManaged,
  };
}

function shouldIncludeResource(
  resource: InventoryResource,
  request: ScanRequest,
): boolean {
  return request.includeManaged || !resource.isCloudFormationManaged;
}

export function isGlobalResourceType(resourceType: string): boolean {
  return /^(AWS::IAM::|AWS::CloudFront::|AWS::Route53::)/.test(resourceType);
}

function dedupeInventoryResources(
  resources: readonly InventoryResource[],
): readonly InventoryResource[] {
  const byKey = new Map<string, InventoryResource>();

  for (const resource of resources) {
    const key = inventoryResourceKey(resource);

    if (!byKey.has(key)) {
      byKey.set(key, resource);
    } else {
      const primary = byKey.get(key)!;
      const notes = [
        ...(primary.collectionNotes ?? []),
        ...(resource.collectionNotes ?? []),
      ];
      byKey.set(key, {
        ...primary,
        properties: { ...resource.properties, ...primary.properties },
        ...(notes.length > 0
          ? {
              collectionNotes: [
                ...new Map(
                  notes.map((note) => [JSON.stringify(note), note]),
                ).values(),
              ],
            }
          : {}),
      });
    }
  }

  return [...byKey.values()];
}

export function extractInventoryTags(
  properties: Record<string, unknown>,
): Record<string, string> {
  const tags = properties.Tags;

  if (Array.isArray(tags)) {
    return tagsArrayToRecord(tags);
  }

  if (isPlainObject(tags)) {
    return tagsObjectToRecord(tags);
  }

  return {};
}

function tagsArrayToRecord(tags: readonly unknown[]): Record<string, string> {
  const result: Record<string, string> = {};

  for (const tag of tags) {
    if (!isPlainObject(tag)) {
      continue;
    }

    const key = tag.Key ?? tag.key;
    const value = tag.Value ?? tag.value;

    if (typeof key === "string" && typeof value === "string") {
      result[key] = value;
    }
  }

  return result;
}

function tagsObjectToRecord(
  tags: Record<string, unknown>,
): Record<string, string> {
  const result: Record<string, string> = {};

  for (const [key, value] of Object.entries(tags)) {
    if (typeof value === "string") {
      result[key] = value;
    }
  }

  return result;
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return false;
  }

  const prototype = Object.getPrototypeOf(value) as unknown;
  return prototype === Object.prototype || prototype === null;
}

function createNoopLogger(): ScanLogger {
  return {
    debug() {},
    error() {},
    info() {},
    warn() {},
  };
}
