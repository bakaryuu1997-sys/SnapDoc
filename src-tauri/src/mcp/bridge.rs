//! Cầu nối stdio ↔ HTTP: `snapdoc.exe --mcp-stdio`.
//!
//! Claude Desktop / nhiều IDE chỉ chạy được MCP server qua stdio (khai `command` + `args`).
//! Tiến trình này KHÔNG mở cửa sổ/không khởi động Tauri: chỉ đọc `mcp.json` (cổng + token),
//! chuyển từng dòng JSON-RPC từ stdin sang server HTTP đang chạy trong app SnapDoc rồi in
//! phản hồi ra stdout. Mọi kiểm soát an toàn (token, quyền ghi, nhật ký) vẫn nằm ở app.

use super::config::{self, McpConfig};
use serde_json::{json, Value};
use std::io::{BufRead, Write};
use std::path::PathBuf;

/// Thư mục cấu hình mặc định của app (khớp `identifier` trong tauri.conf.json).
pub fn default_config_dir() -> PathBuf {
    #[cfg(target_os = "windows")]
    {
        std::env::var_os("APPDATA").map(PathBuf::from).unwrap_or_default().join("com.snapdoc.app")
    }
    #[cfg(target_os = "macos")]
    {
        std::env::var_os("HOME").map(PathBuf::from).unwrap_or_default().join("Library/Application Support/com.snapdoc.app")
    }
    #[cfg(not(any(target_os = "windows", target_os = "macos")))]
    {
        std::env::var_os("HOME").map(PathBuf::from).unwrap_or_default().join(".config/com.snapdoc.app")
    }
}

/// `--config-dir <path>` > biến môi trường `SNAPDOC_CONFIG_DIR` > mặc định.
pub fn resolve_config_dir(args: &[String], env: Option<String>) -> PathBuf {
    if let Some(i) = args.iter().position(|a| a == "--config-dir") {
        if let Some(p) = args.get(i + 1) {
            return PathBuf::from(p);
        }
    }
    match env {
        Some(p) if !p.is_empty() => PathBuf::from(p),
        _ => default_config_dir(),
    }
}

fn error_line(id: &Value, msg: &str) -> String {
    json!({"jsonrpc": "2.0", "id": id, "error": {"code": -32000, "message": msg}}).to_string()
}

fn first_id(v: &Value) -> Option<Value> {
    match v {
        Value::Object(m) => m.get("id").cloned(),
        Value::Array(a) => a.iter().find_map(first_id),
        _ => None,
    }
}

/// Chuyển 1 dòng. `post(url, token, body) -> Ok((status, body)) | Err(lý do)`.
/// Trả về dòng cần in ra stdout (hoặc None nếu không có phản hồi).
pub fn forward_line(
    line: &str,
    cfg: &McpConfig,
    post: &dyn Fn(&str, &str, &str) -> Result<(u16, String), String>,
) -> Option<String> {
    let parsed: Value = match serde_json::from_str(line) {
        Ok(v) => v,
        Err(_) => return Some(json!({"jsonrpc":"2.0","id":null,"error":{"code":-32700,"message":"Parse error"}}).to_string()),
    };
    let id = first_id(&parsed); // None = notification
    if !cfg.enabled || cfg.token.is_empty() || cfg.port == 0 {
        return id.map(|i| error_line(&i, "SnapDoc MCP đang TẮT. Mở SnapDoc → Cài đặt → AI Agent (MCP) và bật \"Bật MCP server\", rồi kết nối lại."));
    }
    let url = format!("http://127.0.0.1:{}/mcp", cfg.port);
    match post(&url, &cfg.token, line) {
        Ok((200, body)) if !body.trim().is_empty() => Some(body.replace(['\r', '\n'], "")),
        Ok((202, _)) | Ok((200, _)) => None,
        Ok((401, _)) => id.map(|i| error_line(&i, "SnapDoc từ chối token (có thể vừa tạo token mới). Sao chép lại cấu hình trong Cài đặt → AI Agent.")),
        Ok((code, body)) => id.map(|i| error_line(&i, &format!("SnapDoc MCP trả về HTTP {code}: {}", body.chars().take(200).collect::<String>()))),
        Err(e) => id.map(|i| error_line(&i, &format!("Không kết nối được SnapDoc (app chưa chạy hoặc MCP chưa bật?): {e}"))),
    }
}

fn http_post(url: &str, token: &str, body: &str) -> Result<(u16, String), String> {
    let agent = ureq::AgentBuilder::new()
        .timeout(std::time::Duration::from_secs(180))
        .timeout_connect(std::time::Duration::from_secs(5))
        .build();
    let r = agent
        .post(url)
        .set("Authorization", &format!("Bearer {token}"))
        .set("Content-Type", "application/json")
        .set("Accept", "application/json")
        .set("User-Agent", "snapdoc-mcp-bridge")
        .send_string(body);
    match r {
        Ok(resp) => {
            let code = resp.status();
            Ok((code, resp.into_string().unwrap_or_default()))
        }
        Err(ureq::Error::Status(code, resp)) => Ok((code, resp.into_string().unwrap_or_default())),
        Err(e) => Err(e.to_string()),
    }
}

/// Vòng lặp stdio. Trả về mã thoát.
pub fn run(args: &[String]) -> i32 {
    let dir = resolve_config_dir(args, std::env::var("SNAPDOC_CONFIG_DIR").ok());
    let stdin = std::io::stdin();
    let stdout = std::io::stdout();
    for line in stdin.lock().lines() {
        let Ok(line) = line else { break };
        let line = line.trim();
        if line.is_empty() {
            continue;
        }
        // Đọc lại cấu hình MỖI dòng: người dùng bật MCP/đổi token sau khi client đã chạy vẫn dùng được.
        let cfg = config::load(&dir);
        if let Some(out) = forward_line(line, &cfg, &http_post) {
            let mut o = stdout.lock();
            let _ = writeln!(o, "{out}");
            let _ = o.flush();
        }
    }
    0
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::cell::RefCell;

    fn cfg(enabled: bool) -> McpConfig {
        McpConfig { enabled, write_enabled: false, port: 4242, token: "tok".into() }
    }

    #[test]
    fn forwards_request_with_token_and_url() {
        let seen = RefCell::new(Vec::new());
        let post = |u: &str, t: &str, b: &str| {
            seen.borrow_mut().push((u.to_string(), t.to_string(), b.to_string()));
            Ok((200u16, "{\"jsonrpc\":\"2.0\",\"id\":1,\"result\":{}}\n".to_string()))
        };
        let out = forward_line(r#"{"jsonrpc":"2.0","id":1,"method":"ping"}"#, &cfg(true), &post).unwrap();
        assert!(out.contains("\"result\"") && !out.contains('\n'));
        let s = seen.borrow();
        assert_eq!(s[0].0, "http://127.0.0.1:4242/mcp");
        assert_eq!(s[0].1, "tok");
    }

    #[test]
    fn notification_gets_no_output() {
        let post = |_: &str, _: &str, _: &str| Ok((202u16, String::new()));
        assert!(forward_line(r#"{"jsonrpc":"2.0","method":"notifications/initialized"}"#, &cfg(true), &post).is_none());
    }

    #[test]
    fn disabled_config_returns_clear_error_without_calling_http() {
        let post = |_: &str, _: &str, _: &str| -> Result<(u16, String), String> { panic!("không được gọi HTTP khi MCP tắt") };
        let out = forward_line(r#"{"jsonrpc":"2.0","id":5,"method":"initialize"}"#, &cfg(false), &post).unwrap();
        let v: Value = serde_json::from_str(&out).unwrap();
        assert_eq!(v["id"], 5);
        assert!(v["error"]["message"].as_str().unwrap().contains("TẮT"));
        // Notification khi tắt → im lặng.
        assert!(forward_line(r#"{"jsonrpc":"2.0","method":"notifications/initialized"}"#, &cfg(false), &post).is_none());
    }

    #[test]
    fn connection_failure_and_401_become_rpc_errors() {
        let down = |_: &str, _: &str, _: &str| Err("connection refused".to_string());
        let out = forward_line(r#"{"jsonrpc":"2.0","id":"a","method":"ping"}"#, &cfg(true), &down).unwrap();
        assert!(out.contains("Không kết nối được SnapDoc") && out.contains("\"a\""));
        let unauth = |_: &str, _: &str, _: &str| Ok((401u16, "{}".to_string()));
        let out = forward_line(r#"{"jsonrpc":"2.0","id":2,"method":"ping"}"#, &cfg(true), &unauth).unwrap();
        assert!(out.contains("từ chối token"));
    }

    #[test]
    fn config_dir_resolution_order() {
        let args = vec!["--mcp-stdio".to_string(), "--config-dir".to_string(), "D:\\x".to_string()];
        assert_eq!(resolve_config_dir(&args, Some("E:\\y".into())), PathBuf::from("D:\\x"));
        assert_eq!(resolve_config_dir(&["--mcp-stdio".to_string()], Some("E:\\y".into())), PathBuf::from("E:\\y"));
        assert!(resolve_config_dir(&[], None).ends_with("com.snapdoc.app"));
    }

    #[test]
    fn parse_error_is_reported() {
        let post = |_: &str, _: &str, _: &str| Ok((200u16, String::new()));
        let out = forward_line("not json", &cfg(true), &post).unwrap();
        assert!(out.contains("-32700"));
    }
}
