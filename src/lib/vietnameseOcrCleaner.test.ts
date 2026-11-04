import { describe, it, expect } from "vitest";
import {
  cleanVietnameseOcrText,
  cleanJapaneseOcrText,
  cleanEnglishOcrText,
  cleanOcrText,
  cleanOcrWord,
} from "./vietnameseOcrCleaner";

describe("Vietnamese OCR Cleaner (cleanVietnameseOcrText)", () => {
  it("hàn gắn các dấu thanh bị tách trong từ tiếng Việt trên màn hình", () => {
    const input = "• API Key (bă ' t đâ ' u bă ` ng sk-, ghp_, ...)";
    const expected = "• API Key (bắt đầu bằng sk-, ghp_, ...)";
    expect(cleanVietnameseOcrText(input)).toBe(expected);

    const inputDark = "bắt đã u bằng sk-. Excel Mã u Phỏng Và'n Tiếng Việt nhay cảm";
    const expectedDark = "bắt đầu bằng sk-. Excel Mẫu Phỏng Vấn Tiếng Việt nhạy cảm";
    expect(cleanVietnameseOcrText(inputDark)).toBe(expectedDark);
  });

  it("TUYỆT ĐỐI không làm hỏng các từ tiếng Anh thuần như can, bat, bang, lap", () => {
    const englishInput = "you can use bat in lap test with big bang theory";
    const cleaned = cleanVietnameseOcrText(englishInput);
    expect(cleaned).toBe("you can use bat in lap test with big bang theory");
    expect(cleaned).not.toContain("cần");
    expect(cleaned).not.toContain("bắt");
    expect(cleaned).not.toContain("bằng");
    expect(cleaned).not.toContain("lập");
  });

  it("bảo toàn 100% chữ Kanji/Kana trong tài liệu song ngữ Nhật - Việt", () => {
    const bilingualInput = "設計書 Màn hình đăng nhập và xác thực tài khoản";
    const cleaned = cleanVietnameseOcrText(bilingualInput);
    expect(cleaned).toContain("設計書");
    expect(cleaned).toContain("Màn hình đăng nhập và xác thực tài khoản");
  });

  it("sửa các lỗi nhận nhầm ký tự Umlaut Đức (ä, ö, ü) do font màn hình và Dark mode", () => {
    const umlautSample = "cöt và döng khöng bị dính chü và laptüc dudc tách ra";
    const cleaned = cleanVietnameseOcrText(umlautSample);
    expect(cleaned).toContain("cột");
    expect(cleaned).toContain("dòng");
    expect(cleaned).toContain("không");
    expect(cleaned).toContain("chữ");
    expect(cleaned).toContain("lập tức");
    expect(cleaned).toContain("được");
    expect(cleaned).not.toContain("ä");
    expect(cleaned).not.toContain("ö");
    expect(cleaned).not.toContain("ü");
  });

  it("khử dấu nháy kép rác và hàn gắn các âm tiết bị ngắt đôi từ VieSVTR", () => {
    const input = 'thanh điể u khiển có nút [Kéo hộp chọn]. Bạn chỉ cả\'n bã\'m vào nút mà không mãt công.';
    const cleaned = cleanVietnameseOcrText(input);
    expect(cleaned).toContain("điều khiển");
    expect(cleaned).toContain("chỉ cần bấm");
    expect(cleaned).toContain("không mất công");

    const input2 = 'đường viể"n tinh tế"" và tuyệt đố \'i chính xác, xuố ng dòng và gom khố i text.';
    const cleaned2 = cleanVietnameseOcrText(input2);
    expect(cleaned2).toContain("đường viền tinh tế");
    expect(cleaned2).toContain("tuyệt đối chính xác");
    expect(cleaned2).toContain("xuống dòng");
    expect(cleaned2).toContain("gom khối text");

    const input3 = 'thanh tiêu để" bị lập đã"y nên quét nhã" m sang Sidebar, nãm ngay bên dưới.';
    const cleaned3 = cleanVietnameseOcrText(input3);
    expect(cleaned3).toContain("tiêu đề");
    expect(cleaned3).toContain("lấp đầy");
    expect(cleaned3).toContain("quét nhầm");
    expect(cleaned3).toContain("nằm ngay");
  });

  it("xử lý hoàn hảo toàn bộ văn bản thực tế từ VieSVTR trên giao diện Antigravity", () => {
    const input = `Nguyên nhân trước đó: Do ảnh chụp có các dòng chữ kéo dài toàn màn hình (ví dụ thanh tiêu đề project drive bakaryuu1997 / snapdoc ), thuật toán tìm rãnh trông bị lập đã''y nên vô tình gộp Sidebar và Vùng chính thành một khố'i.
Giải pháp & Đề' xuấ't hoàn thiện:
1. Tách cột & Rãnh dọc thông minh (Gutter & Clustering): Bộ phân tích sortBoxesColumnAware tự động lọc bỏ các thanh tiêu để toàn trang để nhận diện chính xác rãnh dọc giữa Sidebar bên trái và Vùng nội dung chính bên phải.
2. Bộ bảo vệ cô lập vùng bôi đen (Selection Isolation Guard): Khi bạn click chuột vào cột Nội dung chính, cột Sidebar lập tức được chuyển sang user-select: none. Khi bạn kéo chuột chọn chữ, trình duyệt tuyệt đố 'i không thể quét nhã'm chữ sang Sidebar!
3. Hiển thị trực quan các khung & Nút Copy 1-Click:
Các cột/khung được bao quanh bởi đường viể'n tinh tế' và phát sáng nhẹ khì di chuột.
Trên đỉnh môi khung có thẻ hiển thì: Khung 1 (Sidebar) dòng và Khung 2 (Nội dung) M dòng].
Bạn chỉ cầ'n bã'm vào nút ICopy khung] là toàn bộ chữ của riêng khung đó sẽ được copy vào Clipboard mà không cầ'n mãt công kéo bôi đen thủ công.
4. Chế' độ Kéo hộp chọn tự do (Marquee Box Selection):
Trên thanh điể u khiển Live Text có thêm nút [ Kéo hộp chọn ].
Khi bật chế' độ này, bạn chỉ cầ'n kéo chuột vẽ một khung hình chữ nhật bao quanh vùng muố'n lày (ví dụ 1 đoạn văn, 1 bảng con, hoặc 1 khố i text), ứng dụng sẽ tự động chọn và hiện menu Copy/Che mờ vùng đó với độ chính xác tuyệt đố'i.
5. Căn chỉnh vị trí Topbar: Điể'u chỉnh vị trí Topbar từ top: 68px xuố ng top: 84px nã'm ngay bên dưới Toolbar 74px, không còn che khuat một nửa như trước.`;

    const cleaned = cleanVietnameseOcrText(input);
    expect(cleaned).toContain("rãnh trống bị lấp đầy");
    expect(cleaned).toContain("thành một khối.");
    expect(cleaned).toContain("Giải pháp & Đề xuất hoàn thiện:");
    expect(cleaned).toContain("thanh tiêu đề toàn trang");
    expect(cleaned).toContain("tuyệt đối không thể quét nhầm");
    expect(cleaned).toContain("đường viền tinh tế và phát sáng nhẹ khi di chuột.");
    expect(cleaned).toContain("Trên đỉnh mỗi khung");
    expect(cleaned).toContain("Bạn chỉ cần bấm vào nút Copy khung]");
    expect(cleaned).toContain("không cần mất công");
    expect(cleaned).toContain("Chế độ Kéo hộp chọn");
    expect(cleaned).toContain("thanh điều khiển Live Text");
    expect(cleaned).toContain("vùng muốn lấy");
    expect(cleaned).toContain("1 khối text");
    expect(cleaned).toContain("độ chính xác tuyệt đối.");
    expect(cleaned).toContain("Điều chỉnh vị trí Topbar");
    expect(cleaned).toContain("xuống top: 84px nằm ngay bên dưới");
    expect(cleaned).toContain("không còn che khuất");
  });

  it("loại bỏ ký tự rác do nhận diện nhầm Emoji", () => {
    expect(cleanVietnameseOcrText('1 nút bấm: "âChe thông tin nhay cảm"')).toBe('1 nút bấm: "Che thông tin nhạy cảm"');
    expect(cleanVietnameseOcrText("4. â Smart Auto-Redact")).toBe("4. Smart Auto-Redact");
  });

  it("sửa lỗi Số ' và dấu chấm tách rời", () => {
    const input = "• Số ' thẻ tín dụng / Số ' tài khoản ngân hàng";
    expect(cleanVietnameseOcrText(input)).toBe("• Số thẻ tín dụng / Số tài khoản ngân hàng");

    const input2 = "• Mật khẩu dạng dâ ' u châ ' m ......";
    expect(cleanVietnameseOcrText(input2)).toBe("• Mật khẩu dạng dấu chấm ......");
  });

  it("giữ nguyên tên file extension và mã nguồn tiếng Anh trong câu tiếng Việt", () => {
    const input = "SnapDoc ( mouseFocusEngine.ts ).";
    expect(cleanVietnameseOcrText(input)).toBe("SnapDoc (mouseFocusEngine.ts).");
  });
});

describe("Japanese OCR Cleaner (cleanJapaneseOcrText)", () => {
  it("xóa khoảng trắng nhân tạo giữa các ký tự Kanji, Hiragana và Katakana", () => {
    const input = "プ ロ ジ ェ ク ト の 画 面 U I 設 計 書 を 作 成 す る";
    const cleaned = cleanJapaneseOcrText(input);
    expect(cleaned).toBe("プロジェクトの画面UI設計書を作成する");
  });

  it("bảo toàn 100% Kanji và Kana, không xóa nhầm ký tự Nhật", () => {
    const input = "SnapDoc で 高速 に スクリーンショット を 撮影";
    const cleaned = cleanJapaneseOcrText(input);
    expect(cleaned).toContain("SnapDoc");
    expect(cleaned).toContain("高速にスクリーンショットを撮影");
  });

  it("chuẩn hóa dấu câu tiếng Nhật chuẩn", () => {
    const input = "設定､画面｡プロジェクト･管理｢重要｣";
    const cleaned = cleanJapaneseOcrText(input);
    expect(cleaned).toBe("設定、画面。プロジェクト・管理「重要」");
  });
});

describe("English OCR Cleaner (cleanEnglishOcrText)", () => {
  it("bảo toàn nguyên vẹn camelCase, snake_case và đường dẫn file", () => {
    const input = "const isDarkMode = sortBoxesColumnAware(boxes, imgW);";
    expect(cleanEnglishOcrText(input)).toBe("const isDarkMode = sortBoxesColumnAware(boxes, imgW);");

    const pathInput = "C:\\Users\\asus\\snapdoc\\src\\lib\\mouseFocusEngine.ts";
    expect(cleanEnglishOcrText(pathInput)).toBe("C:\\Users\\asus\\snapdoc\\src\\lib\\mouseFocusEngine.ts");
  });

  it("sửa nhanh các lỗi quang học đặc trưng như AP1 -> API", () => {
    expect(cleanEnglishOcrText("Use AP1 Key for auth")).toBe("Use API Key for auth");
    expect(cleanEnglishOcrText("export const API_URL = 'https://api.snapdoc.app' ;")).toBe(
      "export const API_URL = 'https://api.snapdoc.app';"
    );
  });
});

describe("Language-Aware Router (cleanOcrText)", () => {
  it("điều phối chính xác theo chế độ ngôn ngữ đã chọn", () => {
    // Mode ja
    expect(cleanOcrText("プ ロ ジ ェ ク ト", "ja")).toBe("プロジェクト");

    // Mode vi
    expect(cleanOcrText("bă't đâ`u", "vi")).toBe("bắt đầu");

    // Mode en
    expect(cleanOcrText("AP1 Key", "en")).toBe("API Key");
  });

  it("tự động nhận diện ngôn ngữ khi dùng chế độ đa ngôn ngữ (all)", () => {
    expect(cleanOcrText("設 計 書 を 確 認", "all")).toBe("設計書を確認");
    expect(cleanOcrText("bắt đầu thực hiện", "all")).toContain("bắt đầu");
  });

  it("cleanOcrWord làm sạch từ đơn lẻ chính xác", () => {
    expect(cleanOcrWord("bă't", "vi")).toBe("bắt");
    expect(cleanOcrWord("mê`m", "vi")).toBe("mềm");
    expect(cleanOcrWord("AP1", "en")).toBe("API");
  });
});
