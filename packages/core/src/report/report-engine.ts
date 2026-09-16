import {
  CdkImportMapDocumentSchema,
  type CdkImportMapDocument,
} from "../generate/schemas.js";
import {
  GapDocumentSchema,
  NormalizationModelDocumentSchema,
  type GapCode,
  type GapDocument,
  type GapFinding,
  type NormalizationModelDocument,
} from "../normalize/schemas.js";
import { formatStructureReport } from "./structure-report.js";
import {
  inlineText,
  inlineCode,
  inlineBacktickMarker,
  inlineBackslashMarker,
} from "./report-text.js";

export type ReportLanguage = "en" | "ja";
export type ReportMessageValues = Readonly<
  Record<string, boolean | number | string>
>;

export interface ReportLocale {
  readonly language: ReportLanguage;
  readonly t: (key: string, values?: ReportMessageValues) => string;
}

export interface ReportArtifacts {
  readonly gaps: GapDocument;
  readonly html: string;
  readonly markdown: Readonly<Partial<Record<ReportLanguage, string>>>;
}

export interface CreateReportArtifactsInput {
  readonly gaps: GapDocument;
  readonly importReview: CdkImportMapDocument;
  readonly locales: readonly ReportLocale[];
  readonly model: NormalizationModelDocument;
}

interface ReportData {
  readonly codeableResources: number;
  readonly excludedResources: number;
  readonly gapGroups: readonly {
    readonly code: GapCode;
    readonly findings: readonly GapFinding[];
  }[];
  readonly importCounts: Readonly<
    Record<"blocked" | "needs-review" | "ready", number>
  >;
  readonly manualResources: number;
  readonly services: readonly {
    readonly count: number;
    readonly name: string;
  }[];
}

export function createReportArtifacts(
  input: CreateReportArtifactsInput,
): ReportArtifacts {
  const model = NormalizationModelDocumentSchema.parse(input.model);
  const gaps = GapDocumentSchema.parse(input.gaps);
  const importReview = CdkImportMapDocumentSchema.parse(input.importReview);
  const locales = uniqueLocales(input.locales);

  if (locales.length === 0) {
    throw new Error("At least one report locale is required.");
  }

  const data = createReportData(model, gaps, importReview);
  const markdown = Object.fromEntries(
    locales.map((locale) => [
      locale.language,
      formatMarkdownReport(locale, model, gaps, importReview, data),
    ]),
  ) as Partial<Record<ReportLanguage, string>>;

  return {
    gaps,
    html: formatHtmlReport(locales, markdown),
    markdown,
  };
}

function createReportData(
  model: NormalizationModelDocument,
  gaps: GapDocument,
  importReview: CdkImportMapDocument,
): ReportData {
  const statusCounts = countBy(model.resources, (resource) => resource.status);
  const importCounts = countBy(
    importReview.resources,
    (resource) => resource.status,
  );
  const services = [
    ...countBy(model.resources, (resource) =>
      serviceName(resource.resourceType),
    ).entries(),
  ]
    .map(([name, count]) => ({ count, name }))
    .sort((left, right) => left.name.localeCompare(right.name));
  const gapsByCode = countByValues(gaps.gaps, (finding) => finding.code);
  const gapGroups = [...gapsByCode.entries()]
    .map(([code, findings]) => ({
      code,
      findings: [...findings].sort(compareFindings),
    }))
    .sort((left, right) => left.code.localeCompare(right.code));

  return {
    codeableResources: statusCounts.get("codeable") ?? 0,
    excludedResources: statusCounts.get("excluded") ?? 0,
    gapGroups,
    importCounts: {
      blocked: importCounts.get("blocked") ?? 0,
      "needs-review": importCounts.get("needs-review") ?? 0,
      ready: importCounts.get("ready") ?? 0,
    },
    manualResources: statusCounts.get("manual") ?? 0,
    services,
  };
}

function formatMarkdownReport(
  locale: ReportLocale,
  model: NormalizationModelDocument,
  gaps: GapDocument,
  importReview: CdkImportMapDocument,
  data: ReportData,
): string {
  const t = locale.t;
  const lines = [
    `# ${t("report.title")}`,
    "",
    `> ${t("report.reviewNotice")}`,
    "",
    `## ${t("report.summary.title")}`,
    "",
    `- ${t((importReview.plan?.stacks.length ?? 0) > 1 ? "report.summary.project" : "report.summary.stack", { stack: inlineText(importReview.stackName) })}`,
    `- ${t("report.summary.resources", {
      codeable: data.codeableResources,
      excluded: data.excludedResources,
      manual: data.manualResources,
      total: model.resources.length,
    })}`,
    `- ${t("report.summary.gaps", { total: gaps.gaps.length })}`,
    `- ${t("report.summary.resourceCoverage", {
      codeable: model.coverage.resources.codeable,
      percent: percentage(model.coverage.resources.score),
      total: model.coverage.resources.total,
    })}`,
    `- ${t("report.summary.propertyCoverage", {
      codeable: model.coverage.properties.codeable,
      percent: percentage(model.coverage.properties.score),
      total: model.coverage.properties.total,
    })}`,
    "",
    `> ${t("report.structure.coverageNotice")}`,
    "",
    `### ${t("report.summary.services")}`,
    "",
    ...(data.services.length > 0
      ? data.services.map(
          (service) => `- ${t("report.summary.service", service)}`,
        )
      : [`- ${t("report.none")}`]),
    "",
    ...formatStructureReport(locale, model, importReview),
    `## ${t("report.gaps.title")}`,
    "",
    ...(data.gapGroups.length > 0
      ? data.gapGroups.flatMap((group) =>
          formatGapGroup(locale, group.code, group.findings),
        )
      : [`- ${t("report.gaps.none")}`, ""]),
    `## ${t("report.import.title")}`,
    "",
    `- ${t((importReview.plan?.stacks.length ?? 0) > 1 ? "report.summary.project" : "report.import.stack", { stack: inlineText(importReview.stackName) })}`,
    `- ${t("report.import.status", {
      blocked: data.importCounts.blocked,
      needsReview: data.importCounts["needs-review"],
      ready: data.importCounts.ready,
      total: importReview.resources.length,
    })}`,
    `- ${t("report.import.boundaries", {
      count: importReview.externalReferences.length,
    })}`,
    "",
    `### ${t("report.import.safetyTitle")}`,
    "",
    `1. ${t("report.import.step.review")}`,
    `2. ${t("report.import.step.diff")}`,
    `3. ${t("report.import.step.retain")}`,
    `4. ${t("report.import.step.execute")}`,
    "",
    t("report.import.commands"),
    "",
    `## ${t("report.masking.title")}`,
    "",
    `- ${t("report.masking.account")}`,
    `- ${t("report.masking.identifiers")}`,
    `- ${t("report.masking.properties")}`,
    `- ${t("report.masking.files")}`,
    "",
    `## ${t("report.references.title")}`,
    "",
    `- ${t("report.references.todo")}`,
    `- ${t("report.references.gapsJson")}`,
    `- ${t("report.references.importReview")}`,
    "",
  ];

  return `${lines.join("\n").trimEnd()}\n`;
}

function formatGapGroup(
  locale: ReportLocale,
  code: GapCode,
  findings: readonly GapFinding[],
): string[] {
  const t = locale.t;
  return [
    `### ${code}: ${t(`report.gap.name.${code}`)}`,
    "",
    `- ${t("report.gap.count", { count: findings.length })}`,
    `- ${t("report.gap.nextAction", {
      action: t(`report.gap.action.${code}`),
    })}`,
    `- ${t("report.gap.codeReference", { code })}`,
    "",
    ...findings.flatMap((finding) => [
      `#### ${inlineCode(finding.identifier)}`,
      "",
      `- ${t("report.gap.what", {
        property: inlineText(finding.propertyPath ?? "-"),
        region: inlineText(finding.region),
        resourceType: inlineText(finding.resourceType),
      })}`,
      `- ${t("report.gap.why", { reason: inlineText(finding.messageKey && locale.t(finding.messageKey) !== finding.messageKey ? locale.t(finding.messageKey) : finding.message) })}`,
      `- ${t("report.gap.severity", { severity: finding.severity })}`,
      `- ${t("report.gap.resourceKey", {
        resourceKey: inlineText(finding.resourceKey),
      })}`,
      "",
    ]),
  ];
}

function formatHtmlReport(
  locales: readonly ReportLocale[],
  markdown: Readonly<Partial<Record<ReportLanguage, string>>>,
): string {
  const title = locales.map((locale) => locale.t("report.title")).join(" / ");
  const articles = locales
    .map((locale) => {
      const content = markdown[locale.language];
      if (!content) {
        throw new Error(`Missing markdown report: ${locale.language}`);
      }

      return `<article lang="${locale.language}">${markdownToHtml(content)}</article>`;
    })
    .join("\n");

  return `<!doctype html>
<html lang="${locales[0]?.language ?? "en"}">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src 'unsafe-inline'">
  <title>${escapeHtml(title)}</title>
  <style>
    :root { color-scheme: light dark; font-family: system-ui, sans-serif; line-height: 1.55; }
    body { margin: 0; background: #f4f6f8; color: #17202a; }
    main { max-width: 1040px; margin: 0 auto; padding: 32px 20px 64px; }
    article { padding: 0 0 32px; margin-bottom: 32px; border-bottom: 1px solid #d7dde3; overflow-wrap: anywhere; }
    h1, h2, h3, h4 { color: #102a43; letter-spacing: 0; text-wrap: balance; word-break: keep-all; }
    h2 { border-bottom: 1px solid #d7dde3; padding-bottom: 6px; margin-top: 32px; }
    code, pre { font-family: ui-monospace, SFMono-Regular, Consolas, monospace; }
    code { background: #eef2f5; border-radius: 3px; padding: 1px 4px; overflow-wrap: anywhere; }
    pre { background: #101820; color: #f5f7fa; padding: 14px; overflow-x: auto; border-radius: 4px; }
    pre code { background: transparent; color: inherit; padding: 0; overflow-wrap: normal; }
    blockquote { border-left: 4px solid #c2410c; margin: 12px 0; padding: 8px 16px; background: #fff7ed; text-wrap: pretty; }
    h1 { font-size: 24px; } h2 { font-size: 21px; } h3 { font-size: 18px; } h4 { font-size: 16px; }
    .table-scroll { max-width: 100%; overflow-x: auto; margin: 16px 0; }
    table { border-collapse: collapse; width: 100%; min-width: 720px; table-layout: fixed; font-size: 14px; background: #fff; }
    th, td { text-align: left; vertical-align: top; padding: 10px; border: 1px solid #d7dde3; overflow-wrap: anywhere; }
    th { background: #e7ede9; }
    @media (max-width: 600px) { main { padding: 20px 12px 40px; } ul { padding-left: 22px; } }
    @media (prefers-color-scheme: dark) {
      body { background: #111820; color: #e6edf3; }
      article { border-color: #3c4856; }
      table { background: #18212b; } th { background: #273b32; } th, td { border-color: #3c4856; }
      h1, h2, h3, h4 { color: #f2f6fa; }
      code { background: #2b3642; }
      blockquote { background: #39291f; }
    }
  </style>
</head>
<body>
<main>
${articles}
</main>
</body>
</html>
`;
}

function markdownToHtml(markdown: string): string {
  const output: string[] = [];
  let inCode = false;
  let inList = false;
  let inTable = false;

  const closeList = () => {
    if (inList) {
      output.push("</ul>");
      inList = false;
    }
  };

  for (const line of markdown.trimEnd().split("\n")) {
    if (!inCode && line.startsWith("| ") && line.endsWith(" |")) {
      closeList();
      const cells = line
        .slice(2, -2)
        .split(/(?<!\\)\|/)
        .map((cell) => cell.trim().replaceAll("\\|", "|"));
      if (cells.every((cell) => cell === "---")) continue;
      if (!inTable) {
        output.push(
          `<div class="table-scroll" tabindex="0" role="region" aria-label="${escapeHtml(cells.join(" / "))}"><table><thead><tr>${cells.map((cell) => `<th scope="col">${formatInline(cell)}</th>`).join("")}</tr></thead><tbody>`,
        );
        inTable = true;
      } else {
        output.push(
          `<tr>${cells.map((cell) => `<td>${formatInline(cell)}</td>`).join("")}</tr>`,
        );
      }
      continue;
    }
    if (inTable) {
      output.push("</tbody></table></div>");
      inTable = false;
    }
    if (line === "```bash") {
      closeList();
      output.push("<pre><code>");
      inCode = true;
      continue;
    }

    if (line === "```" && inCode) {
      output.push("</code></pre>");
      inCode = false;
      continue;
    }

    if (inCode) {
      output.push(`${escapeHtml(line)}\n`);
      continue;
    }

    if (line.startsWith("- ")) {
      if (!inList) {
        output.push("<ul>");
        inList = true;
      }
      output.push(`<li>${formatInline(line.slice(2))}</li>`);
      continue;
    }

    closeList();

    if (!line) {
      continue;
    }

    const heading = /^(#{1,4}) (.+)$/.exec(line);
    if (heading) {
      const level = heading[1]?.length ?? 1;
      output.push(`<h${level}>${formatInline(heading[2] ?? "")}</h${level}>`);
      continue;
    }

    if (line.startsWith("> ")) {
      output.push(`<blockquote>${formatInline(line.slice(2))}</blockquote>`);
      continue;
    }

    if (/^\d+\. /.test(line)) {
      output.push(`<p>${formatInline(line)}</p>`);
      continue;
    }

    output.push(`<p>${formatInline(line)}</p>`);
  }

  closeList();
  if (inTable) output.push("</tbody></table></div>");
  return output.join("\n");
}

function formatInline(value: string): string {
  const protectedValue = value
    .replaceAll("\\\\", inlineBackslashMarker)
    .replaceAll("\\`", inlineBacktickMarker);

  return escapeHtml(protectedValue)
    .replace(/`([^`]+)`/g, "<code>$1</code>")
    .replaceAll(inlineBacktickMarker, "&#96;")
    .replaceAll(inlineBackslashMarker, "\\");
}

function escapeHtml(value: string): string {
  return value
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#39;");
}

function serviceName(resourceType: string): string {
  return resourceType.split("::")[1] ?? resourceType;
}

function percentage(score: number): string {
  return `${(score * 100).toFixed(2)}%`;
}

function compareFindings(left: GapFinding, right: GapFinding): number {
  return (
    left.resourceType.localeCompare(right.resourceType) ||
    left.identifier.localeCompare(right.identifier) ||
    (left.propertyPath ?? "").localeCompare(right.propertyPath ?? "") ||
    left.message.localeCompare(right.message)
  );
}

function uniqueLocales(locales: readonly ReportLocale[]): ReportLocale[] {
  const found = new Map<ReportLanguage, ReportLocale>();
  for (const locale of locales) {
    if (!found.has(locale.language)) {
      found.set(locale.language, locale);
    }
  }
  return [...found.values()];
}

function countBy<T>(
  values: readonly T[],
  keyOf: (value: T) => string,
): Map<string, number> {
  const counts = new Map<string, number>();
  for (const value of values) {
    const key = keyOf(value);
    counts.set(key, (counts.get(key) ?? 0) + 1);
  }
  return counts;
}

function countByValues<T, K extends string>(
  values: readonly T[],
  keyOf: (value: T) => K,
): Map<K, T[]> {
  const groups = new Map<K, T[]>();
  for (const value of values) {
    const key = keyOf(value);
    const group = groups.get(key) ?? [];
    group.push(value);
    groups.set(key, group);
  }
  return groups;
}
