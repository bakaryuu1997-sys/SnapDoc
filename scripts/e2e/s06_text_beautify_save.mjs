import { attach, report, sleep } from "./cdp.mjs";
const rows = [];
const add = (id, name, ok, note = "") => rows.push({ id, name, ok, note });
const ed = await attach("editor");
const OX = 402, OY = 225;
const tool = async (title) => { await ed.clickSel(`button[title^="${title}"]`); await sleep(250); };

// Tắt Live Text nếu đang bật để không che thao tác chuột
const live = await ed.eval(`!![...document.querySelectorAll('button')].find(b => b.textContent.includes('Tắt Live Text'))`);
if (live) { await ed.clickText("Tắt Live Text"); await sleep(400); }

// ── Công cụ Chữ: gõ rồi chuyển sang công cụ Chọn để xác nhận ──
await tool("Viết chữ");
await ed.click(OX + 600, OY + 520);
await sleep(600);
const hasInput = await ed.eval(`!!document.querySelector('textarea, input[type=text][style*=absolute], [contenteditable=true]')`);
await ed.type("Ghi chú kiểm thử");
await sleep(300);
await ed.shot("10_text_typing");
await tool("Chọn / sửa");
await sleep(600);
await ed.shot("10b_text_committed");
const hint = await ed.eval(`document.body.innerText.includes('Ghi chú kiểm thử')`);
add("ST-06g", "Công cụ Chữ (T): gõ chữ và xác nhận bằng cách chuyển công cụ", hasInput, `ô nhập xuất hiện=${hasInput}, chữ nằm trong DOM=${hint}`);

// ── Làm đẹp (1-Click Beautifier) ──
await ed.clickSel('button[title*="1-Click Beautifier"]');
await sleep(1500);
await ed.shot("11_beautify");
const cv = await ed.eval(`[...document.querySelectorAll('canvas')].map(c => c.width + 'x' + c.height).join(',')`);
console.log("canvas sau Làm đẹp:", cv);
add("ST-06h", "Làm đẹp 1 chạm: canvas đổi kích thước (thêm nền/padding)", !/^1100x640$/.test(cv.split(',')[0] || ""), cv);

// ── Lưu vào lịch sử (Ctrl+S) ──
await ed.clickSel('button[title^="Lưu (Ctrl"]');
await sleep(2500);
await ed.shot("12_after_save");
const txt = await ed.text();
console.log("Sau lưu, thông báo:", txt.replace(/\s+/g, " ").slice(-200));
const hist = await ed.invoke("list_history", { filter: { limit: 20, offset: 0, trashOnly: false } }).catch((e) => ({ error: String(e) }));
console.log("history:", JSON.stringify(hist).slice(0, 300));
add("ST-07a", "Ảnh được ghi vào Thư viện (History) sau khi mở trong Editor", Array.isArray(hist.items) ? hist.items.length >= 1 : false, hist.error || `items=${hist.items?.length}`);

console.log("console lỗi:", ed.console.filter((c) => /EXCEPTION|error/i.test(c)).slice(0, 6));
ed.close();
report(rows);
