# Product Teardown — SnapDoc 3.9.x (v3, 2026-11-05)

Dựa trên **mã nguồn thực tế** (74 file TS/TSX ≈ 36,5k dòng, 54 file Rust ≈ 25,6k dòng, 124 lệnh IPC, 18 loại cửa sổ, i18n vi/en cân bằng 662 khóa) và **kết quả chạy thật toàn bộ màn hình** (xem `docs/SnapDoc_Test_Report_3.9.1.md`). Báo cáo v2 cũ (30/10) đã lỗi thời: hầu hết đề xuất trong đó nay đã có.

## 1. Tóm tắt điều hành

**Điểm trưởng thành: 8,0 / 10** (hoàn thiện tính năng 9 · độ tin cậy 7 · hoàn thiện UX 8 · hiệu năng/tài nguyên 7 · bảo mật 8).

**3 tử huyệt**
1. **Độ tin cậy của tính năng mới thấp hơn độ rộng của nó.** Chạy thật bắt được 2 lỗi Critical (đơ app khi mở Webcam Bubble; sập Lịch sử khi chọn mục) và 3 lỗi High/Medium, cả hai lỗi Critical đều **qua mặt build, type-check và unit test**. Repo chưa có E2E, chưa có lint hooks → rủi ro tái phát cao.
2. **Tài nguyên.** Bản đang cài nhàn rỗi ~124 MB nhưng sau khi dùng Editor + OCR + video đo được **1,2–1,9 GB** (9 webview prewarm, 2 overlay/màn hình, WASM OCR). Chưa chứng minh được bộ nhớ được trả lại khi đóng cửa sổ.
3. **Tính năng bảo mật "hứa nhiều, giữ ít".** Che nhạy cảm tự động chỉ che 1/4 vùng trên ảnh thử (đã sửa trong 3.9.2), OCR tiếng Việt "tự thêm dấu" vào email/ID ASCII → mọi tính năng dựa trên OCR (Live Text, redact, Text Grab) đều bị ảnh hưởng.

**3 cơ hội vàng**
1. **Thư viện tìm kiếm được bằng nội dung** (OCR ảnh + lời thoại video, hoàn toàn offline) — hiện cả hai dữ liệu đã được tạo ra nhưng *bị vứt đi* sau mỗi phiên.
2. **Quay màn hình kiểu Loom/Screen Studio chạy local**: đã có auto-zoom, con trỏ mượt, phụ đề, webcam bubble, chia sẻ Drive — thiếu mảnh ghép là ghép webcam vào chính video và chia sẻ liền mạch.
3. **Redact thông minh cho video** (OCR lấy mẫu khung hình → làm mờ email/token trong bản quay) — đối thủ chưa có, mà người quay hướng dẫn kỹ thuật rất cần.

## 2. Hiện trạng so với Tier-1

| Năng lực | SnapDoc 3.9.x | CleanShot X | ShareX | Snagit | Screen Studio | Loom |
|---|---|---|---|---|---|---|
| Chụp vùng/cửa sổ/cuộn, pin, loupe, eyedropper | **Có (đủ)** | Có | Có | Có | – | – |
| Annotation + beautify 1-chạm + code block | **Có** | Có | Cơ bản | Mạnh | – | – |
| OCR + Live Text offline, tiếng Việt | **Có (mạnh nhất nhóm)**, nhưng chưa chính xác với ID ASCII | Có | Có | Có | – | – |
| Auto-redact | Có (email/token/SĐT/thẻ) | Thủ công | Thủ công | Có | – | – |
| Quay màn hình + HUD phím/click + auto-zoom | **Có** | Có | Cơ bản | Có | **Chuẩn mực** | Không auto-zoom |
| Phụ đề AI **offline**, khớp bản cắt | **Có — duy nhất chạy hoàn toàn local** | Không | Không | Không | Không | Có (cloud, 50+ ngôn ngữ) |
| Webcam | Cửa sổ nổi (chụp gián tiếp) | Ghép vào video | – | Có | Ghép + auto-framing | **Chuẩn mực** |
| Chia sẻ link | Drive cá nhân, thủ công, chỉ trong History | Cloud riêng | 70+ dịch vụ | Screencast | Có | **Lõi sản phẩm** |
| Tìm kiếm theo nội dung | Không | Có (cơ bản) | Không | Không | Không | Có (transcript) |
| Cài đặt/nhẹ | ~150 MB installer, 124 MB RAM nhàn rỗi | – | Rất nhẹ | Nặng | Nặng | Cloud |

## 3. Đề xuất theo 3 tầng (bám codebase hiện có)

### Tầng 1 — Quick wins (1–2 ngày mỗi mục)
1. **Chặn lỗi loại này quay lại:** thêm `eslint-plugin-react-hooks`; đưa `scripts/e2e/` vào CI (chạy smoke 5 phút); quy ước "lệnh tạo cửa sổ phải `async`" kèm test.
2. **Dọn i18n:** đưa chuỗi cứng (tab Chia sẻ, Webcam, Palette) vào `locales/`; thống nhất "Thùng rác/Explorer" thay "Trash/Finder".
3. **`Esc` xác nhận chữ thay vì huỷ** ở công cụ Chữ (`AnnotationStage.tsx`), đúng thói quen Snagit/Figma.
4. **Gắn Command Palette toàn cục** (hiện chỉ ở Editor/Lịch sử): mount ở Capture Bar, thêm mục tray; thêm lệnh "Phụ đề cho video gần nhất", "Chia sẻ mục gần nhất".
5. **OCR nhận biết ASCII:** token có `@`, `://`, `_`, hoặc toàn ký tự ASCII → chạy lại bằng model `eng` (hoặc bỏ dấu theo ngữ cảnh) trong `ocrService.processOcrResult`.
6. **Webcam Bubble nhớ vị trí/kích thước** và tự bật khi bắt đầu quay (hook vào `record::start`) — dữ liệu hiện chỉ lưu `deviceId/mirror/shape`.
7. **Toast "Đã copy link" + tuỳ chọn thư mục Drive riêng** cho Cloud Share (`drive.rs`: thêm `parents` khi upload).

### Tầng 2 — Nâng cấp chiến lược (3–5 ngày)
1. **Phụ đề nâng cao:** timestamp từng từ (`--output-json-full`) để tô từng chữ (karaoke), mẫu kiểu chữ/vị trí, xuất `.vtt/.ass`, **dịch sang tiếng Anh** (`-tr`), cắt khoảng lặng (VAD) — mọi thứ chỉ là thêm cờ cho `whisper-cli` + UI trong `CaptionsModal`.
2. **Chia sẻ video + tiến độ + huỷ** (hiện chỉ upload nguyên khối, không có % — nên dùng resumable upload của Drive API).
3. **Ghép webcam vào video** bằng FFmpeg overlay (khung tròn, bo góc) thay vì dựa vào cửa sổ nổi; cho phép chỉnh vị trí ở `VideoTrimmer`.
4. **Giải phóng bộ nhớ:** thu hồi (destroy/reload) webview nặng sau N phút không dùng; không prewarm overlay cho màn hình phụ cho đến lần chụp đầu.

### Tầng 3 — Killer moats
1. **"Spotlight cho mọi thứ bạn đã chụp":** lưu OCR và transcript vào SQLite **FTS5** (đã có `rusqlite` bundled); ô tìm kiếm trong Lịch sử trả về cả ảnh lẫn **đúng giây trong video** nơi từ đó được nói. Offline, riêng tư — Loom/CleanShot không làm được.
2. **Redact trong video:** lấy mẫu khung hình → OCR → dùng lại `sensitiveDetector` → làm mờ theo thời gian khi xuất (`encoder::trim` đã có hạ tầng overlay).
3. **Tóm tắt/chương tự động từ transcript** bằng LLM cục bộ (sidecar `llama.cpp`, cùng mô hình tải-có-kiểm-tra-SHA như Whisper) → "Loom AI không cần cloud".
4. **Camera thông minh:** nền mờ/auto-framing theo mặt cho Webcam Bubble (ONNX runtime đã có trong `public/onnxruntime`).

## 4. Lộ trình gợi ý

`Tuần 1`: Tầng 1 (1–7) + đưa E2E vào CI → ổn định. `Tuần 2–3`: Tầng 2 (1, 3, 4). `Tháng sau`: Tầng 3 mục 1 (tìm kiếm FTS) rồi mục 2.

## 5. Tự đánh giá lại (Self-improvement)

- Đề xuất có bám codebase? Có: mỗi mục trỏ tới file/hạ tầng sẵn có (whisper-cli flags, `encoder::trim`, `rusqlite`, `onnxruntime`).
- Điểm mù tự phát hiện: tính năng "xong" theo `tsc`/unit test chưa đồng nghĩa chạy được — chuẩn đánh giá phải gồm **chạy thật từng màn hình**. Mô thức UX học thêm: *Esc = xác nhận, không huỷ* với mọi trình soạn thảo trên canvas; *trạng thái chờ quyền hệ thống phải có lời giải thích*.
