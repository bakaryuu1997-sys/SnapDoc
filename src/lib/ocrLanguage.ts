import { ipc } from "./ipc";

export type OcrLanguageMode = "auto" | "vi" | "en" | "ja" | "zh";

export interface OcrLangPreset {
  id: OcrLanguageMode;
  label: string;
  flag: string;
  codes: string[];
}

export const OCR_LANG_PRESETS: Record<OcrLanguageMode, OcrLangPreset> = {
  auto: {
    id: "auto",
    label: "Tự động (Việt · Anh · 日本語 · 中文)",
    flag: "🌐",
    codes: ["vie", "jpn", "eng"],
  },
  vi: {
    id: "vi",
    label: "Tiếng Việt + English",
    flag: "🇻🇳",
    codes: ["vie", "eng"],
  },
  ja: {
    id: "ja",
    label: "日本語 + English",
    flag: "🇯🇵",
    codes: ["jpn", "eng"],
  },
  zh: {
    id: "zh",
    label: "中文 + English",
    flag: "🇨🇳",
    codes: ["chi_sim", "chi_tra", "eng"],
  },
  en: {
    id: "en",
    label: "English only",
    flag: "🇺🇸",
    codes: ["eng"],
  },
};

export const CJK_REGEX = /[\u3040-\u30FF\u31F0-\u31FF\u3400-\u4DBF\u4E00-\u9FFF\uFF66-\uFF9F]/;

export function normalizeOcrLang(mode: string | null | undefined): OcrLanguageMode {
  if (!mode || mode === "all") return "auto";
  if (mode === "auto" || mode === "vi" || mode === "en" || mode === "ja" || mode === "zh") {
    return mode;
  }
  return "auto";
}

let cachedSettingsLang: OcrLanguageMode | null = null;

export function getSavedOcrLang(): OcrLanguageMode {
  if (cachedSettingsLang) return cachedSettingsLang;
  try {
    const raw = localStorage.getItem("snapdoc_ocr_lang");
    const normalized = normalizeOcrLang(raw);
    if (raw === "all") {
      localStorage.setItem("snapdoc_ocr_lang", "auto");
    }
    return normalized;
  } catch {
    return "auto";
  }
}

export function saveOcrLang(mode: OcrLanguageMode) {
  const norm = normalizeOcrLang(mode);
  cachedSettingsLang = norm;
  try {
    localStorage.setItem("snapdoc_ocr_lang", norm);
  } catch {}
  ipc.patchSettings({ ocrLanguage: norm }).catch(() => {});
}

export function setCachedOcrLang(mode: string | null | undefined) {
  cachedSettingsLang = normalizeOcrLang(mode);
}
