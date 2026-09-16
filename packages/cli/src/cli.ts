import { constants } from "node:fs";
import { access, readdir, readFile, stat } from "node:fs/promises";
import { join } from "node:path";

import { confirm, input, select } from "@inquirer/prompts";
import { prepareQuery, queryRows, querySummary } from "./query.js";
import { isSupportedCliNodeVersion } from "./runtime.js";
import {
  applyBoundaryHandlingDecisions,
  canIncludeBoundaryReference,
  createAwsReadOnlyScanEngine,
  createAwsResourceSchemaProvider,
  createAllScopeDocument,
  createGenerationDocuments,
  createStackPlan,
  createPythonCdkProject,
  createTypeScriptCdkProject,
  createInventoryDocument,
  createNormalizationDocuments,
  createReportArtifacts,
  createSeedScopeDocument,
  createTagScopeDocument,
  createVpcScopeDocument,
  CfnResourceSchemaSchema,
  CdkImportMapDocumentSchema,
  GapDocumentSchema,
  GapRuleSetSchema,
  GapSuppressionSetSchema,
  InventoryDocumentSchema,
  inventoryResourceKey,
  isGlobalResourceType,
  loadBundledCfnSchemas,
  loadBundledGapRules,
  mergeLocalGapRules,
  NormalizationModelDocumentSchema,
  ScopeDocumentSchema,
  TOOL_SCHEMA_VERSION,
  writeGapDocumentFile,
  writeCdkImportMapFile,
  writeCdkImportReviewFile,
  writeGeneratedCfnTemplateFile,
  writeGeneratedProjectFiles,
  writeImportGuideFile,
  writeInventoryFile,
  writeNormalizationModelFile,
  writeReportArtifacts,
  writeResourceSchemas,
  writeScopeDocumentFile,
  type CfnResourceSchema,
  type CdkImportMapDocument,
  type CdkOutputLanguage,
  type BoundaryHandling,
  type BoundaryHandlingDecision,
  type ExternalReference,
  type GapDocument,
  type GenerationPlan,
  type GapRuleSet,
  type GapSuppressionSet,
  type InventoryDocument,
  type InventoryResource,
  type NormalizationModelDocument,
  type ReportLanguage,
  type ResourceSchemaProvider,
  type ScanEngine,
  type ScopeDocument,
  type ScopeTagFilter,
  type ScopeTagOperator,
} from "@cdk-excavator/core";
import {
  createTranslator,
  type MessageValues,
  type SupportedLanguage,
} from "@cdk-excavator/i18n";

export const CLI_VERSION = "0.1.0";
export const DEFAULT_SCAN_CONCURRENCY = 4;
export const DEFAULT_SCAN_OUTPUT = "inventory.json";
export const DEFAULT_SCOPE_OUTPUT = "scope.json";
export const DEFAULT_MODEL_OUTPUT = "model.json";
export const DEFAULT_GAPS_OUTPUT = "gaps.json";
export const DEFAULT_GENERATE_OUTPUT_DIR = "cdkx.out";
export const DEFAULT_STACK_NAME = "ExcavatedStack";
export const DEFAULT_SCHEMA_OUTPUT_DIR = "schemas";

type OutputFormat = "json" | "table" | "text";

const DEFAULT_OUTPUT_FORMAT: OutputFormat = "text";
const SCAN_POLICY_ACTIONS = [
  "cloudformation:GetResource",
  "cloudformation:ListResources",
  "cloudformation:DescribeStackResources",
  "cloudformation:DescribeStacks",
  "ec2:DescribeInternetGateways",
  "ec2:DescribeNatGateways",
  "ec2:DescribeRegions",
  "ec2:DescribeRouteTables",
  "ec2:DescribeSecurityGroups",
  "ec2:DescribeSubnets",
  "ec2:DescribeVpcEndpoints",
  "ec2:DescribeVpcs",
] as const;
const SCHEMA_POLICY_ACTIONS = ["cloudformation:DescribeType"] as const;
const READ_ONLY_POLICY_ACTIONS = [
  ...SCAN_POLICY_ACTIONS,
  ...SCHEMA_POLICY_ACTIONS,
] as const;

export interface CliResult {
  exitCode: number;
  stdout: string;
  stderr: string;
}

export interface RunCdkxDependencies {
  readonly writeStderr?: (message: string) => void;
  readonly isTTY?: boolean;
  readonly createScanEngine?: () => ScanEngine;
  readonly createSchemaProvider?: (
    options: SchemaOptions,
  ) => ResourceSchemaProvider;
  readonly interactivePrompts?: InteractivePrompts;
}

export interface InteractivePrompts {
  readonly confirmExternalReferences: (
    references: readonly ExternalReference[],
  ) => Promise<boolean>;
  readonly inputDepth: () => Promise<number>;
  readonly inputResourceId: () => Promise<string>;
  readonly inputTagFilters: () => Promise<readonly ScopeTagFilter[]>;
  readonly inputVpcId: () => Promise<string>;
  readonly selectMode: () => Promise<ScopeMode>;
  readonly selectBoundaryHandling: (
    reference: ExternalReference,
    canInclude: boolean,
  ) => Promise<BoundaryHandling>;
  readonly selectTagOperator: () => Promise<ScopeTagOperator>;
}

export async function runCdkx(
  argv: string[],
  dependencies: RunCdkxDependencies = {},
): Promise<CliResult> {
  if (!argv.some((arg) => arg === "--query" || arg.startsWith("--query="))) {
    return dispatchCdkx(argv, dependencies);
  }
  const parsed = parseArguments(argv);
  const translator = createTranslator(parsed.language);
  try {
    const query = prepareQuery(argv);
    if (
      ![
        "scan",
        "scope",
        "normalize",
        "doctor",
        "preflight",
        "iam-policy",
        "plan",
        "preview",
        "generate",
        "report",
        "schemas",
      ].includes(parsed.command ?? "")
    )
      throw new Error("unsupported-command");
    const result = await dispatchCdkx(query.args, dependencies);
    if (parsed.help || result.exitCode >= 2 || !result.stdout) return result;
    const value = querySummary(result.stdout, query.expression);
    const rows = queryRows(value);
    return {
      ...result,
      stdout:
        query.format === "json"
          ? formatJson(value)
          : query.format === "table"
            ? renderTable(
                rows.some((row) => row.length > 1)
                  ? ["key", "value"]
                  : ["value"],
                rows,
              )
            : rows.map((row) => row.join("\t")).join("\n"),
    };
  } catch {
    return { exitCode: 2, stdout: "", stderr: translator.t("cli.error.query") };
  }
}

async function dispatchCdkx(
  argv: string[],
  dependencies: RunCdkxDependencies,
): Promise<CliResult> {
  const parsed = parseArguments(argv);
  const translator = createTranslator(parsed.language);

  if (parsed.command === "scan") {
    return runScanCommand(parsed, dependencies);
  }

  if (parsed.command === "scope") {
    return runScopeCommand(parsed);
  }

  if (parsed.command === "normalize") {
    return runNormalizeCommand(parsed);
  }

  if (parsed.command === "doctor" || parsed.command === "preflight") {
    return runDoctorCommand(parsed);
  }

  if (parsed.command === "iam-policy") {
    return runIamPolicyCommand(parsed);
  }

  if (parsed.command === "plan" || parsed.command === "preview") {
    return runPlanCommand(parsed);
  }

  if (parsed.command === "generate") {
    return runGenerateCommand(parsed);
  }

  if (parsed.command === "report") {
    return runReportCommand(parsed);
  }

  if (parsed.command === "schemas") {
    return runSchemasCommand(parsed, dependencies);
  }

  if (parsed.command === "interactive") {
    return runInteractiveCommand(parsed, dependencies);
  }

  if (parsed.help || parsed.command === "help" || argv.length === 0) {
    return ok(renderHelp(parsed.language));
  }

  if (parsed.version || parsed.command === "version") {
    return ok(translator.t("cli.version", { version: CLI_VERSION }));
  }

  const unknown = parsed.unknown[0] ?? parsed.command ?? "";
  return {
    exitCode: 2,
    stdout: "",
    stderr: [
      translator.t("cli.error.unknown", { argument: unknown }),
      translator.t("cli.error.hint"),
    ].join("\n"),
  };
}

export function renderHelp(language?: SupportedLanguage): string {
  const translator = createTranslator(language);

  return [
    translator.t("cli.title"),
    "",
    translator.t("cli.description"),
    "",
    translator.t("cli.usage.title"),
    translator.t("cli.usage.help"),
    translator.t("cli.usage.version"),
    translator.t("cli.usage.scan"),
    translator.t("cli.usage.scope"),
    translator.t("cli.usage.normalize"),
    translator.t("cli.usage.plan"),
    translator.t("cli.usage.generate"),
    translator.t("cli.usage.report"),
    translator.t("cli.usage.schemas"),
    translator.t("cli.usage.doctor"),
    translator.t("cli.usage.iamPolicy"),
    translator.t("cli.usage.interactive"),
    "",
    translator.t("cli.commands.title"),
    translator.t("cli.commands.help"),
    translator.t("cli.commands.version"),
    translator.t("cli.commands.scan"),
    translator.t("cli.commands.scope"),
    translator.t("cli.commands.normalize"),
    translator.t("cli.commands.plan"),
    translator.t("cli.commands.generate"),
    translator.t("cli.commands.report"),
    translator.t("cli.commands.schemas"),
    translator.t("cli.commands.doctor"),
    translator.t("cli.commands.iamPolicy"),
    translator.t("cli.commands.interactive"),
    "",
    translator.t("cli.options.title"),
    translator.t("cli.options.lang"),
    translator.t("cli.options.query"),
    "",
    `schemaVersion: ${TOOL_SCHEMA_VERSION}`,
  ].join("\n");
}

export function renderScanHelp(language?: SupportedLanguage): string {
  const translator = createTranslator(language);

  return [
    translator.t("cli.scan.title"),
    "",
    translator.t("cli.scan.description"),
    "",
    translator.t("cli.usage.title"),
    translator.t("cli.usage.scan"),
    "",
    translator.t("cli.options.title"),
    translator.t("cli.scan.options.region"),
    translator.t("cli.scan.options.allRegions"),
    translator.t("cli.scan.options.globalServices"),
    translator.t("cli.scan.options.profile"),
    translator.t("cli.scan.options.output"),
    translator.t("cli.scan.options.fixture"),
    translator.t("cli.scan.options.concurrency"),
    translator.t("cli.scan.options.verbose"),
    translator.t("cli.scan.options.includeManaged"),
    translator.t("cli.options.resourceType"),
    translator.t("cli.options.excludeResourceType"),
    translator.t("cli.options.format"),
    translator.t("cli.options.lang"),
  ].join("\n");
}

export function renderScopeHelp(language?: SupportedLanguage): string {
  const translator = createTranslator(language);

  return [
    translator.t("cli.scope.title"),
    "",
    translator.t("cli.scope.description"),
    "",
    translator.t("cli.usage.title"),
    translator.t("cli.usage.scope"),
    "",
    translator.t("cli.options.title"),
    translator.t("cli.scope.options.inventory"),
    translator.t("cli.scope.options.mode"),
    translator.t("cli.scope.options.region"),
    translator.t("cli.scope.options.tag"),
    translator.t("cli.scope.options.tagOperator"),
    translator.t("cli.scope.options.vpcId"),
    translator.t("cli.scope.options.resourceId"),
    translator.t("cli.scope.options.depth"),
    translator.t("cli.scope.options.seedTraversal"),
    translator.t("cli.scope.options.output"),
    translator.t("cli.scope.options.withDeps"),
    translator.t("cli.options.resourceType"),
    translator.t("cli.options.excludeResourceType"),
    translator.t("cli.options.format"),
    translator.t("cli.options.lang"),
  ].join("\n");
}

export function renderNormalizeHelp(language?: SupportedLanguage): string {
  const translator = createTranslator(language);

  return [
    translator.t("cli.normalize.title"),
    "",
    translator.t("cli.normalize.description"),
    "",
    translator.t("cli.usage.title"),
    translator.t("cli.usage.normalize"),
    "",
    translator.t("cli.options.title"),
    translator.t("cli.normalize.options.inventory"),
    translator.t("cli.normalize.options.scope"),
    translator.t("cli.normalize.options.schemas"),
    translator.t("cli.normalize.options.gapRules"),
    translator.t("cli.normalize.options.gapRulesLocal"),
    translator.t("cli.normalize.options.suppressions"),
    translator.t("cli.normalize.options.modelOutput"),
    translator.t("cli.normalize.options.gapsOutput"),
    translator.t("cli.options.format"),
    translator.t("cli.options.lang"),
  ].join("\n");
}

export function renderPlanHelp(language?: SupportedLanguage): string {
  const translator = createTranslator(language);

  return [
    translator.t("cli.plan.title"),
    "",
    translator.t("cli.plan.description"),
    "",
    translator.t("cli.usage.title"),
    translator.t("cli.usage.plan"),
    "",
    translator.t("cli.options.title"),
    translator.t("cli.plan.options.model"),
    translator.t("cli.plan.options.gaps"),
    translator.t("cli.options.format"),
    translator.t("cli.options.lang"),
  ].join("\n");
}

export function renderGenerateHelp(language?: SupportedLanguage): string {
  const translator = createTranslator(language);

  return [
    translator.t("cli.generate.title"),
    "",
    translator.t("cli.generate.description"),
    "",
    translator.t("cli.usage.title"),
    translator.t("cli.usage.generate"),
    "",
    translator.t("cli.options.title"),
    translator.t("cli.generate.options.model"),
    translator.t("cli.generate.options.gaps"),
    translator.t("cli.generate.options.outdir"),
    translator.t("cli.generate.options.stackName"),
    translator.t("cli.generate.options.language"),
    translator.t("cli.generate.options.liftL2"),
    translator.t("cli.options.format"),
    translator.t("cli.options.lang"),
  ].join("\n");
}

export function renderReportHelp(language?: SupportedLanguage): string {
  const translator = createTranslator(language);

  return [
    translator.t("cli.report.title"),
    "",
    translator.t("cli.report.description"),
    "",
    translator.t("cli.usage.title"),
    translator.t("cli.usage.report"),
    "",
    translator.t("cli.options.title"),
    translator.t("cli.report.options.model"),
    translator.t("cli.report.options.gaps"),
    translator.t("cli.report.options.importReview"),
    translator.t("cli.report.options.outdir"),
    translator.t("cli.report.options.languages"),
    translator.t("cli.options.format"),
  ].join("\n");
}

export function renderSchemasHelp(language?: SupportedLanguage): string {
  const translator = createTranslator(language);

  return [
    translator.t("cli.schemas.title"),
    "",
    translator.t("cli.schemas.description"),
    "",
    translator.t("cli.usage.title"),
    translator.t("cli.usage.schemas"),
    "",
    translator.t("cli.options.title"),
    translator.t("cli.schemas.options.resourceType"),
    translator.t("cli.schemas.options.region"),
    translator.t("cli.schemas.options.profile"),
    translator.t("cli.schemas.options.outputDir"),
    translator.t("cli.options.format"),
    translator.t("cli.options.lang"),
  ].join("\n");
}

export function renderDoctorHelp(language?: SupportedLanguage): string {
  const translator = createTranslator(language);

  return [
    translator.t("cli.doctor.title"),
    "",
    translator.t("cli.doctor.description"),
    "",
    translator.t("cli.usage.title"),
    translator.t("cli.usage.doctor"),
    "",
    translator.t("cli.options.title"),
    translator.t("cli.doctor.options.profile"),
    translator.t("cli.doctor.options.region"),
    translator.t("cli.doctor.options.outputDir"),
    translator.t("cli.options.format"),
    translator.t("cli.options.lang"),
  ].join("\n");
}

export function renderIamPolicyHelp(language?: SupportedLanguage): string {
  const translator = createTranslator(language);

  return [
    translator.t("cli.iamPolicy.title"),
    "",
    translator.t("cli.iamPolicy.description"),
    "",
    translator.t("cli.usage.title"),
    translator.t("cli.usage.iamPolicy"),
    "",
    translator.t("cli.options.title"),
    translator.t("cli.iamPolicy.options.stage"),
    translator.t("cli.options.format"),
    translator.t("cli.options.lang"),
  ].join("\n");
}

export function renderInteractiveHelp(language?: SupportedLanguage): string {
  const translator = createTranslator(language);

  return [
    translator.t("cli.interactive.title"),
    "",
    translator.t("cli.interactive.description"),
    "",
    translator.t("cli.usage.title"),
    translator.t("cli.usage.interactive"),
    "",
    translator.t("cli.options.title"),
    translator.t("cli.scope.options.inventory"),
    translator.t("cli.scope.options.output"),
    translator.t("cli.options.lang"),
  ].join("\n");
}

async function runScanCommand(
  parsed: ParsedArguments,
  dependencies: RunCdkxDependencies,
): Promise<CliResult> {
  const translator = createTranslator(parsed.language);

  if (parsed.help) {
    return ok(renderScanHelp(parsed.language));
  }

  const scan = parseScanArguments(parsed.commandArgs);

  if ("error" in scan) {
    return {
      exitCode: 2,
      stdout: "",
      stderr: [
        translator.t(scan.error.key, scan.error.values),
        translator.t("cli.error.hint"),
      ].join("\n"),
    };
  }

  if (scan.fixture) {
    return runFixtureScanCommand(scan, scan.fixture, translator);
  }

  return runAwsScanCommand(scan, translator, dependencies);
}

async function runScopeCommand(parsed: ParsedArguments): Promise<CliResult> {
  const translator = createTranslator(parsed.language);

  if (parsed.help) {
    return ok(renderScopeHelp(parsed.language));
  }

  const scope = parseScopeArguments(parsed.commandArgs);

  if ("error" in scope) {
    return {
      exitCode: 2,
      stdout: "",
      stderr: [
        translator.t(scope.error.key, scope.error.values),
        translator.t("cli.error.hint"),
      ].join("\n"),
    };
  }

  try {
    const inventory = await readInventoryDocument(scope.inventory);
    const document = createScopeDocumentForMode(
      scope,
      filterInventoryDocument(inventory, scope),
    );

    await writeScopeDocumentFile({
      document,
      outputPath: scope.output,
    });

    return ok(
      formatScopeSummary(
        {
          command: "scope",
          edgeCount: document.graph.edges.length,
          inventory: scope.inventory,
          mode: scope.mode,
          output: scope.output,
          resourceCount: document.resources.length,
        },
        scope.format,
        translator,
      ),
    );
  } catch (error) {
    return {
      exitCode: 2,
      stdout: "",
      stderr: [
        translator.t("cli.error.scope", {
          inventory: scope.inventory,
          message: errorMessage(error),
          output: scope.output,
        }),
        translator.t("cli.error.hint"),
      ].join("\n"),
    };
  }
}

async function runNormalizeCommand(
  parsed: ParsedArguments,
): Promise<CliResult> {
  const translator = createTranslator(parsed.language);

  if (parsed.help) {
    return ok(renderNormalizeHelp(parsed.language));
  }

  const normalize = parseNormalizeArguments(parsed.commandArgs);

  if ("error" in normalize) {
    return {
      exitCode: 2,
      stdout: "",
      stderr: [
        translator.t(normalize.error.key, normalize.error.values),
        translator.t("cli.error.hint"),
      ].join("\n"),
    };
  }

  try {
    const inventory = await readInventoryDocument(normalize.inventory);
    const scope = await readScopeDocument(normalize.scope);
    const schemas = normalize.schemas
      ? await readCfnSchemas(normalize.schemas)
      : loadBundledCfnSchemas();
    const baseGapRules = normalize.gapRules
      ? await readGapRuleSet(normalize.gapRules)
      : loadBundledGapRules();
    const gapRules = normalize.gapRulesLocal
      ? mergeLocalGapRules(
          baseGapRules,
          JSON.parse(
            await readFile(normalize.gapRulesLocal, "utf8"),
          ) as unknown,
        )
      : baseGapRules;
    const suppressions = normalize.suppressions
      ? await readGapSuppressionSet(normalize.suppressions)
      : undefined;
    const documents = createNormalizationDocuments({
      gapRules,
      inventory,
      schemas,
      scope,
      suppressions,
      toolVersion: CLI_VERSION,
    });

    await writeNormalizationModelFile({
      document: documents.model,
      outputPath: normalize.modelOutput,
    });
    await writeGapDocumentFile({
      document: documents.gaps,
      outputPath: normalize.gapsOutput,
    });

    return complete(
      formatNormalizeSummary(
        {
          command: "normalize",
          gapCount: documents.gaps.gaps.length,
          gapsOutput: normalize.gapsOutput,
          modelOutput: normalize.modelOutput,
          resourceCount: documents.model.resources.length,
          scope: normalize.scope,
        },
        normalize.format,
        translator,
      ),
      documents.gaps.gaps.length > 0,
    );
  } catch (error) {
    return {
      exitCode: 2,
      stdout: "",
      stderr: [
        translator.t("cli.error.normalize", {
          message: errorMessage(error),
          scope: normalize.scope,
        }),
        translator.t("cli.error.hint"),
      ].join("\n"),
    };
  }
}

async function runDoctorCommand(parsed: ParsedArguments): Promise<CliResult> {
  const translator = createTranslator(parsed.language);

  if (parsed.help) {
    return ok(renderDoctorHelp(parsed.language));
  }

  const doctor = parseDoctorArguments(parsed.commandArgs);

  if ("error" in doctor) {
    return parseErrorResult(doctor.error, translator);
  }

  const result = await createDoctorResult(doctor);
  const hasFailure = result.checks.some((check) => check.status === "fail");

  return {
    exitCode: hasFailure ? 2 : 0,
    stdout: formatDoctorResult(result, doctor.format, translator),
    stderr: "",
  };
}

async function runIamPolicyCommand(
  parsed: ParsedArguments,
): Promise<CliResult> {
  const translator = createTranslator(parsed.language);

  if (parsed.help) {
    return ok(renderIamPolicyHelp(parsed.language));
  }

  const options = parseIamPolicyArguments(parsed.commandArgs);

  if ("error" in options) {
    return parseErrorResult(options.error, translator);
  }

  const policy = createIamPolicyDocument(options.stage);
  return ok(formatIamPolicyDocument(policy, options.format, translator));
}

async function runPlanCommand(parsed: ParsedArguments): Promise<CliResult> {
  const translator = createTranslator(parsed.language);

  if (parsed.help) {
    return ok(renderPlanHelp(parsed.language));
  }

  const plan = parsePlanArguments(parsed.commandArgs);

  if ("error" in plan) {
    return parseErrorResult(plan.error, translator);
  }

  try {
    const model = await readNormalizationModelDocument(plan.model);
    const gaps = await readGapDocument(plan.gaps);
    const summary = createPlanSummary(model, gaps);

    return complete(
      formatPlanSummary(summary, plan.format, translator),
      summary.gapCount > 0 ||
        summary.reviewReferenceCount > 0 ||
        summary.plan.warnings.length > 0 ||
        summary.plan.stacks.some((stack) => stack.reviewReasons.length > 0),
    );
  } catch (error) {
    return {
      exitCode: 2,
      stdout: "",
      stderr: [
        translator.t("cli.error.plan", {
          message: errorMessage(error),
          model: plan.model,
        }),
        translator.t("cli.error.hint"),
      ].join("\n"),
    };
  }
}

async function runGenerateCommand(parsed: ParsedArguments): Promise<CliResult> {
  const translator = createTranslator(parsed.language);

  if (parsed.help) {
    return ok(renderGenerateHelp(parsed.language));
  }

  const generate = parseGenerateArguments(parsed.commandArgs);

  if ("error" in generate) {
    return parseErrorResult(generate.error, translator);
  }

  try {
    const model = await readNormalizationModelDocument(generate.model);
    const gaps = await readGapDocument(generate.gaps);
    const documents = createGenerationDocuments({
      gaps,
      model,
      stackName: generate.stackName,
      toolVersion: CLI_VERSION,
    });
    const project =
      generate.language === "python"
        ? createPythonCdkProject({
            documents,
            gaps,
            liftL2: generate.liftL2,
          })
        : createTypeScriptCdkProject({
            documents,
            gaps,
            liftL2: generate.liftL2,
          });
    const multipleStacks = (documents.stacks?.length ?? 0) > 1;
    const templateOutput = join(
      generate.outdir,
      multipleStacks ? "stacks" : "template.json",
    );
    const importMapOutput = join(
      generate.outdir,
      multipleStacks ? "stacks" : "cdk-import-map.json",
    );
    const importReviewOutput = join(generate.outdir, "cdk-import-review.json");
    const importGuideOutput = join(generate.outdir, "IMPORT.md");
    const converterFallbackOutput =
      project.converterFallbacks.length > 0
        ? join(generate.outdir, "converter-fallbacks.json")
        : undefined;

    await writeGeneratedProjectFiles({
      files: project.files,
      outputDirectory: generate.outdir,
    });
    if (!multipleStacks) {
      await writeGeneratedCfnTemplateFile({
        document: documents.template,
        outputPath: templateOutput,
      });
      await writeCdkImportMapFile({
        document: documents.resourceMapping,
        outputPath: importMapOutput,
      });
    }
    await writeCdkImportReviewFile({
      document: documents.importMap,
      outputPath: importReviewOutput,
    });
    await writeImportGuideFile({
      document: documents.importMap,
      outputPath: importGuideOutput,
    });

    return complete(
      formatGenerateSummary(
        {
          command: "generate",
          converterFallbackCount: project.converterFallbacks.length,
          converterFallbackOutput,
          importGuideOutput,
          importMapOutput,
          importReviewOutput,
          language: generate.language,
          outdir: generate.outdir,
          resourceCount: documents.importMap.resources.length,
          stackName: documents.importMap.stackName,
          stackFile: join(generate.outdir, project.stackFile),
          templateOutput,
        },
        generate.format,
        translator,
      ),
      gaps.gaps.length > 0 ||
        project.converterFallbacks.length > 0 ||
        (documents.importMap.plan?.references.some(
          (reference) =>
            reference.disposition === "unresolved" ||
            reference.disposition === "cycle-boundary",
        ) ??
          false),
    );
  } catch (error) {
    return {
      exitCode: 2,
      stdout: "",
      stderr: [
        translator.t("cli.error.generate", {
          message: errorMessage(error),
          model: generate.model,
        }),
        translator.t("cli.error.hint"),
      ].join("\n"),
    };
  }
}

async function runReportCommand(parsed: ParsedArguments): Promise<CliResult> {
  const translator = createTranslator(parsed.language);

  if (parsed.help) {
    return ok(renderReportHelp(parsed.language));
  }

  const report = parseReportArguments(parsed.commandArgs);

  if ("error" in report) {
    return parseErrorResult(report.error, translator);
  }

  try {
    const model = await readNormalizationModelDocument(report.model);
    const gaps = await readGapDocument(report.gaps);
    const importReview = await readCdkImportReviewDocument(report.importReview);
    const languages = selectedReportLanguages(parsed);
    const artifacts = createReportArtifacts({
      gaps,
      importReview,
      locales: languages.map((language) => {
        const reportTranslator = createTranslator(language);
        return {
          language,
          t: (key: string, values = {}) =>
            reportTranslator.t(key, { ...values }),
        };
      }),
      model,
    });

    await writeReportArtifacts({
      artifacts,
      outputDirectory: report.outdir,
    });

    return complete(
      formatReportSummary(
        {
          command: "report",
          gapCount: gaps.gaps.length,
          languages,
          outdir: report.outdir,
          resourceCount: model.resources.length,
        },
        report.format,
        translator,
      ),
      gaps.gaps.length > 0,
    );
  } catch (error) {
    return {
      exitCode: 2,
      stdout: "",
      stderr: [
        translator.t("cli.error.report", {
          message: errorMessage(error),
          model: report.model,
        }),
        translator.t("cli.error.hint"),
      ].join("\n"),
    };
  }
}

async function runSchemasCommand(
  parsed: ParsedArguments,
  dependencies: RunCdkxDependencies,
): Promise<CliResult> {
  const translator = createTranslator(parsed.language);

  if (parsed.help) {
    return ok(renderSchemasHelp(parsed.language));
  }

  const options = parseSchemaArguments(parsed.commandArgs);
  if ("error" in options) {
    return parseErrorResult(options.error, translator);
  }

  try {
    const provider =
      dependencies.createSchemaProvider?.(options) ??
      createAwsResourceSchemaProvider(options);
    const schemas: CfnResourceSchema[] = [];
    for (const resourceType of [...options.resourceTypes].sort()) {
      schemas.push(await provider.fetch(resourceType));
    }
    await writeResourceSchemas({
      outputDirectory: options.outputDirectory,
      schemas,
    });

    return ok(
      formatSchemaSummary(
        {
          command: "schemas",
          outputDirectory: options.outputDirectory,
          profile: options.profile,
          region: options.region,
          resourceTypes: options.resourceTypes,
        },
        options.format,
        translator,
      ),
    );
  } catch (error) {
    return {
      exitCode: 2,
      stdout: "",
      stderr: [
        translator.t("cli.error.schemas", {
          message: errorMessage(error),
          output: options.outputDirectory,
        }),
        translator.t("cli.error.hint"),
      ].join("\n"),
    };
  }
}

async function runInteractiveCommand(
  parsed: ParsedArguments,
  dependencies: RunCdkxDependencies,
): Promise<CliResult> {
  const translator = createTranslator(parsed.language);

  if (parsed.help) {
    return ok(renderInteractiveHelp(parsed.language));
  }

  const interactive = parseInteractiveArguments(parsed.commandArgs);

  if ("error" in interactive) {
    return {
      exitCode: 2,
      stdout: "",
      stderr: [
        translator.t(interactive.error.key, interactive.error.values),
        translator.t("cli.error.hint"),
      ].join("\n"),
    };
  }

  try {
    const prompts =
      dependencies.interactivePrompts ??
      createInquirerInteractivePrompts(parsed.language);
    const inventory = await readInventoryDocument(interactive.inventory);
    const scope = await promptForScopeOptions(interactive, prompts);
    const initialDocument = createScopeDocumentForMode(scope, inventory);
    const document = await resolveBoundaryReferences(
      initialDocument,
      inventory,
      prompts,
    );

    await writeScopeDocumentFile({
      document,
      outputPath: scope.output,
    });

    return ok(
      formatScopeSummary(
        {
          command: "scope",
          edgeCount: document.graph.edges.length,
          inventory: scope.inventory,
          mode: scope.mode,
          output: scope.output,
          resourceCount: document.resources.length,
        },
        scope.format,
        translator,
      ),
    );
  } catch (error) {
    return {
      exitCode: 2,
      stdout: "",
      stderr: [
        translator.t("cli.error.interactive", {
          inventory: interactive.inventory,
          message: errorMessage(error),
          output: interactive.output,
        }),
        translator.t("cli.error.hint"),
      ].join("\n"),
    };
  }
}

async function resolveBoundaryReferences(
  initialDocument: ScopeDocument,
  inventory: InventoryDocument,
  prompts: InteractivePrompts,
): Promise<ScopeDocument> {
  if (initialDocument.externalReferences.length === 0) {
    return initialDocument;
  }

  const shouldContinue = await prompts.confirmExternalReferences(
    initialDocument.externalReferences,
  );

  if (!shouldContinue) {
    throw new Error("Interactive scope cancelled before writing output.");
  }

  const decisions: BoundaryHandlingDecision[] = [];
  const decidedKeys = new Set<string>();
  let document = initialDocument;

  while (true) {
    const pending = document.externalReferences.filter(
      (reference) => !decidedKeys.has(boundaryReferenceKey(reference)),
    );

    if (pending.length === 0) {
      return document;
    }

    for (const reference of pending) {
      const boundaryHandling = await prompts.selectBoundaryHandling(
        reference,
        canIncludeBoundaryReference(inventory, reference),
      );
      decisions.push({ ...reference, boundaryHandling });
      decidedKeys.add(boundaryReferenceKey(reference));
    }

    document = applyBoundaryHandlingDecisions({
      decisions,
      document,
      inventory,
    });
  }
}

function boundaryReferenceKey(
  reference: Pick<ExternalReference, "referencedBy" | "type" | "value">,
): string {
  return [reference.referencedBy, reference.type, reference.value].join(
    "\u0000",
  );
}

interface ParsedArguments {
  readonly command?: string;
  readonly commandArgs: readonly string[];
  readonly help: boolean;
  readonly language?: SupportedLanguage;
  readonly languages: readonly SupportedLanguage[];
  readonly unknown: readonly string[];
  readonly version: boolean;
}

interface ScanOptions {
  readonly verbose: boolean;
  readonly allRegions: boolean;
  readonly globalServices: "include" | "exclude" | "only";
  readonly concurrency: number;
  readonly excludeResourceTypes: readonly string[];
  readonly fixture?: string;
  readonly format: OutputFormat;
  readonly includeManaged: boolean;
  readonly output: string;
  readonly profile?: string;
  readonly resourceTypes: readonly string[];
  readonly regions: readonly string[];
}

type ScopeMode = "all" | "tag" | "vpc" | "seed";

interface InteractiveOptions {
  readonly inventory: string;
  readonly output: string;
}

interface NormalizeOptions {
  readonly format: OutputFormat;
  readonly gapRules?: string;
  readonly gapRulesLocal?: string;
  readonly gapsOutput: string;
  readonly inventory: string;
  readonly modelOutput: string;
  readonly schemas?: string;
  readonly scope: string;
  readonly suppressions?: string;
}

interface SchemaOptions {
  readonly format: OutputFormat;
  readonly outputDirectory: string;
  readonly profile?: string;
  readonly region: string;
  readonly resourceTypes: readonly string[];
}

interface DoctorOptions {
  readonly format: OutputFormat;
  readonly outputDir?: string;
  readonly profile?: string;
  readonly region?: string;
}

type IamPolicyStage =
  "all" | "generate" | "normalize" | "scan" | "schemas" | "scope";

interface IamPolicyOptions {
  readonly format: OutputFormat;
  readonly stage: IamPolicyStage;
}

interface PlanOptions {
  readonly format: OutputFormat;
  readonly gaps: string;
  readonly model: string;
}

interface GenerateOptions {
  readonly format: OutputFormat;
  readonly gaps: string;
  readonly language: CdkOutputLanguage;
  readonly liftL2: boolean;
  readonly model: string;
  readonly outdir: string;
  readonly stackName: string;
}

interface ReportOptions {
  readonly format: OutputFormat;
  readonly gaps: string;
  readonly importReview: string;
  readonly model: string;
  readonly outdir: string;
}

interface ScopeOptions {
  readonly depth?: number;
  readonly regions?: readonly string[];
  readonly excludeResourceTypes: readonly string[];
  readonly inventory: string;
  readonly mode: ScopeMode;
  readonly output: string;
  readonly format: OutputFormat;
  readonly resourceId?: string;
  readonly resourceTypes: readonly string[];
  readonly tagOperator: ScopeTagOperator;
  readonly tags: readonly ScopeTagFilter[];
  readonly vpcId?: string;
  readonly withDependencies: boolean;
}

interface ParseError {
  readonly key: string;
  readonly values?: MessageValues;
}

type DoctorCheckStatus = "fail" | "pass" | "warn";

interface DoctorCheck {
  readonly detail: string;
  readonly name: string;
  readonly status: DoctorCheckStatus;
}

interface DoctorResult {
  readonly checks: readonly DoctorCheck[];
}

interface IamPolicyDocument {
  readonly Statement: readonly {
    readonly Action: readonly string[];
    readonly Effect: "Allow";
    readonly Resource: "*";
  }[];
  readonly Version: "2012-10-17";
}

interface PlanSummary {
  readonly plan: GenerationPlan;
  readonly stackCount: number;
  readonly reviewReferenceCount: number;
  readonly blockingGaps: number;
  readonly cfnManagedResources: number;
  readonly codeableResources: number;
  readonly excludedResources: number;
  readonly gapCount: number;
  readonly gapsByCode: Readonly<Record<string, number>>;
  readonly gapsBySeverity: Readonly<Record<string, number>>;
  readonly manualResources: number;
  readonly propertyCoverageScore: number;
  readonly replacementRiskGaps: number;
  readonly resourceCoverageScore: number;
  readonly totalResources: number;
  readonly writeOnlyGaps: number;
}

interface ScanSummary {
  readonly command: "scan";
  readonly fixture?: string;
  readonly output: string;
  readonly profile?: string;
  readonly regions: readonly string[];
  readonly resourceCount: number;
  readonly source: "aws" | "fixture";
}

interface ScopeSummary {
  readonly command: "scope";
  readonly edgeCount: number;
  readonly inventory: string;
  readonly mode: ScopeMode;
  readonly output: string;
  readonly resourceCount: number;
}

interface NormalizeSummary {
  readonly command: "normalize";
  readonly gapCount: number;
  readonly gapsOutput: string;
  readonly modelOutput: string;
  readonly resourceCount: number;
  readonly scope: string;
}

interface GenerateSummary {
  readonly command: "generate";
  readonly converterFallbackCount: number;
  readonly converterFallbackOutput?: string;
  readonly importGuideOutput: string;
  readonly importMapOutput: string;
  readonly importReviewOutput: string;
  readonly language: CdkOutputLanguage;
  readonly outdir: string;
  readonly resourceCount: number;
  readonly stackName: string;
  readonly stackFile: string;
  readonly templateOutput: string;
}

interface ReportSummary {
  readonly command: "report";
  readonly gapCount: number;
  readonly languages: readonly ReportLanguage[];
  readonly outdir: string;
  readonly resourceCount: number;
}

interface SchemaSummary {
  readonly command: "schemas";
  readonly outputDirectory: string;
  readonly profile?: string;
  readonly region: string;
  readonly resourceTypes: readonly string[];
}

function parseArguments(argv: string[]) {
  const commandArgs: string[] = [];
  const languages: SupportedLanguage[] = [];
  const unknown: string[] = [];
  let language: SupportedLanguage | undefined;
  let help = false;
  let version = false;
  let command: string | undefined;

  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];

    if (!arg) {
      continue;
    }

    if (arg === "--help" || arg === "-h") {
      help = true;
      continue;
    }

    if (arg === "--version" || arg === "-v") {
      version = true;
      continue;
    }

    if (arg === "--lang") {
      const value = argv[index + 1];
      if (value === "en" || value === "ja") {
        language = value;
        languages.push(value);
        index += 1;
      } else if (value) {
        unknown.push(value);
        index += 1;
      }
      continue;
    }

    if (arg?.startsWith("--lang=")) {
      const value = arg.slice("--lang=".length);
      if (value === "en" || value === "ja") {
        language = value;
        languages.push(value);
      } else {
        unknown.push(arg);
      }
      continue;
    }

    if (command) {
      commandArgs.push(arg);
      continue;
    }

    if (!command && arg && !arg.startsWith("-")) {
      command = arg;
      continue;
    }

    if (arg) {
      unknown.push(arg);
    }
  }

  return {
    command,
    commandArgs,
    help,
    language,
    languages,
    unknown,
    version,
  } satisfies ParsedArguments;
}

function parseScanArguments(
  args: readonly string[],
): ScanOptions | { error: ParseError } {
  const excludeResourceTypes: string[] = [];
  const resourceTypes: string[] = [];
  const regions: string[] = [];
  let allRegions = false;
  let verbose = false;
  let globalServices: ScanOptions["globalServices"] = "include";
  let concurrency = DEFAULT_SCAN_CONCURRENCY;
  let fixture: string | undefined;
  let format: OutputFormat = DEFAULT_OUTPUT_FORMAT;
  let includeManaged = false;
  let output = DEFAULT_SCAN_OUTPUT;
  let profile: string | undefined;

  for (let index = 0; index < args.length; index += 1) {
    const arg = args[index];

    if (!arg) {
      continue;
    }

    if (arg === "--include-managed") {
      includeManaged = true;
      continue;
    }

    if (arg === "--all-regions") {
      allRegions = true;
      continue;
    }
    if (arg === "--verbose") {
      verbose = true;
      continue;
    }
    if (arg === "--global-services" || arg.startsWith("--global-services=")) {
      const value =
        arg === "--global-services"
          ? args[++index]
          : arg.slice("--global-services=".length);
      if (value !== "include" && value !== "exclude" && value !== "only") {
        return { error: invalidChoiceError("--global-services", value ?? "") };
      }
      globalServices = value;
      continue;
    }

    if (arg === "--region") {
      const value = args[index + 1];
      if (!value || value.startsWith("-")) {
        return { error: optionValueError("--region") };
      }

      regions.push(value);
      index += 1;
      continue;
    }

    if (arg.startsWith("--region=")) {
      const value = arg.slice("--region=".length);
      if (!value) {
        return { error: optionValueError("--region") };
      }

      regions.push(value);
      continue;
    }

    if (arg === "--profile") {
      const value = args[index + 1];
      if (!value || value.startsWith("-")) {
        return { error: optionValueError("--profile") };
      }

      profile = value;
      index += 1;
      continue;
    }

    if (arg.startsWith("--profile=")) {
      const value = arg.slice("--profile=".length);
      if (!value) {
        return { error: optionValueError("--profile") };
      }

      profile = value;
      continue;
    }

    if (arg === "--output") {
      const value = args[index + 1];
      if (!value || value.startsWith("-")) {
        return { error: optionValueError("--output") };
      }

      output = value;
      index += 1;
      continue;
    }

    if (arg.startsWith("--output=")) {
      const value = arg.slice("--output=".length);
      if (!value) {
        return { error: optionValueError("--output") };
      }

      output = value;
      continue;
    }

    if (arg === "--fixture") {
      const value = args[index + 1];
      if (!value || value.startsWith("-")) {
        return { error: optionValueError("--fixture") };
      }

      fixture = value;
      index += 1;
      continue;
    }

    if (arg.startsWith("--fixture=")) {
      const value = arg.slice("--fixture=".length);
      if (!value) {
        return { error: optionValueError("--fixture") };
      }

      fixture = value;
      continue;
    }

    if (arg === "--concurrency") {
      const value = args[index + 1];
      if (!value || value.startsWith("-")) {
        return { error: optionValueError("--concurrency") };
      }

      const parsed = parseConcurrency(value);
      if (parsed === undefined) {
        return { error: invalidNumberError("--concurrency", value) };
      }

      concurrency = parsed;
      index += 1;
      continue;
    }

    if (arg.startsWith("--concurrency=")) {
      const value = arg.slice("--concurrency=".length);
      const parsed = parseConcurrency(value);
      if (parsed === undefined) {
        return { error: invalidNumberError("--concurrency", value) };
      }

      concurrency = parsed;
      continue;
    }

    const parsedFormat = parseFormatArgument(args, index, arg);
    if (parsedFormat) {
      if ("error" in parsedFormat) {
        return parsedFormat;
      }

      format = parsedFormat.value;
      index += parsedFormat.consumed;
      continue;
    }

    if (arg === "--resource-type") {
      const parsed = parseResourceTypeOption(args, index, "--resource-type");
      if ("error" in parsed) {
        return parsed;
      }

      resourceTypes.push(parsed.value);
      index += 1;
      continue;
    }

    if (arg.startsWith("--resource-type=")) {
      const parsed = parseResourceTypeValue(
        arg.slice("--resource-type=".length),
        "--resource-type",
      );
      if ("error" in parsed) {
        return parsed;
      }

      resourceTypes.push(parsed.value);
      continue;
    }

    if (arg === "--exclude-resource-type") {
      const parsed = parseResourceTypeOption(
        args,
        index,
        "--exclude-resource-type",
      );
      if ("error" in parsed) {
        return parsed;
      }

      excludeResourceTypes.push(parsed.value);
      index += 1;
      continue;
    }

    if (arg.startsWith("--exclude-resource-type=")) {
      const parsed = parseResourceTypeValue(
        arg.slice("--exclude-resource-type=".length),
        "--exclude-resource-type",
      );
      if ("error" in parsed) {
        return parsed;
      }

      excludeResourceTypes.push(parsed.value);
      continue;
    }

    return {
      error: {
        key: "cli.error.unknown",
        values: { argument: arg },
      },
    };
  }

  if (regions.length === 0 && !(allRegions && fixture)) {
    return {
      error: {
        key: "cli.error.missingOption",
        values: { option: "--region" },
      },
    };
  }

  return {
    allRegions,
    verbose,
    globalServices,
    concurrency,
    excludeResourceTypes,
    fixture,
    format,
    includeManaged,
    output,
    profile,
    resourceTypes,
    regions,
  };
}

function parseScopeArguments(
  args: readonly string[],
): ScopeOptions | { error: ParseError } {
  const excludeResourceTypes: string[] = [];
  const regions: string[] = [];
  const resourceTypes: string[] = [];
  const tags: ScopeTagFilter[] = [];
  let inventory: string | undefined;
  let mode: string | undefined;
  let output = DEFAULT_SCOPE_OUTPUT;
  let depth: number | undefined;
  let format: OutputFormat = DEFAULT_OUTPUT_FORMAT;
  let resourceId: string | undefined;
  let tagOperator: ScopeTagOperator = "and";
  let vpcId: string | undefined;
  let withDependencies = false;

  for (let index = 0; index < args.length; index += 1) {
    const arg = args[index];

    if (!arg) {
      continue;
    }

    if (arg === "--region" || arg.startsWith("--region=")) {
      const value =
        arg === "--region" ? args[++index] : arg.slice("--region=".length);
      if (!value || value.startsWith("-"))
        return { error: optionValueError("--region") };
      regions.push(value);
      continue;
    }

    if (arg === "--with-deps") {
      withDependencies = true;
      continue;
    }

    if (arg === "--inventory") {
      const value = args[index + 1];
      if (!value || value.startsWith("-")) {
        return { error: optionValueError("--inventory") };
      }

      inventory = value;
      index += 1;
      continue;
    }

    if (arg.startsWith("--inventory=")) {
      const value = arg.slice("--inventory=".length);
      if (!value) {
        return { error: optionValueError("--inventory") };
      }

      inventory = value;
      continue;
    }

    if (arg === "--mode") {
      const value = args[index + 1];
      if (!value || value.startsWith("-")) {
        return { error: optionValueError("--mode") };
      }

      mode = value;
      index += 1;
      continue;
    }

    if (arg.startsWith("--mode=")) {
      const value = arg.slice("--mode=".length);
      if (!value) {
        return { error: optionValueError("--mode") };
      }

      mode = value;
      continue;
    }

    if (arg === "--tag") {
      const value = args[index + 1];
      if (!value || value.startsWith("-")) {
        return { error: optionValueError("--tag") };
      }

      const filter = parseTagFilter(value);
      if (!filter) {
        return {
          error: {
            key: "cli.error.invalidTag",
            values: { value },
          },
        };
      }

      tags.push(filter);
      index += 1;
      continue;
    }

    if (arg.startsWith("--tag=")) {
      const value = arg.slice("--tag=".length);
      const filter = parseTagFilter(value);
      if (!filter) {
        return {
          error: {
            key: "cli.error.invalidTag",
            values: { value },
          },
        };
      }

      tags.push(filter);
      continue;
    }

    if (arg === "--tag-operator") {
      const value = args[index + 1];
      if (!value || value.startsWith("-")) {
        return { error: optionValueError("--tag-operator") };
      }

      const operator = parseTagOperator(value);
      if (!operator) {
        return {
          error: {
            key: "cli.error.invalidTagOperator",
            values: { value },
          },
        };
      }

      tagOperator = operator;
      index += 1;
      continue;
    }

    if (arg.startsWith("--tag-operator=")) {
      const value = arg.slice("--tag-operator=".length);
      const operator = parseTagOperator(value);
      if (!operator) {
        return {
          error: {
            key: "cli.error.invalidTagOperator",
            values: { value },
          },
        };
      }

      tagOperator = operator;
      continue;
    }

    if (arg === "--vpc-id") {
      const value = args[index + 1];
      if (!value || value.startsWith("-")) {
        return { error: optionValueError("--vpc-id") };
      }

      vpcId = value;
      index += 1;
      continue;
    }

    if (arg.startsWith("--vpc-id=")) {
      const value = arg.slice("--vpc-id=".length);
      if (!value) {
        return { error: optionValueError("--vpc-id") };
      }

      vpcId = value;
      continue;
    }

    if (arg === "--resource-id") {
      const value = args[index + 1];
      if (!value || value.startsWith("-")) {
        return { error: optionValueError("--resource-id") };
      }

      resourceId = value;
      index += 1;
      continue;
    }

    if (arg.startsWith("--resource-id=")) {
      const value = arg.slice("--resource-id=".length);
      if (!value) {
        return { error: optionValueError("--resource-id") };
      }

      resourceId = value;
      continue;
    }

    if (arg === "--depth") {
      const value = args[index + 1];
      if (!value || value.startsWith("-")) {
        return { error: optionValueError("--depth") };
      }

      const parsed = parseNonNegativeInteger(value);
      if (parsed === undefined) {
        return { error: invalidNumberError("--depth", value) };
      }

      depth = parsed;
      index += 1;
      continue;
    }

    if (arg.startsWith("--depth=")) {
      const value = arg.slice("--depth=".length);
      const parsed = parseNonNegativeInteger(value);
      if (parsed === undefined) {
        return { error: invalidNumberError("--depth", value) };
      }

      depth = parsed;
      continue;
    }

    if (arg === "--output") {
      const value = args[index + 1];
      if (!value || value.startsWith("-")) {
        return { error: optionValueError("--output") };
      }

      output = value;
      index += 1;
      continue;
    }

    if (arg.startsWith("--output=")) {
      const value = arg.slice("--output=".length);
      if (!value) {
        return { error: optionValueError("--output") };
      }

      output = value;
      continue;
    }

    const parsedFormat = parseFormatArgument(args, index, arg);
    if (parsedFormat) {
      if ("error" in parsedFormat) {
        return parsedFormat;
      }

      format = parsedFormat.value;
      index += parsedFormat.consumed;
      continue;
    }

    if (arg === "--resource-type") {
      const parsed = parseResourceTypeOption(args, index, "--resource-type");
      if ("error" in parsed) {
        return parsed;
      }

      resourceTypes.push(parsed.value);
      index += 1;
      continue;
    }

    if (arg.startsWith("--resource-type=")) {
      const parsed = parseResourceTypeValue(
        arg.slice("--resource-type=".length),
        "--resource-type",
      );
      if ("error" in parsed) {
        return parsed;
      }

      resourceTypes.push(parsed.value);
      continue;
    }

    if (arg === "--exclude-resource-type") {
      const parsed = parseResourceTypeOption(
        args,
        index,
        "--exclude-resource-type",
      );
      if ("error" in parsed) {
        return parsed;
      }

      excludeResourceTypes.push(parsed.value);
      index += 1;
      continue;
    }

    if (arg.startsWith("--exclude-resource-type=")) {
      const parsed = parseResourceTypeValue(
        arg.slice("--exclude-resource-type=".length),
        "--exclude-resource-type",
      );
      if ("error" in parsed) {
        return parsed;
      }

      excludeResourceTypes.push(parsed.value);
      continue;
    }

    return {
      error: {
        key: "cli.error.unknown",
        values: { argument: arg },
      },
    };
  }

  if (!inventory) {
    return {
      error: {
        key: "cli.error.missingOption",
        values: { option: "--inventory" },
      },
    };
  }

  if (!mode) {
    return {
      error: {
        key: "cli.error.missingOption",
        values: { option: "--mode" },
      },
    };
  }

  if (mode !== "all" && mode !== "tag" && mode !== "vpc" && mode !== "seed") {
    return {
      error: {
        key: "cli.error.unsupportedScopeMode",
        values: { mode },
      },
    };
  }

  if (mode === "all" && tags.length > 0) {
    return {
      error: {
        key: "cli.error.scopeOptionForMode",
        values: { mode, option: "--tag" },
      },
    };
  }

  if (mode !== "tag" && withDependencies) {
    return {
      error: {
        key: "cli.error.scopeOptionForMode",
        values: { mode, option: "--with-deps" },
      },
    };
  }

  if (mode !== "vpc" && vpcId) {
    return {
      error: {
        key: "cli.error.scopeOptionForMode",
        values: { mode, option: "--vpc-id" },
      },
    };
  }

  if (mode !== "seed" && resourceId) {
    return {
      error: {
        key: "cli.error.scopeOptionForMode",
        values: { mode, option: "--resource-id" },
      },
    };
  }

  if (mode !== "seed" && depth !== undefined) {
    return {
      error: {
        key: "cli.error.scopeOptionForMode",
        values: { mode, option: "--depth" },
      },
    };
  }

  if (mode === "tag" && tags.length === 0) {
    return {
      error: {
        key: "cli.error.missingOption",
        values: { option: "--tag" },
      },
    };
  }

  if (mode === "vpc" && !vpcId) {
    return {
      error: {
        key: "cli.error.missingOption",
        values: { option: "--vpc-id" },
      },
    };
  }

  if (mode === "seed" && !resourceId) {
    return {
      error: {
        key: "cli.error.missingOption",
        values: { option: "--resource-id" },
      },
    };
  }

  if (mode === "seed" && depth === undefined) {
    return {
      error: {
        key: "cli.error.missingOption",
        values: { option: "--depth" },
      },
    };
  }

  return {
    depth,
    regions: [...new Set(regions)].sort(),
    excludeResourceTypes,
    format,
    inventory,
    mode,
    output,
    resourceId,
    resourceTypes,
    tagOperator,
    tags,
    vpcId,
    withDependencies,
  };
}

function parseNormalizeArguments(
  args: readonly string[],
): NormalizeOptions | { error: ParseError } {
  let gapRules: string | undefined;
  let gapRulesLocal: string | undefined;
  let gapsOutput = DEFAULT_GAPS_OUTPUT;
  let format: OutputFormat = DEFAULT_OUTPUT_FORMAT;
  let inventory: string | undefined;
  let modelOutput = DEFAULT_MODEL_OUTPUT;
  let schemas: string | undefined;
  let scope: string | undefined;
  let suppressions: string | undefined;

  for (let index = 0; index < args.length; index += 1) {
    const arg = args[index];

    if (!arg) {
      continue;
    }

    if (arg === "--inventory") {
      const value = args[index + 1];
      if (!value || value.startsWith("-")) {
        return { error: optionValueError("--inventory") };
      }

      inventory = value;
      index += 1;
      continue;
    }

    if (arg.startsWith("--inventory=")) {
      const value = arg.slice("--inventory=".length);
      if (!value) {
        return { error: optionValueError("--inventory") };
      }

      inventory = value;
      continue;
    }

    if (arg === "--scope") {
      const value = args[index + 1];
      if (!value || value.startsWith("-")) {
        return { error: optionValueError("--scope") };
      }

      scope = value;
      index += 1;
      continue;
    }

    if (arg.startsWith("--scope=")) {
      const value = arg.slice("--scope=".length);
      if (!value) {
        return { error: optionValueError("--scope") };
      }

      scope = value;
      continue;
    }

    if (arg === "--schemas") {
      const value = args[index + 1];
      if (!value || value.startsWith("-")) {
        return { error: optionValueError("--schemas") };
      }

      schemas = value;
      index += 1;
      continue;
    }

    if (arg.startsWith("--schemas=")) {
      const value = arg.slice("--schemas=".length);
      if (!value) {
        return { error: optionValueError("--schemas") };
      }

      schemas = value;
      continue;
    }

    const localRulesPath = parsePathOption(args, index, arg, [
      "--gap-rules-local",
    ]);
    if (localRulesPath) {
      if ("error" in localRulesPath) return localRulesPath;
      gapRulesLocal = localRulesPath.value;
      index += localRulesPath.consumed;
      continue;
    }

    if (arg === "--gap-rules") {
      const value = args[index + 1];
      if (!value || value.startsWith("-")) {
        return { error: optionValueError("--gap-rules") };
      }

      gapRules = value;
      index += 1;
      continue;
    }

    if (arg.startsWith("--gap-rules=")) {
      const value = arg.slice("--gap-rules=".length);
      if (!value) {
        return { error: optionValueError("--gap-rules") };
      }

      gapRules = value;
      continue;
    }

    if (arg === "--suppressions") {
      const value = args[index + 1];
      if (!value || value.startsWith("-")) {
        return { error: optionValueError("--suppressions") };
      }

      suppressions = value;
      index += 1;
      continue;
    }

    if (arg.startsWith("--suppressions=")) {
      const value = arg.slice("--suppressions=".length);
      if (!value) {
        return { error: optionValueError("--suppressions") };
      }

      suppressions = value;
      continue;
    }

    if (arg === "--model-output") {
      const value = args[index + 1];
      if (!value || value.startsWith("-")) {
        return { error: optionValueError("--model-output") };
      }

      modelOutput = value;
      index += 1;
      continue;
    }

    if (arg.startsWith("--model-output=")) {
      const value = arg.slice("--model-output=".length);
      if (!value) {
        return { error: optionValueError("--model-output") };
      }

      modelOutput = value;
      continue;
    }

    if (arg === "--gaps-output") {
      const value = args[index + 1];
      if (!value || value.startsWith("-")) {
        return { error: optionValueError("--gaps-output") };
      }

      gapsOutput = value;
      index += 1;
      continue;
    }

    if (arg.startsWith("--gaps-output=")) {
      const value = arg.slice("--gaps-output=".length);
      if (!value) {
        return { error: optionValueError("--gaps-output") };
      }

      gapsOutput = value;
      continue;
    }

    const parsedFormat = parseFormatArgument(args, index, arg);
    if (parsedFormat) {
      if ("error" in parsedFormat) {
        return parsedFormat;
      }

      format = parsedFormat.value;
      index += parsedFormat.consumed;
      continue;
    }

    return {
      error: {
        key: "cli.error.unknown",
        values: { argument: arg },
      },
    };
  }

  if (!inventory) {
    return {
      error: {
        key: "cli.error.missingOption",
        values: { option: "--inventory" },
      },
    };
  }

  if (!scope) {
    return {
      error: {
        key: "cli.error.missingOption",
        values: { option: "--scope" },
      },
    };
  }

  return {
    format,
    gapRules,
    gapRulesLocal,
    gapsOutput,
    inventory,
    modelOutput,
    schemas,
    scope,
    suppressions,
  };
}

function parseInteractiveArguments(
  args: readonly string[],
): InteractiveOptions | { error: ParseError } {
  let inventory: string | undefined;
  let output = DEFAULT_SCOPE_OUTPUT;

  for (let index = 0; index < args.length; index += 1) {
    const arg = args[index];

    if (!arg) {
      continue;
    }

    if (arg === "--inventory") {
      const value = args[index + 1];
      if (!value || value.startsWith("-")) {
        return { error: optionValueError("--inventory") };
      }

      inventory = value;
      index += 1;
      continue;
    }

    if (arg.startsWith("--inventory=")) {
      const value = arg.slice("--inventory=".length);
      if (!value) {
        return { error: optionValueError("--inventory") };
      }

      inventory = value;
      continue;
    }

    if (arg === "--output") {
      const value = args[index + 1];
      if (!value || value.startsWith("-")) {
        return { error: optionValueError("--output") };
      }

      output = value;
      index += 1;
      continue;
    }

    if (arg.startsWith("--output=")) {
      const value = arg.slice("--output=".length);
      if (!value) {
        return { error: optionValueError("--output") };
      }

      output = value;
      continue;
    }

    return {
      error: {
        key: "cli.error.unknown",
        values: { argument: arg },
      },
    };
  }

  if (!inventory) {
    return {
      error: {
        key: "cli.error.missingOption",
        values: { option: "--inventory" },
      },
    };
  }

  return {
    inventory,
    output,
  };
}

function parseDoctorArguments(
  args: readonly string[],
): DoctorOptions | { error: ParseError } {
  let format: OutputFormat = DEFAULT_OUTPUT_FORMAT;
  let outputDir: string | undefined;
  let profile: string | undefined;
  let region: string | undefined;

  for (let index = 0; index < args.length; index += 1) {
    const arg = args[index];

    if (!arg) {
      continue;
    }

    if (arg === "--profile") {
      const value = args[index + 1];
      if (!value || value.startsWith("-")) {
        return { error: optionValueError("--profile") };
      }

      profile = value;
      index += 1;
      continue;
    }

    if (arg.startsWith("--profile=")) {
      const value = arg.slice("--profile=".length);
      if (!value) {
        return { error: optionValueError("--profile") };
      }

      profile = value;
      continue;
    }

    if (arg === "--region") {
      const value = args[index + 1];
      if (!value || value.startsWith("-")) {
        return { error: optionValueError("--region") };
      }

      region = value;
      index += 1;
      continue;
    }

    if (arg.startsWith("--region=")) {
      const value = arg.slice("--region=".length);
      if (!value) {
        return { error: optionValueError("--region") };
      }

      region = value;
      continue;
    }

    if (arg === "--output-dir") {
      const value = args[index + 1];
      if (!value || value.startsWith("-")) {
        return { error: optionValueError("--output-dir") };
      }

      outputDir = value;
      index += 1;
      continue;
    }

    if (arg.startsWith("--output-dir=")) {
      const value = arg.slice("--output-dir=".length);
      if (!value) {
        return { error: optionValueError("--output-dir") };
      }

      outputDir = value;
      continue;
    }

    const parsedFormat = parseFormatArgument(args, index, arg);
    if (parsedFormat) {
      if ("error" in parsedFormat) {
        return parsedFormat;
      }

      format = parsedFormat.value;
      index += parsedFormat.consumed;
      continue;
    }

    return unknownArgumentError(arg);
  }

  return {
    format,
    outputDir,
    profile,
    region,
  };
}

function parseIamPolicyArguments(
  args: readonly string[],
): IamPolicyOptions | { error: ParseError } {
  let format: OutputFormat = "json";
  let stage: IamPolicyStage = "all";

  for (let index = 0; index < args.length; index += 1) {
    const arg = args[index];

    if (!arg) {
      continue;
    }

    if (arg === "--stage") {
      const value = args[index + 1];
      if (!value || value.startsWith("-")) {
        return { error: optionValueError("--stage") };
      }

      const parsed = parseIamPolicyStage(value);
      if (!parsed) {
        return { error: invalidChoiceError("--stage", value) };
      }

      stage = parsed;
      index += 1;
      continue;
    }

    if (arg.startsWith("--stage=")) {
      const value = arg.slice("--stage=".length);
      const parsed = parseIamPolicyStage(value);
      if (!parsed) {
        return { error: invalidChoiceError("--stage", value) };
      }

      stage = parsed;
      continue;
    }

    const parsedFormat = parseFormatArgument(args, index, arg);
    if (parsedFormat) {
      if ("error" in parsedFormat) {
        return parsedFormat;
      }

      format = parsedFormat.value;
      index += parsedFormat.consumed;
      continue;
    }

    return unknownArgumentError(arg);
  }

  return {
    format,
    stage,
  };
}

function parsePlanArguments(
  args: readonly string[],
): PlanOptions | { error: ParseError } {
  let format: OutputFormat = DEFAULT_OUTPUT_FORMAT;
  let gaps: string | undefined;
  let model: string | undefined;

  for (let index = 0; index < args.length; index += 1) {
    const arg = args[index];

    if (!arg) {
      continue;
    }

    if (arg === "--model") {
      const value = args[index + 1];
      if (!value || value.startsWith("-")) {
        return { error: optionValueError("--model") };
      }

      model = value;
      index += 1;
      continue;
    }

    if (arg.startsWith("--model=")) {
      const value = arg.slice("--model=".length);
      if (!value) {
        return { error: optionValueError("--model") };
      }

      model = value;
      continue;
    }

    if (arg === "--gaps") {
      const value = args[index + 1];
      if (!value || value.startsWith("-")) {
        return { error: optionValueError("--gaps") };
      }

      gaps = value;
      index += 1;
      continue;
    }

    if (arg.startsWith("--gaps=")) {
      const value = arg.slice("--gaps=".length);
      if (!value) {
        return { error: optionValueError("--gaps") };
      }

      gaps = value;
      continue;
    }

    const parsedFormat = parseFormatArgument(args, index, arg);
    if (parsedFormat) {
      if ("error" in parsedFormat) {
        return parsedFormat;
      }

      format = parsedFormat.value;
      index += parsedFormat.consumed;
      continue;
    }

    return unknownArgumentError(arg);
  }

  if (!model) {
    return {
      error: {
        key: "cli.error.missingOption",
        values: { option: "--model" },
      },
    };
  }

  if (!gaps) {
    return {
      error: {
        key: "cli.error.missingOption",
        values: { option: "--gaps" },
      },
    };
  }

  return {
    format,
    gaps,
    model,
  };
}

function parseGenerateArguments(
  args: readonly string[],
): GenerateOptions | { error: ParseError } {
  let format: OutputFormat = DEFAULT_OUTPUT_FORMAT;
  let gaps: string | undefined;
  let language: CdkOutputLanguage = "typescript";
  let liftL2 = false;
  let model: string | undefined;
  let outdir = DEFAULT_GENERATE_OUTPUT_DIR;
  let stackName = DEFAULT_STACK_NAME;

  for (let index = 0; index < args.length; index += 1) {
    const arg = args[index];

    if (!arg) {
      continue;
    }

    if (arg === "--model") {
      const value = args[index + 1];
      if (!value || value.startsWith("-")) {
        return { error: optionValueError("--model") };
      }

      model = value;
      index += 1;
      continue;
    }

    if (arg.startsWith("--model=")) {
      const value = arg.slice("--model=".length);
      if (!value) {
        return { error: optionValueError("--model") };
      }

      model = value;
      continue;
    }

    if (arg === "--gaps") {
      const value = args[index + 1];
      if (!value || value.startsWith("-")) {
        return { error: optionValueError("--gaps") };
      }

      gaps = value;
      index += 1;
      continue;
    }

    if (arg.startsWith("--gaps=")) {
      const value = arg.slice("--gaps=".length);
      if (!value) {
        return { error: optionValueError("--gaps") };
      }

      gaps = value;
      continue;
    }

    if (arg === "--outdir") {
      const value = args[index + 1];
      if (!value || value.startsWith("-")) {
        return { error: optionValueError("--outdir") };
      }

      outdir = value;
      index += 1;
      continue;
    }

    if (arg.startsWith("--outdir=")) {
      const value = arg.slice("--outdir=".length);
      if (!value) {
        return { error: optionValueError("--outdir") };
      }

      outdir = value;
      continue;
    }

    if (arg === "--stack-name") {
      const value = args[index + 1];
      if (!value || value.startsWith("-")) {
        return { error: optionValueError("--stack-name") };
      }

      stackName = value;
      index += 1;
      continue;
    }

    if (arg.startsWith("--stack-name=")) {
      const value = arg.slice("--stack-name=".length);
      if (!value) {
        return { error: optionValueError("--stack-name") };
      }

      stackName = value;
      continue;
    }

    if (arg === "--lift-l2") {
      liftL2 = true;
      continue;
    }

    if (arg === "--language") {
      const value = args[index + 1];
      if (!value || value.startsWith("-")) {
        return { error: optionValueError("--language") };
      }
      if (value !== "typescript" && value !== "python") {
        return { error: invalidChoiceError("--language", value) };
      }
      language = value;
      index += 1;
      continue;
    }

    if (arg.startsWith("--language=")) {
      const value = arg.slice("--language=".length);
      if (value !== "typescript" && value !== "python") {
        return { error: invalidChoiceError("--language", value) };
      }
      language = value;
      continue;
    }

    const parsedFormat = parseFormatArgument(args, index, arg);
    if (parsedFormat) {
      if ("error" in parsedFormat) {
        return parsedFormat;
      }

      format = parsedFormat.value;
      index += parsedFormat.consumed;
      continue;
    }

    return unknownArgumentError(arg);
  }

  if (!model) {
    return {
      error: {
        key: "cli.error.missingOption",
        values: { option: "--model" },
      },
    };
  }

  if (!gaps) {
    return {
      error: {
        key: "cli.error.missingOption",
        values: { option: "--gaps" },
      },
    };
  }

  return {
    format,
    gaps,
    language,
    liftL2,
    model,
    outdir,
    stackName,
  };
}

function parseReportArguments(
  args: readonly string[],
): ReportOptions | { error: ParseError } {
  let format: OutputFormat = DEFAULT_OUTPUT_FORMAT;
  let gaps: string | undefined;
  let importReview: string | undefined;
  let model: string | undefined;
  let outdir = DEFAULT_GENERATE_OUTPUT_DIR;

  for (let index = 0; index < args.length; index += 1) {
    const arg = args[index];

    if (!arg) {
      continue;
    }

    const option = parsePathOption(args, index, arg, [
      "--model",
      "--gaps",
      "--import-review",
      "--outdir",
    ]);
    if (option) {
      if ("error" in option) {
        return option;
      }

      if (option.name === "--model") {
        model = option.value;
      } else if (option.name === "--gaps") {
        gaps = option.value;
      } else if (option.name === "--import-review") {
        importReview = option.value;
      } else {
        outdir = option.value;
      }
      index += option.consumed;
      continue;
    }

    const parsedFormat = parseFormatArgument(args, index, arg);
    if (parsedFormat) {
      if ("error" in parsedFormat) {
        return parsedFormat;
      }

      format = parsedFormat.value;
      index += parsedFormat.consumed;
      continue;
    }

    return unknownArgumentError(arg);
  }

  if (!model) {
    return { error: missingOptionError("--model") };
  }
  if (!gaps) {
    return { error: missingOptionError("--gaps") };
  }
  if (!importReview) {
    return { error: missingOptionError("--import-review") };
  }

  return { format, gaps, importReview, model, outdir };
}

function parseSchemaArguments(
  args: readonly string[],
): SchemaOptions | { error: ParseError } {
  const resourceTypes: string[] = [];
  let format: OutputFormat = DEFAULT_OUTPUT_FORMAT;
  let outputDirectory = DEFAULT_SCHEMA_OUTPUT_DIR;
  let profile: string | undefined;
  let region: string | undefined;

  for (let index = 0; index < args.length; index += 1) {
    const arg = args[index];
    if (!arg) {
      continue;
    }

    if (arg === "--resource-type") {
      const parsed = parseResourceTypeOption(args, index, "--resource-type");
      if ("error" in parsed) {
        return parsed;
      }
      resourceTypes.push(parsed.value);
      index += 1;
      continue;
    }
    if (arg.startsWith("--resource-type=")) {
      const parsed = parseResourceTypeValue(
        arg.slice("--resource-type=".length),
        "--resource-type",
      );
      if ("error" in parsed) {
        return parsed;
      }
      resourceTypes.push(parsed.value);
      continue;
    }

    const option = parsePathOption(args, index, arg, [
      "--region",
      "--profile",
      "--output-dir",
    ]);
    if (option) {
      if ("error" in option) {
        return option;
      }
      if (option.name === "--region") {
        region = option.value;
      } else if (option.name === "--profile") {
        profile = option.value;
      } else {
        outputDirectory = option.value;
      }
      index += option.consumed;
      continue;
    }

    const parsedFormat = parseFormatArgument(args, index, arg);
    if (parsedFormat) {
      if ("error" in parsedFormat) {
        return parsedFormat;
      }
      format = parsedFormat.value;
      index += parsedFormat.consumed;
      continue;
    }

    return unknownArgumentError(arg);
  }

  const resolvedRegion =
    region ?? process.env["AWS_REGION"] ?? process.env["AWS_DEFAULT_REGION"];
  if (!resolvedRegion) {
    return { error: missingOptionError("--region") };
  }
  if (resourceTypes.length === 0) {
    return { error: missingOptionError("--resource-type") };
  }

  return {
    format,
    outputDirectory,
    profile,
    region: resolvedRegion,
    resourceTypes: [...new Set(resourceTypes)].sort(),
  };
}

async function promptForScopeOptions(
  interactive: InteractiveOptions,
  prompts: InteractivePrompts,
): Promise<ScopeOptions> {
  const mode = await prompts.selectMode();

  if (mode === "tag") {
    return {
      excludeResourceTypes: [],
      format: DEFAULT_OUTPUT_FORMAT,
      inventory: interactive.inventory,
      mode,
      output: interactive.output,
      resourceTypes: [],
      tagOperator: await prompts.selectTagOperator(),
      tags: await prompts.inputTagFilters(),
      withDependencies: false,
    };
  }

  if (mode === "vpc") {
    return {
      excludeResourceTypes: [],
      format: DEFAULT_OUTPUT_FORMAT,
      inventory: interactive.inventory,
      mode,
      output: interactive.output,
      resourceTypes: [],
      tagOperator: "and",
      tags: [],
      vpcId: await prompts.inputVpcId(),
      withDependencies: false,
    };
  }

  if (mode === "seed") {
    return {
      depth: await prompts.inputDepth(),
      excludeResourceTypes: [],
      format: DEFAULT_OUTPUT_FORMAT,
      inventory: interactive.inventory,
      mode,
      output: interactive.output,
      resourceId: await prompts.inputResourceId(),
      resourceTypes: [],
      tagOperator: "and",
      tags: [],
      withDependencies: false,
    };
  }

  return {
    excludeResourceTypes: [],
    format: DEFAULT_OUTPUT_FORMAT,
    inventory: interactive.inventory,
    mode,
    output: interactive.output,
    resourceTypes: [],
    tagOperator: "and",
    tags: [],
    withDependencies: false,
  };
}

function createInquirerInteractivePrompts(
  language?: SupportedLanguage,
): InteractivePrompts {
  const translator = createTranslator(language);

  return {
    async confirmExternalReferences(references) {
      return confirm({
        default: true,
        message: formatExternalReferencePrompt(references, translator),
      });
    },
    async inputDepth() {
      const value = await input({
        default: "1",
        message: translator.t("cli.interactive.prompt.depth"),
        required: true,
        validate: (candidate) =>
          parseNonNegativeInteger(candidate) !== undefined ||
          translator.t("cli.interactive.prompt.depthValidation"),
      });
      const parsed = parseNonNegativeInteger(value);

      if (parsed === undefined) {
        throw new Error(
          translator.t("cli.interactive.prompt.invalidDepth", { value }),
        );
      }

      return parsed;
    },
    async inputResourceId() {
      return input({
        message: translator.t("cli.interactive.prompt.resourceId"),
        required: true,
      });
    },
    async inputTagFilters() {
      const value = await input({
        message: translator.t("cli.interactive.prompt.tags"),
        required: true,
        validate: (candidate) =>
          parseTagFilterList(candidate)
            ? true
            : translator.t("cli.interactive.prompt.tagsValidation"),
      });
      const filters = parseTagFilterList(value);

      if (!filters) {
        throw new Error(
          translator.t("cli.interactive.prompt.invalidTags", { value }),
        );
      }

      return filters;
    },
    async inputVpcId() {
      return input({
        message: translator.t("cli.interactive.prompt.vpcId"),
        required: true,
      });
    },
    async selectMode() {
      return select<ScopeMode>({
        choices: [
          { name: "all", value: "all" },
          { name: "tag", value: "tag" },
          { name: "vpc", value: "vpc" },
          { name: "seed", value: "seed" },
        ],
        message: translator.t("cli.interactive.prompt.mode"),
      });
    },
    async selectBoundaryHandling(reference, canInclude) {
      return select<BoundaryHandling>({
        choices: [
          {
            name: translator.t("cli.interactive.boundary.importReference"),
            value: "import-reference",
          },
          {
            name: translator.t("cli.interactive.boundary.parameter"),
            value: "parameter",
          },
          ...(canInclude
            ? [
                {
                  name: translator.t("cli.interactive.boundary.include"),
                  value: "include" as const,
                },
              ]
            : []),
        ],
        default: "import-reference",
        message: translator.t("cli.interactive.boundary.select", {
          type: reference.type,
          value: reference.value,
        }),
      });
    },
    async selectTagOperator() {
      return select<ScopeTagOperator>({
        choices: [
          { name: "and", value: "and" },
          { name: "or", value: "or" },
        ],
        message: translator.t("cli.interactive.prompt.tagOperator"),
      });
    },
  };
}

function formatExternalReferencePrompt(
  references: readonly ExternalReference[],
  translator: ReturnType<typeof createTranslator>,
): string {
  const preview = references
    .slice(0, 5)
    .map(
      (reference) =>
        `- ${translator.t("cli.interactive.boundary.preview", {
          handling: reference.boundaryHandling,
          referencedBy: reference.referencedBy,
          type: reference.type,
          value: reference.value,
        })}`,
    )
    .join("\n");
  const suffix =
    references.length > 5
      ? `\n${translator.t("cli.interactive.boundary.more", {
          count: references.length - 5,
        })}`
      : "";

  return [
    translator.t("cli.interactive.boundary.summary", {
      count: references.length,
    }),
    preview,
    suffix,
    translator.t("cli.interactive.boundary.confirm"),
  ]
    .filter(Boolean)
    .join("\n");
}

function createScopeDocumentForMode(
  scope: ScopeOptions,
  inventory: InventoryDocument,
): ScopeDocument {
  if (scope.mode === "tag") {
    return createTagScopeDocument({
      inventory,
      regions: scope.regions,
      operator: scope.tagOperator,
      tags: scope.tags,
      toolVersion: CLI_VERSION,
      withDependencies: scope.withDependencies,
    });
  }

  if (scope.mode === "vpc") {
    return createVpcScopeDocument({
      inventory,
      regions: scope.regions,
      toolVersion: CLI_VERSION,
      vpcId: scope.vpcId ?? "",
    });
  }

  if (scope.mode === "seed") {
    return createSeedScopeDocument({
      depth: scope.depth ?? 0,
      inventory,
      seedIdentifier: scope.resourceId ?? "",
      regions: scope.regions,
      toolVersion: CLI_VERSION,
    });
  }

  return createAllScopeDocument({
    inventory,
    regions: scope.regions,
    toolVersion: CLI_VERSION,
  });
}

async function runFixtureScanCommand(
  scan: ScanOptions,
  fixturePath: string,
  translator: ReturnType<typeof createTranslator>,
): Promise<CliResult> {
  try {
    const fixture = await readInventoryDocument(fixturePath);
    const regions = new Set(
      scan.allRegions
        ? fixture.resources
            .filter((resource) => resource.region !== "global")
            .map((resource) => resource.region)
        : scan.regions,
    );
    const resources = filterInventoryResources(
      fixture.resources.filter(
        (resource) =>
          (resource.region === "global" ||
          isGlobalResourceType(resource.resourceType)
            ? scan.globalServices !== "exclude"
            : scan.globalServices !== "only" && regions.has(resource.region)) &&
          (scan.includeManaged || !resource.isCloudFormationManaged),
      ),
      scan,
    );
    const document = createInventoryDocument({
      resources: [
        ...new Map(
          resources.map((resource) => {
            const normalized = isGlobalResourceType(resource.resourceType)
              ? { ...resource, region: "global" }
              : resource;
            return [inventoryResourceKey(normalized), normalized];
          }),
        ).values(),
      ],
      toolVersion: CLI_VERSION,
    });

    await writeInventoryFile({
      document,
      outputPath: scan.output,
    });

    return complete(
      formatScanSummary(
        {
          command: "scan",
          fixture: fixturePath,
          output: scan.output,
          regions: [
            ...new Set([
              ...(scan.globalServices === "only" ? [] : regions),
              ...(document.resources.some(
                (resource) => resource.region === "global",
              )
                ? ["global"]
                : []),
            ]),
          ].sort(),
          resourceCount: document.resources.length,
          source: "fixture",
        },
        scan.format,
        translator,
      ),
      hasResourceErrors(document.resources),
    );
  } catch (error) {
    return {
      exitCode: 2,
      stdout: "",
      stderr: [
        translator.t("cli.error.scanFixture", {
          message: errorMessage(error),
          path: fixturePath,
        }),
        translator.t("cli.error.hint"),
      ].join("\n"),
    };
  }
}

async function runAwsScanCommand(
  scan: ScanOptions,
  translator: ReturnType<typeof createTranslator>,
  dependencies: RunCdkxDependencies,
): Promise<CliResult> {
  try {
    const scanEngine =
      dependencies.createScanEngine?.() ??
      createAwsReadOnlyScanEngine({
        toolVersion: CLI_VERSION,
      });
    let scannedRegions: readonly string[] = scan.regions;
    const scanned = await scanEngine.scan({
      onRegionsResolved: (regions) => {
        scannedRegions = [...new Set(regions)].sort();
      },
      ...(scan.verbose || (dependencies.isTTY ?? process.stderr.isTTY)
        ? {
            onProgress: (
              progress: import("@cdk-excavator/core").ScanProgress,
            ) => {
              const {
                operation,
                region,
                resourceType,
                completed,
                total,
                identifier,
              } = progress;
              if (
                !scan.verbose &&
                completed !== undefined &&
                total &&
                completed < total &&
                completed % Math.max(1, Math.ceil(total / 10)) !== 0
              )
                return;
              const publicProgress = {
                operation,
                region,
                resourceType,
                completed,
                total,
                ...(completed !== undefined && total
                  ? { percent: Math.floor((completed * 100) / total) }
                  : {}),
              };
              const metadata = scan.verbose
                ? { ...publicProgress, ...(identifier ? { identifier } : {}) }
                : publicProgress;
              const message = `${JSON.stringify({ message: translator.t("stage.scan.progress"), ...metadata })}\n`;
              (
                dependencies.writeStderr ??
                ((text: string) => process.stderr.write(text))
              )(message);
            },
          }
        : {}),
      allRegions: scan.allRegions,
      globalServices: scan.globalServices,
      resourceTypes:
        scan.resourceTypes.length > 0 ? scan.resourceTypes : undefined,
      excludeResourceTypes: scan.excludeResourceTypes,
      concurrency: scan.concurrency,
      includeManaged: scan.includeManaged,
      profile: scan.profile,
      regions: scan.regions,
    });
    const document = InventoryDocumentSchema.parse({
      ...scanned,
      resources: filterInventoryResources(scanned.resources, scan),
    });

    await writeInventoryFile({
      document,
      outputPath: scan.output,
    });

    return complete(
      formatScanSummary(
        {
          command: "scan",
          output: scan.output,
          profile: scan.profile,
          regions: scannedRegions,
          resourceCount: document.resources.length,
          source: "aws",
        },
        scan.format,
        translator,
      ),
      hasResourceErrors(document.resources),
    );
  } catch (error) {
    return {
      exitCode: 2,
      stdout: "",
      stderr: [
        translator.t("cli.error.scan", {
          message: errorMessage(error),
          output: scan.output,
        }),
        translator.t("cli.error.hint"),
      ].join("\n"),
    };
  }
}

async function readInventoryDocument(path: string): Promise<InventoryDocument> {
  const content = await readFile(path, "utf8");
  return InventoryDocumentSchema.parse(JSON.parse(content) as unknown);
}

async function readScopeDocument(path: string): Promise<ScopeDocument> {
  const content = await readFile(path, "utf8");
  return ScopeDocumentSchema.parse(JSON.parse(content) as unknown);
}

async function readCfnSchemas(
  directory: string,
): Promise<readonly CfnResourceSchema[]> {
  const entries = await readdir(directory, { withFileTypes: true });
  const schemas: CfnResourceSchema[] = [];

  for (const entry of entries
    .filter((candidate) => candidate.isFile())
    .map((candidate) => candidate.name)
    .filter((name) => name.endsWith(".json"))
    .sort()) {
    const content = await readFile(join(directory, entry), "utf8");
    schemas.push(CfnResourceSchemaSchema.parse(JSON.parse(content) as unknown));
  }

  if (schemas.length === 0) {
    throw new Error(
      `No CloudFormation schema JSON files found in ${directory}`,
    );
  }

  return schemas;
}

async function readGapRuleSet(directory: string): Promise<GapRuleSet> {
  const entries = await readdir(directory, { withFileTypes: true });
  const propertyRules: GapRuleSet["propertyRules"] = [];
  const resourceRules: GapRuleSet["resourceRules"] = [];

  for (const entry of entries
    .filter((candidate) => candidate.isFile())
    .map((candidate) => candidate.name)
    .filter((name) => name.endsWith(".json"))
    .sort()) {
    const content = await readFile(join(directory, entry), "utf8");
    const parsed = GapRuleSetSchema.parse(JSON.parse(content) as unknown);
    propertyRules.push(...parsed.propertyRules);
    resourceRules.push(...parsed.resourceRules);
  }

  if (propertyRules.length === 0 && resourceRules.length === 0) {
    throw new Error(`No gap rule JSON entries found in ${directory}`);
  }

  return GapRuleSetSchema.parse({
    propertyRules,
    resourceRules,
    version: TOOL_SCHEMA_VERSION,
  });
}

async function readGapSuppressionSet(path: string): Promise<GapSuppressionSet> {
  const content = await readFile(path, "utf8");
  return GapSuppressionSetSchema.parse(JSON.parse(content) as unknown);
}

async function readNormalizationModelDocument(
  path: string,
): Promise<NormalizationModelDocument> {
  const content = await readFile(path, "utf8");
  return NormalizationModelDocumentSchema.parse(JSON.parse(content) as unknown);
}

async function readGapDocument(path: string): Promise<GapDocument> {
  const content = await readFile(path, "utf8");
  return GapDocumentSchema.parse(JSON.parse(content) as unknown);
}

async function readCdkImportReviewDocument(
  path: string,
): Promise<CdkImportMapDocument> {
  const content = await readFile(path, "utf8");
  return CdkImportMapDocumentSchema.parse(JSON.parse(content) as unknown);
}

function selectedReportLanguages(
  parsed: ParsedArguments,
): readonly ReportLanguage[] {
  const requested =
    parsed.languages.length > 0
      ? parsed.languages
      : [createTranslator(parsed.language).language];
  return [...new Set(requested)];
}

function filterInventoryDocument(
  inventory: InventoryDocument,
  filters: {
    readonly excludeResourceTypes: readonly string[];
    readonly resourceTypes: readonly string[];
  },
): InventoryDocument {
  return InventoryDocumentSchema.parse({
    ...inventory,
    resources: filterInventoryResources(inventory.resources, filters),
  });
}

function filterInventoryResources(
  resources: readonly InventoryResource[],
  filters: {
    readonly excludeResourceTypes: readonly string[];
    readonly resourceTypes: readonly string[];
  },
): InventoryResource[] {
  const included = new Set(filters.resourceTypes);
  const excluded = new Set(filters.excludeResourceTypes);

  return resources.filter(
    (resource) =>
      (included.size === 0 || included.has(resource.resourceType)) &&
      !excluded.has(resource.resourceType),
  );
}

async function createDoctorResult(
  options: DoctorOptions,
): Promise<DoctorResult> {
  const checks: DoctorCheck[] = [];
  const profile = options.profile ?? process.env["AWS_PROFILE"];
  const region =
    options.region ??
    process.env["AWS_REGION"] ??
    process.env["AWS_DEFAULT_REGION"];

  checks.push({
    detail: `node=${process.versions.node}`,
    name: "node",
    status: isSupportedCliNodeVersion(process.versions.node) ? "pass" : "fail",
  });
  checks.push({
    detail: profile
      ? `profile=${profile}`
      : "No explicit profile. AWS SDK default credential chain may still work.",
    name: "aws-profile",
    status: profile ? "pass" : "warn",
  });
  checks.push({
    detail: region
      ? `region=${region}`
      : "No explicit region. Pass --region or set AWS_REGION.",
    name: "aws-region",
    status: region ? "pass" : "warn",
  });
  checks.push(
    options.outputDir
      ? await checkOutputDirectory(options.outputDir)
      : {
          detail: "No output directory was provided.",
          name: "output-dir",
          status: "warn",
        },
  );
  checks.push({
    detail:
      "Read-only permissions are not called during offline doctor. Use cdkx iam-policy before real AWS scans.",
    name: "read-only-permissions",
    status: "warn",
  });

  return { checks };
}

async function checkOutputDirectory(path: string): Promise<DoctorCheck> {
  try {
    const entry = await stat(path);

    if (!entry.isDirectory()) {
      return {
        detail: `${path} is not a directory.`,
        name: "output-dir",
        status: "fail",
      };
    }

    await access(path, constants.W_OK);
    return {
      detail: `${path} is writable.`,
      name: "output-dir",
      status: "pass",
    };
  } catch (error) {
    return {
      detail: `${path}: ${errorMessage(error)}`,
      name: "output-dir",
      status: "fail",
    };
  }
}

function createIamPolicyDocument(stage: IamPolicyStage): IamPolicyDocument {
  const actions =
    stage === "all"
      ? [...READ_ONLY_POLICY_ACTIONS]
      : stage === "scan"
        ? [...SCAN_POLICY_ACTIONS]
        : stage === "schemas"
          ? [...SCHEMA_POLICY_ACTIONS]
          : [];

  return {
    Statement:
      actions.length > 0
        ? [
            {
              Action: actions,
              Effect: "Allow",
              Resource: "*",
            },
          ]
        : [],
    Version: "2012-10-17",
  };
}

function createPlanSummary(
  model: NormalizationModelDocument,
  gaps: GapDocument,
): PlanSummary {
  const plan = createStackPlan(model, DEFAULT_STACK_NAME);
  return {
    plan,
    stackCount: plan.stacks.length,
    reviewReferenceCount: plan.references.filter(
      (reference) =>
        reference.reason ||
        !["internal-token", "cross-stack-token", "excluded-property"].includes(
          reference.disposition,
        ),
    ).length,
    blockingGaps: countGaps(gaps, (gap) => gap.severity === "blocking"),
    cfnManagedResources: countGaps(gaps, (gap) => gap.code === "GAP-5"),
    codeableResources: model.resources.filter(
      (resource) => resource.status === "codeable",
    ).length,
    excludedResources: model.resources.filter(
      (resource) => resource.status === "excluded",
    ).length,
    gapCount: gaps.gaps.length,
    gapsByCode: countBy(gaps.gaps.map((gap) => gap.code)),
    gapsBySeverity: countBy(gaps.gaps.map((gap) => gap.severity)),
    manualResources: model.resources.filter(
      (resource) => resource.status === "manual",
    ).length,
    propertyCoverageScore: model.coverage.properties.score,
    replacementRiskGaps: countGaps(gaps, (gap) => gap.code === "GAP-7"),
    resourceCoverageScore: model.coverage.resources.score,
    totalResources: model.resources.length,
    writeOnlyGaps: countGaps(gaps, (gap) => gap.code === "GAP-2"),
  };
}

function countGaps(
  gaps: GapDocument,
  predicate: (gap: GapDocument["gaps"][number]) => boolean,
): number {
  return gaps.gaps.filter(predicate).length;
}

function countBy(values: readonly string[]): Readonly<Record<string, number>> {
  const result: Record<string, number> = {};

  for (const value of [...values].sort()) {
    result[value] = (result[value] ?? 0) + 1;
  }

  return result;
}

function formatScanSummary(
  summary: ScanSummary,
  format: OutputFormat,
  translator: ReturnType<typeof createTranslator>,
): string {
  if (format === "json") {
    return formatJson(summary);
  }

  if (format === "table") {
    return renderTable(
      ["metric", "value"],
      [
        ["source", summary.source],
        ["regions", summary.regions.join(",")],
        ["profile", summary.profile ?? "-"],
        ["fixture", summary.fixture ?? "-"],
        ["output", summary.output],
        ["resourceCount", summary.resourceCount.toString()],
      ],
    );
  }

  return summary.source === "fixture"
    ? translator.t("cli.scan.wroteFixture", {
        fixture: summary.fixture ?? "-",
        output: summary.output,
        resourceCount: summary.resourceCount,
        regions: summary.regions.join(","),
      })
    : translator.t("cli.scan.wroteInventory", {
        output: summary.output,
        profile: summary.profile ?? "-",
        resourceCount: summary.resourceCount,
        regions: summary.regions.join(","),
      });
}

function formatScopeSummary(
  summary: ScopeSummary,
  format: OutputFormat,
  translator: ReturnType<typeof createTranslator>,
): string {
  if (format === "json") {
    return formatJson(summary);
  }

  if (format === "table") {
    return renderTable(
      ["metric", "value"],
      [
        ["inventory", summary.inventory],
        ["mode", summary.mode],
        ["output", summary.output],
        ["resourceCount", summary.resourceCount.toString()],
        ["edgeCount", summary.edgeCount.toString()],
      ],
    );
  }

  return translator.t("cli.scope.wroteScope", {
    edgeCount: summary.edgeCount,
    inventory: summary.inventory,
    mode: summary.mode,
    output: summary.output,
    resourceCount: summary.resourceCount,
  });
}

function formatNormalizeSummary(
  summary: NormalizeSummary,
  format: OutputFormat,
  translator: ReturnType<typeof createTranslator>,
): string {
  if (format === "json") {
    return formatJson(summary);
  }

  if (format === "table") {
    return renderTable(
      ["metric", "value"],
      [
        ["scope", summary.scope],
        ["modelOutput", summary.modelOutput],
        ["gapsOutput", summary.gapsOutput],
        ["resourceCount", summary.resourceCount.toString()],
        ["gapCount", summary.gapCount.toString()],
      ],
    );
  }

  return translator.t("cli.normalize.wroteDocuments", {
    gapCount: summary.gapCount,
    gapsOutput: summary.gapsOutput,
    modelOutput: summary.modelOutput,
    resourceCount: summary.resourceCount,
    scope: summary.scope,
  });
}

function formatGenerateSummary(
  summary: GenerateSummary,
  format: OutputFormat,
  translator: ReturnType<typeof createTranslator>,
): string {
  if (format === "json") {
    return formatJson(summary);
  }

  if (format === "table") {
    return renderTable(
      ["metric", "value"],
      [
        ["stackName", summary.stackName],
        ["language", summary.language],
        ["outdir", summary.outdir],
        ["templateOutput", summary.templateOutput],
        ["importMapOutput", summary.importMapOutput],
        ["importReviewOutput", summary.importReviewOutput],
        ["importGuideOutput", summary.importGuideOutput],
        ["stackFile", summary.stackFile],
        ["resourceCount", summary.resourceCount.toString()],
        ["converterFallbackCount", summary.converterFallbackCount.toString()],
        ["converterFallbackOutput", summary.converterFallbackOutput ?? "-"],
      ],
    );
  }

  return translator.t("cli.generate.wroteDocuments", {
    importGuideOutput: summary.importGuideOutput,
    importMapOutput: summary.importMapOutput,
    importReviewOutput: summary.importReviewOutput,
    resourceCount: summary.resourceCount,
    converterFallbackCount: summary.converterFallbackCount,
    converterFallbackOutput: summary.converterFallbackOutput ?? "-",
    language: summary.language,
    stackName: summary.stackName,
    stackFile: summary.stackFile,
    templateOutput: summary.templateOutput,
  });
}

function formatReportSummary(
  summary: ReportSummary,
  format: OutputFormat,
  translator: ReturnType<typeof createTranslator>,
): string {
  if (format === "json") {
    return formatJson(summary);
  }

  if (format === "table") {
    return renderTable(
      ["metric", "value"],
      [
        ["outdir", summary.outdir],
        ["languages", summary.languages.join(",")],
        ["resourceCount", summary.resourceCount.toString()],
        ["gapCount", summary.gapCount.toString()],
      ],
    );
  }

  return translator.t("cli.report.wroteDocuments", {
    gapCount: summary.gapCount,
    languages: summary.languages.join(","),
    outdir: summary.outdir,
    resourceCount: summary.resourceCount,
  });
}

function formatSchemaSummary(
  summary: SchemaSummary,
  format: OutputFormat,
  translator: ReturnType<typeof createTranslator>,
): string {
  if (format === "json") {
    return formatJson(summary);
  }
  if (format === "table") {
    return renderTable(
      ["metric", "value"],
      [
        ["region", summary.region],
        ["profile", summary.profile ?? "-"],
        ["outputDirectory", summary.outputDirectory],
        ["resourceTypes", summary.resourceTypes.join(",")],
      ],
    );
  }
  return translator.t("cli.schemas.wroteSchemas", {
    count: summary.resourceTypes.length,
    output: summary.outputDirectory,
    region: summary.region,
  });
}

function formatDoctorResult(
  result: DoctorResult,
  format: OutputFormat,
  translator: ReturnType<typeof createTranslator>,
): string {
  if (format === "json") {
    return formatJson(result);
  }

  if (format === "table") {
    return renderTable(
      ["check", "status", "detail"],
      result.checks.map((check) => [check.name, check.status, check.detail]),
    );
  }

  return [
    translator.t("cli.doctor.text.title"),
    ...result.checks.map(
      (check) => `- ${check.name}: ${check.status} (${check.detail})`,
    ),
  ].join("\n");
}

function formatIamPolicyDocument(
  policy: IamPolicyDocument,
  format: OutputFormat,
  translator: ReturnType<typeof createTranslator>,
): string {
  const actions = policy.Statement.flatMap((statement) => statement.Action);

  if (format === "json") {
    return formatJson(policy);
  }

  if (format === "table") {
    return renderTable(
      ["effect", "action", "resource"],
      actions.map((action) => ["Allow", action, "*"]),
    );
  }

  return [
    translator.t("cli.iamPolicy.text.title"),
    ...(actions.length > 0
      ? actions.map((action) => `- ${action}`)
      : [`- ${translator.t("cli.iamPolicy.text.noPermissions")}`]),
  ].join("\n");
}

function formatPlanSummary(
  summary: PlanSummary,
  format: OutputFormat,
  translator: ReturnType<typeof createTranslator>,
): string {
  if (format === "json") {
    return formatJson(summary);
  }

  if (format === "table") {
    return renderTable(
      ["metric", "value"],
      [
        ["totalResources", summary.totalResources.toString()],
        ["stackCount", summary.stackCount.toString()],
        ["reviewReferenceCount", summary.reviewReferenceCount.toString()],
        ["codeableResources", summary.codeableResources.toString()],
        ["manualResources", summary.manualResources.toString()],
        ["excludedResources", summary.excludedResources.toString()],
        ["gapCount", summary.gapCount.toString()],
        ["writeOnlyGaps", summary.writeOnlyGaps.toString()],
        ["cfnManagedResources", summary.cfnManagedResources.toString()],
        ["replacementRiskGaps", summary.replacementRiskGaps.toString()],
        ["blockingGaps", summary.blockingGaps.toString()],
        ["resourceCoverageScore", summary.resourceCoverageScore.toString()],
        ["propertyCoverageScore", summary.propertyCoverageScore.toString()],
      ],
    );
  }

  return [
    translator.t("cli.plan.text.title"),
    translator.t("cli.plan.text.structure", {
      stacks: summary.stackCount,
      references: summary.reviewReferenceCount,
    }),
    ...summary.plan.stacks.map((stack) =>
      translator.t("cli.plan.text.stack", {
        stack: stack.stackName,
        kind: stack.kind,
        region: stack.region ?? "?",
        count: stack.resourceKeys.length,
      }),
    ),
    translator.t("cli.plan.text.resources", {
      codeable: summary.codeableResources,
      excluded: summary.excludedResources,
      manual: summary.manualResources,
      total: summary.totalResources,
    }),
    translator.t("cli.plan.text.gaps", {
      blocking: summary.blockingGaps,
      cfnManaged: summary.cfnManagedResources,
      replacementRisk: summary.replacementRiskGaps,
      total: summary.gapCount,
      writeOnly: summary.writeOnlyGaps,
    }),
    translator.t("cli.plan.text.coverage", {
      properties: summary.propertyCoverageScore,
      resources: summary.resourceCoverageScore,
    }),
    translator.t("cli.plan.text.gapCodes", {
      value: formatCountRecord(summary.gapsByCode),
    }),
    translator.t("cli.plan.text.severities", {
      value: formatCountRecord(summary.gapsBySeverity),
    }),
  ].join("\n");
}

function formatCountRecord(record: Readonly<Record<string, number>>): string {
  const entries = Object.entries(record).sort(([left], [right]) =>
    left.localeCompare(right),
  );

  return entries.length > 0
    ? entries.map(([key, value]) => `${key}=${value}`).join(",")
    : "-";
}

function renderTable(
  headers: readonly string[],
  rows: readonly (readonly string[])[],
): string {
  const widths = headers.map((header, index) =>
    Math.max(header.length, ...rows.map((row) => row[index]?.length ?? 0)),
  );
  const renderRow = (row: readonly string[]) =>
    row
      .map((cell, index) => cell.padEnd(widths[index] ?? cell.length))
      .join("  ")
      .trimEnd();
  const separator = widths.map((width) => "-".repeat(width)).join("  ");

  return [renderRow(headers), separator, ...rows.map(renderRow)].join("\n");
}

function formatJson(value: unknown): string {
  return JSON.stringify(value, null, 2);
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function optionValueError(option: string): ParseError {
  return {
    key: "cli.error.missingOptionValue",
    values: { option },
  };
}

function missingOptionError(option: string): ParseError {
  return {
    key: "cli.error.missingOption",
    values: { option },
  };
}

function parsePathOption(
  args: readonly string[],
  index: number,
  argument: string,
  names: readonly string[],
):
  | { readonly consumed: number; readonly name: string; readonly value: string }
  | { readonly error: ParseError }
  | undefined {
  for (const name of names) {
    if (argument === name) {
      const value = args[index + 1];
      return !value || value.startsWith("-")
        ? { error: optionValueError(name) }
        : { consumed: 1, name, value };
    }

    if (argument.startsWith(`${name}=`)) {
      const value = argument.slice(name.length + 1);
      return value
        ? { consumed: 0, name, value }
        : { error: optionValueError(name) };
    }
  }

  return undefined;
}

function invalidNumberError(option: string, value: string): ParseError {
  return {
    key: "cli.error.invalidNumber",
    values: { option, value },
  };
}

function invalidChoiceError(option: string, value: string): ParseError {
  return {
    key: "cli.error.invalidChoice",
    values: { option, value },
  };
}

function unknownArgumentError(argument: string): { error: ParseError } {
  return {
    error: {
      key: "cli.error.unknown",
      values: { argument },
    },
  };
}

function parseErrorResult(
  error: ParseError,
  translator: ReturnType<typeof createTranslator>,
): CliResult {
  return {
    exitCode: 2,
    stdout: "",
    stderr: [
      translator.t(error.key, error.values),
      translator.t("cli.error.hint"),
    ].join("\n"),
  };
}

function parseFormatArgument(
  args: readonly string[],
  index: number,
  arg: string,
):
  | { readonly consumed: number; readonly value: OutputFormat }
  | { readonly error: ParseError }
  | undefined {
  if (arg === "--format") {
    const value = args[index + 1];
    if (!value || value.startsWith("-")) {
      return { error: optionValueError("--format") };
    }

    const parsed = parseOutputFormat(value);
    if (!parsed) {
      return { error: invalidChoiceError("--format", value) };
    }

    return { consumed: 1, value: parsed };
  }

  if (arg.startsWith("--format=")) {
    const value = arg.slice("--format=".length);
    const parsed = parseOutputFormat(value);
    if (!parsed) {
      return { error: invalidChoiceError("--format", value) };
    }

    return { consumed: 0, value: parsed };
  }

  return undefined;
}

function parseOutputFormat(value: string): OutputFormat | undefined {
  return value === "json" || value === "table" || value === "text"
    ? value
    : undefined;
}

function parseIamPolicyStage(value: string): IamPolicyStage | undefined {
  return value === "all" ||
    value === "generate" ||
    value === "normalize" ||
    value === "scan" ||
    value === "schemas" ||
    value === "scope"
    ? value
    : undefined;
}

function parseResourceTypeOption(
  args: readonly string[],
  index: number,
  option: string,
): { readonly value: string } | { readonly error: ParseError } {
  const value = args[index + 1];
  if (!value || value.startsWith("-")) {
    return { error: optionValueError(option) };
  }

  return parseResourceTypeValue(value, option);
}

function parseResourceTypeValue(
  value: string,
  option: string,
): { readonly value: string } | { readonly error: ParseError } {
  if (!/^AWS::[A-Za-z0-9]+::[A-Za-z0-9]+$/.test(value)) {
    return {
      error: {
        key: "cli.error.invalidResourceType",
        values: { option, value },
      },
    };
  }

  return { value };
}

function parseConcurrency(value: string): number | undefined {
  const parsed = Number(value);
  return Number.isInteger(parsed) && parsed > 0 ? parsed : undefined;
}

function parseNonNegativeInteger(value: string): number | undefined {
  const parsed = Number(value);
  return Number.isInteger(parsed) && parsed >= 0 ? parsed : undefined;
}

function parseTagFilter(value: string): ScopeTagFilter | undefined {
  const separatorIndex = value.indexOf("=");
  if (separatorIndex <= 0 || separatorIndex === value.length - 1) {
    return undefined;
  }

  return {
    key: value.slice(0, separatorIndex),
    value: value.slice(separatorIndex + 1),
  };
}

function parseTagFilterList(
  value: string,
): readonly ScopeTagFilter[] | undefined {
  const filters = value.split(",").map((entry) => parseTagFilter(entry.trim()));

  if (filters.length === 0 || filters.some((filter) => !filter)) {
    return undefined;
  }

  return filters as ScopeTagFilter[];
}

function parseTagOperator(value: string): ScopeTagOperator | undefined {
  return value === "and" || value === "or" ? value : undefined;
}

function ok(stdout: string): CliResult {
  return complete(stdout, false);
}

function complete(stdout: string, partial: boolean): CliResult {
  return {
    exitCode: partial ? 1 : 0,
    stdout,
    stderr: "",
  };
}

function hasResourceErrors(
  resources: readonly Pick<InventoryResource, "errors">[],
): boolean {
  return resources.some((resource) => resource.errors.length > 0);
}
