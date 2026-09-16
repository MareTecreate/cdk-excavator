export type ExtractedReferenceType = "arn" | "id";

export interface ExtractedReference {
  readonly path: string;
  readonly type: ExtractedReferenceType;
  readonly value: string;
}

const ARN_PATTERN = /\barn:aws[a-zA-Z-]*:[^\s"'`]+/g;
const AWS_ID_PATTERN = /^(?:vpc|subnet|sg|rtb|nat|vpce|igw)-[0-9a-fA-F]+$/;

export function extractReferences(
  value: unknown,
): readonly ExtractedReference[] {
  const references: ExtractedReference[] = [];
  collectReferences(value, "$", references);

  return references.sort((left, right) =>
    referenceKey(left).localeCompare(referenceKey(right)),
  );
}

function collectReferences(
  value: unknown,
  path: string,
  references: ExtractedReference[],
): void {
  if (typeof value === "string") {
    references.push(...extractStringReferences(value, path));
    return;
  }

  if (Array.isArray(value)) {
    value.forEach((item, index) => {
      collectReferences(item, `${path}[${index}]`, references);
    });
    return;
  }

  if (isPlainObject(value)) {
    for (const key of Object.keys(value).sort()) {
      collectReferences(value[key], `${path}.${key}`, references);
    }
  }
}

function extractStringReferences(
  value: string,
  path: string,
): readonly ExtractedReference[] {
  const references: ExtractedReference[] = [];

  for (const match of value.matchAll(ARN_PATTERN)) {
    references.push({
      path,
      type: "arn",
      value: trimTrailingPunctuation(match[0]),
    });
  }

  if (AWS_ID_PATTERN.test(value)) {
    references.push({
      path,
      type: "id",
      value,
    });
  }

  return references;
}

function trimTrailingPunctuation(value: string): string {
  let end = value.length;
  while (end > 0 && "),.;".includes(value.charAt(end - 1))) {
    end -= 1;
  }
  return value.slice(0, end);
}

function referenceKey(reference: ExtractedReference): string {
  return [reference.path, reference.type, reference.value].join("\u0000");
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return false;
  }

  const prototype = Object.getPrototypeOf(value) as unknown;
  return prototype === Object.prototype || prototype === null;
}
