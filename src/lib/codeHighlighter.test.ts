import { describe, it, expect } from "vitest";
import { tokenizeCode, CODE_THEME, CODE_LANGUAGES } from "./codeHighlighter";

describe("Lightweight Code Syntax Highlighter (tokenizeCode)", () => {
  it("phân tích từ khoá, chuỗi và số trong TypeScript chính xác", () => {
    const code = 'const count: number = 42;\n// comment\nreturn "hello";';
    const lines = tokenizeCode(code, "typescript");

    expect(lines.length).toBe(3);

    // Dòng 1: const (keyword), count (text), :, number (type), =, 42 (number), ;
    const line1 = lines[0];
    const kwToken = line1.find((t) => t.text === "const");
    expect(kwToken?.color).toBe(CODE_THEME.keyword);
    expect(kwToken?.bold).toBe(true);

    const numToken = line1.find((t) => t.text === "42");
    expect(numToken?.color).toBe(CODE_THEME.number);

    // Dòng 2: comment
    const line2 = lines[1];
    expect(line2[0].color).toBe(CODE_THEME.comment);
    expect(line2[0].italic).toBe(true);

    // Dòng 3: string
    const line3 = lines[2];
    const strToken = line3.find((t) => t.text.includes("hello"));
    expect(strToken?.color).toBe(CODE_THEME.string);
  });

  it("phân tích cú pháp Rust chính xác", () => {
    const code = 'pub fn calculate() -> Result<i32, String> {\n    println!("Done");\n}';
    const lines = tokenizeCode(code, "rust");

    const fnToken = lines[0].find((t) => t.text === "fn");
    expect(fnToken?.color).toBe(CODE_THEME.keyword);

    const resultTypeToken = lines[0].find((t) => t.text === "Result");
    expect(resultTypeToken?.color).toBe(CODE_THEME.type);

    const macroToken = lines[1].find((t) => t.text === "println");
    expect(macroToken?.color).toBe(CODE_THEME.function);
  });

  it("phân tích SQL hoa/thường chuẩn", () => {
    const code = "SELECT id, name FROM users WHERE id = 100;";
    const lines = tokenizeCode(code, "sql");

    const selectToken = lines[0].find((t) => t.text === "SELECT");
    expect(selectToken?.color).toBe(CODE_THEME.keyword);

    const fromToken = lines[0].find((t) => t.text === "FROM");
    expect(fromToken?.color).toBe(CODE_THEME.keyword);
  });

  it("bảo toàn danh mục ngôn ngữ và mẫu code", () => {
    expect(CODE_LANGUAGES.length).toBeGreaterThanOrEqual(6);
    const rustLang = CODE_LANGUAGES.find((l) => l.id === "rust");
    expect(rustLang?.defaultTitle).toBe("main.rs");
    expect(rustLang?.sample).toContain("tauri");
  });
});
