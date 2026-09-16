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
  GeneratedCfnParameter,
  GeneratedCfnResource,
  ImportBoundaryReference,
} from "./schemas.js";
import type { GeneratedProjectFile } from "./typescript-project.js";
import { TYPESCRIPT_PACKAGE_LOCK_TEMPLATE } from "./typescript-package-lock.js";

const GENERATED_PROJECT_VERSION = "0.0.0";
const GENERATED_DEPENDENCIES = {
  "aws-cdk-lib": "2.263.0",
  constructs: "10.6.0",
} as const;
const GENERATED_DEV_DEPENDENCIES = {
  "aws-cdk": "2.1131.0",
} as const;
const GENERIC_CFN_FALLBACK_TYPES = new Set(["AWS::CloudFront::Distribution"]);

export interface PythonCdkProject {
  readonly converterFallbacks: readonly ConverterFallbackDiagnostic[];
  readonly files: readonly GeneratedProjectFile[];
  readonly packageName: string;
  readonly stackClassName: string;
  readonly stackFile: string;
}

export interface CreatePythonCdkProjectInput {
  readonly adapter?: CfnToCdkAdapter;
  readonly documents: GenerationDocuments;
  readonly gaps: GapDocument;
  readonly liftL2?: boolean;
}

interface ResourceGroup {
  readonly className: string;
  readonly moduleName: string;
  readonly parameterLogicalIds: readonly string[];
  readonly resources: Readonly<Record<string, GeneratedCfnResource>>;
}

interface PackageLock {
  name: string;
  packages: Record<
    string,
    {
      dependencies?: Record<string, string>;
      devDependencies?: Record<string, string>;
      license?: string;
      name?: string;
      version?: string;
    }
  >;
  version: string;
}

export function createPythonCdkProject(
  input: CreatePythonCdkProjectInput,
): PythonCdkProject {
  for (const resource of Object.values(input.documents.template.Resources))
    assertCdkJsonRepresentable(resource.Properties);
  if ((input.documents.stacks?.length ?? 0) > 1)
    return combineStackProjects(input.documents, "python", (documents) =>
      createPythonCdkProject({ ...input, documents }),
    );
  const adapter = input.adapter ?? cdkFromCfnAdapter;
  const stackName = input.documents.importMap.stackName;
  const stackClassName = stackClassIdentifier(stackName);
  const stackModuleName = toPythonModuleName(stackName) || "excavated_stack";
  const stackFile = `cdkx_generated/${stackModuleName}.py`;
  const packageName = `${toKebabIdentifier(stackName) || "excavated-stack"}-cdk-python`;
  const parameters = input.documents.template.Parameters ?? {};
  const groups = createResourceGroups(
    input.documents.template.Resources,
    parameters,
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
    const groupL2Evaluations = input.liftL2
      ? evaluateGroupL2Lifts(group.resources, gapsByLogicalId, genericResources)
      : [];
    l2Evaluations.push(...groupL2Evaluations);
    const liftedLogicalIds = new Set(
      groupL2Evaluations
        .filter((evaluation) => evaluation.status === "lifted")
        .map((evaluation) => evaluation.logicalId),
    );
    const typedResources = Object.fromEntries(
      Object.entries(group.resources).filter(
        ([logicalId, resource]) =>
          !requiresGenericCfnResource(
            resource,
            gapsByLogicalId[logicalId] ?? [],
          ) && !liftedLogicalIds.has(logicalId),
      ),
    );
    const conversion = transmuteWithGenericFallback(
      adapter,
      {
        boundaryReferencesByLogicalId,
        classType: "construct",
        gapsByLogicalId,
        language: "python",
        stackClassName: group.className,
        template: {
          AWSTemplateFormatVersion:
            input.documents.template.AWSTemplateFormatVersion,
          ...(group.parameterLogicalIds.length > 0
            ? {
                Parameters: Object.fromEntries(
                  group.parameterLogicalIds.map((logicalId) => [
                    logicalId,
                    parameters[logicalId],
                  ]),
                ),
              }
            : {}),
          Resources: typedResources,
        },
      },
      typedResources,
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
      path: `cdkx_generated/resources/${group.moduleName}.py`,
    });
  }

  files.push(
    { contents: "", path: "cdkx_generated/__init__.py" },
    { contents: "", path: "cdkx_generated/resources/__init__.py" },
    {
      contents: formatApp(
        stackClassName,
        stackModuleName,
        stackName,
        input.documents,
      ),
      path: "app.py",
    },
    {
      contents: formatBoundaryReferences(
        input.documents.importMap.externalReferences,
      ),
      path: "cdkx_generated/boundary_references.py",
    },
    {
      contents: formatStackFile(
        stackClassName,
        groups,
        parameters,
        input.documents,
      ),
      path: stackFile,
    },
    { contents: formatPackageJson(packageName), path: "package.json" },
    { contents: formatPackageLock(packageName), path: "package-lock.json" },
    { contents: formatCdkJson(), path: "cdk.json" },
    { contents: formatRequirements(), path: "requirements.txt" },
    { contents: formatGitignore(), path: ".gitignore" },
    { contents: formatReadme(stackName), path: "README.md" },
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

      const variableName = `generic_resource_${index + 1}`;
      const todos = (gapsByLogicalId[logicalId] ?? []).map(
        (gap) => `    # TODO(${gap.code}): ${singleLine(gap.message)}`,
      );
      const boundaryNotes = (
        boundaryReferencesByLogicalId[logicalId] ?? []
      ).map(
        (reference) =>
          `    # Boundary(${reference.boundaryHandling}): ${reference.type}=${singleLine(reference.value)}`,
      );
      const converterNotes = converterFallbacks
        .filter((fallback) => fallback.logicalIds.includes(logicalId))
        .map(
          (fallback) =>
            `    # TODO(CONVERTER-FALLBACK): ${fallback.reason}; group=${fallback.group} rejected=${fallback.rejectedLogicalId}.${fallback.property} type=${fallback.resourceType}`,
        );
      const metadataEntries = Object.entries(resource.Metadata).sort(
        ([a], [b]) => a.localeCompare(b),
      );

      return [
        ...(hasCfnReferences(resource)
          ? [`    # ${coreMessages.t("core.generate.references")}`]
          : []),
        ...boundaryNotes,
        ...todos,
        ...converterNotes,
        `    ${variableName} = cdk.CfnResource(`,
        "      self,",
        `      ${pythonString(logicalId)},`,
        `      type=${pythonString(resource.Type)},`,
        `      properties=${pythonLiteral(resource.Properties)},`,
        "    )",
        ...metadataEntries.map(
          ([key, value]) =>
            `    ${variableName}.add_metadata(${pythonString(key)}, ${pythonLiteral(value)})`,
        ),
        `    ${variableName}.override_logical_id(${pythonString(logicalId)})`,
        `    ${variableName}.apply_removal_policy(cdk.RemovalPolicy.RETAIN)`,
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
        (gap) => `    # TODO(${gap.code}): ${singleLine(gap.message)}`,
      );
      const boundaryNotes = (
        boundaryReferencesByLogicalId[evaluation.logicalId] ?? []
      ).map(
        (reference) =>
          `    # Boundary(${reference.boundaryHandling}): ${reference.type}=${singleLine(reference.value)}`,
      );

      return [
        ...boundaryNotes,
        ...todos,
        "    # L2 lift accepted: synthesized resource is identical to the L1 template.",
        ...evaluation.candidate.renderPython(`lifted_resource_${index + 1}`),
      ].join("\n");
    });
  const snippets = [...genericSnippets, ...liftedSnippets];

  if (snippets.length === 0) {
    return source;
  }

  let decoratedSource = source;
  const imports = l2Evaluations
    .flatMap((evaluation) =>
      evaluation.candidate ? [evaluation.candidate] : [],
    )
    .sort((left, right) =>
      left.pythonImportPath.localeCompare(right.pythonImportPath),
    );

  for (const candidate of imports) {
    const importLine = `import ${candidate.pythonImportPath} as ${candidate.importAlias}`;
    if (decoratedSource.includes(importLine)) {
      continue;
    }

    const cdkImport = "import aws_cdk as cdk\n";
    if (!decoratedSource.includes(cdkImport)) {
      throw new Error("Unable to locate aws_cdk import for L2 lift");
    }
    decoratedSource = decoratedSource.replace(
      cdkImport,
      `${cdkImport}${importLine}\n`,
    );
  }

  const marker = "    # Resources\n";
  if (!decoratedSource.includes(marker)) {
    throw new Error("Unable to locate cdk-from-cfn resource insertion point");
  }

  return decoratedSource.replace(marker, `${marker}${snippets.join("\n\n")}\n`);
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
      moduleName: toPythonModuleName(className),
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
  const referenced = new Set<string>();
  collectRefs(resources, new Set(Object.keys(parameters)), referenced);
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
  if (typeof record.Ref === "string" && known.has(record.Ref)) {
    referenced.add(record.Ref);
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

function formatStackFile(
  stackClassName: string,
  groups: readonly ResourceGroup[],
  parameters: Readonly<Record<string, GeneratedCfnParameter>>,
  documents: GenerationDocuments,
): string {
  const augmentation = stackAugmentation(documents, "python");
  const imports = groups.map(
    (group) => `from .resources.${group.moduleName} import ${group.className}`,
  );
  const parameterDeclarations = Object.keys(parameters)
    .sort()
    .flatMap((logicalId) => {
      const parameter = parameters[logicalId];
      if (!parameter) {
        return [];
      }
      const variableName = toPythonVariableName(logicalId);
      return [
        `        ${variableName} = cdk.CfnParameter(`,
        "            self,",
        `            ${pythonString(logicalId)},`,
        `            type=${pythonString(parameter.Type)},`,
        `            description=${pythonString(parameter.Description)},`,
        ...(parameter.Default !== undefined
          ? [`            default=${pythonString(parameter.Default)},`]
          : []),
        "        )",
        `        ${variableName}.override_logical_id(${pythonString(logicalId)})`,
      ];
    });
  const constructs = groups.flatMap((group) => {
    if (group.parameterLogicalIds.length === 0) {
      return [
        `        ${group.className}(self, ${pythonString(group.className)})`,
      ];
    }
    return [
      `        ${group.className}(`,
      "            self,",
      `            ${pythonString(group.className)},`,
      ...group.parameterLogicalIds.map((logicalId) => {
        const parameterVariable = toPythonVariableName(logicalId);
        return `            ${toCamelIdentifier(logicalId)}=${parameterVariable}.value_as_string,`;
      }),
      "        )",
    ];
  });

  return `${[
    "from typing import Any",
    "",
    "import aws_cdk as cdk",
    "from constructs import Construct",
    ...imports,
    ...augmentation.imports,
    "",
    `class ${stackClassName}(cdk.Stack):`,
    "    def __init__(self, scope: Construct, construct_id: str, **kwargs: Any) -> None:",
    "        super().__init__(scope, construct_id, **kwargs)",
    "",
    "        self.template_options.description = (",
    '            "Generated by cdk-excavator. Review gaps and import mapping before cdk import."',
    "        )",
    "",
    ...parameterDeclarations,
    ...(parameterDeclarations.length > 0 ? [""] : []),
    ...constructs,
    ...augmentation.statements,
  ].join("\n")}\n`;
}

function formatApp(
  stackClassName: string,
  stackModuleName: string,
  stackName: string,
  documents: GenerationDocuments,
): string {
  return `${[
    "import aws_cdk as cdk",
    `from cdkx_generated.${stackModuleName} import ${stackClassName}`,
    "",
    "app = cdk.App(analytics_reporting=False)",
    `${stackClassName}(`,
    "    app,",
    `    ${pythonString(stackName)},`,
    "    synthesizer=cdk.BootstraplessSynthesizer(),",
    `    ${environmentSource(documents.stack, "python")}`,
    ")",
    "app.synth()",
  ].join("\n")}\n`;
}

function formatBoundaryReferences(
  references: readonly ImportBoundaryReference[],
): string {
  return `${[
    "# Generated boundary decisions. Review before replacing physical IDs/ARNs with CDK references.",
    `BOUNDARY_REFERENCES = ${pythonLiteral(references)}`,
  ].join("\n")}\n`;
}

function formatPackageJson(packageName: string): string {
  return formatJson({
    name: packageName,
    version: GENERATED_PROJECT_VERSION,
    private: true,
    license: "UNLICENSED",
    scripts: { synth: "cdk synth" },
    dependencies: GENERATED_DEPENDENCIES,
    devDependencies: GENERATED_DEV_DEPENDENCIES,
  });
}

function formatPackageLock(packageName: string): string {
  const lock = JSON.parse(TYPESCRIPT_PACKAGE_LOCK_TEMPLATE) as PackageLock;
  const root = lock.packages[""];
  if (!root) {
    throw new Error("Generated Python package lock is missing its root");
  }

  lock.name = packageName;
  lock.version = GENERATED_PROJECT_VERSION;
  root.name = packageName;
  root.version = GENERATED_PROJECT_VERSION;
  root.license = "UNLICENSED";
  root.dependencies = { ...GENERATED_DEPENDENCIES };
  root.devDependencies = { ...GENERATED_DEV_DEPENDENCIES };
  return formatJson(lock);
}

function formatCdkJson(): string {
  return formatJson({
    app: "python app.py",
    assetMetadata: false,
    pathMetadata: false,
    versionReporting: false,
  });
}

function formatRequirements(): string {
  return [
    "# Python 3.10 or newer is required by this pinned AWS CDK release.",
    "aws-cdk-lib==2.263.0",
    "constructs==10.6.0",
    "",
  ].join("\n");
}

function formatGitignore(): string {
  return [
    ".venv/",
    "__pycache__/",
    "*.pyc",
    "cdk.out/",
    "node_modules/",
    "",
  ].join("\n");
}

function formatReadme(stackName: string): string {
  return `${[
    `# ${stackName}`,
    "",
    "This Python CDK project was generated by cdk-excavator as a review-first draft.",
    "",
    "Python 3.10 or newer is required.",
    "",
    "## Validate",
    "",
    "```bash",
    "python -m venv .venv",
    ".venv\\Scripts\\python -m pip install -r requirements.txt",
    "npm ci",
    ".venv\\Scripts\\python -m compileall -q app.py cdkx_generated",
    "npx cdk synth",
    "npx cdk diff",
    "```",
    "",
    "Read `IMPORT.md` and `cdk-import-review.json` before editing `cdk-import-map.json` or running `cdk import`.",
    "If `converter-fallbacks.json` exists, review every entry and matching `TODO(CONVERTER-FALLBACK)` source comment.",
    "Do not deploy this project until every TODO, replacement risk, and stateful resource has been reviewed.",
  ].join("\n")}\n`;
}

function toPythonModuleName(value: string): string {
  return toKebabIdentifier(value).replaceAll("-", "_");
}

function toPythonVariableName(value: string): string {
  return toPythonModuleName(toCamelIdentifier(value));
}

function pythonLiteral(value: unknown): string {
  if (value === null) {
    return "None";
  }
  if (typeof value === "string") {
    return pythonString(value);
  }
  if (typeof value === "number") {
    return String(value);
  }
  if (typeof value === "boolean") {
    return value ? "True" : "False";
  }
  if (Array.isArray(value)) {
    return `[${value.map((item) => pythonLiteral(item)).join(", ")}]`;
  }
  if (value && typeof value === "object") {
    return `{${Object.entries(value as Readonly<Record<string, unknown>>)
      .sort(([a], [b]) => a.localeCompare(b))
      .map(([key, item]) => `${pythonString(key)}: ${pythonLiteral(item)}`)
      .join(", ")}}`;
  }
  throw new Error(`Unsupported Python literal: ${String(value)}`);
}

function pythonString(value: string): string {
  return JSON.stringify(value);
}

function formatJson(value: unknown): string {
  return `${JSON.stringify(value, null, 2)}\n`;
}

function singleLine(value: string): string {
  return value.replace(/\s+/g, " ").trim();
}
