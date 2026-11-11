// Dựng trang hướng dẫn tự chứa: nhúng ảnh (base64) + số phiên bản vào mẫu HTML.
//   node scripts/build-guide.mjs
// Nguồn: docs/guide/guide.template.html + docs/guide/images/*  →  src-tauri/guide/HUONG_DAN_SU_DUNG.html
// (file đầu ra được `include_str!` vào binary — xem src-tauri/src/guide.rs; nhớ chạy lại sau khi sửa mẫu/ảnh).
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const tpl = fs.readFileSync(path.join(root, "docs/guide/guide.template.html"), "utf8");
const version = JSON.parse(fs.readFileSync(path.join(root, "package.json"), "utf8")).version;

const MIME = { ".png": "image/png", ".jpg": "image/jpeg", ".jpeg": "image/jpeg", ".gif": "image/gif", ".webp": "image/webp", ".svg": "image/svg+xml" };
const html = tpl
  .replace(/\{\{version\}\}/g, version)
  .replace(/\{\{img:([^}]+)\}\}/g, (_, name) => {
    const f = path.join(root, "docs/guide/images", name);
    if (!fs.existsSync(f)) throw new Error(`Thiếu ảnh: docs/guide/images/${name}`);
    const mime = MIME[path.extname(name).toLowerCase()] ?? "application/octet-stream";
    return `data:${mime};base64,${fs.readFileSync(f).toString("base64")}`;
  });

const out = path.join(root, "src-tauri/guide/HUONG_DAN_SU_DUNG.html");
fs.mkdirSync(path.dirname(out), { recursive: true });
fs.writeFileSync(out, html);
console.log(`OK ${path.relative(root, out)}  (v${version}, ${(html.length / 1024).toFixed(0)} KB)`);
