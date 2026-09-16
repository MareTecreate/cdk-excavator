import internetGateway from "./schemas/aws-ec2-internetgateway.json" with { type: "json" };
import natGateway from "./schemas/aws-ec2-natgateway.json" with { type: "json" };
import routeTable from "./schemas/aws-ec2-routetable.json" with { type: "json" };
import securityGroup from "./schemas/aws-ec2-securitygroup.json" with { type: "json" };
import subnet from "./schemas/aws-ec2-subnet.json" with { type: "json" };
import vpc from "./schemas/aws-ec2-vpc.json" with { type: "json" };
import vpcEndpoint from "./schemas/aws-ec2-vpcendpoint.json" with { type: "json" };
import propertyRules from "./gap-rules/property-rules.json" with { type: "json" };
import networkConnections from "./schemas/network-connections.json" with { type: "json" };
import supportingResources from "./schemas/supporting-resources.json" with { type: "json" };

import {
  CfnResourceSchemaSchema,
  GapRuleSetSchema,
  type CfnResourceSchema,
  type GapRuleSet,
} from "../normalize/schemas.js";

const bundledSchemas = [
  ...networkConnections,
  ...supportingResources,
  internetGateway,
  natGateway,
  routeTable,
  securityGroup,
  subnet,
  vpc,
  vpcEndpoint,
].map((schema) => CfnResourceSchemaSchema.parse(schema));

const bundledGapRules = GapRuleSetSchema.parse(propertyRules);

export function loadBundledCfnSchemas(): readonly CfnResourceSchema[] {
  return bundledSchemas;
}

export function loadBundledGapRules(): GapRuleSet {
  return bundledGapRules;
}
