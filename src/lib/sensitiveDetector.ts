import type { OcrWord } from "./ipc";

export interface SensitiveBox {
  x: number;
  y: number;
  w: number;
  h: number;
  kind: "email" | "token" | "ip" | "card" | "phone" | "my_number" | "postal";
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
/** SĐT Nhật: di động 0[789]0-xxxx-xxxx (11 số), hoặc +81 bỏ số 0 đầu. (Số bàn 10 số khớp PHONE_VN.) */
const PHONE_JP = /^(?:\+81|0)(?:[789]0\d{8}|[1-9]\d{8})$/;
/** Mã bưu điện Nhật: 〒123-4567 hoặc 123-4567 (có gạch ngang — viết liền 7 số quá dễ nhầm nên bỏ qua). */
const POSTAL_JP = /^(?:〒\s?\d{3}-?\d{4}|\d{3}-\d{4})$/;
/** Chuỗi bí mật "không rõ định dạng": dài, chỉ gồm ký tự base64/hex, có cả chữ lẫn số, entropy cao. */
const SECRET_CHARS = /^[A-Za-z0-9+_=-]{32,}$/;

/** Entropy Shannon (bit/ký tự): chuỗi ngẫu nhiên ~4–6, từ/tên file có nghĩa thường < 3,5. */
function entropy(s: string): number {
  const freq = new Map<string, number>();
  for (const c of s) freq.set(c, (freq.get(c) ?? 0) + 1);
  let h = 0;
  for (const n of freq.values()) {
    const p = n / s.length;
    h -= p * Math.log2(p);
  }
  return h;
}

function longestLetterRun(s: string): number {
  let best = 0;
  let cur = 0;
  for (const c of s) {
    if (/[A-Za-z]/.test(c)) best = Math.max(best, ++cur);
    else cur = 0;
  }
  return best;
}

/** Khoá ngẫu nhiên có chữ-số xen kẽ, đoạn chữ liền nhau ngắn; còn tên/cụm từ ghép (CamelCase dài, snake_case) thì
 * có đoạn chữ liền rất dài hoặc gần như không có chữ số → không bị báo nhầm. */
function looksLikeSecret(ascii: string): boolean {
  if (!SECRET_CHARS.test(ascii)) return false;
  const digits = (ascii.match(/\d/g) ?? []).length;
  if (digits < 3 || !/[A-Za-z]/.test(ascii)) return false;
  return longestLetterRun(ascii) <= 11 && entropy(ascii) >= 3.6;
}

/** Số cá nhân (My Number) 12 chữ số, chữ số cuối là số kiểm tra (mod 11) — tránh báo nhầm mọi dãy 12 số. */
function isMyNumber(digits: string): boolean {
  if (!/^\d{12}$/.test(digits)) return false;
  let sum = 0;
  for (let n = 1; n <= 11; n++) {
    const p = digits.charCodeAt(11 - n) - 48; // P_n: tính từ phải, bỏ chữ số kiểm tra
    const q = n <= 6 ? n + 1 : n - 5;
    sum += p * q;
  }
  const r = sum % 11;
  const check = r <= 1 ? 0 : 11 - r;
  return check === digits.charCodeAt(11) - 48;
}

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
  if (PHONE_VN.test(digits) || PHONE_JP.test(digits)) return "phone";
  if (isMyNumber(digits)) return "my_number";
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
  if (POSTAL_JP.test(clean)) return "postal";
  if (DIGITISH.test(ascii)) return classifyDigits(ascii);
  // Token/secret không theo mẫu nào đã biết (Bearer, khoá tự sinh…): dài + trộn chữ-số + entropy cao.
  if (looksLikeSecret(ascii)) return "token";
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
