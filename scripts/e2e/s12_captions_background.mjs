// E2E thật: phụ đề chạy NỀN (popup tiến độ nhỏ, không chặn), kết quả sống sót khi đóng
// Editor giữa chừng, và tải NHIỀU model một lượt (lần lượt ở nền, đóng hộp thoại vẫn tải).
//
// Cần: bản e2e đang chạy (xem README), video thử + (tuỳ chọn) E2E_VIDEO.
// Tải thật `base` (~60 MB) + `small` (~190 MB) vào %LOCALAPPDATA%\com.snapdoc.e2etest.
import { attach, report, sleep } from "./cdp.mjs";

const rows = [];
const add = (id, name, ok, note = "") => {
  rows.push({ id, name, ok, note });
  console.log(`${ok ? "PASS" : "FAIL"}  ${id}  ${name}${note ? "  — " + note : ""}`);
};
const VIDEO =
  process.env.E2E_VIDEO ||
  "C:/Users/asus/AppData/Local/Temp/claude/40ef3781ac0a4ad3/8c62e2b3-1416-48c3-9cb1-b6449112eb18/scratchpad/e2e/test_video.mp4";

const bar = await attach("capture-bar");
// Xoá bộ nhớ đệm phụ đề của mọi video để kết quả thật sự đến từ tác vụ nền.
const clearCache = () =>
  bar.eval(`(() => { for (const k of Object.keys(localStorage)) if (k.startsWith('snapdoc.captions.v1:')) localStorage.removeItem(k); return true; })()`);
await clearCache();

async function openEditor() {
  await bar.invoke("open_video_file_path", { path: VIDEO });
  const ed = await attach("editor", 20000);
  for (let i = 0; i < 40; i++) {
    const ready = await ed
      .eval(`(() => { const v=document.querySelector('video'); return !!v && v.readyState>=2 && v.duration>0; })()`)
      .catch(() => false);
    if (ready) break;
    await sleep(500);
  }
  await sleep(1200);
  return ed;
}
/** Mở hộp thoại phụ đề và chờ tới khi nút Tạo/Tạo lại phụ đề xuất hiện (đã nạp xong trạng thái model). */
async function openGenerateModal(ed) {
  await ed.clickSel('button[title="Phụ đề tự động (AI)"]');
  for (let i = 0; i < 30; i++) {
    await sleep(300);
    const ok = await ed.eval(`[...document.querySelectorAll('[role="dialog"] button')].some(b => /^(Tạo|Tạo lại) phụ đề$/.test(b.textContent.trim()) && !b.disabled)`);
    if (ok) return;
  }
  throw new Error("Hộp thoại phụ đề không sẵn sàng (không thấy nút Tạo phụ đề)");
}
const clickGenerate = (ed) =>
  ed.eval(`(() => { const b=[...document.querySelectorAll('[role="dialog"] button')].find(b => /^(Tạo|Tạo lại) phụ đề$/.test(b.textContent.trim())); if(!b) return null; const r=b.getBoundingClientRect(); return {x:r.x+r.width/2,y:r.y+r.height/2}; })()`)
    .then((p) => { if (!p) throw new Error("không thấy nút Tạo phụ đề"); return ed.click(p.x, p.y); });
const chipText = (ed) => ed.eval(`(document.querySelector('[data-testid="captions-job-chip"]')||{}).innerText||''`);
const dialogOpen = (ed) => ed.eval(`!!document.querySelector('[role="dialog"]')`);
const setSelect = (ed, pred, value) =>
  ed.eval(`(() => { const s=[...document.querySelectorAll('select')].find(${pred}); if(!s) return false; const set=Object.getOwnPropertyDescriptor(HTMLSelectElement.prototype,'value').set; set.call(s,${JSON.stringify(value)}); s.dispatchEvent(new Event('change',{bubbles:true})); return true; })()`);

let ed = await openEditor();
// Editor có thể còn mở từ lần chạy trước (state cũ) → đóng hẳn rồi mở lại để bắt đầu sạch.
ed.invoke("close_self").catch(() => {}); // không await: cửa sổ bị huỷ nên lệnh không bao giờ trả lời
ed.close();
await sleep(1500);
ed = await openEditor();
await ed.shot("30_editor_before");

// ── 1) Màn hình cài đặt: tick NHIỀU model ──
await ed.clickSel('button[title="Phụ đề tự động (AI)"]');
for (let i = 0; i < 20; i++) {
  await sleep(300);
  if (await ed.eval(`document.querySelectorAll('[role="dialog"] input[type=checkbox]').length >= 3`)) break;
}
await ed.shot("31_setup_multi");
let txt = await ed.text();
const boxes = await ed.eval(`document.querySelectorAll('[role="dialog"] input[type=checkbox]').length`);
add("BG-01", "Cài đặt lần đầu: chọn được nhiều model (checkbox cho cả 3)", boxes >= 3, `checkbox=${boxes}`);
add("BG-02", "Nút tải ghi rõ số model + tổng dung lượng", /Tải về & cài đặt \(\d+ model/.test(txt), (txt.match(/Tải về & cài đặt \([^)]*\)/) || [""])[0]);

// Mặc định đã tick "Cân bằng"; tick thêm "Nhanh" → 2 model.
await ed.clickText("Nhanh", "label");
await sleep(300);
txt = await ed.text();
add("BG-03", "Tick 2 model → nút hiện '2 model'", /\(2 model/.test(txt), (txt.match(/Tải về & cài đặt \([^)]*\)/) || [""])[0]);
await ed.clickText("Tải về & cài đặt");

// ── 2) Đóng hộp thoại NGAY khi đang tải: vẫn tải tiếp, popup nhỏ hiện tiến độ ──
await sleep(1500);
// Đóng bằng nút ✕ (phím Esc qua CDP bị bỏ khi phần tử đang focus là nút vừa bị disable).
await ed.clickSel('[role="dialog"] button[title="Đóng"]');
await sleep(600);
add("BG-04", "Đóng hộp thoại được ngay khi đang tải model", !(await dialogOpen(ed)));
let sawChip = false;
const seen = new Set();
const t0 = Date.now();
let status = null;
for (let i = 0; i < 400; i++) {
  const c = await chipText(ed);
  if (c) {
    if (!sawChip) await ed.shot("32_chip_downloading");
    sawChip = true;
    const m = c.match(/\((\d)\/(\d)\)/);
    if (m) seen.add(`${m[1]}/${m[2]}`);
  }
  status = await ed.invoke("captions_status");
  const have = (id) => status.models.find((m) => m.id === id)?.installed;
  if (status.engineInstalled && have("base") && have("small")) break;
  await sleep(1000);
}
add("BG-05", "Popup nhỏ hiện tiến độ tải khi hộp thoại đã đóng", sawChip);
add("BG-06", "Tải LẦN LƯỢT cả 2 model trong 1 tác vụ (thấy 1/2 rồi 2/2)", seen.has("1/2") && seen.has("2/2"), [...seen].join(", "));
const both = status?.engineInstalled && status.models.find((m) => m.id === "base")?.installed && status.models.find((m) => m.id === "small")?.installed;
add("BG-07", "Engine + cả 2 model đã cài và qua kiểm tra SHA-256", !!both, `${Math.round((Date.now() - t0) / 1000)}s`);
await sleep(1500);
add("BG-08", "Popup tự biến mất khi tải xong", (await chipText(ed)) === "");

// ── 3) Tạo phụ đề NỀN: hộp thoại tự đóng, popup tiến độ, vẫn thao tác được ──
await openGenerateModal(ed);
await setSelect(ed, `x=>[...x.options].some(o=>o.value==='en')`, "en");
await setSelect(ed, `x=>[...x.options].some(o=>o.value==='base')`, "base");
await sleep(300);
await clickGenerate(ed);
await sleep(1200);
add("BG-09", "Bấm Tạo phụ đề → hộp thoại TỰ ĐÓNG (chạy nền)", !(await dialogOpen(ed)));
let chip = await chipText(ed);
let chipSeen = !!chip;
if (chipSeen) await ed.shot("33_chip_transcribing");
add("BG-10", "Popup nhỏ hiện tiến độ nhận diện", /phụ đề|âm thanh/i.test(chip), chip.replace(/\n/g, " | "));

// Trong lúc đó vẫn làm việc khác trên Editor được (không bị khoá/đơ).
const t1 = Date.now();
await ed.eval(`(() => { const v=document.querySelector('video'); v.pause(); v.currentTime = 4.0; })()`);
const ct = await ed.eval(`document.querySelector('video').currentTime`);
add("BG-11", "Editor vẫn thao tác được trong lúc nhận diện (đổi vị trí phát)", Math.abs(ct - 4) < 0.3, `phản hồi ${Date.now() - t1}ms, t=${ct}`);

let done = false;
for (let i = 0; i < 180; i++) {
  await sleep(1000);
  const c = await chipText(ed);
  if (c) chipSeen = true;
  else if (chipSeen) { done = true; break; }
}
add("BG-12", "Nhận diện xong: popup tự biến mất", done);
await sleep(1200);
await ed.shot("34_after_bg_done");
await ed.eval(`document.querySelector('video').currentTime = 2.0`);
await sleep(900);
const onPlayer = await ed.eval(`document.body.innerText.includes('Hello, this is a test')`);
add("BG-13", "Phụ đề TỰ hiện trên trình phát (không cần mở hộp thoại)", onPlayer);
const cached = await ed.eval(`Object.keys(localStorage).some(k=>k.startsWith('snapdoc.captions.v1:'))`);
add("BG-14", "Phụ đề được lưu bộ nhớ đệm theo video", cached);

// ── 4) Huỷ từ popup ──
await openGenerateModal(ed);
await clickGenerate(ed);
await sleep(1500);
let cancelled = false;
const cbtn = await ed.eval(`(() => { const c=document.querySelector('[data-testid="captions-job-chip"]'); const b=c && c.querySelector('button[aria-label]'); if(!b) return null; const r=b.getBoundingClientRect(); return {x:r.x+r.width/2,y:r.y+r.height/2}; })()`);
if (cbtn) {
  await ed.click(cbtn.x, cbtn.y);
  for (let i = 0; i < 20; i++) {
    await sleep(500);
    const j = await ed.invoke("captions_jobs");
    if (j.running.filter((r) => r.job === "transcribe").length === 0) { cancelled = true; break; }
  }
}
add("BG-15", "Nút ✕ trên popup huỷ được tác vụ nền", cancelled, cbtn ? "" : "không thấy popup/nút huỷ (có thể đã xong quá nhanh)");
await sleep(800);
const errAfterCancel = await ed.eval(`document.body.innerText.includes('Đã huỷ')`);
add("BG-16", "Huỷ không báo lỗi", !errAfterCancel);

// ── 5) Đóng Editor GIỮA CHỪNG: kết quả không mất ──
await clearCache();
await openGenerateModal(ed);
await setSelect(ed, `x=>[...x.options].some(o=>o.value==='en')`, "en");
await setSelect(ed, `x=>[...x.options].some(o=>o.value==='small')`, "small"); // small chậm hơn → kịp đóng giữa chừng
await sleep(300);
await clickGenerate(ed);
await sleep(1500);
const runningBefore = (await bar.invoke("captions_jobs")).running.filter((r) => r.job === "transcribe").length;
ed.invoke("close_self").catch(() => {});
ed.close();
await sleep(1000);
add("BG-17", "Đóng cửa sổ Editor lúc đang nhận diện: tác vụ vẫn chạy ở backend", runningBefore === 1 || (await bar.invoke("captions_jobs")).pending.length > 0, `running trước khi đóng=${runningBefore}`);
let pend = false;
for (let i = 0; i < 120; i++) {
  const j = await bar.invoke("captions_jobs");
  if (j.pending.length > 0) { pend = true; break; }
  await sleep(1000);
}
add("BG-18", "Xong khi Editor đã đóng: kết quả được backend giữ lại (chưa mất)", pend);

ed = await openEditor();
await ed.eval(`document.querySelector('video').pause(); document.querySelector('video').currentTime = 2.0`);
await sleep(1500);
await ed.shot("35_reopened_editor");
const back = await ed.eval(`document.body.innerText.includes('Hello, this is a test')`);
add("BG-19", "Mở lại Editor: phụ đề đã xong tự xuất hiện (không phải dịch lại)", back);
const pendAfter = (await bar.invoke("captions_jobs")).pending.length;
add("BG-20", "Kết quả được nhận đúng 1 lần (backend không còn giữ)", pendAfter === 0, `pending=${pendAfter}`);

console.log("console lỗi:", ed.console.filter((c) => /EXCEPTION|error/i.test(c)).slice(0, 5));
bar.close();
ed.close();
console.log("──── Tổng kết ────");
report(rows);
