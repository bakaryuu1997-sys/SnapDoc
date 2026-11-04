# SnapDoc 10/10 Perfection Plan (OCR, Auto-Redact, Drag-Out)

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Hoàn thiện 4 vũ khí tối thượng đưa SnapDoc đạt điểm số tuyệt đối 10/10: Windows Native OCR Engine (`run_ocr`), 1-Click Smart Auto-Redact (tự động phát hiện và làm mờ Email/API Keys/SĐT/IP), Nút trích xuất chữ OCR trên Thumbnail & Editor Toolbar, và Hỗ trợ Drag-Out Thumbnail.

**Architecture:** 
- Backend Rust + PowerShell WinRT: Tận dụng `Windows.Media.Ocr.OcrEngine` có sẵn trong Windows 10/11 để trích xuất văn bản và toạ độ BoundingBox của từng từ mà không cần bất kỳ thư viện ngoài nặng nề nào.
- Frontend React: Bổ sung handler `runOcr` trong `ipc.ts`, thêm nút `📝 OCR` trên `Thumbnail.tsx` và `Toolbar.tsx`, thêm nút `🔒 Che nhạy cảm` trong `Toolbar.tsx` tự động sinh các `BlurAnn` mosaic layer lên canvas.

**Tech Stack:** Rust, Windows Runtime OCR (`Windows.Media.Ocr`), React 18, TypeScript, Canvas 2D.

---

### Task 1: Backend Rust Windows OCR Command

**Files:**
- Create: `scripts/ocr.ps1`
- Modify: `src-tauri/src/commands.rs`
- Modify: `src-tauri/src/lib.rs`
- Modify: `src/lib/ipc.ts`

- [ ] **Step 1: Viết script `scripts/ocr.ps1`**
  - Chạy `Windows.Media.Ocr.OcrEngine` trả về JSON `{ text: string, words: [{ text, x, y, w, h }] }`.
- [ ] **Step 2: Viết Rust Command `run_ocr` trong `src-tauri/src/commands.rs`**
  - Nhận `image_data: String` (hỗ trợ cả dataURL, base64 hoặc file path).
  - Tự động sinh file tạm nếu là dataURL, gọi script PowerShell và parse JSON kết quả.
  - Đăng ký `run_ocr` trong `src-tauri/src/lib.rs` invoke_handler.
- [ ] **Step 3: Khai báo IPC `runOcr` trong `src/lib/ipc.ts`**
  - `runOcr: (imageData: string) => invoke<OcrResponse>("run_ocr", { imageData })`
- [ ] **Step 4: Kiểm tra biên dịch**
  - Chạy `npm run build` và `cargo check`.

---

### Task 2: Quick OCR & Drag-Out trên Popup Thumbnail

**Files:**
- Modify: `src/routes/thumbnail/Thumbnail.tsx`
- Modify: `src/locales/vi/translation.json`
- Modify: `src/locales/en/translation.json`

- [ ] **Step 1: Bổ sung nút `📝 OCR` trên `Thumbnail.tsx`**
  - Khi bấm: gọi `ipc.runOcr(src)`, copy văn bản trực tiếp vào clipboard.
- [ ] **Step 2: Thêm Drag-Out `onDragStart` trên ảnh thumbnail**
  - Cho phép người dùng nhấn giữ kéo thả thẳng ảnh thumbnail ra ngoài ứng dụng khác.

---

### Task 3: 1-Click Smart Auto-Redact & OCR trong Editor

**Files:**
- Modify: `src/routes/editor/Toolbar.tsx`
- Modify: `src/routes/editor/Editor.tsx`
- Modify: `src/locales/vi/translation.json`
- Modify: `src/locales/en/translation.json`

- [ ] **Step 1: Bổ sung nút `📝 OCR` và `🔒 Che nhạy cảm` trong Toolbar**
  - Thêm props `onOcr?: () => void;` và `onAutoRedact?: () => void;` trong `Toolbar.tsx`.
- [ ] **Step 2: Triển khai logic Auto-Redact trong `Editor.tsx`**
  - Xuất ảnh hiện tại từ stage `stageRef.current?.exportPng()`.
  - Gọi `ipc.runOcr(url)`.
  - Kiểm tra từ trùng khớp pattern nhạy cảm (Email `@`, Token/Key `sk-`, `ghp_`, số thẻ/điện thoại, IP address).
  - Tự động gọi `addAnnotation` với type `blur`, chế độ `pixelate`, kích thước khớp bounding box + padding 4px.
  - Thông báo người dùng: `Đã tự động che mờ X vị trí nhạy cảm! 🔒`.

---

### Task 4: Tích hợp vào Command Palette & Đóng gói Bản cài đặt

**Files:**
- Modify: `src/components/CommandPalette.tsx`
- Đóng gói: `dist-installers/`

- [ ] **Step 1: Bổ sung lệnh OCR trong `CommandPalette.tsx`**
- [ ] **Step 2: Kiểm tra biên dịch `npm run build`**
- [ ] **Step 3: Biên dịch `npx tauri build`**
- [ ] **Step 4: Đồng bộ mã nguồn và bộ cài đặt vào `G:\マイドライブ\project\snapdoc\`**
