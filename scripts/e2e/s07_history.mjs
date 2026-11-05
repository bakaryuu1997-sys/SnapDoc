import { attach, listWindows, report, sleep } from "./cdp.mjs";
const rows = [];
const add = (id, name, ok, note = "") => rows.push({ id, name, ok, note });

const bar = await attach("capture-bar");
await bar.invoke("open_history");
const h = await attach("history", 20000);
await sleep(2000);
await h.shot("13_history_open");
const vp = await h.viewport();
console.log("History viewport:", vp);
let txt = await h.text();
console.log("History chữ:", txt.replace(/\s+/g, " ").slice(0, 350));
add("ST-07b", "Cửa sổ Lịch sử mở và hiển thị mục đã lưu", !/Chưa có|trống/i.test(txt.slice(0, 600)) || /Phụ đề|Quick|Nhanh|ảnh/i.test(txt));

// Chọn mục đầu tiên
const firstCard = await h.eval(`(() => { const c=[...document.querySelectorAll('img')].find(i=>i.getBoundingClientRect().width>40); if(!c) return null; const r=c.getBoundingClientRect(); return {x:r.x+r.width/2,y:r.y+r.height/2}; })()`);
if (firstCard) await h.click(firstCard.x, firstCard.y);
await sleep(1200);
await h.shot("14_history_selected");
txt = await h.text();
add("ST-07c", "Chọn mục → bảng xem trước hiện metadata (kích thước, loại chụp)", /1100\s*×\s*640/.test(txt), (txt.match(/Kích thước[^\n]*\n?[^\n]*/)||[""])[0]);

// Nút chia sẻ Drive khi CHƯA kết nối → phải báo lỗi dễ hiểu, không treo
const hasShare = await h.eval(`!![...document.querySelectorAll('button')].find(b => b.textContent.includes('Chia sẻ qua Drive'))`);
add("ST-07d", "Có nút 'Chia sẻ qua Drive' trong bảng xem trước", hasShare);
if (hasShare) {
  await h.clickText("Chia sẻ qua Drive");
  await sleep(1500);
  await h.shot("15_history_share_notconnected");
  txt = await h.text();
  add("ST-10b", "Chia sẻ khi chưa kết nối Drive → thông báo lỗi rõ ràng", /Chưa kết nối Google Drive/.test(txt), (txt.match(/⚠[^\n]*/) || [""])[0]);
}

// Ghim ảnh lên màn hình
const pinBtn = await h.eval(`!![...document.querySelectorAll('button')].find(b => b.textContent.includes('Ghim'))`);
if (pinBtn) {
  await h.clickText("Ghim");
  await sleep(1500);
  const wins = (await listWindows()).map((w) => w.win);
  console.log("Cửa sổ sau khi ghim:", wins.join(", "));
  add("ST-08a", "Ghim ảnh từ Lịch sử → mở cửa sổ Pin nổi", wins.includes("pin"));
  if (wins.includes("pin")) {
    const pin = await attach("pin");
    await sleep(800);
    await pin.shot("16_pin_window");
    const body = await pin.text();
    add("ST-08b", "Cửa sổ Pin hiển thị ảnh (không kẹt ở 'Đang nạp ảnh ghim')", !/Đang nạp ảnh ghim/.test(body));
    await pin.invoke("close_self").catch(() => {});
    pin.close();
  }
}

// Xoá → toast hoàn tác
await h.clickText("Chuyển vào thùng rác").catch(() => {});
await sleep(1000);
await h.shot("17_history_after_delete");
txt = await h.text();
add("ST-07e", "Xoá mục → hiện toast Hoàn tác", /Hoàn tác|Undo/i.test(txt), (txt.match(/Đã (xoá|xóa)[^\n]*/) || [""])[0]);
if (/Hoàn tác/.test(txt)) {
  await h.clickText("Hoàn tác");
  await sleep(1000);
  const after = await h.invoke("list_history", { filter: { limit: 20, offset: 0, trashOnly: false } });
  add("ST-07f", "Bấm Hoàn tác → mục quay lại danh sách", after.items.length >= 1, `items=${after.items.length}`);
}
console.log("console lỗi:", h.console.filter((c) => /EXCEPTION|error/i.test(c)).slice(0, 5));
bar.close(); h.close();
report(rows);
