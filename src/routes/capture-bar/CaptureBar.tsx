import { useEffect, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import { listen } from "@tauri-apps/api/event";
import { ipc, type CaptureMode, type OutputMode } from "../../lib/ipc";
import { showError } from "../../lib/notify";

type RecordMode = "full" | "window" | "region";
type ActiveGroup = "photo" | "video";

// Icon dùng cho chế độ CHỤP ẢNH (Full/Window/Region)
const SCOPE_ICONS: Record<RecordMode, React.ReactNode> = {
  full: (
    <svg width="20" height="20" viewBox="0 0 20 20" fill="none" aria-hidden>
      <rect x="2" y="3" width="16" height="14" rx="1.5" stroke="currentColor" strokeWidth="1.6"/>
    </svg>
  ),
  window: (
    <svg width="20" height="20" viewBox="0 0 20 20" fill="none" aria-hidden>
      <rect x="3" y="5" width="14" height="11" rx="1.5" stroke="currentColor" strokeWidth="1.6"/>
      <line x1="3" y1="8.5" x2="17" y2="8.5" stroke="currentColor" strokeWidth="1.4"/>
    </svg>
  ),
  region: (
    <svg width="20" height="20" viewBox="0 0 20 20" fill="none" aria-hidden>
      <path d="M3 8V4.5A1.5 1.5 0 0 1 4.5 3H8" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round"/>
      <path d="M12 3h3.5A1.5 1.5 0 0 1 17 4.5V8" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round"/>
      <path d="M17 12v3.5A1.5 1.5 0 0 1 15.5 17H12" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round"/>
      <path d="M8 17H4.5A1.5 1.5 0 0 1 3 15.5V12" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round"/>
    </svg>
  ),
};

// Icon riêng biệt cho chế độ QUAY VIDEO MÀN HÌNH (Full/Window/Region tích hợp máy quay video)
const RECORD_ICONS: Record<RecordMode, React.ReactNode> = {
  full: (
    <svg width="20" height="20" viewBox="0 0 20 20" fill="none" aria-hidden>
      <rect x="2" y="3" width="16" height="14" rx="1.5" stroke="currentColor" strokeWidth="1.5"/>
      <rect x="6" y="7" width="5.5" height="6" rx="1" fill="currentColor"/>
      <path d="M11.5 8.8L14.5 7.2V12.8L11.5 11.2V8.8Z" fill="currentColor"/>
    </svg>
  ),
  window: (
    <svg width="20" height="20" viewBox="0 0 20 20" fill="none" aria-hidden>
      <rect x="2.5" y="4" width="15" height="12" rx="1.5" stroke="currentColor" strokeWidth="1.5"/>
      <line x1="2.5" y1="7.5" x2="17.5" y2="7.5" stroke="currentColor" strokeWidth="1.2"/>
      <rect x="6" y="9.2" width="5" height="5" rx="0.8" fill="currentColor"/>
      <path d="M11 10.5L14 9.2V13.8L11 12.5V10.5Z" fill="currentColor"/>
    </svg>
  ),
  region: (
    <svg width="20" height="20" viewBox="0 0 20 20" fill="none" aria-hidden>
      <path d="M3 7.5V4.5A1.5 1.5 0 0 1 4.5 3H7.5" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round"/>
      <path d="M12.5 3H15.5A1.5 1.5 0 0 1 17 4.5V7.5" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round"/>
      <path d="M17 12.5V15.5A1.5 1.5 0 0 1 15.5 17H12.5" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round"/>
      <path d="M7.5 17H4.5A1.5 1.5 0 0 1 3 15.5V12.5" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round"/>
      <rect x="6" y="7" width="5.5" height="6" rx="1" fill="currentColor"/>
      <path d="M11.5 8.8L14.5 7.2V12.8L11.5 11.2V8.8Z" fill="currentColor"/>
    </svg>
  ),
};

function formatShortcutLabel(raw: string | undefined): string {
  if (!raw) return "";
  const isMac = typeof navigator !== "undefined" && navigator.platform?.toUpperCase().indexOf("MAC") >= 0;
  return raw
    .replace(/CmdOrCtrl/g, isMac ? "⌘" : "Ctrl")
    .replace(/Shift/g, isMac ? "⇧" : "Shift")
    .replace(/Alt/g, isMac ? "⌥" : "Alt");
}

export default function CaptureBar() {
  const { t } = useTranslation();
  const [photoMode, setPhotoMode] = useState<CaptureMode>("region");
  const [videoMode, setVideoMode] = useState<RecordMode>("full");
  const [activeGroup, setActiveGroup] = useState<ActiveGroup>("photo");
  const [output, setOutput] = useState<OutputMode>("editor");
  const [shortcuts, setShortcuts] = useState<Record<string, string>>({
    quick: "CmdOrCtrl+Shift+X",
    record: "CmdOrCtrl+Shift+R",
    full: "CmdOrCtrl+Shift+3",
    window: "CmdOrCtrl+Shift+2",
    region: "CmdOrCtrl+Shift+1",
    all: "CmdOrCtrl+Shift+4",
    scroll: "CmdOrCtrl+Shift+6",
  });

  const PHOTO_MODES: { id: CaptureMode; label: string; icon: React.ReactNode }[] = [
    {
      id: "all", label: t("captureBar.all"),
      icon: (
        <svg width="20" height="20" viewBox="0 0 20 20" fill="none" aria-hidden>
          <rect x="1" y="4" width="8" height="12" rx="1.5" stroke="currentColor" strokeWidth="1.6"/>
          <rect x="11" y="4" width="8" height="12" rx="1.5" stroke="currentColor" strokeWidth="1.6"/>
        </svg>
      ),
    },
    { id: "full", label: t("captureBar.full"), icon: SCOPE_ICONS.full },
    { id: "window", label: t("captureBar.window"), icon: SCOPE_ICONS.window },
    { id: "region", label: t("captureBar.region"), icon: SCOPE_ICONS.region },
    {
      id: "scroll", label: t("captureBar.scroll"),
      icon: (
        <svg width="20" height="20" viewBox="0 0 20 20" fill="none" aria-hidden>
          <rect x="3" y="3" width="14" height="14" rx="2" stroke="currentColor" strokeWidth="1.6"/>
          <path d="M7 8l3-3 3 3M7 12l3 3 3-3" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round"/>
        </svg>
      ),
    },
  ];

  const RECORD_MODES: { id: RecordMode; label: string; tooltip: string }[] = [
    {
      id: "full",
      label: t("captureBar.recordFull"),
      tooltip: t("captureBar.recordModeLabel", { mode: t("captureBar.full").toLowerCase() }),
    },
    {
      id: "window",
      label: t("captureBar.recordWindow"),
      tooltip: t("captureBar.recordModeLabel", { mode: t("captureBar.window").toLowerCase() }),
    },
    {
      id: "region",
      label: t("captureBar.recordRegion"),
      tooltip: t("captureBar.recordModeLabel", { mode: t("captureBar.region").toLowerCase() }),
    },
  ];

  const photoModeRef = useRef(photoMode);
  photoModeRef.current = photoMode;
  const videoModeRef = useRef(videoMode);
  videoModeRef.current = videoMode;
  const activeGroupRef = useRef(activeGroup);
  activeGroupRef.current = activeGroup;
  const outputRef = useRef(output);
  outputRef.current = output;

  useEffect(() => {
    // Load settings lần đầu
    ipc.getSettings().then((s) => {
      if (s?.defaultOutput) setOutput(s.defaultOutput);
      if (s?.shortcuts) setShortcuts((prev) => ({ ...prev, ...s.shortcuts }));
    }).catch(() => {});

    // Sync output khi settings thay đổi
    const unlistenSettings = listen<Record<string, unknown>>("settings-changed", (e) => {
      if (e.payload?.defaultOutput) {
        setOutput(e.payload.defaultOutput as OutputMode);
      }
      if (e.payload?.shortcuts && typeof e.payload.shortcuts === "object") {
        setShortcuts((prev) => ({ ...prev, ...(e.payload.shortcuts as Record<string, string>) }));
      }
    });

    const unlistenRecordMode = listen<{ mode: string }>("set-record-mode", (e) => {
      selectVideoMode(e.payload.mode as RecordMode);
    });

    const onKey = (e: KeyboardEvent) => {
      if ((e.ctrlKey || e.metaKey) && (e.key === "k" || e.key === "K")) {
        e.preventDefault();
        ipc.hideCaptureBarPopover().catch(() => {});
        ipc.openSettings().catch(() => {});
        return;
      }
      if (e.key === "Escape") {
        ipc.hideCaptureBarPopover().catch(() => {});
        ipc.closeSelf();
      }
      if (e.key === "Enter") {
        ipc.hideCaptureBarPopover().catch(() => {});
        if (activeGroupRef.current === "video") {
          if (videoModeRef.current === "region") {
            ipc.confirmRegionRecordStart().catch((err) => showError(err));
          } else {
            ipc.startRecordPicker(videoModeRef.current).catch((err) => showError(err));
          }
        } else if (photoModeRef.current === "all") {
          ipc.captureAllScreens(outputRef.current).catch((err) => showError(err));
        } else {
          ipc.captureNow(photoModeRef.current, outputRef.current).catch((err) => showError(err));
        }
      }
    };
    window.addEventListener("keydown", onKey);

    return () => {
      window.removeEventListener("keydown", onKey);
      unlistenRecordMode.then((fn) => fn());
      unlistenSettings.then((fn) => fn());
    };
  }, []);

  const selectPhotoMode = (m: CaptureMode) => {
    ipc.hideCaptureBarPopover().catch(() => {});
    setPhotoMode(m);
    setActiveGroup("photo");
    if (m === "all") {
      ipc.captureAllScreens(output).catch((e) => showError(e));
    } else {
      ipc.captureNow(m, output).catch((e) => showError(e));
    }
  };

  const selectVideoMode = (m: RecordMode) => {
    ipc.hideCaptureBarPopover().catch(() => {});
    setVideoMode(m);
    setActiveGroup("video");
    ipc.startRecordPicker(m).catch((e) => showError(e));
  };

  const toggleOptions = (e: React.MouseEvent<HTMLButtonElement>) => {
    e.stopPropagation();
    const rect = e.currentTarget.getBoundingClientRect();
    ipc.toggleCaptureBarPopover({
      x: rect.left,
      y: rect.top,
      width: rect.width,
      height: rect.height,
    }).catch(() => {});
  };

  const handleClose = () => {
    ipc.hideCaptureBarPopover().catch(() => {});
    ipc.closeSelf();
  };

  return (
    <div style={wrap}>
      <div style={bar}>
        {/* Khu vực 1: chế độ CHỤP ẢNH */}
        <div style={modeGroup}>
          <button
            onClick={() => {
              ipc.hideCaptureBarPopover().catch(() => {});
              ipc.startQuick().catch((e) => showError(e));
            }}
            className="capture-bar-quick-btn"
            style={quickModeBtn}
            title={`${t("captureBar.quick")} (${formatShortcutLabel(shortcuts.quick)}) - ${t("captureBar.quickCaptureHint")}`}
          >
            <svg width="20" height="20" viewBox="0 0 20 20" fill="none" aria-hidden>
              <path d="M11 2 3 12h6l-1 6 8-10h-6l1-6Z" fill="currentColor" />
            </svg>
            <span style={{ fontSize: 11, lineHeight: 1.1, textAlign: "center", whiteSpace: "nowrap" }}>
              {t("captureBar.quick")}
            </span>
          </button>
          {PHOTO_MODES.map((m) => (
            <button
              key={m.id}
              onClick={() => selectPhotoMode(m.id)}
              className="capture-bar-scope-btn"
              style={scopeBtn}
              title={shortcuts[m.id] ? `${m.label} (${formatShortcutLabel(shortcuts[m.id])})` : m.label}
            >
              {m.icon}
              <span style={{ fontSize: 11, lineHeight: 1.1, textAlign: "center", whiteSpace: "nowrap" }}>
                {m.label}
              </span>
            </button>
          ))}
        </div>

        <div style={divider} />

        {/* Khu vực 2: chế độ QUAY VIDEO MÀN HÌNH (nhận diện rõ với icon máy quay & viền nổi bật) */}
        <div style={recordModeGroup}>
          {RECORD_MODES.map((r) => (
            <button
              key={r.id}
              onClick={() => selectVideoMode(r.id)}
              className="capture-bar-record-btn"
              style={recordScopeBtn}
              title={shortcuts.record ? `${r.label} (${formatShortcutLabel(shortcuts.record)})` : r.tooltip}
            >
              <span style={recordIconWrap}>
                {RECORD_ICONS[r.id]}
                <span style={recordDotBadge} aria-hidden />
              </span>
              <span style={{ fontSize: 11, lineHeight: 1.1, textAlign: "center", whiteSpace: "nowrap" }}>
                {r.label}
              </span>
            </button>
          ))}
        </div>

        <div style={divider} />

        {/* Nút Mở Editor */}
        <button
          className="capture-bar-editor-btn"
          style={editorBtn}
          onClick={() => {
            ipc.hideCaptureBarPopover().catch(() => {});
            ipc.openEditor().catch((e) => showError(e));
          }}
          title="Mở cửa sổ chỉnh sửa ảnh SnapDoc Editor"
        >
          <svg width="20" height="20" viewBox="0 0 20 20" fill="none" aria-hidden>
            <path
              d="M13.586 3.586a2 2 0 1 1 2.828 2.828l-.793.793-2.828-2.828.793-.793zM11.379 5.793L3 14.172V17h2.828l8.38-8.379-2.83-2.828z"
              fill="currentColor"
            />
          </svg>
          <span style={{ fontSize: 11, lineHeight: 1.1, textAlign: "center", whiteSpace: "nowrap" }}>
            Mở Editor
          </span>
        </button>

        <div style={divider} />

        {/* Option: Nút mở Popover độc lập */}
        <button
          className="capture-bar-opt-btn"
          style={optBtn}
          onClick={toggleOptions}
          title={t("captureBar.options")}
        >
          <span>{t("captureBar.options")}</span>
          <span style={{ fontSize: 10, opacity: 0.5, marginLeft: 2 }}>▾</span>
        </button>

        {/* Close */}
        <button
          aria-label={t("captureBar.close")}
          className="capture-bar-close-btn"
          style={closeBtn}
          onClick={handleClose}
        >
          ✕
        </button>
      </div>
    </div>
  );
}

/* ── Styles ── */

const wrap: React.CSSProperties = {
  height: "100%",
  width: "100%",
  display: "flex",
  alignItems: "center",
  justifyContent: "center",
  boxSizing: "border-box",
};

const bar: React.CSSProperties = {
  position: "relative",
  display: "flex",
  alignItems: "center",
  gap: 8,
  background: "rgba(32,32,38,0.97)",
  borderRadius: 12,
  padding: "7px 10px",
  width: "max-content",
  boxShadow: "0 6px 20px rgba(0,0,0,0.35), 0 0 0 1px rgba(255,255,255,0.08)",
};

const modeGroup: React.CSSProperties = {
  display: "flex",
  gap: 2,
  background: "rgba(255,255,255,0.06)",
  borderRadius: 8,
  padding: 2,
};

const recordModeGroup: React.CSSProperties = {
  display: "flex",
  gap: 2,
  background: "rgba(239, 68, 68, 0.08)",
  border: "1px solid rgba(239, 68, 68, 0.25)",
  borderRadius: 8,
  padding: 2,
};

const scopeBtn: React.CSSProperties = {
  display: "flex",
  flexDirection: "column",
  alignItems: "center",
  gap: 3,
  minWidth: 56,
  padding: "6px 5px",
  borderRadius: 6,
  color: "var(--text-dim)",
  cursor: "pointer",
  transition: "background 0.12s, color 0.12s",
};

const recordScopeBtn: React.CSSProperties = {
  display: "flex",
  flexDirection: "column",
  alignItems: "center",
  gap: 3,
  minWidth: 62,
  padding: "6px 6px",
  borderRadius: 6,
  color: "#fca5a5",
  cursor: "pointer",
  transition: "background 0.12s, color 0.12s",
};

const divider: React.CSSProperties = {
  width: 1,
  height: 36,
  background: "rgba(255,255,255,0.08)",
  flexShrink: 0,
};

const optBtn: React.CSSProperties = {
  display: "flex",
  alignItems: "center",
  gap: 6,
  padding: "7px 11px",
  borderRadius: 8,
  border: "1px solid rgba(255,255,255,0.1)",
  fontSize: 12,
  color: "var(--text)",
  background: "transparent",
  whiteSpace: "nowrap",
  cursor: "pointer",
  transition: "background 0.12s, border-color 0.12s",
};

const quickModeBtn: React.CSSProperties = {
  display: "flex",
  flexDirection: "column",
  alignItems: "center",
  gap: 3,
  minWidth: 56,
  padding: "6px 5px",
  borderRadius: 6,
  background: "rgba(245,158,11,0.16)",
  color: "#fbbf24",
  cursor: "pointer",
  transition: "background 0.12s",
};

const recordIconWrap: React.CSSProperties = {
  position: "relative",
  display: "inline-flex",
};

const recordDotBadge: React.CSSProperties = {
  position: "absolute",
  top: -2,
  right: -3,
  width: 6,
  height: 6,
  borderRadius: "50%",
  background: "#ef4444",
  boxShadow: "0 0 4px #ef4444",
};

const closeBtn: React.CSSProperties = {
  width: 32,
  height: 32,
  borderRadius: "50%",
  color: "var(--text-dim)",
  fontSize: 16,
  display: "flex",
  alignItems: "center",
  justifyContent: "center",
  background: "transparent",
  border: "none",
  cursor: "pointer",
  transition: "background 0.12s, color 0.12s",
};

const editorBtn: React.CSSProperties = {
  display: "flex",
  flexDirection: "column",
  alignItems: "center",
  gap: 3,
  minWidth: 56,
  padding: "6px 5px",
  borderRadius: 6,
  color: "#93c5fd",
  background: "rgba(59, 130, 246, 0.12)",
  border: "1px solid rgba(59, 130, 246, 0.28)",
  cursor: "pointer",
  transition: "background 0.12s, border-color 0.12s",
};
