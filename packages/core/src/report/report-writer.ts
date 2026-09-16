import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";

import { formatGapDocument } from "../normalize/normalize-writer.js";
import type { ReportArtifacts } from "./report-engine.js";

export interface WriteReportArtifactsInput {
  readonly artifacts: ReportArtifacts;
  readonly outputDirectory: string;
}

export async function writeReportArtifacts(
  input: WriteReportArtifactsInput,
): Promise<void> {
  await mkdir(input.outputDirectory, { recursive: true });

  const writes = Object.entries(input.artifacts.markdown).map(
    ([language, contents]) =>
      writeFile(
        join(input.outputDirectory, `REPORT.${language}.md`),
        contents,
        "utf8",
      ),
  );

  writes.push(
    writeFile(
      join(input.outputDirectory, "report.html"),
      input.artifacts.html,
      "utf8",
    ),
    writeFile(
      join(input.outputDirectory, "gaps.json"),
      formatGapDocument(input.artifacts.gaps),
      "utf8",
    ),
  );

  await Promise.all(writes);
}
