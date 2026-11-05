import { describe, expect, it } from "vitest";
import { findSensitiveBoxes } from "./sensitiveDetector";
import type { OcrWord } from "./ipc";

const w = (text: string, x: number, y: number, ww = 60, h = 24): OcrWord => ({ text, x, y, w: ww, h });
const kinds = (words: OcrWord[]) => findSensitiveBoxes(words).map((b) => b.kind);

describe("findSensitiveBoxes", () => {
  it("bắt email thường", () => {
    expect(kinds([w("nguyen.van.anh@example.com", 10, 10, 300)])).toEqual(["email"]);
  });

  it("bắt email dù OCR tiếng Việt thêm dấu vào chuỗi ASCII (lỗi thực tế đã gặp)", () => {
    expect(kinds([w("nguyên.van.anh@example.com", 10, 10, 300)])).toEqual(["email"]);
  });

  it("bắt API key / token", () => {
    expect(kinds([w("sk-live-abcdef1234567890abcd", 10, 10, 300)])).toEqual(["token"]);
    expect(kinds([w("ghp_abcdefghijklmnopqrstuvwxyz1234", 10, 10, 300)])).toEqual(["token"]);
  });

  it("bắt SĐT Việt Nam viết liền, có dấu chấm và có dấu cách (bị OCR tách từ)", () => {
    expect(kinds([w("0912345678", 10, 10, 120)])).toEqual(["phone"]);
    expect(kinds([w("0912.345.678", 10, 10, 120)])).toEqual(["phone"]);
    const spaced = findSensitiveBoxes([w("0912", 100, 50, 50), w("345", 160, 50, 40), w("678", 210, 50, 40)]);
    expect(spaced).toHaveLength(1);
    expect(spaced[0].kind).toBe("phone");
    expect(spaced[0].x).toBe(100);
    expect(spaced[0].x + spaced[0].w).toBe(250);
  });

  it("bắt số thẻ tín dụng hợp lệ (Luhn) kể cả khi bị tách thành 4 nhóm", () => {
    const card = findSensitiveBoxes([w("4111", 10, 10, 50), w("1111", 70, 10, 50), w("1111", 130, 10, 50), w("1111", 190, 10, 50)]);
    expect(card).toHaveLength(1);
    expect(card[0].kind).toBe("card");
  });

  it("không báo nhầm số 16 chữ số không qua Luhn", () => {
    const words = [w("4111", 10, 10, 50), w("1111", 70, 10, 50), w("1111", 130, 10, 50), w("1112", 190, 10, 50)];
    expect(findSensitiveBoxes(words).filter((b) => b.kind === "card")).toHaveLength(0);
  });

  it("không báo nhầm văn bản, ngày tháng, phiên bản, đường dẫn", () => {
    const words = [
      w("Báo", 10, 10), w("cáo", 80, 10), w("doanh", 150, 10), w("thu", 220, 10),
      w("12/05/2026", 10, 50, 120), w("3.9.1", 150, 50), w("Quận", 10, 90), w("1,", 80, 90),
      w("C:\\Users\\asus\\file.txt", 10, 130, 300), w("https://example.com/a@b.com", 10, 170, 300),
    ];
    expect(findSensitiveBoxes(words)).toEqual([]);
  });

  it("không đếm trùng khi 1 SĐT vừa khớp từ đơn vừa khớp cụm từ", () => {
    expect(findSensitiveBoxes([w("0912345678", 10, 10, 120)])).toHaveLength(1);
  });

  it("chỉ ghép các từ cùng dòng (không ghép số ở 2 dòng khác nhau)", () => {
    const words = [w("0912", 10, 10, 50), w("345", 70, 200, 40), w("678", 120, 400, 40)];
    expect(findSensitiveBoxes(words)).toEqual([]);
  });
});
