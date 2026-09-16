import { readdir, readFile, stat } from "node:fs/promises";
import { extname, relative, resolve } from "node:path";
import { pathToFileURL } from "node:url";

import ts from "typescript";

const sourceExtensions = new Set([".ts", ".tsx", ".js", ".mjs", ".cjs"]);
const ignoredDirectories = new Set([
  ".git",
  "coverage",
  "dist",
  "node_modules",
  "release",
]);

const approvedModules = new Map([
  [
    "@aws-sdk/client-cloudcontrol",
    new Set([
      "CloudControlClient",
      "GetResourceCommand",
      "ListResourcesCommand",
    ]),
  ],
  [
    "@aws-sdk/client-cloudformation",
    new Set([
      "CloudFormationClient",
      "DescribeStackResourcesCommand",
      "DescribeStacksCommand",
      "DescribeTypeCommand",
    ]),
  ],
  [
    "@aws-sdk/client-ec2",
    new Set([
      "DescribeInternetGatewaysCommand",
      "DescribeNatGatewaysCommand",
      "DescribeRegionsCommand",
      "DescribeRouteTablesCommand",
      "DescribeSecurityGroupsCommand",
      "DescribeSubnetsCommand",
      "DescribeVpcEndpointsCommand",
      "DescribeVpcsCommand",
      "EC2Client",
    ]),
  ],
  ["@aws-sdk/credential-provider-ini", new Set(["fromIni"])],
]);

const approvedCommands = new Map(
  [...approvedModules].map(([moduleName, values]) => [
    moduleName,
    new Set([...values].filter((value) => value.endsWith("Command"))),
  ]),
);

const approvedRuntimeBoundaries = new Map([
  [
    "packages/core/src/scan/cloud-control-client.ts",
    new Map([
      [
        "@aws-sdk/client-cloudcontrol",
        new Set([
          "CloudControlClient",
          "GetResourceCommand",
          "ListResourcesCommand",
        ]),
      ],
    ]),
  ],
  [
    "packages/core/src/scan/cloudformation-client.ts",
    new Map([
      [
        "@aws-sdk/client-cloudformation",
        new Set([
          "CloudFormationClient",
          "DescribeStackResourcesCommand",
          "DescribeStacksCommand",
        ]),
      ],
    ]),
  ],
  [
    "packages/core/src/scan/ec2-vpc-client.ts",
    new Map([
      [
        "@aws-sdk/client-ec2",
        new Set([
          "DescribeInternetGatewaysCommand",
          "DescribeNatGatewaysCommand",
          "DescribeRegionsCommand",
          "DescribeRouteTablesCommand",
          "DescribeSecurityGroupsCommand",
          "DescribeSubnetsCommand",
          "DescribeVpcEndpointsCommand",
          "DescribeVpcsCommand",
          "EC2Client",
        ]),
      ],
    ]),
  ],
  [
    "packages/core/src/scan/scan-engine.ts",
    new Map([["@aws-sdk/credential-provider-ini", new Set(["fromIni"])]]),
  ],
  [
    "packages/core/src/schema/schema-provider.ts",
    new Map([
      [
        "@aws-sdk/client-cloudformation",
        new Set(["CloudFormationClient", "DescribeTypeCommand"]),
      ],
      ["@aws-sdk/credential-provider-ini", new Set(["fromIni"])],
    ]),
  ],
]);

export function analyzeAwsApiSource({ path, text }) {
  const normalizedPath = normalizePath(path);
  const isTestFile = /(?:^|\/)[^/]+\.(?:test|spec)\.[^.]+$/.test(
    normalizedPath,
  );
  const sourceFile = ts.createSourceFile(
    normalizedPath,
    text,
    ts.ScriptTarget.Latest,
    true,
    scriptKindFor(normalizedPath),
  );
  const findings = [];
  const commandBindings = new Map();

  for (const statement of sourceFile.statements) {
    if (ts.isImportDeclaration(statement)) {
      inspectImportDeclaration(statement);
    } else if (
      ts.isExportDeclaration(statement) &&
      isAwsSdkModuleSpecifier(statement.moduleSpecifier)
    ) {
      addFinding(
        statement,
        "aws-sdk-reexport",
        "Re-exporting AWS SDK values bypasses the runtime allowlist boundary.",
      );
    } else if (
      ts.isImportEqualsDeclaration(statement) &&
      ts.isExternalModuleReference(statement.moduleReference) &&
      isAwsSdkModuleSpecifier(statement.moduleReference.expression)
    ) {
      addFinding(
        statement,
        "aws-sdk-import-shape",
        "AWS SDK imports must use static named ESM imports.",
      );
    }
  }

  visit(sourceFile);

  return findings.sort(
    (left, right) =>
      left.line - right.line ||
      left.column - right.column ||
      compareStable(left.rule, right.rule),
  );

  function inspectImportDeclaration(node) {
    if (!isAwsSdkModuleSpecifier(node.moduleSpecifier)) {
      return;
    }

    const moduleName = node.moduleSpecifier.text;
    const approvedValues = approvedModules.get(moduleName);
    if (!approvedValues) {
      addFinding(
        node.moduleSpecifier,
        "unapproved-aws-sdk-module",
        `AWS SDK module ${moduleName} is not approved for runtime use.`,
      );
    }

    const importClause = node.importClause;
    if (
      !importClause ||
      importClause.name ||
      !importClause.namedBindings ||
      !ts.isNamedImports(importClause.namedBindings)
    ) {
      addFinding(
        node,
        "aws-sdk-import-shape",
        "AWS SDK imports must use static named imports; default, namespace, and side-effect imports are rejected.",
      );
      return;
    }

    for (const element of importClause.namedBindings.elements) {
      const importedName = (element.propertyName ?? element.name).text;
      const localName = element.name.text;

      if (importedName.endsWith("Command")) {
        const moduleCommands = approvedCommands.get(moduleName);
        if (!moduleCommands?.has(importedName)) {
          addFinding(
            element,
            "unapproved-aws-command",
            `${importedName} from ${moduleName} is not in the complete read-only command allowlist.`,
          );
        }
      }

      if (importClause.isTypeOnly || element.isTypeOnly) {
        continue;
      }

      if (!approvedValues?.has(importedName)) {
        addFinding(
          element,
          "unapproved-aws-sdk-value",
          `${importedName} from ${moduleName} is not approved for runtime import.`,
        );
      }

      if (!isTestFile) {
        const boundaryValues = approvedRuntimeBoundaries
          .get(normalizedPath)
          ?.get(moduleName);
        if (!boundaryValues?.has(importedName)) {
          addFinding(
            element,
            "aws-runtime-boundary",
            `${importedName} from ${moduleName} is not approved in ${normalizedPath}.`,
          );
        }
      }

      if (importedName.endsWith("Command")) {
        commandBindings.set(localName, { importedName, moduleName });
      }
    }
  }

  function visit(node) {
    if (ts.isCallExpression(node)) {
      inspectDynamicImport(node);
      inspectSendCall(node);
    }

    if (ts.isNewExpression(node)) {
      inspectCommandConstruction(node);
    }

    ts.forEachChild(node, visit);
  }

  function inspectDynamicImport(node) {
    const isDynamicImport =
      node.expression.kind === ts.SyntaxKind.ImportKeyword;
    const isRequire =
      ts.isIdentifier(node.expression) && node.expression.text === "require";
    if (!isDynamicImport && !isRequire) {
      return;
    }
    if (isAwsSdkModuleSpecifier(node.arguments[0])) {
      addFinding(
        node,
        "aws-sdk-dynamic-import",
        "Dynamic or CommonJS AWS SDK imports are rejected; use an approved static named import.",
      );
    }
  }

  function inspectSendCall(node) {
    if (
      isTestFile ||
      !ts.isPropertyAccessExpression(node.expression) ||
      node.expression.name.text !== "send"
    ) {
      return;
    }

    const firstArgument = unwrapParentheses(node.arguments[0]);
    if (
      !firstArgument ||
      !ts.isNewExpression(firstArgument) ||
      !ts.isIdentifier(firstArgument.expression)
    ) {
      addFinding(
        node,
        "aws-send-boundary",
        "Runtime .send() calls must directly construct an approved AWS SDK command.",
      );
      return;
    }

    const binding = commandBindings.get(firstArgument.expression.text);
    if (!binding) {
      addFinding(
        firstArgument,
        "aws-send-boundary",
        `${firstArgument.expression.text} is not an approved statically imported AWS SDK command.`,
      );
    }
  }

  function inspectCommandConstruction(node) {
    if (!ts.isIdentifier(node.expression)) {
      return;
    }
    const localName = node.expression.text;
    if (!localName.endsWith("Command")) {
      return;
    }
    const binding = commandBindings.get(localName);
    if (!binding) {
      addFinding(
        node,
        "unapproved-command-construction",
        `${localName} is constructed without an approved AWS SDK command import.`,
      );
      return;
    }
    if (!isTestFile && !isDirectSendArgument(node)) {
      addFinding(
        node,
        "aws-send-boundary",
        `${binding.importedName} must be constructed directly inside client.send().`,
      );
    }
  }

  function isDirectSendArgument(node) {
    let current = node;
    while (current.parent && ts.isParenthesizedExpression(current.parent)) {
      current = current.parent;
    }
    const parent = current.parent;
    return Boolean(
      parent &&
      ts.isCallExpression(parent) &&
      ts.isPropertyAccessExpression(parent.expression) &&
      parent.expression.name.text === "send" &&
      unwrapParentheses(parent.arguments[0]) === node,
    );
  }

  function addFinding(node, rule, message) {
    const start = node.getStart(sourceFile);
    const position = sourceFile.getLineAndCharacterOfPosition(start);
    findings.push({
      column: position.character + 1,
      line: position.line + 1,
      match: node.getText(sourceFile).slice(0, 160),
      message,
      path: normalizedPath,
      rule,
    });
  }
}

export async function scanAwsApiUsage({
  cwd = process.cwd(),
  roots = ["packages", "tools"],
} = {}) {
  const findings = [];
  for (const rootPath of roots) {
    const absoluteRoot = resolve(cwd, rootPath);
    for (const filePath of await listSourceFiles(absoluteRoot)) {
      findings.push(
        ...analyzeAwsApiSource({
          path: normalizePath(relative(cwd, filePath)),
          text: await readFile(filePath, "utf8"),
        }),
      );
    }
  }
  return findings.sort(
    (left, right) =>
      compareStable(left.path, right.path) ||
      left.line - right.line ||
      left.column - right.column ||
      compareStable(left.rule, right.rule),
  );
}

async function listSourceFiles(rootPath) {
  const rootStat = await stat(rootPath);
  if (rootStat.isFile()) {
    return sourceExtensions.has(extname(rootPath)) ? [rootPath] : [];
  }

  const files = [];
  const entries = await readdir(rootPath, { withFileTypes: true });
  entries.sort((left, right) => compareStable(left.name, right.name));
  for (const entry of entries) {
    const entryPath = resolve(rootPath, entry.name);
    if (entry.isDirectory()) {
      if (!ignoredDirectories.has(entry.name)) {
        files.push(...(await listSourceFiles(entryPath)));
      }
    } else if (sourceExtensions.has(extname(entry.name))) {
      files.push(entryPath);
    }
  }
  return files;
}

function isAwsSdkModuleSpecifier(node) {
  return Boolean(
    node &&
    (ts.isStringLiteral(node) || ts.isNoSubstitutionTemplateLiteral(node)) &&
    node.text.startsWith("@aws-sdk/"),
  );
}

function unwrapParentheses(node) {
  let current = node;
  while (current && ts.isParenthesizedExpression(current)) {
    current = current.expression;
  }
  return current;
}

function scriptKindFor(path) {
  if (path.endsWith(".tsx")) return ts.ScriptKind.TSX;
  if (path.endsWith(".ts")) return ts.ScriptKind.TS;
  return ts.ScriptKind.JS;
}

function normalizePath(path) {
  return path.replaceAll("\\", "/");
}

function compareStable(left, right) {
  return left < right ? -1 : left > right ? 1 : 0;
}

async function main() {
  const findings = await scanAwsApiUsage();
  if (findings.length > 0) {
    console.error("AWS API allowlist violations found:");
    for (const finding of findings) {
      console.error(
        `- ${finding.path}:${finding.line}:${finding.column} [${finding.rule}] ${finding.message}`,
      );
    }
    process.exitCode = 1;
    return;
  }
  console.log(
    "AWS SDK imports and client.send calls match the read-only allowlist.",
  );
}

const isDirectExecution =
  process.argv[1] !== undefined &&
  pathToFileURL(resolve(process.argv[1])).href === import.meta.url;
if (isDirectExecution) {
  await main();
}
