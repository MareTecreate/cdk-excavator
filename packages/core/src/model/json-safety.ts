import { coreMessages } from "../messages.js";

export function assertCdkJsonRepresentable(value: unknown): void {
  if (!value || typeof value !== "object") return;
  if (Object.hasOwn(value, "__proto__"))
    throw new Error(coreMessages.t("core.generate.jsonKey"));
  for (const entry of Object.values(value)) assertCdkJsonRepresentable(entry);
}
