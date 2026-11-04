import {
  type ZoomSegment,
  type FocusZone,
  DEFAULT_ZOOM_SCALE,
  makeZoomSegmentUid,
  clamp,
} from "./types";
import type { MouseTelemetryFile, MouseTelemetryItem } from "../../lib/ipc";
import { type Segment, sourceMsToTimeline } from "./segments";

export interface SmartFocusResult {
  focusX: number;
  focusY: number;
  zone: FocusZone;
}

export const FOCUS_ZONE_PRESETS: {
  zone: FocusZone;
  icon: string;
  focusX: number;
  focusY: number;
}[] = [
  { zone: "center", icon: "🎯", focusX: 0.5, focusY: 0.5 },
  { zone: "left", icon: "⬅", focusX: 0.25, focusY: 0.5 },
  { zone: "right", icon: "➡", focusX: 0.75, focusY: 0.5 },
  { zone: "top", icon: "⬆", focusX: 0.5, focusY: 0.22 },
  { zone: "bottom", icon: "⬇", focusX: 0.5, focusY: 0.78 },
];

/**
 * Nhận diện vùng focus từ toạ độ (focusX, focusY)
 */
export function detectFocusZone(focusX: number, focusY: number): FocusZone {
  const dx = Math.abs(focusX - 0.5);
  const dy = Math.abs(focusY - 0.5);

  if (dx <= 0.08 && dy <= 0.08) return "center";
  if (focusX < 0.38 && dy <= 0.18) return "left";
  if (focusX > 0.62 && dy <= 0.18) return "right";
  if (dx <= 0.18 && focusY < 0.35) return "top";
  if (dx <= 0.18 && focusY > 0.65) return "bottom";
  if (focusX < 0.38 && focusY < 0.35) return "top-left";
  if (focusX > 0.62 && focusY < 0.35) return "top-right";
  if (focusX < 0.38 && focusY > 0.65) return "bottom-left";
  if (focusX > 0.62 && focusY > 0.65) return "bottom-right";
  return "custom";
}

/**
 * Tính toán toạ độ zoom thông minh theo chiến lược phân vùng (Smart Focus Zone Strategy):
 *
 * 1. VÙNG GIỮA (Center Zone - Deadband 34% - 66% ngang, 28% - 72% dọc):
 *    - Khi thao tác trong vùng trung tâm (modal popup, tài liệu, bảng dữ liệu, form...),
 *      tự động KHOÁ CỨNG focusX: 0.5, focusY: 0.5.
 *    - Điều này đảm bảo camera phóng to đối xứng đều từ tâm (Symmetrical Center Zoom),
 *      triệt tiêu hoàn toàn hiện tượng lệch sang phải hay sang trái (translateX=0, translateY=0).
 *
 * 2. CỘT TRÁI (Left Zone - X < 0.34):
 *    - Định vị camera vào cột trái (focusX: 0.25) với lề an toàn để thanh điều hướng / sidebar rõ ràng.
 *
 * 3. CỘT PHẢI (Right Zone - X > 0.66):
 *    - Định vị camera vào cột phải (focusX: 0.75).
 *
 * 4. PHÍA TRÊN (Top Zone - Y < 0.28):
 *    - Định vị camera phía trên (focusY: 0.22) để thấy rõ header/tabs/menu.
 *
 * 5. PHÍA DƯỚI (Bottom Zone - Y > 0.72):
 *    - Định vị camera phía dưới (focusY: 0.78) để thấy rõ dock/terminal/status bar.
 *
 * 6. 4 GÓC:
 *    - Giới hạn toạ độ trong khoảng an toàn (0.20 .. 0.80) để không bao giờ bị cắt viền.
 */
export function calculateSmartFocusPoint(
  rawRelX: number,
  rawRelY: number,
): SmartFocusResult {
  const normX = clamp(rawRelX, 0, 1);
  const normY = clamp(rawRelY, 0, 1);

  const dxFromCenter = Math.abs(normX - 0.5);
  const dyFromCenter = Math.abs(normY - 0.5);

  // 1. Vùng giữa (Center Zone): Chiếm ~32% chiều ngang và ~44% chiều dọc trung tâm
  if (dxFromCenter <= 0.16 && dyFromCenter <= 0.22) {
    return {
      focusX: 0.5,
      focusY: 0.5,
      zone: "center",
    };
  }

  const isLeft = normX < 0.34;
  const isRight = normX > 0.66;
  const isTop = normY < 0.28;
  const isBottom = normY > 0.72;

  // 2. 4 góc
  if (isLeft && isTop) {
    return {
      focusX: clamp(Number(normX.toFixed(4)), 0.2, 0.3),
      focusY: clamp(Number(normY.toFixed(4)), 0.18, 0.28),
      zone: "top-left",
    };
  }
  if (isRight && isTop) {
    return {
      focusX: clamp(Number(normX.toFixed(4)), 0.7, 0.8),
      focusY: clamp(Number(normY.toFixed(4)), 0.18, 0.28),
      zone: "top-right",
    };
  }
  if (isLeft && isBottom) {
    return {
      focusX: clamp(Number(normX.toFixed(4)), 0.2, 0.3),
      focusY: clamp(Number(normY.toFixed(4)), 0.72, 0.82),
      zone: "bottom-left",
    };
  }
  if (isRight && isBottom) {
    return {
      focusX: clamp(Number(normX.toFixed(4)), 0.7, 0.8),
      focusY: clamp(Number(normY.toFixed(4)), 0.72, 0.82),
      zone: "bottom-right",
    };
  }

  // 3. Cột trái / Cột phải
  if (isLeft) {
    const safeY = dyFromCenter <= 0.18 ? 0.5 : clamp(Number(normY.toFixed(4)), 0.3, 0.7);
    return {
      focusX: clamp(Number(normX.toFixed(4)), 0.2, 0.32),
      focusY: safeY,
      zone: "left",
    };
  }
  if (isRight) {
    const safeY = dyFromCenter <= 0.18 ? 0.5 : clamp(Number(normY.toFixed(4)), 0.3, 0.7);
    return {
      focusX: clamp(Number(normX.toFixed(4)), 0.68, 0.8),
      focusY: safeY,
      zone: "right",
    };
  }

  // 4. Phía trên / Phía dưới
  if (isTop) {
    const safeX = dxFromCenter <= 0.16 ? 0.5 : clamp(Number(normX.toFixed(4)), 0.3, 0.7);
    return {
      focusX: safeX,
      focusY: clamp(Number(normY.toFixed(4)), 0.18, 0.28),
      zone: "top",
    };
  }
  if (isBottom) {
    const safeX = dxFromCenter <= 0.16 ? 0.5 : clamp(Number(normX.toFixed(4)), 0.3, 0.7);
    return {
      focusX: safeX,
      focusY: clamp(Number(normY.toFixed(4)), 0.72, 0.82),
      zone: "bottom",
    };
  }

  // Dự phòng: vùng chuyển tiếp
  return {
    focusX: clamp(Number(normX.toFixed(4)), 0.2, 0.8),
    focusY: clamp(Number(normY.toFixed(4)), 0.2, 0.8),
    zone: "custom",
  };
}

/**
 * Quy đổi mốc telemetry (source ms) sang timeline ms theo `segments` (sau
 * trim/tốc độ). Trả null nếu mốc rơi vào đoạn đã xoá. Không có `segments`
 * thì coi source = timeline.
 */
export function telemetryMsToTimeline(segments: Segment[] | undefined, srcMs: number): number | null {
  if (!segments) return srcMs;
  if (!segments.some((s) => srcMs >= s.srcStart && srcMs <= s.srcEnd)) return null;
  return sourceMsToTimeline(segments, srcMs);
}

/**
 * Thuật toán tự động phân tích telemetry chuột và sinh các phân đoạn Zoom (Auto Zoom Segments)
 * chuẩn phong cách Screen Studio kết hợp chiến lược phân vùng toạ độ thông minh.
 *
 * Nguyên lý:
 * 1. Thu thập tất cả sự kiện click và kéo chuột (drag) trong toàn bộ thời lượng video.
 * 2. Gom nhóm các thao tác gần nhau theo thời gian (< 2.2 giây) thành 1 cụm (Cluster).
 * 3. Tính toán trọng tâm (Centroid) toạ độ và chạy qua calculateSmartFocusPoint để chọn phương án zoom hợp lý.
 * 4. Đón đầu thao tác bằng cách zoom-in trước cú click 500ms, và giữ zoom sau cú click 2200ms.
 * 5. Hợp nhất các cụm liền kề nếu khoảng cách thời gian < 800ms để camera chuyển động liền mạch.
 */
export function generateAutoZoomSegments(
  telemetry: MouseTelemetryFile,
  videoDurationMs: number,
  targetScale: number = DEFAULT_ZOOM_SCALE,
  segments?: Segment[],
): ZoomSegment[] {
  if (!telemetry || !telemetry.events || telemetry.events.length === 0) {
    return [];
  }

  const vw = telemetry.videoWidth > 0 ? telemetry.videoWidth : 1920;
  const vh = telemetry.videoHeight > 0 ? telemetry.videoHeight : 1080;
  const totalMs = videoDurationMs > 0 ? videoDurationMs : telemetry.durationMs;

  // 1. Lọc các sự kiện thao tác có chủ đích: click hoặc drag. `e.t` là source
  // ms → quy về timeline ms (bỏ sự kiện nằm trong đoạn đã cắt) trước khi so.
  const actionEvents: MouseTelemetryItem[] = [];
  for (const e of telemetry.events) {
    if (e.type !== "click" && e.type !== "drag") continue;
    const t = telemetryMsToTimeline(segments, e.t);
    if (t === null || t < 0 || (totalMs > 0 && t > totalMs)) continue;
    actionEvents.push(t === e.t ? e : { ...e, t });
  }
  actionEvents.sort((a, b) => a.t - b.t);

  if (actionEvents.length === 0) {
    return [];
  }

  // 2. Gom nhóm các sự kiện thành các cụm (Clusters)
  interface ActionCluster {
    events: MouseTelemetryItem[];
    startMs: number;
    endMs: number;
  }

  const clusters: ActionCluster[] = [];
  let currentCluster: ActionCluster | null = null;
  const CLUSTER_WINDOW_MS = 2200;

  for (const ev of actionEvents) {
    if (!currentCluster) {
      currentCluster = {
        events: [ev],
        startMs: ev.t,
        endMs: ev.t,
      };
    } else {
      if (ev.t - currentCluster.endMs <= CLUSTER_WINDOW_MS) {
        currentCluster.events.push(ev);
        currentCluster.endMs = ev.t;
      } else {
        clusters.push(currentCluster);
        currentCluster = {
          events: [ev],
          startMs: ev.t,
          endMs: ev.t,
        };
      }
    }
  }

  if (currentCluster) {
    clusters.push(currentCluster);
  }

  // 3. Chuyển đổi các cụm thành ZoomSegment với toạ độ thông minh
  const rawSegments: ZoomSegment[] = [];

  for (const cluster of clusters) {
    // Tính toạ độ trọng tâm
    let sumX = 0;
    let sumY = 0;
    for (const ev of cluster.events) {
      sumX += ev.x;
      sumY += ev.y;
    }
    const avgX = sumX / cluster.events.length;
    const avgY = sumY / cluster.events.length;

    // Phân tích toạ độ thông minh theo vùng
    const smart = calculateSmartFocusPoint(avgX / vw, avgY / vh);

    // Đón đầu cú click 500ms và giữ zoom 2200ms sau cú click cuối
    const start = Math.max(0, cluster.startMs - 500);
    const end = Math.min(totalMs, cluster.endMs + 2200);

    if (end - start >= 1000) {
      rawSegments.push({
        id: makeZoomSegmentUid(),
        startTimeMs: Math.round(start),
        endTimeMs: Math.round(end),
        scale: targetScale,
        focusX: smart.focusX,
        focusY: smart.focusY,
        zone: smart.zone,
        easing: "smooth",
        autoGenerated: true,
      });
    }
  }

  // 4. Hợp nhất các đoạn zoom quá gần nhau (< 800ms)
  const mergedSegments: ZoomSegment[] = [];

  for (const seg of rawSegments) {
    if (mergedSegments.length === 0) {
      mergedSegments.push(seg);
    } else {
      const prev = mergedSegments[mergedSegments.length - 1];
      const gap = seg.startTimeMs - prev.endTimeMs;
      const spatialDist = Math.hypot(seg.focusX - prev.focusX, seg.focusY - prev.focusY);

      // Nếu 2 đoạn cách nhau dưới 800ms và không quá xa về mặt không gian -> gộp làm một
      if (gap <= 800 && spatialDist < 0.4) {
        prev.endTimeMs = Math.max(prev.endTimeMs, seg.endTimeMs);
        if (prev.zone === "center" && seg.zone === "center") {
          prev.focusX = 0.5;
          prev.focusY = 0.5;
        } else {
          const avgX = (prev.focusX + seg.focusX) / 2;
          const avgY = (prev.focusY + seg.focusY) / 2;
          const merged = calculateSmartFocusPoint(avgX, avgY);
          prev.focusX = merged.focusX;
          prev.focusY = merged.focusY;
          prev.zone = merged.zone;
        }
      } else {
        mergedSegments.push(seg);
      }
    }
  }

  return mergedSegments;
}

export interface CameraState {
  scale: number;
  focusX: number; // 0.0 .. 1.0
  focusY: number; // 0.0 .. 1.0
  isActive: boolean;
  activeSegmentId: string | null;
}

/**
 * Quintic Smootherstep polynomial: 6p^5 - 15p^4 + 10p^3
 * Có đạo hàm bậc 1 (vận tốc) và bậc 2 (gia tốc) bằng 0 tại cả p=0 và p=1.
 * Đảm bảo vận tốc và gia tốc bắt đầu từ 0 tuyệt đối và dừng lại êm ái,
 * loại bỏ hoàn toàn cảm giác giật cục (zero-jerk transition).
 */
export function smootherstep(p: number): number {
  const t = clamp(p, 0, 1);
  return t * t * t * (t * (t * 6 - 15) + 10);
}

/**
 * Tính toán trạng thái Camera mượt mà tại thời điểm `playheadMs` (60fps/120fps interpolation).
 *
 * Khác với thuật toán cũ (bị lỗi dịch chuyển focusX từ 0.5 về điểm click gây cảm giác "zoom tâm rồi mới dịch"),
 * thuật toán mới khóa cố định điểm focus đích (focusX, focusY) và điều khiển biên độ phóng to
 * theo hàm smootherstep mềm mại 650ms.
 */
export function interpolateCamera(
  segments: ZoomSegment[],
  playheadMs: number,
): CameraState {
  if (!segments || segments.length === 0) {
    return {
      scale: 1.0,
      focusX: 0.5,
      focusY: 0.5,
      isActive: false,
      activeSegmentId: null,
    };
  }

  // Sắp xếp các segments theo thời gian
  const sorted = [...segments].sort((a, b) => a.startTimeMs - b.startTimeMs);

  for (let i = 0; i < sorted.length; i++) {
    const seg = sorted[i];
    if (playheadMs >= seg.startTimeMs && playheadMs <= seg.endTimeMs) {
      const dur = seg.endTimeMs - seg.startTimeMs;
      // Thời gian chuyển tiếp mềm mại: 650ms (chuẩn phong cách Screen Studio),
      // tối đa 35% thời lượng phân đoạn và tối thiểu 280ms
      const rampMs = Math.max(280, Math.min(650, dur * 0.35));

      let factor = 1.0;
      let targetFocusX = seg.focusX;
      let targetFocusY = seg.focusY;
      let baseScale = 1.0;

      if (playheadMs < seg.startTimeMs + rampMs) {
        // Giai đoạn Zoom-in (Ramp in)
        const p = (playheadMs - seg.startTimeMs) / rampMs;
        const eased = smootherstep(p);

        // Nếu có segment liền kề trước đó (chuyển tiếp trực tiếp giữa 2 điểm focus)
        const prev = i > 0 ? sorted[i - 1] : null;
        if (prev && Math.abs(seg.startTimeMs - prev.endTimeMs) < 60) {
          const curScale = prev.scale + (seg.scale - prev.scale) * eased;
          const curFocusX = prev.focusX + (seg.focusX - prev.focusX) * eased;
          const curFocusY = prev.focusY + (seg.focusY - prev.focusY) * eased;
          return {
            scale: curScale,
            focusX: curFocusX,
            focusY: curFocusY,
            isActive: curScale > 1.002,
            activeSegmentId: seg.id,
          };
        } else {
          factor = eased;
        }
      } else if (playheadMs > seg.endTimeMs - rampMs) {
        // Giai đoạn Zoom-out (Ramp out)
        const next = i < sorted.length - 1 ? sorted[i + 1] : null;
        if (next && Math.abs(next.startTimeMs - seg.endTimeMs) < 60) {
          // Đoạn sau sẽ tự động nối mượt
          factor = 1.0;
        } else {
          const p = (seg.endTimeMs - playheadMs) / rampMs;
          factor = smootherstep(p);
        }
      }

      factor = clamp(factor, 0.0, 1.0);
      const curScale = baseScale + (seg.scale - baseScale) * factor;

      return {
        scale: curScale,
        focusX: targetFocusX,
        focusY: targetFocusY,
        isActive: curScale > 1.002,
        activeSegmentId: seg.id,
      };
    }
  }

  return {
    scale: 1.0,
    focusX: 0.5,
    focusY: 0.5,
    isActive: false,
    activeSegmentId: null,
  };
}

/**
 * Chuyển đổi trạng thái Camera thành giá trị CSS transform (dịch chuyển translate3d và phóng to scale)
 * có giới hạn biên tự động (clamping) để video KHÔNG BAO GIỜ bị lộ viền đen ra ngoài khung nhìn.
 *
 * Sử dụng subpixel precision (.toFixed(2)) và translate3d để kích hoạt GPU hardware compositing,
 * triệt tiêu hoàn toàn hiện tượng rung giật pixel.
 */
export function calculateCameraTransform(
  camera: CameraState,
  containerWidth: number,
  containerHeight: number,
): { transform: string; translateX: number; translateY: number; scale: number } {
  const { scale, focusX, focusY } = camera;

  if (scale <= 1.001 || containerWidth <= 0 || containerHeight <= 0) {
    return {
      transform: "translate3d(0px, 0px, 0) scale(1)",
      translateX: 0,
      translateY: 0,
      scale: 1.0,
    };
  }

  // Giới hạn dịch chuyển tối đa để mép video không rời khỏi khung chứa
  const maxShiftX = (containerWidth * (scale - 1)) / 2;
  const maxShiftY = (containerHeight * (scale - 1)) / 2;

  // Độ dịch chuyển cần thiết để đưa điểm focus (focusX, focusY) vào chính giữa khung hình
  // Tại tỉ lệ scale, khoảng cách từ focus đến tâm (focusX - 0.5) được nhân với containerWidth * scale
  const rawShiftX = -(focusX - 0.5) * containerWidth * scale;
  const rawShiftY = -(focusY - 0.5) * containerHeight * scale;

  const tx = clamp(rawShiftX, -maxShiftX, maxShiftX);
  const ty = clamp(rawShiftY, -maxShiftY, maxShiftY);

  return {
    transform: `translate3d(${tx.toFixed(2)}px, ${ty.toFixed(2)}px, 0) scale(${scale.toFixed(4)})`,
    translateX: tx,
    translateY: ty,
    scale,
  };
}


// ============================================================================
// SCREEN STUDIO CINEMATIC ENGINE: BEZIER SMOOTH CURSOR & DYNAMIC CLICK-ZOOM
// ============================================================================

export interface ClickRipple {
  id: string;
  x: number; // 0..1 relative to video
  y: number; // 0..1 relative to video
  pixelX: number;
  pixelY: number;
  progress: number; // 0.0 -> 1.0
  button: "left" | "right" | "middle";
  radiusPx: number;
  opacity: number;
}

export interface SmoothCursorState {
  x: number; // 0..1
  y: number; // 0..1
  pixelX: number;
  pixelY: number;
  visible: boolean;
  isClicking: boolean;
  clickScale: number; // 1.0 -> 0.88
  button: "left" | "right" | "middle";
  ripples: ClickRipple[];
}

/**
 * Nội suy Hermite Spline 1D với vận tốc tiếp tuyến đầu/cuối.
 * Đảm bảo liên tục đạo hàm bậc 1 (C1 continuity), không bao giờ có góc gãy nhọn.
 */
export function interpolateHermite(
  p1: number,
  p2: number,
  v1: number,
  v2: number,
  dt: number,
  u: number,
): number {
  const t = clamp(u, 0, 1);
  const t2 = t * t;
  const t3 = t2 * t;

  const h00 = 2 * t3 - 3 * t2 + 1;
  const h10 = t3 - 2 * t2 + t;
  const h01 = -2 * t3 + 3 * t2;
  const h11 = t3 - t2;

  return h00 * p1 + h10 * (dt * v1) + h01 * p2 + h11 * (dt * v2);
}

/**
 * Tìm kiếm nhị phân (Binary Search O(log N)) chỉ số phần tử có event.t <= targetMs.
 */
export function findEventIndexAtTime(events: MouseTelemetryItem[], targetMs: number): number {
  if (events.length === 0) return -1;
  if (targetMs < events[0].t) return 0;
  if (targetMs >= events[events.length - 1].t) return events.length - 1;

  let low = 0;
  let high = events.length - 1;
  let result = 0;

  while (low <= high) {
    const mid = (low + high) >> 1;
    if (events[mid].t <= targetMs) {
      result = mid;
      low = mid + 1;
    } else {
      high = mid - 1;
    }
  }

  return result;
}

/**
 * Tính toán toạ độ và trạng thái con trỏ chuột mượt mà (Cinematic Bezier / Hermite Spline)
 * cùng hiệu ứng sóng nước click (Ripple Waves) tại thời điểm playheadMs.
 */
export function getSmoothCursorState(
  telemetry: MouseTelemetryFile | null | undefined,
  playheadMs: number,
  segments?: Segment[],
  options?: {
    deadbandPx?: number; // Ngưỡng khử rung tay (mặc định 2.5px)
    rippleDurationMs?: number; // Thời gian vòng sóng nước mở rộng (mặc định 420ms)
    maxClickScaleDown?: number; // Độ co của con trỏ khi click (mặc định 0.88)
  },
): SmoothCursorState {
  const deadbandPx = options?.deadbandPx ?? 2.5;
  const rippleDurationMs = options?.rippleDurationMs ?? 420;
  const maxClickScaleDown = options?.maxClickScaleDown ?? 0.88;

  const defaultState: SmoothCursorState = {
    x: 0.5,
    y: 0.5,
    pixelX: 960,
    pixelY: 540,
    visible: false,
    isClicking: false,
    clickScale: 1.0,
    button: "left",
    ripples: [],
  };

  if (!telemetry || !telemetry.events || telemetry.events.length === 0) {
    return defaultState;
  }

  const vw = telemetry.videoWidth > 0 ? telemetry.videoWidth : 1920;
  const vh = telemetry.videoHeight > 0 ? telemetry.videoHeight : 1080;

  // Chuẩn hoá timeline events nếu có phân đoạn trim/tốc độ
  const timelineEvents: MouseTelemetryItem[] = [];
  for (const ev of telemetry.events) {
    const t = telemetryMsToTimeline(segments, ev.t);
    if (t !== null && t >= 0) {
      timelineEvents.push(t === ev.t ? ev : { ...ev, t });
    }
  }
  timelineEvents.sort((a, b) => a.t - b.t);

  if (timelineEvents.length === 0) {
    return defaultState;
  }

  const firstT = timelineEvents[0].t;
  const lastT = timelineEvents[timelineEvents.length - 1].t;

  // Nếu playhead nằm ngoài dải sự kiện > 1.5s thì ẩn con trỏ
  if (playheadMs < firstT - 1500 || playheadMs > lastT + 1500) {
    return { ...defaultState, visible: false };
  }

  // 1. Quét tìm các hiệu ứng sóng nước (Ripple Click Waves) gần playhead
  const ripples: ClickRipple[] = [];
  let isCurrentlyClicking = false;
  let activeClickButton: "left" | "right" | "middle" = "left";

  for (const ev of timelineEvents) {
    if (ev.type === "click") {
      const dt = playheadMs - ev.t;
      if (dt >= 0 && dt <= rippleDurationMs) {
        const p = dt / rippleDurationMs;
        const easedP = smootherstep(p);
        const radius = 8 + 36 * easedP;
        const opacity = Math.max(0, 0.85 * (1 - p));

        ripples.push({
          id: `rip_${ev.t}_${ev.x}_${ev.y}`,
          x: clamp(ev.x / vw, 0, 1),
          y: clamp(ev.y / vh, 0, 1),
          pixelX: ev.x,
          pixelY: ev.y,
          progress: p,
          button: ev.button || "left",
          radiusPx: radius,
          opacity,
        });

        if (dt <= 140) {
          isCurrentlyClicking = true;
          activeClickButton = ev.button || "left";
        }
      }
    }
  }

  // 2. Định vị vị trí con trỏ chuột bằng Hermite / Catmull-Rom Spline
  const idx = findEventIndexAtTime(timelineEvents, playheadMs);
  const p1 = timelineEvents[idx];
  const p2 = idx < timelineEvents.length - 1 ? timelineEvents[idx + 1] : p1;

  let currentX = p1.x;
  let currentY = p1.y;

  if (p1 !== p2 && p2.t > p1.t) {
    const p0 = idx > 0 ? timelineEvents[idx - 1] : p1;
    const p3 = idx + 2 < timelineEvents.length ? timelineEvents[idx + 2] : p2;

    const dt = (p2.t - p1.t) / 1000; // Đổi sang giây
    let u = (playheadMs - p1.t) / (p2.t - p1.t);

    // Nếu điểm đích p2 là cú click -> áp dụng easing giảm tốc mượt mà (ease-out deceleration)
    if (p2.type === "click") {
      u = Math.sin((u * Math.PI) / 2);
    }

    // Tính vận tốc tại p1 và p2 theo Catmull-Rom tiếp tuyến
    const dt02 = Math.max(0.001, (p2.t - p0.t) / 1000);
    const dt13 = Math.max(0.001, (p3.t - p1.t) / 1000);

    const vx1 = (p2.x - p0.x) / dt02;
    const vy1 = (p2.y - p0.y) / dt02;
    const vx2 = (p3.x - p1.x) / dt13;
    const vy2 = (p3.y - p1.y) / dt13;

    // Khoảng cách dịch chuyển thực tế
    const dist = Math.hypot(p2.x - p1.x, p2.y - p1.y);

    if (dist < deadbandPx && p2.type !== "click") {
      // Khử rung tay: nếu khoảng di chuyển < deadbandPx thì giữ nguyên p1
      currentX = p1.x;
      currentY = p1.y;
    } else {
      currentX = interpolateHermite(p1.x, p2.x, vx1, vx2, dt, u);
      currentY = interpolateHermite(p1.y, p2.y, vy1, vy2, dt, u);
    }
  }

  // Giới hạn trong kích thước video
  const clampedPxX = clamp(currentX, 0, vw);
  const clampedPxY = clamp(currentY, 0, vh);

  // Hiệu ứng co nhẹ con trỏ khi click (1.0 -> maxClickScaleDown)
  const clickScale = isCurrentlyClicking ? maxClickScaleDown : 1.0;

  return {
    x: clamp(clampedPxX / vw, 0, 1),
    y: clamp(clampedPxY / vh, 0, 1),
    pixelX: clampedPxX,
    pixelY: clampedPxY,
    visible: true,
    isClicking: isCurrentlyClicking,
    clickScale,
    button: activeClickButton,
    ripples,
  };
}
