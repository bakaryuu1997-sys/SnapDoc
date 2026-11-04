import React, { useEffect, useState } from "react";
import {
  type OcrLanguageMode,
  OCR_LANG_PRESETS,
  getSavedOcrLang,
  saveOcrLang,
} from "../../lib/ocrService";

export interface OcrInspectorModalProps {
  text: string;
  wordCount: number;
  liveTextEnabled: boolean;
  onToggleLiveText: () => void;
  onCopyAll: (text: string) => void;
  onClose: () => void;
  onFlash?: (msg: string) => void;
  onReRecognize?: (mode: OcrLanguageMode) => Promise<void>;
  isRecognizing?: boolean;
}

export default function OcrInspectorModal({
  text: initialText,
  wordCount,
  liveTextEnabled,
  onToggleLiveText,
  onCopyAll,
  onClose,
  onFlash,
  onReRecognize,
  isRecognizing = false,
}: OcrInspectorModalProps) {
  const [currentText, setCurrentText] = useState(initialText);
  const [searchQuery, setSearchQuery] = useState("");
  const [copied, setCopied] = useState(false);
  const [selectedLang, setSelectedLang] = useState<OcrLanguageMode>(getSavedOcrLang());

  useEffect(() => {
    setCurrentText(initialText);
  }, [initialText]);

  // Đóng khi nhấn Esc
  useEffect(() => {
    const handleKeyDown = (e: KeyboardEvent) => {
      if (e.key === "Escape") {
        onClose();
      }
    };
    window.addEventListener("keydown", handleKeyDown);
    return () => window.removeEventListener("keydown", handleKeyDown);
  }, [onClose]);

  const handleCopy = () => {
    onCopyAll(currentText);
    setCopied(true);
    onFlash?.("Đã sao chép toàn bộ văn bản vào Clipboard! 📑");
    setTimeout(() => setCopied(false), 2000);
  };

  const handleExportTxt = () => {
    try {
      const blob = new Blob([currentText], { type: "text/plain;charset=utf-8" });
      const url = URL.createObjectURL(blob);
      const a = document.createElement("a");
      a.href = url;
      const dateStr = new Date().toISOString().replace(/[:.]/g, "-").slice(0, 19);
      a.download = `snapdoc_ocr_${dateStr}.txt`;
      document.body.appendChild(a);
      a.click();
      document.body.removeChild(a);
      URL.revokeObjectURL(url);
      onFlash?.("Đã xuất file văn bản thành công! 💾");
    } catch {
      onFlash?.("Xuất file thất bại");
    }
  };

  const handleSelectLang = async (mode: OcrLanguageMode) => {
    if (mode === selectedLang && !isRecognizing) return;
    setSelectedLang(mode);
    saveOcrLang(mode);
    if (onReRecognize) {
      await onReRecognize(mode);
    }
  };

  const charCount = currentText.length;
  const lineCount = currentText.split("\n").length;

  return (
    <div style={overlayStyle} onClick={onClose}>
      <div style={modalStyle} onClick={(e) => e.stopPropagation()}>
        {/* Header */}
        <div style={headerStyle}>
          <div style={{ display: "flex", alignItems: "center", gap: 10 }}>
            <span style={{ fontSize: 24, lineHeight: 1 }}>📑</span>
            <div>
              <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
                <h3 style={{ margin: 0, fontSize: 16, fontWeight: 700, color: "#f2f2f5" }}>
                  Bóc tách văn bản (OCR Đa ngôn ngữ)
                </h3>
                <span style={statBadgeStyle}>{wordCount} từ</span>
                <span style={statBadgeStyle}>{charCount} ký tự</span>
                <span style={statBadgeStyle}>{lineCount} dòng</span>
                {isRecognizing && (
                  <span style={{ ...statBadgeStyle, background: "rgba(59, 130, 246, 0.25)", color: "#93c5fd" }}>
                    Đang nhận diện... ⏳
                  </span>
                )}
              </div>
              <p style={{ margin: "2px 0 0 0", fontSize: 12, color: "var(--text-dim, #94a3b8)" }}>
                Hỗ trợ chuẩn xác Tiếng Việt, Tiếng Anh, 日本語 (Tiếng Nhật) & 中文 (Tiếng Trung)
              </p>
            </div>
          </div>

          <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
            <button
              type="button"
              onClick={handleCopy}
              style={{
                ...primaryBtnStyle,
                background: copied ? "rgba(34, 197, 94, 0.25)" : "rgba(59, 130, 246, 0.25)",
                color: copied ? "#86efac" : "#93c5fd",
                border: copied ? "1px solid rgba(34, 197, 94, 0.5)" : "1px solid rgba(59, 130, 246, 0.45)",
              }}
              title="Sao chép toàn bộ văn bản vào Clipboard"
            >
              <span>{copied ? "✓" : "📋"}</span>
              <span>{copied ? "Đã sao chép!" : "Sao chép tất cả"}</span>
            </button>

            <button
              type="button"
              onClick={handleExportTxt}
              style={secondaryBtnStyle}
              title="Lưu thành file .txt về máy tính"
            >
              <span>💾</span>
              <span>Xuất .txt</span>
            </button>

            <button
              type="button"
              onClick={onClose}
              style={closeBtnStyle}
              title="Đóng (Esc)"
            >
              ✕
            </button>
          </div>
        </div>

        {/* Thanh chọn ngôn ngữ chuyên biệt (Language Preset Switcher) */}
        <div style={langBarContainerStyle}>
          <span style={{ fontSize: 11, fontWeight: 700, textTransform: "uppercase", letterSpacing: "0.05em", color: "var(--text-dim, #94a3b8)" }}>
            Ngôn ngữ nhận diện:
          </span>
          <div style={{ display: "flex", alignItems: "center", gap: 6, flexWrap: "wrap" }}>
            {(Object.keys(OCR_LANG_PRESETS) as OcrLanguageMode[]).map((mode) => {
              const preset = OCR_LANG_PRESETS[mode];
              const isActive = selectedLang === mode;
              return (
                <button
                  key={mode}
                  type="button"
                  disabled={isRecognizing}
                  onClick={() => handleSelectLang(mode)}
                  style={{
                    ...langPillStyle,
                    background: isActive ? "rgba(59, 130, 246, 0.25)" : "rgba(255, 255, 255, 0.05)",
                    color: isActive ? "#93c5fd" : "#cbd5e1",
                    borderColor: isActive ? "rgba(59, 130, 246, 0.55)" : "rgba(255, 255, 255, 0.1)",
                    fontWeight: isActive ? 600 : 400,
                  }}
                  title={`Chuyển sang chế độ nhận diện: ${preset.label}`}
                >
                  <span>{preset.flag}</span>
                  <span>{preset.label}</span>
                </button>
              );
            })}
          </div>
        </div>

        {/* Toolbar & Filter */}
        <div style={toolbarStyle}>
          <div style={{ display: "flex", alignItems: "center", gap: 8, flex: 1 }}>
            <input
              type="text"
              placeholder="🔍 Tìm kiếm trong văn bản..."
              value={searchQuery}
              onChange={(e) => setSearchQuery(e.target.value)}
              style={searchInputStyle}
            />
            {searchQuery && (
              <span style={{ fontSize: 12, color: "var(--text-dim, #94a3b8)" }}>
                {
                  (currentText.toLowerCase().match(new RegExp(searchQuery.toLowerCase().replace(/[.*+?^${}()|[\]\\]/g, "\\$&"), "g")) || []).length
                }{" "}
                kết quả
              </span>
            )}
          </div>

          <button
            type="button"
            onClick={onToggleLiveText}
            style={{
              ...toggleBtnStyle,
              background: liveTextEnabled ? "rgba(59, 130, 246, 0.25)" : "rgba(255, 255, 255, 0.06)",
              color: liveTextEnabled ? "#93c5fd" : "var(--text-dim, #94a3b8)",
              border: liveTextEnabled ? "1px solid rgba(59, 130, 246, 0.45)" : "1px solid rgba(255, 255, 255, 0.12)",
            }}
            title="Bật/Tắt chế độ bôi đen chuột trực tiếp trên ảnh"
          >
            <span>🔲</span>
            <span>Chế độ bôi đen trên ảnh (Live Text): {liveTextEnabled ? "BẬT" : "TẮT"}</span>
          </button>
        </div>

        {/* Text Viewer / Editor */}
        <div style={editorContainerStyle}>
          <textarea
            value={currentText}
            onChange={(e) => setCurrentText(e.target.value)}
            style={textareaStyle}
            placeholder="Chưa có văn bản nhận diện..."
          />
        </div>

        {/* Footer info */}
        <div style={footerStyle}>
          <div style={{ display: "flex", alignItems: "center", gap: 12 }}>
            <span style={{ fontSize: 12, color: "var(--text-dim, #94a3b8)" }}>
              💡 <strong>Mẹo:</strong> Bạn có thể chỉnh sửa trực tiếp nội dung ở khung trên trước khi bấm Sao chép hoặc Xuất file.
            </span>
          </div>
          <button
            type="button"
            onClick={onClose}
            style={secondaryBtnStyle}
          >
            Đóng
          </button>
        </div>
      </div>
    </div>
  );
}

const overlayStyle: React.CSSProperties = {
  position: "fixed",
  inset: 0,
  backgroundColor: "rgba(0, 0, 0, 0.7)",
  backdropFilter: "blur(6px)",
  display: "flex",
  alignItems: "center",
  justifyContent: "center",
  zIndex: 9999,
  animation: "fadeIn 0.15s ease-out",
};

const modalStyle: React.CSSProperties = {
  width: "820px",
  maxWidth: "92vw",
  height: "720px",
  maxHeight: "90vh",
  background: "#18181b",
  border: "1px solid rgba(255, 255, 255, 0.12)",
  borderRadius: 12,
  boxShadow: "0 24px 48px -12px rgba(0, 0, 0, 0.65)",
  display: "flex",
  flexDirection: "column",
  overflow: "hidden",
};

const headerStyle: React.CSSProperties = {
  padding: "16px 20px",
  borderBottom: "1px solid rgba(255, 255, 255, 0.08)",
  display: "flex",
  alignItems: "center",
  justifyContent: "space-between",
  background: "rgba(255, 255, 255, 0.02)",
};

const langBarContainerStyle: React.CSSProperties = {
  padding: "8px 20px",
  borderBottom: "1px solid rgba(255, 255, 255, 0.06)",
  display: "flex",
  alignItems: "center",
  gap: 12,
  background: "rgba(0, 0, 0, 0.18)",
};

const langPillStyle: React.CSSProperties = {
  display: "inline-flex",
  alignItems: "center",
  gap: 6,
  padding: "4px 10px",
  borderRadius: 6,
  fontSize: 12,
  cursor: "pointer",
  border: "1px solid transparent",
  transition: "all 0.15s ease",
  outline: "none",
};

const statBadgeStyle: React.CSSProperties = {
  padding: "2px 8px",
  fontSize: 11,
  fontWeight: 600,
  background: "rgba(255, 255, 255, 0.08)",
  color: "#cbd5e1",
  borderRadius: 4,
};

const toolbarStyle: React.CSSProperties = {
  padding: "10px 20px",
  borderBottom: "1px solid rgba(255, 255, 255, 0.06)",
  display: "flex",
  alignItems: "center",
  justifyContent: "space-between",
  gap: 12,
  background: "rgba(255, 255, 255, 0.01)",
};

const searchInputStyle: React.CSSProperties = {
  width: "260px",
  padding: "6px 12px",
  fontSize: 13,
  color: "#f8fafc",
  background: "rgba(0, 0, 0, 0.35)",
  border: "1px solid rgba(255, 255, 255, 0.1)",
  borderRadius: 6,
  outline: "none",
};

const toggleBtnStyle: React.CSSProperties = {
  display: "inline-flex",
  alignItems: "center",
  gap: 6,
  padding: "6px 12px",
  borderRadius: 6,
  fontSize: 12,
  fontWeight: 500,
  cursor: "pointer",
  transition: "all 0.15s ease",
};

const editorContainerStyle: React.CSSProperties = {
  flex: 1,
  padding: "16px 20px",
  display: "flex",
  flexDirection: "column",
  overflow: "hidden",
};

const textareaStyle: React.CSSProperties = {
  flex: 1,
  width: "100%",
  boxSizing: "border-box",
  background: "rgba(0, 0, 0, 0.3)",
  border: "1px solid rgba(255, 255, 255, 0.08)",
  borderRadius: 8,
  padding: 14,
  color: "#e2e8f0",
  fontSize: 13.5,
  lineHeight: 1.6,
  fontFamily: "ui-monospace, SFMono-Regular, Menlo, Monaco, Consolas, monospace",
  resize: "none",
  outline: "none",
};

const footerStyle: React.CSSProperties = {
  padding: "12px 20px",
  borderTop: "1px solid rgba(255, 255, 255, 0.08)",
  display: "flex",
  alignItems: "center",
  justifyContent: "space-between",
  background: "rgba(255, 255, 255, 0.02)",
};

const primaryBtnStyle: React.CSSProperties = {
  display: "inline-flex",
  alignItems: "center",
  gap: 6,
  padding: "6px 14px",
  fontSize: 13,
  fontWeight: 600,
  borderRadius: 6,
  cursor: "pointer",
  outline: "none",
  transition: "all 0.15s ease",
};

const secondaryBtnStyle: React.CSSProperties = {
  display: "inline-flex",
  alignItems: "center",
  gap: 6,
  padding: "6px 12px",
  fontSize: 13,
  fontWeight: 500,
  color: "#e2e8f0",
  background: "rgba(255, 255, 255, 0.06)",
  border: "1px solid rgba(255, 255, 255, 0.12)",
  borderRadius: 6,
  cursor: "pointer",
  outline: "none",
};

const closeBtnStyle: React.CSSProperties = {
  width: 28,
  height: 28,
  display: "flex",
  alignItems: "center",
  justifyContent: "center",
  background: "transparent",
  border: "none",
  color: "var(--text-dim, #94a3b8)",
  fontSize: 14,
  cursor: "pointer",
  borderRadius: 4,
};
