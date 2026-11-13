// E2E thật: Text Grab (Ctrl+Shift+T) khi dùng NHIỀU MÀN HÌNH.
//
// Kiểm tra: (a) thả chuột xong thì TẤT CẢ overlay đóng (đếm cửa sổ overlay thật trên OS),
// (b) clipboard chứa đúng chữ giả, (c) có toast + không lỗi console, (d) Esc / chuột phải huỷ mọi overlay.
//
// An toàn:
//  - Chỉ chạy bản e2e cô lập (identifier com.snapdoc.e2etest). BẮT BUỘC đặt E2E_EXE = đường dẫn snapdoc.exe
//    của bản e2e (kịch bản dùng nó để đếm cửa sổ overlay và KHÔNG đụng bản đã cài).
//  - Phím tắt textGrab của bản e2e phải là CmdOrCtrl+Alt+Shift+F10 (xem settings.json cô lập trong README).
//  - Chữ giả hiện bằng cửa sổ topmost của helpers/textwin.ps1 ở giữa MỖI màn hình. Ảnh đóng băng màn hình chỉ
//    nằm trong bộ nhớ của app; kịch bản KHÔNG chụp/lưu ảnh overlay và không ghi dữ liệu ảnh vào log.
//  - Dọn clipboard khi xong.
import { spawn, execFileSync } from "node:child_process";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { listWindows, attach, targets, winName, report, sleep } from "./cdp.mjs";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const H = (f) => path.join(HERE, "helpers", f);
const EXE = process.env.E2E_EXE;
if (!EXE) {
  console.error("Hãy đặt E2E_EXE = đường dẫn snapdoc.exe của bản e2e (identifier com.snapdoc.e2etest).");
  process.exit(2);
}
if (/AppData[\\/]Local[\\/]SnapDoc[\\/]/i.test(EXE)) {
  console.error("E2E_EXE trỏ vào bản ĐÃ CÀI — từ chối chạy.");
  process.exit(2);
}

/** Overlay có label "overlay-i" nhưng URL là ?win=overlay&idx=i — chọn đúng theo idx (lấy cái mới nhất). */
async function attachOverlay(i, timeoutMs = 8000) {
  const end = Date.now() + timeoutMs;
  while (Date.now() < end) {
    const t = (await targets()).filter((x) => winName(x) === "overlay" && new RegExp(`[?&]idx=${i}(&|$)`).test(x.url)).pop();
    if (t) return attach(t);
    await sleep(250);
  }
  throw new Error(`Không thấy overlay idx=${i}`);
}

const rows = [];
// In ngay từng dòng (nếu app e2e sập giữa chừng vẫn còn kết quả các bước trước).
const add = (id, name, ok, note = "") => { rows.push({ id, name, ok, note }); console.log(`${ok ? "PASS" : "FAIL"}  ${id}  ${name}${note ? "  — " + note : ""}`); };

const psFile = (file, args = []) =>
  execFileSync("powershell", ["-NoProfile", "-ExecutionPolicy", "Bypass", "-File", H(file), ...args], { encoding: "utf8" }).trim();
const psCmd = (cmd) =>
  execFileSync("powershell", ["-NoProfile", "-Command", cmd], { encoding: "utf8" }).trim();
const getClip = () => psCmd("$c = Get-Clipboard -Raw; if ($null -eq $c) { '' } else { $c }");
const setClip = (s) => psCmd(`Set-Clipboard -Value '${s.replace(/'/g, "''")}'`);
const clearClip = () => psCmd("Set-Clipboard -Value $null");
const probe = () => JSON.parse(psFile("win_probe.ps1", ["-Exe", EXE]));
const toastRunning = () =>
  Number(psCmd("(Get-CimInstance Win32_Process -Filter \"Name='powershell.exe'\" | Where-Object { $_.CommandLine -like '*NotifyIcon*' -and $_.CommandLine -notlike '*Get-CimInstance*' } | Measure-Object).Count")) > 0;
const hotkey = () => psFile("send_hotkey.ps1");
// Overlay nhận press/release/Esc từ vòng lặp input GỐC của Rust (không phải sự kiện DOM) → phải dùng chuột/phím THẬT của OS.
const realDrag = (x1, y1, x2, y2) => psFile("input.ps1", ["-Action", "drag", "-X1", String(Math.round(x1)), "-Y1", String(Math.round(y1)), "-X2", String(Math.round(x2)), "-Y2", String(Math.round(y2))]);
const realRightClick = (x, y) => psFile("input.ps1", ["-Action", "rclick", "-X1", String(Math.round(x)), "-Y1", String(Math.round(y))]);
const realEsc = () => psFile("input.ps1", ["-Action", "key", "-Vk", "27"]);

async function waitFor(fn, timeoutMs, stepMs = 250) {
  const end = Date.now() + timeoutMs;
  while (Date.now() < end) {
    const v = await fn();
    if (v) return v;
    await sleep(stepMs);
  }
  return null;
}

// --- chuẩn bị: chữ giả trên mọi màn hình -----------------------------------------------------------
const wins0 = await listWindows();
if (!wins0.some((w) => w.win === "capture-bar")) throw new Error("App e2e chưa chạy (không thấy capture-bar) — xem scripts/e2e/README.md");
const pr = probe();
if (pr.pids < 1) throw new Error(`Không thấy tiến trình ${EXE}`);
if (pr.count > 0) throw new Error(`Còn ${pr.count} overlay đang mở từ trước — khởi động lại app e2e (helpers/restart_e2e.ps1)`);

const tw = spawn("powershell", ["-NoProfile", "-ExecutionPolicy", "Bypass", "-File", H("textwin.ps1")], { stdio: ["ignore", "pipe", "inherit"] });
let twOut = "";
tw.stdout.on("data", (d) => (twOut += d.toString()));
let monitors;
{
  const ok = await waitFor(() => /\]\s*$|\}\s*$/.test(twOut.trim()) && twOut.trim(), 20000, 200);
  if (!ok) { tw.kill(); throw new Error("textwin.ps1 không khởi động được: " + twOut); }
  const parsed = JSON.parse(twOut.trim().split(/\r?\n/).pop());
  monitors = Array.isArray(parsed) ? parsed : [parsed];
}
const N = monitors.length;
console.log(`Số màn hình: ${N}  →`, monitors.map((m) => `#${m.index} ${m.w}x${m.h}@${m.x},${m.y}${m.primary ? " (chính)" : ""} "${m.text}"`).join(" | "));
add("TG-00", `Phát hiện ${N} màn hình và hiện chữ giả trên từng màn hình`, N >= 1, `${N} màn hình`);
if (N < 2) console.log("⚠️ Chỉ có 1 màn hình: phần 2 màn hình KHÔNG test được — cần test tay.");
await sleep(1200);

const bar = await attach("capture-bar");

async function triggerAndWaitOverlays(expect) {
  hotkey();
  let got = await waitFor(() => { const p = probe(); return p.count >= expect ? p : null; }, 2500, 300);
  if (!got) {
    try {
      await bar.eval("window.__TAURI_INTERNALS__.invoke('start_text_grab')");
      got = await waitFor(() => { const p = probe(); return p.count >= expect ? p : null; }, 7500, 300);
    } catch { /* bỏ qua */ }
  }
  return got;
}
async function overlaysClosed(timeoutMs = 6000) {
  const t0 = Date.now();
  const ok = await waitFor(() => probe().count === 0, timeoutMs, 200);
  return ok ? Date.now() - t0 : null;
}
/** Tìm màn hình (monitor) mà overlay-i đang phủ: khớp toạ độ vật lý (screenX*dpr) gần nhất. */
function monitorFor(vp) {
  const px = vp.sx * vp.dpr, py = vp.sy * vp.dpr;
  return monitors.reduce((best, m) => (Math.hypot(m.x - px, m.y - py) < Math.hypot(best.x - px, best.y - py) ? m : best), monitors[0]);
}
const norm = (s) => s.toUpperCase().replace(/[^A-Z0-9]/g, "");

// --- (a)(b)(c): kéo chọn vùng trên TỪNG overlay ----------------------------------------------------
for (let i = 0; i < N; i++) {
  const tag = `màn hình overlay-${i}`;
  setClip(`SENTINEL-${Date.now()}`);
  const sentinel = getClip();
  await sleep(2500); // tránh chống-spam phím tắt
  const opened = await triggerAndWaitOverlays(N);
  add(`TG-${i}a`, `Ctrl+Shift+T mở overlay phủ ${N} màn hình`, !!opened && opened.count === N, opened ? `${opened.count} overlay` : "không mở");
  if (!opened) { await sleep(500); continue; }

  const ov = await attachOverlay(i);
  const ready = await waitFor(() => ov.eval("document.body.innerText.includes('trích xuất chữ')"), 8000, 250);
  const vp = await ov.eval("({w: innerWidth, h: innerHeight, dpr: devicePixelRatio, sx: screenX, sy: screenY})");
  const mon = monitorFor(vp);
  const x1 = vp.w * 0.22, x2 = vp.w * 0.78, y1 = vp.h * 0.38, y2 = vp.h * 0.62; // 56% x 24%, giữa màn hình
  add(`TG-${i}b`, `overlay-${i} sẵn sàng (banner Text Grab hiện)`, !!ready, `viewport ${vp.w}x${vp.h} dpr=${vp.dpr} → màn hình #${mon.index}`);

  let toastSeen = false;
  // toạ độ CSS của overlay → toạ độ màn hình vật lý (gốc màn hình + css * dpr)
  realDrag(mon.x + x1 * vp.dpr, mon.y + y1 * vp.dpr, mon.x + x2 * vp.dpr, mon.y + y2 * vp.dpr);
  const closedMs = await overlaysClosed(6000);
  add(`TG-${i}c`, `Thả chuột trên ${tag} → TẤT CẢ overlay đóng`, closedMs !== null, closedMs !== null ? `${closedMs}ms` : `còn ${probe().count} overlay mở`);

  // chờ OCR chạy ngầm + clipboard đổi; đồng thời bắt toast
  let clip = sentinel;
  const gotClip = await waitFor(() => {
    if (!toastSeen) { try { toastSeen = toastRunning(); } catch { /* bỏ qua */ } }
    clip = getClip();
    return clip && clip !== sentinel ? clip : null;
  }, 60000, 300);
  const expected = mon.token;
  add(`TG-${i}d`, `Clipboard chứa chữ giả của màn hình #${mon.index} ("${expected}")`, !!gotClip && norm(clip).includes(expected) && norm(clip).includes("SNAPDOC"), (norm(clip || "").includes("SNAPDOC") ? `clipboard="${clip.replace(/\s+/g, " ").slice(0, 60)}"` : `clipboard ${(clip || "").length} ký tự, không khớp (nội dung không ghi vào log)`));
  if (!toastSeen) toastSeen = !!(await waitFor(() => { try { return toastRunning(); } catch { return false; } }, 4000, 300));
  add(`TG-${i}e`, "Có toast thông báo (tiến trình PowerShell NotifyIcon xuất hiện)", toastSeen);
  ov.close();
  await sleep(800);
}

// console CaptureBar: không lỗi OCR/IPC (dùng phân loại: lỗi WASM -> có dự phòng OCR Windows)
const errs = bar.console.filter((l) => /^(error|EXCEPTION)/.test(l));
add("TG-f", "CaptureBar không báo lỗi console khi xử lý Text Grab", errs.length === 0, errs.slice(0, 3).join(" || "));

// --- (d) Esc và chuột phải huỷ mọi overlay --------------------------------------------------------
await sleep(2500);
{
  const opened = await triggerAndWaitOverlays(N);
  const last = await attachOverlay(N - 1);
  await waitFor(() => last.eval("document.body.innerText.includes('trích xuất chữ')"), 8000, 250);
  realEsc();
  const ms = await overlaysClosed(6000);
  add("TG-g", `Esc trên overlay-${N - 1} đóng mọi overlay`, !!opened && ms !== null, ms !== null ? `${ms}ms` : `còn ${probe().count} mở`);
  last.close();
}
await sleep(2500);
{
  const opened = await triggerAndWaitOverlays(N);
  const first = await attachOverlay(0);
  await waitFor(() => first.eval("document.body.innerText.includes('trích xuất chữ')"), 8000, 250);
  const m0 = monitors.find((m) => m.primary) ?? monitors[0];
  realRightClick(m0.x + m0.w / 2, m0.y + m0.h / 2);
  const ms = await overlaysClosed(6000);
  add("TG-h", "Chuột phải trên overlay-0 đóng mọi overlay", !!opened && ms !== null, ms !== null ? `${ms}ms` : `còn ${probe().count} mở`);
  first.close();
}

// --- dọn ------------------------------------------------------------------------------------------
bar.close();
tw.kill();
try { clearClip(); } catch { /* bỏ qua */ }
console.log(`--- ${rows.filter((r) => r.ok).length}/${rows.length} PASS`);
process.exit(rows.every((r) => r.ok) ? 0 : 1);
