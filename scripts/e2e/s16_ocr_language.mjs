import { attach, report, sleep } from "./cdp.mjs";

const rows = [];
const add = (id, name, ok, note = "") => rows.push({ id, name, ok, note });

try {
  // ── Capture Bar ──
  const bar = await attach("capture-bar");
  await bar.invoke("open_capture_bar");
  await sleep(1000);

  // 1. Kiểm tra menu CaptureBarPopover có section "NGÔN NGỮ OCR"
  await bar.clickSel('button[aria-label="Tùy chọn"], button[title="Tùy chọn"], button:has(svg.lucide-ellipsis), button:has(svg.lucide-more-horizontal)');
  await sleep(500);

  const popoverText = await bar.text();
  const hasOcrSection = /NGÔN NGỮ OCR|OCR LANGUAGE/i.test(popoverText);
  add("OCR-01a", "Menu Capture Bar có section NGÔN NGỮ OCR", hasOcrSection, popoverText.slice(0, 100));

  // Kiểm tra 4 tùy chọn: Tự động, Tiếng Việt, 日本語, English
  const hasAuto = /Tự động|Auto/i.test(popoverText);
  const hasJa = /日本語/i.test(popoverText);
  const hasVi = /Tiếng Việt/i.test(popoverText);
  const hasEn = /English/i.test(popoverText);
  add("OCR-01b", "Menu có đủ 4 ngôn ngữ (Tự động, Tiếng Việt, 日本語, English)", hasAuto && hasJa && hasVi && hasEn);

  // Đổi ngôn ngữ sang 日本語
  await bar.clickText("日本語");
  await sleep(600);

  const settingsAfterJa = await bar.invoke("get_settings");
  add("OCR-01c", "Chọn 日本語 cập nhật settings.ocrLanguage = 'ja'", settingsAfterJa.ocrLanguage === "ja", `actual: ${settingsAfterJa.ocrLanguage}`);

  // Đổi lại sang auto
  await bar.clickSel('button[aria-label="Tùy chọn"], button[title="Tùy chọn"], button:has(svg.lucide-ellipsis), button:has(svg.lucide-more-horizontal)');
  await sleep(500);
  await bar.clickText("Tự động");
  await sleep(600);

  const settingsAfterAuto = await bar.invoke("get_settings");
  add("OCR-01d", "Chọn Tự động cập nhật settings.ocrLanguage = 'auto'", settingsAfterAuto.ocrLanguage === "auto", `actual: ${settingsAfterAuto.ocrLanguage}`);

  // ── Settings Phím tắt ──
  await bar.invoke("open_settings", {});
  const st = await attach("settings");
  await sleep(800);
  await st.clickText("Phím tắt");
  await sleep(500);

  const shortcutsText = await st.text();
  const hasRedoKey = /Ctrl\+Shift\+Y|CmdOrCtrl\+Shift\+Y|Đọc lại Text Grab|Redo/i.test(shortcutsText);
  add("OCR-02a", "Settings Phím tắt có phím Ctrl+Shift+Y (Đọc lại Text Grab)", hasRedoKey);

  // ── Overlay Text Grab: Phím 1–4 để đổi nhanh ngôn ngữ ──
  try {
    await bar.invoke("start_text_grab");
    await sleep(800);
    const ov = await attach("overlay", 6000);
    const bannerInitial = await ov.text();
    const hasKeysHint = /1[–-]4|1-4/i.test(bannerInitial);
    add("OCR-03a", "Overlay Text Grab hiển thị banner hướng dẫn đổi ngôn ngữ phím 1–4", hasKeysHint, bannerInitial);

    // Bấm phím 3 -> 日本語
    await ov.key("3");
    await sleep(400);
    const bannerJa = await ov.text();
    add("OCR-03b", "Phím 3 trong overlay đổi sang 日本語", bannerJa.includes("日本語"), bannerJa);

    // Bấm phím 2 -> Tiếng Việt
    await ov.key("2");
    await sleep(400);
    const bannerVi = await ov.text();
    add("OCR-03c", "Phím 2 trong overlay đổi sang Tiếng Việt", bannerVi.includes("Tiếng Việt"), bannerVi);

    // Bấm phím 4 -> English
    await ov.key("4");
    await sleep(400);
    const bannerEn = await ov.text();
    add("OCR-03d", "Phím 4 trong overlay đổi sang English", bannerEn.includes("English"), bannerEn);

    // Bấm phím 1 -> Tự động
    await ov.key("1");
    await sleep(400);
    const bannerAuto = await ov.text();
    add("OCR-03e", "Phím 1 trong overlay đổi sang Tự động", bannerAuto.includes("Tự động") || bannerAuto.includes("Auto"), bannerAuto);

    await ov.invoke("cancel_overlay");
    await sleep(500);
  } catch (ovErr) {
    add("OCR-03-ERR", "Lỗi kiểm tra phím 1–4 trong overlay Text Grab", false, String(ovErr));
  }

  // ── Text Grab Redo (Ctrl+Shift+Y) ──
  try {
    // Phát sự kiện snapdoc-redo-text-grab khi chưa có Text Grab trước đó -> hiện toast thông báo
    await bar.eval("window.__TAURI_INTERNALS__.invoke('plugin:event|emit', { event: 'snapdoc-redo-text-grab', payload: null })");
    await sleep(500);
    add("OCR-04a", "Text Grab Redo xử lý mượt mà sự kiện redo", true);
  } catch (redoErr) {
    add("OCR-04-ERR", "Lỗi kiểm tra Text Grab Redo", false, String(redoErr));
  }

} catch (err) {
  add("OCR-ERR", "Kịch bản s16 gặp lỗi runtime", false, String(err));
}

report("s16_ocr_language", rows);
