//! Server HTTP cục bộ cho MCP ("Streamable HTTP", chế độ chỉ trả JSON — không SSE).
//!
//! - Chỉ bind `127.0.0.1` (không bao giờ `0.0.0.0`).
//! - Mỗi yêu cầu phải qua: kiểm tra `Host` (chống DNS-rebinding) → không có `Origin`
//!   (chống trang web gọi chéo) → Bearer token → POST /mcp.
//! - Thân tối đa 2 MB; tối đa 16 yêu cầu xử lý đồng thời.

use super::auth;
use super::protocol::{self, Host, McpState};
use std::io::Read;
use std::sync::atomic::{AtomicBool, AtomicUsize, Ordering};
use std::sync::Arc;
use std::thread::JoinHandle;
use std::time::Duration;
use tiny_http::{Header, Method, Request, Response, Server, StatusCode};

const MAX_BODY: u64 = 2 * 1024 * 1024;
const MAX_INFLIGHT: usize = 16;

pub struct ServerHandle {
    stop: Arc<AtomicBool>,
    join: Option<JoinHandle<()>>,
    pub port: u16,
}

impl ServerHandle {
    /// Dừng và chờ giải phóng cổng (≤ ~0,6 giây).
    pub fn stop(mut self) {
        self.stop.store(true, Ordering::SeqCst);
        if let Some(j) = self.join.take() {
            let _ = j.join();
        }
    }
}

fn header(name: &str, value: &str) -> Header {
    Header::from_bytes(name.as_bytes(), value.as_bytes()).expect("header hợp lệ")
}

fn get_header(req: &Request, name: &str) -> Option<String> {
    req.headers()
        .iter()
        .find(|h| h.field.as_str().as_str().eq_ignore_ascii_case(name))
        .map(|h| h.value.as_str().to_string())
}

fn reply(req: Request, code: u16, body: Option<String>, extra: &[(&str, &str)]) {
    let mut resp = Response::from_string(body.unwrap_or_default()).with_status_code(StatusCode(code));
    resp = resp.with_header(header("Content-Type", "application/json"));
    resp = resp.with_header(header("Cache-Control", "no-store"));
    for (k, v) in extra {
        resp = resp.with_header(header(k, v));
    }
    let _ = req.respond(resp);
}

/// Tên client rút từ User-Agent (vd "claude-code/2.1" → "claude-code").
pub fn client_name(ua: Option<&str>) -> String {
    let ua = ua.unwrap_or("").trim();
    let first = ua.split(|c: char| c == '/' || c.is_whitespace()).next().unwrap_or("");
    first.chars().take(40).collect()
}

fn handle(mut req: Request, state: &McpState, host: &dyn Host, port: u16) {
    let cfg = state.cfg();
    if !cfg.enabled {
        return reply(req, 503, Some(r#"{"error":"MCP disabled"}"#.into()), &[]);
    }
    if !auth::check_host(get_header(&req, "host").as_deref(), port) {
        state.log_auth_failure("Bị từ chối: header Host không hợp lệ (có thể là DNS rebinding)");
        return reply(req, 403, Some(r#"{"error":"forbidden host"}"#.into()), &[]);
    }
    if !auth::check_origin(get_header(&req, "origin").as_deref()) {
        state.log_auth_failure("Bị từ chối: yêu cầu có Origin (từ trang web trong trình duyệt)");
        return reply(req, 403, Some(r#"{"error":"forbidden origin"}"#.into()), &[]);
    }
    if !auth::check_bearer(get_header(&req, "authorization").as_deref(), &cfg.token) {
        state.log_auth_failure("Bị từ chối: thiếu hoặc sai token");
        return reply(req, 401, Some(r#"{"error":"unauthorized"}"#.into()), &[("WWW-Authenticate", "Bearer")]);
    }
    let path = req.url().split('?').next().unwrap_or("").trim_end_matches('/').to_string();
    if path != "/mcp" && !path.is_empty() {
        return reply(req, 404, Some(r#"{"error":"not found"}"#.into()), &[]);
    }
    if *req.method() != Method::Post {
        return reply(req, 405, Some(r#"{"error":"POST only"}"#.into()), &[("Allow", "POST")]);
    }
    if req.body_length().map(|n| n as u64 > MAX_BODY).unwrap_or(false) {
        return reply(req, 413, Some(r#"{"error":"body too large"}"#.into()), &[]);
    }
    let mut body = String::new();
    if req.as_reader().take(MAX_BODY + 1).read_to_string(&mut body).is_err() || body.len() as u64 > MAX_BODY {
        return reply(req, 400, Some(r#"{"error":"bad body"}"#.into()), &[]);
    }
    let client = client_name(get_header(&req, "user-agent").as_deref());
    let (code, out) = protocol::handle_body(state, host, &client, &body);
    reply(req, code, out, &[])
}

/// Khởi động server. `preferred_port` = 0 hoặc đang bận → hệ điều hành cấp cổng khác (caller lưu lại `port` trả về).
pub fn start(state: Arc<McpState>, host: Arc<dyn Host>, preferred_port: u16) -> Result<ServerHandle, String> {
    let server = if preferred_port != 0 {
        Server::http(("127.0.0.1", preferred_port)).or_else(|_| Server::http(("127.0.0.1", 0u16)))
    } else {
        Server::http(("127.0.0.1", 0u16))
    }
    .map_err(|e| format!("Không mở được cổng MCP: {e}"))?;
    let port = server
        .server_addr()
        .to_ip()
        .map(|a| a.port())
        .ok_or("Không xác định được cổng MCP")?;

    let stop = Arc::new(AtomicBool::new(false));
    let stop2 = stop.clone();
    let inflight = Arc::new(AtomicUsize::new(0));
    let join = std::thread::Builder::new()
        .name("mcp-http".into())
        .spawn(move || {
            while !stop2.load(Ordering::SeqCst) {
                match server.recv_timeout(Duration::from_millis(400)) {
                    Ok(Some(req)) => {
                        if inflight.load(Ordering::SeqCst) >= MAX_INFLIGHT {
                            reply(req, 503, Some(r#"{"error":"busy"}"#.into()), &[]);
                            continue;
                        }
                        inflight.fetch_add(1, Ordering::SeqCst);
                        let (st, ho, inf) = (state.clone(), host.clone(), inflight.clone());
                        let spawned = std::thread::Builder::new().name("mcp-req".into()).spawn(move || {
                            handle(req, &st, ho.as_ref(), port);
                            inf.fetch_sub(1, Ordering::SeqCst);
                        });
                        if spawned.is_err() {
                            inflight.fetch_sub(1, Ordering::SeqCst);
                        }
                    }
                    Ok(None) => {}
                    Err(_) => break,
                }
            }
        })
        .map_err(|e| format!("Không khởi chạy được server MCP: {e}"))?;
    Ok(ServerHandle { stop, join: Some(join), port })
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::mcp::config::McpConfig;
    use serde_json::{json, Value};
    use std::io::{Read, Write};
    use std::net::TcpStream;

    struct NoopHost;
    impl Host for NoopHost {
        fn confirm(&self, _: &str, _: &str, _: &Value) -> bool {
            false
        }
        fn exec(&self, tool: &str, _: &Value) -> Result<Vec<Value>, String> {
            Ok(vec![protocol::text_block(format!("ran {tool}"))])
        }
    }

    /// HTTP/1.1 thô (không phụ thuộc thư viện client) để kiểm soát từng header.
    fn http(port: u16, method: &str, path: &str, headers: &[(&str, &str)], body: &str) -> (u16, String) {
        let mut s = TcpStream::connect(("127.0.0.1", port)).unwrap();
        s.set_read_timeout(Some(Duration::from_secs(10))).unwrap();
        let mut req = format!("{method} {path} HTTP/1.1\r\nConnection: close\r\nContent-Length: {}\r\n", body.len());
        for (k, v) in headers {
            req.push_str(&format!("{k}: {v}\r\n"));
        }
        req.push_str("\r\n");
        req.push_str(body);
        s.write_all(req.as_bytes()).unwrap();
        let mut out = String::new();
        let _ = s.read_to_string(&mut out);
        let code = out.split_whitespace().nth(1).and_then(|c| c.parse().ok()).unwrap_or(0);
        let body = out.split("\r\n\r\n").nth(1).unwrap_or("").to_string();
        (code, body)
    }

    fn boot(write: bool) -> (Arc<McpState>, ServerHandle, std::path::PathBuf) {
        let d = std::env::temp_dir().join(format!("snapdoc-srv-{}-{}", std::process::id(), uuid::Uuid::new_v4().simple()));
        let cfg = McpConfig { enabled: true, write_enabled: write, port: 0, token: "secret-token".into() };
        let st = Arc::new(McpState::new(d.clone(), cfg, "1.0.0"));
        let h = start(st.clone(), Arc::new(NoopHost), 0).unwrap();
        (st, h, d)
    }

    #[test]
    fn rejects_missing_wrong_token_and_bad_host_and_origin() {
        let (st, h, d) = boot(false);
        let p = h.port;
        let host = format!("127.0.0.1:{p}");
        let body = r#"{"jsonrpc":"2.0","id":1,"method":"ping"}"#;
        let auth = "Bearer secret-token";

        assert_eq!(http(p, "POST", "/mcp", &[("Host", &host)], body).0, 401, "thiếu token");
        assert_eq!(http(p, "POST", "/mcp", &[("Host", &host), ("Authorization", "Bearer nope")], body).0, 401, "sai token");
        assert_eq!(http(p, "POST", "/mcp", &[("Host", "evil.com"), ("Authorization", auth)], body).0, 403, "Host lạ");
        assert_eq!(
            http(p, "POST", "/mcp", &[("Host", &host), ("Authorization", auth), ("Origin", "https://evil.com")], body).0,
            403,
            "có Origin"
        );
        assert_eq!(http(p, "GET", "/mcp", &[("Host", &host), ("Authorization", auth)], "").0, 405);
        assert_eq!(http(p, "POST", "/other", &[("Host", &host), ("Authorization", auth)], body).0, 404);
        let (code, resp) = http(p, "POST", "/mcp", &[("Host", &host), ("Authorization", auth)], body);
        assert_eq!(code, 200);
        assert!(resp.contains("\"result\""), "{resp}");
        assert!(!st.audit.tail(10).is_empty(), "lần bị từ chối được ghi nhật ký");
        h.stop();
        let _ = std::fs::remove_dir_all(&d);
    }

    #[test]
    fn full_flow_read_ok_write_denied_then_allowed_after_toggle() {
        let (st, h, d) = boot(false);
        let p = h.port;
        let host = format!("127.0.0.1:{p}");
        let hdr = [("Host", host.as_str()), ("Authorization", "Bearer secret-token"), ("User-Agent", "claude-code/9.9")];
        let call = |tool: &str| {
            let b = json!({"jsonrpc":"2.0","id":2,"method":"tools/call","params":{"name":tool,"arguments":{"id":"x"}}}).to_string();
            let (code, resp) = http(p, "POST", "/mcp", &hdr, &b);
            assert_eq!(code, 200);
            serde_json::from_str::<Value>(&resp).unwrap()
        };
        assert_eq!(call("get_item")["result"]["isError"], false);
        assert_eq!(call("rename_item")["result"]["isError"], true);
        st.cfg.lock().unwrap().write_enabled = true;
        assert_eq!(call("rename_item")["result"]["isError"], false);
        let log = st.audit.tail(10);
        assert_eq!(log[0].client, "claude-code");
        h.stop();
        let _ = std::fs::remove_dir_all(&d);
    }

    #[test]
    fn disabled_config_returns_503_and_stop_frees_the_port() {
        let (st, h, d) = boot(false);
        let p = h.port;
        st.cfg.lock().unwrap().enabled = false;
        let host = format!("127.0.0.1:{p}");
        let (code, _) = http(p, "POST", "/mcp", &[("Host", &host), ("Authorization", "Bearer secret-token")], "{}");
        assert_eq!(code, 503);
        h.stop();
        assert!(TcpStream::connect_timeout(&format!("127.0.0.1:{p}").parse().unwrap(), Duration::from_millis(300)).is_err(), "cổng phải đóng sau stop()");
        let _ = std::fs::remove_dir_all(&d);
    }

    #[test]
    fn client_name_parsing() {
        assert_eq!(client_name(Some("claude-code/2.1.0 (cli)")), "claude-code");
        assert_eq!(client_name(Some("node")), "node");
        assert_eq!(client_name(None), "");
    }
}
