import { useEffect, useRef, useState } from "react";
import { ipc } from "../../lib/ipc";

type Shape = "circle" | "rounded";

interface Prefs {
  deviceId?: string;
  mirrored: boolean;
  shape: Shape;
}

const STORAGE_KEY = "snapdoc.webcamBubble.prefs";

function loadPrefs(): Prefs {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (raw) {
      const parsed = JSON.parse(raw);
      return { mirrored: true, shape: "circle", ...parsed };
    }
  } catch {
    // ignore — localStorage có thể bị chặn (private mode)
  }
  return { mirrored: true, shape: "circle" };
}

function savePrefs(p: Prefs) {
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(p));
  } catch {
    // ignore
  }
}

export default function WebcamBubble() {
  const videoRef = useRef<HTMLVideoElement | null>(null);
  const streamRef = useRef<MediaStream | null>(null);
  const [prefs, setPrefsState] = useState<Prefs>(() => loadPrefs());
  const [devices, setDevices] = useState<MediaDeviceInfo[]>([]);
  const [hovered, setHovered] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const setPrefs = (next: Prefs) => {
    setPrefsState(next);
    savePrefs(next);
  };

  useEffect(() => {
    let cancelled = false;
    let activeStream: MediaStream | null = null;

    const start = async () => {
      try {
        // Xin quyền trước — `enumerateDevices()` chỉ trả `label` đầy đủ sau khi
        // đã có ít nhất 1 lần cấp quyền camera trong phiên này.
        const probe = await navigator.mediaDevices.getUserMedia({ video: true });
        probe.getTracks().forEach((t) => t.stop());

        const list = await navigator.mediaDevices.enumerateDevices();
        const cams = list.filter((d) => d.kind === "videoinput");
        if (cancelled) return;
        setDevices(cams);

        if (cams.length === 0) {
          setError("Không tìm thấy webcam nào trên máy.");
          return;
        }

        const wantId =
          prefs.deviceId && cams.some((c) => c.deviceId === prefs.deviceId)
            ? prefs.deviceId
            : cams[0].deviceId;

        const stream = await navigator.mediaDevices.getUserMedia({
          video: { deviceId: { exact: wantId } },
        });
        if (cancelled) {
          stream.getTracks().forEach((t) => t.stop());
          return;
        }
        activeStream = stream;
        streamRef.current = stream;
        if (videoRef.current) videoRef.current.srcObject = stream;
        setError(null);
        if (wantId !== prefs.deviceId) setPrefs({ ...prefs, deviceId: wantId });
      } catch (e) {
        console.error("Webcam bubble getUserMedia failed:", e);
        if (!cancelled) {
          setError("Không truy cập được webcam — kiểm tra quyền Camera trong Windows Settings.");
        }
      }
    };

    start();
    return () => {
      cancelled = true;
      activeStream?.getTracks().forEach((t) => t.stop());
      streamRef.current = null;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [prefs.deviceId]);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") ipc.closeSelf();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, []);

  const switchCamera = () => {
    if (devices.length < 2) return;
    const idx = devices.findIndex((d) => d.deviceId === prefs.deviceId);
    const next = devices[(idx + 1) % devices.length];
    setPrefs({ ...prefs, deviceId: next.deviceId });
  };

  const toggleMirror = () => setPrefs({ ...prefs, mirrored: !prefs.mirrored });
  const toggleShape = () =>
    setPrefs({ ...prefs, shape: prefs.shape === "circle" ? "rounded" : "circle" });

  const radius = prefs.shape === "circle" ? "50%" : "20%";

  return (
    <div
      style={wrap}
      data-tauri-drag-region
      onMouseEnter={() => setHovered(true)}
      onMouseLeave={() => setHovered(false)}
      title="Kéo để di chuyển webcam • Esc để đóng"
    >
      <div style={{ ...frame, borderRadius: radius }} data-tauri-drag-region>
        {error ? (
          <div style={errorText}>{error}</div>
        ) : (
          <video
            ref={videoRef}
            autoPlay
            playsInline
            muted
            style={{
              ...videoStyle,
              transform: prefs.mirrored ? "scaleX(-1)" : "none",
            }}
          />
        )}
      </div>
      <div
        style={{ ...toolbar, opacity: hovered ? 1 : 0, pointerEvents: hovered ? "auto" : "none" }}
        onClick={(e) => e.stopPropagation()}
      >
        <button style={iconBtn} onClick={switchCamera} title="Đổi camera" disabled={devices.length < 2}>
          🔄
        </button>
        <button style={iconBtn} onClick={toggleMirror} title="Lật ngang (Mirror)">
          🪞
        </button>
        <button style={iconBtn} onClick={toggleShape} title="Đổi hình dạng (Tròn / Bo góc)">
          ⬭
        </button>
        <button
          style={{ ...iconBtn, color: "#f87171" }}
          onClick={() => ipc.closeSelf()}
          title="Đóng Webcam Bubble (Esc)"
        >
          ✕
        </button>
      </div>
    </div>
  );
}

/* ── Styles ── */

const wrap: React.CSSProperties = {
  width: "100%",
  height: "100%",
  position: "relative",
  display: "flex",
  alignItems: "center",
  justifyContent: "center",
  background: "transparent",
  userSelect: "none",
};

const frame: React.CSSProperties = {
  width: "100%",
  height: "100%",
  overflow: "hidden",
  border: "3px solid rgba(255,255,255,0.85)",
  boxShadow: "0 8px 28px rgba(0,0,0,0.45)",
  background: "#111",
  display: "flex",
  alignItems: "center",
  justifyContent: "center",
};

const videoStyle: React.CSSProperties = {
  width: "100%",
  height: "100%",
  objectFit: "cover",
  pointerEvents: "none",
};

const errorText: React.CSSProperties = {
  fontSize: 11,
  color: "#f87171",
  textAlign: "center",
  padding: 10,
};

const toolbar: React.CSSProperties = {
  position: "absolute",
  bottom: 6,
  left: "50%",
  transform: "translateX(-50%)",
  display: "flex",
  gap: 4,
  background: "rgba(24,24,28,0.92)",
  border: "1px solid rgba(255,255,255,0.12)",
  borderRadius: 8,
  padding: "4px 6px",
  transition: "opacity 0.12s ease",
  zIndex: 10,
};

const iconBtn: React.CSSProperties = {
  width: 26,
  height: 26,
  display: "flex",
  alignItems: "center",
  justifyContent: "center",
  background: "rgba(255,255,255,0.08)",
  border: "none",
  borderRadius: 6,
  cursor: "pointer",
  fontSize: 12,
};
