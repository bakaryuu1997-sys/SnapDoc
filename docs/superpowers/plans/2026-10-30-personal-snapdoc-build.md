# Personal SnapDoc Build & Optimization Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Hoàn thiện và đóng gói bản SnapDoc cá nhân tối ưu trên Windows, đồng bộ phiên bản `3.8.4`, bổ sung test suite tự động cho frontend (Vitest), bảo vệ an toàn state IPC chống mất dữ liệu khi remount, và đảm bảo build sạch 100%.

**Architecture:** Giữ nguyên kiến trúc Tauri v2 (Rust backend) + React 19 + TypeScript + Vite + Zustand + Konva + FFmpeg sidecar. Bổ sung Vitest cho kiểm thử tự động tầng logic frontend, đồng bộ hóa 3 file manifest (`package.json`, `Cargo.toml`, `tauri.conf.json`), tăng cường tính an toàn cho Rust state lifecycle và bảo đảm quy trình build sạch 100%.

**Tech Stack:** Rust, Tauri v2, React 19, TypeScript, Vite, Vitest, Zustand, Konva, FFmpeg, Windows Win32 API.

---

## Danh Sách File Liên Quan

| Phân loại | Đường dẫn file | Mục đích |
|---|---|---|
| **Manifests** | `package.json` | Đồng bộ version `3.8.4`, thêm script `test`, thêm `vitest` |
| **Manifests** | `src-tauri/Cargo.toml` | Đồng bộ version `3.8.4` |
| **Manifests** | `src-tauri/tauri.conf.json` | Đồng bộ version `3.8.4` |
| **Config** | `vite.config.ts` | Thêm cấu hình Vitest test runner |
| **Tests** | `src/features/video-trim/segments.test.ts` | Unit test cho logic cắt ghép timeline & keep ranges |
| **Tests** | `src/features/video-trim/mouseFocusEngine.test.ts` | Unit test cho thuật toán phân vùng Smart Focus & Camera |
| **IPC & State** | `src-tauri/src/state.rs` | Thêm cache lưu giữ capture gần nhất phòng ngừa remount |
| **IPC & State** | `src-tauri/src/commands.rs` | Bổ sung fallback phục hồi capture cho `take_pending` |

---

### Task 1: Đồng bộ Phiên bản Cá nhân & Cài đặt Môi trường

**Files:**
- Modify: `package.json`
- Modify: `src-tauri/Cargo.toml`
- Modify: `src-tauri/tauri.conf.json`

- [ ] **Step 1: Đồng bộ version lên 3.8.4 trong cả 3 manifests**
  - Cập nhật `package.json`: `"version": "3.8.4"`
  - Cập nhật `src-tauri/Cargo.toml`: `version = "3.8.4"`
  - Cập nhật `src-tauri/tauri.conf.json`: `"version": "3.8.4"`

- [ ] **Step 2: Cài đặt dependencies qua npm**
  - Chạy: `npm install`
  - Đảm bảo `node_modules` được cài đặt đầy đủ.

- [ ] **Step 3: Chạy script chuẩn bị binary FFmpeg cho Windows**
  - Chạy: `node scripts/fetch-ffmpeg.mjs`
  - Kiểm tra file `src-tauri/binaries/ffmpeg-x86_64-pc-windows-msvc.exe` được tải về sẵn sàng.

---

### Task 2: Thiết lập Vitest & Viết Unit Tests Cho Frontend

**Files:**
- Modify: `package.json`
- Modify: `vite.config.ts`
- Create: `src/features/video-trim/segments.test.ts`
- Create: `src/features/video-trim/mouseFocusEngine.test.ts`

- [ ] **Step 1: Cài đặt Vitest vào devDependencies**
  - Chạy: `npm install -D vitest`

- [ ] **Step 2: Cấu hình Vitest trong `vite.config.ts` và thêm script `test`**
  - Thêm config reference `/// <reference types="vitest" />` và block `test: { globals: true, environment: "node" }`.
  - Cập nhật `package.json`: thêm `"test": "vitest run"`.

- [ ] **Step 3: Viết Unit Test cho `segments.ts`**
  - Test case:
    1. `initialSegments(durationMs)` khởi tạo đúng segment duy nhất.
    2. `splitSegmentAt()` chia đúng 1 segment thành 2 segments hợp lệ.
    3. `deleteSegment()` đánh dấu đoạn bị xóa và `computeKeepRanges()` tính đúng các khoảng giữ lại cho FFmpeg.
    4. `trimHead()` và `trimTail()` cắt đúng đầu/đuôi mà không vi phạm `MIN_SEG_MS`.

- [ ] **Step 4: Viết Unit Test cho `mouseFocusEngine.ts`**
  - Test case:
    1. `detectFocusZone()` trả về `"center"` khi toạ độ nằm trong vùng deadband trung tâm.
    2. `detectFocusZone()` trả về `"left"` / `"right"` / `"top"` / `"bottom"` chính xác.
    3. `calculateSmartFocusPoint()` khoá cứng tâm (0.5, 0.5) khi ở center zone để tránh rung giật camera.

- [ ] **Step 5: Chạy test suite và kiểm tra kết quả**
  - Chạy: `npm test`
  - Kết quả mong đợi: Toàn bộ test cases PASS 100%.

---

### Task 3: Tối ưu An Toàn State IPC (`take_pending` Failsafe)

**Files:**
- Modify: `src-tauri/src/state.rs`
- Modify: `src-tauri/src/commands.rs`

- [ ] **Step 1: Thêm `last_capture` cache vào `AppState`**
  - Trong `src-tauri/src/state.rs`, thêm trường `pub last_capture: Mutex<Option<PendingCapture>>`.
  - Khi lưu `pending`, đồng thời cập nhật `last_capture`.

- [ ] **Step 2: Bổ sung logic khôi phục an toàn trong `take_pending`**
  - Nếu `pending.take()` trả về `None`, nhưng `last_capture` có dữ liệu (trong vòng 5 giây gần nhất), cung cấp dữ liệu phục hồi thay vì trả về rỗng để phòng ngừa trường hợp component bị unmount/remount ngoài ý muốn.

---

### Task 4: Kiểm tra Toàn Diện & Build Thử Nghiệm

**Files:**
- Verify: Toàn bộ codebase

- [ ] **Step 1: Kiểm tra build TypeScript & Vite**
  - Chạy: `npm run build`
  - Đảm bảo `tsc --noEmit && vite build` hoàn thành với exit code 0, không có lỗi kiểu (type errors).

- [ ] **Step 2: Kiểm tra biên dịch Rust Backend**
  - Chạy: `cargo check --manifest-path src-tauri/Cargo.toml`
  - Đảm bảo mã nguồn Rust biên dịch sạch sẽ không có lỗi.

- [ ] **Step 3: Chạy test suite Rust**
  - Chạy: `cargo test --manifest-path src-tauri/Cargo.toml`
  - Đảm bảo toàn bộ ~65 test cases của backend tiếp tục PASS.
