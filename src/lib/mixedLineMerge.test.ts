import { describe, it, expect } from "vitest";
import { isMixedCjkLatinLine, mergeMixedLine } from "./mixedLineMerge";

describe("isMixedCjkLatinLine", () => {
  it("nhận ra dòng trộn chữ Nhật và chữ Latin/Việt", () => {
    expect(isMixedCjkLatinLine("rồi đổi sang 日本語.")).toBe(true);
    expect(isMixedCjkLatinLine("プロジェクト概要 (Töng quan)")).toBe(true);
  });

  it("không coi dòng thuần Nhật hoặc thuần Việt là dòng trộn", () => {
    expect(isMixedCjkLatinLine("保存ボタンをクリックしてください")).toBe(false);
    expect(isMixedCjkLatinLine("Kết quả phải giữ đúng xuống dòng.")).toBe(false);
  });

  it("không coi chữ viết tắt ngắn trong câu tiếng Nhật là dòng trộn", () => {
    expect(isMixedCjkLatinLine("画面キャプチャとOCR文字認識")).toBe(false);
  });
});

describe("mergeMixedLine", () => {
  it("lấy lại dấu tiếng Việt từ VieSVTR, giữ nguyên phần chữ Nhật từ model CJK", () => {
    const cjk = "1. Bám Ctrl+Shift+T tren chür Nhat that, de ∂ chě do Tu dong, roi doi sang 日本語.";
    const vi = "1. Bấm Ctrl+ Shift +T trên chữ Nhật thật, để ở chế độ Tự động, rồi đổi sang E A.";
    expect(mergeMixedLine(cjk, vi)).toBe(
      "1. Bấm Ctrl+Shift+T trên chữ Nhật thật, để ở chế độ Tự động, rồi đổi sang 日本語.",
    );
  });

  it("sửa dấu ở phần tiếng Việt trong ngoặc của dòng tiếng Nhật", () => {
    const cjk = "プロジェクト概要 (Töng quan)";
    const vi = "Tề=I> NỀ (Tổng quan)";
    expect(mergeMixedLine(cjk, vi)).toBe("プロジェクト概要 (Tổng quan)");
  });

  it("giữ nguyên kết quả CJK khi VieSVTR đọc ra chữ không liên quan", () => {
    const cjk = "設定 Settings 画面";
    expect(mergeMixedLine(cjk, "xyz qwerty")).toBe(cjk);
    expect(mergeMixedLine(cjk, "")).toBe(cjk);
  });

  it("không bao giờ thay một từ có chữ Nhật bằng chữ của VieSVTR", () => {
    const cjk = "sang 日本語 ngay";
    const vi = "sang E A ngay";
    expect(mergeMixedLine(cjk, vi)).toBe("sang 日本語 ngay");
  });
});
