# SnapDoc Product Upgrades Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Implement Tier-1 product upgrades for SnapDoc: Pin to Screen (Always-On-Top floating note), Smart Empty State with actionable onboarding in History, Optimistic Soft Delete with Toast Undo, and Step Counter Tool for technical documentation.

**Architecture:** 
1. Pinned window (`open_pinned_window` in Rust `windows/mod.rs` + React `src/routes/pin/PinnedWindow.tsx`) creates borderless, always-on-top, draggable, resizable windows with opacity controls.
2. History Empty State (`HistoryEmptyState.tsx`) replaces barren text with SVG illustration, shortcut cards, and 1-click capture CTA.
3. Optimistic Soft Delete in `HistoryWindow.tsx` dispatches UI state removal immediately with a floating Toast bar offering a 5-second Undo action before syncing to SQLite.
4. Auto-incrementing Step Tool in Annotation Stage for seamless sequence documentation.

**Tech Stack:** Tauri 2, Rust (Win32/Cocoa window management), React 19, TypeScript, Zustand, CSS Modules / Inline CSS.

---

### Task 1: Smart Empty State for History Library

**Files:**
- Create: `src/routes/history/HistoryEmptyState.tsx`
- Modify: `src/routes/history/HistoryGrid.tsx`
- Modify: `src/routes/history/HistoryList.tsx`
- Modify: `src/locales/vi/translation.json`
- Modify: `src/locales/en/translation.json`

- [ ] **Step 1: Add translation keys for empty state and onboarding**
  Add keys `history.emptyTitle`, `history.emptyDesc`, `history.captureNow`, `history.shortcutHintTitle` in `vi` and `en`.

- [ ] **Step 2: Create `HistoryEmptyState.tsx` component**
  Design an aesthetic card with camera SVG, title, description, shortcut reference pills, and a primary CTA button that calls `ipc.startQuick()`.

- [ ] **Step 3: Integrate into `HistoryGrid.tsx` and `HistoryList.tsx`**
  Replace `{t("historyView.noCaptures")}` with `<HistoryEmptyState />`.

- [ ] **Step 4: Verify build with `npm run build`**

---

### Task 2: Optimistic Soft Delete & Floating Toast Undo for History

**Files:**
- Modify: `src/routes/history/HistoryWindow.tsx`
- Modify: `src/locales/vi/translation.json`
- Modify: `src/locales/en/translation.json`

- [ ] **Step 1: Add translation keys for Undo Toast**
  Add keys `history.deletedToast` ("Đã chuyển {count} mục vào Thùng rác"), `history.undo` ("Hoàn tác").

- [ ] **Step 2: Implement Undo Toast Banner in `HistoryWindow.tsx`**
  - Add state for pending deleted items and undo timer (5 seconds).
  - When user presses Delete: remove items from store immediately (`removeItems`), show Toast bar at bottom center.
  - If user clicks "Hoàn tác": call `ipc.restoreHistoryItems(ids)` and re-insert into store (`addItem` or `reload()`).
  - If timeout triggers or user performs another action: commit deletion to backend `ipc.deleteHistoryItems(ids)`.

- [ ] **Step 3: Verify build with `npm run build`**

---

### Task 4: Pin to Screen (📌 Ghim ảnh chụp nổi Always-On-Top)

**Files:**
- Create: `src/routes/pin/PinnedWindow.tsx`
- Modify: `src/main.tsx`
- Modify: `src-tauri/src/windows/mod.rs`
- Modify: `src-tauri/src/commands.rs`
- Modify: `src/lib/ipc.ts`
- Modify: `src/routes/history/HistoryPreviewPanel.tsx`
- Modify: `src/routes/editor/Toolbar.tsx`

- [ ] **Step 1: Add Tauri Rust Window Builder for `pin`**
  - In `src-tauri/src/windows/mod.rs`, add `open_pinned_window(app: &AppHandle, image_path: &str, w: f64, h: f64) -> Result<(), String>`.
  - Configure: `always_on_top: true`, `decorations: false`, `transparent: true`, `resizable: true`, `skip_taskbar: false`.
  - In `src-tauri/src/commands.rs`, add `#[tauri::command] pub fn pin_image(app: AppHandle, path: String)`.
  - Register in `src-tauri/src/lib.rs` invoke_handler.

- [ ] **Step 2: Add Route in `src/main.tsx` and IPC binding in `src/lib/ipc.ts`**
  - Add `"pin": () => import("./routes/pin/PinnedWindow")` to `routeLoaders`.
  - Add `pinImage: (path: string) => invoke("pin_image", { path })` to `src/lib/ipc.ts`.

- [ ] **Step 3: Implement `PinnedWindow.tsx` UI**
  - Read image URL from query param `src` or `file`.
  - Full-surface draggable via `data-tauri-drag-region`.
  - Floating toolbar on hover:
    - Opacity buttons: 100%, 75%, 50%, 25%.
    - Copy to clipboard button.
    - Close button (✕).
  - Keyboard shortcuts: `Escape` closes, mouse wheel zooms or resizes.

- [ ] **Step 4: Add "Pin" button in History Preview & Editor Toolbar**
  - Add `[ 📌 Ghim ]` in `HistoryPreviewPanel.tsx`.
  - Add `[ 📌 Ghim ]` in `Toolbar.tsx`.

- [ ] **Step 5: Verify build with `npm run build` and `cargo check`**

---

### Task 5: Packaging & Final Verification

**Files:**
- Check git status across repo.
- Verify `npm run build` passes with 0 errors.
- Run `vitest run` to ensure unit tests pass.
- Build release installers and sync to `dist-installers/`.
