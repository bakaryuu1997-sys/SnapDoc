import { listWindows, attach, report, sleep } from "./cdp.mjs";

const rows = [];
const add = (id, name, ok, note = "") => rows.push({ id, name, ok, note });

const wins = await listWindows();
console.log("Cửa sổ (webview) khi khởi động:", wins.map((w) => w.win).join(", "));
add("ST-01a", "App khởi động và hiện các webview prewarm", wins.length >= 1, `${wins.length} webview`);
add("ST-01b", "Có cửa sổ capture-bar", wins.some((w) => w.win === "capture-bar"));

// Cập nhật tự động đã bị vô hiệu hoá: không có bản cập nhật nào, không gọi mạng tới upstream.
const bar = await attach("capture-bar");
const upd = await bar.invoke("check_update", { manual: true }).catch((e) => ({ error: String(e) }));
add("ST-11", "Updater của tác giả gốc bị vô hiệu hoá (check_update không có bản mới)", upd && upd.available === false, JSON.stringify(upd));
const pend = await bar.invoke("get_pending_update").catch((e) => ({ error: String(e) }));
add("ST-11b", "Không có bản cập nhật chờ cài", pend === null, JSON.stringify(pend));

// Cấu hình cô lập đã nạp đúng.
const s = await bar.invoke("get_settings");
add("ST-01c", "Nạp settings cô lập (autostart tắt, saveDir tạm)", s.launchAtLogin === false && /saves$/.test(s.saveDir), `launchAtLogin=${s.launchAtLogin}`);
const warn = await bar.invoke("get_hotkey_warning");
add("ST-01d", "Phím tắt toàn cục đăng ký không xung đột", warn === null, String(warn));

await bar.shot("01_capture_bar_hidden_state");
console.log("console:", bar.console.slice(0, 10));
bar.close();
report(rows);
