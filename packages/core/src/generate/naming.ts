export function toPascalIdentifier(value: string): string {
  const candidate = value
    .split(/[^A-Za-z0-9]+/)
    .filter(Boolean)
    .map((part) => `${part.charAt(0).toUpperCase()}${part.slice(1)}`)
    .join("");
  const normalized = candidate.replace(/^[^A-Za-z]+/, "");

  return normalized || "Resource";
}

export function toKebabIdentifier(value: string): string {
  return value
    .replace(/([a-z0-9])([A-Z])/g, "$1-$2")
    .replace(/[^A-Za-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .toLowerCase();
}

export function toCamelIdentifier(value: string): string {
  const pascal = toPascalIdentifier(value);
  return `${pascal.charAt(0).toLowerCase()}${pascal.slice(1)}`;
}

export function resourceGroupName(resourceType: string): string {
  const service = resourceType.split("::")[1] ?? "Resource";
  return `${toPascalIdentifier(service)}Resources`;
}

export function stackClassIdentifier(value: string): string {
  const candidate = toPascalIdentifier(value);
  return candidate === "Construct" || candidate.endsWith("Resources")
    ? `${candidate}Stack`
    : candidate;
}
