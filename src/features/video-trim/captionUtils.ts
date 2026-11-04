import type { CaptionSegment } from "../../lib/ipc";
import { segmentPlayMs, type Segment } from "./segments";

/** Phụ đề chỉ còn sót < ngần này ms (trong video GỐC) sau khi cắt thì bỏ —
 * tránh chớp 1 dòng phụ đề vài khung hình ở mép đoạn bị cắt. */
const MIN_REMNANT_SRC_MS = 150;

/**
 * Quy đổi phụ đề từ mốc thời gian của video GỐC sang timeline của video ĐÃ
 * chỉnh sửa (cắt đoạn + đổi tốc độ), khớp đúng cách backend ghép các đoạn
 * (`computeKeepRanges` trên `effectiveSegments`).
 *
 * - Phụ đề nằm trọn trong đoạn bị xoá → bỏ.
 * - Phụ đề vắt qua đoạn bị xoá → giữ phần còn lại (liền mạch thành 1 dòng
 *   nếu 2 phần sau khi ghép nằm sát nhau).
 * - Tốc độ x → thời lượng hiển thị chia x.
 */
export function mapCaptionsToTimeline(captions: CaptionSegment[], segments: Segment[]): CaptionSegment[] {
  const bases: number[] = [];
  let acc = 0;
  for (const seg of segments) {
    bases.push(acc);
    acc += segmentPlayMs(seg);
  }

  const out: CaptionSegment[] = [];
  for (const cap of captions) {
    const text = cap.text.trim();
    if (!text) continue;
    const capDur = Math.max(0, cap.endMs - cap.startMs);
    const minRemnant = Math.min(MIN_REMNANT_SRC_MS, capDur);
    const pieces: CaptionSegment[] = [];

    segments.forEach((seg, i) => {
      const speed = seg.speed != null && seg.speed > 0 ? seg.speed : 1;
      const s = Math.max(cap.startMs, seg.srcStart);
      const e = Math.min(cap.endMs, seg.srcEnd);
      if (e <= s || e - s < minRemnant) return;
      const startMs = Math.round(bases[i] + (s - seg.srcStart) / speed);
      const endMs = Math.max(startMs + 1, Math.round(bases[i] + (e - seg.srcStart) / speed));
      const prev = pieces[pieces.length - 1];
      if (prev && startMs - prev.endMs <= 1) {
        prev.endMs = endMs;
      } else {
        pieces.push({ startMs, endMs, text });
      }
    });
    out.push(...pieces);
  }
  return out.sort((a, b) => a.startMs - b.startMs);
}

/** Dòng phụ đề đang hiển thị tại mốc `srcMs` (ms trong video gốc), hoặc null. */
export function activeCaptionAt(captions: CaptionSegment[], srcMs: number): CaptionSegment | null {
  for (const c of captions) {
    if (srcMs >= c.startMs && srcMs < c.endMs) return c;
  }
  return null;
}

/* ───────────── Bộ nhớ đệm phụ đề theo từng video (localStorage) ───────────── */

export interface CachedCaptions {
  language: string;
  segments: CaptionSegment[];
}

const cacheKey = (filePath: string) => `snapdoc.captions.v1:${filePath}`;
export const CAPTIONS_PREVIEW_KEY = "snapdoc.captions.preview";

export function loadCachedCaptions(filePath: string): CachedCaptions | null {
  try {
    const raw = localStorage.getItem(cacheKey(filePath));
    if (!raw) return null;
    const c = JSON.parse(raw) as CachedCaptions;
    if (!Array.isArray(c.segments)) return null;
    const segments = c.segments.filter(
      (s) =>
        s &&
        typeof s.text === "string" &&
        Number.isFinite(s.startMs) &&
        Number.isFinite(s.endMs),
    );
    return { language: typeof c.language === "string" ? c.language : "auto", segments };
  } catch {
    return null;
  }
}

/** Lưu phụ đề của 1 video; danh sách rỗng = xoá bản đã lưu. */
export function saveCachedCaptions(filePath: string, language: string, segments: CaptionSegment[]) {
  try {
    if (segments.length === 0) {
      localStorage.removeItem(cacheKey(filePath));
    } else {
      localStorage.setItem(cacheKey(filePath), JSON.stringify({ language, segments } satisfies CachedCaptions));
    }
  } catch {
    // localStorage có thể bị chặn — chỉ là tiện ích, bỏ qua.
  }
}
