import type { OcrWord } from "./ipc";

export interface SensitiveBox {
  x: number;
  y: number;
  w: number;
  h: number;
  kind: "email" | "token" | "ip" | "card" | "phone";
}

/** Bỏ dấu tiếng Việt: OCR model tiếng Việt hay "tự thêm dấu" vào chuỗi ASCII
 * (vd email `nguyen...` → `nguyên...`) làm regex ASCII trượt. */
function stripAccents(s: string): string {
  return s.normalize("NFD").replace(/[̀-ͯ]/g, "").replace(/đ/g, "d").replace(/Đ/g, "D");
}

const EMAIL = /^[a-z0-9._%+-]+@[a-z0-9.-]+\.[a-z]{2,}$/i;
const EMAIL_LOOSE = /@[a-z0-9-]+(\.[a-z0-9-]+)*\.[a-z]{2,}/i;
const API_KEY = /^(?:sk-[a-z0-9_-]{16,}|gh[pousr]_[a-z0-9]{20,}|(?:AKIA|ASIA)[0-9A-Z]{16}|xox[baprs]-[0-9a-z-]{10,})$/i;
const JWT = /^eyJ[a-z0-9_-]{8,}\.[a-z0-9_-]{8,}\.[a-z0-9_-]{8,}$/i;
const IPV4 = /^(?:(?:25[0-5]|2[0-4][0-9]|1[0-9]{2}|[1-9]?[0-9])\.){3}(?:25[0-5]|2[0-4][0-9]|1[0-9]{2}|[1-9]?[0-9])$/;
const PHONE_VN = /^(?:\+84|0)(?:3|5|7|8|9)\d{8}$/;
const PHONE_INTL = /^\+[1-9]\d{8,14}$/;
const CARD = /^(?:4\d{12}(?:\d{3})?(?:\d{3})?|5[1-5]\d{14}|3[47]\d{13}|6(?:011|5\d{2})\d{12})$/;

function luhn(digits: string): boolean {
  let sum = 0;
  let dbl = false;
  for (let i = digits.length - 1; i >= 0; i--) {
    let d = digits.charCodeAt(i) - 48;
    if (dbl) {
      d *= 2;
      if (d > 9) d -= 9;
    }
    sum += d;
    dbl = !dbl;
  }
  return sum % 10 === 0;
}

/** Chuỗi chỉ gồm chữ số + dấu phân cách thường gặp ở SĐT/thẻ (có thể bắt đầu bằng +). */
const DIGITISH = /^\+?[\d().\-–]+$/;

function classifyDigits(text: string): SensitiveBox["kind"] | null {
  const digits = text.replace(/[^\d+]/g, "").replace(/(?!^)\+/g, "");
  if (PHONE_VN.test(digits)) return "phone";
  if (/^\d{13,19}$/.test(digits) && CARD.test(digits) && luhn(digits)) return "card";
  if (PHONE_INTL.test(digits) && digits.startsWith("+")) return "phone";
  return null;
}

function classifyWord(raw: string): SensitiveBox["kind"] | null {
  const clean = raw.trim().replace(/^['"([{<:;,.]+|['")\]}>:;,.]+$/g, "");
  if (!clean || clean.length < 5) return null;
  // Bỏ URL / đường dẫn file / namespace package — như trước đây.
  if (/^(?:https?|file):\/\//i.test(clean) || clean.includes("/") || clean.includes("\\")) return null;

  const ascii = stripAccents(clean);
  if (EMAIL.test(ascii)) return "email";
  if (ascii.includes("@") && EMAIL_LOOSE.test(ascii)) return "email";
  if (API_KEY.test(ascii) || JWT.test(ascii)) return "token";
  if (IPV4.test(ascii) && ascii !== "127.0.0.1" && ascii !== "0.0.0.0") return "ip";
  if (DIGITISH.test(ascii)) return classifyDigits(ascii);
  return null;
}

/** Gom các từ vào từng dòng theo toạ độ dọc, mỗi dòng sắp theo x. */
function groupLines(words: OcrWord[]): OcrWord[][] {
  const sorted = [...words].sort((a, b) => a.y + a.h / 2 - (b.y + b.h / 2));
  const lines: OcrWord[][] = [];
  for (const w of sorted) {
    const cy = w.y + w.h / 2;
    const line = lines.find((l) => {
      const ref = l[0];
      return Math.abs(ref.y + ref.h / 2 - cy) < Math.max(ref.h, w.h) * 0.6;
    });
    if (line) line.push(w);
    else lines.push([w]);
  }
  return lines.map((l) => l.sort((a, b) => a.x - b.x));
}

function union(ws: OcrWord[]): Omit<SensitiveBox, "kind"> {
  const x = Math.min(...ws.map((w) => w.x));
  const y = Math.min(...ws.map((w) => w.y));
  const x2 = Math.max(...ws.map((w) => w.x + w.w));
  const y2 = Math.max(...ws.map((w) => w.y + w.h));
  return { x, y, w: x2 - x, h: y2 - y };
}

function overlapRatio(a: Omit<SensitiveBox, "kind">, b: Omit<SensitiveBox, "kind">): number {
  const ix = Math.max(0, Math.min(a.x + a.w, b.x + b.w) - Math.max(a.x, b.x));
  const iy = Math.max(0, Math.min(a.y + a.h, b.y + b.h) - Math.max(a.y, b.y));
  const inter = ix * iy;
  const smaller = Math.min(a.w * a.h, b.w * b.h) || 1;
  return inter / smaller;
}

/**
 * Tìm các vùng chứa thông tin nhạy cảm từ kết quả OCR: email, token/API key,
 * IP, thẻ tín dụng (có Luhn) và SĐT — kể cả khi OCR tách số thành nhiều từ
 * ("0912 345 678") hoặc thêm dấu tiếng Việt vào chuỗi ASCII.
 */
export function findSensitiveBoxes(words: OcrWord[]): SensitiveBox[] {
  const found: SensitiveBox[] = [];

  for (const w of words) {
    const kind = classifyWord(w.text);
    if (kind) found.push({ ...union([w]), kind });
  }

  for (const line of groupLines(words)) {
    for (let i = 0; i < line.length; i++) {
      if (!DIGITISH.test(stripAccents(line[i].text.trim()))) continue;
      for (let len = 2; len <= 5 && i + len <= line.length; len++) {
        const slice = line.slice(i, i + len);
        if (!slice.every((w) => DIGITISH.test(stripAccents(w.text.trim())))) break;
        const kind = classifyDigits(slice.map((w) => w.text).join(""));
        if (kind) found.push({ ...union(slice), kind });
      }
    }
  }

  // Bỏ vùng trùng: giữ vùng lớn hơn khi 2 vùng chồng nhau nhiều.
  found.sort((a, b) => b.w * b.h - a.w * a.h);
  const out: SensitiveBox[] = [];
  for (const b of found) {
    if (!out.some((o) => overlapRatio(o, b) > 0.5)) out.push(b);
  }
  return out;
}
