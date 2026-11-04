# Nâng cấp Trải nghiệm Chuẩn Tier-1 cho SnapDoc

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Hoàn thiện trọn bộ tính năng nâng cấp trải nghiệm người dùng chuẩn Tier-1 theo Báo cáo Product Teardown v2: Ghim nhanh từ Thumbnail, Kính lúp Pixel & Bắt màu HEX (`C`) khi Chụp vùng, 1-Click Beautifier Preset, và Command Palette (`Ctrl+K`).

**Architecture:** Mở rộng các route và components hiện có (`Thumbnail.tsx`, `Overlay.tsx`, `Toolbar.tsx`), bổ sung modal tìm kiếm `CommandPalette.tsx` dùng chung. Giữ nguyên kiến trúc IPC Rust/Tauri v2 hiện tại, không gây ảnh hưởng đến các luồng quay video và chụp ảnh sẵn có.

**Tech Stack:** React 18, TypeScript, Tailwind/Inline CSS, Tauri v2 IPC, Canvas 2D API.

---

### Task 1: Ghim nhanh (📌 Pin) trực tiếp trên Popup Thumbnail

**Files:**
- Modify: `src/routes/thumbnail/Thumbnail.tsx`
- Modify: `src/locales/vi/translation.json`
- Modify: `src/locales/en/translation.json`

- [ ] **Step 1: Bổ sung translation key cho nút Pin Thumbnail**
  - Trong `src/locales/vi/translation.json`: `"thumbnail.pinTitle": "Ghim lên màn hình (Pin)"`
  - Trong `src/locales/en/translation.json`: `"thumbnail.pinTitle": "Pin to screen"`

- [ ] **Step 2: Thêm hàm `pin` và nút bấm `📌` vào `Thumbnail.tsx`**
  - Khai báo hàm `pin`: gọi `stopAutoClose()`, `ipc.pinImage(src)`, và `dismiss()`.
  - Đặt nút `<button style={btn} onClick={pin} title={t("thumbnail.pinTitle")}>📌</button>` vào cụm action buttons cạnh nút Copy.

- [ ] **Step 3: Kiểm tra biên dịch**
  - Chạy `npm run build` để kiểm tra TypeScript.

---

### Task 2: Kính lúp ngắm Pixel (Pixel Loupe) & Trích xuất màu HEX (`C`) khi Chụp vùng

**Files:**
- Modify: `src/routes/overlay/Overlay.tsx`
- Modify: `src/locales/vi/translation.json`
- Modify: `src/locales/en/translation.json`

- [ ] **Step 1: Bổ sung State & Canvas nạp frozen image cho kính lúp**
  - Trong `RegionSelect`: nạp `frozenUrl` vào một `HTMLImageElement` offscreen hoặc canvas context để lấy pixel RGB chính xác tại `cursorPos = [x, y]`.
  - Tính toán mã màu HEX `#RRGGBB` và RGB tương ứng.

- [ ] **Step 2: Vẽ kính lúp tròn (Pixel Loupe 4x/8x zoom)**
  - Khi `cursorHere` và không đang kéo tạo box: render một widget kính lúp tròn đường kính ~80px bay theo trỏ chuột (offset +20px để không che trỏ chuột).
  - Bên trong kính lúp: phóng đại lưới pixel 11x11 xung quanh trỏ chuột, tâm chữ thập màu tương phản, kèm nhãn hiển thị mã HEX `#RRGGBB` và tọa độ `x, y`.

- [ ] **Step 3: Bắt phím tắt `C` để copy mã màu HEX tức thì**
  - Lắng nghe sự kiện `keydown`: nếu `e.key === "c" || e.key === "C"`, sao chép `currentHex` vào clipboard qua `navigator.clipboard.writeText(currentHex)`.
  - Hiển thị badge thông báo nhỏ "Đã chép #HEX!".

- [ ] **Step 4: Kiểm tra biên dịch**
  - Chạy `npm run build` xác minh không có lỗi TypeScript.

---

### Task 3: 1-Click Beautifier Preset (Mockup làm đẹp tức thì) trong Editor

**Files:**
- Modify: `src/routes/editor/Toolbar.tsx`
- Modify: `src/locales/vi/translation.json`
- Modify: `src/locales/en/translation.json`

- [ ] **Step 1: Bổ sung translation key cho Beautify**
  - `editorToolbar.beautify`: "Làm đẹp (Beautify)"
  - `editorToolbar.beautifyHint`: "Tự động bo góc, đổ bóng 3D và phủ nền gradient hiện đại"

- [ ] **Step 2: Thêm nút 1-click Beautify trên Toolbar**
  - Thêm nút `✨ Làm đẹp` bên cạnh nút Background.
  - Khi bấm: Nếu background chưa bật, áp dụng ngay preset `DEFAULT_BACKGROUND_CONFIG` (Sunset / padding 32px / bo góc 12px / shadow medium). Nếu đang bật, xoay vòng qua các gradient đẹp nhất (Sunset → Ocean → Cosmic → Tắt).

- [ ] **Step 3: Kiểm tra biên dịch**
  - Chạy `npm run build` để xác nhận.

---

### Task 4: Command Palette (`Ctrl+K`) Trung tâm điều hướng

**Files:**
- Create: `src/components/CommandPalette.tsx`
- Modify: `src/routes/editor/Editor.tsx`
- Modify: `src/routes/history/HistoryWindow.tsx`
- Modify: `src/locales/vi/translation.json`
- Modify: `src/locales/en/translation.json`

- [ ] **Step 1: Tạo component `CommandPalette.tsx`**
  - Modal overlay mở khi nhấn `Ctrl+K` hoặc `Cmd+K`.
  - Input tìm kiếm tự động focus.
  - Danh sách hành động (Action item: icon, label, shortcut hint, action handler).
  - Hỗ trợ phím mũi tên Lên/Xuống + Enter để kích hoạt, Esc để đóng.

- [ ] **Step 2: Tích hợp `CommandPalette` vào Editor và History**
  - Nhúng `<CommandPalette />` vào `Editor.tsx` và `HistoryWindow.tsx`.

- [ ] **Step 3: Kiểm tra biên dịch & Đóng gói**
  - Chạy `npm run build` và `cargo check`.
  - Đồng bộ đầy đủ các file sang workspace `G:\マイドライブ\project\snapdoc`.
