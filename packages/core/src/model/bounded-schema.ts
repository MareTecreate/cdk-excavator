import { z } from "zod";

import {
  JSON_INPUT_LIMITS,
  JsonInputBudget,
  JsonInputLimitError,
} from "./input-limits.js";

export function boundedArray<T extends z.ZodType>(element: T, minimum = 0) {
  return z
    .array(z.unknown())
    .min(minimum)
    .max(JSON_INPUT_LIMITS.collection)
    .transform((values, context) => {
      const output: z.output<T>[] = [];
      for (let index = 0; index < values.length; index++) {
        const parsed = element.safeParse(values[index]);
        if (!parsed.success) {
          // Stop at the first invalid member, including inside the size budget.
          for (const issue of parsed.error.issues.slice(0, 8)) {
            context.addIssue({ ...issue, path: [index, ...issue.path] });
          }
          return z.NEVER;
        }
        output.push(parsed.data);
      }
      return output;
    });
}

export function boundedRecord<T extends z.ZodType>(
  key: z.ZodString,
  element: T,
) {
  return z.record(key, z.unknown()).transform((values, context) => {
    const entries: [string, z.output<T>][] = [];
    for (const name of Object.keys(values)) {
      const parsed = element.safeParse(values[name]);
      if (!parsed.success) {
        for (const issue of parsed.error.issues.slice(0, 8)) {
          context.addIssue({ ...issue, path: [name, ...issue.path] });
        }
        return z.NEVER;
      }
      entries.push([name, parsed.data]);
    }
    return Object.fromEntries(entries);
  });
}

export function boundedJson<T extends z.ZodType>(schema: T) {
  return z.preprocess((value, context) => {
    try {
      new JsonInputBudget().check(value);
      return value;
    } catch (error) {
      if (!(error instanceof JsonInputLimitError)) throw error;
      context.addIssue({ code: "custom", message: error.message, fatal: true });
      return z.NEVER;
    }
  }, schema);
}
