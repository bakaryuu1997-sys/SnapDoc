import { useEffect, useState, useRef } from "react";
import { useTranslation } from "react-i18next";
import { ipc } from "../lib/ipc";
import { showError } from "../lib/notify";
import { cleanPath, looksLikeVideoPath } from "../lib/useFileDrop";

interface CommandItem {
  id: string;
  category: string;
  icon: string;
  title: string;
  subtitle: string;
  shortcut?: string;
  action: () => void | Promise<void>;
}

export default function CommandPalette() {
  const { t } = useTranslation();
  const [open, setOpen] = useState(false);
  const [query, setQuery] = useState("");
  const [selectedIndex, setSelectedIndex] = useState(0);
  const inputRef = useRef<HTMLInputElement | null>(null);
  const listRef = useRef<HTMLDivElement | null>(null);

  const commands: CommandItem[] = [
    // Chụp ảnh
    {
      id: "quick-capture",
      category: t("commandPalette.categoryCapture", "Chụp ảnh"),
      icon: "⚡",
      title: t("commandPalette.quickCapture", "Chụp nhanh (Quick Capture)"),
      subtitle: t("commandPalette.quickCaptureDesc", "Chọn vùng và chú thích tức thì tại chỗ"),
      shortcut: "Ctrl+Shift+A",
      action: () => { ipc.startQuick().catch(() => {}); },
    },
    {
      id: "capture-region",
      category: t("commandPalette.categoryCapture", "Chụp ảnh"),
      icon: "✂️",
      title: t("commandPalette.captureRegion", "Chụp vùng chọn (Region)"),
      subtitle: t("commandPalette.captureRegionDesc", "Kéo chuột chọn vùng cần chụp"),
      shortcut: "Ctrl+Shift+R",
      action: () => { ipc.captureNow("region", "editor").catch(() => {}); },
    },
    {
      id: "capture-window",
      category: t("commandPalette.categoryCapture", "Chụp ảnh"),
      icon: "🪟",
      title: t("commandPalette.captureWindow", "Chụp một cửa sổ (Window)"),
      subtitle: t("commandPalette.captureWindowDesc", "Chọn nhanh cửa sổ ứng dụng đang mở"),
      action: () => { ipc.captureNow("window", "editor").catch(() => {}); },
    },
    {
      id: "capture-full",
      category: t("commandPalette.categoryCapture", "Chụp ảnh"),
      icon: "🖥️",
      title: t("commandPalette.captureFull", "Chụp toàn màn hình (Full Screen)"),
      subtitle: t("commandPalette.captureFullDesc", "Chụp trọn vẹn màn hình hiện tại"),
      action: () => { ipc.captureNow("full", "editor").catch(() => {}); },
    },
    {
      id: "capture-scroll",
      category: t("commandPalette.categoryCapture", "Chụp ảnh"),
      icon: "📜",
      title: t("commandPalette.captureScroll", "Chụp cuộn dài (Scrolling Capture)"),
      subtitle: t("commandPalette.captureScrollDesc", "Cuộn trang web hoặc tài liệu dài để ghép ảnh"),
      action: () => { ipc.captureNow("scroll", "editor").catch(() => {}); },
    },

    // Quay video
    {
      id: "record-region",
      category: t("commandPalette.categoryRecord", "Quay video"),
      icon: "🎥",
      title: t("commandPalette.recordRegion", "Quay video vùng chọn"),
      subtitle: t("commandPalette.recordRegionDesc", "Quay video khu vực được chọn kèm âm thanh"),
      action: () => { ipc.startRecordPicker("region").catch(() => {}); },
    },
    {
      id: "record-window",
      category: t("commandPalette.categoryRecord", "Quay video"),
      icon: "🪟",
      title: t("commandPalette.recordWindow", "Quay video một cửa sổ"),
      subtitle: t("commandPalette.recordWindowDesc", "Quay riêng cửa sổ phần mềm cụ thể"),
      action: () => { ipc.startRecordPicker("window").catch(() => {}); },
    },
    {
      id: "record-full",
      category: t("commandPalette.categoryRecord", "Quay video"),
      icon: "🖥️",
      title: t("commandPalette.recordFull", "Quay video toàn màn hình"),
      subtitle: t("commandPalette.recordFullDesc", "Ghi hình toàn bộ màn hình máy tính"),
      shortcut: "Ctrl+Shift+C",
      action: () => { ipc.startRecordPicker("full").catch(() => {}); },
    },

    // Trích xuất OCR
    {
      id: "quick-ocr",
      category: t("commandPalette.categoryCapture", "Chụp ảnh"),
      icon: "📝",
      title: "Trích xuất chữ (OCR) tức thì từ màn hình",
      subtitle: "Kéo chọn vùng màn hình bất kỳ để bóc tách chữ vào Clipboard",
      shortcut: "Ctrl+Shift+T",
      action: () => { ipc.startQuick().catch(() => {}); },
    },

    // Webcam
    {
      id: "toggle-webcam-bubble",
      category: t("commandPalette.categoryRecord", "Quay video"),
      icon: "🫧",
      title: "Bật/Tắt Webcam Bubble",
      subtitle: "Camera tròn nổi trên màn hình — hữu ích khi quay video hướng dẫn",
      action: async () => {
        const isOpen = await ipc.isWebcamBubbleOpen().catch(() => false);
        if (isOpen) {
          await ipc.closeWebcamBubble().catch(() => {});
        } else {
          await ipc.openWebcamBubble().catch(() => {});
        }
      },
    },

    // Quản lý & Hệ thống
    {
      id: "open-history",
      category: t("commandPalette.categorySystem", "Hệ thống"),
      icon: "🕒",
      title: t("commandPalette.openHistory", "Mở Thư viện Lịch sử (History)"),
      subtitle: t("commandPalette.openHistoryDesc", "Xem lại toàn bộ ảnh và video đã chụp"),
      action: () => { ipc.openHistory().catch(() => {}); },
    },
    {
      id: "open-capture-bar",
      category: t("commandPalette.categorySystem", "Hệ thống"),
      icon: "✨",
      title: t("commandPalette.openCaptureBar", "Mở thanh công cụ nổi (Capture Bar)"),
      subtitle: t("commandPalette.openCaptureBarDesc", "Hiển thị thanh nổi điều khiển ở đỉnh màn hình"),
      action: () => { ipc.openCaptureBar().catch(() => {}); },
    },
    {
      id: "open-video",
      category: t("commandPalette.categorySystem", "Hệ thống"),
      icon: "🎞️",
      title: t("intake.paletteOpenVideo", "Mở video từ máy…"),
      subtitle: t("intake.paletteOpenVideoDesc", "Chọn file video (mp4, mov, mkv…) để cắt, chỉnh tốc độ, tạo phụ đề. Cũng có thể kéo-thả file vào cửa sổ."),
      action: () => { ipc.pickAndOpenVideo().catch((e) => showError(e)); },
    },
    {
      id: "open-settings",
      category: t("commandPalette.categorySystem", "Hệ thống"),
      icon: "⚙️",
      title: t("commandPalette.openSettings", "Mở Cài đặt (Settings)"),
      subtitle: t("commandPalette.openSettingsDesc", "Tuỳ chỉnh phím tắt, đường dẫn lưu và ghi âm"),
      action: () => { ipc.openSettings().catch(() => {}); },
    },
  ];

  // Listen for Ctrl+K or Cmd+K
  useEffect(() => {
    const handleKeyDown = (e: KeyboardEvent) => {
      if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === "k") {
        e.preventDefault();
        setOpen((prev) => !prev);
        setQuery("");
        setSelectedIndex(0);
      }
      if (e.key === "Escape" && open) {
        setOpen(false);
      }
    };

    window.addEventListener("keydown", handleKeyDown);
    return () => window.removeEventListener("keydown", handleKeyDown);
  }, [open]);

  useEffect(() => {
    if (open) {
      setTimeout(() => inputRef.current?.focus(), 50);
    }
  }, [open]);

  // Filter commands
  // Dán đường dẫn file video (kể cả kiểu "Copy as path" có ngoặc kép) → mục "Mở video" ở đầu danh sách.
  const pastedVideo = looksLikeVideoPath(query) ? cleanPath(query) : null;
  const filtered: CommandItem[] = [
    ...(pastedVideo
      ? [{
          id: "open-video-path",
          category: t("commandPalette.categorySystem", "Hệ thống"),
          icon: "🎞️",
          title: t("intake.paletteOpenVideoPath", "Mở video đã dán trong Editor"),
          subtitle: pastedVideo,
          action: () => { ipc.openVideoFilePath(pastedVideo).catch((e) => showError(e)); },
        } as CommandItem]
      : []),
    ...commands.filter((c) => {
      const q = query.trim().toLowerCase();
      if (!q) return true;
      return (
        c.title.toLowerCase().includes(q) ||
        c.subtitle.toLowerCase().includes(q) ||
        c.category.toLowerCase().includes(q)
      );
    }),
  ];

  // Handle keyboard navigation
  const handleNav = (e: React.KeyboardEvent) => {
    if (e.key === "ArrowDown") {
      e.preventDefault();
      setSelectedIndex((prev) => (prev + 1) % Math.max(1, filtered.length));
    } else if (e.key === "ArrowUp") {
      e.preventDefault();
      setSelectedIndex((prev) => (prev - 1 + filtered.length) % Math.max(1, filtered.length));
    } else if (e.key === "Enter") {
      e.preventDefault();
      const item = filtered[selectedIndex];
      if (item) {
        setOpen(false);
        item.action();
      }
    }
  };

  if (!open) return null;

  return (
    <div
      style={backdrop}
      onClick={() => setOpen(false)}
      role="dialog"
      aria-modal="true"
    >
      <div
        style={modal}
        onClick={(e) => e.stopPropagation()}
        onKeyDown={handleNav}
      >
        {/* Search header */}
        <div style={searchWrap}>
          <span style={{ fontSize: 16, opacity: 0.6, userSelect: "none" }}>🔍</span>
          <input
            ref={inputRef}
            type="text"
            value={query}
            onChange={(e) => {
              setQuery(e.target.value);
              setSelectedIndex(0);
            }}
            placeholder={t("commandPalette.placeholder", "Tìm lệnh hoặc hành động... (Ctrl+K)")}
            style={searchInput}
          />
          <kbd style={escBadge}>Esc</kbd>
        </div>

        {/* Results list */}
        <div ref={listRef} style={listContainer}>
          {filtered.length === 0 ? (
            <div style={noResults}>
              {t("commandPalette.noResults", "Không tìm thấy lệnh nào phù hợp.")}
            </div>
          ) : (
            filtered.map((item, idx) => {
              const active = idx === selectedIndex;
              return (
                <div
                  key={item.id}
                  style={active ? activeItemRow : itemRow}
                  onMouseEnter={() => setSelectedIndex(idx)}
                  onClick={() => {
                    setOpen(false);
                    item.action();
                  }}
                >
                  <span style={iconWrap}>{item.icon}</span>
                  <div style={textWrap}>
                    <div style={itemTitle}>{item.title}</div>
                    <div style={itemSubtitle}>{item.subtitle}</div>
                  </div>
                  {item.shortcut && <kbd style={shortcutBadge}>{item.shortcut}</kbd>}
                </div>
              );
            })
          )}
        </div>

        {/* Footer info */}
        <div style={footer}>
          <span style={{ opacity: 0.7 }}>
            ↑↓ Điều hướng · ↵ Chọn · Esc Đóng
          </span>
          <span style={{ color: "#f59e0b", fontWeight: 600 }}>SnapDoc v3.9.3</span>
        </div>
      </div>
    </div>
  );
}

/* ── Styles ── */

const backdrop: React.CSSProperties = {
  position: "fixed",
  inset: 0,
  background: "rgba(0, 0, 0, 0.65)",
  backdropFilter: "blur(4px)",
  display: "flex",
  alignItems: "flex-start",
  justifyContent: "center",
  paddingTop: "12vh",
  zIndex: 100000,
  animation: "fadeIn 0.12s ease-out",
};

const modal: React.CSSProperties = {
  width: 560,
  maxWidth: "92vw",
  background: "#18181b",
  border: "1px solid rgba(255, 255, 255, 0.12)",
  borderRadius: 14,
  boxShadow: "0 24px 60px rgba(0, 0, 0, 0.7), 0 0 0 1px rgba(255, 255, 255, 0.05)",
  display: "flex",
  flexDirection: "column",
  overflow: "hidden",
};

const searchWrap: React.CSSProperties = {
  display: "flex",
  alignItems: "center",
  gap: 12,
  padding: "14px 18px",
  borderBottom: "1px solid rgba(255, 255, 255, 0.08)",
};

const searchInput: React.CSSProperties = {
  flex: 1,
  background: "transparent",
  border: "none",
  color: "#f4f4f5",
  fontSize: 15,
  outline: "none",
  letterSpacing: "-0.01em",
};

const escBadge: React.CSSProperties = {
  fontSize: 10,
  padding: "2px 6px",
  background: "rgba(255, 255, 255, 0.08)",
  borderRadius: 4,
  color: "#a1a1aa",
  border: "1px solid rgba(255, 255, 255, 0.1)",
  fontFamily: "monospace",
};

const listContainer: React.CSSProperties = {
  maxHeight: 380,
  overflowY: "auto",
  padding: "8px 6px",
  display: "flex",
  flexDirection: "column",
  gap: 2,
};

const itemRow: React.CSSProperties = {
  display: "flex",
  alignItems: "center",
  gap: 12,
  padding: "10px 12px",
  borderRadius: 8,
  cursor: "pointer",
  transition: "all 0.08s ease",
};

const activeItemRow: React.CSSProperties = {
  ...itemRow,
  background: "rgba(245, 158, 11, 0.14)",
  border: "1px solid rgba(245, 158, 11, 0.28)",
};

const iconWrap: React.CSSProperties = {
  fontSize: 18,
  width: 24,
  display: "flex",
  alignItems: "center",
  justifyContent: "center",
};

const textWrap: React.CSSProperties = {
  flex: 1,
  minWidth: 0,
};

const itemTitle: React.CSSProperties = {
  fontSize: 13.5,
  fontWeight: 600,
  color: "#f4f4f5",
};

const itemSubtitle: React.CSSProperties = {
  fontSize: 11.5,
  color: "#71717a",
  whiteSpace: "nowrap",
  overflow: "hidden",
  textOverflow: "ellipsis",
  marginTop: 1,
};

const shortcutBadge: React.CSSProperties = {
  fontSize: 10.5,
  padding: "3px 7px",
  background: "rgba(255, 255, 255, 0.07)",
  borderRadius: 4,
  color: "#d4d4d8",
  border: "1px solid rgba(255, 255, 255, 0.1)",
  fontFamily: "monospace",
};

const noResults: React.CSSProperties = {
  padding: "32px 16px",
  textAlign: "center",
  fontSize: 13,
  color: "#71717a",
};

const footer: React.CSSProperties = {
  padding: "8px 18px",
  borderTop: "1px solid rgba(255, 255, 255, 0.06)",
  background: "rgba(0, 0, 0, 0.2)",
  display: "flex",
  justifyContent: "space-between",
  alignItems: "center",
  fontSize: 11,
  color: "#71717a",
};
