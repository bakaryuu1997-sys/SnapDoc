import { attach, report, sleep } from "./cdp.mjs";
import fs from "node:fs";
const rows = [];
const add = (id, name, ok, note = "") => rows.push({ id, name, ok, note });

// ── A) Token Drive: file cũ dạng thô → tự chuyển sang mã hoá DPAPI ──
const CFG = `${process.env.APPDATA}\\com.snapdoc.e2etest`;
const legacy = `${CFG}\\drive_tokens.json`;
const dat = `${CFG}\\drive_tokens.dat`;
fs.writeFileSync(legacy, JSON.stringify({ client_id: "e2e.apps.googleusercontent.com", client_secret: "GOCSPX-e2e-secret", refresh_token: "1//e2e-refresh-token-SECRET", access_token: "ya29.e2e", expires_at_ms: 4102444800000 }));
const bar = await attach("capture-bar");
const connected = await bar.invoke("drive_is_connected");
add("ST-10c", "File token cũ (JSON thô) được nhận và drive_is_connected = true", connected === true);
add("ST-10d", "Sau lần đọc đầu: file thô bị xoá, file mã hoá .dat được tạo", !fs.existsSync(legacy) && fs.existsSync(dat), `legacy=${fs.existsSync(legacy)} dat=${fs.existsSync(dat)}`);
const raw = fs.readFileSync(dat);
add("ST-10e", "File .dat không chứa refresh_token ở dạng chữ thường (DPAPI)", !raw.toString("latin1").includes("e2e-refresh-token-SECRET") && raw.slice(0, 4).toString() === "SDT1", `header=${raw.slice(0,4).toString()} ${raw.length}B`);
await bar.invoke("drive_disconnect");
add("ST-10f", "Ngắt kết nối xoá token", !fs.existsSync(dat) && (await bar.invoke("drive_is_connected")) === false);

// ── B) Settings: hàng phím tắt Text Grab ──
await bar.invoke("open_settings", {});
const st = await attach("settings");
await sleep(1000);
await st.clickText("Phím tắt");
await sleep(600);
const body = await st.text();
await st.shot("30_settings_textgrab");
add("ST-03i", "Phím tắt Text Grab (OCR) có hàng cấu hình riêng", /Trích xuất chữ \(OCR\)/.test(body));
st.close();

// ── C) Che nhạy cảm tự động trên ảnh mới (không che tay) ──
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
  g.fillText('Thẻ: 4111 1111 1111 1111', 40, 410);
  g.fillText('Địa chỉ: 12 Lê Lợi, Quận 1, TP. Hồ Chí Minh', 40, 470);
  return c.toDataURL('image/png');
})()`);
await bar.invoke("set_pending_image", { data: dataUrl, width: 1100, height: 640, docJson: null, scaleFactor: 1 });
await bar.invoke("open_editor");
await sleep(2500);
const ed = await attach("editor");
await sleep(1500);
await ed.clickSel('button[title*="Smart Auto-Redact"]');
let msg = "";
for (let i = 0; i < 120; i++) {
  await sleep(1000);
  const t = await ed.text();
  const m = t.match(/Đã tự động che mờ \d+ vùng|Không phát hiện thông tin nhạy cảm/);
  if (m) { msg = m[0]; break; }
}
await sleep(800);
await ed.shot("31_autoredact_fixed");
console.log("Thông báo Che nhạy cảm:", msg);
const n = Number((msg.match(/(\d+) vùng/) || [])[1] || 0);
add("ST-06i", "Che nhạy cảm tự động bắt đủ ≥4 vùng (email, API key, SĐT có dấu cách, thẻ)", n >= 4, msg);
console.log("console lỗi:", ed.console.filter((c) => /EXCEPTION/i.test(c)).slice(0, 3));
bar.close(); ed.close();
report(rows);
