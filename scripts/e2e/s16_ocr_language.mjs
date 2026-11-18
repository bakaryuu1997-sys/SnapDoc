import { attach, report, sleep } from "./cdp.mjs";

const rows = [];
const add = (id, name, ok, note = "") => rows.push({ id, name, ok, note });

try {
  // ── Capture Bar ──
  const bar = await attach("capture-bar");
  await bar.invoke("open_capture_bar");
  await sleep(1000);

  // 1. Kiểm tra menu CaptureBarPopover có section "NGÔN NGỮ OCR"
  // Click nút menu (ba chấm hoặc popover trigger)
  await bar.clickSel('button[aria-label="Tùy chọn"], button[title="Tùy chọn"], button:has(svg.lucide-ellipsis), button:has(svg.lucide-more-horizontal)');
  await sleep(500);

  const popoverText = await bar.text();
  const hasOcrSection = /NGÔN NGỮ OCR|OCR LANGUAGE/i.test(popoverText);
  add("OCR-01a", "Menu Capture Bar có section NGÔN NGỮ OCR", hasOcrSection, popoverText.slice(0, 100));

  // Kiểm tra 5 tùy chọn: Tự động, Tiếng Việt, 日本語, 中文, English
  const hasAuto = /Tự động|Auto/i.test(popoverText);
  const hasJa = /日本語/i.test(popoverText);
  const hasVi = /Tiếng Việt/i.test(popoverText);
  add("OCR-01b", "Menu có đủ các ngôn ngữ (Tự động, Tiếng Việt, 日本語...)", hasAuto && hasJa && hasVi);

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

} catch (err) {
  add("OCR-ERR", "Kịch bản s16 gặp lỗi runtime", false, String(err));
}

report("s16_ocr_language", rows);
