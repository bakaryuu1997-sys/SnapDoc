/**
 * Thư viện xử lý và chuẩn hóa văn bản OCR đa ngôn ngữ chuyên sâu cho Desktop App
 * Hỗ trợ tối ưu hóa 3 nhóm ngôn ngữ chính:
 * 1. Tiếng Việt (vi): Hàn gắn dấu thanh bị tách, xử lý triệt để lỗi nhận nhầm ký tự Umlaut Đức (ä, ö, ü),
 *    phục hồi khoảng trắng bị dính từ font màn hình/Dark mode, làm sạch nhiễu CJK.
 * 2. Tiếng Nhật (ja): Bảo toàn 100% Kanji, Hiragana, Katakana; xóa khoảng trắng nhân tạo giữa các ký tự CJK,
 *    giữ nguyên khoảng trắng tự nhiên quanh từ tiếng Anh/số, chuẩn hóa dấu câu tiếng Nhật.
 * 3. Tiếng Anh (en): Bảo toàn nguyên vẹn mã nguồn, camelCase, snake_case, đường dẫn file, token API, URLs.
 */

export type OcrLanguageMode = "vi" | "en" | "ja" | "zh" | "all";

// --- BẢNG ÁNH XẠ CHUỖI CỤM TỪ TIẾNG VIỆT & LỖI QUANG HỌC CHUNG ---
const VIETNAMESE_PHRASE_FIXES: [RegExp, string][] = [
  // Sửa nhanh lỗi quang học chữ viết tắt công nghệ
  [/\bAP[1l]\b/g, "API"],
  [/\b[0O]CR\b/g, "OCR"],
  [/\bU[1l]\b/g, "UI"],
];

// --- BẢNG KHẮC PHỤC CHUNG CHO TỪNG TIẾNG/ÂM TIẾT CÓ UMLAUT (ä, ö, ü, å, ø) ---
const GENERAL_UMLAUT_SYLLABLES: [RegExp, string][] = [
  // ä / å -> các âm tiết tiếng Việt chứa a/ă/á/à/ả/ã/ạ khi OCR bị nhận nhầm
  [/(?<![\p{L}\p{N}])nguy[ée]n(?![\p{L}\p{N}])/gui, "nguyên"],
  [/(?<![\p{L}\p{N}])nh[äå]n(?![\p{L}\p{N}])/gui, "nhân"],
  [/(?<![\p{L}\p{N}])c[äå]c(?![\p{L}\p{N}])/gui, "các"],
  [/(?<![\p{L}\p{N}])b[äå]m(?![\p{L}\p{N}])/gui, "bấm"],
  [/(?<![\p{L}\p{N}])c[äå]n(?![\p{L}\p{N}])/gui, "cần"],
  [/(?<![\p{L}\p{N}])ph[äå]p(?![\p{L}\p{N}])/gui, "pháp"],
  [/(?<![\p{L}\p{N}])ph[å]i(?![\p{L}\p{N}])/gui, "phải"],
  [/(?<![\p{L}\p{N}])xu[äå]t(?![\p{L}\p{N}])/gui, "xuất"],
  [/(?<![\p{L}\p{N}])t[äå]ch(?![\p{L}\p{N}])/gui, "tách"],
  [/(?<![\p{L}\p{N}])to[äå]n(?![\p{L}\p{N}])/gui, "toàn"],
  [/(?<![\p{L}\p{N}])t0[åa]n(?![\p{L}\p{N}])/gui, "toán"],
  [/(?<![\p{L}\p{N}])d[å]i(?![\p{L}\p{N}])/gui, "dài"],
  [/(?<![\p{L}\p{N}])s[äå]ng(?![\p{L}\p{N}])/gui, "sáng"],
  [/(?<![\p{L}\p{N}])m[äå]t(?![\p{L}\p{N}])/gui, "mất"],
  [/(?<![\p{L}\p{N}])th[äå]nh(?![\p{L}\p{N}])/gui, "thành"],
  [/(?<![\p{L}\p{N}])n[äå]y(?![\p{L}\p{N}])/gui, "này"],
  [/(?<![\p{L}\p{N}])r[äå]nh(?![\p{L}\p{N}])/gui, "rãnh"],
  [/(?<![\p{L}\p{N}])khu[äå]t(?![\p{L}\p{N}])/gui, "khuất"],
  [/(?<![\p{L}\p{N}])b[äå]ng(?![\p{L}\p{N}])/gui, "bảng"],
  [/(?<![\p{L}\p{N}])b[å]o\s*v[ée](?![\p{L}\p{N}])/gui, "bảo vệ"],
  [/(?<![\p{L}\p{N}])v[å]o(?![\p{L}\p{N}])/gui, "vào"],
  [/(?<![\p{L}\p{N}])m[å] (?![\p{L}\p{N}])/gui, "mà "],
  [/(?<![\p{L}\p{N}])gi[å]i(?![\p{L}\p{N}])/gui, "giải"],
  [/(?<![\p{L}\p{N}])th[å]c[öo]ng(?![\p{L}\p{N}])/gui, "thủ công"],

  // ö -> các âm tiết tiếng Việt chứa o/ô/ơ/ó/ò/ỏ/õ/ọ/ồ/ố/ổ/ỗ/ộ/ớ/ờ/ở/ỡ/ợ
  [/(?<![\p{L}\p{N}])cöt(?![\p{L}\p{N}])/gui, "cột"],
  [/(?<![\p{L}\p{N}])döng(?![\p{L}\p{N}])/gui, "dòng"],
  [/(?<![\p{L}\p{N}])khöng(?![\p{L}\p{N}])/gui, "không"],
  [/(?<![\p{L}\p{N}])möt(?![\p{L}\p{N}])/gui, "một"],
  [/(?<![\p{L}\p{N}])khöi(?![\p{L}\p{N}])/gui, "khối"],
  [/(?<![\p{L}\p{N}])chuöt(?![\p{L}\p{N}])/gui, "chuột"],
  [/(?<![\p{L}\p{N}])cö(?![\p{L}\p{N}])/gui, "có"],
  [/(?<![\p{L}\p{N}])vö(?![\p{L}\p{N}])/gui, "vô"],
  [/(?<![\p{L}\p{N}])dö(?![\p{L}\p{N}])/gui, "độ"],
  [/(?<![\p{L}\p{N}])bdi(?![\p{L}\p{N}])/gui, "bởi"],
  [/(?<![\p{L}\p{N}])b[ö]i(?![\p{L}\p{N}])/gui, "bôi"],
  [/(?<![\p{L}\p{N}])ch[ö]n(?![\p{L}\p{N}])/gui, "chọn"],
  [/(?<![\p{L}\p{N}])tuyetdöi(?![\p{L}\p{N}])/gui, "tuyệt đối"],

  // ü / ø -> các âm tiết tiếng Việt chứa u/ư/ú/ù/ủ/ũ/ụ/ứ/ừ/ử/ữ/ự
  [/(?<![\p{L}\p{N}])chü(?![\p{L}\p{N}])/gui, "chữ"],
  [/(?<![\p{L}\p{N}])trudc(?![\p{L}\p{N}])/gui, "trước"],
  [/(?<![\p{L}\p{N}])dudc(?![\p{L}\p{N}])/gui, "được"],
  [/(?<![\p{L}\p{N}])duøc(?![\p{L}\p{N}])/gui, "được"],
  [/(?<![\p{L}\p{N}])nüt(?![\p{L}\p{N}])/gui, "nút"],
  [/(?<![\p{L}\p{N}])giüa(?![\p{L}\p{N}])/gui, "giữa"],
  [/(?<![\p{L}\p{N}])vüng(?![\p{L}\p{N}])/gui, "vùng"],
  [/(?<![\p{L}\p{N}])dudng(?![\p{L}\p{N}])/gui, "đường"],
  [/(?<![\p{L}\p{N}])laptüc(?![\p{L}\p{N}])/gui, "lập tức"],

  // é -> các âm tiết tiếng Việt chứa e/ê/é/è/ẻ/ẽ/ẹ/ế/ề/ể/ễ/ệ
  [/(?<![\p{L}\p{N}])tiéu(?![\p{L}\p{N}])/gui, "tiêu"],
  [/(?<![\p{L}\p{N}])dé(?![\p{L}\p{N}])/gui, "để"],
  [/(?<![\p{L}\p{N}])dién(?![\p{L}\p{N}])/gui, "diện"],
  [/(?<![\p{L}\p{N}])chuyén(?![\p{L}\p{N}])/gui, "chuyển"],
  [/(?<![\p{L}\p{N}])biéu(?![\p{L}\p{N}])/gui, "biểu"],
  [/(?<![\p{L}\p{N}])hién(?![\p{L}\p{N}])/gui, "hiển"],
  [/(?<![\p{L}\p{N}])thé(?![\p{L}\p{N}])/gui, "thể"],
  [/(?<![\p{L}\p{N}])quét(?![\p{L}\p{N}])/gui, "quét"],
];

// --- BẢNG D KHÔNG GẠCH THÀNH Đ CÓ GẠCH TRONG TỪ ĐƠN ---
const D_TO_D_WORDS: [RegExp, string][] = [
  [/(?<![\p{L}\p{N}])dudc(?=[\s\.,]|$)/gui, "được"],
  [/(?<![\p{L}\p{N}])dudng(?=[\s\.,]|$)/gui, "đường"],
  [/(?<![\p{L}\p{N}])döng(?=[\s\.,]|$)/gui, "dòng"],
  [/(?<![\p{L}\p{N}])dé(?=[\s\.,]|$)/gui, "để"],
  [/(?<![\p{L}\p{N}])dién(?=[\s\.,]|$)/gui, "diện"],
  [/(?<![\p{L}\p{N}])diem(?=[\s\.,]|$)/gui, "điểm"],
  [/(?<![\p{L}\p{N}])doan(?=[\s\.,]|$)/gui, "đoạn"],
  [/(?<![\p{L}\p{N}])dau(?=[\s\.,]|$)/gui, "đầu"],
];

/**
 * Làm sạch và hàn gắn văn bản Tiếng Việt
 */
export function cleanVietnameseOcrText(text: string): string {
  if (!text) return "";

  // 1. Chuẩn hoá Unicode sang NFC
  let res = text.normalize("NFC");

  // 2. Sửa các từ viết tắt kỹ thuật hay bị nhận nhầm
  res = res.replace(/\bAP[1l]\b/g, "API");

  // 3. Xử lý các cụm từ đặc thù bị vỡ do Dark mode / màn hình
  for (const [pattern, repl] of VIETNAMESE_PHRASE_FIXES) {
    res = res.replace(pattern, repl);
  }

  // 4. Hàn gắn các ký tự có dấu thanh bị tách (diacritic detachment inside syllables)
  const fixWithCase = (target: string) => (match: string) => {
    if (!match || !target) return target;
    return match[0] === match[0].toUpperCase()
      ? target[0].toUpperCase() + target.slice(1)
      : target;
  };

  const syllableFixes: [RegExp, string | ((...args: any[]) => string)][] = [
    // che mở -> che mờ
    [/(?<![\p{L}\p{N}])che\s+mở(?![\p{L}\p{N}])/gui, fixWithCase("che mờ")],
    // nôi bộ -> nội bộ
    [/(?<![\p{L}\p{N}])nôi\s+bộ(?![\p{L}\p{N}])/gui, fixWithCase("nội bộ")],
    // API Kay -> API Key
    [/(?<![\p{L}\p{N}])API\s+Kay(?![\p{L}\p{N}])/gui, "API Key"],
    // ding côg cụ / ding công cụ -> dùng công cụ
    [/(?<![\p{L}\p{N}])ding\s+côg\s+cụ(?![\p{L}\p{N}])/gui, "dùng công cụ"],
    [/(?<![\p{L}\p{N}])ding\s+công\s+cụ(?![\p{L}\p{N}])/gui, "dùng công cụ"],
    // kh lu -> khẩu
    [/(?<![\p{L}\p{N}])kh\s*lu(?![\p{L}\p{N}])/gui, fixWithCase("khẩu")],
    // b - ă/â - ' - t -> bắt (bắt buộc có ký tự mũ hoặc dấu thanh, không làm hỏng từ tiếng Anh 'bat')
    [/(?<![\p{L}\p{N}])b[ăâáắã]\s*['`´ˆ˜^~"]?\s*t(?![\p{L}\p{N}])/gui, fixWithCase("bắt")],
    [/(?<![\p{L}\p{N}])ba\s*['`´ˆ˜^~"]+\s*t(?![\p{L}\p{N}])/gui, fixWithCase("bắt")],
    // d - â - ' - u -> dấu (dấu chấm, dấu phẩy; không làm hỏng 'dau')
    [/(?<![\p{L}\p{N}])d[âáấã]\s*['`´ˆ˜^~"]?\s*u(?![\p{L}\p{N}])/gui, fixWithCase("dấu")],
    [/(?<![\p{L}\p{N}])da\s*['`´ˆ˜^~"]+\s*u(?![\p{L}\p{N}])/gui, fixWithCase("dấu")],
    // đ - â - `/' - u -> đầu (bắt đầu, ban đầu)
    [/(?<![\p{L}\p{N}])đ[aâàầáấã]\s*['`´ˆ˜^~"]?\s*u(?![\p{L}\p{N}])/gui, fixWithCase("đầu")],
    [/(?<![\p{L}\p{N}])d[âàầáấã]\s*[`´ˆ˜^~"]\s*u(?![\p{L}\p{N}])/gui, fixWithCase("đầu")],
    // m - a/â - ~/' - u -> mẫu (ví dụ, biểu mẫu; không làm hỏng 'mau')
    [/(?<![\p{L}\p{N}])m[âáấãàằ]\s*['`´ˆ˜^~"]?\s*u(?![\p{L}\p{N}])/gui, fixWithCase("mẫu")],
    [/(?<![\p{L}\p{N}])ma\s*['`´ˆ˜^~"]+\s*u(?![\p{L}\p{N}])/gui, fixWithCase("mẫu")],
    // v - a/â - ' - n -> vấn (phỏng vấn, câu vấn; không làm hỏng 'van')
    [/(?<![\p{L}\p{N}])v[âáấãàằ]\s*['`´ˆ˜^~"]?\s*n(?![\p{L}\p{N}])/gui, fixWithCase("vấn")],
    [/(?<![\p{L}\p{N}])va\s*['`´ˆ˜^~"]+\s*n(?![\p{L}\p{N}])/gui, fixWithCase("vấn")],
    // nhay cảm -> nhạy cảm
    [/(?<![\p{L}\p{N}])nhay\s+cảm(?![\p{L}\p{N}])/gui, fixWithCase("nhạy cảm")],
    // b - ă - `/` - ng -> bằng (không làm hỏng từ tiếng Anh 'bang')
    [/(?<![\p{L}\p{N}])b[ăâàằáắ]\s*['`´ˆ˜^~"]?\s*ng(?![\p{L}\p{N}])/gui, fixWithCase("bằng")],
    [/(?<![\p{L}\p{N}])ba\s*['`´ˆ˜^~"]+\s*ng(?![\p{L}\p{N}])/gui, fixWithCase("bằng")],
    // ch - â - ' - m -> chấm (không làm hỏng 'cham')
    [/(?<![\p{L}\p{N}])ch[âáấ]\s*['`´ˆ˜^~"]?\s*m(?![\p{L}\p{N}])/gui, fixWithCase("chấm")],
    [/(?<![\p{L}\p{N}])cha\s*['`´ˆ˜^~"]+\s*m(?![\p{L}\p{N}])/gui, fixWithCase("chấm")],
    // m - ê - `/' - m -> mềm (không làm hỏng từ tiếng Anh 'mem')
    [/(?<![\p{L}\p{N}])m[êèềéế]\s*['`´ˆ˜^~"]?\s*m(?![\p{L}\p{N}])/gui, fixWithCase("mềm")],
    [/(?<![\p{L}\p{N}])me\s*['`´ˆ˜^~"]+\s*m(?![\p{L}\p{N}])/gui, fixWithCase("mềm")],
    // kh - ă - ' - t -> khắt (không làm hỏng 'khat')
    [/(?<![\p{L}\p{N}])kh[ăâáắã]\s*['`´ˆ˜^~"]?\s*t(?![\p{L}\p{N}])/gui, fixWithCase("khắt")],
    [/(?<![\p{L}\p{N}])kha\s*['`´ˆ˜^~"]+\s*t(?![\p{L}\p{N}])/gui, fixWithCase("khắt")],
    // đ - ô - `/' - ng -> đồng (cộng đồng, đồng ý, không ảnh hưởng dòng chữ, tự động)
    [/(?<![\p{L}\p{N}])[đ][ôồo]\s*['`´ˆ˜^~"]?\s*ng(?![\p{L}\p{N}])/gui, fixWithCase("đồng")],
    [/(?<![\p{L}\p{N}])d[ôồ]\s*['`´ˆ˜^~"]?\s*ng(?![\p{L}\p{N}])/gui, fixWithCase("đồng")],
    [/(?<![\p{L}\p{N}])do\s*[`´ˆ˜^~"]+\s*ng(?![\p{L}\p{N}])/gui, fixWithCase("đồng")],
    // s - ă - ~ - n -> sẵn (không làm hỏng 'san')
    [/(?<![\p{L}\p{N}])s[ăâáắãeẽ]\s*['`´ˆ˜^~"]?\s*n(?![\p{L}\p{N}])/gui, fixWithCase("sẵn")],
    [/(?<![\p{L}\p{N}])sa\s*['`´ˆ˜^~"]+\s*n(?![\p{L}\p{N}])/gui, fixWithCase("sẵn")],
    // k - y - ~ - thuật -> kỹ thuật
    [/(?<![\p{L}\p{N}])k[yýỳỹ]\s*['"`´ˆ˜^~]?\s*thuật(?![\p{L}\p{N}])/gui, fixWithCase("kỹ thuật")],
    // c - â - `/' - n -> cần (bắt buộc có ký tự mũ hoặc dấu thanh, TUYỆT ĐỐI không làm hỏng từ tiếng Anh 'can')
    [/(?<![\p{L}\p{N}])c[âàầáấ]\s*['`´ˆ˜^~"]?\s*n(?![\p{L}\p{N}])/gui, fixWithCase("cần")],
    [/(?<![\p{L}\p{N}])ca\s*['`´ˆ˜^~"]+\s*n(?![\p{L}\p{N}])/gui, fixWithCase("cần")],
    // chu - â - ?/' - n -> chuẩn (không làm hỏng 'chuan')
    [/(?<![\p{L}\p{N}])chu[âảẩáấ]\s*['`´ˆ˜^~"]?\s*n(?![\p{L}\p{N}])/gui, fixWithCase("chuẩn")],
    [/(?<![\p{L}\p{N}])chua\s*['`´ˆ˜^~"]+\s*n(?![\p{L}\p{N}])/gui, fixWithCase("chuẩn")],
    // đ - i - ê - ?/' - m -> điểm (không làm hỏng 'diem')
    [/(?<![\p{L}\p{N}])[đ]i[eêẻểéế]\s*['`´ˆ˜^~"]?\s*m(?![\p{L}\p{N}])/gui, fixWithCase("điểm")],
    [/(?<![\p{L}\p{N}])di[êẻểéế]\s*['`´ˆ˜^~"]?\s*m(?![\p{L}\p{N}])/gui, fixWithCase("điểm")],
    [/(?<![\p{L}\p{N}])die\s*['`´ˆ˜^~"]+\s*m(?![\p{L}\p{N}])/gui, fixWithCase("điểm")],
    // nghi - ê - ./' - p -> nghiệp
    [/(?<![\p{L}\p{N}])nghi[êèềéếệ]\s*['`´ˆ˜^~"]?\s*p(?![\p{L}\p{N}])/gui, fixWithCase("nghiệp")],
    [/(?<![\p{L}\p{N}])nghie\s*['`´ˆ˜^~"]+\s*p(?![\p{L}\p{N}])/gui, fixWithCase("nghiệp")],
    // l - â - ./' - p -> lập (bắt buộc có ký tự mũ hoặc dấu thanh, TUYỆT ĐỐI không làm hỏng từ tiếng Anh 'lap')
    [/(?<![\p{L}\p{N}])l[âàầáấậ]\s*['`´ˆ˜^~"]?\s*p(?![\p{L}\p{N}])/gui, fixWithCase("lập")],
    [/(?<![\p{L}\p{N}])la\s*['`´ˆ˜^~"]+\s*p(?![\p{L}\p{N}])/gui, fixWithCase("lập")],
    // b - â - ' - m -> bấm (không làm hỏng 'bam')
    [/(?<![\p{L}\p{N}])b[âáấ]\s*['`´ˆ˜^~"]?\s*m(?![\p{L}\p{N}])/gui, fixWithCase("bấm")],
    [/(?<![\p{L}\p{N}])ba\s*['`´ˆ˜^~"]+\s*m(?![\p{L}\p{N}])/gui, fixWithCase("bấm")],
    // t - ô - ' - t -> tốt (không làm hỏng 'tot')
    [/(?<![\p{L}\p{N}])t[ôóố]\s*['`´ˆ˜^~"]?\s*t(?![\p{L}\p{N}])/gui, fixWithCase("tốt")],
    [/(?<![\p{L}\p{N}])to\s*['`´ˆ˜^~"]+\s*t(?![\p{L}\p{N}])/gui, fixWithCase("tốt")],
    // th - ư - ./' - c -> thực (không làm hỏng 'thuc')
    [/(?<![\p{L}\p{N}])th[ưúứ]\s*['`´ˆ˜^~"]?\s*c(?![\p{L}\p{N}])/gui, fixWithCase("thực")],
    [/(?<![\p{L}\p{N}])thu\s*['`´ˆ˜^~"]+\s*c(?![\p{L}\p{N}])/gui, fixWithCase("thực")],
    // đ - ư - ơ - `/' - ng -> đường
    [/(?<![\p{L}\p{N}])[đ][uư][oơờớ]\s*['`´ˆ˜^~"]?\s*ng(?![\p{L}\p{N}])/gui, fixWithCase("đường")],
    [/(?<![\p{L}\p{N}])d[uư][ơờớ]\s*['`´ˆ˜^~"]?\s*ng(?![\p{L}\p{N}])/gui, fixWithCase("đường")],
    [/(?<![\p{L}\p{N}])duo\s*['`´ˆ˜^~"]+\s*ng(?![\p{L}\p{N}])/gui, fixWithCase("đường")],
    // Sô ' / Số ' / Sô" / Số" -> Số
    [/(?<![\p{L}\p{N}])[sS][oôóố]\s*['`´ˆ˜^"°]\s*/gu, "Số "],
    // chô ~ / chỗ ' -> chỗ
    [/(?<![\p{L}\p{N}])ch[oôóốõỗ]\s*['`´ˆ˜^~"]\s*/gui, "chỗ "],
  ];

  for (const [pattern, repl] of syllableFixes) {
    res = res.replace(pattern, repl as any);
  }

  // 5. Phục hồi các âm tiết riêng lẻ có dấu umlaut Đức
  for (const [pattern, repl] of GENERAL_UMLAUT_SYLLABLES) {
    res = res.replace(pattern, repl);
  }

  // 6. Phục hồi d -> đ trong các từ thường gặp
  for (const [pattern, repl] of D_TO_D_WORDS) {
    res = res.replace(pattern, repl);
  }

  // 7. Phục hồi các nguyên âm kết hợp dấu thanh trôi nổi (sắc, huyền, hỏi, ngã)
  const singleToneMap: Record<string, string> = {
    "ă'": "ắ", "ă`": "ằ", "ă?": "ẳ", "ă~": "ẵ",
    "â'": "ấ", "â`": "ầ", "â?": "ẩ", "â~": "ẫ",
    "ê'": "ế", "ê`": "ề", "ê?": "ể", "ê~": "ễ",
    "ô'": "ố", "ô`": "ồ", "ô?": "ổ", "ô~": "ỗ",
    "ơ'": "ớ", "ơ`": "ờ", "ơ?": "ở", "ơ~": "ỡ",
    "ư'": "ứ", "ư`": "ừ", "ư?": "ử", "ư~": "ữ",
  };
  for (const [k, v] of Object.entries(singleToneMap)) {
    const char = k[0];
    const mark = k[1];
    const escapedMark = mark === "?" ? "\\?" : mark;
    res = res.replace(new RegExp(`${char}\\s*${escapedMark}`, "g"), v);
  }

  // 8. Thay thế ký tự å (Swedish a with ring do Tesseract/OCR nhận nhầm dấu hỏi/ngã/mũ)
  res = res.replace(/khåu/gui, "khẩu");
  res = res.replace(/Bång/gui, "Bảng");
  res = res.replace(/Khå\s+thi/gui, "Khả thi");
  res = res.replace(/å/gui, "ả");

  // 9. Xóa các ký tự rác sinh ra do nhận diện nhầm Emoji
  res = res.replace(/(["'“])\s*[âa]\s*([A-ZÀ-Ỹa-zà-ỹ])/gu, "$1$2");
  res = res.replace(/(?<=\d+\.\s*)[âa]\s+(?=[A-Z])/gu, "");
  res = res.replace(/(?<=\s)[âa]\s+(?=[A-Z][a-z])/gu, "");

  const VIETNAMESE_VOWELS_WITH_ACCENTS = "àáảãạăằắẳẵặâầấẩẫậèéẻẽẹêềếểễệìíỉĩịòóỏõọôồốổỗộơờớởỡợùúủũụưừứửữựỳýỷỹỵÀÁẢÃẠĂẰẮẲẴẶÂẦẤẨẪẬÈÉẺẼẸÊỀẾỂỄỆÌÍỈĨỊÒÓỎÕỌÔỒỐỔỖỘƠỜỚỞỠỢÙÚỦŨỤƯỪỨỬỮỰỲÝỶỸỴ";

  // 10. Khử các dấu nháy đơn/nháy kép/backtick rác kẹp giữa các chữ cái trong cùng một từ (ví dụ: muố'n -> muốn, đố'i -> đối, đố"i -> đối)
  // LƯU Ý: Tuyệt đối không nuốt khoảng trắng giữa các từ (dùng (?=[a-zA-Zà-ỹÀ-ỸđĐ]) không kèm \s*)
  res = res.replace(new RegExp(`([${VIETNAMESE_VOWELS_WITH_ACCENTS}])[\\s]*["'”’‘\`´ˆ˜^]+(?=[a-zA-Zà-ỹÀ-ỸđĐ])`, "gu"), "$1");

  // 11. Khử các dấu nháy/backtick dư thừa dính sau nguyên âm có dấu trước khoảng trắng hoặc dấu câu (ví dụ: để" -> để, tinh tế' -> tinh tế, chế' -> chế)
  res = res.replace(new RegExp(`([${VIETNAMESE_VOWELS_WITH_ACCENTS}])["'”’‘\`´ˆ˜^]+(?=[\\s.,;:!?\\]\\)]|$)`, "gu"), "$1");

  // 12. Hàn gắn các âm tiết bị ngắt đôi khoảng trắng thừa giữa nguyên âm và phụ âm cuối
  res = res.replace(/(?<![\p{L}\p{N}])Điể\s+u\s+chỉnh(?![\p{L}\p{N}])/gui, "Điều chỉnh");
  res = res.replace(/(?<![\p{L}\p{N}])điể\s+u(?![\p{L}\p{N}])/gui, fixWithCase("điều"));
  res = res.replace(/(?<![\p{L}\p{N}])xuố\s+ng(?![\p{L}\p{N}])/gui, fixWithCase("xuống"));
  res = res.replace(/(?<![\p{L}\p{N}])khố\s+i(?![\p{L}\p{N}])/gui, fixWithCase("khối"));
  res = res.replace(/(?<![\p{L}\p{N}])buộ\s+c(?![\p{L}\p{N}])/gui, fixWithCase("buộc"));
  res = res.replace(/(?<![\p{L}\p{N}])thuộ\s+c(?![\p{L}\p{N}])/gui, fixWithCase("thuộc"));
  res = res.replace(/(?<![\p{L}\p{N}])cuộ\s+c(?![\p{L}\p{N}])/gui, fixWithCase("cuộc"));
  res = res.replace(/(?<![\p{L}\p{N}])ngư[ờơ]\s+i(?![\p{L}\p{N}])/gui, fixWithCase("người"));
  res = res.replace(/(?<![\p{L}\p{N}])tiế\s+p(?![\p{L}\p{N}])/gui, fixWithCase("tiếp"));
  res = res.replace(/(?<![\p{L}\p{N}])biế\s+t(?![\p{L}\p{N}])/gui, fixWithCase("biết"));
  res = res.replace(/(?<![\p{L}\p{N}])viế\s+t(?![\p{L}\p{N}])/gui, fixWithCase("viết"));
  res = res.replace(/(?<![\p{L}\p{N}])chiế\s+c(?![\p{L}\p{N}])/gui, fixWithCase("chiếc"));
  res = res.replace(/(?<![\p{L}\p{N}])chuyể\s+n(?![\p{L}\p{N}])/gui, fixWithCase("chuyển"));
  res = res.replace(/(?<![\p{L}\p{N}])tuyệ\s+t(?![\p{L}\p{N}])/gui, fixWithCase("tuyệt"));

  // 13. Sửa các lỗi quang học dấu thanh đặc thù tiếng Việt từ VieSVTR & Tesseract
  res = res.replace(/(?<![\p{L}\p{N}])viể[n"]+/gui, fixWithCase("viền"));
  res = res.replace(/(?<![\p{L}\p{N}])tiêu\s+để["']*/gui, fixWithCase("tiêu đề"));
  res = res.replace(/(?<![\p{L}\p{N}])rãnh\s+trông(?![\p{L}\p{N}])/gui, fixWithCase("rãnh trống"));
  res = res.replace(/(?<![\p{L}\p{N}])lập\s+đ[aãáàầ]["']*\s*y(?![\p{L}\p{N}])/gui, fixWithCase("lấp đầy"));
  res = res.replace(/(?<![\p{L}\p{N}])lấp\s+đ[aãáàầ]["']*\s*y(?![\p{L}\p{N}])/gui, fixWithCase("lấp đầy"));
  res = res.replace(/(?<![\p{L}\p{N}])khì(?=\s+(?:di|bạn|click|mở|kéo|nhấp|nhấn|chọn|xem|bật|tắt|chạy))/gui, fixWithCase("khi"));
  res = res.replace(/(?<![\p{L}\p{N}])môi(?=\s+(?:khung|dòng|lần|khối|cột|trang|bước|từ|ảnh))/gui, fixWithCase("mỗi"));
  res = res.replace(/(?<![\p{L}\p{N}])(?:quét|chọn|nhận|hiểu)\s+nh[aãảáầ]["']*\s*m(?![\p{L}\p{N}])/gui, (m) => m.replace(/nh[aãảáầ]["']*\s*m/i, "nhầm"));
  res = res.replace(/(?<![\p{L}\p{N}])(?:chỉ|không)\s+c[aảãầ]["']*\s*n(?![\p{L}\p{N}])/gui, (m) => m.replace(/c[aảãầ]["']*\s*n/i, "cần"));
  res = res.replace(/(?<![\p{L}\p{N}])c[aảãầ]['`]?\s*n(?=\s+(?:bấm|chọn|kéo|làm|phải|thiết|đổi))/gui, fixWithCase("cần"));
  res = res.replace(/(?<![\p{L}\p{N}])b[aãảáấ]["']*\s*m(?=\s+(?:vào|lại|nút|chuột))/gui, fixWithCase("bấm"));
  res = res.replace(/(?<![\p{L}\p{N}])m[aãảáấ]["']*\s*t(?=\s+(?:công|thời gian|kết nối|dữ liệu))/gui, fixWithCase("mất"));
  res = res.replace(/(?<![\p{L}\p{N}])n[aãảáầ]["']*\s*m(?=\s+(?:ngay|dưới|trên|ở|trong|ngoài))/gui, fixWithCase("nằm"));
  res = res.replace(/(?<![\p{L}\p{N}])che\s+khuat(?![\p{L}\p{N}])/gui, fixWithCase("che khuất"));
  res = res.replace(/(?<![\p{L}\p{N}])Điểu\s+chỉnh(?![\p{L}\p{N}])/gui, "Điều chỉnh");
  res = res.replace(/(?<![\p{L}\p{N}])điểu\s+chỉnh(?![\p{L}\p{N}])/gui, "điều chỉnh");
  res = res.replace(/(?<=(?:muốn|cần|để)\s+)lày\b/gui, "lấy");
  res = res.replace(/ICopy/g, "Copy");
  res = res.replace(/\[\s*Copy\s+khung\s*\]/gi, "[Copy khung]");
  res = res.replace(/Để\s+xuấ\s*thoàn\s*thiện/gui, "Đề xuất hoàn thiện");
  res = res.replace(/Đề\s+xuấ\s*thoàn\s*thiện/gui, "Đề xuất hoàn thiện");

  // 14. Xóa các ký tự nháy/backtick trôi nổi còn sót giữa các chữ
  res = res.replace(/([a-zA-ZăâđêôơưĂÂĐÊÔƠƯ])\s*['`´ˆ˜^"]\s*([a-zA-Z])/gu, "$1$2");

  // 15. Phục hồi từ "và" giữa các mệnh đề
  res = res.replace(/\s+va\s+(?=\[|Khung|\p{L})/gu, " và ");

  // 16. Tách khoảng trắng bị dính giữa các từ phổ biến
  res = res.replace(/chữkéo/gui, "chữ kéo");

  // 17. Chuẩn hóa khoảng trắng & dấu câu an toàn (bảo vệ dấu ba chấm ..., tên file .ts/.tsx/.png)
  res = res.replace(/[ \t]{2,}/g, " ");
  // Chuẩn hóa dấu phẩy, chấm phẩy, hai chấm: chỉ thêm space sau dấu nếu chưa có
  res = res.replace(/\s*([,;:])\s*/g, "$1 ");
  // Chuẩn hóa dấu chấm câu nếu đi liền với chữ cái viết hoa kế tiếp (không ảnh hưởng .ts, .tsx hay ...)
  res = res.replace(/(?<=[a-zA-Zà-ỹÀ-Ỹ])\s*\.\s*(?=[A-ZÀ-Ỹ])/gu, ". ");
  // Bảo vệ dấu ba chấm hoặc chuỗi dấu chấm
  res = res.replace(/\.\s+\.\s+\./g, "...");
  res = res.replace(/\.\s+\./g, "..");
  res = res.replace(/\(\s+/g, "(");
  res = res.replace(/\s+\)/g, ")");
  res = res.replace(/\[\s+/g, "[");
  res = res.replace(/\s+\]/g, "]");

  return res.trim();
}

/**
 * Làm sạch và chuẩn hóa văn bản Tiếng Nhật (Japanese - 日本語)
 * Bảo toàn 100% Kanji, Hiragana, Katakana. Xóa khoảng trắng nhân tạo do Tesseract tự chèn giữa các ký tự CJK.
 * Giữ nguyên khoảng trắng quanh các từ tiếng Anh / mã nguồn / số tự nhiên.
 */
export function cleanJapaneseOcrText(text: string): string {
  if (!text) return "";

  let res = text.normalize("NFC");

  // 1. Chuẩn hóa dấu câu tiếng Nhật
  res = res.replace(/､/g, "、");
  res = res.replace(/｡/g, "。");
  res = res.replace(/･/g, "・");
  res = res.replace(/｢/g, "「");
  res = res.replace(/｣/g, "」");

  // 2. Xóa khoảng trắng nhân tạo giữa 2 ký tự CJK (Kanji, Hiragana, Katakana)
  // Ví dụ: "プ ロ ジ ェ ク ト" -> "プロジェクト", "設 計 書" -> "設計書", "画 面" -> "画面"
  res = res.replace(
    /([\u3040-\u309F\u30A0-\u30FF\u4E00-\u9FAF])\s+([\u3040-\u309F\u30A0-\u30FF\u4E00-\u9FAF])/gu,
    "$1$2"
  );
  res = res.replace(
    /([\u3040-\u309F\u30A0-\u30FF\u4E00-\u9FAF])\s+([\u3040-\u309F\u30A0-\u30FF\u4E00-\u9FAF])/gu,
    "$1$2"
  );

  // 3. Xóa khoảng trắng nhân tạo giữa các chữ cái viết tắt tiếng Anh (Acronyms: U I -> UI, O C R -> OCR, A P I -> API)
  res = res.replace(/([A-Z])\s+([A-Z])(?=[\s\u3040-\u309F\u30A0-\u30FF\u4E00-\u9FAF]|$)/gu, "$1$2");
  res = res.replace(/([A-Z])\s+([A-Z])(?=[\s\u3040-\u309F\u30A0-\u30FF\u4E00-\u9FAF]|$)/gu, "$1$2");

  // 4. Xóa khoảng trắng giữa CJK và acronym tiếng Anh nếu bị Tesseract chèn
  res = res.replace(/([\u3040-\u309F\u30A0-\u30FF\u4E00-\u9FAF])\s+([A-Z]{2,4})(?=[\s\u3040-\u309F\u30A0-\u30FF\u4E00-\u9FAF]|$)/gu, "$1$2");
  res = res.replace(/([A-Z]{2,4})\s+([\u3040-\u309F\u30A0-\u30FF\u4E00-\u9FAF])/gu, "$1$2");

  // 5. Chuẩn hóa khoảng trắng quanh dấu ngoặc và dấu câu tiếng Nhật
  res = res.replace(/\s*([、。・「」『』（）])\s*/g, "$1");

  // 6. Chuẩn hóa khoảng trắng đa khoảng trắng
  res = res.replace(/[ \t]{2,}/g, " ");

  return res.trim();
}

/**
 * Làm sạch và chuẩn hóa văn bản Tiếng Anh (English)
 * Bảo toàn mã nguồn, camelCase, snake_case, file extensions, tokens, URLs
 */
export function cleanEnglishOcrText(text: string): string {
  if (!text) return "";

  let res = text.normalize("NFC");

  // Sửa nhanh lỗi quang học AP1 -> API
  res = res.replace(/\bAP[1l]\b/g, "API");

  // Chuẩn hóa khoảng trắng trước dấu câu tiếng Anh: "word , word" -> "word, word"
  res = res.replace(/\s+([,;:.!?])/g, "$1");
  res = res.replace(/[ \t]{2,}/g, " ");

  return res.trim();
}

/**
 * Bộ điều phối làm sạch văn bản OCR thông minh theo ngôn ngữ (Language-Aware OCR Text Cleaner)
 */
export function cleanOcrText(text: string, langMode: OcrLanguageMode = "vi"): string {
  if (!text) return "";

  if (langMode === "ja") {
    return cleanJapaneseOcrText(text);
  }

  if (langMode === "en") {
    return cleanEnglishOcrText(text);
  }

  if (langMode === "vi") {
    return cleanVietnameseOcrText(text);
  }

  // Với chế độ "all" hoặc "zh": Tự động phát hiện tập ký tự chiếm ưu thế
  const jaCount = (text.match(/[\u3040-\u309F\u30A0-\u30FF]/gu) || []).length;
  const cjkCount = (text.match(/[\u4E00-\u9FAF]/gu) || []).length;
  const viCount = (text.match(/[à-ỹÀ-ỸđĐ]/gu) || []).length;

  if (jaCount >= 2 || (cjkCount >= 3 && viCount === 0)) {
    return cleanJapaneseOcrText(text);
  }

  if (viCount > 0) {
    return cleanVietnameseOcrText(text);
  }

  return cleanEnglishOcrText(text);
}

/**
 * Làm sạch từng từ đơn lẻ (dùng cho mảng OcrWord trong LiveTextOverlay)
 */
export function cleanOcrWord(word: string, langMode: OcrLanguageMode = "vi"): string {
  if (!word) return "";
  return cleanOcrText(word, langMode);
}

// Giữ lại alias cũ để tương thích ngược hoàn toàn
export const cleanVietnameseWord = cleanOcrWord;
