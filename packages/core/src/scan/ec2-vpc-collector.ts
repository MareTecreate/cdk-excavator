import type {
  InternetGateway,
  NatGateway,
  RouteTable,
  SecurityGroup,
  Subnet,
  Tag,
  Vpc,
  VpcEndpoint,
} from "@aws-sdk/client-ec2";

import type { InventoryResource } from "../model/schemas.js";
import {
  EC2_VPC_RESOURCE_TYPES,
  type Ec2VpcResources,
  type ListEc2VpcResourcesInput,
} from "./ec2-vpc-client.js";
import { toInventoryPropertyRecord } from "./inventory-properties.js";
import {
  extractEc2Connections,
  projectEc2CfnResource,
} from "./ec2-cfn-projection.js";
import type { CollectorContext, ResourceCollector } from "./types.js";

export interface Ec2VpcResourceSource {
  listVpcResources(input?: ListEc2VpcResourcesInput): Promise<Ec2VpcResources>;
}

export class Ec2VpcResourceCollector implements ResourceCollector {
  readonly id = "ec2-vpc";
  readonly resourceTypes = EC2_VPC_RESOURCE_TYPES;

  constructor(private readonly source: Ec2VpcResourceSource) {}

  async collect(
    context: CollectorContext,
  ): Promise<readonly InventoryResource[]> {
    const resources = await this.source.listVpcResources({
      resourceTypes: context.resourceTypes,
    });

    const parents = [
      ...resources.vpcs.map((vpc, index) =>
        toEc2InventoryResource({
          context,
          identifier: vpc.VpcId,
          operation: "DescribeVpcs",
          path: `vpcs[${index}]`,
          properties: vpc,
          resourceType: "AWS::EC2::VPC",
          tags: vpc.Tags,
        }),
      ),
      ...resources.subnets.map((subnet, index) =>
        toEc2InventoryResource({
          context,
          identifier: subnet.SubnetId,
          operation: "DescribeSubnets",
          path: `subnets[${index}]`,
          properties: subnet,
          resourceType: "AWS::EC2::Subnet",
          tags: subnet.Tags,
        }),
      ),
      ...resources.routeTables.map((routeTable, index) =>
        toEc2InventoryResource({
          context,
          identifier: routeTable.RouteTableId,
          operation: "DescribeRouteTables",
          path: `routeTables[${index}]`,
          properties: routeTable,
          resourceType: "AWS::EC2::RouteTable",
          tags: routeTable.Tags,
        }),
      ),
      ...resources.securityGroups.map((securityGroup, index) =>
        toEc2InventoryResource({
          context,
          identifier: securityGroup.GroupId,
          operation: "DescribeSecurityGroups",
          path: `securityGroups[${index}]`,
          properties: securityGroup,
          resourceType: "AWS::EC2::SecurityGroup",
          tags: securityGroup.Tags,
        }),
      ),
      ...resources.natGateways.map((natGateway, index) =>
        toEc2InventoryResource({
          context,
          identifier: natGateway.NatGatewayId,
          operation: "DescribeNatGateways",
          path: `natGateways[${index}]`,
          properties: natGateway,
          resourceType: "AWS::EC2::NatGateway",
          tags: natGateway.Tags,
        }),
      ),
      ...resources.vpcEndpoints.map((vpcEndpoint, index) =>
        toEc2InventoryResource({
          context,
          identifier: vpcEndpoint.VpcEndpointId,
          operation: "DescribeVpcEndpoints",
          path: `vpcEndpoints[${index}]`,
          properties: vpcEndpoint,
          resourceType: "AWS::EC2::VPCEndpoint",
          tags: vpcEndpoint.Tags,
        }),
      ),
      ...resources.internetGateways.map((internetGateway, index) =>
        toEc2InventoryResource({
          context,
          identifier: internetGateway.InternetGatewayId,
          operation: "DescribeInternetGateways",
          path: `internetGateways[${index}]`,
          properties: internetGateway,
          resourceType: "AWS::EC2::InternetGateway",
          tags: internetGateway.Tags,
        }),
      ),
    ]
      .filter(isDefined)
      .map(projectEc2CfnResource);
    const connections = extractEc2Connections(resources, parents);
    return [...parents, ...connections].filter(
      (resource) =>
        !context.resourceTypes ||
        context.resourceTypes.includes(resource.resourceType),
    );
  }
}

interface ToEc2InventoryResourceInput {
  readonly context: CollectorContext;
  readonly identifier?: string;
  readonly operation: string;
  readonly path: string;
  readonly properties:
    | InternetGateway
    | NatGateway
    | RouteTable
    | SecurityGroup
    | Subnet
    | Vpc
    | VpcEndpoint;
  readonly resourceType: string;
  readonly tags?: readonly Tag[];
}

function toEc2InventoryResource(
  input: ToEc2InventoryResourceInput,
): InventoryResource | undefined {
  if (!input.identifier) {
    input.context.logger.warn("EC2/VPC resource is missing an identifier", {
      operation: input.operation,
      path: input.path,
      resourceType: input.resourceType,
    });
    return undefined;
  }

  return {
    accountId: input.context.accountId,
    errors: [],
    identifier: input.identifier,
    isCloudFormationManaged: false,
    properties: toInventoryPropertyRecord(
      input.properties as Record<string, unknown>,
      input.path,
    ),
    region: input.context.region,
    resourceType: input.resourceType,
    sourceApi: {
      operation: input.operation,
      service: "EC2",
    },
    tags: ec2TagsToRecord(input.tags),
  };
}

export function ec2TagsToRecord(
  tags: readonly Tag[] | undefined,
): Record<string, string> {
  const result: Record<string, string> = {};

  for (const tag of tags ?? []) {
    if (tag.Key && tag.Value !== undefined) {
      result[tag.Key] = tag.Value;
    }
  }

  return result;
}

function isDefined<T>(value: T | undefined): value is T {
  return value !== undefined;
}
