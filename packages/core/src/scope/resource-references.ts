import type { InventoryResource } from "../model/schemas.js";
import { loadBundledCfnSchemas } from "../defaults/normalization-defaults.js";
import {
  extractReferences,
  type ExtractedReference,
} from "./reference-extractor.js";

export interface ResourceReference extends ExtractedReference {
  readonly propertyPath?: string;
  readonly targetType?: string;
}

const namedRelationships: Readonly<
  Record<string, Readonly<Record<string, string>>>
> = {
  "AWS::EC2::Instance": { "/IamInstanceProfile": "AWS::IAM::InstanceProfile" },
  "AWS::IAM::InstanceProfile": { "/Roles/*": "AWS::IAM::Role" },
  "AWS::IAM::Role": { "/ManagedPolicyArns/*": "AWS::IAM::ManagedPolicy" },
  "AWS::IAM::Policy": { "/Roles/*": "AWS::IAM::Role" },
  "AWS::IAM::ManagedPolicy": { "/Roles/*": "AWS::IAM::Role" },
  "AWS::RDS::DBInstance": {
    "/DBSubnetGroupName": "AWS::RDS::DBSubnetGroup",
    "/DBClusterIdentifier": "AWS::RDS::DBCluster",
  },
  "AWS::Lambda::Function": {
    "/Role": "AWS::IAM::Role",
    "/Code/S3Bucket": "AWS::S3::Bucket",
  },
  "AWS::S3::BucketPolicy": { "/Bucket": "AWS::S3::Bucket" },
  "AWS::S3::Bucket": {
    "/LoggingConfiguration/DestinationBucketName": "AWS::S3::Bucket",
    "/ReplicationConfiguration/Role": "AWS::IAM::Role",
  },
};

const idTypes: Readonly<Record<string, string>> = {
  vpc: "AWS::EC2::VPC",
  subnet: "AWS::EC2::Subnet",
  sg: "AWS::EC2::SecurityGroup",
  rtb: "AWS::EC2::RouteTable",
  nat: "AWS::EC2::NatGateway",
  vpce: "AWS::EC2::VPCEndpoint",
  igw: "AWS::EC2::InternetGateway",
  i: "AWS::EC2::Instance",
  eipalloc: "AWS::EC2::EIP",
};

const aliasProperties: Readonly<Record<string, readonly string[]>> = {
  "AWS::IAM::Role": ["RoleName", "Arn"],
  "AWS::IAM::InstanceProfile": ["InstanceProfileName", "Arn"],
  "AWS::IAM::ManagedPolicy": ["ManagedPolicyName", "PolicyArn"],
  "AWS::S3::Bucket": ["BucketName", "Arn"],
  "AWS::RDS::DBInstance": ["DBInstanceIdentifier", "DBInstanceArn"],
  "AWS::RDS::DBSubnetGroup": ["DBSubnetGroupName"],
  "AWS::ElasticLoadBalancingV2::LoadBalancer": ["LoadBalancerArn"],
  "AWS::ElasticLoadBalancingV2::TargetGroup": ["TargetGroupArn"],
  "AWS::ElasticLoadBalancingV2::Listener": ["ListenerArn"],
};

export function resourceAliases(
  resource: InventoryResource,
): readonly string[] {
  const schema = loadBundledCfnSchemas().find(
    (schema) => schema.typeName === resource.resourceType,
  );
  const keys = new Set(aliasProperties[resource.resourceType] ?? []);
  if (schema?.primaryIdentifier.length === 1) {
    const pointer = schema.primaryIdentifier[0]!;
    if (/^\/properties\/[^/]+$/.test(pointer)) keys.add(pointer.slice(12));
  }
  return [
    ...new Set([
      resource.identifier,
      ...[...keys].flatMap((key) =>
        typeof resource.properties[key] === "string"
          ? [resource.properties[key] as string]
          : [],
      ),
    ]),
  ].sort();
}

export function extractResourceReferences(
  resource: Pick<InventoryResource, "resourceType" | "properties">,
): readonly ResourceReference[] {
  const strings = new Map<string, { pointer: string; value: string }>();
  walk(resource.properties, "$", "", strings);
  const schema = loadBundledCfnSchemas().find(
    (schema) => schema.typeName === resource.resourceType,
  );
  for (const [path, leaf] of strings) {
    if (
      /\/(?:Password|MasterUserPassword|SecretAccessKey|AccessKeyId|ApiKey|SessionToken|SecretValue)$/i.test(
        leaf.pointer,
      ) ||
      (schema?.writeOnlyProperties ?? []).some((pointer) => {
        const excluded = pointer.replace(/^\/properties/, "").split("/");
        const actual = leaf.pointer.split("/");
        return (
          excluded.length <= actual.length &&
          excluded.every(
            (part, index) => part === "*" || part === actual[index],
          )
        );
      })
    )
      strings.delete(path);
  }
  const references = new Map<string, ResourceReference>();
  for (const reference of extractReferences(resource.properties)) {
    const leaf = strings.get(reference.path);
    if (!leaf || leaf.value !== reference.value || isObservation(leaf.pointer))
      continue;
    references.set(reference.path, {
      ...reference,
      propertyPath: leaf.pointer,
    });
  }
  for (const [path, leaf] of strings) {
    if (isObservation(leaf.pointer)) continue;
    const pattern = leaf.pointer.replace(/\/\d+(?=\/|$)/g, "/*");
    const targetType =
      namedRelationships[resource.resourceType]?.[pattern] ??
      idTypes[/^([a-z]+)-[0-9a-f]+$/i.exec(leaf.value)?.[1] ?? ""];
    if (targetType)
      references.set(path, {
        path,
        propertyPath: leaf.pointer,
        targetType,
        value: leaf.value,
        type: leaf.value.startsWith("arn:") ? "arn" : "id",
      });
  }
  return [...references.values()].sort((a, b) =>
    `${a.path}:${a.value}`.localeCompare(`${b.path}:${b.value}`),
  );
}

function isObservation(pointer: string): boolean {
  return (
    /^\/(?:Tags|Metadata)(?:\/|$)/.test(pointer) ||
    /\/(?:Description|UserData)$/.test(pointer)
  );
}

function walk(
  value: unknown,
  path: string,
  pointer: string,
  strings: Map<string, { pointer: string; value: string }>,
): void {
  if (typeof value === "string") strings.set(path, { pointer, value });
  else if (Array.isArray(value))
    value.forEach((entry, index) =>
      walk(entry, `${path}[${index}]`, `${pointer}/${index}`, strings),
    );
  else if (value && typeof value === "object")
    for (const [key, entry] of Object.entries(value))
      walk(
        entry,
        `${path}.${key}`,
        `${pointer}/${key.replace(/~/g, "~0").replace(/\//g, "~1")}`,
        strings,
      );
}

export interface ResolvedReference {
  readonly target: InventoryResource;
  readonly attribute?: string;
  readonly suffix: string;
}

export function resolveResourceReference(
  source: InventoryResource,
  reference: Pick<ResourceReference, "type" | "value" | "targetType">,
  resources: readonly InventoryResource[],
): readonly ResolvedReference[] {
  return createReferenceResolver(resources)(source, reference);
}

export function createReferenceResolver(
  resources: readonly InventoryResource[],
) {
  const index = new Map<string, InventoryResource[]>();
  const aliasesByResource = new Map<InventoryResource, readonly string[]>();
  for (const resource of resources) {
    const aliases = resourceAliases(resource);
    aliasesByResource.set(resource, aliases);
    for (const alias of aliases)
      index.set(alias, [...(index.get(alias) ?? []), resource]);
  }
  return (
    source: InventoryResource,
    reference: Pick<ResourceReference, "type" | "value" | "targetType">,
  ): readonly ResolvedReference[] => {
    const arn = parseArn(reference.value);
    const alias =
      arn?.service === "s3"
        ? arn.resource.split("/")[0]
        : arn?.service === "iam"
          ? arn.resource.split("/").at(-1)
          : undefined;
    const candidates = [
      ...new Set([
        ...(index.get(reference.value) ?? []),
        ...(alias ? (index.get(alias) ?? []) : []),
      ]),
    ];
    const matches: ResolvedReference[] = [];
    for (const target of candidates) {
      if (reference.targetType && target.resourceType !== reference.targetType)
        continue;
      if (
        source.accountId &&
        target.accountId &&
        source.accountId !== target.accountId &&
        !arn?.account
      )
        continue;
      if (arn?.account && target.accountId && arn.account !== target.accountId)
        continue;
      if (
        arn?.region &&
        target.region !== arn.region &&
        target.region !== "global"
      )
        continue;
      if (
        !arn &&
        source.region !== "global" &&
        target.region !== "global" &&
        source.region !== target.region
      )
        continue;
      const aliases = aliasesByResource.get(target)!;
      if (aliases.includes(reference.value)) {
        matches.push({
          target,
          attribute: referenceAttribute(
            target,
            reference.value,
            reference.type,
          ),
          suffix: "",
        });
        continue;
      }
      // ARN resource components are aliases, not evidence for inventing an account or region.
      if (arn?.service === "s3" && target.resourceType === "AWS::S3::Bucket") {
        const [name, ...tail] = arn.resource.split("/");
        if (name && aliases.includes(name))
          matches.push({
            target,
            attribute: "Arn",
            suffix: tail.length ? `/${tail.join("/")}` : "",
          });
      }
      if (arn?.service === "iam") {
        const kind =
          target.resourceType === "AWS::IAM::Role"
            ? "role"
            : target.resourceType === "AWS::IAM::InstanceProfile"
              ? "instance-profile"
              : target.resourceType === "AWS::IAM::ManagedPolicy"
                ? "policy"
                : undefined;
        if (
          kind &&
          arn.resource.startsWith(`${kind}/`) &&
          aliases.includes(arn.resource.split("/").at(-1)!)
        ) {
          const explicitArn = aliases.find((alias) => alias.startsWith("arn:"));
          if (
            explicitArn === reference.value ||
            (!explicitArn && target.accountId === arn.account)
          )
            matches.push({
              target,
              attribute:
                target.resourceType === "AWS::IAM::ManagedPolicy"
                  ? "Ref"
                  : "Arn",
              suffix: "",
            });
        }
      }
    }
    return matches;
  };
}

function referenceAttribute(
  resource: InventoryResource,
  value: string,
  type: string,
): string | undefined {
  if (
    resource.resourceType === "AWS::EC2::EIP" &&
    value.startsWith("eipalloc-")
  )
    return "AllocationId";
  if (type !== "arn") {
    // Only supported identity forms may become CDK tokens; unknown aliases remain reviewable literals.
    if (resource.resourceType === "AWS::IAM::ManagedPolicy") return undefined;
    return "Ref";
  }
  const attributes: Readonly<Record<string, string>> = {
    "AWS::S3::Bucket": "Arn",
    "AWS::IAM::Role": "Arn",
    "AWS::IAM::InstanceProfile": "Arn",
    "AWS::IAM::ManagedPolicy": "Ref",
    "AWS::RDS::DBInstance": "DBInstanceArn",
    "AWS::SNS::Topic": "Ref",
    "AWS::SQS::Queue": "Arn",
    "AWS::ElasticLoadBalancingV2::LoadBalancer": "Ref",
    "AWS::ElasticLoadBalancingV2::TargetGroup": "Ref",
    "AWS::ElasticLoadBalancingV2::Listener": "Ref",
  };
  return attributes[resource.resourceType];
}

export function parseArn(
  value: string,
):
  | { service: string; region: string; account: string; resource: string }
  | undefined {
  const match = /^arn:aws(?:-[a-z]+)*:([^:]+):([^:]*):([^:]*):(.+)$/.exec(
    value,
  );
  return match
    ? {
        service: match[1]!,
        region: match[2]!,
        account: match[3]!,
        resource: match[4]!,
      }
    : undefined;
}
