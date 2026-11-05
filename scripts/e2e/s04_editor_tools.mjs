import { attach, report, sleep } from "./cdp.mjs";
const rows = [];
const add = (id, name, ok, note = "") => rows.push({ id, name, ok, note });

const ed = await attach("editor");
const OX = 402, OY = 225; // gốc ảnh trên màn hình (ảnh hiển thị 100%)
const px = (ix, iy) => ({ x: OX + ix, y: OY + iy });

// Lấy pixel từ canvas Konva (toạ độ ảnh) — gộp mọi canvas trong stage.
const pixel = (ix, iy) =>
  ed.eval(`(() => {
    const cs = [...document.querySelectorAll('canvas')];
    const out = document.createElement('canvas'); out.width = 1100; out.height = 640;
    const g = out.getContext('2d');
    cs.forEach(c => { try { g.drawImage(c, 0, 0, c.width, c.height, 0, 0, 1100, 640); } catch(e){} });
    const d = g.getImageData(${ix}, ${iy}, 1, 1).data; return [d[0], d[1], d[2]];
  })()`);
const isRed = ([r, g, b]) => r > 200 && g < 110 && b < 110;
const tool = async (title) => { await ed.clickSel(`button[title^="${title}"]`); await sleep(250); };

// Nền ban đầu tại 1 điểm trống để so sánh
const base = await pixel(200, 460);
console.log("pixel nền (200,460):", base);

// a) Khung (R): vẽ khung quanh ô xanh
await tool("Vẽ khung");
let a = px(30, 460), b = px(360, 590);
await ed.drag(a.x, a.y, b.x, b.y);
await sleep(500);
const edgeTop = await pixel(200, 460);
add("ST-06d", "Công cụ Khung (R): vẽ được khung viền đỏ trên ảnh", isRed(edgeTop), `pixel mép trên=${edgeTop}`);
await ed.shot("05_after_rect");

// b) Mũi tên (A)
await tool("Mũi tên (A)");
a = px(600, 140); b = px(760, 300);
await ed.drag(a.x, a.y, b.x, b.y);
await sleep(500);
const arrowPx = await pixel(680, 220);
add("ST-06e", "Công cụ Mũi tên (A): vẽ được mũi tên", isRed(arrowPx) || arrowPx.join() !== base.join(), `pixel giữa mũi tên=${arrowPx}`);

// c) Chữ (T)
await tool("Viết chữ");
const t0 = px(600, 480);
await ed.click(t0.x, t0.y);
await sleep(400);
await ed.type("Ghi chú kiểm thử");
await sleep(300);
await ed.key("Escape", { vk: 27 });
await sleep(500);
await ed.shot("06_after_text");

// d) Hoàn tác / Làm lại
const before = await pixel(680, 220);
await ed.clickSel('button[title^="Hoàn tác"]'); await sleep(300);
await ed.clickSel('button[title^="Hoàn tác"]'); await sleep(300);
const afterUndo = await pixel(680, 220);
await ed.clickSel('button[title^="Làm lại"]'); await sleep(300);
await ed.clickSel('button[title^="Làm lại"]'); await sleep(300);
const afterRedo = await pixel(680, 220);
add("ST-06f", "Hoàn tác/Làm lại (Undo/Redo) bỏ rồi dựng lại mũi tên", afterUndo.join() !== before.join() && afterRedo.join() === before.join(), `trước=${before} undo=${afterUndo} redo=${afterRedo}`);

// e) Che mờ (B) thủ công lên dòng Họ tên
await tool("Che mờ");
a = px(30, 140); b = px(420, 185);
await ed.drag(a.x, a.y, b.x, b.y);
await sleep(700);
await ed.shot("07_after_blur");

// f) Smart Auto-Redact (OCR + regex) — có thể mất vài giây (WASM)
await ed.clickSel('button[title*="Smart Auto-Redact"]');
let redactMsg = "";
for (let i = 0; i < 40; i++) {
  await sleep(1000);
  const txt = await ed.text();
  if (/đã che|Đã che|nhạy cảm|không tìm thấy|Không tìm thấy|vùng/i.test(txt) && i > 1) { redactMsg = txt.replace(/\s+/g, " ").slice(0, 400); }
  const busy = await ed.eval(`!!document.querySelector('[class*=spinner],[aria-busy=true]')`);
  if (!busy && i > 4) break;
}
await ed.shot("08_after_autoredact");
console.log("Sau Auto-Redact, chữ trên trang:", redactMsg.slice(0, 200));

bar_done: {
  report(rows);
}
console.log("console lỗi:", ed.console.filter((c) => /EXCEPTION|error/i.test(c)).slice(0, 6));
ed.close();
