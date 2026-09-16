import jmespath from "jmespath";

export type QueryFormat = "json" | "text" | "table";

export function prepareQuery(argv: readonly string[]) {
  const args: string[] = [];
  let expression: string | undefined;
  let format: QueryFormat = "text";
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index]!;
    if (arg === "--query" || arg.startsWith("--query=")) {
      if (expression !== undefined) throw new Error("duplicate-query");
      expression = arg === "--query" ? argv[++index] : arg.slice(8);
      if (!expression) throw new Error("missing-query");
    } else if (arg === "--format" || arg.startsWith("--format=")) {
      const value = arg === "--format" ? argv[++index] : arg.slice(9);
      if (value !== "json" && value !== "text" && value !== "table") {
        throw new Error("invalid-format");
      }
      format = value;
    } else {
      args.push(arg);
    }
  }
  if (expression === undefined) throw new Error("missing-query");
  // Compile before dispatch so a syntax error cannot trigger acquisition or writes.
  jmespath.compile(expression);
  return { args: [...args, "--format", "json"], expression, format };
}

export function querySummary(summary: string, expression: string): unknown {
  return jmespath.search(JSON.parse(summary) as unknown, expression) as unknown;
}

export function queryRows(value: unknown): string[][] {
  if (Array.isArray(value)) {
    return value.flatMap((entry) => queryRows(entry));
  }
  if (value !== null && typeof value === "object") {
    return Object.keys(value)
      .sort()
      .map((key) => [key, queryCell((value as Record<string, unknown>)[key])]);
  }
  return [[queryCell(value)]];
}

function queryCell(value: unknown): string {
  // Keep control characters escaped in tabular output.
  return typeof value === "string"
    ? value
        .replace(/[\t\r\n]/g, (char) => JSON.stringify(char).slice(1, -1))
        .replaceAll("\u001b", "\\u001b")
    : JSON.stringify(value ?? null);
}
