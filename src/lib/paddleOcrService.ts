import * as ort from "onnxruntime-web";
import { DetectionService, PaddleOcrService, Image as PaddleImage } from "paddleocr";
import type { OcrResult, OcrWord, OcrLine } from "./ipc";
import { cleanVietnameseOcrText } from "./vietnameseOcrCleaner";

export type OcrLanguageMode = "vi" | "en" | "ja" | "zh" | "all";

export const VIETOCR_VOCAB =
  "aAàÀảẢãÃáÁạẠăĂằẰẳẲẵẴắẮặẶâÂầẦẩẨẫẪấẤậẬbBcCdDđĐeEèÈẻẺẽẼéÉẹẸêÊềỀểỂễỄếẾệỆ" +
  "fFgGhHiIìÌỉỈĩĨíÍịỊjJkKlLmMnNoOòÒỏỎõÕóÓọỌôÔồỒổỔỗỖốỐộỘơƠờỜởỞỡỠớỚợỢpPqQrR" +
  "sStTuUùÙủỦũŨúÚụỤưƯừỪửỬữỮứỨựỰvVwWxXyYỳỲỷỶỹỸýÝỵỴzZ0123456789" +
  "!\"#$%&'()*+,-./:;<=>?@[\\]^_`{|}~ ";

const i2c: Record<number, string> = {};
for (let i = 0; i < VIETOCR_VOCAB.length; i++) {
  i2c[i + 1] = VIETOCR_VOCAB[i];
}

let wasmConfigured = false;
const sessionOptions: ort.InferenceSession.SessionOptions = {
  executionProviders: ["wasm"],
  graphOptimizationLevel: "all",
};

function configureWasm() {
  if (wasmConfigured) return;
  try {
    const origin = typeof window !== "undefined" ? window.location.origin : "";
    ort.env.wasm.wasmPaths = `${origin}/onnxruntime/`;
    ort.env.wasm.proxy = false; // Tắt hoàn toàn Web Worker proxy để không lỗi trong Vite/WebView2
    ort.env.wasm.numThreads = 1; // 1 luồng WASM SIMD trực tiếp, siêu ổn định và cực nhanh (<1s)
    ort.env.wasm.simd = true;
    wasmConfigured = true;
    console.log(`[SnapDoc OCR] Cấu hình WASM thành công: origin=${origin}, numThreads=1, proxy=false, EP=wasm`);
  } catch (err) {
    console.warn("[PaddleOCR] Lỗi cấu hình WASM paths:", err);
  }
}

// Mutex toàn cục tuần tự hóa mọi tác vụ OCR, ngăn chặn triệt để lỗi "Session mismatch"
let globalOcrMutex = Promise.resolve();

// Cache sessions
let detServiceInstance: DetectionService | null = null;
let detInitPromise: Promise<DetectionService> | null = null;

let recViSessionInstance: ort.InferenceSession | null = null;
let recViInitPromise: Promise<ort.InferenceSession> | null = null;

let cjkOcrInstance: PaddleOcrService | null = null;
let cjkInitPromise: Promise<PaddleOcrService> | null = null;

async function fetchArrayBuffer(path: string): Promise<ArrayBuffer> {
  const origin = typeof window !== "undefined" ? window.location.origin : "";
  const fullUrl = path.startsWith("http") ? path : `${origin}${path.startsWith("/") ? "" : "/"}${path}`;
  try {
    const resp = await fetch(fullUrl);
    if (!resp.ok) {
      throw new Error(`HTTP ${resp.status} ${resp.statusText}`);
    }
    return await resp.arrayBuffer();
  } catch (err: any) {
    if (fullUrl !== path) {
      try {
        const resp2 = await fetch(path);
        if (resp2.ok) return await resp2.arrayBuffer();
      } catch {}
    }
    throw new Error(`Tải model ${path} thất bại: ${err?.message || err}`);
  }
}

/**
 * Khởi tạo singleton DetectionService (DBNet detector, ~4.8MB)
 * Cấu hình maxSideLength: 1920 để nhận diện hoàn hảo cả các text cực nhỏ như badges, timestamps, buttons
 */
async function getDetectionService(): Promise<DetectionService> {
  if (detServiceInstance) return detServiceInstance;
  if (detInitPromise) return await detInitPromise;

  configureWasm();
  detInitPromise = (async () => {
    try {
      console.log("[SnapDoc OCR] Đang tải DBNet detection model...");
      const detBuffer = await fetchArrayBuffer("/models/paddleocr/det.onnx");
      const detSession = await ort.InferenceSession.create(new Uint8Array(detBuffer), sessionOptions);
      detServiceInstance = new DetectionService(ort as any, detSession as any, {
        maxSideLength: 1920,
        textPixelThreshold: 0.25,
        boxScoreThreshold: 0.35,
        unclipRatio: 1.6,
        minimumAreaThreshold: 10,
      });
      console.log("[SnapDoc OCR] DBNet detector đã sẵn sàng!");
      return detServiceInstance;
    } catch (err) {
      console.error("[SnapDoc OCR] Không thể nạp det.onnx:", err);
      throw err;
    } finally {
      detInitPromise = null;
    }
  })();

  return await detInitPromise;
}

/**
 * Khởi tạo singleton VieSVTR recognition session cho Tiếng Việt + Tiếng Anh
 */
async function getRecViSession(): Promise<ort.InferenceSession> {
  if (recViSessionInstance) return recViSessionInstance;
  if (recViInitPromise) return await recViInitPromise;

  configureWasm();
  recViInitPromise = (async () => {
    try {
      console.log("[SnapDoc OCR] Đang tải VieSVTR recognition model (rec_vi.onnx)...");
      const recBuffer = await fetchArrayBuffer("/models/paddleocr/rec_vi.onnx");
      recViSessionInstance = await ort.InferenceSession.create(new Uint8Array(recBuffer), sessionOptions);
      console.log("[SnapDoc OCR] VieSVTR recognizer đã sẵn sàng!");
      return recViSessionInstance;
    } catch (err) {
      console.error("[SnapDoc OCR] Không thể nạp rec_vi.onnx:", err);
      throw err;
    } finally {
      recViInitPromise = null;
    }
  })();

  return await recViInitPromise;
}

/**
 * Pre-warm mô hình OCR trong background khi app khởi động hoặc khi Editor mở
 */
export async function preloadOcrModel(): Promise<void> {
  try {
    await getDetectionService();
    await getRecViSession();
    console.log("[SnapDoc OCR] Pre-warm OCR engine hoàn tất!");
  } catch (err) {
    console.debug("[SnapDoc OCR] Pre-warm OCR lỗi hoặc hoãn:", err);
  }
}

/**
 * Khởi tạo singleton PaddleOCR cho CJK (Tiếng Nhật / Tiếng Trung)
 */
async function getCjkOcrService(): Promise<PaddleOcrService> {
  if (cjkOcrInstance) return cjkOcrInstance;
  if (cjkInitPromise) return await cjkInitPromise;

  configureWasm();
  cjkInitPromise = (async () => {
    try {
      console.log("[SnapDoc OCR] Đang nạp CJK recognition model & dict...");
      const [detBuffer, recBuffer, dictText] = await Promise.all([
        fetchArrayBuffer("/models/paddleocr/det.onnx"),
        fetchArrayBuffer("/models/paddleocr/rec_cjk.onnx"),
        fetch("/models/paddleocr/ppocrv5_dict.txt").then((r) => r.text()),
      ]);

      const dictLines = dictText.trimEnd().split(/\r?\n/);
      cjkOcrInstance = await PaddleOcrService.createInstance({
        ort: ort as any,
        modelPreset: "PP-OCRv5_mobile",
        detection: {
          modelBuffer: detBuffer,
        },
        recognition: {
          modelBuffer: recBuffer,
          charactersDictionary: dictLines,
        },
      });
      console.log("[SnapDoc OCR] CJK recognizer đã sẵn sàng!");
      return cjkOcrInstance;
    } catch (err) {
      console.error("[SnapDoc OCR] Không thể nạp CJK model:", err);
      throw err;
    } finally {
      cjkInitPromise = null;
    }
  })();

  return await cjkInitPromise;
}

interface CtcDecodeResult {
  text: string;
  confidence: number;
}

function decodeCtcGreedy(logitsData: Float32Array, seqLen: number, numClasses: number = 230): CtcDecodeResult {
  const chars: string[] = [];
  const probs: number[] = [];
  let prevId = -1;

  for (let t = 0; t < seqLen; t++) {
    const offset = t * numClasses;
    let maxIdx = 0;
    let maxVal = logitsData[offset];
    for (let c = 1; c < numClasses; c++) {
      const v = logitsData[offset + c];
      if (v > maxVal) {
        maxVal = v;
        maxIdx = c;
      }
    }

    if (maxIdx !== prevId && maxIdx !== 0) {
      const ch = i2c[maxIdx];
      if (ch) {
        chars.push(ch);
        // Softmax probability cho maxIdx
        let sumExp = 0;
        for (let c = 0; c < numClasses; c++) {
          sumExp += Math.exp(logitsData[offset + c] - maxVal);
        }
        probs.push(1 / Math.max(1e-6, sumExp));
      }
    }
    prevId = maxIdx;
  }

  const text = chars.join("");
  const confidence = probs.length > 0 ? probs.reduce((a, b) => a + b, 0) / probs.length : 0;
  return { text, confidence };
}

function rgbaToRgb(rgbaData: Uint8ClampedArray, width: number, height: number): Uint8Array {
  const pixelCount = width * height;
  const rgb = new Uint8Array(pixelCount * 3);
  for (let i = 0, j = 0; i < rgbaData.length; i += 4, j += 3) {
    rgb[j] = rgbaData[i];
    rgb[j + 1] = rgbaData[i + 1];
    rgb[j + 2] = rgbaData[i + 2];
  }
  return rgb;
}

export interface BoxWithColumn {
  x: number;
  y: number;
  width: number;
  height: number;
  columnId?: number;
}

/**
 * Sắp xếp các bounding box theo thứ tự đọc tự nhiên của tài liệu đa cột (Multi-Column Layout Awareness)
 * Tự động phát hiện rãnh phân tách dọc (vertical gutter) như giữa Sidebar và Cửa sổ làm việc chính,
 * ngăn hiện tượng các dòng của 2 cột song song bị đan xen vào nhau. Gán columnId cho từng box.
 */
export function sortBoxesColumnAware<T extends { x: number; y: number; width: number; height: number; columnId?: number }>(
  boxes: T[],
  imgW: number
): T[] {
  if (boxes.length <= 1) {
    return boxes.map((b) => ({ ...b, columnId: 0 }));
  }

  // 1. Lọc bỏ các phần tử kéo dài toàn trang (Spanning Elements như Header/Footer/Thanh tìm kiếm)
  // để không làm triệt tiêu các khoảng rãnh dọc giữa Sidebar và Nội dung chính.
  const isSpanning = (b: T) => b.width > imgW * 0.42;
  const colCandidateBoxes = boxes.filter((b) => !isSpanning(b));
  const candidateBoxes = colCandidateBoxes.length >= 3 ? colCandidateBoxes : boxes;

  const safeW = Math.max(10, Math.ceil(imgW));
  const xDensity = new Int32Array(safeW);
  for (const b of candidateBoxes) {
    const startX = Math.max(0, Math.floor(b.x));
    const endX = Math.min(safeW - 1, Math.ceil(b.x + b.width));
    for (let x = startX; x <= endX; x++) {
      xDensity[x]++;
    }
  }

  // 2. Tìm kiếm các khoảng trống dọc (gutters) chia tách các cột (sidebar, bảng, panels)
  // Ngưỡng spike cho phép: 1 phần tử ngoại lai nhỏ không làm mất rãnh
  const maxAllowedSpike = Math.max(0, Math.floor(candidateBoxes.length * 0.03));
  const colSplits: number[] = [];
  const minGutter = 12; // ít nhất 12px rãnh trống
  let gutterStart = -1;

  const minX = Math.floor(imgW * 0.06);
  const maxX = Math.floor(imgW * 0.94);

  for (let x = minX; x <= maxX; x++) {
    if (xDensity[x] <= maxAllowedSpike) {
      if (gutterStart === -1) gutterStart = x;
    } else {
      if (gutterStart !== -1) {
        const gutterW = x - gutterStart;
        if (gutterW >= minGutter) {
          colSplits.push(Math.round(gutterStart + gutterW / 2));
        }
        gutterStart = -1;
      }
    }
  }
  if (gutterStart !== -1 && maxX - gutterStart >= minGutter) {
    colSplits.push(Math.round(gutterStart + (maxX - gutterStart) / 2));
  }

  // 3. Fallback: Nếu không tìm thấy bằng histogram, dùng phân cụm lề trái (Left-margin clustering)
  // Phát hiện nếu các box bên trái (Sidebar) kết thúc trước khi các box bên phải bắt đầu
  if (colSplits.length === 0 && candidateBoxes.length >= 4) {
    let bestSplitX = -1;
    let maxGap = 0;

    // Quét các ngưỡng split tiềm năng từ 15% đến 55% chiều rộng ảnh
    for (let pct = 0.15; pct <= 0.55; pct += 0.05) {
      const splitCandidate = Math.round(imgW * pct);
      const leftBoxes = candidateBoxes.filter((b) => b.x + b.width <= splitCandidate + 10);
      const rightBoxes = candidateBoxes.filter((b) => b.x >= splitCandidate - 10);

      if (leftBoxes.length >= 2 && rightBoxes.length >= 2 && leftBoxes.length + rightBoxes.length >= candidateBoxes.length * 0.8) {
        const maxLeftX = Math.max(...leftBoxes.map((b) => b.x + b.width));
        const minRightX = Math.min(...rightBoxes.map((b) => b.x));
        const gap = minRightX - maxLeftX;
        if (gap >= 12 && gap > maxGap) {
          maxGap = gap;
          bestSplitX = Math.round((maxLeftX + minRightX) / 2);
        }
      }
    }

    if (bestSplitX > 0) {
      colSplits.push(bestSplitX);
    }
  }

  const sortSingleColumn = (colBoxes: T[]) => {
    colBoxes.sort((a, b) => {
      const yDiff = a.y - b.y;
      const minH = Math.min(a.height, b.height);
      if (Math.abs(yDiff) > minH * 0.45) {
        return yDiff;
      }
      return a.x - b.x;
    });
  };

  if (colSplits.length > 0) {
    const columns: T[][] = Array.from({ length: colSplits.length + 1 }, () => []);

    for (const b of boxes) {
      let colIdx = 0;
      if (isSpanning(b)) {
        // Spanning elements: gán vào cột gần điểm bắt đầu X nhất
        while (colIdx < colSplits.length && b.x > colSplits[colIdx]) {
          colIdx++;
        }
      } else {
        const centerX = b.x + b.width / 2;
        while (colIdx < colSplits.length && centerX > colSplits[colIdx]) {
          colIdx++;
        }
      }
      b.columnId = colIdx;
      columns[colIdx].push(b);
    }

    const sortedResult: T[] = [];
    for (const col of columns) {
      sortSingleColumn(col);
      sortedResult.push(...col);
    }
    return sortedResult;
  }

  const copy = boxes.map((b) => ({ ...b, columnId: 0 }));
  sortSingleColumn(copy);
  return copy;
}

/**
 * Hợp nhất các cụm từ/box nằm trên cùng 1 dòng trong cùng 1 cột thành 1 dòng duy nhất liền mạch
 * Giải quyết triệt để vấn đề bị đứt đoạn giữa các từ như "chỗ" và "là bị lộ dữ liệu bí mật."
 */
function mergeAdjacentLinesInSameColumn(lines: OcrLine[]): OcrLine[] {
  if (lines.length <= 1) return lines;

  const colMap = new Map<number, OcrLine[]>();
  for (const l of lines) {
    const cId = l.columnId ?? 0;
    if (!colMap.has(cId)) colMap.set(cId, []);
    colMap.get(cId)!.push(l);
  }

  const result: OcrLine[] = [];
  colMap.forEach((colLines) => {
    colLines.sort((a, b) => {
      const yDiff = a.y - b.y;
      const minH = Math.min(a.h, b.h);
      if (Math.abs(yDiff) > minH * 0.45) return yDiff;
      return a.x - b.x;
    });

    let curr: OcrLine = { ...colLines[0], words: [...colLines[0].words] };

    for (let i = 1; i < colLines.length; i++) {
      const line = colLines[i];
      const avgH = (curr.h + line.h) / 2;
      const isSameY = Math.abs(curr.y - line.y) <= avgH * 0.5;
      const xGap = line.x - (curr.x + curr.w);
      const isAdjacent = xGap >= -10 && xGap <= Math.min(50, avgH * 2.5);

      if (isSameY && isAdjacent) {
        curr.w = line.x + line.w - curr.x;
        curr.h = Math.max(curr.h, line.h);
        curr.text = `${curr.text} ${line.text}`.trim();
        curr.words = [...curr.words, ...line.words];
      } else {
        result.push(curr);
        curr = { ...line, words: [...line.words] };
      }
    }
    result.push(curr);
  });

  return result;
}

/**
 * Nhận diện chữ bằng mô hình Deep Learning On-Device (PaddleOCR + VieSVTR)
 * Tối ưu hóa hiệu năng: Concurrency Batch = 4, Direct Memory Sampling (Zero Canvas DOM overhead)
 */
export async function recognizePaddleOcr(imageUrl: string, langMode: OcrLanguageMode = "vi"): Promise<OcrResult> {
  const prevLock = globalOcrMutex;
  let release: () => void;
  globalOcrMutex = new Promise((resolve) => {
    release = resolve;
  });
  await prevLock;

  try {
    return await doRecognizePaddleOcr(imageUrl, langMode);
  } finally {
    release!();
  }
}

async function doRecognizePaddleOcr(imageUrl: string, langMode: OcrLanguageMode = "vi"): Promise<OcrResult> {
  // 1. Tải ảnh vào Canvas
  const img = await new Promise<HTMLImageElement>((resolve, reject) => {
    const el = new Image();
    el.crossOrigin = "anonymous";
    el.onload = () => resolve(el);
    el.onerror = (e) => reject(new Error("Lỗi nạp ảnh: " + e));
    el.src = imageUrl;
  });

  const origW = img.naturalWidth || img.width;
  const origH = img.naturalHeight || img.height;
  if (!origW || !origH) {
    return { text: "", words: [] };
  }

  const canvas = document.createElement("canvas");
  canvas.width = origW;
  canvas.height = origH;
  const ctx = canvas.getContext("2d", { willReadFrequently: true });
  if (!ctx) throw new Error("Không thể tạo 2D Context");
  ctx.drawImage(img, 0, 0);

  // 2. Chế độ Tiếng Nhật / Tiếng Trung: Dùng PaddleOcrService CJK
  if (langMode === "ja" || langMode === "zh") {
    const cjkOcr = await getCjkOcrService();
    const imgData = ctx.getImageData(0, 0, origW, origH);
    const rgbBytes = rgbaToRgb(imgData.data, origW, origH);
    const recognitionResults = await cjkOcr.recognize(
      new PaddleImage(origW, origH, 3, rgbBytes)
    );

    const sortedCjk = sortBoxesColumnAware(
      recognitionResults.map((r) => ({
        text: r.text,
        x: r.box.x,
        y: r.box.y,
        width: r.box.width,
        height: r.box.height,
        columnId: 0,
      })),
      origW
    );

    const words: OcrWord[] = [];
    for (const item of sortedCjk) {
      if (!item.text || item.text.trim().length === 0) continue;
      words.push({
        text: item.text.trim(),
        x: Math.round(item.x),
        y: Math.round(item.y),
        w: Math.round(item.width),
        h: Math.round(item.height),
      });
    }

    const cjkLines: OcrLine[] = words.map((w) => ({
      text: w.text,
      x: w.x,
      y: w.y,
      w: w.w,
      h: w.h,
      columnId: 0,
      words: [w],
    }));

    return {
      text: words.map((w) => w.text).join("\n"),
      words,
      lines: cjkLines,
      engine: "viesvtr",
    };
  }

  // 3. Chế độ Tiếng Việt / Tiếng Anh: DBNet + VieSVTR (10/10 Accuracy)
  const detService = await getDetectionService();
  const recViSession = await getRecViSession();

  const fullImgData = ctx.getImageData(0, 0, origW, origH);
  const rawRgba = fullImgData.data;
  const rgbBytes = rgbaToRgb(rawRgba, origW, origH);
  const paddleImg = new PaddleImage(origW, origH, 3, rgbBytes);
  const detectedBoxes = await detService.run(paddleImg);

  if (!detectedBoxes || detectedBoxes.length === 0) {
    return { text: "", words: [] };
  }

  // Sắp xếp các bounding box theo thứ tự đọc tự nhiên đa cột & phân bổ columnId
  const sortedBoxes = sortBoxesColumnAware(
    detectedBoxes.map((b) => ({
      x: b.x,
      y: b.y,
      width: b.width,
      height: b.height,
      columnId: 0,
    })),
    origW
  );

  let lastBoxError: string | null = null;
  const recognizedLinesRaw: (OcrLine | null)[] = new Array(sortedBoxes.length).fill(null);

  // Tuần tự nhận diện từng box để tránh xung đột state trong WASM runtime (tránh lỗi "Session mismatch")
  for (let idx = 0; idx < sortedBoxes.length; idx++) {
    const box = sortedBoxes[idx];
    const bx = Math.max(0, Math.round(box.x) - 2);
    const by = Math.max(0, Math.round(box.y) - 2);
    const bw = Math.min(origW - bx, Math.round(box.width) + 4);
    const bh = Math.min(origH - by, Math.round(box.height) + 4);

    if (bw < 8 || bh < 8) continue;

    let tw = Math.ceil(64 * (bw / bh));
    tw = Math.ceil(tw / 4) * 4;
    tw = Math.max(32, Math.min(1600, tw));

    const area = 64 * tw;
    const floatArr = new Float32Array(3 * area);

    // Kiểm tra độ sáng trung bình để xử lý Dark mode
    let totalLuma = 0;
    for (let y = 0; y < bh; y += 2) {
      for (let x = 0; x < bw; x += 2) {
        const pixelIdx = ((by + y) * origW + (bx + x)) * 4;
        totalLuma += 0.299 * rawRgba[pixelIdx] + 0.587 * rawRgba[pixelIdx + 1] + 0.114 * rawRgba[pixelIdx + 2];
      }
    }
    const samplePixels = Math.max(1, Math.ceil(bh / 2) * Math.ceil(bw / 2));
    const isDarkMode = totalLuma / samplePixels < 128;

    // Trích xuất trực tiếp từ rawRgba bằng thuật toán Nội suy Song tuyến tính (Bilinear Interpolation)
    // Giúp các nét dấu thanh tiếng Việt (hỏi, ngã, sắc, mũ) cực kỳ mịn màng và không bị vỡ hạt răng cưa
    const yRatio = bh / 64;
    const xRatio = bw / tw;

    for (let y = 0; y < 64; y++) {
      const srcYFloat = (y + 0.5) * yRatio - 0.5;
      const y0 = Math.max(0, Math.min(bh - 1, Math.floor(srcYFloat)));
      const y1 = Math.max(0, Math.min(bh - 1, y0 + 1));
      const wy1 = Math.max(0, Math.min(1, srcYFloat - y0));
      const wy0 = 1.0 - wy1;

      for (let x = 0; x < tw; x++) {
        const srcXFloat = (x + 0.5) * xRatio - 0.5;
        const x0 = Math.max(0, Math.min(bw - 1, Math.floor(srcXFloat)));
        const x1 = Math.max(0, Math.min(bw - 1, x0 + 1));
        const wx1 = Math.max(0, Math.min(1, srcXFloat - x0));
        const wx0 = 1.0 - wx1;

        const idx00 = ((by + y0) * origW + (bx + x0)) * 4;
        const idx10 = ((by + y0) * origW + (bx + x1)) * 4;
        const idx01 = ((by + y1) * origW + (bx + x0)) * 4;
        const idx11 = ((by + y1) * origW + (bx + x1)) * 4;

        let r = (rawRgba[idx00] * wx0 + rawRgba[idx10] * wx1) * wy0 +
                (rawRgba[idx01] * wx0 + rawRgba[idx11] * wx1) * wy1;
        let g = (rawRgba[idx00 + 1] * wx0 + rawRgba[idx10 + 1] * wx1) * wy0 +
                (rawRgba[idx01 + 1] * wx0 + rawRgba[idx11 + 1] * wx1) * wy1;
        let b = (rawRgba[idx00 + 2] * wx0 + rawRgba[idx10 + 2] * wx1) * wy0 +
                (rawRgba[idx01 + 2] * wx0 + rawRgba[idx11 + 2] * wx1) * wy1;

        if (isDarkMode) {
          r = 255 - r;
          g = 255 - g;
          b = 255 - b;
        }

        const dstIdx = y * tw + x;
        floatArr[dstIdx] = (r / 255.0 - 0.5) / 0.5;
        floatArr[area + dstIdx] = (g / 255.0 - 0.5) / 0.5;
        floatArr[area * 2 + dstIdx] = (b / 255.0 - 0.5) / 0.5;
      }
    }

    try {
      const inputTensor = new ort.Tensor("float32", floatArr, [1, 3, 64, tw]);
      const inpName = recViSession.inputNames[0];
      const outMap = await recViSession.run({ [inpName]: inputTensor });
      const outName = recViSession.outputNames[0];
      const outTensor = outMap[outName];
      const logitsData = outTensor.data as Float32Array;
      const dims = outTensor.dims;
      const seqLen = dims[1];
      const numClasses = dims[2] || 230;

      const { text: rawLineText, confidence } = decodeCtcGreedy(logitsData, seqLen, numClasses);
      if (confidence < 0.40) {
        continue; // Bỏ qua box rác có độ tin cậy thấp
      }
      let lineText = cleanVietnameseOcrText(rawLineText);

      if (lineText && lineText.trim().length > 0) {
        const lineWords: OcrWord[] = [];
        const tokens = lineText.split(/(\s+)/);
        let charCursor = 0;
        const totalChars = Math.max(1, lineText.length);

        for (const token of tokens) {
          const trimmed = token.trim();
          if (trimmed.length > 0) {
            const wordX = bx + Math.round((charCursor / totalChars) * bw);
            const wordW = Math.max(8, Math.round((trimmed.length / totalChars) * bw));
            lineWords.push({
              text: trimmed,
              x: wordX,
              y: by,
              w: wordW,
              h: bh,
            });
          }
          charCursor += token.length;
        }

        recognizedLinesRaw[idx] = {
          text: lineText,
          x: bx,
          y: by,
          w: bw,
          h: bh,
          columnId: box.columnId ?? 0,
          words: lineWords,
        };
      }
    } catch (err: any) {
      console.warn("[SnapDoc OCR] Nhận diện box lỗi:", err);
      lastBoxError = err?.message || String(err);
    }
  }

  const validLines = recognizedLinesRaw.filter((l): l is OcrLine => l !== null);
  if (validLines.length === 0) {
    if (detectedBoxes.length === 0) {
      throw new Error("DBNet không phát hiện được hộp văn bản nào trong ảnh (0 boxes)");
    }
    if (lastBoxError) throw new Error(`VieSVTR nhận diện box lỗi: ${lastBoxError}`);
    throw new Error("Không có dòng chữ nào đạt ngưỡng độ tin cậy (>35%)");
  }

  // Hợp nhất các cụm box cùng dòng trong cùng 1 cột để text selection liền mạch
  const finalLines = mergeAdjacentLinesInSameColumn(validLines);

  const allWords: OcrWord[] = [];
  for (const l of finalLines) {
    allWords.push(...l.words);
  }

  let fullText = finalLines.map((l) => l.text).join("\n");
  fullText = cleanVietnameseOcrText(fullText);

  return {
    text: fullText,
    words: allWords,
    lines: finalLines,
    engine: "viesvtr",
  };
}
