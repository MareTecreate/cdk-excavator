import {
  DescribeInternetGatewaysCommand,
  DescribeNatGatewaysCommand,
  DescribeRegionsCommand,
  DescribeRouteTablesCommand,
  DescribeSecurityGroupsCommand,
  DescribeSubnetsCommand,
  DescribeVpcEndpointsCommand,
  DescribeVpcsCommand,
  EC2Client,
  type EC2ClientConfig as AwsEc2ClientConfig,
  type DescribeInternetGatewaysCommandOutput,
  type DescribeNatGatewaysCommandOutput,
  type DescribeRegionsCommandOutput,
  type DescribeRouteTablesCommandOutput,
  type DescribeSecurityGroupsCommandOutput,
  type DescribeSubnetsCommandOutput,
  type DescribeVpcEndpointsCommandOutput,
  type DescribeVpcsCommandOutput,
  type Filter,
  type InternetGateway,
  type NatGateway,
  type RouteTable,
  type SecurityGroup,
  type Subnet,
  type Vpc,
  type VpcEndpoint,
} from "@aws-sdk/client-ec2";

import { paginateByToken } from "./pagination.js";
import { retryWithBackoff, type RetryOptions } from "./retry.js";

export const EC2_VPC_RESOURCE_TYPES = [
  "AWS::EC2::VPC",
  "AWS::EC2::Subnet",
  "AWS::EC2::RouteTable",
  "AWS::EC2::SecurityGroup",
  "AWS::EC2::NatGateway",
  "AWS::EC2::VPCEndpoint",
  "AWS::EC2::InternetGateway",
  "AWS::EC2::Route",
  "AWS::EC2::SubnetRouteTableAssociation",
  "AWS::EC2::VPCGatewayAttachment",
] as const;

export interface Ec2VpcReadClientConfig {
  readonly credentials?: AwsEc2ClientConfig["credentials"];
  readonly region: string;
  readonly retry?: RetryOptions;
}

export interface Ec2VpcReadClientOptions {
  readonly retry?: RetryOptions;
}

export interface Ec2VpcListInput {
  readonly filters?: readonly Filter[];
  readonly maxResults?: number;
}

export interface ListEc2VpcResourcesInput {
  readonly resourceTypes?: readonly string[];
  readonly maxResults?: number;
}

export interface Ec2VpcResources {
  readonly vpcs: readonly Vpc[];
  readonly subnets: readonly Subnet[];
  readonly routeTables: readonly RouteTable[];
  readonly securityGroups: readonly SecurityGroup[];
  readonly natGateways: readonly NatGateway[];
  readonly vpcEndpoints: readonly VpcEndpoint[];
  readonly internetGateways: readonly InternetGateway[];
}

export interface Ec2VpcSdkClient {
  send(command: DescribeRegionsCommand): Promise<DescribeRegionsCommandOutput>;
  send(command: DescribeVpcsCommand): Promise<DescribeVpcsCommandOutput>;
  send(command: DescribeSubnetsCommand): Promise<DescribeSubnetsCommandOutput>;
  send(
    command: DescribeRouteTablesCommand,
  ): Promise<DescribeRouteTablesCommandOutput>;
  send(
    command: DescribeSecurityGroupsCommand,
  ): Promise<DescribeSecurityGroupsCommandOutput>;
  send(
    command: DescribeNatGatewaysCommand,
  ): Promise<DescribeNatGatewaysCommandOutput>;
  send(
    command: DescribeVpcEndpointsCommand,
  ): Promise<DescribeVpcEndpointsCommandOutput>;
  send(
    command: DescribeInternetGatewaysCommand,
  ): Promise<DescribeInternetGatewaysCommandOutput>;
}

export class Ec2VpcReadClient {
  constructor(
    private readonly client: Ec2VpcSdkClient,
    private readonly options: Ec2VpcReadClientOptions = {},
  ) {}

  async listEnabledRegions(): Promise<readonly string[]> {
    const output = await retryWithBackoff(
      () => this.client.send(new DescribeRegionsCommand({ AllRegions: false })),
      this.options.retry,
    );
    return [
      ...new Set(
        (output.Regions ?? [])
          .filter((region) => region.OptInStatus !== "not-opted-in")
          .flatMap((region) => (region.RegionName ? [region.RegionName] : [])),
      ),
    ].sort();
  }

  listVpcs(input: Ec2VpcListInput = {}): AsyncGenerator<Vpc> {
    return paginateByToken<Vpc>({
      fetchPage: async (nextToken) => {
        const output = await retryWithBackoff(
          () =>
            this.client.send(
              new DescribeVpcsCommand({
                Filters: cloneFilters(input.filters),
                MaxResults: input.maxResults,
                NextToken: nextToken,
              }),
            ),
          this.options.retry,
        );

        return {
          items: output.Vpcs ?? [],
          nextToken: output.NextToken,
        };
      },
    });
  }

  listSubnets(input: Ec2VpcListInput = {}): AsyncGenerator<Subnet> {
    return paginateByToken<Subnet>({
      fetchPage: async (nextToken) => {
        const output = await retryWithBackoff(
          () =>
            this.client.send(
              new DescribeSubnetsCommand({
                Filters: cloneFilters(input.filters),
                MaxResults: input.maxResults,
                NextToken: nextToken,
              }),
            ),
          this.options.retry,
        );

        return {
          items: output.Subnets ?? [],
          nextToken: output.NextToken,
        };
      },
    });
  }

  listRouteTables(input: Ec2VpcListInput = {}): AsyncGenerator<RouteTable> {
    return paginateByToken<RouteTable>({
      fetchPage: async (nextToken) => {
        const output = await retryWithBackoff(
          () =>
            this.client.send(
              new DescribeRouteTablesCommand({
                Filters: cloneFilters(input.filters),
                MaxResults: input.maxResults,
                NextToken: nextToken,
              }),
            ),
          this.options.retry,
        );

        return {
          items: output.RouteTables ?? [],
          nextToken: output.NextToken,
        };
      },
    });
  }

  listSecurityGroups(
    input: Ec2VpcListInput = {},
  ): AsyncGenerator<SecurityGroup> {
    return paginateByToken<SecurityGroup>({
      fetchPage: async (nextToken) => {
        const output = await retryWithBackoff(
          () =>
            this.client.send(
              new DescribeSecurityGroupsCommand({
                Filters: cloneFilters(input.filters),
                MaxResults: input.maxResults,
                NextToken: nextToken,
              }),
            ),
          this.options.retry,
        );

        return {
          items: output.SecurityGroups ?? [],
          nextToken: output.NextToken,
        };
      },
    });
  }

  listNatGateways(input: Ec2VpcListInput = {}): AsyncGenerator<NatGateway> {
    return paginateByToken<NatGateway>({
      fetchPage: async (nextToken) => {
        const output = await retryWithBackoff(
          () =>
            this.client.send(
              new DescribeNatGatewaysCommand({
                Filter: cloneFilters(input.filters),
                MaxResults: input.maxResults,
                NextToken: nextToken,
              }),
            ),
          this.options.retry,
        );

        return {
          items: output.NatGateways ?? [],
          nextToken: output.NextToken,
        };
      },
    });
  }

  listVpcEndpoints(input: Ec2VpcListInput = {}): AsyncGenerator<VpcEndpoint> {
    return paginateByToken<VpcEndpoint>({
      fetchPage: async (nextToken) => {
        const output = await retryWithBackoff(
          () =>
            this.client.send(
              new DescribeVpcEndpointsCommand({
                Filters: cloneFilters(input.filters),
                MaxResults: input.maxResults,
                NextToken: nextToken,
              }),
            ),
          this.options.retry,
        );

        return {
          items: output.VpcEndpoints ?? [],
          nextToken: output.NextToken,
        };
      },
    });
  }

  listInternetGateways(
    input: Ec2VpcListInput = {},
  ): AsyncGenerator<InternetGateway> {
    return paginateByToken<InternetGateway>({
      fetchPage: async (nextToken) => {
        const output = await retryWithBackoff(
          () =>
            this.client.send(
              new DescribeInternetGatewaysCommand({
                Filters: cloneFilters(input.filters),
                MaxResults: input.maxResults,
                NextToken: nextToken,
              }),
            ),
          this.options.retry,
        );

        return {
          items: output.InternetGateways ?? [],
          nextToken: output.NextToken,
        };
      },
    });
  }

  async listVpcResources(
    input: ListEc2VpcResourcesInput = {},
  ): Promise<Ec2VpcResources> {
    const selected = (type: string) =>
      !input.resourceTypes || input.resourceTypes.includes(type);
    const [
      vpcs,
      subnets,
      routeTables,
      securityGroups,
      natGateways,
      vpcEndpoints,
      internetGateways,
    ] = await Promise.all([
      selected("AWS::EC2::VPC")
        ? collectAsync(this.listVpcs({ maxResults: input.maxResults }))
        : [],
      selected("AWS::EC2::Subnet")
        ? collectAsync(this.listSubnets({ maxResults: input.maxResults }))
        : [],
      selected("AWS::EC2::RouteTable") ||
      selected("AWS::EC2::Route") ||
      selected("AWS::EC2::SubnetRouteTableAssociation")
        ? collectAsync(this.listRouteTables({ maxResults: input.maxResults }))
        : [],
      selected("AWS::EC2::SecurityGroup")
        ? collectAsync(
            this.listSecurityGroups({ maxResults: input.maxResults }),
          )
        : [],
      selected("AWS::EC2::NatGateway")
        ? collectAsync(this.listNatGateways({ maxResults: input.maxResults }))
        : [],
      selected("AWS::EC2::VPCEndpoint")
        ? collectAsync(this.listVpcEndpoints({ maxResults: input.maxResults }))
        : [],
      selected("AWS::EC2::InternetGateway") ||
      selected("AWS::EC2::VPCGatewayAttachment")
        ? collectAsync(
            this.listInternetGateways({ maxResults: input.maxResults }),
          )
        : [],
    ]);

    return {
      vpcs,
      subnets,
      routeTables,
      securityGroups,
      natGateways,
      vpcEndpoints,
      internetGateways,
    };
  }
}

export function createEc2VpcReadClient(
  config: Ec2VpcReadClientConfig,
): Ec2VpcReadClient {
  return new Ec2VpcReadClient(
    new EC2Client({
      credentials: config.credentials,
      region: config.region,
    }),
    {
      retry: config.retry,
    },
  );
}

function cloneFilters(
  filters: readonly Filter[] | undefined,
): Filter[] | undefined {
  return filters?.map((filter) => ({
    ...filter,
    Values: filter.Values ? [...filter.Values] : undefined,
  }));
}

async function collectAsync<TItem>(
  items: AsyncIterable<TItem>,
): Promise<readonly TItem[]> {
  const results: TItem[] = [];

  for await (const item of items) {
    results.push(item);
  }

  return results;
}
