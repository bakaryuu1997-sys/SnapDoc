// Chụp ảnh minh hoạ cho README: điều khiển BẢN E2E CÔ LẬP qua CDP và chụp từng cửa sổ CỦA APP
// (Page.captureScreenshot) — không chụp màn hình thật, không dùng dữ liệu thật: ảnh mẫu được vẽ
// bằng canvas (dữ liệu giả), video mẫu là file test_video.mp4 (giọng nói tổng hợp).
//
//   node scripts/e2e/s14_readme_shots.mjs        (cần bản e2e đang chạy, xem README của thư mục này)
//   E2E_VIDEO=<đường dẫn mp4>   video mẫu để chụp phần phụ đề (bỏ qua phần này nếu không đặt)
//
// Ảnh ra: docs/screenshots/*.png
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { attach, sleep, listWindows } from "./cdp.mjs";

const OUT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../docs/screenshots");
fs.mkdirSync(OUT, { recursive: true });
const VIDEO = process.env.E2E_VIDEO || "";
const log = (...a) => console.log(...a);

/** Che dữ liệu riêng/đường dẫn máy này trên trang TRƯỚC khi chụp: token Bearer của MCP và đường dẫn exe. */
async function sanitize(win) {
  const fn = () => {
    const w = document.createTreeWalker(document.body, NodeFilter.SHOW_TEXT);
    const nodes = [];
    while (w.nextNode()) nodes.push(w.currentNode);
    const BS = String.fromCharCode(92); // dấu \ (tránh nhầm lẫn escape khi chuỗi hàm được gửi vào trang)
    const exe = ["C:", "Program Files", "SnapDoc", "snapdoc.exe"].join(BS + BS);
    const anyPath = /[A-Za-z]:[^"'\s]*?snapdoc\.exe/g;
    for (const n of nodes) {
      let t = n.nodeValue;
      t = t.replace(/Bearer [0-9A-Za-z._-]{16,}/g, "Bearer <TOKEN>");
      t = t.replace(anyPath, exe);
      if (t !== n.nodeValue) n.nodeValue = t;
    }
  };
  await win.eval(`(${fn.toString()})()`);
}

async function snap(win, name) {
  await sanitize(win);
  const r = await win.send("Page.captureScreenshot", { format: "png" });
  const f = path.join(OUT, `${name}.png`);
  fs.writeFileSync(f, Buffer.from(r.data, "base64"));
  log("  📸", name);
}
const clickText = async (win, text, tag = "button") => {
  try {
    await win.clickText(text, tag);
    return true;
  } catch {
    return false;
  }
};

// ───────────── Thanh chụp + menu Tuỳ chọn ─────────────
const bar = await attach("capture-bar");
await bar.invoke("open_capture_bar");
await sleep(1500);
await snap(bar, "01-capture-bar");

const opt = await bar.eval(`(() => { const b=[...document.querySelectorAll('button')].find(x=>/Tuỳ chọn|Options/.test(x.textContent)); if(!b) return null; const r=b.getBoundingClientRect(); return {x:r.x,y:r.y,w:r.width,h:r.height}; })()`);
if (opt) {
  await bar.invoke("toggle_capture_bar_popover", { anchorX: opt.x, anchorY: opt.y, anchorW: opt.w, anchorH: opt.h }).catch(() => {});
  await sleep(1200);
  try {
    const pop = await attach("capture-bar-popover", 5000);
    await snap(pop, "02-options-menu");
    pop.close();
  } catch (e) {
    log("  (không chụp được popover:", String(e).slice(0, 80), ")");
  }
  await bar.invoke("hide_capture_bar_popover").catch(() => {});
}

// ───────────── Editor ảnh: ảnh mẫu giả → che nhạy cảm → chú thích → làm đẹp ─────────────
const dataUrl = await bar.eval(`(() => {
  const c = document.createElement('canvas'); c.width = 1100; c.height = 640;
  const g = c.getContext('2d');
  g.fillStyle = '#f3f4f6'; g.fillRect(0,0,1100,640);
  g.fillStyle = '#1d4ed8'; g.fillRect(0,0,1100,90);
  g.fillStyle = '#fff'; g.font = 'bold 40px Arial'; g.fillText('Báo cáo lỗi đăng nhập — ví dụ minh hoạ', 40, 62);
  g.fillStyle = '#111'; g.font = '30px Arial';
  g.fillText('Người dùng: Nguyễn Văn Ánh (dữ liệu giả)', 40, 170);
  g.fillText('Email: nguyen.van.anh@example.com', 40, 230);
  g.fillText('API key: sk-live-abcdef1234567890abcd', 40, 290);
  g.fillText('Số điện thoại: 0912 345 678', 40, 350);
  g.fillText('Kết quả thực tế: màn hình trắng sau khi bấm Đăng nhập', 40, 410);
  g.fillStyle = '#10b981'; g.fillRect(40, 470, 300, 110);
  g.fillStyle = '#ef4444'; g.beginPath(); g.arc(520, 525, 55, 0, Math.PI*2); g.fill();
  return c.toDataURL('image/png');
})()`);
await bar.invoke("set_pending_image", { data: dataUrl, width: 1100, height: 640, docJson: null, scaleFactor: 1 });
await bar.invoke("open_editor");
await sleep(2500);
let ed = await attach("editor", 20000);
await sleep(1800);
await snap(ed, "03-editor");

if (await clickText(ed, "Che nhạy cảm")) {
  log("  … đang quét thông tin nhạy cảm (OCR)");
  await sleep(9000);
  await snap(ed, "04-editor-redact");
}

// Vẽ khung (R) + mũi tên (A) + chữ (T) trên ảnh
const rectInfo = await ed.eval(`(() => { const c=[...document.querySelectorAll('canvas')].sort((a,b)=>b.width*b.height-a.width*a.height)[0]; if(!c) return null; const r=c.getBoundingClientRect(); return {x:r.x,y:r.y,w:r.width,h:r.height}; })()`);
if (rectInfo) {
  const px = (fx, fy) => [rectInfo.x + rectInfo.w * fx, rectInfo.y + rectInfo.h * fy];
  await ed.key("r", { code: "KeyR", vk: 82 });
  await ed.drag(...px(0.06, 0.60), ...px(0.34, 0.90));
  await ed.key("a", { code: "KeyA", vk: 65 });
  await ed.drag(...px(0.62, 0.62), ...px(0.46, 0.80));
  await sleep(600);
  await ed.key("v", { code: "KeyV", vk: 86 });
  await sleep(400);
  await snap(ed, "05-editor-annotate");
}
if (await clickText(ed, "Làm đẹp")) {
  await sleep(2500);
  await snap(ed, "06-editor-beautify");
}

// Bảng lệnh Ctrl+K
await ed.key("k", { code: "KeyK", vk: 75, modifiers: 2 });
await sleep(900);
await snap(ed, "07-command-palette");
await ed.key("Escape", { vk: 27 });

// Lưu vào Thư viện (Ctrl+S) rồi mở Thư viện
await ed.key("s", { code: "KeyS", vk: 83, modifiers: 2 });
await sleep(2500);
await bar.invoke("open_history");
try {
  const h = await attach("history", 20000);
  await sleep(2500);
  await snap(h, "08-library");
  h.close();
} catch (e) {
  log("  (không mở được Thư viện:", String(e).slice(0, 80), ")");
}

// ───────────── Cài đặt ─────────────
await bar.invoke("open_settings", {});
try {
  const st = await attach("settings", 15000);
  await sleep(1500);
  await snap(st, "09-settings-general");
  for (const [label, name] of [
    ["Phím tắt", "10-settings-shortcuts"],
    ["Quay video", "11-settings-recording"],
    ["AI Agent", "12-settings-ai-agent"],
  ]) {
    if (await clickText(st, label)) {
      await sleep(1200);
      await snap(st, name);
    }
  }
  st.close();
} catch (e) {
  log("  (không mở được Cài đặt:", String(e).slice(0, 80), ")");
}
ed.close();

// ───────────── Video + phụ đề AI ─────────────
if (VIDEO && fs.existsSync(VIDEO)) {
  await bar.invoke("open_video_file_path", { path: VIDEO });
  const ve = await attach("editor", 25000).catch(() => null);
  const wins = await listWindows();
  const editors = wins.filter((w) => w.win.startsWith("editor"));
  const vw = editors.length ? await attach(editors[editors.length - 1].win, 20000) : ve;
  for (let i = 0; i < 40; i++) {
    const ok = await vw.eval(`(() => { const v=document.querySelector('video'); return !!v && v.readyState>=2 && v.duration>0; })()`).catch(() => false);
    if (ok) break;
    await sleep(500);
  }
  await sleep(1500);
  await snap(vw, "13-video-editor");
  await vw.clickSel('button[title="Phụ đề tự động (AI)"]').catch(() => {});
  await sleep(1500);
  await snap(vw, "14-captions-dialog");
  vw.close();
}

bar.close();
log("Xong. Ảnh nằm trong", OUT);

process.exit(0); // đóng hết kết nối CDP còn mở, tránh treo khi thoát
