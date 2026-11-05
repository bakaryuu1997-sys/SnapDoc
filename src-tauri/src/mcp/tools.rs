//! Thực thi tool MCP trên app thật. Mọi tool ở đây TÁI DỤNG hàm có sẵn của Library
//! (`history::commands::*_sync`), trình cắt/ghép video (`record::encoder`) và module
//! phụ đề (`captions`) — không viết lại logic. Việc kiểm tra quyền/nhật ký đã làm ở
//! `protocol::call_tool` trước khi vào đây.

use super::jobs::run_with_wait;
use super::protocol::{json_block, text_block, Host, McpState};
use crate::captions::{self, CaptionSegment};
use crate::history::commands as hc;
use crate::history::model::{HistoryFilter, HistoryRecord};
use crate::record::encoder::VideoCrop;
use serde_json::{json, Value};
use std::path::{Path, PathBuf};
use std::sync::Arc;
use std::time::Duration;
use tauri::{AppHandle, Emitter, Manager};

type Out = Result<Vec<Value>, String>;

/// Thời gian tối đa 1 lời gọi chờ tác vụ nền trước khi trả `jobId` (client MCP thường timeout ~60s).
const WAIT: Duration = Duration::from_secs(40);
const VIDEO_EXTS: &[&str] = &["mp4", "mov", "m4v", "webm", "mkv", "avi"];

pub struct AppHost {
    pub app: AppHandle,
    pub state: Arc<McpState>,
}

// ───────────────────────── tham số ─────────────────────────

fn req_str<'a>(args: &'a Value, k: &str) -> Result<&'a str, String> {
    args.get(k)
        .and_then(|v| v.as_str())
        .filter(|s| !s.trim().is_empty())
        .ok_or_else(|| format!("Thiếu tham số bắt buộc: {k}"))
}

fn opt_str<'a>(args: &'a Value, k: &str) -> Option<&'a str> {
    args.get(k).and_then(|v| v.as_str()).filter(|s| !s.trim().is_empty())
}

fn opt_bool(args: &Value, k: &str) -> bool {
    args.get(k).and_then(|v| v.as_bool()).unwrap_or(false)
}

fn opt_i64(args: &Value, k: &str) -> Option<i64> {
    args.get(k).and_then(|v| v.as_f64()).map(|f| f.round() as i64)
}

/// `keepRanges` → [(startMs, endMs, speed)]. Kiểm tra chặt để không đẩy tham số vô nghĩa xuống ffmpeg.
pub fn parse_ranges(v: Option<&Value>, duration_ms: i64) -> Result<Vec<(i64, i64, f64)>, String> {
    let arr = v
        .and_then(|x| x.as_array())
        .filter(|a| !a.is_empty())
        .ok_or("keepRanges phải là mảng không rỗng, mỗi phần tử [startMs, endMs] hoặc [startMs, endMs, speed]")?;
    if arr.len() > 200 {
        return Err("Tối đa 200 đoạn trong keepRanges".into());
    }
    let mut out = Vec::new();
    for (i, r) in arr.iter().enumerate() {
        let a = r.as_array().filter(|a| a.len() == 2 || a.len() == 3).ok_or(format!("keepRanges[{i}] phải có 2 hoặc 3 số"))?;
        let n: Option<Vec<f64>> = a.iter().map(|x| x.as_f64()).collect();
        let n = n.ok_or(format!("keepRanges[{i}] chứa giá trị không phải số"))?;
        let (s, mut e) = (n[0].round() as i64, n[1].round() as i64);
        let speed = if n.len() == 3 { n[2] } else { 1.0 };
        if s < 0 || e <= s {
            return Err(format!("keepRanges[{i}]: cần 0 <= startMs < endMs (nhận {s}..{e})"));
        }
        if duration_ms > 0 {
            if s >= duration_ms {
                return Err(format!("keepRanges[{i}]: startMs {s} vượt quá thời lượng video ({duration_ms} ms)"));
            }
            if e > duration_ms {
                if e - duration_ms > 1000 {
                    return Err(format!("keepRanges[{i}]: endMs {e} vượt quá thời lượng video ({duration_ms} ms)"));
                }
                e = duration_ms;
            }
        }
        if !(0.25..=8.0).contains(&speed) {
            return Err(format!("keepRanges[{i}]: speed phải trong khoảng 0.25–8 (nhận {speed})"));
        }
        out.push((s, e, speed));
    }
    Ok(out)
}

/// Dựng danh sách đoạn cho `change_speed` (cả video hoặc chỉ khoảng start..end).
pub fn speed_ranges(duration_ms: i64, speed: f64, start: Option<i64>, end: Option<i64>) -> Result<Vec<(i64, i64, f64)>, String> {
    if !(0.25..=8.0).contains(&speed) {
        return Err(format!("speed phải trong khoảng 0.25–8 (nhận {speed})"));
    }
    if duration_ms <= 0 {
        return Err("Không biết thời lượng video nên không đổi tốc độ được.".into());
    }
    let s = start.unwrap_or(0);
    let e = end.unwrap_or(duration_ms).min(duration_ms);
    if s < 0 || e <= s || s >= duration_ms {
        return Err(format!("Khoảng thời gian không hợp lệ: {s}..{e} (video dài {duration_ms} ms)"));
    }
    let mut v = Vec::new();
    if s > 0 {
        v.push((0, s, 1.0));
    }
    v.push((s, e, speed));
    if e < duration_ms {
        v.push((e, duration_ms, 1.0));
    }
    Ok(v)
}

pub fn check_crop(c: VideoCrop, w: u32, h: u32) -> Result<VideoCrop, String> {
    if c.width < 2 || c.height < 2 {
        return Err("Vùng crop quá nhỏ (tối thiểu 2×2 px)".into());
    }
    if c.x.checked_add(c.width).map(|v| v > w).unwrap_or(true) || c.y.checked_add(c.height).map(|v| v > h).unwrap_or(true) {
        return Err(format!("Vùng crop vượt ngoài khung hình {w}×{h}"));
    }
    Ok(c)
}

fn parse_crop(v: &Value) -> Result<VideoCrop, String> {
    serde_json::from_value::<VideoCrop>(v.clone()).map_err(|_| "crop cần {x, y, width, height} là số nguyên không âm".to_string())
}

// ───────────────────────── đường dẫn ─────────────────────────

#[cfg(windows)]
fn strip_verbatim(p: PathBuf) -> PathBuf {
    let s = p.to_string_lossy().to_string();
    if let Some(rest) = s.strip_prefix(r"\\?\") {
        if !rest.starts_with("UNC\\") {
            return PathBuf::from(rest);
        }
    }
    p
}
#[cfg(not(windows))]
fn strip_verbatim(p: PathBuf) -> PathBuf {
    p
}

/// Kiểm tra đường dẫn ĐẦU RA do agent đưa: tuyệt đối, đúng đuôi, CHƯA tồn tại (không ghi đè
/// file có sẵn), thư mục cha tồn tại và nằm trong một thư mục được phép.
pub fn check_output_path(requested: &str, ext: &str, roots: &[PathBuf]) -> Result<PathBuf, String> {
    let p = PathBuf::from(requested);
    if !p.is_absolute() {
        return Err("outputPath phải là đường dẫn tuyệt đối".into());
    }
    let ok_ext = p.extension().and_then(|e| e.to_str()).map(|e| e.eq_ignore_ascii_case(ext)).unwrap_or(false);
    if !ok_ext {
        return Err(format!("outputPath phải có đuôi .{ext}"));
    }
    if p.exists() {
        return Err("outputPath đã tồn tại — SnapDoc không ghi đè file có sẵn qua MCP; hãy chọn tên khác".into());
    }
    let name = p.file_name().ok_or("outputPath thiếu tên file")?.to_owned();
    let parent = p.parent().ok_or("outputPath thiếu thư mục")?;
    let parent = std::fs::canonicalize(parent)
        .map(strip_verbatim)
        .map_err(|_| "Thư mục chứa outputPath không tồn tại".to_string())?;
    let allowed = roots.iter().map(|r| strip_verbatim(r.clone())).any(|r| parent.starts_with(&r));
    if !allowed {
        return Err("outputPath nằm ngoài các thư mục được phép (thư mục lưu của SnapDoc, thư mục chứa video gốc, Videos/Downloads/Desktop/Documents/Pictures)".into());
    }
    Ok(parent.join(name))
}

fn allowed_roots(app: &AppHandle, source: Option<&Path>) -> Vec<PathBuf> {
    let mut v: Vec<PathBuf> = Vec::new();
    if let Ok(d) = crate::record::resolve_save_dir(app) {
        v.push(d);
    }
    if let Some(p) = source.and_then(|s| s.parent()) {
        v.push(p.to_path_buf());
    }
    let r = app.path();
    for d in [r.video_dir(), r.download_dir(), r.desktop_dir(), r.document_dir(), r.picture_dir()] {
        if let Ok(p) = d {
            v.push(p);
        }
    }
    v.into_iter().filter_map(|p| std::fs::canonicalize(p).ok()).collect()
}

fn resolve_out(app: &AppHandle, requested: Option<&str>, ext: &str, source: &Path) -> Result<Option<PathBuf>, String> {
    match requested {
        None => Ok(None),
        Some(r) => check_output_path(r, ext, &allowed_roots(app, Some(source))).map(Some),
    }
}

/// `<tên video>.srt` cạnh video; trùng thì thêm hậu tố (không ghi đè).
pub fn default_srt_path(video: &Path) -> PathBuf {
    let stem = video.file_stem().map(|s| s.to_string_lossy().to_string()).unwrap_or_else(|| "captions".into());
    crate::storage::save::dedupe(video.with_file_name(format!("{stem}.srt")))
}

// ───────────────────────── tiện ích Library ─────────────────────────

fn live_item(app: &AppHandle, id: &str) -> Result<HistoryRecord, String> {
    let rec = hc::get_history_item_sync(app, id)?;
    if rec.deleted_at.is_some() {
        return Err("Mục này đang ở Thùng rác — dùng restore_item trước.".into());
    }
    Ok(rec)
}

fn live_video(app: &AppHandle, id: &str) -> Result<HistoryRecord, String> {
    let rec = live_item(app, id)?;
    if rec.media_type != "video" {
        return Err("Chỉ áp dụng cho video.".into());
    }
    if !Path::new(&rec.asset_path).is_file() {
        return Err(format!("File video không còn trên đĩa: {}", rec.asset_path));
    }
    Ok(rec)
}

fn rec_json(r: &HistoryRecord) -> Value {
    serde_json::to_value(r).unwrap_or(Value::Null)
}

fn changed(app: &AppHandle) {
    let _ = app.emit("history:changed", ());
}

fn stash_captions(st: &McpState, id: &str, lang: &str, segs: &[CaptionSegment]) {
    let mut g = st.captions.lock().unwrap_or_else(|e| e.into_inner());
    if g.len() >= 20 {
        if let Some(k) = g.keys().next().cloned() {
            g.remove(&k);
        }
    }
    g.insert(id.to_string(), json!({"language": lang, "segments": segs}));
}

fn stored_captions(st: &McpState, id: &str) -> Result<(String, Vec<CaptionSegment>), String> {
    let g = st.captions.lock().unwrap_or_else(|e| e.into_inner());
    let v = g.get(id).ok_or("Chưa có phụ đề cho mục này trong phiên hiện tại. Hãy chạy generate_captions trước.")?;
    let lang = v["language"].as_str().unwrap_or("auto").to_string();
    let segs: Vec<CaptionSegment> = serde_json::from_value(v["segments"].clone()).map_err(|e| e.to_string())?;
    Ok((lang, segs))
}

// ───────────────────────── Host ─────────────────────────

impl Host for AppHost {
    fn confirm(&self, client: &str, tool: &str, args: &Value) -> bool {
        use tauri_plugin_dialog::{DialogExt, MessageDialogButtons, MessageDialogKind};
        let id = args.get("id").and_then(|v| v.as_str()).unwrap_or("");
        let target = match hc::get_history_item_sync(&self.app, id) {
            Ok(r) => format!(
                "“{}” ({})\n{}",
                r.title.clone().filter(|t| !t.is_empty()).unwrap_or_else(|| "không tên".into()),
                r.media_type,
                r.asset_path
            ),
            Err(_) => format!("(mục {id})"),
        };
        let action = if tool == "delete_to_trash" {
            "Chuyển mục này vào THÙNG RÁC (khôi phục được trong 30 ngày)."
        } else {
            "GHI ĐÈ lên file video GỐC bằng bản đã chỉnh sửa. Bản gốc sẽ MẤT, không khôi phục được."
        };
        let who = if client.is_empty() { "một AI agent" } else { client };
        let msg = format!("{who} (qua MCP) yêu cầu:\n\n{action}\n\n{target}\n\nBạn có cho phép không?");
        let (tx, rx) = std::sync::mpsc::channel();
        self.app
            .dialog()
            .message(msg)
            .title("SnapDoc — AI agent xin xác nhận")
            .kind(MessageDialogKind::Warning)
            .buttons(MessageDialogButtons::OkCancelCustom("Cho phép".into(), "Từ chối".into()))
            .show(move |ok| {
                let _ = tx.send(ok);
            });
        rx.recv_timeout(Duration::from_secs(120)).unwrap_or(false)
    }

    fn exec(&self, tool: &str, args: &Value) -> Out {
        let (app, st) = (&self.app, &self.state);
        match tool {
            "app_status" => app_status(app, st),
            "list_history" => list_history(app, args),
            "get_item" => {
                let r = hc::get_history_item_sync(app, req_str(args, "id")?)?;
                Ok(vec![json_block(&rec_json(&r))])
            }
            "get_preview" => get_preview(app, req_str(args, "id")?),
            "get_captions" => {
                let id = req_str(args, "id")?;
                let (lang, segs) = stored_captions(st, id)?;
                Ok(vec![json_block(&json!({"language": lang, "segmentCount": segs.len(), "segments": segs, "srt": captions::format_srt(&segs)}))])
            }
            "captions_status" => Ok(vec![json_block(&json!({
                "status": captions::captions_status(app.clone()),
                "jobs": captions::captions_jobs(),
            }))]),
            "get_job" => {
                let id = req_str(args, "jobId")?;
                let secs = opt_i64(args, "waitSeconds").unwrap_or(0).clamp(0, 45) as u64;
                let j = st.jobs.wait(id, Duration::from_secs(secs)).ok_or("Không có tác vụ với jobId này (đã hết hạn hoặc sai).")?;
                Ok(vec![json_block(&j.to_json())])
            }
            "get_activity_log" => {
                let n = opt_i64(args, "limit").unwrap_or(30).clamp(1, 200) as usize;
                Ok(vec![json_block(&json!({"entries": st.audit.tail(n)}))])
            }
            "import_video" => import_video(self, args),
            "open_in_editor" => {
                let id = req_str(args, "id")?;
                live_item(app, id)?;
                hc::open_history_item_in_editor_sync(app, id)?;
                Ok(vec![text_block("Đã mở trong Editor.")])
            }
            "rename_item" => {
                let id = req_str(args, "id")?;
                let title = args.get("title").and_then(|v| v.as_str()).ok_or("Thiếu tham số bắt buộc: title")?;
                live_item(app, id)?;
                hc::rename_history_item_sync(app, id, title.trim())?;
                changed(app);
                Ok(vec![json_block(&rec_json(&hc::get_history_item_sync(app, id)?))])
            }
            "trim_video" => {
                let rec = live_video(app, req_str(args, "id")?)?;
                let ranges = parse_ranges(args.get("keepRanges"), rec.duration_ms.unwrap_or(0))?;
                let crop = match args.get("crop") {
                    Some(c) if !c.is_null() => Some(check_crop(parse_crop(c)?, rec.width, rec.height)?),
                    _ => None,
                };
                edit_video(self, tool, args, rec, ranges, crop)
            }
            "crop_video" => {
                let rec = live_video(app, req_str(args, "id")?)?;
                let get = |k: &str| opt_i64(args, k).filter(|v| *v >= 0).map(|v| v as u32).ok_or(format!("Thiếu/sai tham số: {k}"));
                let crop = check_crop(VideoCrop { x: get("x")?, y: get("y")?, width: get("width")?, height: get("height")? }, rec.width, rec.height)?;
                let dur = rec.duration_ms.unwrap_or(0);
                edit_video(self, tool, args, rec, vec![(0, dur.max(1), 1.0)], Some(crop))
            }
            "change_speed" => {
                let rec = live_video(app, req_str(args, "id")?)?;
                let speed = args.get("speed").and_then(|v| v.as_f64()).ok_or("Thiếu tham số bắt buộc: speed")?;
                let ranges = speed_ranges(rec.duration_ms.unwrap_or(0), speed, opt_i64(args, "startMs"), opt_i64(args, "endMs"))?;
                edit_video(self, tool, args, rec, ranges, None)
            }
            "captions_setup" => {
                let models: Vec<String> = args
                    .get("models")
                    .and_then(|v| v.as_array())
                    .map(|a| a.iter().filter_map(|x| x.as_str().map(String::from)).collect())
                    .filter(|v: &Vec<String>| !v.is_empty())
                    .unwrap_or_else(|| vec!["base".into()]);
                tauri::async_runtime::block_on(captions::captions_setup(app.clone(), models.clone()))?;
                Ok(vec![json_block(&json!({"started": true, "models": models, "note": "Đang tải ở nền. Dùng captions_status để xem tiến độ/đã cài chưa."}))])
            }
            "generate_captions" => generate_captions(self, args),
            "export_srt" => {
                let id = req_str(args, "id")?;
                let rec = live_video(app, id)?;
                let (_, segs) = stored_captions(st, id)?;
                let video = Path::new(&rec.asset_path);
                let out = match resolve_out(app, opt_str(args, "outputPath"), "srt", video)? {
                    Some(p) => p,
                    None => default_srt_path(video),
                };
                let saved = captions::captions_save_srt(out.to_string_lossy().to_string(), segs)?;
                Ok(vec![json_block(&json!({"srtPath": saved}))])
            }
            "add_captions_to_video" => add_captions(self, args),
            "restore_item" => {
                let id = req_str(args, "id")?;
                let rec = hc::get_history_item_sync(app, id)?;
                if rec.deleted_at.is_none() {
                    return Ok(vec![text_block("Mục này không nằm trong Thùng rác.")]);
                }
                hc::restore_history_item_sync(app, id)?;
                changed(app);
                Ok(vec![text_block("Đã khôi phục.")])
            }
            "delete_to_trash" => {
                let id = req_str(args, "id")?;
                let rec = live_item(app, id)?;
                hc::delete_history_item_sync(app, id)?;
                changed(app);
                Ok(vec![json_block(&json!({"movedToTrash": true, "id": id, "title": rec.title, "note": "Khôi phục được bằng restore_item trong 30 ngày."}))])
            }
            other => Err(format!("Tool chưa được hỗ trợ: {other}")),
        }
    }
}

// ───────────────────────── từng tool ─────────────────────────

fn count(app: &AppHandle, media: Option<&str>, trash: bool) -> i64 {
    hc::list_history_sync(
        app,
        HistoryFilter { from: None, to: None, capture_mode: None, media_type: media.map(String::from), trash_only: trash, limit: 1, offset: 0 },
    )
    .map(|p| p.total)
    .unwrap_or(-1)
}

fn app_status(app: &AppHandle, st: &Arc<McpState>) -> Out {
    let cfg = st.cfg();
    Ok(vec![json_block(&json!({
        "app": "SnapDoc",
        "version": env!("CARGO_PKG_VERSION"),
        "platform": std::env::consts::OS,
        "writePermission": cfg.write_enabled,
        "writePermissionNote": if cfg.write_enabled { "ON: tool ghi hoạt động; xoá/ghi đè gốc vẫn cần người dùng xác nhận trong app." } else { "OFF: chỉ đọc. Người dùng bật trong SnapDoc → Cài đặt → AI Agent (MCP)." },
        "library": {
            "total": count(app, None, false),
            "videos": count(app, Some("video"), false),
            "images": count(app, Some("image"), false),
            "trash": count(app, None, true),
        },
        "captions": { "status": captions::captions_status(app.clone()), "jobs": captions::captions_jobs() },
    }))])
}

fn list_history(app: &AppHandle, args: &Value) -> Out {
    let media = opt_str(args, "mediaType");
    if let Some(m) = media {
        if m != "image" && m != "video" {
            return Err("mediaType phải là image hoặc video".into());
        }
    }
    let page = hc::list_history_sync(
        app,
        HistoryFilter {
            from: None,
            to: None,
            capture_mode: opt_str(args, "captureMode").map(String::from),
            media_type: media.map(String::from),
            trash_only: opt_bool(args, "trash"),
            limit: opt_i64(args, "limit").unwrap_or(20).clamp(1, 100),
            offset: opt_i64(args, "offset").unwrap_or(0).max(0),
        },
    )?;
    Ok(vec![json_block(&json!({"total": page.total, "items": page.items}))])
}

fn get_preview(app: &AppHandle, id: &str) -> Out {
    use base64::{engine::general_purpose::STANDARD, Engine};
    let rec = live_item(app, id)?;
    let (bytes, mime) = if rec.media_type == "video" {
        (std::fs::read(&rec.thumb_path).map_err(|e| format!("Không đọc được thumbnail: {e}"))?, "image/jpeg")
    } else {
        let png = hc::load_asset_preview(&rec)?;
        let img = image::load_from_memory(&png).map_err(|e| format!("Không giải mã được ảnh: {e}"))?;
        if img.width().max(img.height()) > 1600 || png.len() > 3_000_000 {
            let small = img.thumbnail(1600, 1600);
            let mut buf = std::io::Cursor::new(Vec::new());
            small.write_to(&mut buf, image::ImageFormat::Png).map_err(|e| e.to_string())?;
            (buf.into_inner(), "image/png")
        } else {
            (png, "image/png")
        }
    };
    Ok(vec![
        json!({"type": "image", "data": STANDARD.encode(&bytes), "mimeType": mime}),
        text_block(format!(
            "{} · {}×{}{}",
            rec.media_type,
            rec.width,
            rec.height,
            rec.duration_ms.map(|d| format!(" · {} ms", d)).unwrap_or_default()
        )),
    ])
}

fn import_video(h: &AppHost, args: &Value) -> Out {
    let path = req_str(args, "path")?.to_string();
    let p = PathBuf::from(&path);
    if !p.is_absolute() {
        return Err("path phải là đường dẫn tuyệt đối".into());
    }
    let ok = p.extension().and_then(|e| e.to_str()).map(|e| VIDEO_EXTS.contains(&e.to_ascii_lowercase().as_str())).unwrap_or(false);
    if !ok {
        return Err(format!("Định dạng không hỗ trợ. Chấp nhận: {}", VIDEO_EXTS.join(", ")));
    }
    let open = opt_bool(args, "openInEditor");
    let app = h.app.clone();
    let v = run_with_wait(&h.state.jobs, "import_video", WAIT, move || {
        let (rec, is_new) = crate::commands::ingest_video_path_sync(&app, &path)?;
        if is_new {
            let _ = app.emit("history:item-added", &rec);
        }
        if open {
            crate::commands::open_video_record_in_editor(&app, &rec)?;
        }
        Ok(json!({"item": rec, "alreadyInLibrary": !is_new, "openedInEditor": open}))
    })?;
    Ok(vec![json_block(&v)])
}

/// Dùng chung cho trim_video / crop_video / change_speed.
fn edit_video(h: &AppHost, tool: &str, args: &Value, rec: HistoryRecord, ranges: Vec<(i64, i64, f64)>, crop: Option<VideoCrop>) -> Out {
    let remove_audio = opt_bool(args, "removeAudio");
    let replace = opt_bool(args, "replaceOriginal");
    let out = if replace { None } else { resolve_out(&h.app, opt_str(args, "outputPath"), "mp4", Path::new(&rec.asset_path))? };
    if replace && opt_str(args, "outputPath").is_some() {
        return Err("Không dùng outputPath cùng replaceOriginal".into());
    }
    let app = h.app.clone();
    let id = rec.id.clone();
    let v = run_with_wait(&h.state.jobs, tool, WAIT, move || {
        if replace {
            let r = hc::overwrite_history_video_sync(&app, &id, &ranges, remove_audio, None, None, crop)?;
            changed(&app);
            Ok(json!({"item": r, "replacedOriginal": true}))
        } else {
            let r = hc::trim_history_video_sync(
                &app,
                &id,
                &ranges,
                remove_audio,
                out.as_ref().map(|p| p.to_string_lossy().to_string()).as_deref(),
                None,
                None,
                crop,
                None,
            )?;
            let _ = app.emit("history:item-added", &r);
            Ok(json!({"item": r, "originalUntouched": true}))
        }
    })?;
    Ok(vec![json_block(&v)])
}

fn generate_captions(h: &AppHost, args: &Value) -> Out {
    let id = req_str(args, "id")?.to_string();
    let rec = live_video(&h.app, &id)?;
    let lang = opt_str(args, "language").unwrap_or("auto").to_string();
    let model = opt_str(args, "model").unwrap_or("base").to_string();
    let save_srt = opt_bool(args, "saveSrt");
    let (app, state) = (h.app.clone(), h.state.clone());
    let path = rec.asset_path.clone();
    let v = run_with_wait(&h.state.jobs, "generate_captions", WAIT, move || {
        tauri::async_runtime::block_on(captions::captions_transcribe_start(app.clone(), path.clone(), lang, model))?;
        // Chờ kết quả do chính job này tạo ra (registry giữ kết quả tới khi có người nhận).
        let outcome = loop {
            let snap = captions::captions_jobs();
            if snap.pending.iter().any(|p| p == &path) {
                break captions::captions_take_outcome(path.clone()).ok_or("Mất kết quả nhận diện")?;
            }
            let running = snap.running.iter().any(|j| j.job == "transcribe" && j.video_path.as_deref() == Some(path.as_str()));
            if !running {
                return Err("Nhận diện phụ đề đã bị huỷ hoặc dừng bất thường.".to_string());
            }
            std::thread::sleep(Duration::from_millis(500));
        };
        if !outcome.ok {
            return Err(outcome.error.unwrap_or_else(|| "Nhận diện phụ đề thất bại".into()));
        }
        stash_captions(&state, &id, &outcome.language, &outcome.segments);
        let mut res = json!({
            "language": outcome.language,
            "segmentCount": outcome.segments.len(),
            "preview": outcome.segments.iter().take(5).collect::<Vec<_>>(),
            "note": "Dùng get_captions để lấy toàn bộ, export_srt để lưu .srt, add_captions_to_video để nhúng vào video.",
        });
        if save_srt {
            let out = default_srt_path(Path::new(&path));
            let saved = captions::captions_save_srt(out.to_string_lossy().to_string(), outcome.segments.clone())?;
            res["srtPath"] = Value::String(saved);
        }
        Ok(res)
    })?;
    Ok(vec![json_block(&v)])
}

fn add_captions(h: &AppHost, args: &Value) -> Out {
    let id = req_str(args, "id")?.to_string();
    let rec = live_video(&h.app, &id)?;
    let (lang, segs) = stored_captions(&h.state, &id)?;
    let mode = opt_str(args, "mode").unwrap_or("soft").to_string();
    if mode != "soft" && mode != "burn" {
        return Err("mode phải là soft hoặc burn".into());
    }
    let lang = if lang == "auto" { "und".to_string() } else { lang };
    let out = match resolve_out(&h.app, opt_str(args, "outputPath"), "mp4", Path::new(&rec.asset_path))? {
        Some(p) => p,
        None => crate::record::new_output_path(&h.app)?,
    };
    let app = h.app.clone();
    let v = run_with_wait(&h.state.jobs, "add_captions_to_video", WAIT, move || {
        let dur = rec.duration_ms.unwrap_or(0).max(0) as u64;
        let saved = tauri::async_runtime::block_on(captions::captions_export_video(
            app.clone(),
            rec.asset_path.clone(),
            out.to_string_lossy().to_string(),
            segs,
            mode,
            lang,
            dur,
        ))?;
        let item = crate::history::ingest_video(&app, Path::new(&saved), rec.width, rec.height, dur as i64, &rec.capture_mode)?;
        let _ = app.emit("history:item-added", &item);
        Ok(json!({"item": item, "originalUntouched": true}))
    })?;
    Ok(vec![json_block(&v)])
}

#[cfg(test)]
mod tests {
    use super::*;

    fn tmp(name: &str) -> PathBuf {
        let d = std::env::temp_dir().join(format!("snapdoc-tools-{name}-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&d);
        std::fs::create_dir_all(&d).unwrap();
        d
    }

    #[test]
    fn ranges_valid_and_invalid() {
        let r = parse_ranges(Some(&json!([[0, 1000], [2000, 3000, 2.0]])), 5000).unwrap();
        assert_eq!(r, vec![(0, 1000, 1.0), (2000, 3000, 2.0)]);
        // endMs vượt nhẹ được kẹp về thời lượng
        assert_eq!(parse_ranges(Some(&json!([[0, 5400]])), 5000).unwrap(), vec![(0, 5000, 1.0)]);
        for bad in [json!([]), json!([[5, 5]]), json!([[-1, 5]]), json!([[0, 1, 99]]), json!([["a", 1]]), json!([[0]]), json!([[9000, 9500]]), json!([[0, 99999]]), json!("x")] {
            assert!(parse_ranges(Some(&bad), 5000).is_err(), "{bad}");
        }
        assert!(parse_ranges(None, 5000).is_err());
        // thời lượng không biết (0) → không kiểm tra trần
        assert!(parse_ranges(Some(&json!([[0, 99999]])), 0).is_ok());
    }

    #[test]
    fn speed_ranges_cover_whole_video() {
        assert_eq!(speed_ranges(10_000, 2.0, None, None).unwrap(), vec![(0, 10_000, 2.0)]);
        assert_eq!(
            speed_ranges(10_000, 0.5, Some(2000), Some(4000)).unwrap(),
            vec![(0, 2000, 1.0), (2000, 4000, 0.5), (4000, 10_000, 1.0)]
        );
        assert!(speed_ranges(10_000, 20.0, None, None).is_err());
        assert!(speed_ranges(10_000, 2.0, Some(5000), Some(1000)).is_err());
        assert!(speed_ranges(0, 2.0, None, None).is_err());
    }

    #[test]
    fn crop_bounds() {
        assert!(check_crop(VideoCrop { x: 0, y: 0, width: 100, height: 100 }, 1920, 1080).is_ok());
        assert!(check_crop(VideoCrop { x: 1900, y: 0, width: 100, height: 100 }, 1920, 1080).is_err());
        assert!(check_crop(VideoCrop { x: 0, y: 0, width: 1, height: 100 }, 1920, 1080).is_err());
        assert!(check_crop(VideoCrop { x: u32::MAX, y: 0, width: 10, height: 10 }, 1920, 1080).is_err(), "tràn số");
        assert!(parse_crop(&json!({"x": -1, "y": 0, "width": 5, "height": 5})).is_err());
    }

    #[test]
    fn output_path_rules() {
        let root = tmp("out-root");
        let other = tmp("out-other");
        let roots = vec![std::fs::canonicalize(&root).unwrap()];
        let ok = root.join("clip.mp4");
        assert!(check_output_path(ok.to_str().unwrap(), "mp4", &roots).is_ok());
        assert!(check_output_path(ok.to_str().unwrap().to_uppercase().as_str(), "mp4", &roots).is_err() || cfg!(windows), "khác hoa/thường trên FS phân biệt");
        // sai đuôi, tương đối, ngoài thư mục cho phép, thư mục cha không tồn tại
        assert!(check_output_path(root.join("a.exe").to_str().unwrap(), "mp4", &roots).is_err());
        assert!(check_output_path("clip.mp4", "mp4", &roots).is_err());
        assert!(check_output_path(other.join("a.mp4").to_str().unwrap(), "mp4", &roots).is_err());
        assert!(check_output_path(root.join("missing").join("a.mp4").to_str().unwrap(), "mp4", &roots).is_err());
        // `..` để thoát khỏi thư mục cho phép
        let escape = root.join("..").join(other.file_name().unwrap()).join("a.mp4");
        assert!(check_output_path(escape.to_str().unwrap(), "mp4", &roots).is_err(), "path traversal");
        // không ghi đè file có sẵn
        std::fs::write(root.join("exists.mp4"), b"x").unwrap();
        assert!(check_output_path(root.join("exists.mp4").to_str().unwrap(), "mp4", &roots).is_err());
        let _ = std::fs::remove_dir_all(&root);
        let _ = std::fs::remove_dir_all(&other);
    }

    #[test]
    fn srt_default_path_never_overwrites() {
        let d = tmp("srt");
        let v = d.join("movie.mp4");
        assert_eq!(default_srt_path(&v), d.join("movie.srt"));
        std::fs::write(d.join("movie.srt"), b"x").unwrap();
        let p = default_srt_path(&v);
        assert_ne!(p, d.join("movie.srt"));
        assert_eq!(p.extension().unwrap(), "srt");
        let _ = std::fs::remove_dir_all(&d);
    }

    #[test]
    fn arg_helpers() {
        let a = json!({"id": "  ", "n": 2.6, "b": true});
        assert!(req_str(&a, "id").is_err(), "chuỗi toàn khoảng trắng coi như thiếu");
        assert!(req_str(&a, "zzz").is_err());
        assert_eq!(opt_i64(&a, "n"), Some(3));
        assert!(opt_bool(&a, "b") && !opt_bool(&a, "x"));
    }
}
