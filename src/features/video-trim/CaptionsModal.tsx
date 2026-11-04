import { useCallback, useEffect, useMemo, useState } from "react";
import { useTranslation } from "react-i18next";
import { listen } from "@tauri-apps/api/event";
import { save } from "@tauri-apps/plugin-dialog";
import {
  ipc,
  type CaptionSegment,
  type CaptionsProgress,
  type CaptionsStatus,
} from "../../lib/ipc";
import { dirnameOf, promptSaveVideoPath } from "../output/useOutput";

export interface CaptionsModalProps {
  open: boolean;
  onClose: () => void;
  /** Đường dẫn file video thật trên đĩa (nguồn để nhận diện giọng nói). */
  filePath: string;
  durationMs: number;
  /** Nhảy tới mốc thời gian (ms) trên video GỐC khi bấm vào 1 dòng phụ đề. */
  onSeekSource?: (srcMs: number) => void;
  onFlash?: (msg: string) => void;
}

type Job = null | "setup" | "transcribe" | "export";

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
const cacheKey = (filePath: string) => `snapdoc.captions.v1:${filePath}`;

interface CachedCaptions {
  language: string;
  segments: CaptionSegment[];
}

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
  onSeekSource,
  onFlash,
}: CaptionsModalProps) {
  const { t } = useTranslation();
  const tt = useCallback(
    (key: string, def: string, opts?: Record<string, unknown>) =>
      t(`captions.${key}`, { defaultValue: def, ...opts }),
    [t],
  );

  const [status, setStatus] = useState<CaptionsStatus | null>(null);
  const [modelId, setModelId] = useState<string>(() => readLS(MODEL_KEY) ?? "small");
  const [language, setLanguage] = useState<string>(() => readLS(LANG_KEY) ?? "auto");
  const [segments, setSegments] = useState<CaptionSegment[]>([]);
  const [resultLang, setResultLang] = useState<string>("auto");
  const [job, setJob] = useState<Job>(null);
  const [progress, setProgress] = useState<CaptionsProgress | null>(null);
  const [error, setError] = useState<string | null>(null);

  const refreshStatus = useCallback(() => {
    ipc
      .captionsStatus()
      .then((s) => {
        setStatus(s);
        // Chưa chọn gì rõ ràng: ưu tiên model đã cài.
        setModelId((cur) => {
          const curInstalled = s.models.find((m) => m.id === cur)?.installed;
          if (curInstalled) return cur;
          const firstInstalled = MODEL_ORDER.find((id) => s.models.find((m) => m.id === id)?.installed);
          return firstInstalled ?? cur;
        });
      })
      .catch((e) => setError(String(e)));
  }, []);

  useEffect(() => {
    if (!open) return;
    setError(null);
    refreshStatus();
    const raw = readLS(cacheKey(filePath));
    if (raw) {
      try {
        const c = JSON.parse(raw) as CachedCaptions;
        if (Array.isArray(c.segments)) {
          setSegments(c.segments);
          setResultLang(c.language || "auto");
        }
      } catch {
        // cache hỏng — bỏ qua
      }
    } else {
      setSegments([]);
    }
  }, [open, filePath, refreshStatus]);

  useEffect(() => {
    if (!open) return;
    let disposed = false;
    let unlisten: (() => void) | undefined;
    listen<CaptionsProgress>("captions-progress", (e) => setProgress(e.payload)).then((fn) => {
      if (disposed) fn();
      else unlisten = fn;
    });
    return () => {
      disposed = true;
      unlisten?.();
    };
  }, [open]);

  useEffect(() => {
    if (!open) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape" && job === null) onClose();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [open, job, onClose]);

  const persist = useCallback(
    (segs: CaptionSegment[], lang: string) => {
      writeLS(cacheKey(filePath), JSON.stringify({ language: lang, segments: segs } satisfies CachedCaptions));
    },
    [filePath],
  );

  const updateSegments = (next: CaptionSegment[]) => {
    setSegments(next);
    persist(next, resultLang);
  };

  const modelInstalled = !!status?.models.find((m) => m.id === modelId)?.installed;
  const ready = !!status?.engineInstalled && modelInstalled;
  const busy = job !== null;

  const run = async (kind: Exclude<Job, null>, fn: () => Promise<void>) => {
    setJob(kind);
    setProgress(null);
    setError(null);
    try {
      await fn();
    } catch (e) {
      const msg = String(e);
      if (!msg.includes("Đã huỷ")) setError(msg);
    } finally {
      setJob(null);
      setProgress(null);
      refreshStatus();
    }
  };

  const doInstall = () =>
    run("setup", async () => {
      await ipc.captionsSetup(modelId);
    });

  const doGenerate = () =>
    run("transcribe", async () => {
      writeLS(LANG_KEY, language);
      writeLS(MODEL_KEY, modelId);
      const res = await ipc.captionsTranscribe(filePath, language, modelId);
      setSegments(res.segments);
      setResultLang(res.language);
      persist(res.segments, res.language);
    });

  const defaultDir = async (): Promise<string> => {
    const settings = await ipc.getSettings().catch(() => null);
    return (
      settings?.lastVideoSaveAsDir ||
      settings?.saveDir ||
      (await ipc.defaultSaveDir().catch(() => "")) ||
      dirnameOf(filePath)
    );
  };

  const doCopy = async () => {
    await ipc.copyText(segments.map((s) => s.text).join("\n"));
    onFlash?.(tt("copied", "Đã copy nội dung phụ đề"));
  };

  const doSaveSrt = async () => {
    const dir = await defaultDir();
    const path = await save({
      defaultPath: `${dir}/${stemOf(filePath)}.srt`,
      filters: [{ name: "SubRip", extensions: ["srt"] }],
    });
    if (!path) return;
    setError(null);
    try {
      await ipc.captionsSaveSrt(path, segments);
      onFlash?.(tt("savedSrt", "Đã lưu file phụ đề (.srt)"));
    } catch (e) {
      setError(String(e));
    }
  };

  const doExportVideo = async (mode: "soft" | "burn") => {
    const dir = await defaultDir();
    const path = await promptSaveVideoPath(`${dir}/${stemOf(filePath)}_captions.mp4`);
    if (!path) return;
    await run("export", async () => {
      await ipc.captionsExportVideo(filePath, path, segments, mode, resultLang, durationMs);
      onFlash?.(tt("savedVideo", "Đã xuất video có phụ đề"));
    });
  };

  const stageText = useMemo(() => {
    if (!progress) return "";
    switch (progress.stage) {
      case "engine":
        return tt("stageEngine", "Đang tải engine Whisper…");
      case "model":
        return tt("stageModel", "Đang tải model…");
      case "audio":
        return tt("stageAudio", "Đang tách âm thanh…");
      case "transcribe":
        return tt("stageTranscribe", "Đang nhận diện giọng nói…");
      default:
        return tt("stageExport", "Đang xuất video…");
    }
  }, [progress, tt]);

  if (!open) return null;

  const unsupported = status && !status.supported;

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
                  "setupDesc",
                  "Cần tải engine Whisper ({{engine}}) và 1 model nhận diện giọng nói. Tệp tải từ github.com/ggml-org/whisper.cpp và huggingface.co/ggerganov/whisper.cpp, được kiểm tra SHA-256 trước khi dùng.",
                  { engine: fmtMB(status.engineSizeBytes) },
                )}
              </div>
              <div style={modelListStyle}>
                {status.models.map((m) => (
                  <label key={m.id} style={{ ...modelRowStyle, ...(modelId === m.id ? modelRowActive : null) }}>
                    <input
                      type="radio"
                      name="captions-model"
                      checked={modelId === m.id}
                      disabled={busy}
                      onChange={() => setModelId(m.id)}
                    />
                    <span style={{ flex: 1 }}>
                      {m.id === "base"
                        ? tt("modelBase", "Nhanh")
                        : m.id === "small"
                          ? tt("modelSmall", "Cân bằng (khuyên dùng)")
                          : tt("modelTurbo", "Chính xác nhất")}
                    </span>
                    <span style={sizeStyle}>
                      {m.installed ? "✓ " + tt("installed", "đã cài") : fmtMB(m.sizeBytes)}
                    </span>
                  </label>
                ))}
              </div>
              <button style={primaryBtn} disabled={busy} onClick={doInstall}>
                {job === "setup" ? tt("installing", "Đang tải…") : tt("install", "Tải về & cài đặt")}
              </button>
            </div>
          )}

          {!unsupported && status && ready && (
            <div style={rowStyle}>
              <div style={{ flex: 1 }}>
                <div style={labelStyle}>{tt("language", "Ngôn ngữ trong video")}</div>
                <select style={selectStyle} value={language} disabled={busy} onChange={(e) => setLanguage(e.target.value)}>
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
                        {m.id === "base"
                          ? tt("modelBase", "Nhanh")
                          : m.id === "small"
                            ? tt("modelSmall", "Cân bằng (khuyên dùng)")
                            : tt("modelTurbo", "Chính xác nhất")}
                      </option>
                    ))}
                </select>
              </div>
            </div>
          )}

          {busy && (
            <div style={sectionStyle}>
              <div style={progressTextStyle}>
                <span>{stageText || tt("working", "Đang xử lý…")}</span>
                {progress && progress.stage !== "audio" && <span>{progress.percent}%</span>}
              </div>
              <div style={trackStyle}>
                <div style={{ ...barStyle, width: `${progress?.percent ?? 0}%` }} />
              </div>
              <button style={ghostBtn} onClick={() => ipc.captionsCancel().catch(() => {})}>
                {tt("cancel", "Huỷ")}
              </button>
            </div>
          )}

          {error && <div style={errBox}>⚠ {error}</div>}

          {!unsupported && ready && (
            <>
              <button style={primaryBtn} disabled={busy} onClick={doGenerate}>
                {segments.length > 0 ? tt("regenerate", "Tạo lại phụ đề") : tt("generate", "Tạo phụ đề")}
              </button>

              <div style={listStyle}>
                {segments.length === 0 ? (
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
                          setSegments((prev) => prev.map((p, j) => (j === i ? { ...p, text: e.target.value } : p)))
                        }
                        onBlur={() => persist(segments, resultLang)}
                      />
                      <button
                        style={delBtnStyle}
                        disabled={busy}
                        title={tt("remove", "Xoá dòng này")}
                        onClick={() => updateSegments(segments.filter((_, j) => j !== i))}
                      >
                        ✕
                      </button>
                    </div>
                  ))
                )}
              </div>

              {segments.length > 0 && (
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
              )}
            </>
          )}

          <div style={noteStyle}>
            {tt(
              "note",
              "Phụ đề được tạo từ file video gốc đang mở, chưa tính các đoạn đã cắt/tăng tốc trong editor. Hãy lưu video đã chỉnh sửa trước nếu muốn phụ đề khớp bản đã cắt.",
            )}
          </div>
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
