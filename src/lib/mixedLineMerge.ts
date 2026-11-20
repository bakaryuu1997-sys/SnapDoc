/**
 * Ghép kết quả OCR cho dòng TRỘN chữ Nhật + chữ Việt/Latin (chế độ "auto").
 *
 * Model CJK (PP-OCRv5) đọc đúng kanji/kana nhưng làm mất dấu tiếng Việt
 * ("Bấm" → "Bám", "ở" → "∂"); model VieSVTR đọc đúng dấu nhưng ra rác ở phần
 * chữ Nhật. Thư viện không trả vị trí từng ký tự, nên ghép ở mức TỪ:
 * - từ có chữ Nhật → luôn giữ bản của model CJK;
 * - từ Latin → nếu khớp (so sánh bỏ dấu, cho phép sai 1–2 ký tự) với một từ
 *   của VieSVTR theo đúng thứ tự (LCS) thì lấy bản có dấu của VieSVTR,
 *   ngược lại giữ bản CJK.
 */

const CJK_CHAR = /[぀-ヿㇰ-ㇿ㐀-䶿一-鿿ｦ-ﾟ]/;
const LATIN_LETTER = /[A-Za-zÀ-ɏḀ-ỿ]/g;

/** Dòng có chữ Nhật VÀ có từ 4 chữ cái Latin trở lên (chữ viết tắt kiểu "OCR" không tính). */
export function isMixedCjkLatinLine(text: string): boolean {
  if (!CJK_CHAR.test(text)) return false;
  return (text.match(LATIN_LETTER) || []).length >= 4;
}

/** Dạng so sánh: bỏ dấu, đ→d, chữ thường, chỉ giữ chữ và số. */
function baseForm(word: string): string {
  return word
    .normalize("NFD")
    .replace(/\p{M}/gu, "")
    .replace(/[đĐ]/g, "d")
    .toLowerCase()
    .replace(/[^\p{L}\p{N}]/gu, "");
}

function levenshtein(a: string, b: string): number {
  if (a === b) return 0;
  if (!a.length) return b.length;
  if (!b.length) return a.length;
  let prev = Array.from({ length: b.length + 1 }, (_, j) => j);
  for (let i = 1; i <= a.length; i++) {
    const cur = [i];
    for (let j = 1; j <= b.length; j++) {
      cur[j] = Math.min(prev[j] + 1, cur[j - 1] + 1, prev[j - 1] + (a[i - 1] === b[j - 1] ? 0 : 1));
    }
    prev = cur;
  }
  return prev[b.length];
}

function wordsMatch(cjkWord: string, viWord: string): boolean {
  const a = baseForm(cjkWord);
  const b = baseForm(viWord);
  const maxLen = Math.max(a.length, b.length);
  if (maxLen === 0) return cjkWord === viWord;
  const allowed = maxLen <= 4 ? 1 : 2;
  return levenshtein(a, b) <= allowed;
}

export function mergeMixedLine(cjkText: string, viText: string): string {
  const parts = cjkText.split(/(\s+)/);
  const viWords = viText.split(/\s+/).filter(Boolean);
  if (viWords.length === 0) return cjkText;

  // Chỉ số (trong `parts`) của các từ Latin — ứng viên được thay bằng bản có dấu.
  const latinIdx: number[] = [];
  parts.forEach((p, i) => {
    if (p.trim() && !CJK_CHAR.test(p)) latinIdx.push(i);
  });
  if (latinIdx.length === 0) return cjkText;

  // LCS giữa các từ Latin của CJK và các từ của VieSVTR (khớp mờ, giữ thứ tự).
  const n = latinIdx.length;
  const m = viWords.length;
  const dp: number[][] = Array.from({ length: n + 1 }, () => new Array(m + 1).fill(0));
  for (let i = n - 1; i >= 0; i--) {
    for (let j = m - 1; j >= 0; j--) {
      dp[i][j] = wordsMatch(parts[latinIdx[i]], viWords[j])
        ? dp[i + 1][j + 1] + 1
        : Math.max(dp[i + 1][j], dp[i][j + 1]);
    }
  }

  const out = parts.slice();
  let i = 0;
  let j = 0;
  while (i < n && j < m) {
    if (wordsMatch(parts[latinIdx[i]], viWords[j]) && dp[i][j] === dp[i + 1][j + 1] + 1) {
      out[latinIdx[i]] = viWords[j];
      i++;
      j++;
    } else if (dp[i + 1][j] >= dp[i][j + 1]) {
      i++;
    } else {
      j++;
    }
  }
  return out.join("");
}
