import { useEffect, useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import { ipc } from "../../lib/ipc";
import { showError } from "../../lib/notify";
import { copyToClipboard } from "../../features/output/useOutput";

export default function PinnedWindow() {
  const [imageSrc, setImageSrc] = useState<string | null>(null);
  const [opacity, setOpacity] = useState<number>(1.0);
  const [zoom, setZoom] = useState<number>(1.0);
  const [isHovered, setIsHovered] = useState<boolean>(false);
  const [copied, setCopied] = useState<boolean>(false);
  const [alwaysOnTop, setAlwaysOnTop] = useState<boolean>(true);

  const toggleAlwaysOnTop = async () => {
    const nextVal = !alwaysOnTop;
    try {
      await invoke("set_always_on_top", { alwaysOnTop: nextVal });
      setAlwaysOnTop(nextVal);
    } catch (e) {
      showError(e);
    }
  };

  const label = new URLSearchParams(window.location.search).get("label") ?? "";

  useEffect(() => {
    if (!label) return;
    invoke<string | null>("get_pinned_image", { label })
      .then((src) => {
        if (src) setImageSrc(src);
      })
      .catch((err) => showError(err));
  }, [label]);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") {
        ipc.closeSelf();
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, []);

  const handleClose = () => {
    ipc.closeSelf();
  };

  const handleWheel = (e: React.WheelEvent) => {
    e.preventDefault();
    if (e.deltaY < 0) {
      setZoom((z) => Math.min(3.0, z + 0.1));
    } else {
      setZoom((z) => Math.max(0.3, z - 0.1));
    }
  };

  const handleCopy = async () => {
    if (!imageSrc) return;
    try {
      await copyToClipboard(imageSrc);
      setCopied(true);
      setTimeout(() => setCopied(false), 1500);
    } catch (e) {
      showError(e);
    }
  };

  if (!imageSrc) {
    return (
      <div style={wrap} data-tauri-drag-region>
        <div style={loadingText}>Đang nạp ảnh ghim…</div>
      </div>
    );
  }

  return (
    <div
      style={{
        ...wrap,
        opacity,
      }}
      data-tauri-drag-region
      onMouseEnter={() => setIsHovered(true)}
      onMouseLeave={() => setIsHovered(false)}
      onDoubleClick={handleClose}
      onWheel={handleWheel}
      title="Kéo để di chuyển • Cuộn chuột để zoom • Nhấp đúp để đóng"
    >
      {/* Floating Toolbar Header (Fades in on hover) */}
      <div
        style={{
          ...toolbar,
          opacity: isHovered ? 1 : 0,
          pointerEvents: isHovered ? "auto" : "none",
        }}
        data-tauri-drag-region
        onClick={(e) => e.stopPropagation()}
        onDoubleClick={(e) => e.stopPropagation()}
      >
        {/* Opacity Selector */}
        <div style={pillGroup}>
          {[1.0, 0.75, 0.5, 0.25].map((val) => (
            <button
              key={val}
              onClick={() => setOpacity(val)}
              style={{
                ...pillBtn,
                background: opacity === val ? "rgba(255, 255, 255, 0.25)" : "transparent",
                color: opacity === val ? "#ffffff" : "var(--text-dim)",
              }}
              title={`Độ mờ: ${Math.round(val * 100)}%`}
            >
              {Math.round(val * 100)}%
            </button>
          ))}
        </div>

        {/* Zoom Controls */}
        <div style={pillGroup}>
          <button
            style={pillBtn}
            onClick={() => setZoom((z) => Math.max(0.3, z - 0.15))}
            title="Thu nhỏ"
          >
            -
          </button>
          <button
            style={pillBtn}
            onClick={() => setZoom(1.0)}
            title="Kích thước gốc 100%"
          >
            {Math.round(zoom * 100)}%
          </button>
          <button
            style={pillBtn}
            onClick={() => setZoom((z) => Math.min(3.0, z + 0.15))}
            title="Phóng to"
          >
            +
          </button>
        </div>

        {/* Always-on-top Pin Button */}
        <button
          style={{
            ...iconBtn,
            color: alwaysOnTop ? "#38bdf8" : "var(--text-dim)",
            background: alwaysOnTop ? "rgba(56, 189, 248, 0.25)" : "rgba(255, 255, 255, 0.08)",
          }}
          onClick={toggleAlwaysOnTop}
          title={alwaysOnTop ? "Đang ghim trên mọi ứng dụng (Always on Top) — Bấm để bỏ ghim" : "Đã bỏ ghim — Bấm để ghim trên mọi ứng dụng"}
        >
          📌
        </button>

        {/* Copy Button */}
        <button
          style={{ ...iconBtn, color: copied ? "#34d399" : "var(--text)" }}
          onClick={handleCopy}
          title={copied ? "Đã copy ảnh ✓" : "Copy vào Clipboard"}
        >
          {copied ? "✓" : "📋"}
        </button>

        {/* Close Button */}
        <button
          style={{ ...iconBtn, color: "#f87171" }}
          onClick={handleClose}
          title="Đóng ghim (Esc hoặc nhấp đúp)"
        >
          ✕
        </button>
      </div>

      {/* Image Container with Zoom */}
      <div style={imageContainer} data-tauri-drag-region>
        <img
          src={imageSrc}
          alt="Pinned"
          data-tauri-drag-region
          style={{
            ...imageStyle,
            transform: `scale(${zoom})`,
          }}
          draggable={false}
        />
      </div>
    </div>
  );
}

/* ── Styles ── */

const wrap: React.CSSProperties = {
  width: "100%",
  height: "100%",
  boxSizing: "border-box",
  background: "rgba(22, 22, 26, 0.88)",
  borderRadius: 12,
  overflow: "hidden",
  display: "flex",
  flexDirection: "column",
  position: "relative",
  userSelect: "none",
  border: "1px solid rgba(255, 255, 255, 0.12)",
  boxShadow: "0 12px 36px rgba(0, 0, 0, 0.45)",
  transition: "opacity 0.15s ease",
};

const toolbar: React.CSSProperties = {
  position: "absolute",
  top: 8,
  left: "50%",
  transform: "translateX(-50%)",
  background: "rgba(30, 30, 36, 0.92)",
  border: "1px solid rgba(255, 255, 255, 0.15)",
  borderRadius: 8,
  padding: "4px 8px",
  display: "flex",
  alignItems: "center",
  gap: 8,
  zIndex: 100,
  boxShadow: "0 6px 20px rgba(0, 0, 0, 0.4)",
  transition: "opacity 0.15s ease",
};

const pillGroup: React.CSSProperties = {
  display: "flex",
  alignItems: "center",
  background: "rgba(255, 255, 255, 0.08)",
  borderRadius: 6,
  padding: 2,
  gap: 2,
};

const pillBtn: React.CSSProperties = {
  border: "none",
  padding: "2px 6px",
  fontSize: 11,
  fontWeight: 500,
  borderRadius: 4,
  cursor: "pointer",
  transition: "background 0.1s, color 0.1s",
};

const iconBtn: React.CSSProperties = {
  width: 24,
  height: 24,
  display: "flex",
  alignItems: "center",
  justifyContent: "center",
  background: "rgba(255, 255, 255, 0.08)",
  border: "none",
  borderRadius: 6,
  cursor: "pointer",
  fontSize: 12,
  transition: "background 0.1s",
};

const imageContainer: React.CSSProperties = {
  flex: 1,
  width: "100%",
  height: "100%",
  display: "flex",
  alignItems: "center",
  justifyContent: "center",
  overflow: "hidden",
  padding: 8,
  boxSizing: "border-box",
};

const imageStyle: React.CSSProperties = {
  maxWidth: "100%",
  maxHeight: "100%",
  objectFit: "contain",
  borderRadius: 6,
  transition: "transform 0.1s ease-out",
  pointerEvents: "none",
};

const loadingText: React.CSSProperties = {
  margin: "auto",
  fontSize: 12,
  color: "var(--text-dim)",
};
