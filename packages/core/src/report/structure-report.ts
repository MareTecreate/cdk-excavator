import type { CdkImportMapDocument } from "../generate/schemas.js";
import type { NormalizationModelDocument } from "../normalize/schemas.js";
import type { ReportLocale } from "./report-engine.js";
import { inlineCode, inlineText, markdownTable } from "./report-text.js";

export function formatStructureReport(
  locale: ReportLocale,
  model: NormalizationModelDocument,
  review: CdkImportMapDocument,
): string[] {
  const t = locale.t;
  const plan = review.plan;
  const unknown = t("report.structure.unknown");
  const scoped = new Map(model.scope?.resources.map((r) => [r.key, r]) ?? []);
  const resources = new Map(model.resources.map((r) => [r.key, r]));
  const imports = new Map(review.resources.map((r) => [r.resourceKey, r]));
  const labels = new Map(
    plan?.stacks.map((stack, index) => [
      stack.stackName,
      t("report.structure.stackNumber", { number: index + 1 }),
    ]) ?? [],
  );
  const stackByResource = new Map(
    plan?.stacks.flatMap((stack) =>
      stack.resourceKeys.map((key) => [key, stack] as const),
    ) ?? [],
  );
  const resourceLabel = (key: string): string => {
    const resource = resources.get(key);
    return resource
      ? inlineText(
          `${resource.identifier} (${resource.resourceType}, ${resource.region})`,
        )
      : inlineText(key);
  };
  const reason = (code: string): string => {
    const key = `report.reason.${code}`;
    const translated = t(key);
    return inlineText(translated === key ? code : translated);
  };
  const list = (values: string[]) =>
    values.length ? values.map(inlineText).join(", ") : unknown;
  const referenceRows = (plan?.references ?? []).map((reference) => [
    `${resourceLabel(reference.from)}; ${inlineCode(reference.propertyPath || "-")}`,
    reference.to ? resourceLabel(reference.to) : inlineText(reference.value),
    t(`report.disposition.${reference.disposition}`),
    [reference.sourceStack, reference.targetStack]
      .filter((name): name is string => Boolean(name))
      .map((name) => labels.get(name) ?? inlineText(name))
      .join(" -> ") + (reference.reason ? `; ${reason(reference.reason)}` : ""),
  ]);

  // Retain graph-only evidence even when normalization intentionally removed its value.
  for (const edge of model.scope?.graph.edges ?? []) {
    if (
      plan?.references.some(
        (ref) =>
          ref.from === edge.from &&
          ref.to === edge.to &&
          ref.propertyPath === (edge.propertyPath ?? ""),
      )
    )
      continue;
    referenceRows.push([
      `${resourceLabel(edge.from)}; ${inlineCode(edge.propertyPath ?? edge.path ?? "-")}`,
      resourceLabel(edge.to),
      t(
        !edge.value
          ? "report.disposition.excluded-property"
          : "report.disposition.unresolved",
      ),
      t("report.structure.graphOnly"),
    ]);
  }
  for (const boundary of model.externalReferences) {
    if (
      plan?.references.some(
        (ref) =>
          ref.from === boundary.referencedBy && ref.value === boundary.value,
      )
    )
      continue;
    referenceRows.push([
      `${resourceLabel(boundary.referencedBy)}; ${list(boundary.propertyPaths ?? [])}`,
      boundary.targetKey
        ? resourceLabel(boundary.targetKey)
        : inlineText(boundary.value),
      inlineText(boundary.boundaryHandling),
      t("report.structure.boundaryOnly"),
    ]);
  }

  return [
    `### ${t("report.summary.stackStructure")}`,
    "",
    t("report.structure.placementNotice"),
    "",
    ...(plan
      ? plan.stacks.flatMap((stack) => [
          `#### ${labels.get(stack.stackName)}: ${t(`report.kind.${stack.kind}`)}`,
          "",
          `- ${inlineCode(stack.stackName)}`,
          `- ${t("report.structure.environment", { account: stack.account ?? unknown, region: stack.region ?? unknown, count: stack.resourceKeys.length })}`,
          `- ${t("report.structure.placement", { vpc: list(stack.vpcIds), az: list(stack.availabilityZones) })}`,
          ...stack.reviewReasons.map((value) => `- ${reason(value)}`),
          "",
        ])
      : [t("report.structure.noPlan"), ""]),
    `### ${t("report.structure.resources")}`,
    "",
    ...(model.resources.length
      ? markdownTable(
          [
            t("report.column.resource"),
            t("report.column.placement"),
            t("report.column.decision"),
            t("report.column.selection"),
          ],
          [...model.resources]
            .sort((a, b) => a.key.localeCompare(b.key))
            .map((resource) => {
              const evidence = scoped.get(resource.key);
              const stack = stackByResource.get(resource.key);
              const entry = imports.get(resource.key);
              const placement = evidence?.placement;
              return [
                resourceLabel(resource.key),
                placement
                  ? t("report.structure.placement", {
                      vpc: list(placement.vpcIds),
                      az: list(placement.availabilityZones),
                    })
                  : unknown,
                [
                  t(
                    `report.resource.${resource.status === "codeable" && !stack ? "candidate" : resource.status}`,
                  ),
                  stack
                    ? labels.get(stack.stackName)!
                    : t("report.structure.noGeneratedStack"),
                  ...resource.gapCodes,
                  ...(entry ? [t(`report.importStatus.${entry.status}`)] : []),
                ].join("; "),
                evidence?.inclusionReasons
                  .map((entry) =>
                    [
                      t(`report.selection.${entry.type}`),
                      entry.sourceKey
                        ? resourceLabel(entry.sourceKey)
                        : undefined,
                      entry.detail ? inlineText(entry.detail) : undefined,
                    ]
                      .filter(Boolean)
                      .join(": "),
                  )
                  .join("; ") ?? unknown,
              ];
            }),
        )
      : [t("report.none"), ""]),
    `### ${t("report.structure.connections")}`,
    "",
    t("report.structure.connectionNotice"),
    "",
    ...(referenceRows.length
      ? markdownTable(
          [
            t("report.column.source"),
            t("report.column.target"),
            t("report.column.decision"),
            t("report.column.reason"),
          ],
          referenceRows,
        )
      : [t("report.structure.noConnections"), ""]),
    `### ${t("report.structure.evidence")}`,
    "",
    ...(!model.scope
      ? [`- ${t("report.structure.noScope")}`]
      : [
          `- ${t("report.structure.mode", { mode: model.scope.mode, cycles: model.scope.graph.cycles.length })}`,
          ...model.scope.graph.cycles.map(
            (cycle) => `- ${cycle.map(resourceLabel).join(" -> ")}`,
          ),
          ...model.scope.warnings.map(
            (warning) =>
              `- ${inlineCode(warning.code)}: ${inlineText(warning.message)}`,
          ),
        ]),
    ...(plan?.warnings.map((warning) => `- ${reason(warning)}`) ?? []),
    "",
  ];
}
