export const inlineBacktickMarker = "\ufdd0";
export const inlineBackslashMarker = "\ufdd1";

export function inlineText(value: string): string {
  return [...value.replaceAll("\u0000", " / ")]
    .map((character) => {
      const code = character.charCodeAt(0);
      return code < 32 || code === 127 ? " " : character;
    })
    .join("")
    .replace(/\s+/g, " ")
    .trim()
    .replaceAll(inlineBacktickMarker, "\ufffd")
    .replaceAll(inlineBackslashMarker, "\ufffd")
    .replaceAll("\\", "\\\\")
    .replaceAll("`", "\\`");
}

export function inlineCode(value: string): string {
  return `\`${inlineText(value)}\``;
}

export function markdownTable(headers: string[], rows: string[][]): string[] {
  const row = (cells: string[]) =>
    `| ${cells.map((cell) => cell.replaceAll("|", "\\|")).join(" | ")} |`;
  return [row(headers), row(headers.map(() => "---")), ...rows.map(row), ""];
}
