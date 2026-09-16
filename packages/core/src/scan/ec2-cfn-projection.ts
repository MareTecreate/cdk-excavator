import type { IpPermission } from "@aws-sdk/client-ec2";
import type { InventoryResource } from "../model/schemas.js";
import type { Ec2VpcResources } from "./ec2-vpc-client.js";

type Note = NonNullable<InventoryResource["collectionNotes"]>[number];

export const EC2_CONNECTION_RESOURCE_TYPES: readonly string[] = [
  "AWS::EC2::Route",
  "AWS::EC2::SubnetRouteTableAssociation",
  "AWS::EC2::VPCGatewayAttachment",
];

export function projectEc2CfnResource(
  resource: InventoryResource,
): InventoryResource {
  const properties = { ...resource.properties };
  const notes: Note[] = [...(resource.collectionNotes ?? [])];
  const rename = (from: string, to: string) => {
    if (!Object.hasOwn(properties, from)) return;
    if (!Object.hasOwn(properties, to)) properties[to] = properties[from];
    else if (properties[to] !== properties[from])
      notes.push(note(from, "core.gap.unmapped"));
    delete properties[from];
    notes.push(note(from, "core.gap.ec2Mapped"));
  };
  if (resource.resourceType === "AWS::EC2::SecurityGroup") {
    rename("Description", "GroupDescription");
    for (const [from, to, ingress] of [
      ["IpPermissions", "SecurityGroupIngress", true],
      ["IpPermissionsEgress", "SecurityGroupEgress", false],
    ] as const) {
      if (!Array.isArray(properties[from])) continue;
      const permissions = properties[from] as IpPermission[];
      if (!Object.hasOwn(properties, to)) {
        properties[to] = permissions.flatMap((permission) =>
          projectPermission(permission, ingress),
        );
      } else notes.push(note(from, "core.gap.unmapped"));
      delete properties[from];
      notes.push(note(from, "core.gap.ec2Mapped"));
      permissions.forEach((permission, index) =>
        notes.push(
          ...permissionLossNotes(permission, ingress, `${from}/${index}`),
        ),
      );
      // Unknown destination forms must remain visible instead of becoming an empty rule list.
      if (
        permissions.some(
          (permission) => projectPermission(permission, ingress).length === 0,
        )
      )
        notes.push(note(from, "core.gap.unmapped"));
    }
  }
  return {
    ...resource,
    properties,
    ...(notes.length > 0 ? { collectionNotes: notes } : {}),
  };
}

function permissionLossNotes(
  permission: IpPermission,
  ingress: boolean,
  path: string,
): Note[] {
  const notes: Note[] = [];
  const destinations = [
    ["IpRanges", "CidrIp"],
    ["Ipv6Ranges", "CidrIpv6"],
    ["PrefixListIds", "PrefixListId"],
    ["UserIdGroupPairs", "GroupId"],
  ] as const;
  const supported = new Set<string>([
    "IpProtocol",
    "FromPort",
    "ToPort",
    ...destinations.map(([key]) => key),
  ]);
  for (const [key, value] of Object.entries(permission)) {
    if (value !== undefined && !supported.has(key))
      notes.push(note(`${path}/${key}`, "core.gap.unmapped"));
  }
  for (const [key, target] of destinations) {
    for (const [index, entry] of (permission[key] ?? []).entries()) {
      const value = entry as Record<string, unknown>;
      if (!value[target])
        notes.push(note(`${path}/${key}/${index}`, "core.gap.unmapped"));
      for (const field of Object.keys(value)) {
        if (
          value[field] !== undefined &&
          ![
            target,
            "Description",
            ...(key === "UserIdGroupPairs" && ingress ? ["UserId"] : []),
          ].includes(field)
        )
          notes.push(
            note(`${path}/${key}/${index}/${field}`, "core.gap.unmapped"),
          );
      }
    }
  }
  return notes;
}

function projectPermission(
  permission: IpPermission,
  ingress: boolean,
): Record<string, unknown>[] {
  const common = {
    ...(permission.IpProtocol !== undefined
      ? { IpProtocol: permission.IpProtocol }
      : {}),
    ...(permission.FromPort !== undefined
      ? { FromPort: permission.FromPort }
      : {}),
    ...(permission.ToPort !== undefined ? { ToPort: permission.ToPort } : {}),
  };
  const rule = (target: Record<string, unknown>, description?: string) => ({
    ...common,
    ...target,
    ...(description !== undefined ? { Description: description } : {}),
  });
  return [
    ...(permission.IpRanges ?? [])
      .filter((range) => range.CidrIp)
      .map((range) => rule({ CidrIp: range.CidrIp }, range.Description)),
    ...(permission.Ipv6Ranges ?? [])
      .filter((range) => range.CidrIpv6)
      .map((range) => rule({ CidrIpv6: range.CidrIpv6 }, range.Description)),
    ...(permission.PrefixListIds ?? [])
      .filter((range) => range.PrefixListId)
      .map((range) =>
        rule(
          {
            [ingress ? "SourcePrefixListId" : "DestinationPrefixListId"]:
              range.PrefixListId,
          },
          range.Description,
        ),
      ),
    ...(permission.UserIdGroupPairs ?? [])
      .filter((pair) => pair.GroupId)
      .map((pair) =>
        rule(
          {
            [ingress ? "SourceSecurityGroupId" : "DestinationSecurityGroupId"]:
              pair.GroupId,
            ...(ingress && pair.UserId
              ? { SourceSecurityGroupOwnerId: pair.UserId }
              : {}),
          },
          pair.Description,
        ),
      ),
  ];
}

const ROUTE_PROPERTIES = [
  "DestinationCidrBlock",
  "DestinationIpv6CidrBlock",
  "DestinationPrefixListId",
  "CarrierGatewayId",
  "CoreNetworkArn",
  "EgressOnlyInternetGatewayId",
  "GatewayId",
  "InstanceId",
  "LocalGatewayId",
  "NatGatewayId",
  "NetworkInterfaceId",
  "OdbNetworkArn",
  "TransitGatewayId",
  "VpcEndpointId",
  "VpcPeeringConnectionId",
] as const;

export function extractEc2Connections(
  input: Ec2VpcResources,
  parents: readonly InventoryResource[],
): InventoryResource[] {
  const byIdentifier = new Map(
    parents.map((resource) => [resource.identifier, resource]),
  );
  const result: InventoryResource[] = [];
  const add = (
    parent: InventoryResource,
    type: string,
    identifier: string,
    properties: Record<string, unknown>,
  ) => {
    result.push({
      ...parent,
      identifier,
      resourceType: `AWS::EC2::${type}`,
      properties,
      collectionNotes: [],
    });
  };
  for (const table of input.routeTables) {
    const parent = table.RouteTableId
      ? byIdentifier.get(table.RouteTableId)
      : undefined;
    if (!parent) continue;
    for (const [index, route] of (table.Routes ?? []).entries()) {
      const path = `Routes/${index}`;
      if (
        route.GatewayId === "local" ||
        (route.Origin && route.Origin !== "CreateRoute")
      ) {
        appendNote(parent, note(path, "core.gap.ec2Managed"));
        continue;
      }
      const destination =
        route.DestinationCidrBlock ??
        route.DestinationIpv6CidrBlock ??
        route.DestinationPrefixListId;
      if (!destination) {
        appendNote(parent, note(path, "core.gap.unmapped"));
        continue;
      }
      const values = route as Record<string, unknown>;
      const targetCount = ROUTE_PROPERTIES.filter(
        (key) => !key.startsWith("Destination") && values[key] !== undefined,
      ).length;
      if (targetCount !== 1)
        appendNote(parent, note(path, "core.gap.unmapped"));
      const properties = Object.fromEntries(
        ROUTE_PROPERTIES.filter((key) => values[key] !== undefined).map(
          (key) => [key, values[key]],
        ),
      );
      add(parent, "Route", `${parent.identifier}|${destination}`, {
        ...properties,
        RouteTableId: parent.identifier,
      });
      appendNote(parent, note(path, "core.gap.ec2Split"));
      if (route.State === "blackhole")
        appendNote(parent, note(path, "core.gap.unmapped"));
      for (const key of Object.keys(values)) {
        if (
          !(ROUTE_PROPERTIES as readonly string[]).includes(key) &&
          !["State", "Origin", "InstanceOwnerId"].includes(key)
        )
          appendNote(parent, note(`${path}/${key}`, "core.gap.unmapped"));
      }
    }
    for (const [index, association] of (table.Associations ?? []).entries()) {
      const path = `Associations/${index}`;
      if (association.Main)
        appendNote(parent, note(path, "core.gap.ec2Managed"));
      else if (association.SubnetId && association.RouteTableAssociationId) {
        add(
          parent,
          "SubnetRouteTableAssociation",
          association.RouteTableAssociationId,
          {
            RouteTableId: parent.identifier,
            SubnetId: association.SubnetId,
          },
        );
        appendNote(parent, note(path, "core.gap.ec2Split"));
      } else appendNote(parent, note(path, "core.gap.unmapped"));
    }
    delete parent.properties.Routes;
    delete parent.properties.Associations;
  }
  for (const gateway of input.internetGateways) {
    const parent = gateway.InternetGatewayId
      ? byIdentifier.get(gateway.InternetGatewayId)
      : undefined;
    if (!parent) continue;
    for (const [index, attachment] of (gateway.Attachments ?? []).entries()) {
      if (attachment.VpcId) {
        add(
          parent,
          "VPCGatewayAttachment",
          `${parent.identifier}|${attachment.VpcId}`,
          {
            InternetGatewayId: parent.identifier,
            VpcId: attachment.VpcId,
          },
        );
        appendNote(parent, note(`Attachments/${index}`, "core.gap.ec2Split"));
      } else
        appendNote(parent, note(`Attachments/${index}`, "core.gap.unmapped"));
    }
    delete parent.properties.Attachments;
  }
  return result;
}

function note(path: string, messageKey: Note["messageKey"]): Note {
  return {
    code: messageKey === "core.gap.unmapped" ? "GAP-1" : "GAP-4",
    propertyPath: `/properties/${path}`,
    messageKey,
  };
}

function appendNote(resource: InventoryResource, value: Note): void {
  resource.collectionNotes = [...(resource.collectionNotes ?? []), value];
}
