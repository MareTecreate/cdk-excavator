import type { GapDocument, GapFinding } from "../normalize/schemas.js";
import {
  cdkFromCfnAdapter,
  type CfnToCdkAdapter,
} from "./cdk-from-cfn-adapter.js";
import {
  formatConverterFallbackReport,
  transmuteWithGenericFallback,
  type ConverterFallbackDiagnostic,
} from "./converter-fallback.js";
import type { GenerationDocuments } from "./generate-engine.js";
import {
  environmentSource,
  hasCfnReferences,
  stackAugmentation,
} from "./project-references.js";
import {
  combineStackProjects,
  stackArtifactFiles,
} from "./multi-stack-project.js";
import { coreMessages } from "../messages.js";
import { assertCdkJsonRepresentable } from "../model/json-safety.js";
import {
  evaluateL2Lift,
  isL2LiftResourceType,
  type L2LiftEvaluation,
} from "./l2-lift.js";
import {
  resourceGroupName,
  stackClassIdentifier,
  toCamelIdentifier,
  toKebabIdentifier,
} from "./naming.js";
import type {
  GeneratedCfnResource,
  GeneratedCfnParameter,
  ImportBoundaryReference,
} from "./schemas.js";
import { TYPESCRIPT_PACKAGE_LOCK_TEMPLATE } from "./typescript-package-lock.js";

const GENERATED_PROJECT_VERSION = "0.0.0";
const GENERATED_DEPENDENCIES = {
  "aws-cdk-lib": "2.263.0",
  constructs: "10.6.0",
} as const;
const GENERATED_DEV_DEPENDENCIES = {
  "@types/node": "24.13.2",
  "aws-cdk": "2.1131.0",
  "ts-node": "10.9.2",
  typescript: "5.9.3",
} as const;
const GENERIC_CFN_FALLBACK_TYPES = new Set(["AWS::CloudFront::Distribution"]);

export interface GeneratedProjectFile {
  readonly contents: string;
  readonly path: string;
}

export interface TypeScriptCdkProject {
  readonly converterFallbacks: readonly ConverterFallbackDiagnostic[];
  readonly files: readonly GeneratedProjectFile[];
  readonly packageName: string;
  readonly stackClassName: string;
  readonly stackFile: string;
}

export interface CreateTypeScriptCdkProjectInput {
  readonly adapter?: CfnToCdkAdapter;
  readonly documents: GenerationDocuments;
  readonly gaps: GapDocument;
  readonly liftL2?: boolean;
}

interface ResourceGroup {
  readonly className: string;
  readonly fileName: string;
  readonly parameterLogicalIds: readonly string[];
  readonly resources: Readonly<Record<string, GeneratedCfnResource>>;
}

interface PackageLock {
  name: string;
  packages: Record<
    string,
    {
      license?: string;
      name?: string;
      version?: string;
    }
  >;
  version: string;
}

export function createTypeScriptCdkProject(
  input: CreateTypeScriptCdkProjectInput,
): TypeScriptCdkProject {
  for (const resource of Object.values(input.documents.template.Resources))
    assertCdkJsonRepresentable(resource.Properties);
  if ((input.documents.stacks?.length ?? 0) > 1)
    return combineStackProjects(input.documents, "typescript", (documents) =>
      createTypeScriptCdkProject({ ...input, documents }),
    );
  const adapter = input.adapter ?? cdkFromCfnAdapter;
  const stackName = input.documents.importMap.stackName;
  const stackClassName = stackClassIdentifier(stackName);
  const stackFileBase = toKebabIdentifier(stackName) || "excavated-stack";
  const stackFile = `lib/${stackFileBase}.ts`;
  const packageName = `${stackFileBase}-cdk`;
  const groups = createResourceGroups(
    input.documents.template.Resources,
    input.documents.template.Parameters ?? {},
  );
  const gapsByLogicalId = createGapsByLogicalId(
    input.documents,
    input.gaps.gaps,
  );
  const boundaryReferencesByLogicalId = createBoundaryReferencesByLogicalId(
    input.documents.importMap.externalReferences,
  );
  const files: GeneratedProjectFile[] = [];
  const l2Evaluations: L2LiftEvaluation[] = [];
  const converterFallbacks: ConverterFallbackDiagnostic[] = [];

  for (const group of groups) {
    const genericResources = Object.fromEntries(
      Object.entries(group.resources).filter(([logicalId, resource]) =>
        requiresGenericCfnResource(resource, gapsByLogicalId[logicalId] ?? []),
      ),
    );
    const typedResources = Object.fromEntries(
      Object.entries(group.resources).filter(
        ([logicalId, resource]) =>
          !requiresGenericCfnResource(
            resource,
            gapsByLogicalId[logicalId] ?? [],
          ),
      ),
    );
    const groupL2Evaluations = input.liftL2
      ? evaluateGroupL2Lifts(group.resources, gapsByLogicalId, genericResources)
      : [];
    l2Evaluations.push(...groupL2Evaluations);
    const liftedLogicalIds = new Set(
      groupL2Evaluations
        .filter((evaluation) => evaluation.status === "lifted")
        .map((evaluation) => evaluation.logicalId),
    );
    const finalTypedResources = Object.fromEntries(
      Object.entries(typedResources).filter(
        ([logicalId]) => !liftedLogicalIds.has(logicalId),
      ),
    );
    const conversion = transmuteWithGenericFallback(
      adapter,
      {
        classType: "construct",
        boundaryReferencesByLogicalId,
        gapsByLogicalId,
        language: "typescript",
        stackClassName: group.className,
        template: {
          AWSTemplateFormatVersion:
            input.documents.template.AWSTemplateFormatVersion,
          ...(group.parameterLogicalIds.length > 0
            ? {
                Parameters: Object.fromEntries(
                  group.parameterLogicalIds.map((logicalId) => [
                    logicalId,
                    input.documents.template.Parameters?.[logicalId],
                  ]),
                ),
              }
            : {}),
          Resources: finalTypedResources,
        },
      },
      finalTypedResources,
    );
    const finalGenericResources = {
      ...genericResources,
      ...conversion.fallbackResources,
    };
    converterFallbacks.push(...conversion.fallbacks);

    files.push({
      contents: injectAdditionalResources(
        conversion.source,
        finalGenericResources,
        groupL2Evaluations,
        gapsByLogicalId,
        boundaryReferencesByLogicalId,
        conversion.fallbacks,
      ),
      path: `lib/resources/${group.fileName}.ts`,
    });
  }

  files.push(
    {
      contents: formatPackageJson(packageName),
      path: "package.json",
    },
    {
      contents: formatPackageLock(packageName),
      path: "package-lock.json",
    },
    {
      contents: formatCdkJson(),
      path: "cdk.json",
    },
    {
      contents: formatTsconfig(),
      path: "tsconfig.json",
    },
    {
      contents: formatGitignore(),
      path: ".gitignore",
    },
    {
      contents: formatBoundaryReferences(
        input.documents.importMap.externalReferences,
      ),
      path: "lib/boundary-references.ts",
    },
    {
      contents: formatStackFile(
        stackClassName,
        groups,
        input.documents.template.Parameters ?? {},
        input.documents,
      ),
      path: stackFile,
    },
    {
      contents: formatBinFile(
        stackClassName,
        stackFileBase,
        stackName,
        input.documents,
      ),
      path: "bin/cdk-excavator.ts",
    },
    {
      contents: formatReadme(stackName),
      path: "README.md",
    },
  );

  files.push(...stackArtifactFiles(input.documents));

  if (input.liftL2) {
    files.push({
      contents: formatJson({
        entries: l2Evaluations
          .filter((evaluation) => evaluation.status !== "not-eligible")
          .map((evaluation) => ({
            differences: evaluation.differences,
            logicalId: evaluation.logicalId,
            reason: evaluation.reason,
            resourceType: evaluation.resourceType,
            status: evaluation.status,
          }))
          .sort((left, right) => left.logicalId.localeCompare(right.logicalId)),
        mode: "synth-diff-zero",
        resourceTypes: [
          "AWS::S3::Bucket",
          "AWS::SNS::Topic",
          "AWS::SQS::Queue",
        ],
      }),
      path: "l2-lift-report.json",
    });
  }

  if (converterFallbacks.length > 0) {
    files.push({
      contents: formatConverterFallbackReport(converterFallbacks),
      path: "converter-fallbacks.json",
    });
  }

  return {
    converterFallbacks,
    files: files.sort((left, right) => left.path.localeCompare(right.path)),
    packageName,
    stackClassName,
    stackFile,
  };
}

function requiresGenericCfnResource(
  resource: GeneratedCfnResource,
  gaps: readonly GapFinding[],
): boolean {
  return (
    GENERIC_CFN_FALLBACK_TYPES.has(resource.Type) ||
    hasCfnReferences(resource) ||
    gaps.some((gap) => gap.code === "GAP-2" || gap.code === "GAP-3")
  );
}

function evaluateGroupL2Lifts(
  resources: Readonly<Record<string, GeneratedCfnResource>>,
  gapsByLogicalId: Readonly<Record<string, readonly GapFinding[]>>,
  genericResources: Readonly<Record<string, GeneratedCfnResource>>,
): L2LiftEvaluation[] {
  return Object.keys(resources)
    .sort()
    .filter((logicalId) => {
      const resource = resources[logicalId];
      return resource && isL2LiftResourceType(resource.Type);
    })
    .map((logicalId) => {
      const resource = resources[logicalId];

      if (!resource) {
        throw new Error(`Missing generated resource: ${logicalId}`);
      }

      if (genericResources[logicalId]) {
        return {
          differences: [],
          logicalId,
          reason: hasCfnReferences(resource)
            ? "reference-preservation-required"
            : `generic-l1-required:${
                (gapsByLogicalId[logicalId] ?? [])
                  .map((gap) => gap.code)
                  .join(",") || resource.Type
              }`,
          resourceType: resource.Type,
          status: "fallback" as const,
        };
      }

      return evaluateL2Lift(logicalId, resource);
    });
}

function injectAdditionalResources(
  source: string,
  resources: Readonly<Record<string, GeneratedCfnResource>>,
  l2Evaluations: readonly L2LiftEvaluation[],
  gapsByLogicalId: Readonly<Record<string, readonly GapFinding[]>>,
  boundaryReferencesByLogicalId: Readonly<
    Record<string, readonly ImportBoundaryReference[]>
  >,
  converterFallbacks: readonly ConverterFallbackDiagnostic[],
): string {
  const genericSnippets = Object.keys(resources)
    .sort()
    .map((logicalId, index) => {
      const resource = resources[logicalId];

      if (!resource) {
        return "";
      }

      const variableName = `genericResource${index + 1}`;
      const options = indentJson(
        {
          properties: resource.Properties,
          type: resource.Type,
        },
        4,
      );
      const metadata = indentJson(resource.Metadata, 4);
      const todos = (gapsByLogicalId[logicalId] ?? []).map(
        (gap) => `    // TODO(${gap.code}): ${singleLine(gap.message)}`,
      );
      const boundaryNotes = (
        boundaryReferencesByLogicalId[logicalId] ?? []
      ).map(
        (reference) =>
          `    // Boundary(${reference.boundaryHandling}): ${reference.type}=${singleLine(reference.value)}`,
      );
      const converterNotes = converterFallbacks
        .filter((fallback) => fallback.logicalIds.includes(logicalId))
        .map(
          (fallback) =>
            `    // TODO(CONVERTER-FALLBACK): ${fallback.reason}; group=${fallback.group} rejected=${fallback.rejectedLogicalId}.${fallback.property} type=${fallback.resourceType}`,
        );

      return [
        ...(hasCfnReferences(resource)
          ? [`    // ${coreMessages.t("core.generate.references")}`]
          : []),
        ...boundaryNotes,
        ...todos,
        ...converterNotes,
        `    const ${variableName} = new cdk.CfnResource(this, '${escapeSingleQuoted(logicalId)}', ${options});`,
        `    ${variableName}.cfnOptions.metadata = ${metadata};`,
        `    ${variableName}.overrideLogicalId('${escapeSingleQuoted(logicalId)}');`,
        `    ${variableName}.applyRemovalPolicy(cdk.RemovalPolicy.RETAIN);`,
      ].join("\n");
    })
    .filter(Boolean);
  const liftedSnippets = l2Evaluations
    .filter(
      (
        evaluation,
      ): evaluation is L2LiftEvaluation & {
        candidate: NonNullable<L2LiftEvaluation["candidate"]>;
      } => evaluation.status === "lifted" && Boolean(evaluation.candidate),
    )
    .sort((left, right) => left.logicalId.localeCompare(right.logicalId))
    .map((evaluation, index) => {
      const todos = (gapsByLogicalId[evaluation.logicalId] ?? []).map(
        (gap) => `    // TODO(${gap.code}): ${singleLine(gap.message)}`,
      );
      const boundaryNotes = (
        boundaryReferencesByLogicalId[evaluation.logicalId] ?? []
      ).map(
        (reference) =>
          `    // Boundary(${reference.boundaryHandling}): ${reference.type}=${singleLine(reference.value)}`,
      );

      return [
        ...boundaryNotes,
        ...todos,
        "    // L2 lift accepted: synthesized resource is identical to the L1 template.",
        ...evaluation.candidate.renderTypeScript(`liftedResource${index + 1}`),
      ].join("\n");
    });
  const snippets = [...genericSnippets, ...liftedSnippets];

  if (snippets.length === 0) {
    return source;
  }

  const imports = l2Evaluations
    .flatMap((evaluation) =>
      evaluation.candidate ? [evaluation.candidate] : [],
    )
    .sort((left, right) => left.importPath.localeCompare(right.importPath));
  let decoratedSource = source;

  for (const candidate of imports) {
    const importLine = `import * as ${candidate.importAlias} from '${candidate.importPath}';`;

    if (decoratedSource.includes(importLine)) {
      continue;
    }

    const cdkImport = "import * as cdk from 'aws-cdk-lib';\n";

    if (!decoratedSource.includes(cdkImport)) {
      throw new Error("Unable to locate aws-cdk-lib import for L2 lift");
    }

    decoratedSource = decoratedSource.replace(
      cdkImport,
      `${cdkImport}${importLine}\n`,
    );
  }

  const marker = "    // Resources\n";

  if (!decoratedSource.includes(marker)) {
    throw new Error("Unable to locate cdk-from-cfn resource insertion point");
  }

  return decoratedSource.replace(marker, `${marker}${snippets.join("\n\n")}\n`);
}

function createBoundaryReferencesByLogicalId(
  references: readonly ImportBoundaryReference[],
): Readonly<Record<string, readonly ImportBoundaryReference[]>> {
  const result: Record<string, ImportBoundaryReference[]> = {};

  for (const reference of references) {
    if (!reference.referencedByLogicalId) {
      continue;
    }

    const current = result[reference.referencedByLogicalId] ?? [];
    current.push(reference);
    result[reference.referencedByLogicalId] = current;
  }

  for (const [logicalId, entries] of Object.entries(result)) {
    result[logicalId] = entries.sort((left, right) =>
      `${left.type}:${left.value}`.localeCompare(
        `${right.type}:${right.value}`,
      ),
    );
  }

  return result;
}

function createResourceGroups(
  resources: Readonly<Record<string, GeneratedCfnResource>>,
  parameters: Readonly<Record<string, GeneratedCfnParameter>>,
): ResourceGroup[] {
  const grouped = new Map<string, Record<string, GeneratedCfnResource>>();

  for (const logicalId of Object.keys(resources).sort()) {
    const resource = resources[logicalId];

    if (!resource) {
      continue;
    }

    const className = resourceGroupName(resource.Type);
    const current = grouped.get(className) ?? {};
    current[logicalId] = resource;
    grouped.set(className, current);
  }

  return [...grouped.entries()]
    .sort(([left], [right]) => left.localeCompare(right))
    .map(([className, groupResources]) => ({
      className,
      fileName: toKebabIdentifier(className),
      parameterLogicalIds: collectReferencedParameters(
        groupResources,
        parameters,
      ),
      resources: groupResources,
    }));
}

function collectReferencedParameters(
  resources: Readonly<Record<string, GeneratedCfnResource>>,
  parameters: Readonly<Record<string, GeneratedCfnParameter>>,
): string[] {
  const known = new Set(Object.keys(parameters));
  const referenced = new Set<string>();

  collectRefs(resources, known, referenced);
  return [...referenced].sort();
}

function collectRefs(
  value: unknown,
  known: ReadonlySet<string>,
  referenced: Set<string>,
): void {
  if (Array.isArray(value)) {
    for (const entry of value) {
      collectRefs(entry, known, referenced);
    }
    return;
  }

  if (!value || typeof value !== "object") {
    return;
  }

  const record = value as Readonly<Record<string, unknown>>;
  const reference = record.Ref;

  if (typeof reference === "string" && known.has(reference)) {
    referenced.add(reference);
  }

  for (const entry of Object.values(record)) {
    collectRefs(entry, known, referenced);
  }
}

function createGapsByLogicalId(
  documents: GenerationDocuments,
  gaps: readonly GapFinding[],
): Readonly<Record<string, readonly GapFinding[]>> {
  const byResourceKey = new Map<string, GapFinding[]>();
  const result: Record<string, readonly GapFinding[]> = {};

  for (const gap of gaps) {
    const current = byResourceKey.get(gap.resourceKey) ?? [];
    current.push(gap);
    byResourceKey.set(gap.resourceKey, current);
  }

  for (const resource of documents.importMap.resources) {
    result[resource.logicalId] = [
      ...(byResourceKey.get(resource.resourceKey) ?? []),
    ].sort((left, right) =>
      `${left.code}:${left.propertyPath ?? ""}`.localeCompare(
        `${right.code}:${right.propertyPath ?? ""}`,
      ),
    );
  }

  return result;
}

function formatPackageJson(packageName: string): string {
  return formatJson({
    name: packageName,
    version: GENERATED_PROJECT_VERSION,
    private: true,
    license: "UNLICENSED",
    scripts: {
      build: "tsc",
      synth: "cdk synth",
    },
    dependencies: GENERATED_DEPENDENCIES,
    devDependencies: GENERATED_DEV_DEPENDENCIES,
  });
}

function formatPackageLock(packageName: string): string {
  const lock = JSON.parse(TYPESCRIPT_PACKAGE_LOCK_TEMPLATE) as PackageLock;
  const root = lock.packages[""];

  if (!root) {
    throw new Error("Generated TypeScript package lock is missing its root");
  }

  lock.name = packageName;
  lock.version = GENERATED_PROJECT_VERSION;
  root.name = packageName;
  root.version = GENERATED_PROJECT_VERSION;
  root.license = "UNLICENSED";

  return formatJson(lock);
}

function formatCdkJson(): string {
  return formatJson({
    app: "npx ts-node --prefer-ts-exts bin/cdk-excavator.ts",
    assetMetadata: false,
    pathMetadata: false,
    versionReporting: false,
  });
}

function formatTsconfig(): string {
  return formatJson({
    compilerOptions: {
      alwaysStrict: true,
      declaration: true,
      esModuleInterop: true,
      experimentalDecorators: true,
      inlineSourceMap: true,
      inlineSources: true,
      lib: ["es2022"],
      module: "CommonJS",
      noFallthroughCasesInSwitch: true,
      noImplicitAny: true,
      noImplicitReturns: true,
      noImplicitThis: true,
      resolveJsonModule: true,
      strict: true,
      strictNullChecks: true,
      strictPropertyInitialization: true,
      target: "ES2022",
      typeRoots: ["./node_modules/@types"],
    },
    exclude: ["cdk.out"],
  });
}

function formatGitignore(): string {
  return ["cdk.out/", "dist/", "node_modules/", "*.js", "*.d.ts", ""].join(
    "\n",
  );
}

function formatBoundaryReferences(
  references: readonly ImportBoundaryReference[],
): string {
  const value = JSON.stringify(references, null, 2);

  return `${[
    "// Generated boundary decisions. Review before replacing physical IDs/ARNs with CDK references.",
    `export const boundaryReferences = ${value} as const;`,
  ].join("\n")}\n`;
}

function formatStackFile(
  stackClassName: string,
  groups: readonly ResourceGroup[],
  parameters: Readonly<Record<string, GeneratedCfnParameter>>,
  documents: GenerationDocuments,
): string {
  const augmentation = stackAugmentation(documents, "typescript");
  const imports = groups.map(
    (group) =>
      `import { ${group.className} } from './resources/${group.fileName}';`,
  );
  const parameterDeclarations = Object.keys(parameters)
    .sort()
    .flatMap((logicalId) => {
      const parameter = parameters[logicalId];
      const variableName = toCamelIdentifier(logicalId);

      if (!parameter) {
        return [];
      }

      return [
        `    const ${variableName} = new cdk.CfnParameter(this, '${escapeSingleQuoted(logicalId)}', {`,
        `      type: '${parameter.Type}',`,
        `      description: '${escapeSingleQuoted(parameter.Description)}',`,
        ...(parameter.Default !== undefined
          ? [`      default: ${JSON.stringify(parameter.Default)},`]
          : []),
        "    });",
        `    ${variableName}.overrideLogicalId('${escapeSingleQuoted(logicalId)}');`,
      ];
    });
  const constructs = groups.flatMap((group) => {
    if (group.parameterLogicalIds.length === 0) {
      return [`    new ${group.className}(this, '${group.className}');`];
    }

    return [
      `    new ${group.className}(this, '${group.className}', {`,
      ...group.parameterLogicalIds.map((logicalId) => {
        const variableName = toCamelIdentifier(logicalId);
        return `      ${variableName}: ${variableName}.valueAsString,`;
      }),
      "    });",
    ];
  });

  return `${[
    "import * as cdk from 'aws-cdk-lib';",
    "import { Construct } from 'constructs';",
    ...imports,
    ...augmentation.imports,
    "",
    `export interface ${stackClassName}Props extends cdk.StackProps {}`,
    "",
    `export class ${stackClassName} extends cdk.Stack {`,
    `  public constructor(scope: Construct, id: string, props: ${stackClassName}Props = {}) {`,
    "    super(scope, id, props);",
    "",
    "    this.templateOptions.description =",
    "      'Generated by cdk-excavator. Review gaps and import mapping before cdk import.';",
    "",
    ...parameterDeclarations,
    ...(parameterDeclarations.length > 0 ? [""] : []),
    ...constructs,
    ...augmentation.statements,
    "  }",
    "}",
  ].join("\n")}\n`;
}

function formatBinFile(
  stackClassName: string,
  stackFileBase: string,
  stackName: string,
  documents: GenerationDocuments,
): string {
  return `${[
    "#!/usr/bin/env node",
    "import * as cdk from 'aws-cdk-lib';",
    `import { ${stackClassName} } from '../lib/${stackFileBase}';`,
    "",
    "const app = new cdk.App();",
    `new ${stackClassName}(app, '${escapeSingleQuoted(stackName)}', {`,
    "  synthesizer: new cdk.BootstraplessSynthesizer(),",
    `  ${environmentSource(documents.stack, "typescript")}`,
    "});",
  ].join("\n")}\n`;
}

function formatReadme(stackName: string): string {
  return `${[
    `# ${stackName}`,
    "",
    "This CDK project was generated by cdk-excavator as a review-first draft.",
    "",
    "## Validate",
    "",
    "```bash",
    "npm ci",
    "npm run build",
    "npx cdk synth",
    "npx cdk diff",
    "```",
    "",
    "Read `IMPORT.md` and `cdk-import-review.json` before editing `cdk-import-map.json` or running `cdk import`.",
    "If `converter-fallbacks.json` exists, review every entry and matching `TODO(CONVERTER-FALLBACK)` source comment.",
    "Do not deploy this project until every TODO, replacement risk, and stateful resource has been reviewed.",
  ].join("\n")}\n`;
}

function formatJson(value: unknown): string {
  return `${JSON.stringify(value, null, 2)}\n`;
}

function indentJson(value: unknown, spaces: number): string {
  const padding = " ".repeat(spaces);
  return JSON.stringify(value, null, 2).replaceAll("\n", `\n${padding}`);
}

function singleLine(value: string): string {
  return value.replace(/\s+/g, " ").trim();
}

function escapeSingleQuoted(value: string): string {
  return value.replaceAll("\\", "\\\\").replaceAll("'", "\\'");
}
