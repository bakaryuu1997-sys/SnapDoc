import { attach, report, sleep } from "./cdp.mjs";
const rows=[]; const add=(id,name,ok,note="")=>rows.push({id,name,ok,note});
const bar = await attach("capture-bar");
let ed = await attach("editor");
await ed.eval("location.reload()").catch(()=>{});
ed.close();
await sleep(3000);
const dataUrl = await bar.eval(`(() => {
  const c = document.createElement('canvas'); c.width = 1100; c.height = 640;
  const g = c.getContext('2d');
  g.fillStyle = '#f3f4f6'; g.fillRect(0,0,1100,640);
  g.fillStyle = '#111'; g.font = '30px Arial';
  g.fillText('Họ tên: Nguyễn Văn Ánh', 40, 170);
  g.fillText('Email: nguyen.van.anh@example.com', 40, 230);
  g.fillText('API key: sk-live-abcdef1234567890abcd', 40, 290);
  g.fillText('Số điện thoại: 0912 345 678', 40, 350);
  g.fillText('Thẻ: 4111 1111 1111 1111', 40, 410);
  g.fillText('Địa chỉ: 12 Lê Lợi, Quận 1, TP. Hồ Chí Minh', 40, 470);
  return c.toDataURL('image/png');
})()`);
await bar.invoke("set_pending_image", { data: dataUrl, width: 1100, height: 640, docJson: null, scaleFactor: 1 });
await bar.invoke("open_editor");
await sleep(3000);
ed = await attach("editor");
await sleep(1500);
await ed.clickSel('button[title*="Smart Auto-Redact"]');
let msg = "";
for (let i = 0; i < 400 && !msg; i++) {
  await sleep(300);
  const t = await ed.text();
  const m = t.match(/Đã tự động che mờ \d+ vùng|Không phát hiện thông tin nhạy cảm|Không tìm thấy văn bản/);
  if (m) msg = m[0];
}
await sleep(500);
await ed.shot("31_autoredact_fixed");
console.log("Thông báo:", msg);
const n = Number((msg.match(/(\d+) vùng/)||[])[1]||0);
add("ST-06i","Che nhạy cảm tự động (bản sửa) che ≥4 vùng: email, API key, SĐT có dấu cách, thẻ", n>=4, msg);
bar.close(); ed.close(); report(rows);
