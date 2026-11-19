// @ts-nocheck
import { describe, it, expect } from "vitest";
import * as fs from "fs";
import * as path from "path";
import { CJK_REGEX } from "./ocrLanguage";

describe("PaddleOCR CJK Dictionary and regex", () => {
  it("ppocrv5_dict has 18385 classes with space at the end for PP-OCRv5 model", () => {
    const dictPath = path.resolve(__dirname, "../../public/models/paddleocr/ppocrv5_dict.txt");
    const dictText = fs.readFileSync(dictPath, "utf-8");
    const rawLines = dictText.trimEnd().split(/\r?\n/);
    expect(rawLines.length).toBe(18384);

    const dictLines = [...rawLines, " "];
    expect(dictLines.length).toBe(18385);
    expect(dictLines[dictLines.length - 1]).toBe(" ");
  });

  it("CJK_REGEX matches Japanese Kanji, Hiragana, and Katakana", () => {
    expect(CJK_REGEX.test("こんにちは")).toBe(true);
    expect(CJK_REGEX.test("プロジェクト")).toBe(true);
    expect(CJK_REGEX.test("設計書")).toBe(true);
    expect(CJK_REGEX.test("Xin chào Việt Nam")).toBe(false);
    expect(CJK_REGEX.test("English Only")).toBe(false);
  });
});
