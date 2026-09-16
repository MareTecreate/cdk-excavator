import { createTranslator } from "@cdk-excavator/i18n";

// Persisted diagnostics use a stable language; renderers can localize messageKey.
export const coreMessages = createTranslator("en");
