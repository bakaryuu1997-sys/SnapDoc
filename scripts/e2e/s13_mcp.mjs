// E2E thật: MCP server cho AI agent (HTTP + cầu stdio), công tắc quyền ghi, nhật ký,
// xác nhận thao tác phá huỷ bằng hộp thoại gốc, và các đường đưa video vào app.
//
// Cần: bản e2e đang chạy (xem README) với WEBVIEW2 remote-debugging 9333, MCP đang TẮT (mặc định).
// Biến môi trường: E2E_VIDEO (video thử), E2E_EXE (đường dẫn snapdoc.exe của bản e2e, cho test cầu stdio),
// E2E_CONFIG_DIR (mặc định %APPDATA%\com.snapdoc.e2etest). KHÔNG chạm màn hình/camera thật.
import { spawn, spawnSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { attach, report, sleep } from "./cdp.mjs";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const rows = [];
const add = (id, name, ok, note = "") => {
  rows.push({ id, name, ok, note });
  console.log(`${ok ? "PASS" : "FAIL"}  ${id}  ${name}${note ? "  — " + note : ""}`);
};
const VIDEO =
  process.env.E2E_VIDEO ||
  "C:/Users/asus/AppData/Local/Temp/claude/40ef3781ac0a4ad3/8c62e2b3-1416-48c3-9cb1-b6449112eb18/scratchpad/e2e/test_video.mp4";
const EXE = process.env.E2E_EXE;
const CONFIG_DIR = process.env.E2E_CONFIG_DIR || path.join(process.env.APPDATA, "com.snapdoc.e2etest");

// Bản sao video để các thao tác "ghi đè bản gốc" KHÔNG chạm vào file thật của bạn.
const WORK = fs.mkdtempSync(path.join(process.env.TEMP, "snapdoc-e2e-mcp-"));
const COPY = path.join(WORK, "mcp_copy.mp4");
fs.copyFileSync(VIDEO, COPY);

const bar = await attach("capture-bar");

// ───────── 1. Mặc định an toàn + bật server qua giao diện Cài đặt ─────────
await bar.invoke("open_settings", { tab: "agent" });
const st = await attach("settings", 20000);
await sleep(1200);
const sw = (id) => st.eval(`(() => { const e=document.querySelector('[data-testid="${id}"]'); return e ? e.getAttribute('aria-checked') : null; })()`);
add("MCP-01", "Mặc định: server TẮT và quyền ghi TẮT", (await sw("mcp-enable")) === "false" && (await sw("mcp-write")) === "false");
let info = await st.invoke("mcp_get_state");
add("MCP-02", "Chưa bật thì không có cổng nào mở", !info.running);

await st.clickSel('[data-testid="mcp-enable"]');
await sleep(800);
info = await st.invoke("mcp_get_state");
add("MCP-03", "Bật server trong Cài đặt → chạy ở 127.0.0.1 có token 64 ký tự", info.running && /^http:\/\/127\.0\.0\.1:\d+\/mcp$/.test(info.url) && info.token.length === 64, info.url);
await st.shot("s13_01_agent_tab");

// ───────── 2. Client HTTP (đóng vai Claude Code) ─────────
let rpcId = 0;
const call = async (method, params, { token = info.token, headers = {} } = {}) => {
  const res = await fetch(info.url, {
    method: "POST",
    headers: { "Content-Type": "application/json", Accept: "application/json", Authorization: `Bearer ${token}`, "User-Agent": "e2e-client/1.0", ...headers },
    body: JSON.stringify({ jsonrpc: "2.0", id: ++rpcId, method, params }),
  });
  const text = await res.text();
  return { status: res.status, json: text ? JSON.parse(text) : null };
};
const tool = async (name, args = {}) => {
  const r = await call("tools/call", { name, arguments: args });
  const res = r.json?.result;
  const text = res?.content?.find((c) => c.type === "text")?.text ?? "";
  let data = null;
  try { data = JSON.parse(text); } catch {}
  return { rpc: r.json, isError: !!res?.isError, text, data, content: res?.content };
};

add("MCP-04", "Sai token → 401", (await call("ping", {}, { token: "sai" })).status === 401);
const noAuth = await fetch(info.url, { method: "POST", body: "{}" });
add("MCP-05", "Không có token → 401", noAuth.status === 401);
const withOrigin = await fetch(info.url, { method: "POST", headers: { Authorization: `Bearer ${info.token}`, Origin: "https://evil.example" }, body: "{}" });
add("MCP-06", "Có header Origin (trang web) → 403", withOrigin.status === 403);

const init = await call("initialize", { protocolVersion: "2025-06-18", capabilities: {}, clientInfo: { name: "e2e", version: "1" } });
add("MCP-07", "initialize trả serverInfo snapdoc", init.json?.result?.serverInfo?.name === "snapdoc", init.json?.result?.protocolVersion);
const list = await call("tools/list");
const names = (list.json?.result?.tools ?? []).map((t) => t.name);
add("MCP-08", "tools/list có đủ tool đọc + ghi", ["app_status", "list_history", "import_video", "trim_video", "generate_captions", "delete_to_trash"].every((n) => names.includes(n)), `${names.length} tool`);

const status = await tool("app_status");
add("MCP-09", "Tool đọc app_status chạy được khi quyền ghi TẮT", !status.isError && status.data?.writePermission === false, status.data?.version);
const lh = await tool("list_history", { limit: 5 });
add("MCP-10", "Tool đọc list_history chạy được", !lh.isError && Array.isArray(lh.data?.items));

const denied = await tool("import_video", { path: COPY });
add("MCP-11", "Quyền ghi TẮT → import_video bị từ chối với thông báo rõ", denied.isError && /TẮT/.test(denied.text) && /Cài đặt/.test(denied.text), denied.text.slice(0, 80));
const unknown = await call("tools/call", { name: "permanently_delete_item", arguments: { id: "x" } });
add("MCP-12", "Tool xoá vĩnh viễn KHÔNG tồn tại trên MCP", !!unknown.json?.error);

// ───────── 3. Bật quyền ghi qua giao diện (có hộp xác nhận) ─────────
await st.clickSel('[data-testid="mcp-write"]');
await sleep(500);
const confirmShown = await st.eval(`!!document.querySelector('[data-testid="mcp-write-confirm"]')`);
add("MCP-13", "Bật quyền ghi → hiện hộp xác nhận, CHƯA bật ngay", confirmShown && (await sw("mcp-write")) === "false");
await st.shot("s13_02_write_confirm");
await st.clickSel('[data-testid="mcp-write-confirm-yes"]');
await sleep(800);
info = await st.invoke("mcp_get_state");
add("MCP-14", "Xác nhận → quyền ghi BẬT (áp dụng ngay, không cần kết nối lại)", info.writeEnabled === true && (await sw("mcp-write")) === "true");

// ───────── 4. Công cụ ghi thật trên video thật ─────────
const imp = await tool("import_video", { path: COPY });
const itemId = imp.data?.item?.id;
add("MCP-15", "import_video thêm video vào Thư viện", !imp.isError && !!itemId && imp.data.item.mediaType === "video", imp.text.slice(0, 100));
const dur = imp.data?.item?.durationMs ?? 0;

const got = await tool("get_item", { id: itemId });
add("MCP-16", "get_item đọc lại đúng mục vừa nhập", got.data?.id === itemId);
const prev = await tool("get_preview", { id: itemId });
add("MCP-17", "get_preview trả ảnh (image content)", prev.content?.some((c) => c.type === "image" && c.data?.length > 100));

const ren = await tool("rename_item", { id: itemId, title: "E2E MCP clip" });
add("MCP-18", "rename_item đổi tên", ren.data?.title === "E2E MCP clip");

const trim = await tool("trim_video", { id: itemId, keepRanges: [[0, 1500]] });
let trimmedId = trim.data?.item?.id;
if (!trimmedId && trim.data?.jobId) {
  const j = await tool("get_job", { jobId: trim.data.jobId, waitSeconds: 40 });
  trimmedId = j.data?.result?.item?.id;
}
add("MCP-19", "trim_video tạo bản MỚI, bản gốc nguyên vẹn", !!trimmedId && trimmedId !== itemId && fs.existsSync(COPY), `dur gốc ${dur}ms`);
const trimmed = await tool("get_item", { id: trimmedId });
add("MCP-20", "Bản cắt dài ≈1.5s", Math.abs((trimmed.data?.durationMs ?? 0) - 1500) < 400, `${trimmed.data?.durationMs}ms`);
const outFile = trimmed.data?.assetPath;
add("MCP-21", "File bản cắt tồn tại trên đĩa", !!outFile && fs.existsSync(outFile) && fs.statSync(outFile).size > 1000);

const spd = await tool("change_speed", { id: itemId, speed: 2 });
let spdId = spd.data?.item?.id ?? (spd.data?.jobId ? (await tool("get_job", { jobId: spd.data.jobId, waitSeconds: 40 })).data?.result?.item?.id : null);
const spdItem = spdId ? (await tool("get_item", { id: spdId })).data : null;
add("MCP-22", "change_speed x2 → thời lượng ≈ một nửa", !!spdItem && Math.abs(spdItem.durationMs - dur / 2) < 700, `${spdItem?.durationMs}ms vs ${dur}ms`);

const crop = await tool("crop_video", { id: itemId, x: 0, y: 0, width: 320, height: 180 });
let cropId = crop.data?.item?.id ?? (crop.data?.jobId ? (await tool("get_job", { jobId: crop.data.jobId, waitSeconds: 40 })).data?.result?.item?.id : null);
const cropItem = cropId ? (await tool("get_item", { id: cropId })).data : null;
add("MCP-23", "crop_video → kích thước 320×180", cropItem?.width === 320 && cropItem?.height === 180, `${cropItem?.width}x${cropItem?.height}`);

const badRange = await tool("trim_video", { id: itemId, keepRanges: [[5000, 100]] });
add("MCP-24", "Tham số sai (start>end) → lỗi rõ ràng, không chạy ffmpeg", badRange.isError && /keepRanges/.test(badRange.text));
const badOut = await tool("trim_video", { id: itemId, keepRanges: [[0, 500]], outputPath: "C:\\Windows\\System32\\evil.mp4" });
add("MCP-25", "outputPath ngoài thư mục cho phép bị chặn", badOut.isError && /outputPath/.test(badOut.text), badOut.text.slice(0, 90));

const cap = await tool("generate_captions", { id: itemId });
add("MCP-26", "generate_captions khi chưa cài engine → lỗi hướng dẫn rõ (không treo)", cap.isError || /error|Chưa cài/i.test(cap.text), cap.text.slice(0, 90));
const cs = await tool("captions_status");
add("MCP-27", "captions_status đọc được", !cs.isError && cs.data?.status && "supported" in cs.data.status);

// ───────── 5. Thao tác phá huỷ phải được người dùng xác nhận trong app ─────────
const DIALOG = "SnapDoc — AI agent xin xác nhận";
const clickDialog = (button) =>
  new Promise((resolve) => {
    const p = spawn("powershell", ["-NoProfile", "-ExecutionPolicy", "Bypass", "-File", path.join(HERE, "click_dialog.ps1"), "-Button", button, "-TimeoutSec", "40"], { env: { ...process.env, E2E_DIALOG_TITLE: DIALOG } });
    let out = "";
    p.stdout.on("data", (d) => (out += d));
    p.on("close", () => resolve(out.trim()));
  });

let pending = tool("delete_to_trash", { id: cropId });
let clicked = await clickDialog("Cancel");
const del1 = await pending;
add("MCP-28", "delete_to_trash + người dùng TỪ CHỐI → không xoá", clicked === "clicked" && del1.isError && /TỪ CHỐI/.test(del1.text) && (await tool("get_item", { id: cropId })).data?.deletedAt == null, clicked);

pending = tool("delete_to_trash", { id: cropId });
clicked = await clickDialog("OK");
const del2 = await pending;
add("MCP-29", "delete_to_trash + người dùng CHO PHÉP → vào Thùng rác", clicked === "clicked" && !del2.isError && (await tool("get_item", { id: cropId })).data?.deletedAt != null, `${clicked} ${del2.text.slice(0, 120)}`);
const res = await tool("restore_item", { id: cropId });
add("MCP-30", "restore_item khôi phục từ Thùng rác", !res.isError && (await tool("get_item", { id: cropId })).data?.deletedAt == null);

// Ghi đè bản gốc (chỉ trên bản sao trong thư mục tạm) cũng phải xin phép
const sizeBefore = fs.statSync(COPY).size;
pending = tool("trim_video", { id: itemId, keepRanges: [[0, 1000]], replaceOriginal: true });
clicked = await clickDialog("Cancel");
const ov1 = await pending;
add("MCP-31", "replaceOriginal bị TỪ CHỐI → file gốc không đổi", clicked === "clicked" && ov1.isError && fs.statSync(COPY).size === sizeBefore, `${clicked} ${ov1.isError} ${ov1.text.slice(0, 120)} ${fs.statSync(COPY).size}/${sizeBefore}`);
pending = tool("trim_video", { id: itemId, keepRanges: [[0, 1000]], replaceOriginal: true });
clicked = await clickDialog("OK");
let ov2 = await pending;
if (ov2.data?.jobId) ov2 = { ...ov2, data: (await tool("get_job", { jobId: ov2.data.jobId, waitSeconds: 40 })).data?.result };
add("MCP-32", "replaceOriginal được CHO PHÉP → file gốc (bản sao) bị thay", clicked === "clicked" && !ov2.isError && fs.statSync(COPY).size !== sizeBefore, `${sizeBefore} → ${fs.statSync(COPY).size}`);

// ───────── 6. Nhật ký ─────────
const log = await st.invoke("mcp_audit_list", { limit: 300 });
const has = (tool, outcome) => log.some((e) => e.tool === tool && e.outcome === outcome);
add("MCP-33", "Nhật ký ghi đủ: ok / denied / error", has("import_video", "denied") && has("import_video", "ok") && has("trim_video", "error") && has("delete_to_trash", "denied") && has("delete_to_trash", "ok"));
add("MCP-34", "Nhật ký có tên client + tham số rút gọn + thời gian", log.some((e) => e.client === "e2e-client" && e.args.includes("keepRanges") && e.durationMs >= 0 && e.ts > 0));
add("MCP-35", "Nhật ký ghi cả việc đổi công tắc & truy cập sai token", log.some((e) => e.tool === "write_permission_on") && log.some((e) => e.tool === "(auth)" && e.outcome === "denied"));
const al = await tool("get_activity_log", { limit: 5 });
add("MCP-36", "Agent đọc được nhật ký (get_activity_log) nhưng không có tool xoá/sửa", !al.isError && al.data?.entries?.length > 0 && !names.some((n) => /clear|delete_log|audit/i.test(n)));
await st.eval(`document.querySelector('[data-testid="tab-agent"]')?.click()`);
await sleep(600);
const uiText = await st.eval(`document.querySelector('[data-testid="mcp-log"]')?.innerText ?? ''`);
add("MCP-37", "Giao diện Cài đặt hiển thị nhật ký (tool + kết quả)", /trim_video/.test(uiText) && /denied/.test(uiText) && /delete_to_trash/.test(uiText));
await st.shot("s13_03_audit_log");

// ───────── 7. Tắt quyền ghi → có hiệu lực ngay ─────────
await st.clickSel('[data-testid="mcp-write"]');
await sleep(600);
info = await st.invoke("mcp_get_state");
const after = await tool("rename_item", { id: itemId, title: "x" });
add("MCP-38", "Tắt quyền ghi → tool ghi bị từ chối ngay (cùng kết nối)", info.writeEnabled === false && after.isError && /TẮT/.test(after.text));

// ───────── 8. Cầu stdio (đóng vai Claude Desktop) ─────────
if (EXE) {
  const child = spawn(EXE, ["--mcp-stdio", "--config-dir", CONFIG_DIR], { stdio: ["pipe", "pipe", "pipe"] });
  const lines = [];
  let buf = "";
  child.stdout.on("data", (d) => {
    buf += d;
    let i;
    while ((i = buf.indexOf("\n")) >= 0) {
      lines.push(buf.slice(0, i));
      buf = buf.slice(i + 1);
    }
  });
  const send = (o) => child.stdin.write(JSON.stringify(o) + "\n");
  const waitLines = async (n) => {
    for (let i = 0; i < 100 && lines.length < n; i++) await sleep(100);
  };
  send({ jsonrpc: "2.0", id: 1, method: "initialize", params: { protocolVersion: "2025-06-18", capabilities: {}, clientInfo: { name: "stdio-e2e", version: "1" } } });
  send({ jsonrpc: "2.0", method: "notifications/initialized" });
  send({ jsonrpc: "2.0", id: 2, method: "tools/call", params: { name: "app_status", arguments: {} } });
  await waitLines(2);
  const r1 = JSON.parse(lines[0] ?? "{}");
  const r2 = JSON.parse(lines[1] ?? "{}");
  add("MCP-39", "Cầu stdio: initialize + gọi tool app_status qua `snapdoc.exe --mcp-stdio`", r1.result?.serverInfo?.name === "snapdoc" && r2.result?.isError === false && lines.length === 2, `${lines.length} dòng`);
  child.stdin.end();
  await sleep(300);
  child.kill();
} else {
  add("MCP-39", "Cầu stdio (bỏ qua: chưa đặt E2E_EXE)", true, "SKIP");
}

// ───────── 9. Tắt server ─────────
await st.clickSel('[data-testid="mcp-enable"]');
await sleep(1200);
info = await st.invoke("mcp_get_state");
let refused = false;
try {
  await fetch(info.url, { method: "POST", body: "{}", signal: AbortSignal.timeout(2000) });
} catch {
  refused = true;
}
add("MCP-40", "Tắt server → cổng đóng, không còn nhận kết nối", !info.running && refused, `running=${info.running} refused=${refused}`);

// ───────── 10. Đưa video vào app: menu, palette, kéo-thả ─────────
const pop = await attach("capture-bar-popover").catch(() => null);
if (pop) {
  const t = await pop.text();
  add("IMP-01", "Menu Tuỳ chọn của Capture Bar có mục 'Mở video…'", /Mở video/.test(t));
} else {
  await bar.invoke("toggle_capture_bar_popover").catch(() => {});
  const p2 = await attach("capture-bar-popover", 8000).catch(() => null);
  add("IMP-01", "Menu Tuỳ chọn của Capture Bar có mục 'Mở video…'", !!p2 && /Mở video/.test(await p2.text()));
  await bar.invoke("hide_capture_bar_popover").catch(() => {});
}

await bar.invoke("open_history");
const h = await attach("history", 20000);
await sleep(1500);
await h.key("k", { modifiers: 2, code: "KeyK", vk: 75 });
await sleep(500);
const entries = await h.text();
add("IMP-02", "Command Palette (Ctrl+K) có 'Mở video từ máy…'", /Mở video từ máy/.test(entries));
await h.eval(`(() => { const i=document.querySelector('[role="dialog"] input'); i.focus(); return true; })()`);
await h.type(`"${COPY.replace(/\//g, "\\")}"`);
await sleep(500);
add("IMP-03", "Dán đường dẫn video (có ngoặc kép) vào palette → mục 'Mở video đã dán'", /Mở video đã dán/.test(await h.text()));
await h.key("Escape");

// Kéo-thả: phát đúng sự kiện mà Tauri gửi khi thả file từ Explorer lên cửa sổ.
const before = (await h.invoke("list_history", { filter: { limit: 100, offset: 0, trashOnly: false } })).total;
await h.eval(`window.__TAURI_INTERNALS__.invoke('plugin:event|emit', { event: 'tauri://drag-drop', payload: { paths: [${JSON.stringify(COPY)}], position: { x: 10, y: 10 } } })`);
await sleep(6000);
const eds = await attach("editor", 15000).catch(() => null);
add("IMP-04", "Thả video vào cửa sổ Thư viện → mở trong Editor", !!eds);
if (eds) {
  await sleep(2500);
  add("IMP-05", "Editor hiển thị video vừa thả", await eds.eval(`!!document.querySelector('video')`));
  await eds.shot("s13_04_dropped_video");
}
await bar.eval(`true`);
const dropBar = await attach("capture-bar");
await dropBar.eval(`window.__TAURI_INTERNALS__.invoke('plugin:event|emit', { event: 'tauri://drag-over', payload: { paths: [${JSON.stringify(COPY)}], position: { x: 5, y: 5 } } })`);
await sleep(400);
add("IMP-06", "Kéo video lên Capture Bar → hiện gợi ý 'Thả video…'", /Thả video/.test(await dropBar.text()));
await dropBar.eval(`window.__TAURI_INTERNALS__.invoke('plugin:event|emit', { event: 'tauri://drag-leave', payload: {} })`);

console.log("\n==== TỔNG KẾT ====");
report(rows);
const failed = rows.filter((r) => !r.ok);
console.log(`\n${rows.length - failed.length}/${rows.length} PASS`);
fs.rmSync(WORK, { recursive: true, force: true });
process.exit(failed.length ? 1 : 0);
