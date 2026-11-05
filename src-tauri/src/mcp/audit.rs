//! Nhật ký thao tác của AI agent — JSON Lines (`mcp-audit.jsonl`), CHỈ GHI THÊM.
//!
//! - Agent KHÔNG có tool nào xoá/sửa nhật ký (chỉ có `get_activity_log` để đọc).
//! - Chỉ người dùng xoá được, qua lệnh Tauri của giao diện (và việc xoá cũng được
//!   ghi lại thành một dòng mới).
//! - Quá `MAX_BYTES` thì xoay vòng: file hiện tại → `mcp-audit.1.jsonl` (ghi đè bản
//!   xoay cũ); đọc luôn gộp cả hai file nên người dùng vẫn thấy lịch sử gần đây.
//! - Tham số được RÚT GỌN (chuỗi dài bị cắt, mảng dài thay bằng "[N items]") nên
//!   nhật ký không phình ra và không chứa dữ liệu lớn.

use serde::{Deserialize, Serialize};
use serde_json::Value;
use std::io::Write;
use std::path::{Path, PathBuf};
use std::sync::Mutex;

const MAX_BYTES: u64 = 1_500_000;
const MAX_STR: usize = 120;
const MAX_ARGS_LEN: usize = 500;

#[derive(Clone, Debug, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct Entry {
    /// Thời điểm (ms từ epoch).
    pub ts: i64,
    pub tool: String,
    /// "read" | "write" | "destructive" | "system"
    pub kind: String,
    /// Tham số đã rút gọn.
    pub args: String,
    /// "ok" | "error" | "denied" | "running"
    pub outcome: String,
    /// Kết quả/lỗi rút gọn.
    pub detail: String,
    /// Tên client MCP (nếu khai báo lúc initialize).
    pub client: String,
    pub duration_ms: u64,
}

pub fn now_ms() -> i64 {
    std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_millis() as i64)
        .unwrap_or(0)
}

fn shrink(v: &Value, depth: usize) -> Value {
    match v {
        Value::String(s) if s.chars().count() > MAX_STR => {
            let cut: String = s.chars().take(MAX_STR).collect();
            Value::String(format!("{cut}…(+{} ký tự)", s.chars().count() - MAX_STR))
        }
        Value::Array(a) if a.len() > 8 => Value::String(format!("[{} items]", a.len())),
        Value::Array(a) => Value::Array(a.iter().map(|x| shrink(x, depth + 1)).collect()),
        Value::Object(m) if depth < 4 => {
            Value::Object(m.iter().map(|(k, x)| (k.clone(), shrink(x, depth + 1))).collect())
        }
        Value::Object(_) => Value::String("{…}".into()),
        other => other.clone(),
    }
}

/// Rút gọn tham số để ghi nhật ký.
pub fn summarize_args(args: &Value) -> String {
    let s = shrink(args, 0).to_string();
    if s.chars().count() > MAX_ARGS_LEN {
        let cut: String = s.chars().take(MAX_ARGS_LEN).collect();
        format!("{cut}…")
    } else {
        s
    }
}

/// Rút gọn một đoạn văn bản (kết quả/lỗi) cho cột "detail".
pub fn clip(s: &str, max: usize) -> String {
    let one_line = s.replace(['\r', '\n'], " ");
    if one_line.chars().count() > max {
        let cut: String = one_line.chars().take(max).collect();
        format!("{cut}…")
    } else {
        one_line
    }
}

pub struct AuditLog {
    path: PathBuf,
    lock: Mutex<()>,
}

impl AuditLog {
    pub fn new(dir: &Path) -> Self {
        Self { path: dir.join("mcp-audit.jsonl"), lock: Mutex::new(()) }
    }

    fn rotated(&self) -> PathBuf {
        self.path.with_file_name("mcp-audit.1.jsonl")
    }

    pub fn append(&self, e: &Entry) {
        let _g = self.lock.lock().unwrap_or_else(|p| p.into_inner());
        if let Some(parent) = self.path.parent() {
            let _ = std::fs::create_dir_all(parent);
        }
        if std::fs::metadata(&self.path).map(|m| m.len() > MAX_BYTES).unwrap_or(false) {
            let _ = std::fs::remove_file(self.rotated());
            let _ = std::fs::rename(&self.path, self.rotated());
        }
        let Ok(line) = serde_json::to_string(e) else { return };
        if let Ok(mut f) = std::fs::OpenOptions::new().create(true).append(true).open(&self.path) {
            let _ = writeln!(f, "{line}");
        }
    }

    /// `n` dòng mới nhất, MỚI NHẤT TRƯỚC.
    pub fn tail(&self, n: usize) -> Vec<Entry> {
        let _g = self.lock.lock().unwrap_or_else(|p| p.into_inner());
        let mut all: Vec<Entry> = Vec::new();
        for p in [self.rotated(), self.path.clone()] {
            if let Ok(s) = std::fs::read_to_string(&p) {
                all.extend(s.lines().filter_map(|l| serde_json::from_str::<Entry>(l).ok()));
            }
        }
        all.reverse();
        all.truncate(n);
        all
    }

    /// Chỉ giao diện người dùng gọi (KHÔNG có tool MCP nào dẫn tới đây).
    pub fn clear(&self) {
        let _g = self.lock.lock().unwrap_or_else(|p| p.into_inner());
        let _ = std::fs::remove_file(&self.path);
        let _ = std::fs::remove_file(self.rotated());
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    fn tmpdir(name: &str) -> PathBuf {
        let d = std::env::temp_dir().join(format!("snapdoc-audit-{name}-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&d);
        d
    }

    fn entry(tool: &str, ts: i64) -> Entry {
        Entry {
            ts,
            tool: tool.into(),
            kind: "write".into(),
            args: "{}".into(),
            outcome: "ok".into(),
            detail: String::new(),
            client: "test".into(),
            duration_ms: 3,
        }
    }

    #[test]
    fn append_and_tail_newest_first() {
        let d = tmpdir("tail");
        let log = AuditLog::new(&d);
        for i in 0..5 {
            log.append(&entry(&format!("t{i}"), i));
        }
        let t = log.tail(3);
        assert_eq!(t.iter().map(|e| e.tool.as_str()).collect::<Vec<_>>(), ["t4", "t3", "t2"]);
        assert_eq!(log.tail(100).len(), 5);
        let _ = std::fs::remove_dir_all(&d);
    }

    #[test]
    fn log_survives_reopen_and_is_append_only() {
        let d = tmpdir("reopen");
        AuditLog::new(&d).append(&entry("a", 1));
        AuditLog::new(&d).append(&entry("b", 2));
        let t = AuditLog::new(&d).tail(10);
        assert_eq!(t.len(), 2);
        assert_eq!(t[1].tool, "a", "dòng cũ không bị ghi đè");
        let _ = std::fs::remove_dir_all(&d);
    }

    #[test]
    fn corrupt_lines_are_skipped() {
        let d = tmpdir("corrupt");
        let log = AuditLog::new(&d);
        log.append(&entry("ok1", 1));
        std::fs::OpenOptions::new().append(true).open(d.join("mcp-audit.jsonl")).unwrap().write_all(b"rubbish\n").unwrap();
        log.append(&entry("ok2", 2));
        assert_eq!(log.tail(10).len(), 2);
        let _ = std::fs::remove_dir_all(&d);
    }

    #[test]
    fn rotation_keeps_recent_history_readable() {
        let d = tmpdir("rotate");
        let log = AuditLog::new(&d);
        let mut big = entry("big", 0);
        big.detail = "x".repeat(1000);
        for i in 0..1800 {
            big.ts = i;
            log.append(&big);
        }
        assert!(d.join("mcp-audit.1.jsonl").exists(), "đã xoay vòng");
        let all = log.tail(100_000);
        assert!(all.len() > 1000 && all[0].ts == 1799, "bản ghi mới nhất vẫn đọc được: {}", all.len());
        let _ = std::fs::remove_dir_all(&d);
    }

    #[test]
    fn clear_removes_everything() {
        let d = tmpdir("clear");
        let log = AuditLog::new(&d);
        log.append(&entry("a", 1));
        log.clear();
        assert!(log.tail(10).is_empty());
        let _ = std::fs::remove_dir_all(&d);
    }

    #[test]
    fn args_are_shortened() {
        let long = "y".repeat(500);
        let s = summarize_args(&json!({"path": long, "keepRanges": [[0,1],[1,2],[2,3],[3,4],[4,5],[5,6],[6,7],[7,8],[8,9],[9,10]], "n": 3}));
        assert!(s.chars().count() <= MAX_ARGS_LEN + 1, "độ dài {}", s.chars().count());
        assert!(s.contains("[10 items]"));
        assert!(s.contains("+380 ký tự"));
        assert!(s.contains("\"n\":3"));
    }

    #[test]
    fn clip_flattens_newlines() {
        assert_eq!(clip("a\nb\r\nc", 10), "a b  c");
        assert_eq!(clip("abcdef", 3), "abc…");
    }
}
