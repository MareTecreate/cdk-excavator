import type { GenerationDocuments } from "./generate-engine.js";
import type { GenerationReference, GenerationStack } from "./schemas.js";

export function hasCfnReferences(value: unknown): boolean {
  if (!value || typeof value !== "object") return false;
  if (Array.isArray(value)) return value.some(hasCfnReferences);
  return Object.entries(value).some(
    ([key, entry]) =>
      key === "Ref" ||
      key.startsWith("Fn::") ||
      key === "DependsOn" ||
      hasCfnReferences(entry),
  );
}

export function environmentSource(
  stack: GenerationStack | undefined,
  language: "typescript" | "python",
): string {
  if (!stack || (!stack.account && !stack.region)) return "";
  const values = Object.entries({
    account: stack.account,
    region: stack.region,
  }).filter(([, value]) => value);
  return language === "typescript"
    ? `env: ${JSON.stringify(Object.fromEntries(values))},`
    : `env=cdk.Environment(${values.map(([key, value]) => `${key}=${JSON.stringify(value)}`).join(", ")}),`;
}

export function canImportReference(reference: GenerationReference): boolean {
  return (
    importDescriptor(reference) !== undefined &&
    (reference.targetAttribute === "Ref" ||
      reference.targetAttribute === "Arn") &&
    /^\/(?:[A-Za-z0-9_:/-]+)$/.test(reference.propertyPath)
  );
}

export function stackAugmentation(
  documents: GenerationDocuments,
  language: "typescript" | "python",
): { imports: string[]; statements: string[] } {
  const python = language === "python",
    indent = python ? "        " : "    ";
  const imports = new Set<string>(),
    statements: string[] = [];
  const logicalIds = new Map(
    documents.importMap.resources.map((resource) => [
      resource.resourceKey,
      resource.logicalId,
    ]),
  );
  const get = (id: string) =>
    python
      ? `next(node for node in self.node.find_all() if isinstance(node, cdk.CfnResource) and self.resolve(node.logical_id) == ${JSON.stringify(id)})`
      : `(this.node.findAll().find((node): node is cdk.CfnResource => node instanceof cdk.CfnResource && this.resolve(node.logicalId) === ${JSON.stringify(id)})!)`;
  for (const [id, resource] of Object.entries(documents.template.Resources)) {
    // Typed CDK tag managers omit empty arrays; retain the reviewed template.
    if (
      Array.isArray(resource.Properties.Tags) &&
      resource.Properties.Tags.length === 0
    )
      statements.push(
        `${indent}${get(id)}.${python ? "add_property_override" : "addPropertyOverride"}("Tags", [])${python ? "" : ";"}`,
      );
    for (const dependency of resource.DependsOn ?? [])
      statements.push(
        `${indent}${get(id)}.${python ? "add_resource_dependency" : "addResourceDependency"}(${get(dependency)})${python ? "" : ";"}`,
      );
  }
  for (const [index, reference] of (
    documents.importMap.plan?.references ?? []
  ).entries()) {
    if (
      reference.sourceStack !== documents.importMap.stackName ||
      reference.disposition !== "import-reference" ||
      !canImportReference(reference)
    )
      continue;
    const logicalId = logicalIds.get(reference.from);
    if (!logicalId) continue;
    const descriptor = importDescriptor(reference)!;
    const alias = `boundary_${descriptor.module}`,
      variable = `boundaryImport${index + 1}`;
    imports.add(
      python
        ? `from aws_cdk import aws_${descriptor.module} as ${alias}`
        : `import * as ${alias} from 'aws-cdk-lib/aws-${descriptor.module}';`,
    );
    const physical = reference.valueSuffix
      ? reference.value.slice(0, -reference.valueSuffix.length)
      : reference.value;
    const args =
      descriptor.kind === "vpc"
        ? python
          ? `vpc_id=${JSON.stringify(physical)}, availability_zones=cdk.Fn.get_azs()`
          : `{ vpcId: ${JSON.stringify(physical)}, availabilityZones: cdk.Fn.getAzs() }`
        : JSON.stringify(physical);
    const method = python ? snake(descriptor.method) : descriptor.method;
    const attr = python ? snake(descriptor.attribute) : descriptor.attribute;
    statements.push(
      `${indent}${python ? "" : "const "}${variable} = ${alias}.${descriptor.className}.${method}(${python ? "self" : "this"}, ${JSON.stringify(`BoundaryImport${index + 1}`)}, ${args}${descriptor.kind === "security-group" ? (python ? ", mutable=False" : ", { mutable: false }") : ""})${python ? "" : ";"}`,
    );
    let value = `${variable}.${attr}`;
    if (reference.valueSuffix)
      value = python
        ? `cdk.Fn.join("", [${value}, ${JSON.stringify(reference.valueSuffix)}])`
        : `cdk.Fn.join('', [${value}, ${JSON.stringify(reference.valueSuffix)}])`;
    const path = reference.propertyPath.slice(1).replaceAll("/", ".");
    statements.push(
      `${indent}${get(logicalId)}.${python ? "add_property_override" : "addPropertyOverride"}(${JSON.stringify(path)}, ${value})${python ? "" : ";"}`,
    );
  }
  for (const [index, [id, output]] of Object.entries(
    documents.template.Outputs ?? {},
  ).entries()) {
    const value = JSON.stringify(output.Value);
    const variable = `referenceOutput${index + 1}`;
    statements.push(
      python
        ? `${indent}${variable} = cdk.CfnOutput(self, ${JSON.stringify(id)}, value=cdk.Token.as_string(${value}), export_name=${JSON.stringify(output.Export.Name)})`
        : `${indent}const ${variable} = new cdk.CfnOutput(this, ${JSON.stringify(id)}, { value: cdk.Token.asString(${value}), exportName: ${JSON.stringify(output.Export.Name)} });`,
    );
    statements.push(
      `${indent}${variable}.${python ? "override_logical_id" : "overrideLogicalId"}(${JSON.stringify(id)})${python ? "" : ";"}`,
    );
  }
  return { imports: [...imports].sort(), statements };
}

function importDescriptor(reference: GenerationReference):
  | {
      module: string;
      className: string;
      method: string;
      attribute: string;
      kind?: string;
    }
  | undefined {
  const arn = reference.value.startsWith("arn:");
  switch (reference.targetResourceType) {
    case "AWS::S3::Bucket":
      return {
        module: "s3",
        className: "Bucket",
        method: arn ? "fromBucketArn" : "fromBucketName",
        attribute: arn ? "bucketArn" : "bucketName",
      };
    case "AWS::IAM::Role":
      return {
        module: "iam",
        className: "Role",
        method: arn ? "fromRoleArn" : "fromRoleName",
        attribute: arn ? "roleArn" : "roleName",
      };
    case "AWS::IAM::InstanceProfile":
      return {
        module: "iam",
        className: "InstanceProfile",
        method: arn ? "fromInstanceProfileArn" : "fromInstanceProfileName",
        attribute: arn ? "instanceProfileArn" : "instanceProfileName",
      };
    case "AWS::EC2::VPC":
      return {
        module: "ec2",
        className: "Vpc",
        method: "fromVpcAttributes",
        attribute: "vpcId",
        kind: "vpc",
      };
    case "AWS::EC2::Subnet":
      return {
        module: "ec2",
        className: "Subnet",
        method: "fromSubnetId",
        attribute: "subnetId",
      };
    case "AWS::EC2::SecurityGroup":
      return {
        module: "ec2",
        className: "SecurityGroup",
        method: "fromSecurityGroupId",
        attribute: "securityGroupId",
        kind: "security-group",
      };
    default:
      return undefined;
  }
}
function snake(value: string): string {
  return value.replace(/[A-Z]/g, (letter) => `_${letter.toLowerCase()}`);
}
