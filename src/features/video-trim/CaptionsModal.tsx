import { useCallback, useEffect, useMemo, useState } from "react";
import { useTranslation } from "react-i18next";
import { listen } from "@tauri-apps/api/event";
import { save } from "@tauri-apps/plugin-dialog";
import {
  ipc,
  type CaptionSegment,
  type CaptionsProgress,
  type CaptionsStatus,
  type KeepRange,
} from "../../lib/ipc";
import { dirnameOf, promptSaveVideoPath } from "../output/useOutput";
import type { Segment } from "./segments";
import type { VideoCrop, VideoOverlayItem, ZoomSegment } from "./types";
import { mapCaptionsToTimeline } from "./captionUtils";
import { clearCaptionsError, fmtElapsed, useCaptionsJobs } from "./captionsJobs";

/** Các tham số y hệt "Lưu thành video mới" dùng để dựng bản đã chỉnh sửa. */
export interface CaptionEditPayload {
  keepRanges: KeepRange[];
  removeAudio: boolean;
  overlays: VideoOverlayItem[];
  zoomSegments: ZoomSegment[];
  crop: VideoCrop | null;
}

export interface CaptionsModalProps {
  open: boolean;
  onClose: () => void;
  /** Đường dẫn file video thật trên đĩa (nguồn để nhận diện giọng nói). */
  filePath: string;
  durationMs: number;
  /** Phụ đề hiện có (mốc thời gian theo video GỐC) + ngôn ngữ của chúng. */
  segments: CaptionSegment[];
  language: string;
  onChange: (segments: CaptionSegment[], language: string) => void;
  /** Hiện phụ đề ngay trên trình phát. */
  showOnPlayer: boolean;
  onShowOnPlayerChange: (show: boolean) => void;
  /** Video đang có chỉnh sửa (cắt/tốc độ/overlay/zoom/crop) so với file gốc. */
  edited: boolean;
  /** Các đoạn hiệu lực (đã gồm tốc độ) — dùng để quy mốc gốc → timeline đã chỉnh. */
  timelineSegments: Segment[];
  /** Id History của video — cần để xuất bản ĐÃ chỉnh sửa kèm phụ đề. */
  sourceHistoryId?: string;
  getEditPayload: () => CaptionEditPayload;
  /** Nhảy tới mốc thời gian (ms) trên video GỐC khi bấm vào 1 dòng phụ đề. */
  onSeekSource?: (srcMs: number) => void;
  onFlash?: (msg: string) => void;
}

/** Chỉ xuất video còn chạy "trong" hộp thoại (nó cần các tham số chỉnh sửa hiện tại);
 * tải model và nhận diện giọng nói chạy NỀN, không gắn với hộp thoại. */
type Job = null | "export";

const LANGS: { code: string; label: string }[] = [
  { code: "auto", label: "Tự nhận diện" },
  { code: "vi", label: "Tiếng Việt" },
  { code: "en", label: "English" },
  { code: "ja", label: "日本語" },
  { code: "zh", label: "中文" },
  { code: "ko", label: "한국어" },
  { code: "fr", label: "Français" },
  { code: "de", label: "Deutsch" },
  { code: "es", label: "Español" },
  { code: "pt", label: "Português" },
  { code: "it", label: "Italiano" },
  { code: "ru", label: "Русский" },
  { code: "th", label: "ไทย" },
  { code: "id", label: "Bahasa Indonesia" },
];

const MODEL_ORDER = ["small", "turbo", "base"] as const;

const LANG_KEY = "snapdoc.captions.lang";
const MODEL_KEY = "snapdoc.captions.model";

function readLS(key: string): string | null {
  try {
    return localStorage.getItem(key);
  } catch {
    return null;
  }
}

function writeLS(key: string, value: string) {
  try {
    localStorage.setItem(key, value);
  } catch {
    // localStorage có thể bị chặn — chỉ là tiện ích, bỏ qua.
  }
}

function fmtClock(ms: number): string {
  const total = Math.max(0, Math.floor(ms / 1000));
  const m = Math.floor(total / 60);
  const s = total % 60;
  return `${m}:${String(s).padStart(2, "0")}`;
}

function fmtMB(bytes: number): string {
  return `${Math.round(bytes / (1024 * 1024))} MB`;
}

function stemOf(path: string): string {
  const base = path.replace(/^.*[\\/]/, "");
  return base.replace(/\.[^.]+$/, "") || "video";
}

export default function CaptionsModal({
  open,
  onClose,
  filePath,
  durationMs,
  segments,
  language,
  onChange,
  showOnPlayer,
  onShowOnPlayerChange,
  edited,
  timelineSegments,
  sourceHistoryId,
  getEditPayload,
  onSeekSource,
  onFlash,
}: CaptionsModalProps) {
  const { t } = useTranslation();
  const tt = useCallback(
    (key: string, def: string, opts?: Record<string, unknown>) =>
      t(`captions.${key}`, { defaultValue: def, ...opts }),
    [t],
  );

  const jobs = useCaptionsJobs();
  const [status, setStatus] = useState<CaptionsStatus | null>(null);
  const [modelId, setModelId] = useState<string>(() => readLS(MODEL_KEY) ?? "small");
  /** Các model được tick để tải (có thể tải nhiều model cùng lúc, lần lượt ở nền). */
  const [dlSel, setDlSel] = useState<string[]>(["small"]);
  const [spoken, setSpoken] = useState<string>(() => readLS(LANG_KEY) ?? "auto");
  const [matchEdits, setMatchEdits] = useState(true);
  const [job, setJob] = useState<Job>(null);
  const [exportProgress, setExportProgress] = useState<CaptionsProgress | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [, tick] = useState(0);

  const refreshStatus = useCallback(() => {
    ipc
      .captionsStatus()
      .then((s) => {
        setStatus(s);
        setModelId((cur) => {
          if (s.models.find((m) => m.id === cur)?.installed) return cur;
          const firstInstalled = MODEL_ORDER.find((id) => s.models.find((m) => m.id === id)?.installed);
          return firstInstalled ?? cur;
        });
        // Model đã cài thì không còn nằm trong danh sách "cần tải".
        // Chưa cài model nào mà danh sách chọn trống → chọn lại model khuyên dùng.
        setDlSel((sel) => {
          const left = sel.filter((id) => !s.models.find((m) => m.id === id)?.installed);
          return left.length === 0 && !s.models.some((m) => m.installed) ? ["small"] : left;
        });
      })
      .catch((e) => setError(String(e)));
  }, []);

  useEffect(() => {
    if (!open) return;
    setError(null);
    refreshStatus();
  }, [open, refreshStatus]);

  // Có tác vụ nền kết thúc (tải xong 1 lượt model…) → nạp lại model nào đã cài.
  useEffect(() => {
    if (open) refreshStatus();
  }, [open, jobs.finishedSeq, refreshStatus]);

  // Đồng hồ "đã chạy …" cập nhật mỗi giây khi có tác vụ nền.
  const hasBg = !!(jobs.transcribe || jobs.download);
  useEffect(() => {
    if (!open || !hasBg) return;
    const id = window.setInterval(() => tick((n) => n + 1), 1000);
    return () => window.clearInterval(id);
  }, [open, hasBg]);

  // Tiến độ xuất video (chạy trong hộp thoại) — tải model/nhận diện do store nền lo.
  useEffect(() => {
    if (!open) return;
    let disposed = false;
    const unlistens: Array<() => void> = [];
    const track = (p: Promise<() => void>) =>
      p.then((fn) => {
        if (disposed) fn();
        else unlistens.push(fn);
      });
    track(
      listen<CaptionsProgress>("captions-progress", (e) => {
        if (e.payload.job === "export") setExportProgress(e.payload);
      }),
    );
    // Tiến độ bước "áp dụng chỉnh sửa" (cắt/tốc độ/overlay) trước khi ghi phụ đề.
    track(
      listen<number>("trim-progress", (e) =>
        setExportProgress({
          job: "export",
          stage: "edit",
          percent: Math.round(Math.min(1, Math.max(0, e.payload)) * 100),
          doneBytes: 0,
          totalBytes: 0,
          index: 0,
          count: 0,
          startedMs: 0,
        }),
      ),
    );
    return () => {
      disposed = true;
      unlistens.forEach((fn) => fn());
    };
  }, [open]);

  const exporting = job === "export";

  useEffect(() => {
    if (!open) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape" && !exporting) onClose();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [open, exporting, onClose]);

  const modelInstalled = !!status?.models.find((m) => m.id === modelId)?.installed;
  const ready = !!status?.engineInstalled && modelInstalled;
  const transcribing = !!jobs.transcribe;
  const transcribingOther = !!jobs.transcribe && jobs.transcribe.videoPath !== filePath;
  const downloading = !!jobs.download;
  const hasCaptions = segments.length > 0;
  /** Khoá thao tác ghi đè dữ liệu phụ đề chỉ khi đang xuất video (nhận diện/tải chạy nền, không khoá). */
  const busy = exporting;
  const transcribeError = jobs.transcribeError && jobs.transcribeError.videoPath === filePath ? jobs.transcribeError.message : null;

  const run = async (kind: Exclude<Job, null>, fn: () => Promise<void>) => {
    setJob(kind);
    setExportProgress(null);
    setError(null);
    try {
      await fn();
    } catch (e) {
      const msg = String(e);
      if (!msg.includes("Đã huỷ")) setError(msg);
    } finally {
      setJob(null);
      setExportProgress(null);
      refreshStatus();
    }
  };

  const doInstall = async () => {
    setError(null);
    clearCaptionsError("download");
    try {
      // Tải ở nền, lần lượt từng model đã chọn; hộp thoại có thể đóng ngay.
      await ipc.captionsSetup(dlSel);
    } catch (e) {
      setError(String(e));
    }
  };

  const toggleDl = (id: string) =>
    setDlSel((sel) => (sel.includes(id) ? sel.filter((x) => x !== id) : [...sel, id]));

  const doGenerate = async () => {
    setError(null);
    clearCaptionsError("transcribe");
    writeLS(LANG_KEY, spoken);
    writeLS(MODEL_KEY, modelId);
    try {
      // Chạy NỀN: trả về ngay → thu nhỏ thành popup tiến độ để người dùng làm việc khác.
      await ipc.captionsTranscribeStart(filePath, spoken, modelId);
      onFlash?.(tt("startedBg", "Đang tạo phụ đề ở nền — bạn cứ tiếp tục chỉnh sửa, xong sẽ có thông báo"));
      onClose();
    } catch (e) {
      setError(String(e));
    }
  };

  const defaultDir = async (): Promise<string> => {
    const settings = await ipc.getSettings().catch(() => null);
    return (
      settings?.lastVideoSaveAsDir ||
      settings?.saveDir ||
      (await ipc.defaultSaveDir().catch(() => "")) ||
      dirnameOf(filePath)
    );
  };

  /** Phụ đề dùng khi xuất .srt: theo timeline ĐÃ chỉnh sửa (nếu người dùng chọn) hoặc theo video gốc. */
  const srtSegments = useMemo(
    () => (edited && matchEdits ? mapCaptionsToTimeline(segments, timelineSegments) : segments),
    [edited, matchEdits, segments, timelineSegments],
  );

  const doCopy = async () => {
    await ipc.copyText(segments.map((s) => s.text).join("\n"));
    onFlash?.(tt("copied", "Đã copy nội dung phụ đề"));
  };

  const doSaveSrt = async () => {
    if (srtSegments.length === 0) {
      setError(tt("noneKept", "Không còn phụ đề nào nằm trong phần video được giữ lại."));
      return;
    }
    const dir = await defaultDir();
    const path = await save({
      defaultPath: `${dir}/${stemOf(filePath)}.srt`,
      filters: [{ name: "SubRip", extensions: ["srt"] }],
    });
    if (!path) return;
    setError(null);
    try {
      await ipc.captionsSaveSrt(path, srtSegments);
      onFlash?.(tt("savedSrt", "Đã lưu file phụ đề (.srt)"));
    } catch (e) {
      setError(String(e));
    }
  };

  const doExportVideo = async (mode: "soft" | "burn") => {
    // Có chỉnh sửa: xuất BẢN ĐÃ chỉnh sửa (cùng pipeline "Lưu thành video mới")
    // rồi ghi phụ đề — mốc phụ đề đã được quy sang timeline mới.
    if (edited) {
      if (!sourceHistoryId) {
        setError(tt("needHistory", "Video này không nằm trong Thư viện nên chưa xuất kèm chỉnh sửa được — hãy lưu video đã chỉnh sửa trước."));
        return;
      }
      const mapped = mapCaptionsToTimeline(segments, timelineSegments);
      if (mapped.length === 0) {
        setError(tt("noneKept", "Không còn phụ đề nào nằm trong phần video được giữ lại."));
        return;
      }
      const dir = await defaultDir();
      const path = await promptSaveVideoPath(`${dir}/${stemOf(filePath)}_captions.mp4`);
      if (!path) return;
      await run("export", async () => {
        const p = getEditPayload();
        await ipc.trimHistoryVideo(sourceHistoryId, p.keepRanges, p.removeAudio, path, p.overlays, p.zoomSegments, p.crop, {
          segments: mapped,
          mode,
          language,
        });
        onFlash?.(tt("savedEditedVideo", "Đã xuất video đã chỉnh sửa kèm phụ đề"));
      });
      return;
    }

    const dir = await defaultDir();
    const path = await promptSaveVideoPath(`${dir}/${stemOf(filePath)}_captions.mp4`);
    if (!path) return;
    await run("export", async () => {
      await ipc.captionsExportVideo(filePath, path, segments, mode, language, durationMs);
      onFlash?.(tt("savedVideo", "Đã xuất video có phụ đề"));
    });
  };

  const exportStageText = useMemo(() => {
    if (!exportProgress) return "";
    return exportProgress.stage === "edit"
      ? tt("stageEdit", "Đang áp dụng chỉnh sửa vào video…")
      : tt("stageExport", "Đang xuất video…");
  }, [exportProgress, tt]);

  if (!open) return null;

  const unsupported = status && !status.supported;
  const modelLabel = (id: string) =>
    id === "base"
      ? tt("modelBase", "Nhanh")
      : id === "small"
        ? tt("modelSmall", "Cân bằng (khuyên dùng)")
        : tt("modelTurbo", "Chính xác nhất");

  const missing = status?.models.filter((m) => !m.installed) ?? [];
  const dlBytes =
    (status?.models.filter((m) => dlSel.includes(m.id) && !m.installed).reduce((a, m) => a + m.sizeBytes, 0) ?? 0) +
    (status && !status.engineInstalled ? status.engineSizeBytes : 0);
  const dl = jobs.download;
  const dlText = !dl
    ? ""
    : dl.stage === "engine"
      ? tt("stageEngine", "Đang tải engine Whisper…")
      : dl.count > 1
        ? tt("stageModelN", "Đang tải model {{name}} ({{i}}/{{n}})…", { name: modelLabel(dl.modelId ?? ""), i: dl.index, n: dl.count })
        : tt("stageModelOne", "Đang tải model {{name}}…", { name: modelLabel(dl.modelId ?? "") });
  const tr = jobs.transcribe;

  /** Danh sách model: tick nhiều model để tải cùng lúc (lần lượt ở nền). */
  const modelPicker = status && (
    <div style={sectionStyle}>
      <div style={modelListStyle}>
        {status.models.map((m) => {
          const checked = m.installed || dlSel.includes(m.id);
          return (
            <label
              key={m.id}
              style={{ ...modelRowStyle, ...(modelId === m.id && m.installed ? modelRowActive : null), cursor: m.installed || downloading ? "default" : "pointer" }}
            >
              <input
                type="checkbox"
                checked={checked}
                disabled={m.installed || downloading}
                onChange={() => toggleDl(m.id)}
              />
              <span style={{ flex: 1 }}>{modelLabel(m.id)}</span>
              <span style={sizeStyle}>
                {m.installed ? "✓ " + tt("installed", "đã cài") : fmtMB(m.sizeBytes)}
              </span>
            </label>
          );
        })}
      </div>
      {missing.length > 1 && !downloading && (
        <button
          style={ghostBtn}
          onClick={() => setDlSel(missing.map((m) => m.id))}
          disabled={dlSel.length === missing.length}
        >
          {tt("selectAll", "Chọn tất cả model chưa cài")}
        </button>
      )}
      <button style={primaryBtn} disabled={downloading || dlSel.length === 0 && !!status.engineInstalled} onClick={doInstall}>
        {downloading
          ? tt("installing", "Đang tải…")
          : tt("installN", "Tải về & cài đặt ({{n}} model · {{size}})", {
              n: dlSel.length,
              size: fmtMB(dlBytes),
            })}
      </button>
    </div>
  );

  return (
    <div style={overlayStyle} onMouseDown={(e) => e.target === e.currentTarget && !busy && onClose()}>
      <div style={cardStyle} role="dialog" aria-modal="true">
        <div style={headerStyle}>
          <div>
            <div style={titleStyle}>💬 {tt("title", "Phụ đề tự động (AI)")}</div>
            <div style={subtitleStyle}>
              {tt("subtitle", "Whisper.cpp chạy offline ngay trên máy bạn — video không rời khỏi máy.")}
            </div>
          </div>
          <button style={closeBtnStyle} onClick={onClose} disabled={busy} title={tt("close", "Đóng")}>
            ✕
          </button>
        </div>

        <div style={bodyStyle}>
          {unsupported && <div style={errBox}>{tt("unsupported", "Phụ đề AI hiện chỉ hỗ trợ Windows.")}</div>}

          {!unsupported && status && !ready && (
            <div style={sectionStyle}>
              <div style={labelStyle}>{tt("setupTitle", "Cài đặt lần đầu")}</div>
              <div style={hintStyle}>
                {tt(
                  "setupDescMulti",
                  "Cần tải engine Whisper ({{engine}}) và ít nhất 1 model nhận diện giọng nói — có thể tick nhiều model để tải một lượt (tải ở nền, đóng hộp thoại vẫn tiếp tục, bị ngắt sẽ tải tiếp). Tệp tải từ github.com/ggml-org/whisper.cpp và huggingface.co/ggerganov/whisper.cpp, được kiểm tra SHA-256 trước khi dùng.",
                  { engine: fmtMB(status.engineSizeBytes) },
                )}
              </div>
              {modelPicker}
            </div>
          )}

          {!unsupported && status && ready && (
            <>
              <div style={rowStyle}>
                <div style={{ flex: 1 }}>
                  <div style={labelStyle}>{tt("language", "Ngôn ngữ trong video")}</div>
                  <select style={selectStyle} value={spoken} disabled={busy} onChange={(e) => setSpoken(e.target.value)}>
                    {LANGS.map((l) => (
                      <option key={l.code} value={l.code}>
                        {l.code === "auto" ? tt("langAuto", l.label) : l.label}
                      </option>
                    ))}
                  </select>
                </div>
                <div style={{ flex: 1 }}>
                  <div style={labelStyle}>{tt("model", "Model")}</div>
                  <select style={selectStyle} value={modelId} disabled={busy} onChange={(e) => setModelId(e.target.value)}>
                    {status.models
                      .filter((m) => m.installed)
                      .map((m) => (
                        <option key={m.id} value={m.id}>
                          {modelLabel(m.id)}
                        </option>
                      ))}
                  </select>
                </div>
              </div>
              {(missing.length > 0 || downloading) && (
                <details style={detailsStyle} open={downloading}>
                  <summary style={summaryStyle}>
                    {tt("moreModels", "Tải thêm model ({{n}} chưa cài)", { n: missing.length })}
                  </summary>
                  {modelPicker}
                </details>
              )}
            </>
          )}

          {downloading && dl && (
            <div style={sectionStyle}>
              <div style={progressTextStyle}>
                <span>{dlText}</span>
                <span>
                  {dl.percent}%{dl.startedMs > 0 ? ` · ${fmtElapsed(Date.now() - dl.startedMs)}` : ""}
                </span>
              </div>
              <div style={trackStyle}>
                <div style={{ ...barStyle, width: `${dl.percent}%` }} />
              </div>
              <div style={noteStyle}>
                {tt("bgHint", "Chạy nền — bạn có thể đóng hộp thoại này và tiếp tục làm việc.")}
              </div>
              <button style={ghostBtn} onClick={() => ipc.captionsCancel("download").catch(() => {})}>
                {tt("cancel", "Huỷ")}
              </button>
            </div>
          )}

          {transcribing && tr && (
            <div style={sectionStyle}>
              <div style={progressTextStyle}>
                <span>
                  {tr.stage === "audio"
                    ? tt("stageAudio", "Đang tách âm thanh…")
                    : tt("stageTranscribe", "Đang nhận diện giọng nói…")}
                  {transcribingOther ? ` (${tr.videoPath?.replace(/^.*[\\/]/, "") ?? ""})` : ""}
                </span>
                <span>
                  {tr.stage !== "audio" ? `${tr.percent}%` : ""}
                  {tr.startedMs > 0 ? ` · ${fmtElapsed(Date.now() - tr.startedMs)}` : ""}
                </span>
              </div>
              <div style={trackStyle}>
                <div style={{ ...barStyle, width: `${tr.stage === "audio" ? 4 : tr.percent}%` }} />
              </div>
              <div style={noteStyle}>
                {tt("bgHint", "Chạy nền — bạn có thể đóng hộp thoại này và tiếp tục làm việc.")}
              </div>
              <button style={ghostBtn} onClick={() => ipc.captionsCancel("transcribe").catch(() => {})}>
                {tt("cancel", "Huỷ")}
              </button>
            </div>
          )}

          {exporting && (
            <div style={sectionStyle}>
              <div style={progressTextStyle}>
                <span>{exportStageText || tt("working", "Đang xử lý…")}</span>
                {exportProgress && <span>{exportProgress.percent}%</span>}
              </div>
              <div style={trackStyle}>
                <div style={{ ...barStyle, width: `${exportProgress?.percent ?? 0}%` }} />
              </div>
              <button style={ghostBtn} onClick={() => ipc.captionsCancel("export").catch(() => {})}>
                {tt("cancel", "Huỷ")}
              </button>
            </div>
          )}

          {error && <div style={errBox}>⚠ {error}</div>}
          {jobs.downloadError && <div style={errBox}>⚠ {jobs.downloadError}</div>}
          {transcribeError && <div style={errBox}>⚠ {transcribeError}</div>}

          {!unsupported && ready && (
            <>
              <button style={primaryBtn} disabled={busy || transcribing} onClick={doGenerate}>
                {transcribing
                  ? transcribingOther
                    ? tt("busyOther", "Đang tạo phụ đề cho video khác…")
                    : tt("generating", "Đang tạo phụ đề…")
                  : hasCaptions
                    ? tt("regenerate", "Tạo lại phụ đề")
                    : tt("generate", "Tạo phụ đề")}
              </button>

              {hasCaptions && (
                <div style={optionsStyle}>
                  <label style={checkLabel}>
                    <input
                      type="checkbox"
                      checked={showOnPlayer}
                      onChange={(e) => onShowOnPlayerChange(e.target.checked)}
                    />
                    <span>{tt("previewOnPlayer", "Hiện phụ đề ngay trên trình phát")}</span>
                  </label>
                  {edited && (
                    <label style={checkLabel}>
                      <input
                        type="checkbox"
                        checked={matchEdits}
                        disabled={busy}
                        onChange={(e) => setMatchEdits(e.target.checked)}
                      />
                      <span>{tt("matchEdits", "File .srt khớp với video đã chỉnh sửa (cắt/tốc độ)")}</span>
                    </label>
                  )}
                </div>
              )}

              <div style={listStyle}>
                {!hasCaptions ? (
                  <div style={emptyStyle}>{tt("empty", "Chưa có phụ đề. Bấm “Tạo phụ đề” để bắt đầu.")}</div>
                ) : (
                  segments.map((s, i) => (
                    <div key={`${s.startMs}-${i}`} style={segRowStyle}>
                      <button
                        style={timeBtnStyle}
                        onClick={() => onSeekSource?.(s.startMs)}
                        title={tt("seek", "Nhảy tới đoạn này")}
                      >
                        {fmtClock(s.startMs)}
                      </button>
                      <input
                        style={segInputStyle}
                        value={s.text}
                        disabled={busy}
                        onChange={(e) =>
                          onChange(
                            segments.map((p, j) => (j === i ? { ...p, text: e.target.value } : p)),
                            language,
                          )
                        }
                      />
                      <button
                        style={delBtnStyle}
                        disabled={busy}
                        title={tt("remove", "Xoá dòng này")}
                        onClick={() =>
                          onChange(
                            segments.filter((_, j) => j !== i),
                            language,
                          )
                        }
                      >
                        ✕
                      </button>
                    </div>
                  ))
                )}
              </div>

              {hasCaptions && (
                <>
                  <div style={actionsStyle}>
                    <button style={secondaryBtn} disabled={busy} onClick={doCopy}>
                      📋 {tt("copyText", "Copy nội dung")}
                    </button>
                    <button style={secondaryBtn} disabled={busy} onClick={doSaveSrt}>
                      💾 {tt("saveSrt", "Lưu .srt")}
                    </button>
                    <button style={secondaryBtn} disabled={busy} onClick={() => doExportVideo("soft")}>
                      🎬 {tt("exportSoft", "Xuất video (phụ đề bật/tắt được)")}
                    </button>
                    <button style={secondaryBtn} disabled={busy} onClick={() => doExportVideo("burn")}>
                      🔥 {tt("exportBurn", "Xuất video (ghi cứng vào hình)")}
                    </button>
                  </div>
                  <div style={noteStyle}>
                    {edited
                      ? tt(
                          "editedExportHint",
                          "Video có chỉnh sửa: xuất video sẽ áp dụng các chỉnh sửa hiện tại (cắt, tốc độ, phóng to, crop, chú thích) rồi ghi phụ đề lên bản đó; mốc phụ đề tự khớp.",
                        )
                      : tt("note", "Phụ đề được tạo từ file video đang mở. Khi bạn cắt hoặc đổi tốc độ, mốc phụ đề sẽ tự khớp lúc xuất.")}
                  </div>
                </>
              )}
            </>
          )}
        </div>
      </div>
    </div>
  );
}

/* ── Styles ── */

const overlayStyle: React.CSSProperties = {
  position: "fixed",
  inset: 0,
  zIndex: 1100,
  background: "rgba(0, 0, 0, 0.72)",
  backdropFilter: "blur(6px)",
  display: "flex",
  alignItems: "center",
  justifyContent: "center",
  padding: 16,
};

const cardStyle: React.CSSProperties = {
  width: "100%",
  maxWidth: 640,
  maxHeight: "92vh",
  background: "#18181c",
  border: "1px solid #32323a",
  borderRadius: 14,
  display: "flex",
  flexDirection: "column",
  boxShadow: "0 24px 64px rgba(0, 0, 0, 0.65), 0 2px 8px rgba(0, 0, 0, 0.4)",
  overflow: "hidden",
  color: "#f0f0f3",
  fontFamily: "inherit",
};

const headerStyle: React.CSSProperties = {
  display: "flex",
  alignItems: "flex-start",
  justifyContent: "space-between",
  gap: 12,
  padding: "14px 18px",
  borderBottom: "1px solid #282830",
  background: "#1e1e24",
};

const titleStyle: React.CSSProperties = { fontSize: 15, fontWeight: 700 };
const subtitleStyle: React.CSSProperties = { fontSize: 11.5, color: "#9a9aa6", marginTop: 3 };

const closeBtnStyle: React.CSSProperties = {
  width: 28,
  height: 28,
  borderRadius: 8,
  border: "none",
  background: "rgba(255,255,255,0.06)",
  color: "#cfcfd6",
  cursor: "pointer",
};

const bodyStyle: React.CSSProperties = {
  padding: 18,
  display: "flex",
  flexDirection: "column",
  gap: 14,
  overflowY: "auto",
};

const sectionStyle: React.CSSProperties = { display: "flex", flexDirection: "column", gap: 8 };
const rowStyle: React.CSSProperties = { display: "flex", gap: 12 };
const labelStyle: React.CSSProperties = { fontSize: 11.5, fontWeight: 700, color: "#b4b4be", marginBottom: 4 };
const hintStyle: React.CSSProperties = { fontSize: 12, color: "#9a9aa6", lineHeight: 1.55 };

const detailsStyle: React.CSSProperties = {
  border: "1px solid #282830",
  borderRadius: 8,
  padding: "8px 10px",
  background: "#141418",
};
const summaryStyle: React.CSSProperties = { fontSize: 12, fontWeight: 600, color: "#b4b4be", cursor: "pointer", marginBottom: 8 };
const modelListStyle: React.CSSProperties = { display: "flex", flexDirection: "column", gap: 6 };
const modelRowStyle: React.CSSProperties = {
  display: "flex",
  alignItems: "center",
  gap: 10,
  padding: "9px 12px",
  borderRadius: 8,
  border: "1px solid #32323a",
  background: "#1e1e24",
  cursor: "pointer",
  fontSize: 13,
};
const modelRowActive: React.CSSProperties = { borderColor: "#f59e0b", background: "rgba(245,158,11,0.10)" };
const sizeStyle: React.CSSProperties = { fontSize: 12, color: "#9a9aa6", fontVariantNumeric: "tabular-nums" };

const selectStyle: React.CSSProperties = {
  width: "100%",
  padding: "7px 9px",
  borderRadius: 8,
  border: "1px solid #32323a",
  background: "#1e1e24",
  color: "#f0f0f3",
  fontSize: 13,
};

const progressTextStyle: React.CSSProperties = {
  display: "flex",
  justifyContent: "space-between",
  fontSize: 12,
  color: "#cfcfd6",
};
const trackStyle: React.CSSProperties = { height: 6, borderRadius: 3, background: "#2a2a32", overflow: "hidden" };
const barStyle: React.CSSProperties = { height: "100%", background: "#f59e0b", transition: "width 0.2s ease" };

const primaryBtn: React.CSSProperties = {
  padding: "10px 14px",
  borderRadius: 9,
  border: "none",
  background: "#f59e0b",
  color: "#1a1204",
  fontWeight: 700,
  fontSize: 13,
  cursor: "pointer",
};

const secondaryBtn: React.CSSProperties = {
  padding: "8px 12px",
  borderRadius: 8,
  border: "1px solid #3a3a44",
  background: "#22222a",
  color: "#f0f0f3",
  fontSize: 12.5,
  cursor: "pointer",
};

const ghostBtn: React.CSSProperties = {
  alignSelf: "flex-start",
  padding: "6px 12px",
  borderRadius: 8,
  border: "1px solid #3a3a44",
  background: "transparent",
  color: "#cfcfd6",
  fontSize: 12,
  cursor: "pointer",
};

const errBox: React.CSSProperties = {
  padding: "9px 12px",
  borderRadius: 8,
  background: "rgba(248,113,113,0.10)",
  border: "1px solid rgba(248,113,113,0.35)",
  color: "#fca5a5",
  fontSize: 12.5,
  lineHeight: 1.5,
  whiteSpace: "pre-wrap",
};

const optionsStyle: React.CSSProperties = { display: "flex", flexDirection: "column", gap: 6 };
const checkLabel: React.CSSProperties = {
  display: "flex",
  alignItems: "center",
  gap: 8,
  fontSize: 12.5,
  color: "#d4d4dc",
  cursor: "pointer",
};

const listStyle: React.CSSProperties = {
  display: "flex",
  flexDirection: "column",
  gap: 4,
  maxHeight: 260,
  overflowY: "auto",
  padding: 4,
  borderRadius: 8,
  border: "1px solid #282830",
  background: "#141418",
};

const emptyStyle: React.CSSProperties = { padding: 18, textAlign: "center", color: "#8a8a96", fontSize: 12.5 };
const segRowStyle: React.CSSProperties = { display: "flex", alignItems: "center", gap: 6 };

const timeBtnStyle: React.CSSProperties = {
  minWidth: 46,
  padding: "5px 6px",
  borderRadius: 6,
  border: "none",
  background: "rgba(245,158,11,0.14)",
  color: "#f59e0b",
  fontSize: 11.5,
  fontVariantNumeric: "tabular-nums",
  cursor: "pointer",
};

const segInputStyle: React.CSSProperties = {
  flex: 1,
  minWidth: 0,
  padding: "6px 8px",
  borderRadius: 6,
  border: "1px solid #2c2c34",
  background: "#1a1a20",
  color: "#f0f0f3",
  fontSize: 13,
};

const delBtnStyle: React.CSSProperties = {
  width: 24,
  height: 24,
  borderRadius: 6,
  border: "none",
  background: "transparent",
  color: "#8a8a96",
  cursor: "pointer",
};

const actionsStyle: React.CSSProperties = { display: "flex", flexWrap: "wrap", gap: 8 };
const noteStyle: React.CSSProperties = { fontSize: 11, color: "#7c7c88", lineHeight: 1.5 };
