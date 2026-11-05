import { attach, listWindows, report, sleep } from "./cdp.mjs";
const rows = [];
const add = (id, name, ok, note = "") => rows.push({ id, name, ok, note });

const ed = await attach("editor");
await ed.invoke("open_editor").catch(() => {});
await sleep(800);

// Command Palette: Ctrl+K
await ed.key("k", { modifiers: 2, vk: 75, code: "KeyK" });
await sleep(600);
await ed.shot("18_palette_open");
let txt = await ed.text();
add("ST-04a", "Ctrl+K mở Command Palette trong Editor", /Tìm lệnh hoặc hành động/.test(txt) || (await ed.eval(`!!document.querySelector('input[placeholder*="Tìm lệnh"]')`)));
const items = await ed.eval(`[...document.querySelectorAll('[role=dialog] div')].filter(d => d.children.length===0 || d.className==='').map(d=>d.textContent.trim()).filter(t=>t.length>3 && t.length<60).slice(0,40)`);
console.log("Palette mục (mẫu):", JSON.stringify(items).slice(0, 500));

// Lọc
await ed.type("webcam");
await sleep(400);
await ed.shot("18b_palette_filter");
txt = await ed.text();
add("ST-04b", "Gõ 'webcam' lọc ra lệnh Bật/Tắt Webcam Bubble", /Webcam Bubble/.test(txt));
// Thực thi bằng Enter
await ed.key("Enter", { vk: 13, code: "Enter" });
await sleep(2500);
const wins = (await listWindows()).map((w) => w.win);
console.log("Cửa sổ sau khi bật Webcam:", wins.join(", "));
add("ST-05a", "Palette → Bật Webcam Bubble tạo cửa sổ webcam-bubble", wins.includes("webcam-bubble"));
if (wins.includes("webcam-bubble")) {
  const wb = await attach("webcam-bubble");
  await sleep(2500);
  await wb.shot("19_webcam_bubble");
  const vp = await wb.viewport();
  const body = await wb.text();
  const hasVideo = await wb.eval(`!!document.querySelector('video')`);
  const err = await wb.eval(`document.body.innerText`);
  console.log("Webcam viewport:", vp, "| chữ:", err.replace(/\s+/g, " ").slice(0, 200));
  add("ST-05b", "Webcam Bubble: kích thước 220x220 đúng thiết kế", vp.w === 220 && vp.h === 220, `${vp.w}x${vp.h}`);
  add("ST-05c", "Không có camera/không cấp quyền → hiện thông báo lỗi thân thiện (không trống/đen)", /webcam|Camera|quyền/i.test(err) || hasVideo, err.replace(/\s+/g, " ").slice(0, 120));
  const isOpen = await wb.invoke("is_webcam_bubble_open");
  add("ST-05d", "is_webcam_bubble_open = true khi đang mở", isOpen === true);
  await wb.invoke("close_webcam_bubble");
  await sleep(800);
  const after = (await listWindows()).map((w) => w.win);
  add("ST-05e", "close_webcam_bubble đóng cửa sổ", !after.includes("webcam-bubble"));
  wb.close();
}
console.log("editor console lỗi:", ed.console.filter((c) => /EXCEPTION/i.test(c)).slice(0, 3));
ed.close();
report(rows);
