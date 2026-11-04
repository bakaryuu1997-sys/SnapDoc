import React from "react";
import type { MouseTelemetryFile } from "../../lib/ipc";
import { type Segment } from "./segments";
import { getSmoothCursorState, type ClickRipple } from "./mouseFocusEngine";

export interface SmoothCursorOverlayProps {
  telemetry: MouseTelemetryFile | null | undefined;
  playheadMs: number;
  videoRef: React.RefObject<HTMLVideoElement | null>;
  segments?: Segment[];
  enabled?: boolean;
  cursorStyle?: "mac" | "windows" | "dot";
  showRipples?: boolean;
}

export const SmoothCursorOverlay: React.FC<SmoothCursorOverlayProps> = ({
  telemetry,
  playheadMs,
  videoRef,
  segments,
  enabled = true,
  cursorStyle = "mac",
  showRipples = true,
}) => {
  if (!enabled || !telemetry || !telemetry.events || telemetry.events.length === 0) {
    return null;
  }

  const cursorState = getSmoothCursorState(telemetry, playheadMs, segments);

  if (!cursorState.visible) {
    return null;
  }

  // Tính toán vùng hiển thị thực tế của nội dung video bên trong videoRef (object-fit: contain)
  const videoEl = videoRef.current;
  const cw = videoEl?.clientWidth || 1;
  const ch = videoEl?.clientHeight || 1;
  const vw = telemetry.videoWidth > 0 ? telemetry.videoWidth : 1920;
  const vh = telemetry.videoHeight > 0 ? telemetry.videoHeight : 1080;

  const containerRatio = cw / ch;
  const videoRatio = vw / vh;
  let vidW = cw;
  let vidH = ch;
  let vidL = 0;
  let vidT = 0;

  if (containerRatio > videoRatio) {
    vidW = ch * videoRatio;
    vidL = (cw - vidW) / 2;
  } else {
    vidH = cw / videoRatio;
    vidT = (ch - vidH) / 2;
  }

  // Toạ độ pixel chính xác của đầu mũi con trỏ chuột trên wrapper
  const screenX = vidL + cursorState.x * vidW;
  const screenY = vidT + cursorState.y * vidH;

  return (
    <div
      style={{
        position: "absolute",
        inset: 0,
        pointerEvents: "none",
        zIndex: 15,
        overflow: "hidden",
      }}
      aria-hidden="true"
    >
      {/* 1. Hiệu ứng Vòng sóng nước Click (Ripple Waves) */}
      {showRipples &&
        cursorState.ripples.map((rip: ClickRipple) => {
          const ripX = vidL + rip.x * vidW;
          const ripY = vidT + rip.y * vidH;
          const rippleColor =
            rip.button === "right"
              ? "rgba(244, 63, 94, " // Hồng neon cho chuột phải
              : rip.button === "middle"
              ? "rgba(168, 85, 247, " // Tím neon cho chuột giữa
              : "rgba(56, 189, 248, "; // Xanh dương cyan Screen Studio cho chuột trái

          return (
            <div
              key={rip.id}
              style={{
                position: "absolute",
                left: ripX,
                top: ripY,
                transform: "translate(-50%, -50%)",
                width: rip.radiusPx * 2,
                height: rip.radiusPx * 2,
                borderRadius: "50%",
                border: `2px solid ${rippleColor}${rip.opacity})`,
                backgroundColor: `${rippleColor}${rip.opacity * 0.25})`,
                boxShadow: `0 0 12px ${rippleColor}${rip.opacity * 0.7})`,
                pointerEvents: "none",
                willChange: "transform, opacity",
              }}
            />
          );
        })}

      {/* 2. Con trỏ chuột điện ảnh mượt mà (Cinematic Cursor) */}
      <div
        style={{
          position: "absolute",
          left: screenX,
          top: screenY,
          transform: `scale(${cursorState.clickScale})`,
          transformOrigin: "top left",
          transition: "transform 0.08s cubic-bezier(0.2, 0.9, 0.3, 1)",
          willChange: "left, top, transform",
          filter: "drop-shadow(0 3px 6px rgba(0, 0, 0, 0.45))",
        }}
      >
        {cursorStyle === "mac" ? (
          // Mac-style Black Arrow với viền trắng tương phản cao
          <svg
            width="24"
            height="24"
            viewBox="0 0 24 24"
            fill="none"
            xmlns="http://www.w3.org/2000/svg"
            style={{ display: "block" }}
          >
            <path
              d="M3 2.5V20.5C3 20.8 3.35 21 3.6 20.8L8.8 15.6C8.95 15.45 9.15 15.35 9.35 15.35H16.5C16.85 15.35 17.05 14.9 16.8 14.65L3.8 2.15C3.6 1.95 3 2.1 3 2.5Z"
              fill="#000000"
              stroke="#ffffff"
              strokeWidth="1.75"
              strokeLinejoin="round"
            />
          </svg>
        ) : cursorStyle === "windows" ? (
          // Windows 11 Fluent Style Arrow
          <svg
            width="24"
            height="24"
            viewBox="0 0 24 24"
            fill="none"
            xmlns="http://www.w3.org/2000/svg"
            style={{ display: "block" }}
          >
            <path
              d="M4 2L4 20L8.5 15.5L12 22L14.5 20.5L11 14L18 14L4 2Z"
              fill="#ffffff"
              stroke="#1a1a1a"
              strokeWidth="1.5"
              strokeLinejoin="round"
            />
          </svg>
        ) : (
          // Dot Cursor (Vòng tròn hiện đại kiểu Presentation)
          <div
            style={{
              width: 14,
              height: 14,
              borderRadius: "50%",
              backgroundColor: "#38bdf8",
              border: "2px solid #ffffff",
              boxShadow: "0 0 10px rgba(56, 189, 248, 0.8)",
              transform: "translate(-50%, -50%)",
            }}
          />
        )}
      </div>
    </div>
  );
};
