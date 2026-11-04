/**
 * Bộ phân tích và tô màu cú pháp nhẹ (Lightweight Syntax Highlighter) cho Code Block Annotation
 * Hỗ trợ các ngôn ngữ phổ biến: TypeScript/JavaScript, Rust, Python, SQL, JSON
 * Không phụ thuộc thư viện bên ngoài nặng nề, hoàn toàn tương thích React & Konva Canvas.
 */

export type CodeLanguage = "typescript" | "javascript" | "rust" | "python" | "sql" | "json";

export interface CodeToken {
  text: string;
  color: string;
  bold?: boolean;
  italic?: boolean;
}

// Bảng màu Catppuccin Mocha cho giao diện Dark Code Box cao cấp
export const CODE_THEME = {
  bg: "#181825",
  titleBg: "#11111b",
  border: "#313244",
  text: "#cdd6f4",
  keyword: "#cba6f7", // Tím hoa cà
  string: "#a6e3a1",  // Xanh lá mềm
  number: "#fab387",  // Cam đào
  comment: "#6c7086", // Xám mờ (italic)
  type: "#f9e2af",    // Vàng sáng
  function: "#89b4fa",// Xanh dương
  operator: "#89dceb",// Xanh lơ
  lineNumber: "#585b70",
};

export const CODE_LANGUAGES: { id: CodeLanguage; label: string; defaultTitle: string; sample: string }[] = [
  {
    id: "typescript",
    label: "TypeScript",
    defaultTitle: "snippet.ts",
    sample: `interface User {\n  id: string;\n  name: string;\n  role: "admin" | "dev";\n}\n\nasync function fetchUser(id: string): Promise<User> {\n  const res = await api.get(\`/users/\${id}\`);\n  return res.data;\n}`,
  },
  {
    id: "javascript",
    label: "JavaScript",
    defaultTitle: "index.js",
    sample: `const express = require("express");\nconst app = express();\n\napp.get("/api/health", (req, res) => {\n  res.json({ status: "ok", timestamp: Date.now() });\n});`,
  },
  {
    id: "rust",
    label: "Rust",
    defaultTitle: "main.rs",
    sample: `#[tauri::command]\npub fn execute_task(app: AppHandle) -> Result<String, String> {\n    let state = app.state::<AppState>();\n    let val = state.lock().map_err(|e| e.to_string())?;\n    println!("Status: {:?}", val);\n    Ok("done".into())\n}`,
  },
  {
    id: "python",
    label: "Python",
    defaultTitle: "app.py",
    sample: `from fastapi import FastAPI, HTTPException\n\napp = FastAPI()\n\n@app.get("/items/{item_id}")\ndef read_item(item_id: int):\n    if item_id <= 0:\n        raise HTTPException(status_code=400, detail="Invalid ID")\n    return {"item_id": item_id, "active": True}`,
  },
  {
    id: "sql",
    label: "SQL",
    defaultTitle: "query.sql",
    sample: `SELECT\n  u.id, u.username, COUNT(o.id) AS total_orders\nFROM users u\nLEFT JOIN orders o ON o.user_id = u.id\nWHERE u.status = 'active'\nGROUP BY u.id, u.username\nORDER BY total_orders DESC\nLIMIT 10;`,
  },
  {
    id: "json",
    label: "JSON",
    defaultTitle: "config.json",
    sample: `{\n  "name": "snapdoc",\n  "version": "3.8.4",\n  "private": true,\n  "settings": {\n    "ocrEngine": "viesvtr",\n    "alwaysOnTop": true\n  }\n}`,
  },
];

const TS_JS_KEYWORDS = new Set([
  "async", "await", "break", "case", "catch", "class", "const", "continue", "debugger", "default", "delete",
  "do", "else", "enum", "export", "extends", "false", "finally", "for", "from", "function", "if", "implements",
  "import", "in", "instanceof", "interface", "let", "new", "null", "of", "package", "private", "protected",
  "public", "return", "static", "super", "switch", "this", "throw", "true", "try", "type", "typeof", "var", "void", "while", "with", "yield"
]);

const RUST_KEYWORDS = new Set([
  "as", "async", "await", "break", "const", "continue", "crate", "dyn", "else", "enum", "extern", "false", "fn",
  "for", "if", "impl", "in", "let", "loop", "match", "mod", "move", "mut", "pub", "ref", "return", "self", "Self",
  "static", "struct", "super", "trait", "true", "type", "unsafe", "use", "where", "while"
]);

const PYTHON_KEYWORDS = new Set([
  "and", "as", "assert", "async", "await", "break", "class", "continue", "def", "del", "elif", "else", "except",
  "False", "finally", "for", "from", "global", "if", "import", "in", "is", "lambda", "None", "nonlocal", "not",
  "or", "pass", "raise", "return", "True", "try", "while", "with", "yield"
]);

const SQL_KEYWORDS = new Set([
  "SELECT", "FROM", "WHERE", "JOIN", "LEFT", "RIGHT", "INNER", "OUTER", "ON", "AND", "OR", "NOT", "IN",
  "IS", "NULL", "GROUP", "BY", "ORDER", "ASC", "DESC", "LIMIT", "OFFSET", "HAVING", "COUNT", "SUM", "AVG",
  "INSERT", "INTO", "VALUES", "UPDATE", "SET", "DELETE", "CREATE", "TABLE", "ALTER", "DROP", "AS", "DISTINCT"
]);

/**
 * Phân tích cú pháp từng dòng code thành các token có màu
 */
export function tokenizeCode(code: string, lang: CodeLanguage): CodeToken[][] {
  if (!code) return [[{ text: "", color: CODE_THEME.text }]];

  const lines = code.split("\n");
  const result: CodeToken[][] = [];

  for (const line of lines) {
    if (line.length === 0) {
      result.push([{ text: " ", color: CODE_THEME.text }]);
      continue;
    }

    const tokens: CodeToken[] = [];
    let i = 0;
    const len = line.length;

    while (i < len) {
      // 1. Bình luận (Comments)
      if ((lang === "typescript" || lang === "javascript" || lang === "rust") && line.startsWith("//", i)) {
        tokens.push({ text: line.slice(i), color: CODE_THEME.comment, italic: true });
        break;
      }
      if ((lang === "python" || lang === "json") && line[i] === "#") {
        tokens.push({ text: line.slice(i), color: CODE_THEME.comment, italic: true });
        break;
      }
      if (lang === "sql" && line.startsWith("--", i)) {
        tokens.push({ text: line.slice(i), color: CODE_THEME.comment, italic: true });
        break;
      }

      // 2. Chuỗi ký tự (Strings: ", ', `)
      const quoteChar = line[i];
      if (quoteChar === '"' || quoteChar === "'" || quoteChar === "`") {
        let j = i + 1;
        while (j < len) {
          if (line[j] === "\\" && j + 1 < len) {
            j += 2;
            continue;
          }
          if (line[j] === quoteChar) {
            j++;
            break;
          }
          j++;
        }
        tokens.push({ text: line.slice(i, j), color: CODE_THEME.string });
        i = j;
        continue;
      }

      // 3. Số (Numbers)
      if (/\d/.test(line[i]) && (i === 0 || /[\s,;:([<{=+\-*/%]/.test(line[i - 1]))) {
        let j = i;
        while (j < len && /[\d.xXa-fA-F_]/.test(line[j])) {
          j++;
        }
        tokens.push({ text: line.slice(i, j), color: CODE_THEME.number });
        i = j;
        continue;
      }

      // 4. Từ định danh & Từ khoá (Identifiers / Keywords)
      if (/[a-zA-Z_$]/.test(line[i])) {
        let j = i;
        while (j < len && /[a-zA-Z0-9_$]/.test(line[j])) {
          j++;
        }
        const word = line.slice(i, j);
        const nextChar = line[j] || "";

        let color = CODE_THEME.text;
        let bold = false;

        if (lang === "typescript" || lang === "javascript") {
          if (TS_JS_KEYWORDS.has(word)) {
            color = CODE_THEME.keyword;
            bold = true;
          } else if (/^[A-Z]/.test(word)) {
            color = CODE_THEME.type;
          } else if (nextChar === "(") {
            color = CODE_THEME.function;
          }
        } else if (lang === "rust") {
          if (RUST_KEYWORDS.has(word)) {
            color = CODE_THEME.keyword;
            bold = true;
          } else if (/^[A-Z]/.test(word)) {
            color = CODE_THEME.type;
          } else if (nextChar === "(" || nextChar === "!") {
            color = CODE_THEME.function;
          }
        } else if (lang === "python") {
          if (PYTHON_KEYWORDS.has(word)) {
            color = CODE_THEME.keyword;
            bold = true;
          } else if (/^[A-Z]/.test(word)) {
            color = CODE_THEME.type;
          } else if (nextChar === "(") {
            color = CODE_THEME.function;
          }
        } else if (lang === "sql") {
          const upperWord = word.toUpperCase();
          if (SQL_KEYWORDS.has(upperWord)) {
            color = CODE_THEME.keyword;
            bold = true;
          } else if (nextChar === "(") {
            color = CODE_THEME.function;
          }
        } else if (lang === "json") {
          if (word === "true" || word === "false" || word === "null") {
            color = CODE_THEME.number;
            bold = true;
          }
        }

        tokens.push({ text: word, color, bold });
        i = j;
        continue;
      }

      // 5. Macro Rust / Decorator Python
      if (line[i] === "#" && (lang === "rust" || lang === "python")) {
        tokens.push({ text: line[i], color: CODE_THEME.keyword });
        i++;
        continue;
      }

      // 6. Toán tử và ký tự phân cách (Punctuation & Operators)
      const ch = line[i];
      if (/^[=+\-*/%&|^!<>?:;,.~]/.test(ch)) {
        tokens.push({ text: ch, color: CODE_THEME.operator });
      } else {
        tokens.push({ text: ch, color: CODE_THEME.text });
      }
      i++;
    }

    result.push(tokens);
  }

  return result;
}
