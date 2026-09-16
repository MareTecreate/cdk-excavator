export type InventoryPropertyValue =
  | null
  | boolean
  | number
  | string
  | readonly InventoryPropertyValue[]
  | { readonly [key: string]: InventoryPropertyValue };

export type InventoryPropertyRecord = Record<string, InventoryPropertyValue>;

export function toInventoryPropertyRecord(
  value: Record<string, unknown>,
  path = "properties",
): InventoryPropertyRecord {
  const result: Record<string, InventoryPropertyValue> = {};

  for (const [key, entry] of Object.entries(value)) {
    if (entry !== undefined) {
      result[key] = toInventoryPropertyValue(entry, `${path}.${key}`);
    }
  }

  return result;
}

function toInventoryPropertyValue(
  value: unknown,
  path: string,
): InventoryPropertyValue {
  if (
    value === null ||
    typeof value === "string" ||
    typeof value === "boolean"
  ) {
    return value;
  }

  if (typeof value === "number") {
    if (!Number.isFinite(value)) {
      throw new Error(
        `Inventory property contains a non-finite number at ${path}`,
      );
    }

    return value;
  }

  if (value instanceof Date) {
    if (Number.isNaN(value.getTime())) {
      throw new Error(`Inventory property contains an invalid date at ${path}`);
    }

    return value.toISOString();
  }

  if (Array.isArray(value)) {
    return value.map((entry, index) =>
      toInventoryPropertyValue(entry, `${path}[${index}]`),
    );
  }

  if (isPlainObject(value)) {
    return toInventoryPropertyRecord(value, path);
  }

  throw new Error(`Inventory property is not JSON-compatible at ${path}`);
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  if (!value || typeof value !== "object") {
    return false;
  }

  const prototype = Object.getPrototypeOf(value) as unknown;
  return prototype === Object.prototype || prototype === null;
}
