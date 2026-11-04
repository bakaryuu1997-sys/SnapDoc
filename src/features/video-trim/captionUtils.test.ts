import { describe, expect, it } from "vitest";
import { activeCaptionAt, mapCaptionsToTimeline } from "./captionUtils";
import type { Segment } from "./segments";

const seg = (id: string, srcStart: number, srcEnd: number, speed = 1): Segment => ({ id, srcStart, srcEnd, speed });
const cap = (startMs: number, endMs: number, text: string) => ({ startMs, endMs, text });

describe("mapCaptionsToTimeline", () => {
  it("giữ nguyên mốc khi video chưa chỉnh sửa", () => {
    const out = mapCaptionsToTimeline([cap(1000, 3000, "A"), cap(4000, 6000, "B")], [seg("a", 0, 10000)]);
    expect(out).toEqual([cap(1000, 3000, "A"), cap(4000, 6000, "B")]);
  });

  it("bỏ phụ đề nằm trọn trong đoạn đã xoá và dời mốc các đoạn sau", () => {
    // Giữ 0-5s và 8-12s (xoá 5-8s) → timeline: 0-5s rồi 5-9s.
    const segs = [seg("a", 0, 5000), seg("b", 8000, 12000)];
    const out = mapCaptionsToTimeline([cap(1000, 2000, "đầu"), cap(5500, 7500, "bị xoá"), cap(9000, 11000, "cuối")], segs);
    expect(out).toEqual([cap(1000, 2000, "đầu"), cap(6000, 8000, "cuối")]);
  });

  it("phụ đề vắt qua đoạn xoá được nối liền thành 1 dòng", () => {
    const segs = [seg("a", 0, 5000), seg("b", 8000, 12000)];
    const out = mapCaptionsToTimeline([cap(4000, 9000, "vắt qua")], segs);
    // 4-5s ở đoạn a, 8-9s ở đoạn b → timeline 4-5s và 5-6s liền nhau.
    expect(out).toEqual([cap(4000, 6000, "vắt qua")]);
  });

  it("chia thời lượng theo tốc độ", () => {
    const out = mapCaptionsToTimeline([cap(2000, 4000, "nhanh")], [seg("a", 0, 10000, 2)]);
    expect(out).toEqual([cap(1000, 2000, "nhanh")]);
  });

  it("tính đúng độ lệch khi đoạn trước có tốc độ khác", () => {
    // Đoạn a: 0-4s tốc độ 1 (dài 4s). Đoạn b: 4-8s tốc độ 2 → bắt đầu ở timeline 4s.
    const segs = [seg("a", 0, 4000, 1), seg("b", 4000, 8000, 2)];
    const out = mapCaptionsToTimeline([cap(6000, 7000, "x")], segs);
    expect(out).toEqual([cap(5000, 5500, "x")]);
  });

  it("bỏ phần sót quá ngắn ở mép đoạn bị cắt", () => {
    const out = mapCaptionsToTimeline([cap(4900, 6000, "sót")], [seg("a", 0, 5000)]);
    expect(out).toEqual([]);
  });

  it("giữ phụ đề ngắn nằm trọn trong đoạn dù tốc độ cao", () => {
    const out = mapCaptionsToTimeline([cap(1000, 1400, "ngắn")], [seg("a", 0, 10000, 4)]);
    expect(out).toEqual([cap(250, 350, "ngắn")]);
  });

  it("2 đoạn liền kề (chia mà không xoá) không làm phụ đề bị tách đôi", () => {
    const segs = [seg("a", 0, 5000), seg("b", 5000, 10000)];
    expect(mapCaptionsToTimeline([cap(4000, 6000, "liền")], segs)).toEqual([cap(4000, 6000, "liền")]);
  });

  it("bỏ dòng rỗng và sắp xếp theo thời gian", () => {
    const out = mapCaptionsToTimeline([cap(5000, 6000, "sau"), cap(1000, 2000, "  "), cap(0, 1000, "trước")], [seg("a", 0, 10000)]);
    expect(out.map((c) => c.text)).toEqual(["trước", "sau"]);
  });
});

describe("activeCaptionAt", () => {
  const caps = [cap(0, 1000, "một"), cap(1000, 2500, "hai")];
  it("chọn đúng dòng và coi mốc kết thúc là loại trừ", () => {
    expect(activeCaptionAt(caps, 0)?.text).toBe("một");
    expect(activeCaptionAt(caps, 999)?.text).toBe("một");
    expect(activeCaptionAt(caps, 1000)?.text).toBe("hai");
    expect(activeCaptionAt(caps, 2500)).toBeNull();
    expect(activeCaptionAt(caps, -5)).toBeNull();
  });
});
