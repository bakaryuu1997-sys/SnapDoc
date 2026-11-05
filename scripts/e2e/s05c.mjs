import { attach, report, sleep } from "./cdp.mjs";
const ed = await attach("editor");
await ed.click(1826, 987);
await sleep(1500);
await ed.shot("09c_ocr_modal");
const fields = await ed.eval(`(() => { const t=[...document.querySelectorAll('textarea')].map(e=>e.value); const d=[...document.querySelectorAll('[role=dialog]')].map(e=>e.innerText); return JSON.stringify({textareas:t, dialogs:d}); })()`);
console.log(fields.slice(0, 1500));
ed.close();
