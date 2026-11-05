//! Cấu hình MCP (bật/tắt server, quyền GHI, cổng, token) lưu ở `mcp.json` trong
//! thư mục cấu hình của app — TÁCH khỏi `settings.json` để (a) webview không vô
//! tình ghi đè khi lưu Cài đặt chung, (b) token không đi theo `get_settings`.
//!
//! Nguyên tắc FAIL-CLOSED: file hỏng/thiếu/không đọc được → mọi thứ TẮT (server
//! tắt, quyền ghi tắt). Quyền ghi chỉ bật khi file ghi rõ `"writeEnabled": true`.

use serde::{Deserialize, Serialize};
use std::path::{Path, PathBuf};

#[derive(Clone, Debug, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase", default)]
pub struct McpConfig {
    /// Server MCP có lắng nghe không (mặc định TẮT — người dùng chủ động bật).
    pub enabled: bool,
    /// Cho phép tool GHI/SỬA/XOÁ. Mặc định TẮT = agent chỉ đọc được.
    pub write_enabled: bool,
    /// Cổng 127.0.0.1; 0 = chưa chọn (chọn ngẫu nhiên lần bật đầu rồi nhớ lại).
    pub port: u16,
    /// Bearer token (64 hex). Rỗng = chưa sinh.
    pub token: String,
}

impl Default for McpConfig {
    fn default() -> Self {
        Self { enabled: false, write_enabled: false, port: 0, token: String::new() }
    }
}

pub fn config_path(dir: &Path) -> PathBuf {
    dir.join("mcp.json")
}

/// Sinh token ngẫu nhiên 256 bit (2 UUID v4 = 244 bit ngẫu nhiên từ getrandom của OS).
pub fn generate_token() -> String {
    format!("{}{}", uuid::Uuid::new_v4().simple(), uuid::Uuid::new_v4().simple())
}

/// Đọc cấu hình; mọi lỗi → mặc định an toàn (tất cả TẮT).
pub fn load(dir: &Path) -> McpConfig {
    match std::fs::read_to_string(config_path(dir)) {
        Ok(s) => serde_json::from_str(&s).unwrap_or_default(),
        Err(_) => McpConfig::default(),
    }
}

/// Ghi nguyên tử (file tạm cùng thư mục → rename) để crash giữa chừng không
/// để lại file nửa vời (sẽ bị coi là hỏng → tắt hết, không nguy hiểm nhưng khó chịu).
pub fn save(dir: &Path, cfg: &McpConfig) -> Result<(), String> {
    std::fs::create_dir_all(dir).map_err(|e| format!("Không tạo được thư mục cấu hình: {e}"))?;
    let path = config_path(dir);
    let tmp = path.with_extension("json.tmp");
    let body = serde_json::to_string_pretty(cfg).map_err(|e| e.to_string())?;
    std::fs::write(&tmp, body).map_err(|e| format!("Không ghi được cấu hình MCP: {e}"))?;
    std::fs::rename(&tmp, &path).map_err(|e| format!("Không lưu được cấu hình MCP: {e}"))
}

#[cfg(test)]
mod tests {
    use super::*;

    fn tmpdir(name: &str) -> PathBuf {
        let d = std::env::temp_dir().join(format!("snapdoc-mcp-{name}-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&d);
        d
    }

    #[test]
    fn defaults_are_closed() {
        let c = McpConfig::default();
        assert!(!c.enabled, "server mặc định phải TẮT");
        assert!(!c.write_enabled, "quyền ghi mặc định phải TẮT");
    }

    #[test]
    fn missing_or_corrupt_file_fails_closed() {
        let d = tmpdir("corrupt");
        assert_eq!(load(&d), McpConfig::default());
        std::fs::create_dir_all(&d).unwrap();
        std::fs::write(config_path(&d), "{ not json").unwrap();
        let c = load(&d);
        assert!(!c.enabled && !c.write_enabled);
        // Kiểu sai (chuỗi thay vì bool) cũng không được bật ghi.
        std::fs::write(config_path(&d), r#"{"writeEnabled":"true","enabled":1}"#).unwrap();
        let c = load(&d);
        assert!(!c.enabled && !c.write_enabled);
        let _ = std::fs::remove_dir_all(&d);
    }

    #[test]
    fn roundtrip_and_partial_file() {
        let d = tmpdir("roundtrip");
        let c = McpConfig { enabled: true, write_enabled: true, port: 51234, token: generate_token() };
        save(&d, &c).unwrap();
        assert_eq!(load(&d), c);
        // File chỉ có vài khóa → khóa thiếu lấy mặc định (không bật ghi ngầm).
        std::fs::write(config_path(&d), r#"{"enabled":true}"#).unwrap();
        let c2 = load(&d);
        assert!(c2.enabled && !c2.write_enabled);
        let _ = std::fs::remove_dir_all(&d);
    }

    #[test]
    fn tokens_are_long_and_unique() {
        let a = generate_token();
        let b = generate_token();
        assert_eq!(a.len(), 64);
        assert_ne!(a, b);
        assert!(a.chars().all(|c| c.is_ascii_hexdigit()));
    }
}
