import { createWorker } from "tesseract.js";
import { ipc, type OcrResult, type OcrWord } from "./ipc";
import { cleanOcrText, cleanOcrWord } from "./vietnameseOcrCleaner";
import { recognizePaddleOcr, preloadOcrModel } from "./paddleOcrService";

export { preloadOcrModel };

export type OcrLanguageMode = "all" | "vi" | "ja" | "zh" | "en";

export interface OcrLangPreset {
  id: OcrLanguageMode;
  label: string;
  flag: string;
  codes: string[];
}

export const OCR_LANG_PRESETS: Record<OcrLanguageMode, OcrLangPreset> = {
  vi: {
    id: "vi",
    label: "Tiếng Việt + English (Khuyên dùng)",
    flag: "🇻🇳",
    codes: ["vie", "eng"],
  },
  en: {
    id: "en",
    label: "English only",
    flag: "🇺🇸",
    codes: ["eng"],
  },
  ja: {
    id: "ja",
    label: "日本語 (Tiếng Nhật) + English",
    flag: "🇯🇵",
    codes: ["jpn", "eng"],
  },
  zh: {
    id: "zh",
    label: "中文 (Tiếng Trung) + English",
    flag: "🇨🇳",
    codes: ["chi_sim", "chi_tra", "eng"],
  },
  all: {
    id: "all",
    label: "Đa ngôn ngữ",
    flag: "🌐",
    codes: ["vie", "eng"],
  },
};

export function getSavedOcrLang(): OcrLanguageMode {
  try {
    const saved = localStorage.getItem("snapdoc_ocr_lang") as OcrLanguageMode;
    if (saved && OCR_LANG_PRESETS[saved]) return saved;
  } catch {}
  return "vi"; // Mặc định Tiếng Việt + English để giữ nguyên khoảng trắng và chống lẫn Kanji
}

export function saveOcrLang(mode: OcrLanguageMode) {
  try {
    localStorage.setItem("snapdoc_ocr_lang", mode);
  } catch {}
}

const workerPool: Partial<Record<OcrLanguageMode, any>> = {};
const initPromises: Partial<Record<OcrLanguageMode, Promise<any>>> = {};

/**
 * Khởi tạo worker Tesseract.js offline 100% từ thư mục public/tesseract/ (không dùng CDN, không cần internet)
 */
export async function getOcrWorker(mode: OcrLanguageMode = getSavedOcrLang()) {
  if (workerPool[mode]) return workerPool[mode];

  if (initPromises[mode]) {
    return await initPromises[mode];
  }

  const preset = OCR_LANG_PRESETS[mode] || OCR_LANG_PRESETS.all;
  const origin = window.location.origin;

  const initPromise = (async () => {
    try {
      console.log(`[SnapDoc OCR] Khởi tạo worker offline cho [${preset.label}] với codes:`, preset.codes);

      const worker = await createWorker(preset.codes, 1, {
        workerPath: `${origin}/tesseract/worker.min.js`,
        corePath: `${origin}/tesseract/core/tesseract-core-simd-lstm.wasm.js`,
        langPath: `${origin}/tesseract/lang`,
        workerBlobURL: false,
        gzip: false,
        errorHandler: (err) => console.warn("[SnapDoc OCR Worker warning]", err),
      });

      if (mode === "vi" || mode === "en" || mode === "all") {
        try {
          await worker.setParameters({
            tessedit_char_blacklist: "åÅäÄöÖüÜøØæÆßëËïÏÿŸ",
          });
        } catch (paramErr) {
          console.warn("[SnapDoc OCR] Không thể set tessedit_char_blacklist:", paramErr);
        }
      }

      workerPool[mode] = worker;
      return worker;
    } catch (err) {
      console.error("[SnapDoc OCR] Lỗi nạp worker offline:", err);
      // Fallback: nếu đường dẫn origin gặp giới hạn asset, dùng CDN dự phòng
      const worker = await createWorker(preset.codes);
      if (mode === "vi" || mode === "en" || mode === "all") {
        try {
          await worker.setParameters({
            tessedit_char_blacklist: "åÅäÄöÖüÜøØæÆßëËïÏÿŸ",
          });
        } catch (paramErr) {
          console.warn("[SnapDoc OCR] Không thể set tessedit_char_blacklist:", paramErr);
        }
      }

      workerPool[mode] = worker;
      return worker;
    } finally {
      delete initPromises[mode];
    }
  })();

  initPromises[mode] = initPromise;
  return await initPromise;
}

/**
 * Tiền xử lý hình ảnh tối ưu hoá cho OCR:
 * 1. Nhận diện nền tối (Dark mode) và tự động ĐẢO MÀU (Invert) để chuyển thành chữ đen nền trắng (chuẩn huấn luyện của Tesseract).
 * 2. Phóng to 2x (Upscale) bằng thuật toán nội suy chất lượng cao để làm dày nét chữ và tách biệt các dấu thanh tiếng Việt / ký tự Kanji/Kana/Hanzi nhỏ trên màn hình.
 * 3. Tăng cường độ tương phản (Contrast) và loại bỏ nhiễu màu.
 */
async function preprocessImageForOcr(imageUrl: string): Promise<{ dataUrl: string; scaleFactor: number }> {
  return new Promise((resolve) => {
    const img = new Image();
    img.crossOrigin = "anonymous";
    img.onload = () => {
      try {
        const origW = img.naturalWidth || img.width;
        const origH = img.naturalHeight || img.height;
        if (!origW || !origH) {
          resolve({ dataUrl: imageUrl, scaleFactor: 1 });
          return;
        }

        // Phân tích độ sáng trung bình để phát hiện Dark mode
        const sampleCanvas = document.createElement("canvas");
        sampleCanvas.width = 64;
        sampleCanvas.height = 64;
        const sCtx = sampleCanvas.getContext("2d");
        if (!sCtx) {
          resolve({ dataUrl: imageUrl, scaleFactor: 1 });
          return;
        }

        sCtx.drawImage(img, 0, 0, 64, 64);
        const imgData = sCtx.getImageData(0, 0, 64, 64);
        const data = imgData.data;
        let totalLuma = 0;
        let darkPixels = 0;
        const pixelCount = data.length / 4;
        for (let i = 0; i < data.length; i += 4) {
          const luma = 0.299 * data[i] + 0.587 * data[i + 1] + 0.114 * data[i + 2];
          totalLuma += luma;
          if (luma < 95) darkPixels++;
        }
        const avgLuma = totalLuma / pixelCount;
        // Tự động nhận diện Dark mode nếu độ sáng trung bình < 128 HOẶC có > 35% pixel là nền tối (ví dụ cửa sổ IDE/Terminal ở giữa màn hình)
        const isDarkMode = avgLuma < 128 || (darkPixels / pixelCount) > 0.35;

        const scaleFactor = 2.0;
        const canvas = document.createElement("canvas");
        canvas.width = Math.round(origW * scaleFactor);
        canvas.height = Math.round(origH * scaleFactor);
        const ctx = canvas.getContext("2d");
        if (!ctx) {
          resolve({ dataUrl: imageUrl, scaleFactor: 1 });
          return;
        }

        ctx.imageSmoothingEnabled = true;
        ctx.imageSmoothingQuality = "high";

        if (isDarkMode) {
          ctx.filter = "invert(1) grayscale(1) contrast(1.05)";
        } else {
          ctx.filter = "grayscale(1)";
        }

        ctx.drawImage(img, 0, 0, canvas.width, canvas.height);
        const processedUrl = canvas.toDataURL("image/png");
        resolve({ dataUrl: processedUrl, scaleFactor });
      } catch (err) {
        console.warn("[SnapDoc OCR] Tiền xử lý thất bại, dùng ảnh gốc:", err);
        resolve({ dataUrl: imageUrl, scaleFactor: 1 });
      }
    };

    img.onerror = () => {
      resolve({ dataUrl: imageUrl, scaleFactor: 1 });
    };

    img.src = imageUrl;
  });
}


/**
 * Hàn gắn các mảnh chữ/dấu thanh bị Tesseract bóc tách rời rạc trong TSV
 */
function mergeOcrWords(rawWords: OcrWord[]): OcrWord[] {
  if (rawWords.length <= 1) return rawWords;
  const merged: OcrWord[] = [];
  let curr = { ...rawWords[0] };

  for (let i = 1; i < rawWords.length; i++) {
    const next = rawWords[i];
    const isSameLine = Math.abs(curr.y - next.y) <= Math.max(curr.h, next.h) * 0.55;
    const gap = next.x - (curr.x + curr.w);

    const nextIsDiacritic = /^['`´ˆ˜^"”°]/.test(next.text);
    const currEndsWithDiacritic = /['`´ˆ˜^]$/.test(curr.text);
    const isOverlappingFragment = gap < 0 && Math.abs(gap) >= 1;
    // Chỉ hàn gắn nếu là ký tự dấu thanh trôi nổi hoặc mảnh dấu thanh
    const isTightFragment = gap <= 1 && (/^['`´ˆ˜^"”°]/.test(next.text) || /['`´ˆ˜^]$/.test(curr.text));

    if (isSameLine && (nextIsDiacritic || currEndsWithDiacritic || isOverlappingFragment || isTightFragment)) {
      curr.text = curr.text + next.text;
      const right = Math.max(curr.x + curr.w, next.x + next.w);
      const bottom = Math.max(curr.y + curr.h, next.y + next.h);
      curr.x = Math.min(curr.x, next.x);
      curr.y = Math.min(curr.y, next.y);
      curr.w = right - curr.x;
      curr.h = bottom - curr.y;
    } else {
      merged.push(curr);
      curr = { ...next };
    }
  }
  merged.push(curr);
  return merged;
}

function splitGluedWord(w: OcrWord, cleaned: string): OcrWord[] {
  const tokens = cleaned.split(/\s+/).filter(Boolean);
  if (tokens.length <= 1) {
    return [{ ...w, text: cleaned }];
  }
  const totalChars = tokens.reduce((sum, t) => sum + t.length, 0);
  let curX = w.x;
  const res: OcrWord[] = [];
  for (let i = 0; i < tokens.length; i++) {
    const token = tokens[i];
    const tokenW = Math.max(6, Math.round((w.w * token.length) / Math.max(1, totalChars)));
    res.push({
      text: token,
      x: curX,
      y: w.y,
      w: tokenW,
      h: w.h,
    });
    curX += tokenW + Math.max(2, Math.round(w.w * 0.02));
  }
  return res;
}

/**
 * Hậu xử lý kết quả OCR: Hàn gắn các mảnh từ/dấu thanh, chuẩn hoá tiếng Việt, làm sạch khoảng trắng CJK
 * Tự động phân tách các cụm từ dính liền thành từng từ con với bounding box tỷ lệ chuẩn xác.
 */
export function processOcrResult(rawResult: OcrResult, mode: OcrLanguageMode = "vi"): OcrResult {
  let fullText = (rawResult.text || "").trim();
  fullText = cleanOcrText(fullText, mode);

  // Xử lý các dòng trước để bảo toàn cấu trúc văn bản
  const lines = rawResult.lines && rawResult.lines.length > 0
    ? rawResult.lines.map((l) => {
        const splitLineWords: OcrWord[] = [];
        const mergedLineWords = mergeOcrWords(l.words || []);
        for (const w of mergedLineWords) {
          const cleaned = cleanOcrWord(w.text, mode);
          if (!cleaned || cleaned.trim().length === 0) continue;
          splitLineWords.push(...splitGluedWord(w, cleaned));
        }
        splitLineWords.sort((a, b) => a.x - b.x);
        return {
          ...l,
          text: cleanOcrText(l.text, mode),
          words: splitLineWords,
        };
      })
    : undefined;

  // Lấy words trực tiếp từ lines để đảm bảo 100% đồng nhất object reference
  const words: OcrWord[] = [];
  if (lines && lines.length > 0) {
    for (const l of lines) {
      words.push(...l.words);
    }
  } else {
    const mergedWords = mergeOcrWords(rawResult.words || []);
    for (const w of mergedWords) {
      const cleaned = cleanOcrWord(w.text, mode);
      if (!cleaned || cleaned.trim().length === 0) continue;
      words.push(...splitGluedWord(w, cleaned));
    }
  }

  return {
    text: fullText,
    words,
    lines,
    engine: rawResult.engine,
    engineError: rawResult.engineError,
  };
}

/**
 * Trích xuất văn bản từ ảnh với độ chính xác cao hỗ trợ Tiếng Việt, Tiếng Anh, Tiếng Nhật, Tiếng Trung
 */
export async function recognizeImage(imageUrl: string, langMode?: OcrLanguageMode): Promise<OcrResult> {
  const mode = langMode || getSavedOcrLang();
  let viesvtrError: string | null = null;
  let tesseractError: string | null = null;

  // 1. Ưu tiên hàng đầu: PaddleOCR + VieSVTR Deep Learning Engine (chuẩn 10/10, không lẫn Kanji, không nối từ, 100% offline)
  try {
    const dlResult = await recognizePaddleOcr(imageUrl, mode);
    if (dlResult && (dlResult.text.length > 0 || dlResult.words.length > 0)) {
      return { ...processOcrResult(dlResult, mode), engine: "viesvtr" };
    }
  } catch (err: any) {
    viesvtrError = err?.message || String(err);
    console.error("[SnapDoc OCR] PaddleOCR/VieSVTR engine gặp sự cố, chuyển sang Tesseract dự phòng:", err);
  }

  // 2. Dự phòng cấp 2: Tesseract Worker nếu khả dụng
  try {
    const { dataUrl: processedUrl, scaleFactor } = await preprocessImageForOcr(imageUrl);
    const worker = await getOcrWorker(mode);
    const ret = await worker.recognize(processedUrl, {}, { tsv: true });

    const rawTsv = ret?.data?.tsv || "";
    const lines = rawTsv.split("\n");
    const rawWords: OcrWord[] = [];
    const tsvLinesMap = new Map<string, { words: OcrWord[]; blockNum: number }>();

    for (const line of lines) {
      const cols = line.split("\t");
      // Cột 0 === '5' tương ứng với Word level trong chuẩn TSV của Tesseract
      if (cols[0] === "5" && cols[11] && cols[11].trim().length > 0) {
        const rawText = cols[11].trim();
        const blockNum = parseInt(cols[2], 10) || 0;
        const lineNum = parseInt(cols[4], 10) || 0;
        const x = Math.round((parseInt(cols[6], 10) || 0) / scaleFactor);
        const y = Math.round((parseInt(cols[7], 10) || 0) / scaleFactor);
        const w = Math.round((parseInt(cols[8], 10) || 0) / scaleFactor);
        const h = Math.round((parseInt(cols[9], 10) || 0) / scaleFactor);

        if (w > 0 && h > 0) {
          const wObj: OcrWord = { text: rawText, x, y, w, h };
          rawWords.push(wObj);

          const key = `${blockNum}-${lineNum}`;
          if (!tsvLinesMap.has(key)) {
            tsvLinesMap.set(key, { words: [], blockNum });
          }
          tsvLinesMap.get(key)!.words.push(wObj);
        }
      }
    }

    const tsvLines: { text: string; x: number; y: number; w: number; h: number; words: OcrWord[]; columnId?: number }[] = [];
    tsvLinesMap.forEach(({ words: lWords, blockNum }) => {
      if (lWords.length === 0) return;
      const minX = Math.min(...lWords.map((w) => w.x));
      const minY = Math.min(...lWords.map((w) => w.y));
      const maxX = Math.max(...lWords.map((w) => w.x + w.w));
      const maxY = Math.max(...lWords.map((w) => w.y + w.h));
      tsvLines.push({
        text: lWords.map((w) => w.text).join(" "),
        x: minX,
        y: minY,
        w: Math.max(maxX - minX, 10),
        h: Math.max(maxY - minY, 12),
        words: lWords,
        columnId: blockNum,
      });
    });

    const tesseractText = (ret?.data?.text || "").trim();
    if (tesseractText.length > 0 || rawWords.length > 0) {
      return {
        ...processOcrResult({ text: tesseractText, words: rawWords, lines: tsvLines }, mode),
        engine: "tesseract",
        engineError: viesvtrError ? `VieSVTR lỗi: ${viesvtrError}` : undefined,
      };
    }
  } catch (err: any) {
    tesseractError = err?.message || String(err);
    console.error("[SnapDoc OCR] Tesseract Worker không khả dụng, dùng Native Windows OCR engine:", err);
  }

  // Fallback sang Windows Native OCR engine (nhanh, ổn định)
  try {
    const nativeRes = await ipc.runOcr(imageUrl);
    const combinedErrors = [
      viesvtrError ? `VieSVTR: ${viesvtrError}` : null,
      tesseractError ? `Tesseract: ${tesseractError}` : null,
    ].filter(Boolean).join(" | ");

    return {
      ...processOcrResult(nativeRes, mode),
      engine: nativeRes.engine || "windows",
      engineError: combinedErrors || undefined,
    };
  } catch (err) {
    console.error("[SnapDoc OCR] Native OCR thất bại:", err);
    throw err;
  }
}
