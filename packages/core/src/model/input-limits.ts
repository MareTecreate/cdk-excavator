import { coreMessages } from "../messages.js";

export const JSON_INPUT_LIMITS = Object.freeze({
  bytes: 32 * 1024 * 1024,
  nodes: 1_000_000,
  collection: 50_000,
  depth: 64,
});

export type JsonInputLimit = keyof typeof JSON_INPUT_LIMITS;

export class JsonInputSyntaxError extends Error {
  constructor() {
    super(coreMessages.t("core.input.invalidJson"));
    this.name = "JsonInputSyntaxError";
  }
}

export class JsonInputLimitError extends Error {
  constructor(readonly limit: JsonInputLimit) {
    super(
      coreMessages.t(`core.input.limit.${limit}`, {
        limit: JSON_INPUT_LIMITS[limit],
      }),
    );
    this.name = "JsonInputLimitError";
  }
}

// A directory shares this budget across files; no file can reset the aggregate.
export class JsonInputBudget {
  private bytes = 0;
  private nodes = 0;

  addBytes(count: number): void {
    this.bytes += count;
    if (this.bytes > JSON_INPUT_LIMITS.bytes)
      throw new JsonInputLimitError("bytes");
  }

  check(value: unknown): void {
    const ancestors = new Set<object>();
    const pending: { value: unknown; depth: number; leave?: boolean }[] = [
      { value, depth: 0 },
    ];
    let stringBytes = 0;
    while (pending.length) {
      const item = pending.pop()!;
      if (item.leave) {
        ancestors.delete(item.value as object);
        continue;
      }
      if (++this.nodes > JSON_INPUT_LIMITS.nodes)
        throw new JsonInputLimitError("nodes");
      if (item.depth > JSON_INPUT_LIMITS.depth)
        throw new JsonInputLimitError("depth");
      if (typeof item.value === "string")
        stringBytes += Buffer.byteLength(item.value);
      if (item.value && typeof item.value === "object") {
        if (ancestors.has(item.value)) throw new JsonInputLimitError("depth");
        if (
          Array.isArray(item.value) &&
          item.value.length > JSON_INPUT_LIMITS.collection
        ) {
          throw new JsonInputLimitError("collection");
        }
        const keys = Object.keys(item.value);
        if (keys.length > JSON_INPUT_LIMITS.collection) {
          throw new JsonInputLimitError("collection");
        }
        if (this.nodes + keys.length > JSON_INPUT_LIMITS.nodes)
          throw new JsonInputLimitError("nodes");
        ancestors.add(item.value);
        pending.push({ ...item, leave: true });
        for (const key of keys) {
          stringBytes += Buffer.byteLength(key);
          pending.push({
            value: (item.value as Record<string, unknown>)[key],
            depth: item.depth + 1,
          });
        }
      }
      if (stringBytes > JSON_INPUT_LIMITS.bytes)
        throw new JsonInputLimitError("bytes");
    }
  }
}

export function parseJsonInput(
  text: string,
  budget = new JsonInputBudget(),
): unknown {
  budget.addBytes(Buffer.byteLength(text));
  let value: unknown;
  try {
    value = JSON.parse(text);
  } catch {
    throw new JsonInputSyntaxError();
  }
  budget.check(value);
  return value;
}
