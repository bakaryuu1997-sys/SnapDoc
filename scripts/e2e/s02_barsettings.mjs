import { listWindows, attach, report, sleep } from "./cdp.mjs";

const rows = [];
const add = (id, name, ok, note = "") => rows.push({ id, name, ok, note });

// ── Capture Bar ──
const bar = await attach("capture-bar");
await bar.invoke("open_capture_bar");
await sleep(1200);
await bar.shot("02_capture_bar");
const barText = await bar.text();
const buttons = await bar.eval(`[...document.querySelectorAll('button')].map(b => (b.title || b.getAttribute('aria-label') || b.textContent || '').trim()).filter(Boolean)`);
console.log("Capture bar — nút:", buttons.join(" | "));
console.log("Capture bar — chữ:", barText.replace(/\s+/g, " ").slice(0, 300));
add("ST-02a", "Capture Bar hiển thị với các nút chế độ", buttons.length >= 6, `${buttons.length} nút`);
add("ST-02b", "Không lỗi console khi mở Capture Bar", bar.console.filter((c) => /EXCEPTION|error/i.test(c)).length === 0, bar.console.slice(0, 3).join(" ; "));
const vp = await bar.viewport();
console.log("viewport:", vp);

// ── Settings ──
await bar.invoke("open_settings", {});
const st = await attach("settings");
await sleep(1000);
await st.shot("03_settings_general");
const tabs = await st.eval(`[...document.querySelectorAll('button')].map(b => b.textContent.trim()).filter(t => /Chung|Phím tắt|Quay video|Quyền hạn|Chia sẻ/.test(t))`);
console.log("Settings — tab:", tabs.join(" | "));
add("ST-03a", "Settings có đủ 5 tab (Chung, Phím tắt, Quay video, Quyền hạn, Chia sẻ)", tabs.length === 5, tabs.join(", "));

// Tab Phím tắt
await st.clickText("Phím tắt");
await sleep(500);
await st.shot("03b_settings_shortcuts");
const shortcutsText = await st.text();
add("ST-03b", "Tab Phím tắt liệt kê phím (và phím Text Grab có thể đổi?)", /Chụp/.test(shortcutsText), /Text|OCR|chữ/i.test(shortcutsText) ? "có mục OCR/Text Grab" : "KHÔNG có mục Text Grab/OCR trong danh sách phím tắt");

// Tab Quay video
await st.clickText("Quay video");
await sleep(500);
await st.shot("03c_settings_recording");

// Tab Chia sẻ (Google Drive)
await st.clickText("Chia sẻ");
await sleep(700);
await st.shot("03d_settings_cloud");
let cloudText = await st.text();
add("ST-03c", "Tab Chia sẻ hiển thị Google Drive + trạng thái chưa kết nối", /Google Drive/.test(cloudText) && /Kết nối Google Drive/.test(cloudText));
// Nút kết nối bị vô hiệu khi chưa nhập Client ID/Secret
const disabled = await st.eval(`(() => { const b=[...document.querySelectorAll('button')].find(x=>x.textContent.includes('Kết nối Google Drive')); return b ? b.disabled : null; })()`);
add("ST-03d", "Nút 'Kết nối Google Drive' bị khoá khi chưa có Client ID/Secret", disabled === true, `disabled=${disabled}`);
// Mở hướng dẫn
await st.clickText("Hướng dẫn lấy Client ID");
await sleep(400);
await st.shot("03e_settings_cloud_guide");
cloudText = await st.text();
add("ST-03e", "Hướng dẫn lấy Client ID mở ra đủ 5 bước", /Google Drive API/.test(cloudText) && /Desktop app/.test(cloudText));

// Điền Client ID/Secret giả → nút bật, KHÔNG bấm kết nối (không gọi Google)
const inputs = await st.eval(`[...document.querySelectorAll('input')].map(i=>({ph:i.placeholder,type:i.type}))`);
console.log("Inputs:", JSON.stringify(inputs));
await st.clickSel('input[placeholder*="apps.googleusercontent.com"]');
await st.type("e2e-test-id.apps.googleusercontent.com");
await st.clickSel('input[placeholder*="GOCSPX"]');
await st.type("GOCSPX-e2e-test-secret");
await sleep(800);
const enabled = await st.eval(`(() => { const b=[...document.querySelectorAll('button')].find(x=>x.textContent.includes('Kết nối Google Drive')); return b ? !b.disabled : null; })()`);
add("ST-03f", "Điền Client ID/Secret → nút kết nối được bật", enabled === true);
// Lưu bền: settings.json đã ghi Client ID?
await sleep(1200);
const saved = await st.invoke("get_settings");
add("ST-03g", "Client ID/Secret được lưu vào settings", saved.driveClientId === "e2e-test-id.apps.googleusercontent.com", `driveClientId=${saved.driveClientId}`);
// Trạng thái Drive trước khi kết nối
add("ST-10a", "drive_is_connected = false khi chưa kết nối", (await st.invoke("drive_is_connected")) === false);

// Tab Quyền hạn + Chung (chuyển lại)
await st.clickText("Quyền hạn");
await sleep(500);
await st.shot("03f_settings_permissions");
await st.clickText("Chung");
await sleep(500);
const generalText = await st.text();
add("ST-03h", "Tab Chung có mục lưu file / hành vi mặc định / cập nhật", /LƯU FILE|Thư mục lưu/.test(generalText));
console.log("settings console:", st.console.filter((c) => /EXCEPTION|error/i.test(c)).slice(0, 5));

bar.close();
st.close();
report(rows);
