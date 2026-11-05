import { useEffect, useState } from "react";
import { useTranslation } from "react-i18next";
import { ipc, type CaptionsJobKind, type CaptionsProgress } from "../../lib/ipc";
import { fmtElapsed, useCaptionsJobs } from "./captionsJobs";

interface Props {
  /** Video đang mở trong Editor — để biết tác vụ nhận diện có phải của video này không. */
  currentFilePath: string;
  /** Mở lại hộp thoại phụ đề đầy đủ. */
  onOpen: () => void;
  /** Ẩn khi hộp thoại đang mở (hộp thoại tự hiện tiến độ). */
  hidden?: boolean;
}

function baseName(path: string): string {
  return path.replace(/^.*[\\/]/, "");
}

/**
 * Popup nhỏ góc màn hình hiện tiến độ phụ đề đang chạy nền (nhận diện giọng nói /
 * tải model). KHÔNG chặn thao tác: người dùng cứ tiếp tục chỉnh sửa video, xong sẽ
 * có thông báo và phụ đề tự xuất hiện trên trình phát.
 */
export default function CaptionsJobChip({ currentFilePath, onOpen, hidden }: Props) {
  const { t } = useTranslation();
  const tt = (key: string, def: string, opts?: Record<string, unknown>) =>
    t(`captions.${key}`, { defaultValue: def, ...opts }) as string;
  const jobs = useCaptionsJobs();
  const [, tick] = useState(0);
  const active = !!(jobs.transcribe || jobs.download);

  useEffect(() => {
    if (!active || hidden) return;
    const id = window.setInterval(() => tick((n) => n + 1), 1000);
    return () => window.clearInterval(id);
  }, [active, hidden]);

  if (!active || hidden) return null;

  const rows: { kind: CaptionsJobKind; p: CaptionsProgress }[] = [];
  if (jobs.transcribe) rows.push({ kind: "transcribe", p: jobs.transcribe });
  if (jobs.download) rows.push({ kind: "download", p: jobs.download });

  const label = (kind: CaptionsJobKind, p: CaptionsProgress): string => {
    if (kind === "download") {
      if (p.stage === "engine") return tt("chipEngine", "Đang tải engine Whisper…");
      const name = modelName(tt, p.modelId);
      return p.count > 1
        ? tt("chipModelN", "Đang tải model {{name}} ({{i}}/{{n}})", { name, i: p.index, n: p.count })
        : tt("chipModel", "Đang tải model {{name}}", { name });
    }
    const other = p.videoPath && p.videoPath !== currentFilePath ? ` · ${baseName(p.videoPath)}` : "";
    return (p.stage === "audio" ? tt("chipAudio", "Đang tách âm thanh…") : tt("chipTranscribe", "Đang tạo phụ đề…")) + other;
  };

  return (
    <div style={chipStyle} role="status" aria-live="polite" data-testid="captions-job-chip">
      {rows.map(({ kind, p }) => {
        const showPct = !(kind === "transcribe" && p.stage === "audio");
        return (
          <div key={kind} style={rowStyle}>
            <div style={topStyle}>
              <span style={labelStyle} title={label(kind, p)}>
                💬 {label(kind, p)}
              </span>
              <span style={metaStyle}>
                {showPct ? `${p.percent}%` : ""}
                {p.startedMs > 0 ? ` · ${fmtElapsed(Date.now() - p.startedMs)}` : ""}
              </span>
              <button
                style={cancelBtn}
                title={tt("cancel", "Huỷ")}
                aria-label={tt("cancel", "Huỷ")}
                onClick={() => ipc.captionsCancel(kind).catch(() => {})}
              >
                ✕
              </button>
            </div>
            <div style={trackStyle}>
              <div style={{ ...barStyle, width: `${showPct ? p.percent : 4}%` }} />
            </div>
          </div>
        );
      })}
      <button style={openBtn} onClick={onOpen}>
        {tt("chipOpen", "Mở phụ đề")}
      </button>
    </div>
  );
}

function modelName(tt: (k: string, d: string) => string, id?: string | null): string {
  if (id === "base") return tt("modelBaseShort", "Nhanh");
  if (id === "turbo") return tt("modelTurboShort", "Chính xác nhất");
  if (id === "small") return tt("modelSmallShort", "Cân bằng");
  return id ?? "";
}

const chipStyle: React.CSSProperties = {
  position: "fixed",
  right: 16,
  bottom: 16,
  zIndex: 1050,
  width: 300,
  padding: "10px 12px",
  borderRadius: 12,
  background: "#18181c",
  border: "1px solid #32323a",
  boxShadow: "0 12px 32px rgba(0,0,0,0.55)",
  color: "#f0f0f3",
  display: "flex",
  flexDirection: "column",
  gap: 8,
  fontSize: 12,
};
const rowStyle: React.CSSProperties = { display: "flex", flexDirection: "column", gap: 5 };
const topStyle: React.CSSProperties = { display: "flex", alignItems: "center", gap: 8 };
const labelStyle: React.CSSProperties = {
  flex: 1,
  minWidth: 0,
  overflow: "hidden",
  textOverflow: "ellipsis",
  whiteSpace: "nowrap",
  fontWeight: 600,
};
const metaStyle: React.CSSProperties = { color: "#9a9aa6", fontVariantNumeric: "tabular-nums", whiteSpace: "nowrap" };
const trackStyle: React.CSSProperties = { height: 4, borderRadius: 2, background: "#2a2a32", overflow: "hidden" };
const barStyle: React.CSSProperties = { height: "100%", background: "#f59e0b", transition: "width 0.3s ease" };
const cancelBtn: React.CSSProperties = {
  width: 20,
  height: 20,
  borderRadius: 6,
  border: "none",
  background: "rgba(255,255,255,0.06)",
  color: "#cfcfd6",
  cursor: "pointer",
  fontSize: 11,
  lineHeight: 1,
};
const openBtn: React.CSSProperties = {
  alignSelf: "flex-start",
  padding: "4px 10px",
  borderRadius: 7,
  border: "1px solid #3a3a44",
  background: "transparent",
  color: "#cfcfd6",
  fontSize: 11.5,
  cursor: "pointer",
};
