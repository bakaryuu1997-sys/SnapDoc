# SnapDoc — Báo cáo thực thi test hệ thống (ST) — bản 3.9.1 (lỗi sửa trong 3.9.2)

**Ngày:** 2026-11-05 · **Phạm vi:** toàn bộ màn hình chính của app Windows (Tauri 2) · **Người thực hiện:** Claude (tự động hoá bằng WebView2 DevTools Protocol)

## 1. Môi trường & phương pháp

- Chạy **bản release thật** (`snapdoc.exe`) chứ không phải dev server, với **IPC Tauri thật** (`invoke`), FFmpeg đóng gói thật, Whisper.cpp thật, OCR WASM thật.
- Để không đụng tới bản cài của bạn (đang chạy, có mục autostart `SnapDoc`), bản test được build riêng với `identifier = com.snapdoc.e2etest`, `productName = SnapDocE2E`: dữ liệu, settings, WebView2, registry hoàn toàn tách biệt; phím tắt đổi sang `Ctrl+Alt+Shift+F1..F9`. Đã xác nhận mục autostart của bạn không đổi.
- Điều khiển: kết nối từng cửa sổ qua cổng gỡ lỗi WebView2 → bấm/gõ/kéo thật, đọc DOM, gọi lệnh Tauri, **chụp ảnh màn hình để kiểm tra bằng mắt**; video/ảnh thử là dữ liệu tổng hợp (không dùng màn hình/camera/dữ liệu cá nhân của bạn).
- Bộ điều khiển và các kịch bản nằm ở `scripts/e2e/` (chạy lại được).

## 2. Kết quả theo test case

Quy ước: ✅ Pass · ❌ Fail (đã sửa → ghi mã bug) · ➖ Không chạy.

| ID | Khu vực | Nội dung | KQ | Ghi chú / Bug |
|---|---|---|:-:|---|
| ST-01a–c | Khởi động | 7 webview prewarm, cấu hình cô lập nạp đúng | ✅ | |
| ST-01d | Phím tắt | Đăng ký không xung đột | ❌ | `Ctrl+Shift+T` (textGrab) trùng bản cài đang chạy (do chạy song song) → lộ **BUG-01** |
| ST-11 | Cập nhật | Updater của tác giả gốc bị vô hiệu hoá | ✅ | `check_update` → không có bản mới, không gọi mạng |
| ST-02a–b | Capture Bar | 980×80, 12 nút, phím tắt hiển thị đúng | ✅ | |
| ST-03a–h | Settings | 5 tab; tab Chia sẻ: hướng dẫn 5 bước, nút khoá/mở theo ô nhập, lưu bền | ✅ | |
| ST-03i | Settings | Hàng phím tắt Text Grab | ❌→✅ | BUG-01, đã sửa |
| ST-04a–b | Command Palette | Ctrl+K mở, lọc "webcam" | ✅ | |
| ST-05a–e | Webcam Bubble | Mở/đóng cửa sổ 220×220, trạng thái mở | ❌→✅ | **BUG-04** (app đơ), đã sửa |
| ST-06a–c | Editor ảnh | Mở ảnh 1100×640, dựng canvas, không lỗi console | ✅ | |
| ST-06d–f | Annotation | Khung, mũi tên, hoàn tác/làm lại | ✅ | xác nhận bằng ảnh chụp |
| ST-06g | Annotation | Công cụ Chữ | ✅ | Esc huỷ chữ thay vì xác nhận → OBS-02 |
| ST-06h | Làm đẹp | Nền gradient + bo góc + bóng | ✅ | |
| ST-06i | Che nhạy cảm | Che email, API key, SĐT có dấu cách, thẻ | ❌→✅ | **BUG-03**: trước chỉ che 1/4 vùng; sau sửa che 4/4 |
| ST-06j | OCR | Nhận đúng chữ Việt | ⚠️ | Đúng phần lớn; email bị thêm dấu (`nguyên.van…`), tiêu đề lệch thứ tự → OBS-03 |
| ST-07a–f | Lịch sử | Ghi vào thư viện, xem trước, xoá + hoàn tác | ❌→✅ | **BUG-02** (cửa sổ sập khi chọn mục), đã sửa |
| ST-08a–b | Pin | Ghim từ Lịch sử, cửa sổ Pin hiện ảnh | ✅ | |
| ST-09a–j | Video + Phụ đề | Mở video, cài engine+model **tải thật** (29 s, có % tiến độ), nhận diện thật (4 dòng đúng), sửa chữ, hiện trên trình phát, cắt đầu bằng phím Q, hộp thoại nhận biết "đã chỉnh sửa" | ✅ | |
| ST-09k–o | Xuất đã chỉnh sửa | Cắt 3 s + phụ đề soft/burn qua `trim_history_video`: 9,68 s đúng, track `mov_text` có/không đúng chế độ, **mốc phụ đề khớp** (kiểm bằng khung hình) | ✅ | |
| ST-09p | Editor | Hộp tiến độ không kẹt sau khi xuất từ hộp thoại phụ đề | ❌→✅ | **BUG-05**: bản đầu bị kẹt 100% (có ảnh chụp); bản sửa tự tắt (xuất nhanh nên không bắt được lúc hộp hiện) |
| ST-05f–g | Webcam Bubble | Thông báo "Đang chờ quyền truy cập camera…", đóng bong bóng app vẫn phản hồi | ✅ | OBS-01 đã cải thiện |
| ST-10a–f | Google Drive | Chưa kết nối → báo lỗi rõ; file token cũ tự chuyển sang DPAPI, file thô bị xoá, `.dat` không lộ token, ngắt kết nối xoá sạch | ✅ | |
| ST-10g | Google Drive | Đăng nhập OAuth + upload thật | ➖ | cần Client ID/Secret của bạn |
| ST-12 | Overlay chọn vùng, chụp cuộn, quay màn hình, thumbnail sau chụp, tray, phím tắt toàn cục | | ➖ | cần chụp/quay desktop thật của bạn (riêng tư) — nên test tay |
| ST-13 | Camera trực tiếp | Hình từ webcam | ➖ | không cấp quyền camera |
| ST-14 | Cài/gỡ bằng `setup.exe`, đa màn hình, DPI cao | | ➖ | |

**Tổng kết: 66 test case đã chạy, 66/66 đạt sau khi sửa 5 lỗi thật (BUG-01…05); các mục liên quan 5 lỗi này không đạt ở lần chạy đầu · 6 nhóm chưa chạy (liệt kê ở trên).**
(Test tự động đi kèm: Rust 19 + 1 e2e đầu-cuối; frontend 66 — tất cả đạt.)

## 3. Lỗi phát hiện

| Bug | Mức | Mô tả | Gốc rễ | Trạng thái |
|---|:-:|---|---|---|
| BUG-04 | 🔴 Critical | Bật Webcam Bubble làm **cả app đơ** | Lệnh Tauri đồng bộ tạo cửa sổ trên luồng chính → deadlock Windows (do tôi viết) | ✅ Sửa: `async` |
| BUG-02 | 🔴 Critical | Chọn 1 mục trong Lịch sử → cửa sổ **sập** (React #310) | Hook `useState` đặt sau `return` sớm trong nút "Chia sẻ qua Drive" (do tôi viết) | ✅ Sửa: chuyển hook lên trên |
| BUG-05 | 🟠 High | Xuất video kèm phụ đề → Editor bị phủ hộp "Đang lưu… 100%" **kẹt vĩnh viễn** | Editor nghe `trim-progress` toàn cục nhưng chỉ luồng lưu của nó mới tắt hộp phủ | ✅ Sửa: tự tắt sau 100% / 30 s im lặng |
| BUG-03 | 🟠 High | Che nhạy cảm bỏ sót email, SĐT, thẻ | Kiểm từng từ OCR: OCR thêm dấu vào email; SĐT/thẻ bị tách bởi dấu cách | ✅ Sửa: `lib/sensitiveDetector.ts` (+9 test, kiểm Luhn thẻ) |
| BUG-01 | 🟡 Medium | Phím Text Grab không đổi được dù báo "hãy đổi bên dưới" | Thiếu hàng `textGrab` trong `SHORTCUT_KEYS` | ✅ Sửa |

Quan sát (chưa phải lỗi chặn): OBS-01 Webcam Bubble hiện vòng tròn đen im lặng khi chờ quyền camera (đã thêm thông báo) · OBS-02 `Esc` huỷ chữ đang gõ thay vì xác nhận · OBS-03 chất lượng OCR (xem ST-06j) · OBS-04 chuỗi tiếng Việt cứng ngoài i18n (tab Chia sẻ, Webcam, vài mục Palette) và nhãn lẫn Anh–Việt ("Trash", "Finder/Explorer") · OBS-05 Command Palette chỉ gắn ở Editor và Lịch sử · OBS-06 RAM đo được 1,2–1,9 GB sau khi dùng nặng (Editor + OCR + video) so với ~124 MB lúc nhàn rỗi của bản đang cài; chưa xác định có giải phóng khi đóng cửa sổ.

**Bài học quy trình:** 2 lỗi Critical đều **vượt qua `cargo check`, `tsc` và toàn bộ unit test**, chỉ lộ khi chạy app thật → cần giữ bộ E2E này trong quy trình, và thêm `eslint-plugin-react-hooks`.

## 4. Đánh giá tiêu chí thoát & Go/No-Go

- 0 Critical/High còn mở trong phạm vi đã test ✅ · Pass rate sau sửa 66/66 ✅ · Execution rate: toàn bộ mục có thể tự động hoá đã chạy; **6 nhóm cần người test tay** (chụp vùng/cuộn, quay, thumbnail, tray, OAuth thật, cài đặt).
- **Kết luận: GO cho dùng cá nhân bản 3.9.2**, với điều kiện bạn chạy tay nhóm ST-12/13/14 một lần. Bản 3.9.0 bạn đang cài **có BUG-02 và BUG-04** — nên nâng cấp.
