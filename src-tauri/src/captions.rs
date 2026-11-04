//! Auto Caption — phụ đề tự động cho video bằng Whisper.cpp chạy CỤC BỘ (offline).
//!
//! Thiết kế: dùng `whisper-cli.exe` chính thức của dự án ggml-org/whisper.cpp như
//! một tiến trình riêng (cùng cách app đang dùng FFmpeg) thay vì biên dịch
//! whisper.cpp vào binary — không cần cmake/clang, không làm phình installer.
//! Engine (~8 MB) và model (60–574 MB) được tải về LẦN ĐẦU khi người dùng bấm
//! cài đặt, lưu trong thư mục dữ liệu cục bộ của app. Mọi file tải về đều được
//! kiểm tra SHA-256 (ghim cứng bên dưới) trước khi dùng; không chạy gì chưa qua
//! kiểm tra.
//!
//! Luồng: FFmpeg tách audio 16 kHz mono WAV → whisper-cli xuất SRT → parse →
//! chia nhỏ câu quá dài → trả về cho UI (sửa tay) → xuất `.srt` hoặc video
//! (phụ đề mềm `mov_text`, hoặc ghi cứng vào hình bằng filter `subtitles`).

use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};
use std::fs;
use std::io::{BufRead, BufReader, Read, Write};
use std::path::{Path, PathBuf};
use std::process::{Child, ChildStderr, ChildStdout, Command, ExitStatus, Stdio};
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::Mutex;
use std::time::{Duration, Instant};
use tauri::{AppHandle, Emitter, Manager};

/* ───────────── Engine + model được ghim phiên bản/hash ───────────── */

const ENGINE_TAG: &str = "v1.9.2";
const ENGINE_URL: &str =
    "https://github.com/ggml-org/whisper.cpp/releases/download/v1.9.2/whisper-bin-x64.zip";
const ENGINE_SHA256: &str = "49dcc16de826f20bd53d44f947a1ae49dfa81f86cad67a64d80820cb192d674a";
const ENGINE_SIZE: u64 = 8_194_445;
const CLI_NAME: &str = "whisper-cli.exe";

struct ModelDef {
    id: &'static str,
    file: &'static str,
    size: u64,
    sha256: &'static str,
}

const MODELS: &[ModelDef] = &[
    ModelDef {
        id: "base",
        file: "ggml-base-q5_1.bin",
        size: 59_707_625,
        sha256: "422f1ae452ade6f30a004d7e5c6a43195e4433bc370bf23fac9cc591f01a8898",
    },
    ModelDef {
        id: "small",
        file: "ggml-small-q5_1.bin",
        size: 190_085_487,
        sha256: "ae85e4a935d7a567bd102fe55afc16bb595bdb618e11b2fc7591bc08120411bb",
    },
    ModelDef {
        id: "turbo",
        file: "ggml-large-v3-turbo-q5_0.bin",
        size: 574_041_195,
        sha256: "394221709cd5ad1f40c46e6031ca61bce88931e6e088c188294c6d5a55ffa7e2",
    },
];

fn model_def(id: &str) -> Result<&'static ModelDef, String> {
    MODELS
        .iter()
        .find(|m| m.id == id)
        .ok_or_else(|| format!("Model phụ đề không hợp lệ: {id}"))
}

fn model_url(file: &str) -> String {
    format!("https://huggingface.co/ggerganov/whisper.cpp/resolve/main/{file}")
}

/* ───────────── Kiểu dữ liệu trao đổi với frontend ───────────── */

#[derive(Serialize, Deserialize, Clone, Debug, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct CaptionSegment {
    pub start_ms: u64,
    pub end_ms: u64,
    pub text: String,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ModelStatus {
    pub id: String,
    pub size_bytes: u64,
    pub installed: bool,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct CaptionsStatus {
    pub supported: bool,
    pub engine_installed: bool,
    pub engine_size_bytes: u64,
    pub models: Vec<ModelStatus>,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct TranscribeResult {
    /// Ngôn ngữ thực tế (mã 2 chữ cái): do người dùng chọn, hoặc Whisper tự nhận diện khi chọn "auto".
    pub language: String,
    pub segments: Vec<CaptionSegment>,
}

#[derive(Serialize, Clone)]
#[serde(rename_all = "camelCase")]
struct Progress {
    /// "engine" | "model" | "audio" | "transcribe" | "export"
    stage: &'static str,
    percent: u32,
    done_bytes: u64,
    total_bytes: u64,
}

/* ───────────── Trạng thái tác vụ toàn cục (1 tác vụ tại 1 thời điểm) ───────────── */

static BUSY: AtomicBool = AtomicBool::new(false);
static CANCEL: AtomicBool = AtomicBool::new(false);
static ACTIVE_CHILD: Mutex<Option<Child>> = Mutex::new(None);

struct JobGuard;

impl JobGuard {
    fn acquire() -> Result<Self, String> {
        if BUSY
            .compare_exchange(false, true, Ordering::SeqCst, Ordering::SeqCst)
            .is_err()
        {
            return Err("Đang có một tác vụ phụ đề khác chạy — hãy đợi xong hoặc huỷ nó.".into());
        }
        CANCEL.store(false, Ordering::SeqCst);
        Ok(JobGuard)
    }
}

impl Drop for JobGuard {
    fn drop(&mut self) {
        BUSY.store(false, Ordering::SeqCst);
    }
}

fn cancelled() -> bool {
    CANCEL.load(Ordering::SeqCst)
}

const CANCELLED_MSG: &str = "Đã huỷ.";

/// Thư mục tạm tự xoá khi ra khỏi scope (WAV tách audio, SRT trung gian).
struct TempDir(PathBuf);

impl TempDir {
    fn new() -> Result<Self, String> {
        let p = std::env::temp_dir().join(format!("snapdoc_captions_{}", uuid::Uuid::new_v4().simple()));
        fs::create_dir_all(&p).map_err(|e| format!("Không tạo được thư mục tạm: {e}"))?;
        Ok(TempDir(p))
    }
}

impl Drop for TempDir {
    fn drop(&mut self) {
        let _ = fs::remove_dir_all(&self.0);
    }
}

fn ensure_supported() -> Result<(), String> {
    if cfg!(windows) {
        Ok(())
    } else {
        Err("Phụ đề AI hiện chỉ hỗ trợ Windows.".into())
    }
}

fn root_dir(app: &AppHandle) -> PathBuf {
    app.path()
        .app_local_data_dir()
        .or_else(|_| app.path().app_config_dir())
        .unwrap_or_default()
        .join("captions")
}

fn engine_dir(app: &AppHandle) -> PathBuf {
    root_dir(app).join("engine")
}

fn models_dir(app: &AppHandle) -> PathBuf {
    root_dir(app).join("models")
}

fn engine_ready(dir: &Path) -> bool {
    dir.join(CLI_NAME).is_file()
        && fs::read_to_string(dir.join("VERSION"))
            .map(|v| v.trim() == ENGINE_TAG)
            .unwrap_or(false)
}

fn model_ready(dir: &Path, def: &ModelDef) -> bool {
    fs::metadata(dir.join(def.file))
        .map(|m| m.is_file() && m.len() == def.size)
        .unwrap_or(false)
}

/* ───────────── Tải file có kiểm tra SHA-256 ───────────── */

fn download_verified(
    url: &str,
    expect_sha256: &str,
    size_hint: u64,
    dest: &Path,
    mut on_progress: impl FnMut(u64, u64),
) -> Result<(), String> {
    if let Some(parent) = dest.parent() {
        fs::create_dir_all(parent).map_err(|e| format!("Không tạo được thư mục: {e}"))?;
    }
    let tmp = dest.with_extension("part");
    let agent = ureq::AgentBuilder::new()
        .timeout_connect(Duration::from_secs(20))
        .timeout_read(Duration::from_secs(60))
        .build();
    let resp = agent
        .get(url)
        .call()
        .map_err(|e| format!("Không tải được {url}: {e}"))?;
    let total = resp
        .header("Content-Length")
        .and_then(|v| v.parse::<u64>().ok())
        .filter(|&n| n > 0)
        .unwrap_or(size_hint);

    let mut reader = resp.into_reader();
    let mut file = fs::File::create(&tmp).map_err(|e| format!("Không ghi được file tạm: {e}"))?;
    let mut hasher = Sha256::new();
    let mut buf = vec![0u8; 256 * 1024];
    let mut done: u64 = 0;
    let mut last_emit = Instant::now();

    let result = (|| -> Result<(), String> {
        loop {
            if cancelled() {
                return Err(CANCELLED_MSG.into());
            }
            let n = reader.read(&mut buf).map_err(|e| format!("Lỗi khi tải: {e}"))?;
            if n == 0 {
                break;
            }
            file.write_all(&buf[..n]).map_err(|e| format!("Lỗi ghi file: {e}"))?;
            hasher.update(&buf[..n]);
            done += n as u64;
            if last_emit.elapsed() >= Duration::from_millis(150) {
                on_progress(done, total);
                last_emit = Instant::now();
            }
        }
        file.flush().map_err(|e| format!("Lỗi ghi file: {e}"))?;
        Ok(())
    })();
    drop(file);

    if let Err(e) = result {
        let _ = fs::remove_file(&tmp);
        return Err(e);
    }
    on_progress(done, total.max(done));

    let got = format!("{:x}", hasher.finalize());
    if !got.eq_ignore_ascii_case(expect_sha256) {
        let _ = fs::remove_file(&tmp);
        return Err(format!(
            "File tải về không khớp mã SHA-256 (nhận {got}, mong đợi {expect_sha256}) — đã xoá, hãy thử lại."
        ));
    }
    let _ = fs::remove_file(dest);
    fs::rename(&tmp, dest).map_err(|e| format!("Không lưu được file: {e}"))
}

/// Giải nén CHỈ `whisper-cli.exe` + các DLL (làm phẳng đường dẫn → chống
/// zip-slip: không bao giờ dùng đường dẫn trong zip để ghi file).
fn extract_engine(zip_path: &Path, dest_dir: &Path) -> Result<(), String> {
    let file = fs::File::open(zip_path).map_err(|e| format!("Không mở được file zip: {e}"))?;
    let mut archive = zip::ZipArchive::new(file).map_err(|e| format!("File zip hỏng: {e}"))?;
    fs::create_dir_all(dest_dir).map_err(|e| format!("Không tạo được thư mục engine: {e}"))?;
    let mut found_cli = false;
    for i in 0..archive.len() {
        let mut entry = archive.by_index(i).map_err(|e| format!("File zip hỏng: {e}"))?;
        if entry.is_dir() {
            continue;
        }
        let Some(name) = Path::new(entry.name())
            .file_name()
            .and_then(|n| n.to_str())
            .map(|n| n.to_string())
        else {
            continue;
        };
        let lower = name.to_lowercase();
        let wanted = lower == CLI_NAME || lower.ends_with(".dll");
        if !wanted {
            continue;
        }
        let mut out = fs::File::create(dest_dir.join(&name))
            .map_err(|e| format!("Không ghi được {name}: {e}"))?;
        std::io::copy(&mut entry, &mut out).map_err(|e| format!("Lỗi giải nén {name}: {e}"))?;
        if lower == CLI_NAME {
            found_cli = true;
        }
    }
    if !found_cli {
        return Err("Gói engine không chứa whisper-cli.exe".into());
    }
    Ok(())
}

fn install_engine(root: &Path, mut on_progress: impl FnMut(u64, u64)) -> Result<(), String> {
    let zip_path = root.join("downloads").join("whisper-bin-x64.zip");
    download_verified(ENGINE_URL, ENGINE_SHA256, ENGINE_SIZE, &zip_path, &mut on_progress)?;
    let staging = root.join("engine.tmp");
    let _ = fs::remove_dir_all(&staging);
    extract_engine(&zip_path, &staging).map_err(|e| {
        let _ = fs::remove_dir_all(&staging);
        e
    })?;
    fs::write(staging.join("VERSION"), ENGINE_TAG).map_err(|e| format!("Không ghi được VERSION: {e}"))?;
    let final_dir = root.join("engine");
    let _ = fs::remove_dir_all(&final_dir);
    fs::rename(&staging, &final_dir).map_err(|e| format!("Không cài được engine: {e}"))?;
    let _ = fs::remove_file(&zip_path);
    Ok(())
}

/* ───────────── Tiến trình con có thể huỷ ───────────── */

fn spawn_tracked(cmd: &mut Command) -> Result<(Option<ChildStdout>, Option<ChildStderr>), String> {
    crate::record::proc::no_window(cmd);
    let mut child = cmd
        .spawn()
        .map_err(|e| format!("Không khởi chạy được tiến trình: {e}"))?;
    let out = child.stdout.take();
    let err = child.stderr.take();
    {
        let mut slot = ACTIVE_CHILD.lock().unwrap_or_else(|e| e.into_inner());
        *slot = Some(child);
        if cancelled() {
            if let Some(c) = slot.as_mut() {
                let _ = c.kill();
            }
        }
    }
    Ok((out, err))
}

fn finish_tracked() -> Result<ExitStatus, String> {
    let child = ACTIVE_CHILD.lock().unwrap_or_else(|e| e.into_inner()).take();
    match child {
        Some(mut c) => c.wait().map_err(|e| format!("Lỗi chờ tiến trình: {e}")),
        None => Err("Tiến trình đã bị dừng.".into()),
    }
}

fn read_lines_lossy<R: Read>(reader: R, mut f: impl FnMut(&str)) {
    let mut r = BufReader::new(reader);
    let mut buf = Vec::new();
    loop {
        buf.clear();
        match r.read_until(b'\n', &mut buf) {
            Ok(0) | Err(_) => break,
            Ok(_) => f(String::from_utf8_lossy(&buf).trim_end()),
        }
    }
}

fn tail_lines(lines: &[String], n: usize) -> String {
    let start = lines.len().saturating_sub(n);
    lines[start..].join("\n")
}

/* ───────────── Xử lý SRT ───────────── */

fn fmt_ts(ms: u64) -> String {
    let h = ms / 3_600_000;
    let m = (ms / 60_000) % 60;
    let s = (ms / 1000) % 60;
    let r = ms % 1000;
    format!("{h:02}:{m:02}:{s:02},{r:03}")
}

fn parse_ts(s: &str) -> Option<u64> {
    let s = s.trim().replace(',', ".");
    let mut parts = s.split(':');
    let h: u64 = parts.next()?.parse().ok()?;
    let m: u64 = parts.next()?.parse().ok()?;
    let sec = parts.next()?;
    if parts.next().is_some() {
        return None;
    }
    let (ss, frac) = sec.split_once('.').unwrap_or((sec, "0"));
    let ss: u64 = ss.parse().ok()?;
    let mut frac3: String = frac.chars().take(3).collect();
    while frac3.len() < 3 {
        frac3.push('0');
    }
    let ms: u64 = frac3.parse().ok()?;
    Some(((h * 60 + m) * 60 + ss) * 1000 + ms)
}

/// Chú thích không phải lời thoại Whisper hay chèn: `[BLANK_AUDIO]`, `(music)`, `♪`.
fn is_non_speech(t: &str) -> bool {
    let t = t.trim();
    (t.starts_with('[') && t.ends_with(']'))
        || (t.starts_with('(') && t.ends_with(')'))
        || t.chars().all(|c| c == '♪' || c.is_whitespace())
}

pub fn parse_srt(raw: &str) -> Vec<CaptionSegment> {
    let text = raw.trim_start_matches('\u{feff}').replace("\r\n", "\n").replace('\r', "\n");
    let mut out = Vec::new();
    for block in text.split("\n\n") {
        let lines: Vec<&str> = block.lines().collect();
        let Some(ti) = lines.iter().position(|l| l.contains("-->")) else {
            continue;
        };
        let mut it = lines[ti].split("-->");
        let (Some(a), Some(b)) = (it.next(), it.next()) else {
            continue;
        };
        let (Some(start_ms), Some(end_ms)) = (
            parse_ts(a),
            parse_ts(b.split_whitespace().next().unwrap_or("")),
        ) else {
            continue;
        };
        let body = lines[ti + 1..]
            .iter()
            .map(|l| l.trim())
            .filter(|l| !l.is_empty())
            .collect::<Vec<_>>()
            .join(" ");
        if body.is_empty() || is_non_speech(&body) {
            continue;
        }
        out.push(CaptionSegment {
            start_ms,
            end_ms: end_ms.max(start_ms),
            text: body,
        });
    }
    out
}

pub fn format_srt(segments: &[CaptionSegment]) -> String {
    let mut s = String::new();
    let mut idx = 1;
    for seg in segments {
        let text = seg.text.trim();
        if text.is_empty() {
            continue;
        }
        s.push_str(&format!(
            "{idx}\n{} --> {}\n{text}\n\n",
            fmt_ts(seg.start_ms),
            fmt_ts(seg.end_ms.max(seg.start_ms + 1))
        ));
        idx += 1;
    }
    s
}

const MAX_CHARS: usize = 72;
const MAX_MS: u64 = 7_000;

/// Chia câu quá dài/quá lâu thành nhiều dòng phụ đề dễ đọc; thời gian chia theo
/// tỉ lệ số ký tự. Văn bản không có khoảng trắng (CJK) được cắt theo ký tự.
fn split_long(seg: CaptionSegment) -> Vec<CaptionSegment> {
    let total_chars = seg.text.chars().count();
    let dur = seg.end_ms.saturating_sub(seg.start_ms);
    if total_chars <= MAX_CHARS && dur <= MAX_MS {
        return vec![seg];
    }
    let words: Vec<&str> = seg.text.split_whitespace().collect();
    let (tokens, sep): (Vec<String>, &str) = if words.len() > 1 {
        (words.iter().map(|w| w.to_string()).collect(), " ")
    } else {
        (seg.text.chars().map(|c| c.to_string()).collect(), "")
    };
    let by_chars = total_chars.div_ceil(MAX_CHARS);
    let by_time = dur.div_ceil(MAX_MS) as usize;
    let pieces = by_chars.max(by_time).max(2);
    let target = total_chars.div_ceil(pieces);

    let mut lines: Vec<String> = Vec::new();
    let mut cur = String::new();
    for tok in tokens {
        let would = if cur.is_empty() {
            tok.chars().count()
        } else {
            cur.chars().count() + sep.len() + tok.chars().count()
        };
        if !cur.is_empty() && would > target {
            lines.push(std::mem::take(&mut cur));
        }
        if !cur.is_empty() {
            cur.push_str(sep);
        }
        let ends_clause = tok.ends_with(['.', ',', ';', ':', '!', '?', '。', '，', '！', '？']);
        cur.push_str(&tok);
        if ends_clause && cur.chars().count() * 10 >= target * 6 {
            lines.push(std::mem::take(&mut cur));
        }
    }
    if !cur.is_empty() {
        lines.push(cur);
    }

    let sum: usize = lines.iter().map(|l| l.chars().count().max(1)).sum();
    let n = lines.len();
    let mut acc = 0usize;
    let mut out = Vec::with_capacity(n);
    for (i, l) in lines.into_iter().enumerate() {
        let w = l.chars().count().max(1);
        let s = seg.start_ms + dur * acc as u64 / sum as u64;
        acc += w;
        let e = if i + 1 == n {
            seg.end_ms
        } else {
            seg.start_ms + dur * acc as u64 / sum as u64
        };
        out.push(CaptionSegment {
            start_ms: s,
            end_ms: e.max(s),
            text: l,
        });
    }
    out
}

fn normalize_segments(raw: Vec<CaptionSegment>) -> Vec<CaptionSegment> {
    raw.into_iter().flat_map(split_long).collect()
}

/* ───────────── Kiểm tra tham số từ webview ───────────── */

fn validate_lang(l: &str) -> Result<String, String> {
    let l = l.trim().to_lowercase();
    let ok = l == "auto" || ((2..=3).contains(&l.len()) && l.chars().all(|c| c.is_ascii_lowercase()));
    if ok {
        Ok(l)
    } else {
        Err(format!("Ngôn ngữ không hợp lệ: {l}"))
    }
}

fn lang3(l: &str) -> &'static str {
    match l {
        "vi" => "vie",
        "en" => "eng",
        "ja" => "jpn",
        "zh" => "zho",
        "ko" => "kor",
        "fr" => "fra",
        "de" => "deu",
        "es" => "spa",
        "pt" => "por",
        "it" => "ita",
        "ru" => "rus",
        "th" => "tha",
        "id" => "ind",
        "hi" => "hin",
        "ar" => "ara",
        "tr" => "tur",
        _ => "und",
    }
}

fn require_ext(path: &Path, ext: &str, what: &str) -> Result<(), String> {
    let ok = path
        .extension()
        .and_then(|e| e.to_str())
        .map(|e| e.eq_ignore_ascii_case(ext))
        .unwrap_or(false);
    if ok {
        Ok(())
    } else {
        Err(format!("File {what} phải có đuôi .{ext}"))
    }
}

fn require_existing_file(path: &Path) -> Result<(), String> {
    if path.is_file() {
        Ok(())
    } else {
        Err(format!("File không tồn tại: {}", path.display()))
    }
}

fn ensure_not_same_file(input: &Path, output: &Path) -> Result<(), String> {
    if let (Ok(a), Ok(b)) = (fs::canonicalize(input), fs::canonicalize(output)) {
        if a == b {
            return Err("File xuất không được trùng với video gốc.".into());
        }
    }
    Ok(())
}

/* ───────────── Pipeline: audio → whisper → SRT ───────────── */

fn extract_audio(ffmpeg: &Path, video: &Path, wav: &Path) -> Result<(), String> {
    let mut cmd = Command::new(ffmpeg);
    cmd.args(["-y", "-hide_banner", "-loglevel", "error", "-i"])
        .arg(video)
        .args(["-map", "0:a:0", "-vn", "-ac", "1", "-ar", "16000", "-c:a", "pcm_s16le"])
        .arg(wav);
    crate::record::proc::run_ok(&mut cmd, crate::record::proc::timeout_for_file(video), "Tách âm thanh")
        .map(|_| ())
        .map_err(|e| {
            if e.contains("matches no streams") || e.contains("does not contain any stream") {
                "Video này không có âm thanh để tạo phụ đề.".to_string()
            } else {
                e
            }
        })
}

fn parse_progress(line: &str) -> Option<u32> {
    let i = line.find("progress =")?;
    let rest = line[i + "progress =".len()..].trim_start();
    let digits: String = rest.chars().take_while(|c| c.is_ascii_digit()).collect();
    digits.parse::<u32>().ok().map(|p| p.min(100))
}

fn parse_detected_language(line: &str) -> Option<String> {
    let i = line.find("auto-detected language:")?;
    let rest = line[i + "auto-detected language:".len()..].trim_start();
    let code: String = rest.chars().take_while(|c| c.is_ascii_lowercase()).collect();
    if (2..=3).contains(&code.len()) {
        Some(code)
    } else {
        None
    }
}

struct WhisperRun {
    srt_path: PathBuf,
    language: Option<String>,
}

fn run_whisper(
    cli: &Path,
    model: &Path,
    wav: &Path,
    lang: &str,
    out_base: &Path,
    mut on_progress: impl FnMut(u32),
) -> Result<WhisperRun, String> {
    let threads = std::thread::available_parallelism()
        .map(|n| n.get())
        .unwrap_or(4)
        .clamp(2, 8);
    let mut cmd = Command::new(cli);
    if let Some(dir) = cli.parent() {
        cmd.current_dir(dir);
    }
    cmd.arg("-m")
        .arg(model)
        .arg("-f")
        .arg(wav)
        .args(["-l", lang, "-osrt", "-pp", "-t"])
        .arg(threads.to_string())
        .arg("-of")
        .arg(out_base)
        .stdin(Stdio::null())
        .stdout(Stdio::null())
        .stderr(Stdio::piped());

    let (_out, err) = spawn_tracked(&mut cmd)?;
    let mut log: Vec<String> = Vec::new();
    let mut language: Option<String> = None;
    if let Some(err) = err {
        read_lines_lossy(err, |line| {
            if let Some(p) = parse_progress(line) {
                on_progress(p);
            } else if !line.trim().is_empty() {
                if language.is_none() {
                    language = parse_detected_language(line);
                }
                log.push(line.to_string());
                if log.len() > 60 {
                    log.remove(0);
                }
            }
        });
    }
    let status = finish_tracked()?;
    if cancelled() {
        return Err(CANCELLED_MSG.into());
    }
    if !status.success() {
        return Err(format!(
            "Whisper thất bại ({status}): {}",
            tail_lines(&log, 6)
        ));
    }
    let srt_path = out_base.with_extension("srt");
    if !srt_path.is_file() {
        return Err("Whisper không tạo ra file phụ đề.".into());
    }
    Ok(WhisperRun { srt_path, language })
}

/* ───────────── Xuất video có phụ đề ───────────── */

fn export_soft(
    ffmpeg: &Path,
    input: &Path,
    srt: &Path,
    output: &Path,
    lang: &str,
) -> Result<(), String> {
    let mut cmd = Command::new(ffmpeg);
    cmd.args(["-y", "-hide_banner", "-loglevel", "error", "-i"])
        .arg(input)
        .arg("-i")
        .arg(srt)
        .args([
            "-map", "0:v:0", "-map", "0:a?", "-map", "1:0", "-c:v", "copy", "-c:a", "copy", "-c:s",
            "mov_text", "-metadata:s:s:0",
        ])
        .arg(format!("language={}", lang3(lang)))
        .args(["-movflags", "+faststart"])
        .arg(output);
    crate::record::proc::run_ok(
        &mut cmd,
        crate::record::proc::timeout_for_file(input),
        "Ghép phụ đề vào video",
    )
    .map(|_| ())
}

/// Ghi cứng phụ đề vào hình. `work_dir` chứa `captions.srt`; chạy ffmpeg với
/// cwd = `work_dir` và đường dẫn TƯƠNG ĐỐI để tránh hoàn toàn việc escape đường
/// dẫn Windows (`C\:/...`) trong filter `subtitles`.
fn export_burn(
    ffmpeg: &Path,
    input: &Path,
    work_dir: &Path,
    output: &Path,
    duration_ms: u64,
    mut on_progress: impl FnMut(u32),
) -> Result<(), String> {
    let style = "FontName=Arial,FontSize=18,PrimaryColour=&H00FFFFFF,OutlineColour=&H00000000,\
                 BorderStyle=1,Outline=2,Shadow=0,MarginV=28";
    let vf = format!("subtitles=captions.srt:force_style='{style}'");
    let mut cmd = Command::new(ffmpeg);
    cmd.current_dir(work_dir)
        .args(["-y", "-hide_banner", "-loglevel", "error", "-progress", "pipe:1", "-nostats", "-i"])
        .arg(input)
        .args(["-map", "0:v:0", "-map", "0:a?", "-vf"])
        .arg(vf)
        .args([
            "-c:v", "libx264", "-preset", "veryfast", "-crf", "20", "-pix_fmt", "yuv420p", "-c:a",
            "copy", "-movflags", "+faststart",
        ])
        .arg(output)
        .stdin(Stdio::null())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped());

    let (out, err) = spawn_tracked(&mut cmd)?;
    let err_thread = err.map(|e| {
        std::thread::spawn(move || {
            let mut lines = Vec::new();
            read_lines_lossy(e, |l| {
                lines.push(l.to_string());
                if lines.len() > 40 {
                    lines.remove(0);
                }
            });
            lines
        })
    });
    let total_us = (duration_ms.max(1)) * 1000;
    let mut last = 0u32;
    if let Some(out) = out {
        read_lines_lossy(out, |line| {
            if let Some(v) = line
                .strip_prefix("out_time_us=")
                .or_else(|| line.strip_prefix("out_time_ms="))
            {
                if let Ok(us) = v.trim().parse::<u64>() {
                    let p = ((us * 100) / total_us).min(99) as u32;
                    if p != last {
                        last = p;
                        on_progress(p);
                    }
                }
            }
        });
    }
    let status = finish_tracked()?;
    let err_lines = err_thread.and_then(|t| t.join().ok()).unwrap_or_default();
    if cancelled() {
        let _ = fs::remove_file(output);
        return Err(CANCELLED_MSG.into());
    }
    if !status.success() {
        let _ = fs::remove_file(output);
        return Err(format!(
            "Ghi phụ đề vào video thất bại ({status}): {}",
            tail_lines(&err_lines, 6)
        ));
    }
    Ok(())
}

/* ───────────── Tauri commands ───────────── */

fn emit_progress(app: &AppHandle, stage: &'static str, done: u64, total: u64) {
    let percent = if total > 0 { ((done * 100) / total).min(100) as u32 } else { 0 };
    let _ = app.emit(
        "captions-progress",
        Progress {
            stage,
            percent,
            done_bytes: done,
            total_bytes: total,
        },
    );
}

#[tauri::command]
pub fn captions_status(app: AppHandle) -> CaptionsStatus {
    let mdir = models_dir(&app);
    CaptionsStatus {
        supported: cfg!(windows),
        engine_installed: engine_ready(&engine_dir(&app)),
        engine_size_bytes: ENGINE_SIZE,
        models: MODELS
            .iter()
            .map(|m| ModelStatus {
                id: m.id.to_string(),
                size_bytes: m.size,
                installed: model_ready(&mdir, m),
            })
            .collect(),
    }
}

/// Cài engine (nếu chưa có) + model `model_id` (nếu chưa có). Phát sự kiện
/// `captions-progress` (stage "engine"/"model").
#[tauri::command]
pub async fn captions_setup(app: AppHandle, model_id: String) -> Result<(), String> {
    ensure_supported()?;
    let def = model_def(&model_id)?;
    tauri::async_runtime::spawn_blocking(move || {
        let _guard = JobGuard::acquire()?;
        let root = root_dir(&app);
        if !engine_ready(&engine_dir(&app)) {
            let a = app.clone();
            install_engine(&root, move |d, t| emit_progress(&a, "engine", d, t))?;
        }
        let mdir = models_dir(&app);
        if !model_ready(&mdir, def) {
            let a = app.clone();
            download_verified(
                &model_url(def.file),
                def.sha256,
                def.size,
                &mdir.join(def.file),
                move |d, t| emit_progress(&a, "model", d, t),
            )?;
        }
        Ok(())
    })
    .await
    .map_err(|e| format!("Task join error: {e}"))?
}

/// Huỷ tác vụ phụ đề đang chạy (tải về / nhận diện / xuất video).
#[tauri::command]
pub fn captions_cancel() {
    CANCEL.store(true, Ordering::SeqCst);
    if let Some(c) = ACTIVE_CHILD.lock().unwrap_or_else(|e| e.into_inner()).as_mut() {
        let _ = c.kill();
    }
}

#[tauri::command]
pub async fn captions_transcribe(
    app: AppHandle,
    video_path: String,
    language: String,
    model_id: String,
) -> Result<TranscribeResult, String> {
    ensure_supported()?;
    let lang = validate_lang(&language)?;
    let def = model_def(&model_id)?;
    tauri::async_runtime::spawn_blocking(move || {
        let _guard = JobGuard::acquire()?;
        let video = PathBuf::from(&video_path);
        require_existing_file(&video)?;

        let cli = engine_dir(&app).join(CLI_NAME);
        let model = models_dir(&app).join(def.file);
        if !engine_ready(&engine_dir(&app)) || !model_ready(&models_dir(&app), def) {
            return Err("Chưa cài đặt engine/model phụ đề — hãy bấm “Tải về & cài đặt” trước.".into());
        }
        let ffmpeg = crate::record::encoder::sidecar_path("ffmpeg")?;

        let tmp = TempDir::new()?;
        let wav = tmp.0.join("audio.wav");
        emit_progress(&app, "audio", 0, 100);
        extract_audio(&ffmpeg, &video, &wav)?;
        if cancelled() {
            return Err(CANCELLED_MSG.into());
        }

        let a = app.clone();
        let run = run_whisper(&cli, &model, &wav, &lang, &tmp.0.join("out"), move |p| {
            emit_progress(&a, "transcribe", p as u64, 100)
        })?;
        let raw = fs::read_to_string(&run.srt_path).map_err(|e| format!("Không đọc được kết quả: {e}"))?;
        let segments = normalize_segments(parse_srt(&raw));
        if segments.is_empty() {
            return Err("Không nhận diện được lời thoại nào trong video (có thể video không có tiếng nói).".into());
        }
        let language = if lang == "auto" {
            run.language.unwrap_or_else(|| "auto".to_string())
        } else {
            lang
        };
        Ok(TranscribeResult { language, segments })
    })
    .await
    .map_err(|e| format!("Task join error: {e}"))?
}

#[tauri::command]
pub fn captions_save_srt(output_path: String, segments: Vec<CaptionSegment>) -> Result<String, String> {
    let out = PathBuf::from(&output_path);
    require_ext(&out, "srt", "phụ đề")?;
    if let Some(parent) = out.parent() {
        fs::create_dir_all(parent).map_err(|e| format!("Không tạo được thư mục lưu: {e}"))?;
    }
    fs::write(&out, format_srt(&segments)).map_err(|e| format!("Không ghi được file phụ đề: {e}"))?;
    Ok(out.to_string_lossy().to_string())
}

/// Xuất video có phụ đề. `mode`: "soft" (track phụ đề bật/tắt được, không
/// encode lại — nhanh) hoặc "burn" (ghi cứng vào hình, encode lại H.264).
#[tauri::command]
pub async fn captions_export_video(
    app: AppHandle,
    input_path: String,
    output_path: String,
    segments: Vec<CaptionSegment>,
    mode: String,
    language: String,
    duration_ms: u64,
) -> Result<String, String> {
    ensure_supported()?;
    if mode != "soft" && mode != "burn" {
        return Err(format!("Chế độ xuất không hợp lệ: {mode}"));
    }
    let lang = validate_lang(&language)?;
    tauri::async_runtime::spawn_blocking(move || {
        let _guard = JobGuard::acquire()?;
        let input = PathBuf::from(&input_path);
        let output = PathBuf::from(&output_path);
        require_existing_file(&input)?;
        require_ext(&output, "mp4", "video xuất")?;
        ensure_not_same_file(&input, &output)?;
        if format_srt(&segments).is_empty() {
            return Err("Chưa có phụ đề nào để xuất.".into());
        }
        if let Some(parent) = output.parent() {
            fs::create_dir_all(parent).map_err(|e| format!("Không tạo được thư mục lưu: {e}"))?;
        }
        let ffmpeg = crate::record::encoder::sidecar_path("ffmpeg")?;
        let tmp = TempDir::new()?;
        let srt = tmp.0.join("captions.srt");
        fs::write(&srt, format_srt(&segments)).map_err(|e| format!("Không ghi được SRT tạm: {e}"))?;

        // Ghi ra file tạm cạnh đích rồi đổi tên → không để lại video dở dang ở đích khi lỗi/huỷ.
        let staged = output.with_extension("captions.part.mp4");
        let result = if mode == "soft" {
            emit_progress(&app, "export", 0, 100);
            export_soft(&ffmpeg, &input, &srt, &staged, &lang)
        } else {
            let a = app.clone();
            export_burn(&ffmpeg, &input, &tmp.0, &staged, duration_ms, move |p| {
                emit_progress(&a, "export", p as u64, 100)
            })
        };
        if let Err(e) = result {
            let _ = fs::remove_file(&staged);
            return Err(e);
        }
        let _ = fs::remove_file(&output);
        fs::rename(&staged, &output).map_err(|e| format!("Không lưu được video: {e}"))?;
        emit_progress(&app, "export", 100, 100);
        crate::record::allow_asset_file(&app, &output);
        Ok(output.to_string_lossy().to_string())
    })
    .await
    .map_err(|e| format!("Task join error: {e}"))?
}

/* ───────────── Tests ───────────── */

#[cfg(test)]
mod tests {
    use super::*;

    fn seg(a: u64, b: u64, t: &str) -> CaptionSegment {
        CaptionSegment {
            start_ms: a,
            end_ms: b,
            text: t.to_string(),
        }
    }

    #[test]
    fn timestamp_roundtrip() {
        assert_eq!(fmt_ts(3_723_456), "01:02:03,456");
        assert_eq!(parse_ts("01:02:03,456"), Some(3_723_456));
        assert_eq!(parse_ts("00:00:04.2"), Some(4_200));
        assert_eq!(parse_ts("bad"), None);
    }

    #[test]
    fn parses_whisper_srt_and_drops_non_speech() {
        let raw = "\u{feff}1\r\n00:00:00,000 --> 00:00:04,200\r\n Xin chào các bạn.\r\n\r\n\
                   2\r\n00:00:04,200 --> 00:00:06,000\r\n [BLANK_AUDIO]\r\n\r\n\
                   3\r\n00:00:06,000 --> 00:00:09,500\r\n Dòng một\r\n dòng hai\r\n\r\n\
                   4\r\n00:00:09,500 --> 00:00:10,000\r\n ♪\r\n";
        let segs = parse_srt(raw);
        assert_eq!(segs.len(), 2);
        assert_eq!(segs[0], seg(0, 4_200, "Xin chào các bạn."));
        assert_eq!(segs[1], seg(6_000, 9_500, "Dòng một dòng hai"));
    }

    #[test]
    fn srt_format_then_parse_is_stable() {
        let segs = vec![seg(0, 1_500, "Một"), seg(1_500, 3_000, "Hai")];
        let again = parse_srt(&format_srt(&segs));
        assert_eq!(again, segs);
    }

    #[test]
    fn format_srt_skips_empty_text_and_renumbers() {
        let srt = format_srt(&[seg(0, 1000, "  "), seg(1000, 2000, "Có")]);
        assert!(srt.starts_with("1\n00:00:01,000 --> 00:00:02,000\nCó\n"));
    }

    #[test]
    fn short_segment_is_untouched() {
        let s = seg(0, 3_000, "Ngắn gọn thôi");
        assert_eq!(split_long(s.clone()), vec![s]);
    }

    #[test]
    fn long_segment_is_split_with_contiguous_timing() {
        let text = "Đây là một câu rất dài dùng để kiểm tra việc tự động chia nhỏ phụ đề thành nhiều dòng, \
                    mỗi dòng đủ ngắn để người xem kịp đọc trong thời gian hiển thị của nó trên màn hình.";
        let s = seg(1_000, 13_000, text);
        let parts = split_long(s.clone());
        assert!(parts.len() >= 2, "phải chia thành ≥2 dòng");
        assert_eq!(parts.first().unwrap().start_ms, 1_000);
        assert_eq!(parts.last().unwrap().end_ms, 13_000);
        for w in parts.windows(2) {
            assert_eq!(w[0].end_ms, w[1].start_ms, "mốc thời gian phải liền mạch");
        }
        let joined = parts.iter().map(|p| p.text.as_str()).collect::<Vec<_>>().join(" ");
        assert_eq!(joined, text, "không được mất/đổi chữ");
        assert!(parts.iter().all(|p| p.text.chars().count() <= MAX_CHARS + 20));
    }

    #[test]
    fn long_cjk_text_without_spaces_is_split_by_chars() {
        let text: String = "これは長い文章です。".repeat(12);
        let parts = split_long(seg(0, 20_000, &text));
        assert!(parts.len() >= 2);
        let joined: String = parts.iter().map(|p| p.text.as_str()).collect();
        assert_eq!(joined, text);
    }

    #[test]
    fn language_validation() {
        assert_eq!(validate_lang(" VI ").unwrap(), "vi");
        assert_eq!(validate_lang("auto").unwrap(), "auto");
        assert!(validate_lang("--help").is_err());
        assert!(validate_lang("english").is_err());
        assert!(validate_lang("").is_err());
    }

    #[test]
    fn parses_whisper_stderr_lines() {
        assert_eq!(parse_progress("whisper_print_progress_callback: progress =  45%"), Some(45));
        assert_eq!(parse_progress("something else"), None);
        assert_eq!(
            parse_detected_language("whisper_full_with_state: auto-detected language: vi (p = 0.970000)"),
            Some("vi".to_string())
        );
    }

    #[test]
    fn rejects_wrong_extension_and_same_file() {
        assert!(require_ext(Path::new("a.txt"), "srt", "phụ đề").is_err());
        assert!(require_ext(Path::new("a.SRT"), "srt", "phụ đề").is_ok());
    }

    #[test]
    fn model_table_is_consistent() {
        for m in MODELS {
            assert_eq!(m.sha256.len(), 64, "{}", m.id);
            assert!(m.file.ends_with(".bin"));
            assert!(m.size > 10_000_000);
        }
        assert_eq!(ENGINE_SHA256.len(), 64);
        assert!(model_def("nope").is_err());
    }

    /// Chạy THẬT toàn bộ pipeline với ffmpeg + whisper-cli + model thật. Bỏ qua
    /// mặc định; chạy bằng: `SNAPDOC_E2E_DIR=<thư mục> cargo test captions::tests::e2e -- --ignored --nocapture`
    /// với thư mục chứa: ffmpeg.exe, engine/whisper-cli.exe(+dll), ggml-base-q5_1.bin, test_video.mp4.
    #[test]
    #[ignore]
    fn e2e_real_pipeline() {
        let dir = PathBuf::from(std::env::var("SNAPDOC_E2E_DIR").expect("đặt SNAPDOC_E2E_DIR"));
        let ffmpeg = dir.join("ffmpeg.exe");
        let cli = dir.join("engine").join(CLI_NAME);
        let model = dir.join("ggml-base-q5_1.bin");
        let video = dir.join("test_video.mp4");
        let tmp = TempDir::new().unwrap();

        let wav = tmp.0.join("audio.wav");
        extract_audio(&ffmpeg, &video, &wav).expect("extract_audio");
        assert!(wav.metadata().unwrap().len() > 10_000);

        let mut last = 0;
        let run = run_whisper(&cli, &model, &wav, "en", &tmp.0.join("out"), |p| last = p).expect("whisper");
        assert_eq!(last, 100);
        let segs = normalize_segments(parse_srt(&fs::read_to_string(&run.srt_path).unwrap()));
        println!("SEGMENTS: {segs:#?}");
        assert!(!segs.is_empty());
        let all = segs.iter().map(|s| s.text.to_lowercase()).collect::<Vec<_>>().join(" ");
        assert!(all.contains("test") && all.contains("captions"), "nội dung: {all}");

        let srt = tmp.0.join("captions.srt");
        // Thêm 1 dòng tiếng Việt để kiểm tra font/dấu khi ghi cứng.
        let mut with_vi = segs.clone();
        with_vi.push(seg(0, 2_000, "Phụ đề tiếng Việt có dấu: Đặng Thị Ngọc Ánh"));
        fs::write(&srt, format_srt(&with_vi)).unwrap();

        let soft = dir.join("out_soft.mp4");
        export_soft(&ffmpeg, &video, &srt, &soft, "en").expect("soft");
        assert!(soft.metadata().unwrap().len() > 1_000);

        let burn = dir.join("out_burn.mp4");
        let mut seen = 0;
        export_burn(&ffmpeg, &video, &tmp.0, &burn, 12_000, |p| seen = p).expect("burn");
        assert!(burn.metadata().unwrap().len() > 1_000);
        println!("burn progress max seen: {seen}");
    }
}
