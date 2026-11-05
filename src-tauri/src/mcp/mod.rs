//! MCP server cho SnapDoc — để AI agent (Claude Code / Claude Desktop / Antigravity…)
//! đọc Thư viện và (khi người dùng cho phép) chỉnh sửa video, tạo phụ đề… trên app thật.
//!
//! Kiến trúc: server HTTP chạy NGAY TRONG tiến trình app, chỉ lắng nghe 127.0.0.1, xác
//! thực bằng Bearer token (xem `server.rs`). Client chỉ hỗ trợ stdio dùng cầu nối
//! `snapdoc.exe --mcp-stdio` (xem `bridge.rs`). Ba lớp an toàn: công tắc quyền ghi
//! (mặc định TẮT) → nhật ký mọi thao tác → thao tác phá huỷ cần người dùng xác nhận
//! trong app + giới hạn tốc độ (xem `policy.rs`, `protocol.rs`, `audit.rs`).

pub mod audit;
pub mod auth;
pub mod bridge;
pub mod config;
pub mod jobs;
pub mod policy;
pub mod protocol;
pub mod schema;
pub mod server;
pub mod tools;

use protocol::McpState;
use serde::Serialize;
use std::sync::{Arc, Mutex};
use tauri::{AppHandle, Emitter, Manager};

/// Trạng thái chạy của MCP, được `manage` vào Tauri.
pub struct McpRuntime {
    pub state: Arc<McpState>,
    server: Mutex<Option<server::ServerHandle>>,
}

fn runtime(app: &AppHandle) -> Result<tauri::State<'_, McpRuntime>, String> {
    app.try_state::<McpRuntime>().ok_or_else(|| "MCP chưa khởi tạo".to_string())
}

/// Gọi lúc khởi động app (bản đầy đủ, không phải "Open with"). Lỗi KHÔNG chặn app.
pub fn init(app: &AppHandle) {
    let dir = app.path().app_config_dir().unwrap_or_default();
    let cfg = config::load(&dir);
    let state = Arc::new(McpState::new(dir, cfg.clone(), env!("CARGO_PKG_VERSION")));
    let a = app.clone();
    state.set_notifier(Box::new(move |e| {
        let _ = a.emit("mcp-activity", e);
    }));
    app.manage(McpRuntime { state, server: Mutex::new(None) });
    if cfg.enabled {
        if let Err(e) = start_server(app) {
            eprintln!("[SnapDoc][mcp] Không khởi động được server: {e}");
        }
    }
}

fn start_server(app: &AppHandle) -> Result<(), String> {
    let rt = runtime(app)?;
    let mut slot = rt.server.lock().unwrap_or_else(|e| e.into_inner());
    if slot.is_some() {
        return Ok(());
    }
    // Đảm bảo có token trước khi lắng nghe.
    {
        let mut c = rt.state.cfg.lock().unwrap_or_else(|e| e.into_inner());
        if c.token.is_empty() {
            c.token = config::generate_token();
            config::save(&rt.state.dir, &c)?;
        }
    }
    let preferred = rt.state.cfg().port;
    let host = Arc::new(tools::AppHost { app: app.clone(), state: rt.state.clone() });
    let handle = server::start(rt.state.clone(), host, preferred)?;
    if handle.port != preferred {
        let mut c = rt.state.cfg.lock().unwrap_or_else(|e| e.into_inner());
        c.port = handle.port;
        config::save(&rt.state.dir, &c)?;
    }
    *slot = Some(handle);
    Ok(())
}

fn stop_server(app: &AppHandle) {
    if let Ok(rt) = runtime(app) {
        let h = rt.server.lock().unwrap_or_else(|e| e.into_inner()).take();
        if let Some(h) = h {
            h.stop();
        }
    }
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct McpInfo {
    pub enabled: bool,
    pub write_enabled: bool,
    pub running: bool,
    pub port: u16,
    pub token: String,
    pub url: String,
    pub exe_path: String,
    pub config_dir: String,
}

fn info(app: &AppHandle) -> Result<McpInfo, String> {
    let rt = runtime(app)?;
    let cfg = rt.state.cfg();
    let running = rt.server.lock().unwrap_or_else(|e| e.into_inner()).is_some();
    Ok(McpInfo {
        enabled: cfg.enabled,
        write_enabled: cfg.write_enabled,
        running,
        port: cfg.port,
        token: cfg.token.clone(),
        url: if cfg.port != 0 { format!("http://127.0.0.1:{}/mcp", cfg.port) } else { String::new() },
        exe_path: std::env::current_exe().map(|p| p.to_string_lossy().to_string()).unwrap_or_default(),
        config_dir: rt.state.dir.to_string_lossy().to_string(),
    })
}

fn notify_changed(app: &AppHandle) {
    let _ = app.emit("mcp-changed", ());
}

#[tauri::command]
pub async fn mcp_get_state(app: AppHandle) -> Result<McpInfo, String> {
    info(&app)
}

#[tauri::command]
pub async fn mcp_set_enabled(app: AppHandle, enabled: bool) -> Result<McpInfo, String> {
    {
        let rt = runtime(&app)?;
        {
            let mut c = rt.state.cfg.lock().unwrap_or_else(|e| e.into_inner());
            c.enabled = enabled;
            config::save(&rt.state.dir, &c)?;
        }
        rt.state.log_system(if enabled { "mcp_enabled" } else { "mcp_disabled" }, "Người dùng đổi công tắc MCP server trong Cài đặt");
    }
    if enabled {
        start_server(&app)?;
    } else {
        stop_server(&app);
    }
    notify_changed(&app);
    info(&app)
}

/// Bật/tắt quyền GHI. Giao diện phải hỏi xác nhận rõ ràng trước khi gọi với `enabled=true`.
#[tauri::command]
pub async fn mcp_set_write(app: AppHandle, enabled: bool) -> Result<McpInfo, String> {
    {
        let rt = runtime(&app)?;
        {
            let mut c = rt.state.cfg.lock().unwrap_or_else(|e| e.into_inner());
            c.write_enabled = enabled;
            config::save(&rt.state.dir, &c)?;
        }
        rt.state.log_system(
            if enabled { "write_permission_on" } else { "write_permission_off" },
            if enabled { "Người dùng BẬT quyền ghi/sửa/xoá cho AI agent" } else { "Người dùng TẮT quyền ghi (chỉ đọc)" },
        );
    }
    notify_changed(&app);
    info(&app)
}

#[tauri::command]
pub async fn mcp_regenerate_token(app: AppHandle) -> Result<McpInfo, String> {
    {
        let rt = runtime(&app)?;
        {
            let mut c = rt.state.cfg.lock().unwrap_or_else(|e| e.into_inner());
            c.token = config::generate_token();
            config::save(&rt.state.dir, &c)?;
        }
        rt.state.log_system("token_regenerated", "Đã tạo token mới — mọi client cũ bị ngắt cho tới khi cập nhật cấu hình");
    }
    notify_changed(&app);
    info(&app)
}

#[tauri::command]
pub async fn mcp_audit_list(app: AppHandle, limit: Option<usize>) -> Result<Vec<audit::Entry>, String> {
    Ok(runtime(&app)?.state.audit.tail(limit.unwrap_or(200).clamp(1, 1000)))
}

/// Chỉ người dùng (giao diện) xoá được nhật ký; hành động xoá được ghi lại thành dòng đầu tiên của nhật ký mới.
#[tauri::command]
pub async fn mcp_audit_clear(app: AppHandle) -> Result<(), String> {
    let rt = runtime(&app)?;
    rt.state.audit.clear();
    rt.state.log_system("log_cleared", "Người dùng đã xoá nhật ký cũ");
    Ok(())
}
