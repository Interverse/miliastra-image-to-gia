import { TRANSLATIONS, type MessageKey } from "./translations";

// Canonical Miliastra Toolkit language codes shared across all toolkit sites
// via localStorage on the interverse.github.io origin. See docs/language-sync.md.
export const MILIASTRA_LANGS = [
  "en",
  "zhs",
  "zht",
  "ja",
  "ko",
  "es",
  "fr",
  "ru",
  "th",
  "vi",
  "de",
  "id",
  "pt",
  "tr",
  "it",
] as const;

export type Lang = (typeof MILIASTRA_LANGS)[number];

export const SHARED_LANG_KEY = "miliastra-lang";

// Native-language display names for the selector.
export const LANG_NAMES: Record<Lang, string> = {
  en: "English",
  zhs: "简体中文",
  zht: "繁體中文",
  ja: "日本語",
  ko: "한국어",
  es: "Español",
  fr: "Français",
  ru: "Русский",
  th: "ไทย",
  vi: "Tiếng Việt",
  de: "Deutsch",
  id: "Bahasa Indonesia",
  pt: "Português",
  tr: "Türkçe",
  it: "Italiano",
};

// BCP 47 tags for <html lang="...">.
export const HTML_LANGS: Record<Lang, string> = {
  en: "en",
  zhs: "zh-CN",
  zht: "zh-TW",
  ja: "ja",
  ko: "ko",
  es: "es",
  fr: "fr",
  ru: "ru",
  th: "th",
  vi: "vi",
  de: "de",
  id: "id",
  pt: "pt",
  tr: "tr",
  it: "it",
};

export function isValidLang(value: unknown): value is Lang {
  return (
    typeof value === "string" && (MILIASTRA_LANGS as readonly string[]).includes(value)
  );
}

// Resolve the language on page load: shared key first (validated), then
// browser detection. This site never had its own legacy language key, so
// there is no migration step. Never writes to storage — auto-detection stays
// responsive to browser-setting changes until the user actively picks.
export function resolveLang(): Lang {
  try {
    const saved = localStorage.getItem(SHARED_LANG_KEY);
    if (isValidLang(saved)) return saved;
  } catch {
    // localStorage unavailable (private browsing) — fall through to detection.
  }
  const candidates =
    navigator.languages && navigator.languages.length
      ? navigator.languages
      : [navigator.language || "en"];
  for (const candidate of candidates) {
    const lower = String(candidate).toLowerCase();
    if (lower.startsWith("zh")) {
      return /hant|tw|hk|mo/.test(lower) ? "zht" : "zhs";
    }
    const two = lower.slice(0, 2);
    if (isValidLang(two)) return two;
  }
  return "en";
}

// Persist an explicit user choice as the toolkit-wide preference.
export function saveLang(code: Lang): void {
  try {
    localStorage.setItem(SHARED_LANG_KEY, code);
  } catch {
    // Non-fatal: keep the in-memory selection for this session.
  }
}

export function translate(
  lang: Lang,
  key: MessageKey,
  params?: Record<string, string | number>
): string {
  let text = TRANSLATIONS[lang][key] ?? TRANSLATIONS.en[key];
  if (params) {
    for (const [name, value] of Object.entries(params)) {
      text = text.replace(new RegExp(`\\{${name}\\}`, "g"), String(value));
    }
  }
  return text;
}

export type { MessageKey };
