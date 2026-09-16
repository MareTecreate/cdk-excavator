import { GapRuleSetSchema, type GapRuleSet } from "./schemas.js";

export function mergeLocalGapRules(
  base: GapRuleSet,
  local: unknown,
): GapRuleSet {
  const overrides = GapRuleSetSchema.parse(local);
  const parsedBase = GapRuleSetSchema.parse(base);
  return GapRuleSetSchema.parse({
    version: parsedBase.version,
    propertyRules: mergeRules(
      parsedBase.propertyRules,
      overrides.propertyRules,
      (rule) =>
        JSON.stringify([rule.resourceType, rule.code, rule.propertyPath]),
    ),
    resourceRules: mergeRules(
      parsedBase.resourceRules,
      overrides.resourceRules,
      (rule) =>
        JSON.stringify([
          rule.resourceType,
          rule.code,
          rule.regionsIn ? [...new Set(rule.regionsIn)].sort() : null,
          rule.regionsNotIn ? [...new Set(rule.regionsNotIn)].sort() : null,
        ]),
    ),
  });
}

function mergeRules<T>(
  base: readonly T[],
  local: readonly T[],
  keyOf: (rule: T) => string,
): T[] {
  const rules = new Map(base.map((rule) => [keyOf(rule), rule]));
  const localKeys = new Set<string>();
  for (const rule of local) {
    const key = keyOf(rule);
    if (localKeys.has(key)) throw new Error("Duplicate local gap rule key.");
    localKeys.add(key);
    rules.set(key, rule);
  }
  return [...rules.entries()]
    .sort(([left], [right]) => (left < right ? -1 : left > right ? 1 : 0))
    .map(([, rule]) => rule);
}
