import { supported_languages, transmute } from "cdk-from-cfn";

import type { GapFinding } from "../normalize/schemas.js";

export type CdkOutputLanguage = "python" | "typescript";

export interface CfnToCdkInput {
  readonly boundaryReferencesByLogicalId?: Readonly<
    Record<
      string,
      readonly {
        readonly boundaryHandling: "import-reference" | "parameter" | "include";
        readonly type: "arn" | "id";
        readonly value: string;
      }[]
    >
  >;
  readonly classType: "construct" | "stack";
  readonly gapsByLogicalId?: Readonly<Record<string, readonly GapFinding[]>>;
  readonly language: CdkOutputLanguage;
  readonly stackClassName: string;
  readonly template: Readonly<Record<string, unknown>>;
}

export interface CfnToCdkAdapter {
  readonly supportedLanguages: () => readonly string[];
  readonly transmute: (input: CfnToCdkInput) => string;
}

export const cdkFromCfnAdapter: CfnToCdkAdapter = {
  supportedLanguages: () =>
    supported_languages()
      .filter((language): language is string => typeof language === "string")
      .sort(),
  transmute: (input) => {
    const languages = supported_languages();

    if (!languages.includes(input.language)) {
      throw new Error(
        `cdk-from-cfn does not support requested language: ${input.language}`,
      );
    }

    const generated = transmute(
      JSON.stringify(input.template),
      input.language,
      input.stackClassName,
      input.classType,
    );

    const normalized = normalizeGeneratedSource(generated);
    const gaps = input.gapsByLogicalId ?? {};
    const boundaryReferences = input.boundaryReferencesByLogicalId ?? {};

    return input.language === "python"
      ? decoratePythonStack(normalized, gaps, boundaryReferences)
      : decorateTypeScriptStack(normalized, gaps, boundaryReferences);
  },
};

export function decoratePythonStack(
  source: string,
  gapsByLogicalId: Readonly<Record<string, readonly GapFinding[]>>,
  boundaryReferencesByLogicalId: CfnToCdkInput["boundaryReferencesByLogicalId"] = {},
): string {
  const normalized = normalizeGeneratedSource(source);
  const usesParameterProps = normalized.includes("props[");
  const lines = normalized
    .split("\n")
    .filter(
      (line) =>
        !line.includes(
          ".cfn_options.deletion_policy = cdk.CfnDeletionPolicy.RETAIN",
        ),
    );
  const decorated: string[] = [];
  let pendingResource:
    | {
        readonly indent: string;
        readonly logicalId: string;
        readonly variableName: string;
      }
    | undefined;

  for (const line of lines) {
    if (
      usesParameterProps &&
      line.trimStart().startsWith("super().__init__(")
    ) {
      decorated.push(line, `${line.match(/^\s*/)?.[0] ?? ""}props = kwargs`);
      continue;
    }

    const resourceStart = line.match(
      /^(\s*)([A-Za-z_]\w*) = [A-Za-z_]\w*\.Cfn\w+\(self, '([^']+)',?$/,
    );

    if (resourceStart) {
      const [, indent = "", variableName = "resource", logicalId = "Resource"] =
        resourceStart;
      const gaps = gapsByLogicalId[logicalId] ?? [];
      const boundaryReferences =
        boundaryReferencesByLogicalId?.[logicalId] ?? [];

      for (const reference of boundaryReferences) {
        decorated.push(
          `${indent}# Boundary(${reference.boundaryHandling}): ${reference.type}=${singleLine(reference.value)}`,
        );
      }

      for (const gap of gaps) {
        decorated.push(
          `${indent}# TODO(${gap.code}): ${singleLine(gap.message)}`,
        );
      }

      decorated.push(line);
      pendingResource = { indent, logicalId, variableName };
      continue;
    }

    if (pendingResource && line.trim() === ")") {
      decorated.push(line);
      decorated.push(
        `${pendingResource.indent}${pendingResource.variableName}.override_logical_id(${JSON.stringify(pendingResource.logicalId)})`,
        `${pendingResource.indent}${pendingResource.variableName}.apply_removal_policy(cdk.RemovalPolicy.RETAIN)`,
      );
      pendingResource = undefined;
      continue;
    }

    decorated.push(line);
  }

  if (pendingResource) {
    throw new Error(
      `Unable to decorate generated CDK resource: ${pendingResource.logicalId}`,
    );
  }

  return `${decorated.join("\n").trimEnd()}\n`;
}

export function decorateTypeScriptStack(
  source: string,
  gapsByLogicalId: Readonly<Record<string, readonly GapFinding[]>>,
  boundaryReferencesByLogicalId: CfnToCdkInput["boundaryReferencesByLogicalId"] = {},
): string {
  const lines = normalizeGeneratedSource(source)
    .split("\n")
    .filter(
      (line) =>
        !line.includes(
          ".cfnOptions.deletionPolicy = cdk.CfnDeletionPolicy.RETAIN;",
        ),
    );
  const decorated: string[] = [];
  let pendingResource:
    | {
        readonly indent: string;
        readonly logicalId: string;
        readonly variableName: string;
      }
    | undefined;

  for (const rawLine of lines) {
    const line = rawLine.replace(/^(\s*)cdk-excavator:/, "$1'cdk-excavator':");
    const resourceStart = line.match(
      /^(\s*)const ([A-Za-z_$][\w$]*) = new .+\(this, '([^']+)'(?:, \{)?(?:\);)?$/,
    );

    if (resourceStart) {
      const [, indent = "", variableName, logicalId] = resourceStart;
      const gaps = gapsByLogicalId[logicalId ?? ""] ?? [];
      const boundaryReferences =
        boundaryReferencesByLogicalId?.[logicalId ?? ""] ?? [];

      for (const reference of boundaryReferences) {
        decorated.push(
          `${indent}// Boundary(${reference.boundaryHandling}): ${reference.type}=${singleLine(reference.value)}`,
        );
      }

      for (const gap of gaps) {
        decorated.push(
          `${indent}// TODO(${gap.code}): ${singleLine(gap.message)}`,
        );
      }

      decorated.push(line);

      if (line.endsWith(");")) {
        decorated.push(
          `${indent}${variableName}.overrideLogicalId('${logicalId}');`,
          `${indent}${variableName}.applyRemovalPolicy(cdk.RemovalPolicy.RETAIN);`,
        );
      } else {
        pendingResource = {
          indent,
          logicalId: logicalId ?? "Resource",
          variableName: variableName ?? "resource",
        };
      }

      continue;
    }

    if (pendingResource && line === `${pendingResource.indent}});`) {
      decorated.push(`${pendingResource.indent}} as any);`);
      decorated.push(
        `${pendingResource.indent}${pendingResource.variableName}.overrideLogicalId('${pendingResource.logicalId}');`,
        `${pendingResource.indent}${pendingResource.variableName}.applyRemovalPolicy(cdk.RemovalPolicy.RETAIN);`,
      );
      pendingResource = undefined;
      continue;
    }

    decorated.push(line);
  }

  if (pendingResource) {
    throw new Error(
      `Unable to decorate generated CDK resource: ${pendingResource.logicalId}`,
    );
  }

  return `${decorated.join("\n").trimEnd()}\n`;
}

function normalizeGeneratedSource(source: string): string {
  return source.replaceAll("\r\n", "\n").trimEnd();
}

function singleLine(value: string): string {
  return value.replace(/\s+/g, " ").trim();
}
