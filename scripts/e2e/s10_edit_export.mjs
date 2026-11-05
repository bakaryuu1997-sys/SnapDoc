import { attach, report, sleep } from "./cdp.mjs";
import { execFileSync } from "node:child_process";
const rows=[]; const add=(id,name,ok,note="")=>rows.push({id,name,ok,note});
const FF = "C:/Users/asus/AppData/Local/Temp/claude/40ef3781ac0a4ad3/8c62e2b3-1416-48c3-9cb1-b6449112eb18/scratchpad/e2e/ffmpeg.exe";
const OUT = "C:/Users/asus/AppData/Local/Temp/claude/8abf5ac9548e4346/8c62e2b3-1416-48c3-9cb1-b6449112eb18/scratchpad/out";
import fs from "node:fs"; fs.mkdirSync(OUT, {recursive:true});

const ed = await attach("editor");
const list = await ed.invoke("list_history", { filter: { limit: 50, offset: 0, trashOnly: false } });
const vid = list.items.find(i => i.mediaType === "video");
add("ST-09k", "Video đã vào Thư viện (nhập từ file)", !!vid, vid ? `id=${vid.id.slice(0,8)} ${vid.durationMs}ms` : "không thấy");
if (!vid) { report(rows); process.exit(0); }

// Cắt đầu 3.0s: giữ 3000..12680. Phụ đề quy đổi tay theo đúng công thức của mapCaptionsToTimeline.
const mapped = [
  { startMs: 0,    endMs: 1240, text: "Hello, this is a test of automatic captions." },
  { startMs: 1240, endMs: 4240, text: "The screen recording shows how to open" },
  { startMs: 4240, endMs: 7240, text: "the settings and connect Google Drive." },
  { startMs: 7240, endMs: 9000, text: "Thank you for watching." },
];
const probe = (f) => { try { return execFileSync(FF, ["-hide_banner","-i",f],{encoding:"utf8",stdio:["ignore","pipe","pipe"]}); } catch(e){ return String(e.stderr||e.stdout||e); } };

for (const mode of ["soft","burn"]) {
  const out = `${OUT}/edited_${mode}.mp4`;
  const t0 = Date.now();
  const r = await ed.eval(`window.__TAURI_INTERNALS__.invoke("trim_history_video", {
      id: ${JSON.stringify(vid.id)}, ranges: [[3000, 12680, 1]], removeAudio: false, outputPath: ${JSON.stringify(out)},
      overlays: null, zoomSegments: null, crop: null,
      captions: { segments: ${JSON.stringify(mapped)}, mode: ${JSON.stringify(mode)}, language: "en" }
    }).then(v => "OK:" + v.id).catch(e => "ERR:" + String(e))`);
  const secs = ((Date.now()-t0)/1000).toFixed(1);
  const exists = fs.existsSync(out);
  const info = exists ? probe(out) : "";
  const dur = (info.match(/Duration: (\d+:\d+:\d+\.\d+)/)||[])[1];
  const hasSub = /Subtitle: mov_text/.test(info);
  add(`ST-09l-${mode}`, `Xuất video ĐÃ CẮT + phụ đề (${mode}) qua trim_history_video`, r.startsWith("OK") && exists && dur && dur.startsWith("00:00:09"), `${r.slice(0,40)} ${secs}s dur=${dur} subtitleTrack=${hasSub}`);
  if (mode === "soft") add("ST-09m", "Bản soft có track phụ đề mov_text", hasSub);
  if (mode === "burn") add("ST-09n", "Bản burn KHÔNG có track phụ đề riêng (đã ghi cứng)", exists && !hasSub);
  // chụp 1 khung tại 0.6s (caption 1 phải hiện) và 5s
  if (mode === "burn" && exists) {
    execFileSync(FF, ["-y","-loglevel","error","-ss","0.6","-i",out,"-frames:v","1",`${OUT}/burn_t0_6.png`]);
    execFileSync(FF, ["-y","-loglevel","error","-ss","5.0","-i",out,"-frames:v","1",`${OUT}/burn_t5_0.png`]);
  }
}
// History có thêm 2 bản đã chỉnh sửa
const after = await ed.invoke("list_history", { filter: { limit: 50, offset: 0, trashOnly: false } });
add("ST-09o", "Mỗi lần xuất tạo 1 mục mới trong Thư viện (bản gốc giữ nguyên)", after.items.filter(i=>i.mediaType==="video").length >= 3, `video=${after.items.filter(i=>i.mediaType==="video").length}`);
ed.close(); report(rows);
