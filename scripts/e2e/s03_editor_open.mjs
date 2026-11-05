import { attach, report, sleep } from "./cdp.mjs";
const rows = [];
const add = (id, name, ok, note = "") => rows.push({ id, name, ok, note });

const bar = await attach("capture-bar");
// Ảnh thử tổng hợp: chữ Việt, email, API key, số điện thoại (không phải dữ liệu thật).
const dataUrl = await bar.eval(`(() => {
  const c = document.createElement('canvas'); c.width = 1100; c.height = 640;
  const g = c.getContext('2d');
  g.fillStyle = '#f3f4f6'; g.fillRect(0,0,1100,640);
  g.fillStyle = '#1d4ed8'; g.fillRect(0,0,1100,90);
  g.fillStyle = '#fff'; g.font = 'bold 40px Arial'; g.fillText('Báo cáo doanh thu quý bốn', 40, 62);
  g.fillStyle = '#111'; g.font = '30px Arial';
  g.fillText('Họ tên: Nguyễn Văn Ánh', 40, 170);
  g.fillText('Email: nguyen.van.anh@example.com', 40, 230);
  g.fillText('API key: sk-live-abcdef1234567890abcd', 40, 290);
  g.fillText('Số điện thoại: 0912 345 678', 40, 350);
  g.fillText('Địa chỉ: 12 Lê Lợi, Quận 1, TP. Hồ Chí Minh', 40, 410);
  g.fillStyle = '#10b981'; g.fillRect(40, 470, 300, 110);
  g.fillStyle = '#ef4444'; g.beginPath(); g.arc(520, 525, 55, 0, Math.PI*2); g.fill();
  return c.toDataURL('image/png');
})()`);
add("ST-06a", "Tạo ảnh thử 1100x640", dataUrl.startsWith("data:image/png"), `${dataUrl.length} ký tự`);
await bar.invoke("set_pending_image", { data: dataUrl, width: 1100, height: 640, docJson: null, scaleFactor: 1 });
await bar.invoke("open_editor");
await sleep(2500);
const ed = await attach("editor");
await sleep(1500);
const vp = await ed.viewport();
await ed.shot("04_editor_image");
const titles = await ed.eval(`[...document.querySelectorAll('button')].map(b => (b.title || b.getAttribute('aria-label') || b.textContent || '').trim().replace(/\\s+/g,' ')).filter(Boolean)`);
console.log("Editor viewport:", vp);
console.log("Editor nút (" + titles.length + "):", titles.join(" | "));
const canvases = await ed.eval(`[...document.querySelectorAll('canvas')].map(c => ({w:c.width,h:c.height}))`);
console.log("canvas:", JSON.stringify(canvases));
add("ST-06b", "Editor mở ảnh và dựng canvas", canvases.length > 0, JSON.stringify(canvases[0]));
add("ST-06c", "Không lỗi console khi mở Editor", ed.console.filter((c) => /EXCEPTION/i.test(c)).length === 0, ed.console.slice(0, 4).join(" ; "));
bar.close(); ed.close();
report(rows);
