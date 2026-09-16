import enMessages from "./messages/en.json" with { type: "json" };
import jaMessages from "./messages/ja.json" with { type: "json" };

export type SupportedLanguage = "en" | "ja";
export type MessageCatalog = Record<string, string>;
export type MessageValues = Record<string, string | number | boolean>;

const supportedLanguages = new Set<SupportedLanguage>(["en", "ja"]);
const catalogs: Readonly<Record<SupportedLanguage, MessageCatalog>> = {
  en: enMessages,
  ja: jaMessages,
};

export function resolveLanguage(requested?: string): SupportedLanguage {
  const candidates = [
    requested,
    process.env["CDKX_LANG"],
    Intl.DateTimeFormat().resolvedOptions().locale,
  ];

  for (const candidate of candidates) {
    const normalized = normalizeLanguage(candidate);
    if (normalized) {
      return normalized;
    }
  }

  return "en";
}

export function createTranslator(requested?: string) {
  const language = resolveLanguage(requested);
  const primary = loadCatalog(language);
  const fallback = language === "en" ? primary : loadCatalog("en");

  return {
    language,
    t(key: string, values: MessageValues = {}): string {
      const template = primary[key] ?? fallback[key] ?? key;
      return formatMessage(template, values);
    },
  };
}

export function formatMessage(template: string, values: MessageValues): string {
  return template.replace(/\{([A-Za-z0-9_.-]+)\}/g, (match, key: string) => {
    const value = values[key];
    return value === undefined ? match : String(value);
  });
}

export function loadCatalog(language: SupportedLanguage): MessageCatalog {
  return catalogs[language];
}

function normalizeLanguage(language?: string): SupportedLanguage | undefined {
  if (!language) {
    return undefined;
  }

  const base = language.trim().toLowerCase().split(/[-_]/)[0];
  return supportedLanguages.has(base as SupportedLanguage)
    ? (base as SupportedLanguage)
    : undefined;
}
