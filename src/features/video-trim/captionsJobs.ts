import { useEffect, useRef, useSyncExternalStore } from "react";
import { listen } from "@tauri-apps/api/event";
import {
  ipc,
  type CaptionSegment,
  type CaptionsJobFinished,
  type CaptionsJobKind,
  type CaptionsProgress,
} from "../../lib/ipc";
import { saveCachedCaptions } from "./captionUtils";

/**
 * Trạng thái các tác vụ phụ đề chạy NỀN (tải model, nhận diện giọng nói, xuất video).
 *
 * Việc thật nằm ở backend (`captions.rs`); store này chỉ phản chiếu nó cho giao
 * diện. Nó sống ở mức module (không gắn vào component nào) nên đóng hộp thoại phụ
 * đề, đổi video, hay remount Editor đều không làm mất tiến độ; còn kết quả nhận
 * diện do backend giữ cho tới khi `useCaptionsAutoApply` nhận.
 */
export interface CaptionsJobsState {
  download: CaptionsProgress | null;
  transcribe: CaptionsProgress | null;
  exporting: CaptionsProgress | null;
  /** Lỗi gần nhất của từng loại tác vụ, để hộp thoại hiện lại cho người dùng. */
  downloadError: string | null;
  transcribeError: { videoPath: string; message: string } | null;
  /** Tăng sau mỗi lần 1 tác vụ kết thúc → UI nạp lại trạng thái model đã cài. */
  finishedSeq: number;
}

let state: CaptionsJobsState = {
  download: null,
  transcribe: null,
  exporting: null,
  downloadError: null,
  transcribeError: null,
  finishedSeq: 0,
};

const listeners = new Set<() => void>();
const finishedListeners = new Set<(e: CaptionsJobFinished) => void>();

function setState(patch: Partial<CaptionsJobsState>) {
  state = { ...state, ...patch };
  listeners.forEach((l) => l());
}

const slotOf = (job: CaptionsJobKind): "download" | "transcribe" | "exporting" =>
  job === "export" ? "exporting" : job;

let initPromise: Promise<void> | null = null;

/** Đăng ký lắng nghe sự kiện (1 lần cho cả cửa sổ) rồi đồng bộ với tác vụ đang chạy ở backend. */
export function initCaptionsJobs(): Promise<void> {
  if (initPromise) return initPromise;
  initPromise = (async () => {
    await listen<CaptionsProgress>("captions-progress", (e) => {
      setState({ [slotOf(e.payload.job)]: e.payload } as Partial<CaptionsJobsState>);
    });
    await listen<CaptionsJobFinished>("captions-job-finished", (e) => {
      const f = e.payload;
      const patch: Partial<CaptionsJobsState> = {
        [slotOf(f.job)]: null,
        finishedSeq: state.finishedSeq + 1,
      } as Partial<CaptionsJobsState>;
      if (f.job === "download") patch.downloadError = f.error ?? null;
      setState(patch);
      finishedListeners.forEach((l) => l(f));
    });
    // Nối lại với tác vụ đã chạy từ trước khi cửa sổ này mở.
    const snap = await ipc.captionsJobs().catch(() => null);
    if (snap) {
      const patch: Partial<CaptionsJobsState> = {};
      for (const p of snap.running) (patch as Record<string, unknown>)[slotOf(p.job)] = p;
      if (Object.keys(patch).length) setState(patch);
    }
  })().catch((e) => {
    initPromise = null; // cho phép thử lại lần sau
    console.warn("[SnapDoc] Không khởi tạo được theo dõi phụ đề:", e);
  });
  return initPromise;
}

export function getCaptionsJobs(): CaptionsJobsState {
  return state;
}

export function subscribeCaptionsJobs(cb: () => void): () => void {
  listeners.add(cb);
  return () => listeners.delete(cb);
}

export function useCaptionsJobs(): CaptionsJobsState {
  useEffect(() => {
    void initCaptionsJobs();
  }, []);
  return useSyncExternalStore(subscribeCaptionsJobs, getCaptionsJobs, getCaptionsJobs);
}

export function clearCaptionsError(kind: "download" | "transcribe") {
  if (kind === "download") setState({ downloadError: null });
  else setState({ transcribeError: null });
}

export function setTranscribeError(videoPath: string, message: string) {
  setState({ transcribeError: { videoPath, message } });
}

/**
 * Nhận kết quả nhận diện của `filePath` ngay khi nó xong (kể cả khi hộp thoại phụ
 * đề đang đóng) — và cả kết quả đã xong từ trước lúc Editor này mở (vd người dùng đã
 * đóng Editor giữa chừng). `onApply` chỉ được gọi với kết quả mới, đúng 1 lần.
 */
export function useCaptionsAutoApply(
  filePath: string,
  onApply: (segments: CaptionSegment[], language: string) => void,
  onFail?: (message: string) => void,
) {
  const applyRef = useRef(onApply);
  const failRef = useRef(onFail);
  applyRef.current = onApply;
  failRef.current = onFail;

  useEffect(() => {
    let disposed = false;
    const claim = async () => {
      if (disposed) return;
      const o = await ipc.captionsTakeOutcome(filePath).catch(() => null);
      if (!o) return;
      if (disposed) {
        // Editor đóng/đổi video đúng lúc ta vừa nhận kết quả: ghi vào bộ nhớ đệm theo
        // video để lần mở sau (nạp từ `loadCachedCaptions`) vẫn có phụ đề, không mất.
        if (o.ok) saveCachedCaptions(filePath, o.language, o.segments);
        return;
      }
      if (o.ok) applyRef.current(o.segments, o.language);
      else {
        const msg = o.error ?? "Tạo phụ đề thất bại.";
        setTranscribeError(filePath, msg);
        failRef.current?.(msg);
      }
    };
    void initCaptionsJobs().then(() => {
      if (!disposed) void claim();
    });
    const onFinished = (f: CaptionsJobFinished) => {
      if (f.job === "transcribe" && f.videoPath === filePath) void claim();
    };
    finishedListeners.add(onFinished);
    return () => {
      disposed = true;
      finishedListeners.delete(onFinished);
    };
  }, [filePath]);
}

export function fmtElapsed(ms: number): string {
  const total = Math.max(0, Math.floor(ms / 1000));
  const m = Math.floor(total / 60);
  const s = total % 60;
  return `${m}:${String(s).padStart(2, "0")}`;
}
