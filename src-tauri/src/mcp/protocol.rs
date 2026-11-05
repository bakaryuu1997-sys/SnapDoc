//! Giao thức MCP (JSON-RPC 2.0) + ĐIỂM CHẶN an toàn duy nhất cho mọi lời gọi tool.
//! Thuần logic (không phụ thuộc Tauri) để unit test được: phần thực thi tool thật đi
//! qua trait [`Host`].

use super::audit::{self, AuditLog, Entry};
use super::config::McpConfig;
use super::jobs::JobStore;
use super::policy::{self, Class, RateLimiter};
use serde_json::{json, Value};
use std::collections::HashMap;
use std::path::PathBuf;
use std::sync::{Arc, Mutex};
use std::time::{Duration, Instant};

pub const SERVER_NAME: &str = "snapdoc";
const SUPPORTED_VERSIONS: &[&str] = &["2025-06-18", "2025-03-26", "2024-11-05"];

pub type Notifier = Box<dyn Fn(&Entry) + Send + Sync>;

pub struct McpState {
    pub dir: PathBuf,
    pub cfg: Mutex<McpConfig>,
    pub audit: AuditLog,
    pub jobs: Arc<JobStore>,
    /// Phụ đề đã nhận diện trong phiên này, theo id item: {language, segments}.
    pub captions: Mutex<HashMap<String, Value>>,
    write_limiter: Mutex<RateLimiter>,
    read_limiter: Mutex<RateLimiter>,
    auth_fail_logged: Mutex<Option<Instant>>,
    notifier: Mutex<Option<Notifier>>,
    pub version: String,
}

impl McpState {
    pub fn new(dir: PathBuf, cfg: McpConfig, version: &str) -> Self {
        Self {
            audit: AuditLog::new(&dir),
            dir,
            cfg: Mutex::new(cfg),
            jobs: Arc::new(JobStore::default()),
            captions: Mutex::new(HashMap::new()),
            write_limiter: Mutex::new(RateLimiter::new(policy::WRITE_PER_MIN, Duration::from_secs(60))),
            read_limiter: Mutex::new(RateLimiter::new(policy::READ_PER_MIN, Duration::from_secs(60))),
            auth_fail_logged: Mutex::new(None),
            notifier: Mutex::new(None),
            version: version.to_string(),
        }
    }

    pub fn set_notifier(&self, n: Notifier) {
        *self.notifier.lock().unwrap_or_else(|e| e.into_inner()) = Some(n);
    }

    pub fn cfg(&self) -> McpConfig {
        self.cfg.lock().unwrap_or_else(|e| e.into_inner()).clone()
    }

    /// Ghi nhật ký + báo giao diện (nếu có).
    pub fn log(&self, e: Entry) {
        self.audit.append(&e);
        if let Some(n) = self.notifier.lock().unwrap_or_else(|p| p.into_inner()).as_ref() {
            n(&e);
        }
    }

    /// Ghi 1 dòng "hệ thống" (đổi cấu hình, xoá nhật ký…).
    pub fn log_system(&self, what: &str, detail: &str) {
        self.log(Entry {
            ts: audit::now_ms(),
            tool: what.to_string(),
            kind: "system".into(),
            args: String::new(),
            outcome: "ok".into(),
            detail: detail.to_string(),
            client: "app".into(),
            duration_ms: 0,
        });
    }

    /// Yêu cầu HTTP bị từ chối vì sai token… — ghi nhật ký nhưng tối đa 1 dòng / 10 giây
    /// để kẻ dò token không làm phình nhật ký.
    pub fn log_auth_failure(&self, why: &str) {
        let mut last = self.auth_fail_logged.lock().unwrap_or_else(|e| e.into_inner());
        if last.map(|t| t.elapsed() < Duration::from_secs(10)).unwrap_or(false) {
            return;
        }
        *last = Some(Instant::now());
        drop(last);
        self.log(Entry {
            ts: audit::now_ms(),
            tool: "(auth)".into(),
            kind: "system".into(),
            args: String::new(),
            outcome: "denied".into(),
            detail: why.to_string(),
            client: String::new(),
            duration_ms: 0,
        });
    }
}

/// Phần thực thi tool thật (cần AppHandle) — tách ra để test giao thức/chính sách không cần app.
pub trait Host: Send + Sync {
    /// Hộp thoại xác nhận của người dùng cho thao tác phá huỷ (Host tự dựng nội dung dễ hiểu
    /// từ tool + tham số). `false` = từ chối/không trả lời.
    fn confirm(&self, client: &str, tool: &str, args: &Value) -> bool;
    /// Chạy tool (đã qua kiểm tra quyền). Trả về các khối nội dung MCP.
    fn exec(&self, tool: &str, args: &Value) -> Result<Vec<Value>, String>;
}

pub fn text_block(s: impl Into<String>) -> Value {
    json!({"type": "text", "text": s.into()})
}

pub fn json_block(v: &Value) -> Value {
    text_block(serde_json::to_string_pretty(v).unwrap_or_else(|_| v.to_string()))
}

fn rpc_error(id: Value, code: i64, msg: &str) -> Value {
    json!({"jsonrpc": "2.0", "id": id, "error": {"code": code, "message": msg}})
}

fn rpc_ok(id: Value, result: Value) -> Value {
    json!({"jsonrpc": "2.0", "id": id, "result": result})
}

fn instructions(write_enabled: bool) -> String {
    format!(
        "SnapDoc is a screenshot / screen-recording / video editing app. Use these tools to read the user's Library and, if permitted, edit videos and subtitles. \
Agent WRITE permission is currently {}. Start with app_status. Destructive actions (moving to Trash, overwriting an original) always pop up a confirmation in the app for the user; \
if they decline you get an error — do not retry in a loop. Everything you do is recorded in an activity log the user can read. Video edits create NEW items by default.",
        if write_enabled { "ON" } else { "OFF (read-only)" }
    )
}

fn tool_error(msg: &str) -> Value {
    json!({"content": [text_block(msg)], "isError": true})
}

/// Điểm vào duy nhất cho `tools/call`. Mọi lớp an toàn nằm ở đây.
fn call_tool(state: &McpState, host: &dyn Host, client: &str, params: &Value) -> Result<Value, (i64, String)> {
    let name = params.get("name").and_then(|v| v.as_str()).unwrap_or("").to_string();
    let args = params.get("arguments").cloned().unwrap_or_else(|| json!({}));
    if !args.is_object() {
        return Err((-32602, "arguments phải là object".into()));
    }
    let started = Instant::now();
    let Some(class) = policy::class_of(&name, &args) else {
        return Err((-32602, format!("Tool không tồn tại: {name}")));
    };
    let log = |outcome: &str, detail: &str| {
        state.log(Entry {
            ts: audit::now_ms(),
            tool: name.clone(),
            kind: class.label().to_string(),
            args: audit::summarize_args(&args),
            outcome: outcome.to_string(),
            detail: audit::clip(detail, 300),
            client: client.to_string(),
            duration_ms: started.elapsed().as_millis() as u64,
        });
    };

    // Lớp 1: công tắc quyền ghi — đọc cấu hình MỚI NHẤT tại thời điểm gọi.
    if let Err(msg) = policy::gate(state.cfg().write_enabled, class) {
        log("denied", &msg);
        return Ok(tool_error(&msg));
    }

    // Giới hạn tốc độ (chống vòng lặp mất kiểm soát).
    let limiter = if class == Class::Read { &state.read_limiter } else { &state.write_limiter };
    if !limiter.lock().unwrap_or_else(|e| e.into_inner()).allow(Instant::now()) {
        let msg = "Gọi quá nhanh (giới hạn tốc độ). Hãy chờ khoảng một phút rồi thử lại, và gộp bớt thao tác.";
        log("denied", msg);
        return Ok(tool_error(msg));
    }

    // Lớp 3: thao tác phá huỷ phải được người dùng bấm đồng ý trong app.
    if class == Class::Destructive {
        if !host.confirm(client, &name, &args) {
            let msg = "Người dùng đã TỪ CHỐI (hoặc không trả lời) yêu cầu xác nhận trong app. Không thực hiện. Đừng thử lại liên tục; hãy hỏi người dùng.";
            log("denied", msg);
            return Ok(tool_error(msg));
        }
    }

    match host.exec(&name, &args) {
        Ok(content) => {
            let first = content.iter().find_map(|c| c.get("text").and_then(|t| t.as_str())).unwrap_or("");
            let running = first.contains("\"status\": \"running\"");
            log(if running { "running" } else { "ok" }, first);
            Ok(json!({"content": content, "isError": false}))
        }
        Err(e) => {
            log("error", &e);
            Ok(tool_error(&e))
        }
    }
}

/// Xử lý 1 thông điệp JSON-RPC. `None` = notification (không trả lời).
pub fn handle_message(state: &McpState, host: &dyn Host, client: &str, msg: &Value) -> Option<Value> {
    let method = msg.get("method").and_then(|v| v.as_str());
    let id = msg.get("id").cloned();
    // Phản hồi từ client (có id nhưng không có method) — bỏ qua.
    let Some(method) = method else { return None };
    let Some(id) = id else { return None }; // notification
    let params = msg.get("params").cloned().unwrap_or_else(|| json!({}));

    Some(match method {
        "initialize" => {
            let asked = params.get("protocolVersion").and_then(|v| v.as_str()).unwrap_or("");
            let ver = if SUPPORTED_VERSIONS.contains(&asked) { asked } else { SUPPORTED_VERSIONS[0] };
            rpc_ok(id, json!({
                "protocolVersion": ver,
                "capabilities": {"tools": {"listChanged": false}},
                "serverInfo": {"name": SERVER_NAME, "title": "SnapDoc", "version": state.version},
                "instructions": instructions(state.cfg().write_enabled),
            }))
        }
        "ping" => rpc_ok(id, json!({})),
        "tools/list" => rpc_ok(id, json!({"tools": super::schema::tool_defs()})),
        "tools/call" => match call_tool(state, host, client, &params) {
            Ok(r) => rpc_ok(id, r),
            Err((code, m)) => rpc_error(id, code, &m),
        },
        "resources/list" => rpc_ok(id, json!({"resources": []})),
        "resources/templates/list" => rpc_ok(id, json!({"resourceTemplates": []})),
        "prompts/list" => rpc_ok(id, json!({"prompts": []})),
        other => rpc_error(id, -32601, &format!("Method not found: {other}")),
    })
}

/// Xử lý thân HTTP (1 object hoặc 1 mảng batch). Trả về (HTTP status, body).
pub fn handle_body(state: &McpState, host: &dyn Host, client: &str, body: &str) -> (u16, Option<String>) {
    let parsed: Value = match serde_json::from_str(body) {
        Ok(v) => v,
        Err(_) => return (400, Some(rpc_error(Value::Null, -32700, "Parse error").to_string())),
    };
    match parsed {
        Value::Array(items) => {
            if items.is_empty() {
                return (400, Some(rpc_error(Value::Null, -32600, "Invalid Request").to_string()));
            }
            let out: Vec<Value> = items.iter().filter_map(|m| handle_message(state, host, client, m)).collect();
            if out.is_empty() { (202, None) } else { (200, Some(Value::Array(out).to_string())) }
        }
        Value::Object(_) => match handle_message(state, host, client, &parsed) {
            Some(r) => (200, Some(r.to_string())),
            None => (202, None),
        },
        _ => (400, Some(rpc_error(Value::Null, -32600, "Invalid Request").to_string())),
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::sync::atomic::{AtomicUsize, Ordering};

    struct Mock {
        approve: bool,
        confirms: AtomicUsize,
        execs: AtomicUsize,
    }
    impl Mock {
        fn new(approve: bool) -> Self {
            Self { approve, confirms: AtomicUsize::new(0), execs: AtomicUsize::new(0) }
        }
    }
    impl Host for Mock {
        fn confirm(&self, _c: &str, _t: &str, _a: &Value) -> bool {
            self.confirms.fetch_add(1, Ordering::SeqCst);
            self.approve
        }
        fn exec(&self, tool: &str, _a: &Value) -> Result<Vec<Value>, String> {
            self.execs.fetch_add(1, Ordering::SeqCst);
            if tool == "rename_item" {
                return Err("không tìm thấy item".into());
            }
            Ok(vec![text_block(format!("ran {tool}"))])
        }
    }

    fn state(write: bool) -> (McpState, PathBuf) {
        let d = std::env::temp_dir().join(format!("snapdoc-proto-{}-{}", std::process::id(), uuid::Uuid::new_v4().simple()));
        let cfg = McpConfig { enabled: true, write_enabled: write, port: 1, token: "t".into() };
        (McpState::new(d.clone(), cfg, "9.9.9"), d)
    }

    fn call(s: &McpState, h: &dyn Host, tool: &str, args: Value) -> Value {
        let msg = json!({"jsonrpc":"2.0","id":1,"method":"tools/call","params":{"name":tool,"arguments":args}});
        handle_message(s, h, "tester", &msg).unwrap()
    }

    #[test]
    fn initialize_negotiates_version_and_reports_mode() {
        let (s, d) = state(false);
        let h = Mock::new(true);
        let r = handle_message(&s, &h, "", &json!({"jsonrpc":"2.0","id":7,"method":"initialize","params":{"protocolVersion":"2025-03-26"}})).unwrap();
        assert_eq!(r["id"], 7);
        assert_eq!(r["result"]["protocolVersion"], "2025-03-26");
        assert_eq!(r["result"]["serverInfo"]["name"], "snapdoc");
        assert!(r["result"]["instructions"].as_str().unwrap().contains("OFF (read-only)"));
        let r2 = handle_message(&s, &h, "", &json!({"jsonrpc":"2.0","id":8,"method":"initialize","params":{"protocolVersion":"1999-01-01"}})).unwrap();
        assert_eq!(r2["result"]["protocolVersion"], SUPPORTED_VERSIONS[0]);
        let _ = std::fs::remove_dir_all(&d);
    }

    #[test]
    fn notifications_get_no_reply_and_unknown_methods_error() {
        let (s, d) = state(false);
        let h = Mock::new(true);
        assert!(handle_message(&s, &h, "", &json!({"jsonrpc":"2.0","method":"notifications/initialized"})).is_none());
        let r = handle_message(&s, &h, "", &json!({"jsonrpc":"2.0","id":1,"method":"nope"})).unwrap();
        assert_eq!(r["error"]["code"], -32601);
        let (code, body) = handle_body(&s, &h, "", r#"{"jsonrpc":"2.0","method":"notifications/initialized"}"#);
        assert_eq!((code, body), (202, None));
        let (code, _) = handle_body(&s, &h, "", "{broken");
        assert_eq!(code, 400);
        let _ = std::fs::remove_dir_all(&d);
    }

    #[test]
    fn tools_list_contains_all_tools() {
        let (s, d) = state(false);
        let h = Mock::new(true);
        let r = handle_message(&s, &h, "", &json!({"jsonrpc":"2.0","id":1,"method":"tools/list"})).unwrap();
        let n = r["result"]["tools"].as_array().unwrap().len();
        assert_eq!(n, policy::READ_TOOLS.len() + policy::WRITE_TOOLS.len() + policy::DESTRUCTIVE_TOOLS.len());
        let _ = std::fs::remove_dir_all(&d);
    }

    #[test]
    fn read_only_mode_denies_write_and_never_reaches_exec() {
        let (s, d) = state(false);
        let h = Mock::new(true);
        let ok = call(&s, &h, "list_history", json!({}));
        assert_eq!(ok["result"]["isError"], false);
        assert_eq!(h.execs.load(Ordering::SeqCst), 1);
        for t in ["import_video", "trim_video", "rename_item", "generate_captions", "restore_item", "delete_to_trash"] {
            let r = call(&s, &h, t, json!({"id":"x","path":"c:\\a.mp4","title":"t","keepRanges":[[0,1]]}));
            assert_eq!(r["result"]["isError"], true, "{t}");
            assert!(r["result"]["content"][0]["text"].as_str().unwrap().contains("TẮT"), "{t}");
        }
        assert_eq!(h.execs.load(Ordering::SeqCst), 1, "không tool ghi nào được chạy");
        assert_eq!(h.confirms.load(Ordering::SeqCst), 0, "bị chặn trước khi hỏi xác nhận");
        // Tất cả đều có trong nhật ký, đánh dấu denied.
        let log = s.audit.tail(50);
        assert_eq!(log.iter().filter(|e| e.outcome == "denied").count(), 6);
        assert_eq!(log.iter().filter(|e| e.outcome == "ok").count(), 1);
        let _ = std::fs::remove_dir_all(&d);
    }

    #[test]
    fn toggle_takes_effect_immediately_without_reconnect() {
        let (s, d) = state(false);
        let h = Mock::new(true);
        assert_eq!(call(&s, &h, "open_in_editor", json!({"id":"1"}))["result"]["isError"], true);
        s.cfg.lock().unwrap().write_enabled = true;
        assert_eq!(call(&s, &h, "open_in_editor", json!({"id":"1"}))["result"]["isError"], false);
        s.cfg.lock().unwrap().write_enabled = false;
        assert_eq!(call(&s, &h, "open_in_editor", json!({"id":"1"}))["result"]["isError"], true);
        let _ = std::fs::remove_dir_all(&d);
    }

    #[test]
    fn destructive_needs_user_confirmation_even_when_write_enabled() {
        let (s, d) = state(true);
        let no = Mock::new(false);
        let r = call(&s, &no, "delete_to_trash", json!({"id":"abc"}));
        assert_eq!(r["result"]["isError"], true);
        assert!(r["result"]["content"][0]["text"].as_str().unwrap().contains("TỪ CHỐI"));
        assert_eq!((no.confirms.load(Ordering::SeqCst), no.execs.load(Ordering::SeqCst)), (1, 0), "từ chối thì không thực thi");

        let yes = Mock::new(true);
        let r = call(&s, &yes, "delete_to_trash", json!({"id":"abc"}));
        assert_eq!(r["result"]["isError"], false);
        assert_eq!((yes.confirms.load(Ordering::SeqCst), yes.execs.load(Ordering::SeqCst)), (1, 1));

        // Ghi đè video gốc cũng phải hỏi; còn cắt thành bản mới thì không.
        let r = call(&s, &yes, "trim_video", json!({"id":"abc","keepRanges":[[0,1]],"replaceOriginal":true}));
        assert_eq!(r["result"]["isError"], false);
        assert_eq!(yes.confirms.load(Ordering::SeqCst), 2);
        call(&s, &yes, "trim_video", json!({"id":"abc","keepRanges":[[0,1]]}));
        assert_eq!(yes.confirms.load(Ordering::SeqCst), 2, "bản mới không cần xác nhận");
        let _ = std::fs::remove_dir_all(&d);
    }

    #[test]
    fn unknown_tool_is_rpc_error_and_not_executed() {
        let (s, d) = state(true);
        let h = Mock::new(true);
        for t in ["permanently_delete_item", "empty_trash", "set_settings", "clear_activity_log", "run_command"] {
            let r = call(&s, &h, t, json!({}));
            assert_eq!(r["error"]["code"], -32602, "{t}");
        }
        assert_eq!(h.execs.load(Ordering::SeqCst), 0);
        let _ = std::fs::remove_dir_all(&d);
    }

    #[test]
    fn every_call_is_logged_with_result_and_errors() {
        let (s, d) = state(true);
        let h = Mock::new(true);
        call(&s, &h, "list_history", json!({"limit": 5}));
        call(&s, &h, "rename_item", json!({"id":"zzz","title":"x"}));
        let log = s.audit.tail(10);
        assert_eq!(log.len(), 2);
        assert_eq!(log[0].tool, "rename_item");
        assert_eq!(log[0].outcome, "error");
        assert!(log[0].detail.contains("không tìm thấy"));
        assert_eq!(log[0].kind, "write");
        assert_eq!(log[0].client, "tester");
        assert_eq!(log[1].outcome, "ok");
        assert!(log[1].args.contains("\"limit\":5"));
        let _ = std::fs::remove_dir_all(&d);
    }

    #[test]
    fn write_rate_limit_kicks_in() {
        let (s, d) = state(true);
        let h = Mock::new(true);
        let mut denied = 0;
        for _ in 0..(policy::WRITE_PER_MIN + 5) {
            let r = call(&s, &h, "open_in_editor", json!({"id":"1"}));
            if r["result"]["isError"] == true {
                denied += 1;
            }
        }
        assert_eq!(denied, 5);
        // Đọc không bị ảnh hưởng bởi giới hạn ghi.
        assert_eq!(call(&s, &h, "app_status", json!({}))["result"]["isError"], false);
        let _ = std::fs::remove_dir_all(&d);
    }

    #[test]
    fn auth_failures_are_logged_but_throttled() {
        let (s, d) = state(false);
        for _ in 0..10 {
            s.log_auth_failure("sai token");
        }
        assert_eq!(s.audit.tail(10).len(), 1);
        let _ = std::fs::remove_dir_all(&d);
    }

    #[test]
    fn batch_requests_are_supported() {
        let (s, d) = state(false);
        let h = Mock::new(true);
        let (code, body) = handle_body(&s, &h, "", r#"[{"jsonrpc":"2.0","id":1,"method":"ping"},{"jsonrpc":"2.0","method":"notifications/initialized"}]"#);
        assert_eq!(code, 200);
        let v: Value = serde_json::from_str(&body.unwrap()).unwrap();
        assert_eq!(v.as_array().unwrap().len(), 1);
        let _ = std::fs::remove_dir_all(&d);
    }
}
