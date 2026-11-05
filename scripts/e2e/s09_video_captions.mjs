import { attach, listWindows, report, sleep } from "./cdp.mjs";
const rows = [];
const add = (id, name, ok, note = "") => rows.push({ id, name, ok, note });
const SCR = "C:\\Users\\asus\\AppData\\Local\\Temp\\claude\\8abf5ac9548e4346\\8c62e2b3-1416-48c3-9cb1-b6449112eb18\\scratchpad";
const VIDEO = "C:/Users/asus/AppData/Local/Temp/claude/40ef3781ac0a4ad3/8c62e2b3-1416-48c3-9cb1-b6449112eb18/scratchpad/e2e/test_video.mp4";

const bar = await attach("capture-bar");
await bar.invoke("open_video_file_path", { path: VIDEO });
const ed = await attach("editor", 20000);
for (let i = 0; i < 40; i++) {
  const ready = await ed.eval(`(() => { const v=document.querySelector('video'); return !!v && v.readyState>=2 && v.duration>0; })()`).catch(() => false);
  if (ready) break;
  await sleep(500);
}
await sleep(1500);
await ed.shot("20_video_editor");
const dur = await ed.eval(`document.querySelector('video').duration`);
add("ST-09a", "Mở video trong Editor: phát được, đọc đúng thời lượng (~12.7s)", dur > 12 && dur < 13.5, `duration=${dur}`);
const tb = await ed.eval(`[...document.querySelectorAll('button')].map(b => (b.title||'').trim()).filter(Boolean)`);
console.log("Trimmer nút (title):", tb.slice(0, 60).join(" | "));
add("ST-09b", "Thanh công cụ video có nút Phụ đề AI (cạnh GIF)", tb.some((t) => /Phụ đề tự động/.test(t)));

// ── Mở hộp thoại phụ đề ──
await ed.clickSel('button[title="Phụ đề tự động (AI)"]');
await sleep(1200);
await ed.shot("21_captions_modal_setup");
let txt = await ed.text();
add("ST-09c", "Hộp thoại phụ đề: lần đầu hiện màn hình cài đặt (3 model, dung lượng)", /Cài đặt lần đầu/.test(txt) && /MB/.test(txt) && /Nhanh/.test(txt), (txt.match(/\d+ MB/g) || []).join(", "));

// ── Cài engine + model Nhanh (thật, ~68 MB) ──
// Mặc định tick sẵn "Cân bằng": bỏ tick nó, chỉ tick "Nhanh" để tải nhẹ (~68 MB).
await ed.clickText("Cân bằng", "label");
await sleep(200);
await ed.clickText("Nhanh", "label");
await sleep(300);
await ed.clickText("Tải về & cài đặt");
let sawProgress = false;
const t0 = Date.now();
let status = null;
for (let i = 0; i < 180; i++) {
  await sleep(1500);
  const t = await ed.text();
  if (/Đang tải engine|Đang tải model/.test(t) && /\d+%/.test(t)) {
    if (!sawProgress) await ed.shot("22_captions_downloading");
    sawProgress = true;
  }
  status = await ed.invoke("captions_status");
  if (status.engineInstalled && status.models.find((m) => m.id === "base")?.installed) break;
}
add("ST-09d", "Cài engine Whisper + model (tải thật, hiện tiến độ %)", status?.engineInstalled && status.models.find((m) => m.id === "base").installed, `${Math.round((Date.now() - t0) / 1000)}s, thấy thanh tiến độ=${sawProgress}`);
await sleep(1500);
await ed.shot("23_captions_ready");

// ── Tạo phụ đề (tiếng Anh) ──
await ed.eval(`(() => { const s=[...document.querySelectorAll('select')].find(x=>[...x.options].some(o=>o.value==='en')); const set=Object.getOwnPropertyDescriptor(HTMLSelectElement.prototype,'value').set; set.call(s,'en'); s.dispatchEvent(new Event('change',{bubbles:true})); })()`);
await sleep(300);
await ed.clickText("Tạo phụ đề");
// Chạy nền: hộp thoại tự đóng, popup tiến độ nhỏ hiện cho tới khi xong.
let chipSeen = false;
for (let i = 0; i < 120; i++) {
  await sleep(1000);
  const c = await ed.eval(`!!document.querySelector('[data-testid="captions-job-chip"]')`);
  if (c) chipSeen = true;
  else if (chipSeen) break;
}
await sleep(800);
await ed.clickSel('button[title="Phụ đề tự động (AI)"]');
await sleep(900);
let rowsText = await ed.eval(`[...document.querySelectorAll('input')].filter(i => i.type==='text' && i.value.length>3).map(i => i.value)`);
await ed.shot("24_captions_generated");
console.log("Dòng phụ đề:", JSON.stringify(rowsText));
const joined = rowsText.join(" ").toLowerCase();
add("ST-09e", "Tạo phụ đề thật: nhận đúng nội dung tiếng Anh", /test of automatic captions/.test(joined) && /google drive/.test(joined), rowsText.length + " dòng");

// ── Sửa 1 dòng (chữ) + xoá rồi hoàn trả không cần; kiểm tra sửa chữ lưu bền ──
const firstInput = await ed.eval(`(() => { const i=[...document.querySelectorAll('input')].find(i=>i.type==='text' && i.value.includes('Hello')); if(!i) return null; const r=i.getBoundingClientRect(); return {x:r.x+r.width/2,y:r.y+r.height/2}; })()`);
if (firstInput) {
  await ed.click(firstInput.x, firstInput.y);
  await ed.key("End", { vk: 35 });
  await ed.type(" (đã sửa)");
  await sleep(700);
}
const edited = await ed.eval(`[...document.querySelectorAll('input')].some(i => i.value.includes('(đã sửa)'))`);
add("ST-09f", "Sửa trực tiếp chữ phụ đề trong danh sách", edited);

// ── Đóng hộp thoại, xem phụ đề trên trình phát ──
await ed.key("Escape", { vk: 27 });
await sleep(600);
await ed.eval(`(() => { const v=document.querySelector('video'); v.pause(); v.currentTime = 2.0; })()`);
await sleep(900);
await ed.shot("25_caption_on_player");
const onPlayer = await ed.eval(`document.body.innerText.includes('Hello, this is a test')`);
add("ST-09g", "Phụ đề hiển thị ngay trên trình phát tại 0:02", onPlayer);
await ed.eval(`document.querySelector('video').currentTime = 11.0`);
await sleep(900);
const onPlayer2 = await ed.eval(`document.body.innerText.includes('Thank you for watching')`);
add("ST-09h", "Phụ đề đổi theo vị trí phát (tại 0:11 là câu cuối)", onPlayer2);

// ── Cắt đầu video tại 3.0s (phím Q) → phải ghi nhận là 'đã chỉnh sửa' ──
await ed.eval(`document.querySelector('video').currentTime = 3.0`);
await sleep(800);
await ed.key("q", { vk: 81, code: "KeyQ" });
await sleep(1000);
await ed.shot("26_after_trim_head");
const timeText = await ed.eval(`(document.body.innerText.match(/\\d+:\\d{2}\\s*\\/\\s*\\d+:\\d{2}/) || [''])[0]`);
console.log("Đồng hồ trimmer sau khi cắt đầu:", timeText);
add("ST-09i", "Phím Q cắt đầu: tổng thời lượng timeline ngắn lại (~0:09)", /\/\s*0:09|\/\s*0:10/.test(timeText), timeText);

await ed.clickSel('button[title="Phụ đề tự động (AI)"]');
await sleep(1000);
await ed.shot("27_captions_modal_edited");
txt = await ed.text();
add("ST-09j", "Hộp thoại phụ đề nhận biết video đã chỉnh sửa (gợi ý + tuỳ chọn khớp .srt)", /Video có chỉnh sửa/.test(txt) && /khớp với video đã chỉnh sửa/i.test(txt));

console.log("console lỗi:", ed.console.filter((c) => /EXCEPTION|error/i.test(c)).slice(0, 5));
bar.close(); ed.close();
report(rows);
