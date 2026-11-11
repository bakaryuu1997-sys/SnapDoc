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
use std::collections::HashMap;
use std::fs;
use std::io::{BufRead, BufReader, Read, Write};
use std::path::{Path, PathBuf};
use std::process::{Child, ChildStderr, ChildStdout, Command, ExitStatus, Stdio};
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Mutex, OnceLock};
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

/// Mô hình VAD (Silero, ~0,9 MB): bỏ qua đoạn im lặng/nhạc nền TRƯỚC khi nhận diện →
/// hết ảo giác kiểu "Cảm ơn các bạn đã xem" trên đoạn lặng, tránh vòng lặp làm đứng ở
/// một % rất lâu, và nhanh hơn rõ với video có nhiều khoảng lặng. Không bắt buộc: thiếu
/// (tải lỗi/offline) thì vẫn nhận diện bình thường, chỉ kém chính xác hơn.
const VAD_FILE: &str = "ggml-silero-v5.1.2.bin";
const VAD_URL: &str = "https://huggingface.co/ggml-org/whisper-vad/resolve/main/ggml-silero-v5.1.2.bin";
const VAD_SIZE: u64 = 885_098;
const VAD_SHA256: &str = "29940d98d42b91fbd05ce489f3ecf7c72f0a42f027e4875919a28fb4c04ea2cf";

fn vad_ready(dir: &Path) -> bool {
    fs::metadata(dir.join(VAD_FILE)).map(|m| m.is_file() && m.len() == VAD_SIZE).unwrap_or(false)
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

/// Tiến độ 1 tác vụ nền. Gửi qua sự kiện `captions-progress` và được giữ trong
/// registry để cửa sổ mở SAU (hoặc mở lại) lấy được bằng `captions_jobs`.
#[derive(Serialize, Clone, Debug)]
#[serde(rename_all = "camelCase")]
pub struct Progress {
    /// "download" | "transcribe" | "export"
    pub job: &'static str,
    /// "engine" | "model" | "audio" | "transcribe" | "export"
    pub stage: &'static str,
    pub percent: u32,
    pub done_bytes: u64,
    pub total_bytes: u64,
    /// Video đang được nhận diện (job "transcribe").
    pub video_path: Option<String>,
    /// Model đang tải (job "download", stage "model").
    pub model_id: Option<String>,
    /// Tải nhiều model: thứ tự model hiện tại (1-based) / tổng số model cần tải.
    pub index: u32,
    pub count: u32,
    /// Lúc tác vụ bắt đầu (ms từ epoch) — để hộp thoại/popup hiện thời gian đã chạy
    /// đúng kể cả khi cửa sổ được mở sau.
    pub started_ms: u64,
}

/// Kết quả 1 lần nhận diện, giữ trong bộ nhớ tới khi frontend `captions_take_outcome`
/// — nhờ vậy đóng hộp thoại / đóng cả cửa sổ Editor giữa chừng vẫn KHÔNG mất kết quả.
#[derive(Serialize, Clone, Debug)]
#[serde(rename_all = "camelCase")]
pub struct TranscribeOutcome {
    pub ok: bool,
    pub error: Option<String>,
    pub language: String,
    pub segments: Vec<CaptionSegment>,
}

#[derive(Serialize, Clone, Debug)]
#[serde(rename_all = "camelCase")]
struct Finished {
    job: &'static str,
    video_path: Option<String>,
    ok: bool,
    cancelled: bool,
    error: Option<String>,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct JobsSnapshot {
    /// Các tác vụ đang chạy.
    pub running: Vec<Progress>,
    /// Video đã có kết quả nhận diện nhưng chưa ai nhận.
    pub pending: Vec<String>,
}

#[derive(Default)]
struct Registry {
    running: HashMap<&'static str, Progress>,
    outcomes: HashMap<String, TranscribeOutcome>,
}

fn registry() -> std::sync::MutexGuard<'static, Registry> {
    static REG: OnceLock<Mutex<Registry>> = OnceLock::new();
    REG.get_or_init(|| Mutex::new(Registry::default()))
        .lock()
        .unwrap_or_else(|e| e.into_inner())
}

/// Ngữ cảnh gắn vào mỗi sự kiện tiến độ của 1 tác vụ.
#[derive(Clone)]
struct Ctx {
    job: &'static str,
    video_path: Option<String>,
    model_id: Option<String>,
    index: u32,
    count: u32,
    started_ms: u64,
}

impl Ctx {
    fn new(job: &'static str) -> Self {
        let started_ms = std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .map(|d| d.as_millis() as u64)
            .unwrap_or(0);
        Ctx { job, video_path: None, model_id: None, index: 0, count: 0, started_ms }
    }
}

/* ───────────── Làn tác vụ: tải model / nhận diện / xuất video chạy ĐỘC LẬP ───────────── */

/// Mỗi làn tối đa 1 tác vụ tại 1 thời điểm, nhưng các làn không chặn nhau: đang
/// nhận diện phụ đề vẫn tải thêm model hoặc xuất video được.
struct Slot {
    name: &'static str,
    busy: AtomicBool,
    cancel: AtomicBool,
    child: Mutex<Option<Child>>,
}

impl Slot {
    const fn new(name: &'static str) -> Self {
        Slot {
            name,
            busy: AtomicBool::new(false),
            cancel: AtomicBool::new(false),
            child: Mutex::new(None),
        }
    }
}

static DOWNLOAD: Slot = Slot::new("download");
static TRANSCRIBE: Slot = Slot::new("transcribe");
static EXPORT: Slot = Slot::new("export");

fn slot_by_name(name: &str) -> Option<&'static Slot> {
    [&DOWNLOAD, &TRANSCRIBE, &EXPORT].into_iter().find(|s| s.name == name)
}

struct JobGuard(&'static Slot);

impl JobGuard {
    fn acquire(slot: &'static Slot) -> Result<Self, String> {
        if slot
            .busy
            .compare_exchange(false, true, Ordering::SeqCst, Ordering::SeqCst)
            .is_err()
        {
            return Err(match slot.name {
                "download" => "Đang tải engine/model — hãy đợi xong hoặc huỷ.",
                "transcribe" => "Đang tạo phụ đề cho một video — hãy đợi xong hoặc huỷ.",
                _ => "Đang xuất video có phụ đề — hãy đợi xong hoặc huỷ.",
            }
            .into());
        }
        slot.cancel.store(false, Ordering::SeqCst);
        Ok(JobGuard(slot))
    }
}

impl Drop for JobGuard {
    fn drop(&mut self) {
        self.0.busy.store(false, Ordering::SeqCst);
    }
}

fn cancelled(slot: &Slot) -> bool {
    slot.cancel.load(Ordering::SeqCst)
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

enum AttemptErr {
    /// Lỗi tạm thời (mạng đứt, 5xx…) — giữ file `.part` và thử tiếp từ chỗ đã tải.
    Retry(String),
    Fatal(String),
    Cancelled,
}

const MAX_ATTEMPTS: u32 = 4;

/// Tải `url` về `dest`, kiểm tra SHA-256. TẢI TIẾP được: file `.part` dở dang
/// (do huỷ / đứt mạng / thoát app) được nối tiếp bằng HTTP `Range` thay vì tải lại
/// từ đầu — quan trọng với model turbo 574 MB. Tự thử lại tối đa vài lần khi đứt mạng.
fn download_verified(
    url: &str,
    expect_sha256: &str,
    size_hint: u64,
    dest: &Path,
    cancel: &AtomicBool,
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

    let mut last_err = String::new();
    for attempt in 0..MAX_ATTEMPTS {
        if cancel.load(Ordering::SeqCst) {
            return Err(CANCELLED_MSG.into());
        }
        match download_attempt(&agent, url, expect_sha256, size_hint, &tmp, cancel, &mut on_progress) {
            Ok(()) => {
                let _ = fs::remove_file(dest);
                return fs::rename(&tmp, dest).map_err(|e| format!("Không lưu được file: {e}"));
            }
            Err(AttemptErr::Cancelled) => return Err(CANCELLED_MSG.into()),
            Err(AttemptErr::Fatal(e)) => return Err(e),
            Err(AttemptErr::Retry(e)) => {
                last_err = e;
                // Nghỉ một chút (kiểm tra huỷ mỗi 100 ms) rồi nối tiếp từ `.part`.
                for _ in 0..(10 * (attempt + 1)) {
                    if cancel.load(Ordering::SeqCst) {
                        return Err(CANCELLED_MSG.into());
                    }
                    std::thread::sleep(Duration::from_millis(100));
                }
            }
        }
    }
    Err(format!("{last_err} (đã thử {MAX_ATTEMPTS} lần — lần sau sẽ tải tiếp từ phần đã có)"))
}

fn download_attempt(
    agent: &ureq::Agent,
    url: &str,
    expect_sha256: &str,
    size_hint: u64,
    tmp: &Path,
    cancel: &AtomicBool,
    on_progress: &mut impl FnMut(u64, u64),
) -> Result<(), AttemptErr> {
    let existing = fs::metadata(tmp).map(|m| m.len()).unwrap_or(0);
    let mut req = agent.get(url);
    if existing > 0 {
        req = req.set("Range", &format!("bytes={existing}-"));
    }
    let resp = match req.call() {
        Ok(r) => r,
        Err(ureq::Error::Status(416, _)) => {
            // `.part` không khớp với file trên máy chủ → bỏ, tải lại từ đầu ở lần sau.
            let _ = fs::remove_file(tmp);
            return Err(AttemptErr::Retry("Phần đã tải không còn hợp lệ — tải lại từ đầu".into()));
        }
        Err(ureq::Error::Status(code, _)) if code >= 500 => {
            return Err(AttemptErr::Retry(format!("Máy chủ lỗi HTTP {code} khi tải {url}")));
        }
        Err(ureq::Error::Status(code, _)) => {
            return Err(AttemptErr::Fatal(format!("Không tải được {url}: HTTP {code}")));
        }
        Err(e) => return Err(AttemptErr::Retry(format!("Không tải được {url}: {e}"))),
    };

    let resumed = existing > 0 && resp.status() == 206;
    let mut hasher = Sha256::new();
    let mut done: u64 = 0;
    let mut file = if resumed {
        // Nạp phần đã có vào bộ băm để kiểm tra SHA-256 toàn file ở cuối.
        let mut old = fs::File::open(tmp).map_err(|e| AttemptErr::Fatal(format!("Không đọc được file tạm: {e}")))?;
        let mut b = vec![0u8; 256 * 1024];
        loop {
            let n = old.read(&mut b).map_err(|e| AttemptErr::Fatal(format!("Không đọc được file tạm: {e}")))?;
            if n == 0 {
                break;
            }
            hasher.update(&b[..n]);
            done += n as u64;
        }
        fs::OpenOptions::new()
            .append(true)
            .open(tmp)
            .map_err(|e| AttemptErr::Fatal(format!("Không ghi được file tạm: {e}")))?
    } else {
        fs::File::create(tmp).map_err(|e| AttemptErr::Fatal(format!("Không ghi được file tạm: {e}")))?
    };

    let remaining = resp
        .header("Content-Length")
        .and_then(|v| v.parse::<u64>().ok())
        .filter(|&n| n > 0);
    let total = remaining.map(|r| r + done).unwrap_or(size_hint).max(done);

    let mut reader = resp.into_reader();
    let mut buf = vec![0u8; 256 * 1024];
    let mut last_emit = Instant::now();
    on_progress(done, total);
    loop {
        if cancel.load(Ordering::SeqCst) {
            let _ = file.flush();
            return Err(AttemptErr::Cancelled);
        }
        let n = match reader.read(&mut buf) {
            Ok(n) => n,
            Err(e) => {
                let _ = file.flush();
                return Err(AttemptErr::Retry(format!("Lỗi khi tải: {e}")));
            }
        };
        if n == 0 {
            break;
        }
        file.write_all(&buf[..n])
            .map_err(|e| AttemptErr::Fatal(format!("Lỗi ghi file: {e}")))?;
        hasher.update(&buf[..n]);
        done += n as u64;
        if last_emit.elapsed() >= Duration::from_millis(150) {
            on_progress(done, total);
            last_emit = Instant::now();
        }
    }
    file.flush().map_err(|e| AttemptErr::Fatal(format!("Lỗi ghi file: {e}")))?;
    drop(file);
    on_progress(done, total.max(done));

    // Kết nối bị cắt sớm mà không báo lỗi → còn thiếu byte: giữ `.part`, nối tiếp.
    if remaining.is_some() && done < total {
        return Err(AttemptErr::Retry("Kết nối bị ngắt giữa chừng".into()));
    }

    let got = format!("{:x}", hasher.finalize());
    if !got.eq_ignore_ascii_case(expect_sha256) {
        let _ = fs::remove_file(tmp);
        let msg = format!(
            "File tải về không khớp mã SHA-256 (nhận {got}, mong đợi {expect_sha256}) — đã xoá, hãy thử lại."
        );
        // Nếu vừa nối tiếp từ `.part` cũ thì có thể phần cũ hỏng → thử lại từ đầu 1 lần.
        return Err(if resumed { AttemptErr::Retry(msg) } else { AttemptErr::Fatal(msg) });
    }
    Ok(())
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

fn install_engine(root: &Path, cancel: &AtomicBool, mut on_progress: impl FnMut(u64, u64)) -> Result<(), String> {
    let zip_path = root.join("downloads").join("whisper-bin-x64.zip");
    download_verified(ENGINE_URL, ENGINE_SHA256, ENGINE_SIZE, &zip_path, cancel, &mut on_progress)?;
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

/// Chạy ở mức ưu tiên THẤP (BELOW_NORMAL) để nhận diện giọng nói — vốn ngốn CPU —
/// không làm đơ giao diện/các app khác trong lúc người dùng làm việc khác.
#[cfg(windows)]
const BELOW_NORMAL_PRIORITY_CLASS: u32 = 0x0000_4000;

fn spawn_tracked(
    slot: &'static Slot,
    cmd: &mut Command,
    low_priority: bool,
) -> Result<(Option<ChildStdout>, Option<ChildStderr>), String> {
    crate::record::proc::no_window(cmd);
    #[cfg(windows)]
    if low_priority {
        use std::os::windows::process::CommandExt;
        const CREATE_NO_WINDOW: u32 = 0x0800_0000;
        cmd.creation_flags(CREATE_NO_WINDOW | BELOW_NORMAL_PRIORITY_CLASS);
    }
    #[cfg(not(windows))]
    let _ = low_priority;
    let mut child = cmd
        .spawn()
        .map_err(|e| format!("Không khởi chạy được tiến trình: {e}"))?;
    let out = child.stdout.take();
    let err = child.stderr.take();
    {
        let mut held = slot.child.lock().unwrap_or_else(|e| e.into_inner());
        *held = Some(child);
        if cancelled(slot) {
            if let Some(c) = held.as_mut() {
                let _ = c.kill();
            }
        }
    }
    Ok((out, err))
}

fn finish_tracked(slot: &Slot) -> Result<ExitStatus, String> {
    let child = slot.child.lock().unwrap_or_else(|e| e.into_inner()).take();
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

fn norm_text(s: &str) -> String {
    s.chars().filter(|c| c.is_alphanumeric()).flat_map(|c| c.to_lowercase()).collect()
}

/// Whisper đôi khi kẹt vòng lặp: lặp NGUYÊN 1 câu hàng chục lần ("Cảm ơn các bạn đã xem…").
/// ≥ 3 dòng liên tiếp giống hệt (bỏ qua hoa/thường, dấu câu) → chỉ giữ dòng đầu. Hai dòng giống
/// nhau liền kề là bình thường (vd "Vâng. Vâng.") nên được giữ nguyên. Cũng bỏ dòng rỗng/0 ms.
fn collapse_repeats(raw: Vec<CaptionSegment>) -> Vec<CaptionSegment> {
    let mut out: Vec<CaptionSegment> = Vec::with_capacity(raw.len());
    let mut i = 0;
    while i < raw.len() {
        let key = norm_text(&raw[i].text);
        if key.is_empty() {
            i += 1;
            continue;
        }
        let mut j = i + 1;
        while j < raw.len() && norm_text(&raw[j].text) == key {
            j += 1;
        }
        let run = j - i;
        if run >= 3 {
            out.push(raw[i].clone());
        } else {
            out.extend(raw[i..j].iter().cloned());
        }
        i = j;
    }
    out.retain(|s| s.end_ms > s.start_ms);
    out
}

fn normalize_segments(raw: Vec<CaptionSegment>) -> Vec<CaptionSegment> {
    collapse_repeats(raw).into_iter().flat_map(split_long).collect()
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

/// Đếm luồng âm thanh từ stderr của `ffmpeg -i <file>` (không có file ra → thoát mã 1 nhưng vẫn in đủ luồng).
fn count_audio_streams(stderr: &str) -> usize {
    stderr
        .lines()
        .filter(|l| l.trim_start().starts_with("Stream #") && l.contains(": Audio:"))
        .count()
}

/// Video quay "Mic + Hệ thống" hoặc video nhập từ ngoài có thể chứa NHIỀU luồng âm thanh;
/// chỉ lấy luồng đầu sẽ bỏ sót lời nói nằm ở luồng khác (kết quả: phụ đề trống/thiếu).
/// Trộn tất cả (tối đa 8) thành 1 kênh mono 16 kHz.
fn audio_filter_args(streams: usize) -> Vec<String> {
    let n = streams.clamp(1, 8);
    if n == 1 {
        return vec!["-map".into(), "0:a:0".into()];
    }
    let inputs: String = (0..n).map(|i| format!("[0:a:{i}]")).collect();
    vec![
        "-filter_complex".into(),
        format!("{inputs}amix=inputs={n}:duration=longest[a]"),
        "-map".into(),
        "[a]".into(),
    ]
}

fn extract_audio(ffmpeg: &Path, video: &Path, wav: &Path) -> Result<(), String> {
    let streams = {
        let mut probe = Command::new(ffmpeg);
        probe.args(["-hide_banner", "-i"]).arg(video);
        crate::record::proc::run(&mut probe, Duration::from_secs(30))
            .map(|o| count_audio_streams(&o.stderr))
            .unwrap_or(1)
    };
    let mut cmd = Command::new(ffmpeg);
    cmd.args(["-y", "-hide_banner", "-loglevel", "error", "-i"])
        .arg(video)
        .args(audio_filter_args(streams))
        .args(["-vn", "-ac", "1", "-ar", "16000", "-c:a", "pcm_s16le"])
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

/// `whisper-cli.exe` đọc tham số dòng lệnh theo bảng mã ANSI: đường dẫn có ký tự ngoài ASCII (rất hay
/// gặp — tên người dùng Windows tiếng Việt như `C:\Users\Nguyễn An\...`) bị biến thành `?` và Whisper
/// báo "input file not found" / "failed to open model". Đã tái hiện bằng bản whisper-cli v1.9.2 thật.
/// Trả về đường dẫn THUẦN ASCII trỏ tới cùng file: giữ nguyên nếu đã ASCII, ngược lại dùng tên ngắn 8.3 của
/// Windows (`GetShortPathNameW`). Lỗi nếu ổ đĩa tắt tạo tên 8.3 — kèm hướng dẫn rõ ràng.
fn ascii_cli_path(p: &Path) -> Result<PathBuf, String> {
    if p.to_str().map(|s| s.is_ascii()).unwrap_or(false) {
        return Ok(p.to_path_buf());
    }
    #[cfg(windows)]
    {
        use std::os::windows::ffi::OsStrExt;
        #[link(name = "kernel32")]
        extern "system" {
            fn GetShortPathNameW(long: *const u16, short: *mut u16, cch: u32) -> u32;
        }
        let wide: Vec<u16> = p.as_os_str().encode_wide().chain(std::iter::once(0)).collect();
        // SAFETY: `wide` kết thúc bằng NUL; buffer đầu ra có đúng `need` phần tử như API yêu cầu.
        unsafe {
            let need = GetShortPathNameW(wide.as_ptr(), std::ptr::null_mut(), 0);
            if need > 0 {
                let mut buf = vec![0u16; need as usize];
                let n = GetShortPathNameW(wide.as_ptr(), buf.as_mut_ptr(), need);
                if n > 0 && n < need {
                    let short = String::from_utf16_lossy(&buf[..n as usize]);
                    if short.is_ascii() {
                        return Ok(PathBuf::from(short));
                    }
                }
            }
        }
    }
    Err(format!(
        "Đường dẫn chứa ký tự có dấu và Windows không tạo được tên ngắn (8.3) cho nó, nên Whisper không đọc được: {}. \
         Hãy chuyển thư mục dữ liệu của SnapDoc sang đường dẫn không dấu hoặc bật tạo tên 8.3 cho ổ đĩa (fsutil 8dot3name).",
        p.display()
    ))
}

/// Thông báo lỗi hữu ích từ log của whisper-cli: khi tham số sai nó in cả bảng trợ giúp dài SAU dòng lỗi,
/// nên lấy 6 dòng cuối chỉ thấy "usage/options". Ưu tiên các dòng có "error"/"failed".
fn useful_error(log: &[String]) -> String {
    let errs: Vec<String> = log
        .iter()
        .filter(|l| {
            let t = l.to_lowercase();
            t.contains("error") || t.contains("failed") || t.contains("cuda") && t.contains("out of memory")
        })
        .cloned()
        .collect();
    if errs.is_empty() {
        tail_lines(log, 6)
    } else {
        tail_lines(&errs, 5)
    }
}

/// Chạy Whisper. Nếu lần đầu thất bại (thường do GPU/CUDA: thiếu VRAM, driver cũ, DLL lỗi)
/// thì TỰ chạy lại 1 lần bằng CPU (`--no-gpu`) thay vì báo lỗi ngay.
fn run_whisper(
    slot: &'static Slot,
    cli: &Path,
    model: &Path,
    wav: &Path,
    lang: &str,
    out_base: &Path,
    vad: Option<&Path>,
    mut on_progress: impl FnMut(u32),
) -> Result<WhisperRun, String> {
    match run_whisper_once(slot, cli, model, wav, lang, out_base, vad, false, &mut on_progress) {
        Ok(r) => Ok(r),
        Err(first) if first != CANCELLED_MSG && !cancelled(slot) => {
            eprintln!("[SnapDoc][captions] Whisper lỗi, thử lại bằng CPU: {first}");
            run_whisper_once(slot, cli, model, wav, lang, out_base, vad, true, &mut on_progress)
                .map_err(|second| format!("{first}\n(Đã thử lại bằng CPU nhưng vẫn lỗi: {second})"))
        }
        Err(e) => Err(e),
    }
}

/// Các tham số làm Whisper ít "ảo giác"/lặp câu hơn (tách riêng để test).
fn whisper_quality_args(vad: Option<&Path>) -> Vec<String> {
    // -mc 0: không mang ngữ cảnh đoạn trước sang đoạn sau — nguyên nhân kinh điển của vòng lặp
    //        lặp 1 câu hàng chục lần và đứng ở 1 % rất lâu.
    // -sns : chặn token không phải lời nói (♪, [Music]…).
    // -ml 72 -sow: tách dòng theo MỐC THỜI GIAN THẬT của từng từ (không phải chia đều theo số ký tự
    //        như `split_long`), nên phụ đề bám sát giọng nói; ngắt ở ranh giới từ.
    let mut a: Vec<String> =
        vec!["-mc".into(), "0".into(), "-sns".into(), "-ml".into(), "72".into(), "-sow".into()];
    if let Some(v) = vad {
        // Đoạn lặng ≥ 0,5 s mới tách; đệm 0,1 s hai đầu để không cụt đầu/đuôi từ; mỗi đoạn tối đa 25 s.
        a.extend(
            ["--vad", "-vm"].iter().map(|s| s.to_string()),
        );
        a.push(v.to_string_lossy().to_string());
        a.extend(
            ["-vt", "0.5", "-vsd", "500", "-vp", "100", "-vmsd", "25"].iter().map(|s| s.to_string()),
        );
    }
    a
}

fn run_whisper_once(
    slot: &'static Slot,
    cli: &Path,
    model: &Path,
    wav: &Path,
    lang: &str,
    out_base: &Path,
    vad: Option<&Path>,
    no_gpu: bool,
    on_progress: &mut impl FnMut(u32),
) -> Result<WhisperRun, String> {
    let threads = std::thread::available_parallelism()
        .map(|n| n.get())
        .unwrap_or(4)
        .saturating_sub(1) // chừa 1 nhân cho giao diện
        .clamp(2, 8);
    // File vào/ra (wav, srt) nằm chung 1 thư mục tạm do app tạo: chạy với cwd = thư mục đó và dùng
    // TÊN TƯƠNG ĐỐI thuần ASCII ("audio.wav", "out") — cwd truyền bằng UTF-16 nên có dấu cũng an toàn.
    // Riêng model/VAD (nằm ở thư mục dữ liệu của app, có thể chứa tên người dùng có dấu) dùng tên 8.3.
    let work_dir = wav.parent().ok_or("Đường dẫn file âm thanh không hợp lệ")?;
    let (Some(wav_name), Some(out_name)) = (wav.file_name(), out_base.file_name()) else {
        return Err("Đường dẫn file âm thanh/kết quả không hợp lệ".into());
    };
    if out_base.parent() != Some(work_dir) {
        return Err("Lỗi nội bộ: file âm thanh và file kết quả phải cùng thư mục".into());
    }
    let model_arg = ascii_cli_path(model)?;
    let vad_arg = match vad {
        Some(v) => Some(ascii_cli_path(v)?),
        None => None,
    };
    let mut cmd = Command::new(cli);
    cmd.current_dir(work_dir);
    cmd.arg("-m")
        .arg(&model_arg)
        .arg("-f")
        .arg(wav_name)
        .args(["-l", lang, "-osrt", "-pp", "-t"])
        .arg(threads.to_string())
        .arg("-of")
        .arg(out_name)
        .args(whisper_quality_args(vad_arg.as_deref()))
        .stdin(Stdio::null())
        .stdout(Stdio::null())
        .stderr(Stdio::piped());
    if no_gpu {
        cmd.arg("--no-gpu");
    }

    let (_out, err) = spawn_tracked(slot, &mut cmd, true)?;
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
    let status = finish_tracked(slot)?;
    if cancelled(slot) {
        return Err(CANCELLED_MSG.into());
    }
    if !status.success() {
        return Err(format!(
            "Whisper thất bại ({status}): {}",
            useful_error(&log)
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
    slot: &'static Slot,
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

    let (out, err) = spawn_tracked(slot, &mut cmd, false)?;
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
    let status = finish_tracked(slot)?;
    let err_lines = err_thread.and_then(|t| t.join().ok()).unwrap_or_default();
    if cancelled(slot) {
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

/// Yêu cầu ghi phụ đề lên video vừa được dựng xong (xuất bản ĐÃ chỉnh sửa).
/// `segments` có mốc thời gian theo timeline CỦA VIDEO ĐÃ CHỈNH SỬA.
#[derive(Deserialize, Clone, Debug)]
#[serde(rename_all = "camelCase")]
pub struct CaptionExport {
    pub segments: Vec<CaptionSegment>,
    /// "soft" | "burn"
    pub mode: String,
    pub language: String,
}

/// Ghi phụ đề lên `file` và thay thế tại chỗ (ghi ra file tạm cạnh đó rồi đổi
/// tên — lỗi/huỷ giữa chừng không làm hỏng file gốc).
fn apply_captions_in_place(
    ffmpeg: &Path,
    file: &Path,
    segments: &[CaptionSegment],
    mode: &str,
    lang: &str,
    duration_ms: u64,
    on_progress: impl FnMut(u32),
) -> Result<(), String> {
    let tmp = TempDir::new()?;
    let srt = tmp.0.join("captions.srt");
    fs::write(&srt, format_srt(segments)).map_err(|e| format!("Không ghi được SRT tạm: {e}"))?;
    let staged = file.with_extension("captions.part.mp4");
    let result = if mode == "soft" {
        export_soft(ffmpeg, file, &srt, &staged, lang)
    } else {
        export_burn(&EXPORT, ffmpeg, file, &tmp.0, &staged, duration_ms, on_progress)
    };
    if let Err(e) = result {
        let _ = fs::remove_file(&staged);
        return Err(e);
    }
    // `fs::rename` trên Windows thay thế file đích đã tồn tại.
    fs::rename(&staged, file).map_err(|e| {
        let _ = fs::remove_file(&staged);
        format!("Không lưu được video có phụ đề: {e}")
    })
}

/// Dùng bởi `history::commands::trim_history_video`: sau khi bản đã chỉnh sửa
/// được dựng xong thì ghi phụ đề lên chính file đó (trước khi vào History).
pub(crate) fn apply_to_file(
    app: &AppHandle,
    file: &Path,
    req: &CaptionExport,
    duration_ms: u64,
) -> Result<(), String> {
    ensure_supported()?;
    if req.mode != "soft" && req.mode != "burn" {
        return Err(format!("Chế độ xuất phụ đề không hợp lệ: {}", req.mode));
    }
    let lang = validate_lang(&req.language)?;
    if format_srt(&req.segments).is_empty() {
        return Ok(());
    }
    let _guard = JobGuard::acquire(&EXPORT)?;
    let ffmpeg = crate::record::encoder::sidecar_path("ffmpeg")?;
    let ctx = Ctx::new("export");
    report(app, &ctx, "export", 0, 100);
    let a = app.clone();
    let c = ctx.clone();
    let result = apply_captions_in_place(&ffmpeg, file, &req.segments, &req.mode, &lang, duration_ms, move |p| {
        report(&a, &c, "export", p as u64, 100)
    });
    clear_running(&ctx);
    result?;
    Ok(())
}

/* ───────────── Tauri commands ───────────── */

/// Phát tiến độ + ghi vào registry (để cửa sổ mở sau vẫn thấy tác vụ đang chạy).
fn report(app: &AppHandle, ctx: &Ctx, stage: &'static str, done: u64, total: u64) {
    let percent = if total > 0 { ((done * 100) / total).min(100) as u32 } else { 0 };
    let p = Progress {
        job: ctx.job,
        stage,
        percent,
        done_bytes: done,
        total_bytes: total,
        video_path: ctx.video_path.clone(),
        model_id: ctx.model_id.clone(),
        index: ctx.index,
        count: ctx.count,
        started_ms: ctx.started_ms,
    };
    registry().running.insert(ctx.job, p.clone());
    let _ = app.emit("captions-progress", p);
}

fn clear_running(ctx: &Ctx) {
    registry().running.remove(ctx.job);
}

fn emit_finished(app: &AppHandle, ctx: &Ctx, result: &Result<(), String>) {
    let (ok, was_cancelled, error) = match result {
        Ok(()) => (true, false, None),
        Err(e) if e == CANCELLED_MSG => (false, true, None),
        Err(e) => (false, false, Some(e.clone())),
    };
    let _ = app.emit(
        "captions-job-finished",
        Finished {
            job: ctx.job,
            video_path: ctx.video_path.clone(),
            ok,
            cancelled: was_cancelled,
            error,
        },
    );
}

/// Chạy `f` ở 1 thread nền; panic được chuyển thành lỗi để làn tác vụ luôn được
/// giải phóng và giao diện không kẹt ở "đang chạy" mãi mãi.
fn spawn_job<T: Send + 'static>(
    name: &str,
    f: impl FnOnce() -> Result<T, String> + Send + 'static,
    done: impl FnOnce(Result<T, String>) + Send + 'static,
) -> Result<(), String> {
    std::thread::Builder::new()
        .name(name.to_string())
        .spawn(move || {
            let r = std::panic::catch_unwind(std::panic::AssertUnwindSafe(f))
                .unwrap_or_else(|_| Err("Lỗi nội bộ khi xử lý phụ đề.".to_string()));
            done(r);
        })
        .map(|_| ())
        .map_err(|e| format!("Không khởi chạy được luồng xử lý: {e}"))
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

/// Tác vụ nền đang chạy + các kết quả nhận diện chưa ai nhận. Cửa sổ vừa mở
/// (hoặc mở lại sau khi đóng) gọi hàm này để nối lại với tác vụ đang chạy.
#[tauri::command]
pub fn captions_jobs() -> JobsSnapshot {
    let reg = registry();
    JobsSnapshot {
        running: reg.running.values().cloned().collect(),
        pending: reg.outcomes.keys().cloned().collect(),
    }
}

/// Lấy (và xoá khỏi bộ nhớ) kết quả nhận diện của `video_path`, nếu đã xong.
#[tauri::command]
pub fn captions_take_outcome(video_path: String) -> Option<TranscribeOutcome> {
    registry().outcomes.remove(&video_path)
}

/// Tải engine (nếu chưa có) + TẤT CẢ các model được chọn, lần lượt, ở nền. Trả về
/// ngay; tiến độ qua sự kiện `captions-progress` (job "download"), kết thúc qua
/// `captions-job-finished`. Không chặn nhận diện/xuất video đang chạy.
#[tauri::command]
pub async fn captions_setup(app: AppHandle, model_ids: Vec<String>) -> Result<(), String> {
    ensure_supported()?;
    let mut defs: Vec<&'static ModelDef> = Vec::new();
    for id in &model_ids {
        let d = model_def(id)?;
        if !defs.iter().any(|x| x.id == d.id) {
            defs.push(d);
        }
    }
    let mdir = models_dir(&app);
    let todo: Vec<&'static ModelDef> = defs.into_iter().filter(|d| !model_ready(&mdir, d)).collect();
    let need_engine = !engine_ready(&engine_dir(&app));
    if todo.is_empty() && !need_engine {
        return Ok(());
    }
    let guard = JobGuard::acquire(&DOWNLOAD)?;

    let mut base = Ctx::new("download");
    base.count = todo.len() as u32;
    report(&app, &base, if need_engine { "engine" } else { "model" }, 0, 0);

    let a = app.clone();
    let b = base.clone();
    let spawned = spawn_job(
        "captions-download",
        move || {
            let root = root_dir(&a);
            if !engine_ready(&engine_dir(&a)) {
                let (aa, bb) = (a.clone(), b.clone());
                install_engine(&root, &DOWNLOAD.cancel, move |d, t| report(&aa, &bb, "engine", d, t))?;
            }
            let mdir = models_dir(&a);
            for (i, def) in todo.iter().enumerate() {
                if model_ready(&mdir, def) {
                    continue;
                }
                let mut ctx = b.clone();
                ctx.model_id = Some(def.id.to_string());
                ctx.index = (i + 1) as u32;
                let aa = a.clone();
                let cc = ctx.clone();
                download_verified(
                    &model_url(def.file),
                    def.sha256,
                    def.size,
                    &mdir.join(def.file),
                    &DOWNLOAD.cancel,
                    move |d, t| report(&aa, &cc, "model", d, t),
                )?;
            }
            Ok(())
        },
        {
            let a = app.clone();
            let b = base.clone();
            move |res: Result<(), String>| {
                drop(guard); // giải phóng làn TRƯỚC khi báo xong để giao diện bấm tải tiếp được ngay
                clear_running(&b);
                emit_finished(&a, &b, &res);
            }
        },
    );
    if let Err(e) = spawned {
        clear_running(&base);
        return Err(e);
    }
    Ok(())
}

/// Huỷ tác vụ phụ đề đang chạy. `job`: "download" | "transcribe" | "export".
#[tauri::command]
pub fn captions_cancel(job: String) {
    let Some(slot) = slot_by_name(&job) else { return };
    slot.cancel.store(true, Ordering::SeqCst);
    if let Some(c) = slot.child.lock().unwrap_or_else(|e| e.into_inner()).as_mut() {
        let _ = c.kill();
    }
}

/// Nhận diện giọng nói ở NỀN: trả về ngay. Kết quả được giữ ở backend (xem
/// `captions_take_outcome`) nên đóng hộp thoại hay đóng cả cửa sổ Editor đều không
/// làm mất công việc đã chạy.
#[tauri::command]
pub async fn captions_transcribe_start(
    app: AppHandle,
    video_path: String,
    language: String,
    model_id: String,
) -> Result<(), String> {
    ensure_supported()?;
    let lang = validate_lang(&language)?;
    let def = model_def(&model_id)?;
    let video = PathBuf::from(&video_path);
    require_existing_file(&video)?;
    if !engine_ready(&engine_dir(&app)) || !model_ready(&models_dir(&app), def) {
        return Err("Chưa cài đặt engine/model phụ đề — hãy bấm “Tải về & cài đặt” trước.".into());
    }
    let guard = JobGuard::acquire(&TRANSCRIBE)?;
    registry().outcomes.remove(&video_path);

    let mut ctx = Ctx::new("transcribe");
    ctx.video_path = Some(video_path.clone());
    ctx.model_id = Some(model_id);
    ctx.index = 1;
    ctx.count = 1;
    report(&app, &ctx, "audio", 0, 100);

    let (a, c) = (app.clone(), ctx.clone());
    let spawned = spawn_job(
        "captions-transcribe",
        move || transcribe_blocking(&a, &video, &lang, def, &c),
        {
            let (a, c) = (app.clone(), ctx.clone());
            move |res: Result<TranscribeResult, String>| {
                drop(guard);
                let path = c.video_path.clone().unwrap_or_default();
                let unit = match res {
                    Ok(r) => {
                        registry().outcomes.insert(
                            path,
                            TranscribeOutcome { ok: true, error: None, language: r.language, segments: r.segments },
                        );
                        Ok(())
                    }
                    Err(e) => {
                        if e != CANCELLED_MSG {
                            registry().outcomes.insert(
                                path,
                                TranscribeOutcome {
                                    ok: false,
                                    error: Some(e.clone()),
                                    language: String::new(),
                                    segments: vec![],
                                },
                            );
                        }
                        Err(e)
                    }
                };
                clear_running(&c);
                emit_finished(&a, &c, &unit);
            }
        },
    );
    if let Err(e) = spawned {
        clear_running(&ctx);
        return Err(e);
    }
    Ok(())
}

fn transcribe_blocking(
    app: &AppHandle,
    video: &Path,
    lang: &str,
    def: &'static ModelDef,
    ctx: &Ctx,
) -> Result<TranscribeResult, String> {
    let cli = engine_dir(app).join(CLI_NAME);
    let model = models_dir(app).join(def.file);
    let ffmpeg = crate::record::encoder::sidecar_path("ffmpeg")?;

    let tmp = TempDir::new()?;
    let wav = tmp.0.join("audio.wav");
    report(app, ctx, "audio", 0, 100);
    extract_audio(&ffmpeg, video, &wav)?;
    if cancelled(&TRANSCRIBE) {
        return Err(CANCELLED_MSG.into());
    }

    // VAD: tải 0,9 MB nếu thiếu; lỗi tải thì bỏ qua (nhận diện không VAD vẫn chạy được).
    let vad_dir = models_dir(app);
    if !vad_ready(&vad_dir) {
        let _ = download_verified(VAD_URL, VAD_SHA256, VAD_SIZE, &vad_dir.join(VAD_FILE), &TRANSCRIBE.cancel, |_, _| {});
        if cancelled(&TRANSCRIBE) {
            return Err(CANCELLED_MSG.into());
        }
    }
    let vad_path = vad_dir.join(VAD_FILE);
    let vad = if vad_ready(&vad_dir) { Some(vad_path.as_path()) } else { None };

    let (a, c) = (app.clone(), ctx.clone());
    let run = run_whisper(&TRANSCRIBE, &cli, &model, &wav, lang, &tmp.0.join("out"), vad, move |p| {
        report(&a, &c, "transcribe", p as u64, 100)
    })?;
    let raw = fs::read_to_string(&run.srt_path).map_err(|e| format!("Không đọc được kết quả: {e}"))?;
    let segments = normalize_segments(parse_srt(&raw));
    if segments.is_empty() {
        return Err("Không nhận diện được lời thoại nào trong video (có thể video không có tiếng nói).".into());
    }
    let language = if lang == "auto" {
        run.language.unwrap_or_else(|| "auto".to_string())
    } else {
        lang.to_string()
    };
    Ok(TranscribeResult { language, segments })
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
        let _guard = JobGuard::acquire(&EXPORT)?;
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
        let ctx = Ctx::new("export");
        let staged = output.with_extension("captions.part.mp4");
        let result = if mode == "soft" {
            report(&app, &ctx, "export", 0, 100);
            export_soft(&ffmpeg, &input, &srt, &staged, &lang)
        } else {
            let (a, c) = (app.clone(), ctx.clone());
            export_burn(&EXPORT, &ffmpeg, &input, &tmp.0, &staged, duration_ms, move |p| {
                report(&a, &c, "export", p as u64, 100)
            })
        };
        if let Err(e) = result {
            clear_running(&ctx);
            let _ = fs::remove_file(&staged);
            return Err(e);
        }
        let _ = fs::remove_file(&output);
        fs::rename(&staged, &output).map_err(|e| format!("Không lưu được video: {e}"))?;
        report(&app, &ctx, "export", 100, 100);
        clear_running(&ctx);
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
        let run = run_whisper(&TRANSCRIBE, &cli, &model, &wav, "en", &tmp.0.join("out"), None, |p| last = p).expect("whisper");
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
        export_burn(&EXPORT, &ffmpeg, &video, &tmp.0, &burn, 12_000, |p| seen = p).expect("burn");
        assert!(burn.metadata().unwrap().len() > 1_000);
        println!("burn progress max seen: {seen}");

        // Đường dùng khi xuất video ĐÃ chỉnh sửa: ghi phụ đề tại chỗ lên 1 file có sẵn.
        let inplace = tmp.0.join("inplace.mp4");
        fs::copy(&video, &inplace).unwrap();
        let before = inplace.metadata().unwrap().len();
        apply_captions_in_place(&ffmpeg, &inplace, &segs, "soft", "en", 12_000, |_| {}).expect("in-place soft");
        assert_ne!(inplace.metadata().unwrap().len(), before, "file phải được thay bằng bản có phụ đề");
        assert!(!inplace.with_extension("captions.part.mp4").exists(), "không để lại file tạm");
        // Thất bại không được để lại file tạm.
        let missing = tmp.0.join("missing.mp4");
        assert!(apply_captions_in_place(&ffmpeg, &missing, &segs, "burn", "en", 1_000, |_| {}).is_err());
        assert!(!missing.with_extension("captions.part.mp4").exists());
    }

    /// Máy chủ giả: lần 1 gửi 250 KB rồi ngắt kết nối; lần 2 phải nhận `Range` và
    /// trả phần còn lại (206). Kết quả cuối phải khớp SHA-256 toàn file.
    #[test]
    fn download_resumes_after_dropped_connection() {
        use std::net::TcpListener;
        let payload: Vec<u8> = (0..600_000u32).map(|i| (i % 251) as u8).collect();
        let mut h = Sha256::new();
        h.update(&payload);
        let sha = format!("{:x}", h.finalize());

        let listener = TcpListener::bind("127.0.0.1:0").unwrap();
        let port = listener.local_addr().unwrap().port();
        let data = payload.clone();
        let server = std::thread::spawn(move || {
            let mut starts = Vec::new();
            for round in 0..2 {
                let (mut sock, _) = listener.accept().unwrap();
                let mut req = Vec::new();
                let mut b = [0u8; 1024];
                loop {
                    let n = sock.read(&mut b).unwrap();
                    req.extend_from_slice(&b[..n]);
                    if n == 0 || req.windows(4).any(|w| w == b"\r\n\r\n") {
                        break;
                    }
                }
                let text = String::from_utf8_lossy(&req).to_ascii_lowercase();
                let start = text
                    .lines()
                    .find_map(|l| {
                        l.strip_prefix("range: bytes=")
                            .and_then(|r| r.trim().trim_end_matches('-').parse::<usize>().ok())
                    })
                    .unwrap_or(0);
                starts.push(start);
                if round == 0 {
                    let head = format!("HTTP/1.1 200 OK\r\nContent-Length: {}\r\nConnection: close\r\n\r\n", data.len());
                    sock.write_all(head.as_bytes()).unwrap();
                    sock.write_all(&data[..250_000]).unwrap();
                } else {
                    let body = &data[start..];
                    let head = format!(
                        "HTTP/1.1 206 Partial Content\r\nContent-Length: {}\r\nContent-Range: bytes {}-{}/{}\r\nConnection: close\r\n\r\n",
                        body.len(),
                        start,
                        data.len() - 1,
                        data.len()
                    );
                    sock.write_all(head.as_bytes()).unwrap();
                    sock.write_all(body).unwrap();
                }
            }
            starts
        });

        let dir = TempDir::new().unwrap();
        let dest = dir.0.join("m.bin");
        let cancel = AtomicBool::new(false);
        download_verified(&format!("http://127.0.0.1:{port}/m.bin"), &sha, 600_000, &dest, &cancel, |_, _| {})
            .expect("tải phải thành công sau khi nối tiếp");
        assert_eq!(fs::read(&dest).unwrap(), payload);
        assert!(!dest.with_extension("part").exists(), "không để lại .part");
        let starts = server.join().unwrap();
        assert_eq!(starts[0], 0);
        assert!(starts[1] > 0, "lần 2 phải xin tiếp từ byte đã có, không tải lại từ đầu: {starts:?}");
    }

    #[test]
    fn job_slots_are_independent() {
        let d = JobGuard::acquire(&DOWNLOAD).expect("download");
        // Đang tải model vẫn nhận diện / xuất được.
        let t = JobGuard::acquire(&TRANSCRIBE).expect("transcribe song song với download");
        let e = JobGuard::acquire(&EXPORT).expect("export song song");
        // Cùng 1 làn thì chặn.
        assert!(JobGuard::acquire(&TRANSCRIBE).is_err());
        drop(t);
        assert!(JobGuard::acquire(&TRANSCRIBE).is_ok());
        drop(d);
        drop(e);
        assert!(slot_by_name("download").is_some() && slot_by_name("nope").is_none());
    }

    #[test]
    fn outcome_is_kept_until_taken() {
        let key = "C:/tmp/outcome_test.mp4".to_string();
        registry().outcomes.insert(
            key.clone(),
            TranscribeOutcome { ok: true, error: None, language: "vi".into(), segments: vec![seg(0, 1000, "x")] },
        );
        assert!(captions_jobs().pending.contains(&key));
        let got = captions_take_outcome(key.clone()).expect("còn kết quả");
        assert_eq!(got.segments.len(), 1);
        assert!(captions_take_outcome(key).is_none(), "chỉ nhận được 1 lần");
    }

    #[test]
    fn collapses_runaway_repetition_but_keeps_legit_double() {
        let looped: Vec<CaptionSegment> = (0..12)
            .map(|i| seg(i * 1000, i * 1000 + 900, if i % 2 == 0 { "Cảm ơn các bạn đã xem." } else { "cảm ơn các bạn đã xem" }))
            .collect();
        let out = collapse_repeats(looped);
        assert_eq!(out.len(), 1, "vòng lặp 12 lần phải còn 1 dòng");
        assert_eq!(out[0].start_ms, 0);

        let double = vec![seg(0, 500, "Vâng."), seg(600, 1100, "Vâng."), seg(1200, 2000, "Tiếp theo nhé")];
        assert_eq!(collapse_repeats(double.clone()), double, "2 dòng giống nhau liền kề là bình thường");

        let empties = vec![seg(0, 0, "x"), seg(0, 900, "  . "), seg(1000, 2000, "Ok")];
        assert_eq!(collapse_repeats(empties), vec![seg(1000, 2000, "Ok")]);
    }

    #[test]
    fn counts_audio_streams_and_builds_mix_filter() {
        let err = "  Stream #0:0(und): Video: h264 (High)\n  Stream #0:1(und): Audio: aac (LC), 48000 Hz\n    Stream #0:2(und): Audio: aac (LC), 44100 Hz\n";
        assert_eq!(count_audio_streams(err), 2);
        assert_eq!(count_audio_streams("Stream #0:0: Video: h264"), 0);
        assert_eq!(audio_filter_args(1), vec!["-map".to_string(), "0:a:0".into()]);
        let f = audio_filter_args(2);
        assert_eq!(f[0], "-filter_complex");
        assert_eq!(f[1], "[0:a:0][0:a:1]amix=inputs=2:duration=longest[a]");
        assert_eq!(audio_filter_args(99)[1].matches("[0:a:").count(), 8, "tối đa 8 luồng");
    }

    #[test]
    fn quality_args_enable_vad_only_when_model_present() {
        let none = whisper_quality_args(None);
        assert!(none.contains(&"-mc".to_string()) && none.contains(&"-sns".to_string()));
        assert!(!none.contains(&"--vad".to_string()));
        let with = whisper_quality_args(Some(Path::new("C:/x/vad.bin")));
        assert!(with.contains(&"--vad".to_string()));
        assert!(with.windows(2).any(|w| w[0] == "-vm" && w[1].ends_with("vad.bin")));
    }

    #[test]
    fn quality_args_split_lines_by_real_word_timestamps() {
        let a = whisper_quality_args(None);
        assert!(a.windows(2).any(|w| w[0] == "-ml" && w[1] == "72"));
        assert!(a.contains(&"-sow".to_string()));
    }

    #[test]
    fn ascii_paths_pass_through_unchanged() {
        let p = Path::new("C:\\Users\\bob\\models\\ggml-base.bin");
        assert_eq!(ascii_cli_path(p).unwrap(), p);
    }

    #[cfg(windows)]
    #[test]
    fn accented_paths_become_ascii_8dot3_or_a_clear_error() {
        // Bug thật: whisper-cli không đọc được đường dẫn có dấu (xem `ascii_cli_path`).
        let d = std::env::temp_dir().join(format!("thư mục có dấu {}", uuid::Uuid::new_v4().simple()));
        fs::create_dir_all(&d).unwrap();
        let f = d.join("mô hình.bin");
        fs::write(&f, b"x").unwrap();
        match ascii_cli_path(&f) {
            Ok(short) => {
                assert!(short.to_str().unwrap().is_ascii(), "phải thuần ASCII: {short:?}");
                assert_eq!(fs::read(&short).unwrap(), b"x", "phải trỏ đúng file");
            }
            Err(e) => assert!(e.contains("8.3"), "lỗi phải nói rõ nguyên nhân: {e}"),
        }
        let _ = fs::remove_dir_all(&d);
    }

    #[test]
    fn useful_error_skips_the_help_text_that_follows_the_real_error() {
        let log: Vec<String> = [
            "error: input file not found 'x.wav'",
            "error: no input files specified",
            "usage: whisper-cli.exe [options] file0 file1 ...",
            "  -h, --help   show this help message and exit",
            "  -t N, --threads N  number of threads",
            "  -p N, --processors N  number of processors",
            "  -ot N, --offset-t N  time offset in milliseconds",
            "  -on N, --offset-n N  segment index offset",
        ]
        .iter()
        .map(|s| s.to_string())
        .collect();
        let msg = useful_error(&log);
        assert!(msg.contains("input file not found") && !msg.contains("usage:"), "{msg}");
        assert_eq!(useful_error(&["plain line".to_string()]), "plain line");
    }

    #[test]
    fn vad_constants_are_sane() {
        assert_eq!(VAD_SHA256.len(), 64);
        assert!(VAD_URL.ends_with(VAD_FILE));
        assert!(VAD_SIZE > 100_000 && VAD_SIZE < 5_000_000);
    }

    #[test]
    fn caption_export_deserializes_frontend_payload() {
        let json = r#"{"segments":[{"startMs":0,"endMs":1500,"text":"Xin chào"}],"mode":"burn","language":"vi"}"#;
        let req: CaptionExport = serde_json::from_str(json).unwrap();
        assert_eq!(req.mode, "burn");
        assert_eq!(req.language, "vi");
        assert_eq!(req.segments, vec![seg(0, 1_500, "Xin chào")]);
    }
}
