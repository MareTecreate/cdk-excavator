import { coreMessages } from "../messages.js";
import type {
  GenerationDocuments,
  GeneratedStackDocuments,
} from "./generate-engine.js";
import {
  formatCdkImportMap,
  formatCdkImportReview,
  formatGeneratedCfnTemplate,
  formatImportGuide,
} from "./generate-writer.js";
import { environmentSource } from "./project-references.js";
import { formatConverterFallbackReport } from "./converter-fallback.js";
import type {
  TypeScriptCdkProject,
  GeneratedProjectFile,
} from "./typescript-project.js";

export function stackArtifactFiles(
  documents: GenerationDocuments,
): GeneratedProjectFile[] {
  const plan = documents.importMap.plan;
  if (!plan) return [];
  const files: GeneratedProjectFile[] = [
    { path: "stack-plan.json", contents: `${JSON.stringify(plan, null, 2)}\n` },
  ];
  if ((documents.stacks?.length ?? 0) > 1)
    for (const stack of documents.stacks!) {
      const prefix = `stacks/${stack.stack.fileBase}`;
      files.push(
        {
          path: `${prefix}/template.json`,
          contents: formatGeneratedCfnTemplate(stack.template),
        },
        {
          path: `${prefix}/cdk-import-map.json`,
          contents: formatCdkImportMap(stack.resourceMapping),
        },
        {
          path: `${prefix}/cdk-import-review.json`,
          contents: formatCdkImportReview(stack.importMap),
        },
        {
          path: `${prefix}/IMPORT.md`,
          contents: formatImportGuide(stack.importMap),
        },
      );
    }
  return files;
}

export function combineStackProjects(
  documents: GenerationDocuments,
  language: "typescript" | "python",
  create: (documents: GeneratedStackDocuments) => TypeScriptCdkProject,
): TypeScriptCdkProject {
  const python = language === "python";
  const projects = documents.stacks!.map((stack) => ({
    stack,
    project: create(stack),
  }));
  const first = projects[0]!.project;
  const files = new Map<string, GeneratedProjectFile>();
  const sourceRoot = python ? "cdkx_generated/" : "lib/";
  const appFile = python ? "app.py" : "bin/cdk-excavator.ts";
  for (const { stack, project } of projects) {
    const name = python
      ? stack.stack.fileBase.replaceAll("-", "_")
      : stack.stack.fileBase;
    for (const file of project.files) {
      if (file.path.startsWith(sourceRoot)) {
        const path = `${sourceRoot}stacks/${name}/${file.path.slice(sourceRoot.length)}`;
        files.set(path, { ...file, path });
      } else if (
        ![
          appFile,
          "stack-plan.json",
          "converter-fallbacks.json",
          "l2-lift-report.json",
        ].includes(file.path) &&
        !files.has(file.path)
      )
        files.set(file.path, file);
    }
  }
  if (python)
    for (const path of [
      "cdkx_generated/__init__.py",
      "cdkx_generated/stacks/__init__.py",
    ])
      files.set(path, { path, contents: "" });
  const app = [
    python ? "import aws_cdk as cdk" : "import * as cdk from 'aws-cdk-lib';",
  ];
  projects.forEach(({ stack, project }) => {
    const name = python
      ? stack.stack.fileBase.replaceAll("-", "_")
      : stack.stack.fileBase;
    const module = project.stackFile
      .slice(sourceRoot.length)
      .replace(/\.(?:ts|py)$/, "");
    app.push(
      python
        ? `from cdkx_generated.stacks.${name}.${module} import ${project.stackClassName}`
        : `import { ${project.stackClassName} } from '../lib/stacks/${name}/${module}';`,
    );
  });
  app.push(
    "",
    python
      ? "app = cdk.App(analytics_reporting=False)"
      : "const app = new cdk.App();",
  );
  projects.forEach(({ stack, project }, index) => {
    app.push(
      python
        ? `stack${index} = ${project.stackClassName}(app, ${JSON.stringify(stack.stack.stackName)}, synthesizer=cdk.BootstraplessSynthesizer(), ${environmentSource(stack.stack, language)})`
        : `const stack${index} = new ${project.stackClassName}(app, ${JSON.stringify(stack.stack.stackName)}, { synthesizer: new cdk.BootstraplessSynthesizer(), ${environmentSource(stack.stack, language)} });`,
    );
  });
  const indices = new Map(
    projects.map(({ stack }, index) => [stack.stack.stackName, index]),
  );
  const dependencies = new Set<string>();
  for (const reference of documents.importMap.plan?.references ?? [])
    if (reference.disposition === "cross-stack-token")
      dependencies.add(
        python
          ? `stack${indices.get(reference.sourceStack)}.add_dependency(stack${indices.get(reference.targetStack!)})`
          : `stack${indices.get(reference.sourceStack)}.addDependency(stack${indices.get(reference.targetStack!)});`,
      );
  app.push(...[...dependencies].sort(), ...(python ? ["app.synth()"] : []), "");
  files.set(appFile, { path: appFile, contents: app.join("\n") });
  for (const file of stackArtifactFiles(documents)) files.set(file.path, file);
  const converterFallbacks = projects.flatMap(
    ({ project }) => project.converterFallbacks,
  );
  if (converterFallbacks.length)
    files.set("converter-fallbacks.json", {
      path: "converter-fallbacks.json",
      contents: formatConverterFallbackReport(converterFallbacks),
    });
  const liftReports = projects.flatMap(({ project }) =>
    project.files
      .filter((file) => file.path === "l2-lift-report.json")
      .map(
        (file) =>
          JSON.parse(file.contents) as {
            entries: unknown[];
            mode: string;
            resourceTypes: string[];
          },
      ),
  );
  if (liftReports.length)
    files.set("l2-lift-report.json", {
      path: "l2-lift-report.json",
      contents: `${JSON.stringify({ ...liftReports[0], entries: liftReports.flatMap((report) => report.entries) }, null, 2)}\n`,
    });
  files.set("README.md", {
    path: "README.md",
    contents: [
      `# ${documents.importMap.stackName}`,
      "",
      coreMessages.t("core.generate.multiReadme"),
      "",
      ...(python ? [coreMessages.t("core.generate.pythonSetup"), ""] : []),
      "```bash",
      "npm ci",
      ...(python
        ? [
            "python -m pip install -r requirements.txt",
            "python -m compileall -q app.py cdkx_generated",
          ]
        : ["npm run build"]),
      "npx cdk synth --no-lookups",
      "```",
      "",
    ].join("\n"),
  });
  return {
    ...first,
    converterFallbacks,
    files: [...files.values()].sort((a, b) => a.path.localeCompare(b.path)),
    stackFile: appFile,
  };
}
