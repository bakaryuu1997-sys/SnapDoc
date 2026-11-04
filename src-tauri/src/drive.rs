//! Cloud Share (Google Drive) — kết nối OAuth2 theo chuẩn "installed app"
//! loopback redirect (RFC 8252, Google khuyến nghị cho ứng dụng Desktop),
//! rồi upload file + cấp quyền "ai có link đều xem được" qua Drive API v3.
//!
//! Thiết kế: hoàn toàn TÁCH RIÊNG khỏi mọi luồng chụp/quay/lưu cục bộ hiện có
//! — chỉ là 1 action bổ sung user chủ động bấm ("Chia sẻ qua Drive") trên 1
//! file ĐÃ lưu cục bộ, không thay đổi hành vi mặc định (vẫn lưu local trước).
//! Token lưu tại `drive_tokens.json` trong thư mục cấu hình của app — KHÔNG
//! mã hoá (giới hạn đã biết, xem ghi chú trong README/báo cáo đi kèm).

use serde::{Deserialize, Serialize};
use serde_json::json;
use std::path::PathBuf;
use std::time::Duration;
use tauri::{AppHandle, Manager};

const AUTH_ENDPOINT: &str = "https://accounts.google.com/o/oauth2/v2/auth";
const TOKEN_ENDPOINT: &str = "https://oauth2.googleapis.com/token";
const UPLOAD_ENDPOINT: &str = "https://www.googleapis.com/upload/drive/v3/files?uploadType=multipart";
const DRIVE_FILES_ENDPOINT: &str = "https://www.googleapis.com/drive/v3/files";
// `drive.file`: app chỉ thấy/sửa được những file CHÍNH NÓ tạo ra qua API này —
// không xin quyền đọc toàn bộ Drive của người dùng (nguyên tắc least-privilege).
const SCOPE: &str = "https://www.googleapis.com/auth/drive.file";

#[derive(Serialize, Deserialize, Clone, Default)]
struct DriveTokens {
    client_id: String,
    client_secret: String,
    refresh_token: String,
    access_token: String,
    /// Unix millis khi `access_token` hết hạn.
    expires_at_ms: u64,
}

fn tokens_path(app: &AppHandle) -> PathBuf {
    app.path()
        .app_config_dir()
        .unwrap_or_default()
        .join("drive_tokens.json")
}

fn load_tokens(app: &AppHandle) -> Option<DriveTokens> {
    let content = std::fs::read_to_string(tokens_path(app)).ok()?;
    serde_json::from_str(&content).ok()
}

fn save_tokens(app: &AppHandle, t: &DriveTokens) -> Result<(), String> {
    let path = tokens_path(app);
    if let Some(dir) = path.parent() {
        let _ = std::fs::create_dir_all(dir);
    }
    let content = serde_json::to_string_pretty(t).map_err(|e| e.to_string())?;
    std::fs::write(&path, content).map_err(|e| e.to_string())
}

fn now_ms() -> u64 {
    std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .unwrap_or_default()
        .as_millis() as u64
}

/// PKCE code_verifier — nối 3 UUID v4 (đủ entropy, ký tự hex thuần nên không
/// cần url-encode) để tránh thêm crate `sha2`/`rand` chỉ cho việc này. Dùng
/// `code_challenge_method=plain` (code_challenge = chính verifier) — Google
/// vẫn chấp nhận phương thức này cho installed app.
fn gen_code_verifier() -> String {
    format!(
        "{}{}{}",
        uuid::Uuid::new_v4().simple(),
        uuid::Uuid::new_v4().simple(),
        uuid::Uuid::new_v4().simple()
    )
}

fn urlencode(s: &str) -> String {
    let mut out = String::with_capacity(s.len());
    for b in s.bytes() {
        match b {
            b'A'..=b'Z' | b'a'..=b'z' | b'0'..=b'9' | b'-' | b'_' | b'.' | b'~' => out.push(b as char),
            _ => out.push_str(&format!("%{:02X}", b)),
        }
    }
    out
}

fn percent_decode(s: &str) -> String {
    let bytes = s.as_bytes();
    let mut out = Vec::with_capacity(bytes.len());
    let mut i = 0;
    while i < bytes.len() {
        if bytes[i] == b'%' && i + 2 < bytes.len() {
            if let Ok(v) = u8::from_str_radix(&s[i + 1..i + 3], 16) {
                out.push(v);
                i += 3;
                continue;
            }
        }
        if bytes[i] == b'+' {
            out.push(b' ');
        } else {
            out.push(bytes[i]);
        }
        i += 1;
    }
    String::from_utf8_lossy(&out).into_owned()
}

fn parse_query_param(query: &str, key: &str) -> Option<String> {
    for pair in query.split('&') {
        let mut it = pair.splitn(2, '=');
        let k = it.next()?;
        if k == key {
            return Some(percent_decode(it.next().unwrap_or("")));
        }
    }
    None
}

/// Mở trình duyệt hệ thống để user đăng nhập Google + đồng ý quyền Drive, chờ
/// redirect loopback cục bộ rồi đổi `code` lấy `refresh_token`. CHẶN
/// (blocking) tối đa 3 phút — gọi từ `spawn_blocking`, không giữ thread pool
/// chính của Tauri.
fn connect_blocking(app: &AppHandle, client_id: String, client_secret: String) -> Result<(), String> {
    let server = tiny_http::Server::http("127.0.0.1:0")
        .map_err(|e| format!("Không mở được cổng cục bộ để nhận đăng nhập: {e}"))?;
    let port = match server.server_addr() {
        tiny_http::ListenAddr::IP(addr) => addr.port(),
        #[allow(unreachable_patterns)]
        _ => return Err("Không lấy được cổng cục bộ để nhận đăng nhập".into()),
    };
    let redirect_uri = format!("http://127.0.0.1:{port}/callback");

    let verifier = gen_code_verifier();
    let auth_url = format!(
        "{AUTH_ENDPOINT}?client_id={}&redirect_uri={}&response_type=code&scope={}&code_challenge={}&code_challenge_method=plain&access_type=offline&prompt=consent",
        urlencode(&client_id),
        urlencode(&redirect_uri),
        urlencode(SCOPE),
        urlencode(&verifier),
    );

    {
        use tauri_plugin_opener::OpenerExt;
        app.opener()
            .open_url(auth_url, None::<&str>)
            .map_err(|e| format!("Không mở được trình duyệt hệ thống: {e}"))?;
    }

    let request = server
        .recv_timeout(Duration::from_secs(180))
        .map_err(|e| format!("Lỗi chờ đăng nhập Google: {e}"))?
        .ok_or("Hết thời gian chờ đăng nhập Google (3 phút) — hãy thử Kết nối lại.")?;

    let full_url = request.url().to_string();
    let query = full_url.splitn(2, '?').nth(1).unwrap_or("").to_string();
    let code = parse_query_param(&query, "code");
    let auth_error = parse_query_param(&query, "error");

    let response_html = "<html><body style=\"font-family:sans-serif;text-align:center;padding-top:80px;color:#333\"><h2>Đã xong — bạn có thể đóng tab này và quay lại SnapDoc.</h2></body></html>";
    let header = tiny_http::Header::from_bytes(&b"Content-Type"[..], &b"text/html; charset=utf-8"[..])
        .map_err(|_| "Lỗi nội bộ (header)".to_string())?;
    let response = tiny_http::Response::from_string(response_html).with_header(header);
    let _ = request.respond(response);

    if let Some(e) = auth_error {
        return Err(format!("Google từ chối cấp quyền: {e}"));
    }
    let code = code.ok_or("Không nhận được mã xác thực từ Google.")?;

    let token_resp: serde_json::Value = ureq::post(TOKEN_ENDPOINT)
        .send_form(&[
            ("client_id", client_id.as_str()),
            ("client_secret", client_secret.as_str()),
            ("code", code.as_str()),
            ("code_verifier", verifier.as_str()),
            ("grant_type", "authorization_code"),
            ("redirect_uri", redirect_uri.as_str()),
        ])
        .map_err(|e| format!("Đổi mã xác thực thất bại: {e}"))?
        .into_json()
        .map_err(|e| format!("Phản hồi không hợp lệ từ Google: {e}"))?;

    let access_token = token_resp
        .get("access_token")
        .and_then(|x| x.as_str())
        .ok_or("Thiếu access_token trong phản hồi của Google")?
        .to_string();
    let refresh_token = token_resp
        .get("refresh_token")
        .and_then(|x| x.as_str())
        .unwrap_or_default()
        .to_string();
    let expires_in = token_resp.get("expires_in").and_then(|x| x.as_u64()).unwrap_or(3600);

    if refresh_token.is_empty() {
        return Err(
            "Google không trả refresh_token (thường do đã từng cấp quyền trước đó). \
             Vào https://myaccount.google.com/permissions, gỡ quyền của SnapDoc rồi Kết nối lại."
                .into(),
        );
    }

    save_tokens(
        app,
        &DriveTokens {
            client_id,
            client_secret,
            refresh_token,
            access_token,
            expires_at_ms: now_ms() + expires_in.saturating_mul(1000),
        },
    )
}

fn refresh_access_token(app: &AppHandle, t: &mut DriveTokens) -> Result<(), String> {
    let resp: serde_json::Value = ureq::post(TOKEN_ENDPOINT)
        .send_form(&[
            ("client_id", t.client_id.as_str()),
            ("client_secret", t.client_secret.as_str()),
            ("refresh_token", t.refresh_token.as_str()),
            ("grant_type", "refresh_token"),
        ])
        .map_err(|e| format!("Làm mới phiên đăng nhập Drive thất bại: {e}"))?
        .into_json()
        .map_err(|e| format!("Phản hồi không hợp lệ từ Google: {e}"))?;
    t.access_token = resp
        .get("access_token")
        .and_then(|x| x.as_str())
        .ok_or("Thiếu access_token khi làm mới phiên")?
        .to_string();
    let expires_in = resp.get("expires_in").and_then(|x| x.as_u64()).unwrap_or(3600);
    t.expires_at_ms = now_ms() + expires_in.saturating_mul(1000);
    save_tokens(app, t)
}

fn valid_access_token(app: &AppHandle) -> Result<String, String> {
    let mut t = load_tokens(app).ok_or("Chưa kết nối Google Drive — vào Cài đặt để kết nối trước.")?;
    if now_ms() + 30_000 >= t.expires_at_ms {
        refresh_access_token(app, &mut t)?;
    }
    Ok(t.access_token)
}

#[derive(Serialize)]
pub struct DriveUploadResult {
    pub link: String,
}

fn guess_mime(file_name: &str) -> &'static str {
    let lower = file_name.to_lowercase();
    if lower.ends_with(".mp4") {
        "video/mp4"
    } else if lower.ends_with(".png") {
        "image/png"
    } else if lower.ends_with(".jpg") || lower.ends_with(".jpeg") {
        "image/jpeg"
    } else if lower.ends_with(".gif") {
        "image/gif"
    } else {
        "application/octet-stream"
    }
}

fn upload_blocking(app: &AppHandle, file_path: String, file_name: String) -> Result<DriveUploadResult, String> {
    let bytes = std::fs::read(&file_path).map_err(|e| format!("Không đọc được file: {e}"))?;
    upload_bytes_blocking(app, bytes, file_name)
}

/// Lõi upload dùng chung — nhận thẳng bytes thay vì đường dẫn file, để
/// `history::commands::drive_upload_history_item` có thể gọi với bytes
/// `preview.png` (ảnh đã ghép annotation, lấy từ trong container `.snapdoc`)
/// mà không cần ghi ra file tạm trước.
pub(crate) fn upload_bytes_blocking(
    app: &AppHandle,
    bytes: Vec<u8>,
    file_name: String,
) -> Result<DriveUploadResult, String> {
    let token = valid_access_token(app)?;
    let mime = guess_mime(&file_name);

    let boundary = format!("snapdoc_boundary_{}", uuid::Uuid::new_v4().simple());
    let metadata = json!({ "name": file_name }).to_string();
    let mut body: Vec<u8> = Vec::with_capacity(bytes.len() + 512);
    body.extend_from_slice(
        format!(
            "--{boundary}\r\nContent-Type: application/json; charset=UTF-8\r\n\r\n{metadata}\r\n--{boundary}\r\nContent-Type: {mime}\r\n\r\n"
        )
        .as_bytes(),
    );
    body.extend_from_slice(&bytes);
    body.extend_from_slice(format!("\r\n--{boundary}--").as_bytes());

    let content_type = format!("multipart/related; boundary={boundary}");
    let upload_resp: serde_json::Value = ureq::post(UPLOAD_ENDPOINT)
        .set("Authorization", &format!("Bearer {token}"))
        .set("Content-Type", &content_type)
        .send_bytes(&body)
        .map_err(|e| format!("Tải lên Google Drive thất bại: {e}"))?
        .into_json()
        .map_err(|e| format!("Phản hồi không hợp lệ từ Drive: {e}"))?;

    let file_id = upload_resp
        .get("id")
        .and_then(|x| x.as_str())
        .ok_or("Không lấy được id file trên Drive")?
        .to_string();

    // Cấp quyền "ai có link đều xem được" — mặc định file mới trên Drive ở chế
    // độ riêng tư, không có bước này thì người nhận link sẽ thấy báo lỗi
    // không có quyền truy cập. Best-effort: lỗi ở đây không chặn việc trả về
    // link (file vẫn tồn tại, chỉ là người khác chưa xem được).
    let _ = ureq::post(&format!("{DRIVE_FILES_ENDPOINT}/{file_id}/permissions"))
        .set("Authorization", &format!("Bearer {token}"))
        .send_json(json!({ "role": "reader", "type": "anyone" }));

    Ok(DriveUploadResult {
        link: format!("https://drive.google.com/file/d/{file_id}/view?usp=sharing"),
    })
}

#[tauri::command]
pub async fn drive_connect(app: AppHandle, client_id: String, client_secret: String) -> Result<(), String> {
    tauri::async_runtime::spawn_blocking(move || connect_blocking(&app, client_id, client_secret))
        .await
        .map_err(|e| e.to_string())?
}

#[tauri::command]
pub fn drive_is_connected(app: AppHandle) -> bool {
    load_tokens(&app).map(|t| !t.refresh_token.is_empty()).unwrap_or(false)
}

#[tauri::command]
pub fn drive_disconnect(app: AppHandle) -> Result<(), String> {
    let path = tokens_path(&app);
    if path.exists() {
        std::fs::remove_file(&path).map_err(|e| e.to_string())?;
    }
    Ok(())
}

#[tauri::command]
pub async fn drive_upload(app: AppHandle, file_path: String, file_name: String) -> Result<DriveUploadResult, String> {
    tauri::async_runtime::spawn_blocking(move || upload_blocking(&app, file_path, file_name))
        .await
        .map_err(|e| e.to_string())?
}
