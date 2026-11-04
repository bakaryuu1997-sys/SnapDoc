import { describe, it, expect } from "vitest";
import {
  groupLinesIntoColumns,
  groupWordsIntoLinesFallback,
  formatWordsToText,
  type RenderLine,
} from "./LiveTextOverlay";
import { sortBoxesColumnAware } from "../../../lib/paddleOcrService";
import { processOcrResult } from "../../../lib/ocrService";
import type { OcrWord } from "../../../lib/ipc";

describe("LiveTextOverlay - Column Isolation & Line Count Fidelity", () => {
  it("phân tách các dòng vào các cột độc lập (Column Isolation) dựa trên columnId", () => {
    const lines: RenderLine[] = [
      {
        id: "line-0",
        x: 17,
        y: 26,
        w: 120,
        h: 20,
        columnId: 0, // Sidebar
        words: [
          { word: { text: "Projects", x: 17, y: 26, w: 50, h: 20 }, index: 0 },
        ],
      },
      {
        id: "line-1",
        x: 17,
        y: 50,
        w: 150,
        h: 20,
        columnId: 0, // Sidebar
        words: [
          { word: { text: "snapdoc", x: 17, y: 50, w: 60, h: 20 }, index: 1 },
        ],
      },
      {
        id: "line-2",
        x: 270,
        y: 40,
        w: 500,
        h: 22,
        columnId: 1, // Main Content
        words: [
          { word: { text: "Khoảng", x: 270, y: 40, w: 60, h: 22 }, index: 2 },
          { word: { text: "cách", x: 335, y: 40, w: 40, h: 22 }, index: 3 },
          { word: { text: "hiện", x: 380, y: 40, w: 40, h: 22 }, index: 4 },
          { word: { text: "tại:", x: 425, y: 40, w: 35, h: 22 }, index: 5 },
        ],
      },
      {
        id: "line-3",
        x: 270,
        y: 80,
        w: 400,
        h: 22,
        columnId: 1, // Main Content
        words: [
          { word: { text: "chỗ", x: 270, y: 80, w: 30, h: 22 }, index: 6 },
          { word: { text: "là", x: 305, y: 80, w: 20, h: 22 }, index: 7 },
          { word: { text: "bị", x: 330, y: 80, w: 20, h: 22 }, index: 8 },
          { word: { text: "lộ", x: 355, y: 80, w: 20, h: 22 }, index: 9 },
          { word: { text: "dữ", x: 380, y: 80, w: 20, h: 22 }, index: 10 },
          { word: { text: "liệu", x: 405, y: 80, w: 30, h: 22 }, index: 11 },
          { word: { text: "bí", x: 440, y: 80, w: 20, h: 22 }, index: 12 },
          { word: { text: "mật.", x: 465, y: 80, w: 35, h: 22 }, index: 13 },
        ],
      },
    ];

    const columns = groupLinesIntoColumns(lines);
    expect(columns).toHaveLength(2);
    // Cột 0: Sidebar (2 dòng)
    expect(columns[0].id).toBe("col-0");
    expect(columns[0].lines).toHaveLength(2);
    expect(columns[0].x).toBe(17);

    // Cột 1: Main Content (2 dòng)
    expect(columns[1].id).toBe("col-1");
    expect(columns[1].lines).toHaveLength(2);
    expect(columns[1].x).toBe(270);
  });

  it("đảm bảo bôi đen bao nhiêu dòng thì copy đúng bấy nhiêu dòng (bôi đen copy cùng số dòng)", () => {
    const w1: OcrWord = { text: "Dòng", x: 10, y: 10, w: 40, h: 18 };
    const w2: OcrWord = { text: "thứ", x: 55, y: 10, w: 30, h: 18 };
    const w3: OcrWord = { text: "nhất", x: 90, y: 10, w: 40, h: 18 };

    const w4: OcrWord = { text: "Dòng", x: 10, y: 40, w: 40, h: 18 };
    const w5: OcrWord = { text: "thứ", x: 55, y: 40, w: 30, h: 18 };
    const w6: OcrWord = { text: "hai", x: 90, y: 40, w: 35, h: 18 };

    const w7: OcrWord = { text: "Dòng", x: 10, y: 70, w: 40, h: 18 };
    const w8: OcrWord = { text: "thứ", x: 55, y: 70, w: 30, h: 18 };
    const w9: OcrWord = { text: "ba", x: 90, y: 70, w: 30, h: 18 };

    const lines: RenderLine[] = [
      { id: "l-0", x: 10, y: 10, w: 120, h: 18, columnId: 0, words: [{ word: w1, index: 0 }, { word: w2, index: 1 }, { word: w3, index: 2 }] },
      { id: "l-1", x: 10, y: 40, w: 115, h: 18, columnId: 0, words: [{ word: w4, index: 3 }, { word: w5, index: 4 }, { word: w6, index: 5 }] },
      { id: "l-2", x: 10, y: 70, w: 110, h: 18, columnId: 0, words: [{ word: w7, index: 6 }, { word: w8, index: 7 }, { word: w9, index: 8 }] },
    ];

    // Người dùng bôi đen cả 3 dòng:
    const selectedAll = [w1, w2, w3, w4, w5, w6, w7, w8, w9];
    const textAll = formatWordsToText(selectedAll, lines);
    const splitLinesAll = textAll.split("\n");
    expect(splitLinesAll).toHaveLength(3);
    expect(splitLinesAll[0]).toBe("Dòng thứ nhất");
    expect(splitLinesAll[1]).toBe("Dòng thứ hai");
    expect(splitLinesAll[2]).toBe("Dòng thứ ba");

    // Người dùng chỉ bôi đen dòng 1 và dòng 3 (bỏ qua dòng 2):
    const selected1And3 = [w1, w2, w3, w7, w8, w9];
    const text1And3 = formatWordsToText(selected1And3, lines);
    const splitLines1And3 = text1And3.split("\n");
    expect(splitLines1And3).toHaveLength(2);
    expect(splitLines1And3[0]).toBe("Dòng thứ nhất");
    expect(splitLines1And3[1]).toBe("Dòng thứ ba");
  });

  it("không bị dính chữ giữa các dòng (chống lỗi haylivestream)", () => {
    const w1: OcrWord = { text: "lập", x: 10, y: 10, w: 30, h: 18 };
    const w2: OcrWord = { text: "trình", x: 45, y: 10, w: 40, h: 18 };
    const w3: OcrWord = { text: "viên", x: 90, y: 10, w: 40, h: 18 };
    const w4: OcrWord = { text: "hay", x: 135, y: 10, w: 35, h: 18 };

    const w5: OcrWord = { text: "livestream/chia", x: 10, y: 35, w: 120, h: 18 };
    const w6: OcrWord = { text: "sẻ", x: 135, y: 35, w: 20, h: 18 };

    const lines: RenderLine[] = [
      { id: "l-0", x: 10, y: 10, w: 160, h: 18, columnId: 0, words: [{ word: w1, index: 0 }, { word: w2, index: 1 }, { word: w3, index: 2 }, { word: w4, index: 3 }] },
      { id: "l-1", x: 10, y: 35, w: 145, h: 18, columnId: 0, words: [{ word: w5, index: 4 }, { word: w6, index: 5 }] },
    ];

    const selected = [w1, w2, w3, w4, w5, w6];
    const formatted = formatWordsToText(selected, lines);

    expect(formatted).not.toContain("haylivestream");
    expect(formatted).toBe("lập trình viên hay\nlivestream/chia sẻ");
  });

  it("sortBoxesColumnAware tách biệt rãnh dọc giữa Sidebar và Nội dung chính kể cả khi có thanh tiêu đề kéo dài (spanning header)", () => {
    const imgW = 1000;
    const boxes: { text: string; x: number; y: number; width: number; height: number; columnId?: number }[] = [
      // 1. Spanning header ở trên cùng
      { text: "project drive bakaryuu1997 / snapdoc", x: 10, y: 10, width: 600, height: 24 },
      // 2. Sidebar boxes (cột trái: X từ 20 đến 180)
      { text: "Projects", x: 20, y: 50, width: 80, height: 20 },
      { text: "snapdoc", x: 20, y: 80, width: 70, height: 20 },
      { text: "Mexc-trading", x: 20, y: 110, width: 100, height: 20 },
      // 3. Main content boxes (cột phải: X từ 320 đến 750)
      { text: "Smart Auto-Redact", x: 320, y: 50, width: 200, height: 22 },
      { text: "Khoảng cách hiện tại:", x: 320, y: 80, width: 300, height: 20 },
      { text: "Chuẩn 10/10", x: 320, y: 110, width: 150, height: 20 },
    ];

    const sorted = sortBoxesColumnAware(boxes, imgW);

    const sidebarItems = sorted.filter((b) => b.columnId === 0 && b.text !== "project drive bakaryuu1997 / snapdoc");
    const mainItems = sorted.filter((b) => b.columnId === 1);

    expect(mainItems.length).toBeGreaterThanOrEqual(3);
    expect(mainItems.map((m) => m.text)).toContain("Smart Auto-Redact");
    expect(mainItems.map((m) => m.text)).toContain("Khoảng cách hiện tại:");
    expect(sidebarItems.map((s) => s.text)).toContain("Projects");
    expect(sidebarItems.map((s) => s.text)).toContain("snapdoc");
  });

  it("groupLinesIntoColumns tự động phân tách cột thông minh khi input lines có cùng columnId", () => {
    // Trường hợp xấu nhất: upstream lines đều có columnId = 0
    const rawLines: RenderLine[] = [
      { id: "s1", x: 20, y: 50, w: 80, h: 20, columnId: 0, words: [{ word: { text: "Projects", x: 20, y: 50, w: 80, h: 20 }, index: 0 }] },
      { id: "s2", x: 20, y: 80, w: 70, h: 20, columnId: 0, words: [{ word: { text: "snapdoc", x: 20, y: 80, w: 70, h: 20 }, index: 1 }] },
      { id: "s3", x: 20, y: 110, w: 90, h: 20, columnId: 0, words: [{ word: { text: "Mexc-trading", x: 20, y: 110, w: 90, h: 20 }, index: 2 }] },
      { id: "m1", x: 320, y: 50, w: 200, h: 22, columnId: 0, words: [{ word: { text: "Smart Auto-Redact", x: 320, y: 50, w: 200, h: 22 }, index: 3 }] },
      { id: "m2", x: 320, y: 80, w: 300, h: 20, columnId: 0, words: [{ word: { text: "Khoảng cách hiện tại", x: 320, y: 80, w: 300, h: 20 }, index: 4 }] },
      { id: "m3", x: 320, y: 110, w: 250, h: 20, columnId: 0, words: [{ word: { text: "Chuẩn 10/10", x: 320, y: 110, w: 250, h: 20 }, index: 5 }] },
    ];

    const columns = groupLinesIntoColumns(rawLines);
    expect(columns).toHaveLength(2);
    expect(columns[0].id).toBe("col-0");
    expect(columns[1].id).toBe("col-1");
    expect(columns[0].lines).toHaveLength(3);
    expect(columns[1].lines).toHaveLength(3);
  });

  it("groupWordsIntoLinesFallback gom trọn vẹn các từ trên cùng 1 dòng bất kể có khoảng cách thụt lề hay code block", () => {
    // Mô phỏng dòng: "1. Tách cột & Rãnh dọc ... sortBoxesColumnAware" có khoảng cách rộng giữa các từ
    const words: OcrWord[] = [
      { text: "1.", x: 320, y: 50, w: 15, h: 18 },
      { text: "Tách", x: 345, y: 50, w: 35, h: 18 },
      { text: "cột", x: 385, y: 50, w: 25, h: 18 },
      // Khoảng cách lớn trước code block (khoảng cách 60px)
      { text: "sortBoxesColumnAware", x: 470, y: 50, w: 140, h: 18 },
      { text: "tự", x: 620, y: 50, w: 20, h: 18 },
      { text: "động", x: 645, y: 50, w: 35, h: 18 },
      // Dòng 2 bên dưới
      { text: "2.", x: 320, y: 80, w: 15, h: 18 },
      { text: "Bộ", x: 345, y: 80, w: 25, h: 18 },
      { text: "bảo", x: 375, y: 80, w: 25, h: 18 },
      { text: "vệ", x: 405, y: 80, w: 20, h: 18 },
    ];

    const lines = groupWordsIntoLinesFallback(words);
    // Phải tạo đúng 2 dòng, KHÔNG được cắt rời dòng 1 thành nhiều mẩu vụn
    expect(lines).toHaveLength(2);
    expect(lines[0].words).toHaveLength(6);
    expect(lines[0].words.map((w) => w.word.text).join(" ")).toBe("1. Tách cột sortBoxesColumnAware tự động");
    expect(lines[1].words).toHaveLength(4);
    expect(lines[1].words.map((w) => w.word.text).join(" ")).toBe("2. Bộ bảo vệ");
  });

  it("processOcrResult tự động phân tách chuỗi OCR dính liền thành từng từ con với bounding box tỷ lệ chuẩn", () => {
    const rawResult = {
      text: "bă't:đâ'u:bă`ng:dâ'u:châ'm",
      words: [
        {
          text: "bă't:đâ'u:bă`ng:dâ'u:châ'm",
          x: 300,
          y: 40,
          w: 500,
          h: 22,
        },
      ],
    };

    const processed = processOcrResult(rawResult, "vi");
    // Phải phân tách thành nhiều từ riêng biệt
    expect(processed.words.length).toBeGreaterThan(4);
    expect(processed.words.map((w) => w.text)).toContain("bắt:");
    expect(processed.words.map((w) => w.text)).toContain("đầu:");
    expect(processed.words.map((w) => w.text)).toContain("bằng:");
    expect(processed.words.map((w) => w.text)).toContain("dấu:");
    expect(processed.words.map((w) => w.text)).toContain("chấm");
    // Các từ con phải có tọa độ X tịnh tiến tăng dần
    for (let i = 1; i < processed.words.length; i++) {
      expect(processed.words[i].x).toBeGreaterThan(processed.words[i - 1].x);
    }
  });

  it("processOcrResult phân tách glued words ĐỒNG BỘ trong cả words và lines", () => {
    const rawResult = {
      text: "bă't:đâ'u:bă`ng",
      words: [
        { text: "bă't:đâ'u:bă`ng", x: 100, y: 20, w: 200, h: 20 },
      ],
      lines: [
        {
          text: "bă't:đâ'u:bă`ng",
          x: 100,
          y: 20,
          w: 200,
          h: 20,
          words: [{ text: "bă't:đâ'u:bă`ng", x: 100, y: 20, w: 200, h: 20 }],
        },
      ],
    };

    const processed = processOcrResult(rawResult, "vi");
    expect(processed.lines).toBeDefined();
    expect(processed.lines![0].words.length).toBeGreaterThan(1);
    expect(processed.words.length).toBe(processed.lines![0].words.length);
    expect(processed.lines![0].words.map((w) => w.text)).toEqual(processed.words.map((w) => w.text));
  });
});
