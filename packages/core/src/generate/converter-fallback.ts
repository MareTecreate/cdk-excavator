import type { CfnToCdkAdapter, CfnToCdkInput } from "./cdk-from-cfn-adapter.js";
import type { GeneratedCfnResource } from "./schemas.js";

export interface ConverterFallbackResult {
  readonly fallbacks: readonly ConverterFallbackDiagnostic[];
  readonly fallbackResources: Readonly<Record<string, GeneratedCfnResource>>;
  readonly source: string;
}

export interface ConverterFallbackDiagnostic {
  readonly category: "unsupported-property";
  readonly group: string;
  readonly logicalIds: readonly string[];
  readonly property: string;
  readonly reason: "cdk-from-cfn-unsupported-property";
  readonly rejectedLogicalId: string;
  readonly resourceType: string;
}

export function transmuteWithGenericFallback(
  adapter: CfnToCdkAdapter,
  input: CfnToCdkInput,
  resources: Readonly<Record<string, GeneratedCfnResource>>,
): ConverterFallbackResult {
  try {
    return {
      fallbacks: [],
      fallbackResources: {},
      source: adapter.transmute(input),
    };
  } catch (error) {
    const fallback = classifyUnsupportedProperty(error, input, resources);
    if (!fallback) {
      throw error;
    }

    return {
      fallbacks: [fallback],
      fallbackResources: resources,
      source: adapter.transmute({
        ...input,
        template: {
          ...input.template,
          Resources: {},
        },
      }),
    };
  }
}

export function formatConverterFallbackReport(
  fallbacks: readonly ConverterFallbackDiagnostic[],
): string {
  return `${JSON.stringify(
    {
      entries: [...fallbacks].sort((left, right) =>
        `${left.group}:${left.rejectedLogicalId}:${left.property}`.localeCompare(
          `${right.group}:${right.rejectedLogicalId}:${right.property}`,
        ),
      ),
      mode: "known-rejection-only",
      schemaVersion: "1.0",
    },
    null,
    2,
  )}\n`;
}

function classifyUnsupportedProperty(
  error: unknown,
  input: CfnToCdkInput,
  resources: Readonly<Record<string, GeneratedCfnResource>>,
): ConverterFallbackDiagnostic | undefined {
  if (!(error instanceof Error) || Object.keys(resources).length === 0) {
    return undefined;
  }

  const match = error.message.match(
    /^([A-Za-z][A-Za-z0-9]*) is not a valid property for resource ([A-Za-z][A-Za-z0-9]*) of type (AWS::[A-Za-z0-9]+::[A-Za-z0-9]+)$/,
  );
  if (!match) {
    return undefined;
  }

  const [, property, rejectedLogicalId, resourceType] = match;
  if (!property || !rejectedLogicalId || !resourceType) {
    return undefined;
  }

  const rejectedResource = resources[rejectedLogicalId];
  if (
    !rejectedResource ||
    rejectedResource.Type !== resourceType ||
    !Object.hasOwn(rejectedResource.Properties, property)
  ) {
    return undefined;
  }

  return {
    category: "unsupported-property",
    group: input.stackClassName,
    logicalIds: Object.keys(resources).sort(),
    property,
    reason: "cdk-from-cfn-unsupported-property",
    rejectedLogicalId,
    resourceType,
  };
}
