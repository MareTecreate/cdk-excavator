import type { InventoryResource } from "../model/schemas.js";
import { inventoryResourceKey } from "../scan/inventory.js";
import type { ScopeGraph, ScopedResource } from "./schemas.js";

export function isOutsideVpc(
  resource: Pick<InventoryResource, "resourceType" | "region">,
): boolean {
  return (
    resource.region === "global" ||
    /^(AWS::S3::|AWS::IAM::|AWS::CloudFront::|AWS::Route53::)/.test(
      resource.resourceType,
    )
  );
}

export function createPlacementResolver(
  resources: readonly InventoryResource[],
  graph: ScopeGraph,
) {
  const byKey = new Map(
    resources.map((entry) => [inventoryResourceKey(entry), entry]),
  );
  const outgoing = new Map<string, string[]>();
  for (const edge of graph.edges) {
    const path = edge.propertyPath ?? "";
    if (
      /^\/(?:VpcId|SubnetId|Subnets\/\d+|SubnetIds\/\d+|SubnetMappings\/\d+\/SubnetId|DBSubnetGroupName|LoadBalancerArn|RouteTableId)$/.test(
        path,
      ) ||
      (byKey.get(edge.from)?.resourceType === "AWS::EC2::InternetGateway" &&
        /^\/Attachments\/\d+\/VpcId$/.test(path))
    ) {
      outgoing.set(edge.from, [...(outgoing.get(edge.from) ?? []), edge.to]);
    }
    // The attachment owns the relationship; it is not a reverse dependency selection rule.
    if (
      byKey.get(edge.from)?.resourceType === "AWS::EC2::VPCGatewayAttachment" &&
      path === "/InternetGatewayId"
    ) {
      outgoing.set(edge.to, [...(outgoing.get(edge.to) ?? []), edge.from]);
    }
  }
  return (
    resource: InventoryResource,
  ): NonNullable<ScopedResource["placement"]> => {
    if (isOutsideVpc(resource)) return { vpcIds: [], availabilityZones: [] };
    const visited = new Set<string>();
    const pending = [inventoryResourceKey(resource)];
    const vpcs = new Set<string>();
    const zones = new Set<string>();
    while (pending.length) {
      const key = pending.pop()!;
      if (visited.has(key)) continue;
      visited.add(key);
      const current = byKey.get(key);
      if (
        !current ||
        isOutsideVpc(current) ||
        current.region !== resource.region
      )
        continue;
      if (current.resourceType === "AWS::EC2::VPC")
        vpcs.add(current.identifier);
      if (typeof current.properties.VpcId === "string")
        vpcs.add(current.properties.VpcId);
      if (typeof current.properties.AvailabilityZone === "string")
        zones.add(current.properties.AvailabilityZone);
      pending.push(...(outgoing.get(key) ?? []));
    }
    return { vpcIds: [...vpcs].sort(), availabilityZones: [...zones].sort() };
  };
}
