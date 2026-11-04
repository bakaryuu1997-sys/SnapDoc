import { describe, it, expect } from "vitest";
import {
  detectFocusZone,
  calculateSmartFocusPoint,
  FOCUS_ZONE_PRESETS,
  interpolateHermite,
  findEventIndexAtTime,
  getSmoothCursorState,
} from "./mouseFocusEngine";
import type { MouseTelemetryFile } from "../../lib/ipc";

describe("VideoTrimmer mouseFocusEngine", () => {
  it("detectFocusZone correctly classifies coordinates", () => {
    // Exact center
    expect(detectFocusZone(0.5, 0.5)).toBe("center");
    // Slightly off center (within deadband)
    expect(detectFocusZone(0.52, 0.48)).toBe("center");

    // Left zone
    expect(detectFocusZone(0.25, 0.5)).toBe("left");
    // Right zone
    expect(detectFocusZone(0.75, 0.5)).toBe("right");
    // Top zone
    expect(detectFocusZone(0.5, 0.2)).toBe("top");
    // Bottom zone
    expect(detectFocusZone(0.5, 0.8)).toBe("bottom");

    // Corners
    expect(detectFocusZone(0.2, 0.2)).toBe("top-left");
    expect(detectFocusZone(0.8, 0.2)).toBe("top-right");
    expect(detectFocusZone(0.2, 0.8)).toBe("bottom-left");
    expect(detectFocusZone(0.8, 0.8)).toBe("bottom-right");
  });

  it("calculateSmartFocusPoint locks center zone to 0.5, 0.5", () => {
    // Within center zone deadband (dx <= 0.16, dy <= 0.22)
    const res1 = calculateSmartFocusPoint(0.5, 0.5);
    expect(res1.zone).toBe("center");
    expect(res1.focusX).toBe(0.5);
    expect(res1.focusY).toBe(0.5);

    const res2 = calculateSmartFocusPoint(0.48, 0.52);
    expect(res2.zone).toBe("center");
    expect(res2.focusX).toBe(0.5);
    expect(res2.focusY).toBe(0.5);
  });

  it("calculateSmartFocusPoint clamps left column to safe region [0.2, 0.32]", () => {
    const res = calculateSmartFocusPoint(0.25, 0.5);
    expect(res.zone).toBe("left");
    expect(res.focusX).toBe(0.25);
    expect(res.focusY).toBe(0.5);

    // Extreme left is clamped to 0.2
    const resFarLeft = calculateSmartFocusPoint(0.05, 0.5);
    expect(resFarLeft.zone).toBe("left");
    expect(resFarLeft.focusX).toBe(0.2);
  });

  it("calculateSmartFocusPoint clamps right column to safe region [0.68, 0.8]", () => {
    const res = calculateSmartFocusPoint(0.75, 0.5);
    expect(res.zone).toBe("right");
    expect(res.focusX).toBe(0.75);
    expect(res.focusY).toBe(0.5);

    // Extreme right is clamped to 0.8
    const resFarRight = calculateSmartFocusPoint(0.95, 0.5);
    expect(resFarRight.zone).toBe("right");
    expect(resFarRight.focusX).toBe(0.8);
  });

  it("FOCUS_ZONE_PRESETS has valid definitions", () => {
    expect(FOCUS_ZONE_PRESETS.length).toBeGreaterThan(0);
    const center = FOCUS_ZONE_PRESETS.find((p) => p.zone === "center");
    expect(center).toBeDefined();
    expect(center?.focusX).toBe(0.5);
    expect(center?.focusY).toBe(0.5);
  });

  // ==========================================================================
  // SCREEN STUDIO CINEMATIC ENGINE TESTS
  // ==========================================================================

  describe("Screen Studio Bezier & Hermite Cursor Interpolation", () => {
    it("interpolateHermite smoothly transitions between p1 and p2", () => {
      // p1=100, p2=300, v1=0, v2=0, dt=1
      expect(interpolateHermite(100, 300, 0, 0, 1, 0)).toBeCloseTo(100);
      expect(interpolateHermite(100, 300, 0, 0, 1, 1)).toBeCloseTo(300);
      expect(interpolateHermite(100, 300, 0, 0, 1, 0.5)).toBeCloseTo(200);
    });

    it("findEventIndexAtTime uses binary search correctly", () => {
      const events = [
        { t: 0, x: 0, y: 0, type: "move" as const },
        { t: 100, x: 10, y: 10, type: "move" as const },
        { t: 300, x: 50, y: 50, type: "click" as const },
        { t: 600, x: 100, y: 100, type: "move" as const },
      ];

      expect(findEventIndexAtTime(events, -50)).toBe(0);
      expect(findEventIndexAtTime(events, 0)).toBe(0);
      expect(findEventIndexAtTime(events, 50)).toBe(0);
      expect(findEventIndexAtTime(events, 100)).toBe(1);
      expect(findEventIndexAtTime(events, 250)).toBe(1);
      expect(findEventIndexAtTime(events, 300)).toBe(2);
      expect(findEventIndexAtTime(events, 599)).toBe(2);
      expect(findEventIndexAtTime(events, 600)).toBe(3);
      expect(findEventIndexAtTime(events, 1000)).toBe(3);
    });

    it("getSmoothCursorState calculates smooth trajectory and handles click ripple", () => {
      const telemetry: MouseTelemetryFile = {
        version: 1,
        videoWidth: 1920,
        videoHeight: 1080,
        durationMs: 5000,
        events: [
          { t: 1000, x: 200, y: 200, type: "move" },
          { t: 2000, x: 600, y: 400, type: "click", button: "left" },
          { t: 3000, x: 800, y: 500, type: "move" },
        ],
      };

      // 1. Tại t=1000: đúng vị trí bắt đầu
      const at1000 = getSmoothCursorState(telemetry, 1000);
      expect(at1000.visible).toBe(true);
      expect(at1000.pixelX).toBeCloseTo(200, 0);
      expect(at1000.pixelY).toBeCloseTo(200, 0);
      expect(at1000.isClicking).toBe(false);

      // 2. Tại t=1500: ở khoảng giữa u=0.5
      const at1500 = getSmoothCursorState(telemetry, 1500);
      expect(at1500.pixelX).toBeGreaterThan(200);
      expect(at1500.pixelX).toBeLessThan(600);
      expect(at1500.pixelY).toBeGreaterThan(200);
      expect(at1500.pixelY).toBeLessThan(400);

      // 3. Tại t=2050 (ngay sau click 50ms): kích hoạt isClicking và sinh ClickRipple
      const at2050 = getSmoothCursorState(telemetry, 2050);
      expect(at2050.isClicking).toBe(true);
      expect(at2050.clickScale).toBeLessThan(1.0); // Co nhẹ khi click
      expect(at2050.ripples.length).toBe(1);
      expect(at2050.ripples[0].button).toBe("left");
      expect(at2050.ripples[0].radiusPx).toBeGreaterThan(8);
      expect(at2050.ripples[0].opacity).toBeGreaterThan(0);

      // 4. Tại t=2500 (sau click 500ms > rippleDurationMs): sóng nước tan hết
      const at2500 = getSmoothCursorState(telemetry, 2500);
      expect(at2500.isClicking).toBe(false);
      expect(at2500.clickScale).toBe(1.0);
      expect(at2500.ripples.length).toBe(0);
    });

    it("getSmoothCursorState eliminates micro-jitter using deadband", () => {
      const telemetry: MouseTelemetryFile = {
        version: 1,
        videoWidth: 1920,
        videoHeight: 1080,
        durationMs: 5000,
        events: [
          { t: 1000, x: 500, y: 500, type: "move" },
          // Rung nhẹ 1.2px (nhỏ hơn deadband 2.5px)
          { t: 1050, x: 501.2, y: 500.8, type: "move" },
        ],
      };

      const at1025 = getSmoothCursorState(telemetry, 1025, undefined, { deadbandPx: 2.5 });
      // Bị giữ nguyên ở p1 để triệt tiêu rung giật
      expect(at1025.pixelX).toBe(500);
      expect(at1025.pixelY).toBe(500);
    });
  });
});
