import { describe, it, expect } from "vitest";
import {
  initialSegments,
  totalTimelineMs,
  segmentPlayMs,
  canSplitAt,
  splitSegmentAt,
  deleteSegment,
  canTrimHead,
  trimHead,
  canTrimTail,
  trimTail,
  computeKeepRanges,
  timelineMsToSource,
  sourceMsToTimeline,
  type Segment,
} from "./segments";

describe("VideoTrimmer segments logic", () => {
  it("initialSegments creates a single segment spanning 0..duration", () => {
    const segs = initialSegments(10000);
    expect(segs).toHaveLength(1);
    expect(segs[0].srcStart).toBe(0);
    expect(segs[0].srcEnd).toBe(10000);
    expect(segs[0].speed).toBe(1.0);
    expect(totalTimelineMs(segs)).toBe(10000);
  });

  it("segmentPlayMs respects speed multiplier", () => {
    const normalSeg: Segment = { id: "1", srcStart: 0, srcEnd: 2000, speed: 1.0 };
    const fastSeg: Segment = { id: "2", srcStart: 0, srcEnd: 2000, speed: 2.0 };
    const slowSeg: Segment = { id: "3", srcStart: 0, srcEnd: 2000, speed: 0.5 };

    expect(segmentPlayMs(normalSeg)).toBe(2000);
    expect(segmentPlayMs(fastSeg)).toBe(1000);
    expect(segmentPlayMs(slowSeg)).toBe(4000);
  });

  it("canSplitAt enforces MIN_SEG_MS boundary rules", () => {
    const segs = initialSegments(5000); // 5000ms
    // Cannot split too close to start or end (< 300ms)
    expect(canSplitAt(segs, 100)).toBe(false);
    expect(canSplitAt(segs, 4900)).toBe(false);
    // Can split comfortably inside
    expect(canSplitAt(segs, 2000)).toBe(true);
  });

  it("splitSegmentAt splits a segment into two parts with preserved speed", () => {
    const segs = initialSegments(5000);
    const split = splitSegmentAt(segs, 2000);
    expect(split).toHaveLength(2);
    expect(split[0].srcStart).toBe(0);
    expect(split[0].srcEnd).toBe(2000);
    expect(split[1].srcStart).toBe(2000);
    expect(split[1].srcEnd).toBe(5000);
    expect(totalTimelineMs(split)).toBe(5000);
  });

  it("deleteSegment removes a segment and leaves others intact", () => {
    const segs = splitSegmentAt(initialSegments(6000), 3000);
    expect(segs).toHaveLength(2);
    const idToDelete = segs[0].id;

    const remaining = deleteSegment(segs, idToDelete);
    expect(remaining).toHaveLength(1);
    expect(remaining[0].id).toBe(segs[1].id);
    expect(remaining[0].srcStart).toBe(3000);
    expect(remaining[0].srcEnd).toBe(6000);
  });

  it("trimHead removes everything before timelineMs", () => {
    const segs = initialSegments(6000);
    expect(canTrimHead(segs, 2000)).toBe(true);

    const trimmed = trimHead(segs, 2000);
    expect(trimmed).toHaveLength(1);
    expect(trimmed[0].srcStart).toBe(2000);
    expect(trimmed[0].srcEnd).toBe(6000);
    expect(totalTimelineMs(trimmed)).toBe(4000);
  });

  it("trimTail removes everything after timelineMs", () => {
    const segs = initialSegments(6000);
    expect(canTrimTail(segs, 4000)).toBe(true);

    const trimmed = trimTail(segs, 4000);
    expect(trimmed).toHaveLength(1);
    expect(trimmed[0].srcStart).toBe(0);
    expect(trimmed[0].srcEnd).toBe(4000);
    expect(totalTimelineMs(trimmed)).toBe(4000);
  });

  it("computeKeepRanges produces [srcStart, srcEnd, speed] tuples for FFmpeg IPC", () => {
    const segs: Segment[] = [
      { id: "1", srcStart: 1000, srcEnd: 3000, speed: 1.0 },
      { id: "2", srcStart: 5000, srcEnd: 8000, speed: 2.0 },
    ];
    const ranges = computeKeepRanges(segs);
    expect(ranges).toEqual([
      [1000, 3000, 1.0],
      [5000, 8000, 2.0],
    ]);
  });

  it("timelineMsToSource and sourceMsToTimeline convert bidirectionally", () => {
    const segs: Segment[] = [
      { id: "1", srcStart: 1000, srcEnd: 3000, speed: 1.0 }, // 2000ms
      { id: "2", srcStart: 5000, srcEnd: 7000, speed: 1.0 }, // 2000ms
    ];
    // timeline 1500 -> inside seg 0 (srcStart 1000 + 1500 = 2500)
    const pos = timelineMsToSource(segs, 1500);
    expect(pos).not.toBeNull();
    expect(pos?.segIndex).toBe(0);
    expect(pos?.srcMs).toBe(2500);

    const tl = sourceMsToTimeline(segs, 2500);
    expect(tl).toBe(1500);

    // timeline 2500 -> inside seg 1 (offset 500 -> 5000 + 500 = 5500)
    const pos2 = timelineMsToSource(segs, 2500);
    expect(pos2?.segIndex).toBe(1);
    expect(pos2?.srcMs).toBe(5500);
  });
});
