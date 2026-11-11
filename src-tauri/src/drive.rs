//! Cloud Share (Google Drive) — kết nối OAuth2 theo chuẩn "installed app"
//! loopback redirect (RFC 8252, Google khuyến nghị cho ứng dụng Desktop),
//! rồi upload file + cấp quyền "ai có link đều xem được" qua Drive API v3.
//!
//! Thiết kế: hoàn toàn TÁCH RIÊNG khỏi mọi luồng chụp/quay/lưu cục bộ hiện có
//! — chỉ là 1 action bổ sung user chủ động bấm ("Chia sẻ qua Drive") trên 1
//! file ĐÃ lưu cục bộ, không thay đổi hành vi mặc định (vẫn lưu local trước).
//! Token lưu tại `drive_tokens.dat` trong thư mục cấu hình của app, được mã
//! hoá bằng Windows DPAPI (xem mục "Lưu token được mã hoá" bên dưới).

use serde::{Deserialize, Serialize};
use serde_json::json;
use std::path::{Path, PathBuf};
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

/* ───────────── Lưu token được mã hoá ─────────────
 *
 * Windows: mã hoá bằng DPAPI (`CryptProtectData`, phạm vi người dùng hiện tại +
 * entropy riêng của app) — file chỉ giải mã được bởi ĐÚNG tài khoản Windows
 * này trên ĐÚNG máy này; copy file sang máy/người dùng khác là vô dụng. Hệ
 * điều hành khác chưa có Keychain/Secret Service nên tạm lưu thô (cùng mức độ
 * bảo vệ như trước, chỉ quyền file của hệ thống).
 */

const TOKEN_FILE: &str = "drive_tokens.dat";
/// Tên file định dạng cũ (JSON thô) — tự chuyển sang dạng mã hoá khi gặp.
const LEGACY_TOKEN_FILE: &str = "drive_tokens.json";
const MAGIC: &[u8; 4] = b"SDT1";
const METHOD_PLAIN: u8 = 0;
const METHOD_DPAPI: u8 = 1;
#[cfg(windows)]
const DPAPI_ENTROPY: &[u8] = b"SnapDoc.Drive.Tokens.v1";

#[cfg(windows)]
fn dpapi_protect(plain: &[u8]) -> Result<Vec<u8>, String> {
    use windows_sys::Win32::Foundation::LocalFree;
    use windows_sys::Win32::Security::Cryptography::{
        CryptProtectData, CRYPTPROTECT_UI_FORBIDDEN, CRYPT_INTEGER_BLOB,
    };
    // SAFETY: các blob trỏ vào slice còn sống suốt lời gọi; `out.pbData` do hệ
    // thống cấp phát và được giải phóng bằng LocalFree sau khi đã copy ra Vec.
    unsafe {
        let input = CRYPT_INTEGER_BLOB { cbData: plain.len() as u32, pbData: plain.as_ptr() as *mut u8 };
        let entropy = CRYPT_INTEGER_BLOB {
            cbData: DPAPI_ENTROPY.len() as u32,
            pbData: DPAPI_ENTROPY.as_ptr() as *mut u8,
        };
        let mut out = CRYPT_INTEGER_BLOB { cbData: 0, pbData: std::ptr::null_mut() };
        let ok = CryptProtectData(
            &input,
            std::ptr::null(),
            &entropy,
            std::ptr::null(),
            std::ptr::null(),
            CRYPTPROTECT_UI_FORBIDDEN,
            &mut out,
        );
        if ok == 0 || out.pbData.is_null() {
            return Err("Không mã hoá được token bằng Windows DPAPI".into());
        }
        let v = std::slice::from_raw_parts(out.pbData, out.cbData as usize).to_vec();
        LocalFree(out.pbData as *mut core::ffi::c_void);
        Ok(v)
    }
}

#[cfg(windows)]
fn dpapi_unprotect(blob: &[u8]) -> Result<Vec<u8>, String> {
    use windows_sys::Win32::Foundation::LocalFree;
    use windows_sys::Win32::Security::Cryptography::{
        CryptUnprotectData, CRYPTPROTECT_UI_FORBIDDEN, CRYPT_INTEGER_BLOB,
    };
    // SAFETY: như `dpapi_protect`.
    unsafe {
        let input = CRYPT_INTEGER_BLOB { cbData: blob.len() as u32, pbData: blob.as_ptr() as *mut u8 };
        let entropy = CRYPT_INTEGER_BLOB {
            cbData: DPAPI_ENTROPY.len() as u32,
            pbData: DPAPI_ENTROPY.as_ptr() as *mut u8,
        };
        let mut out = CRYPT_INTEGER_BLOB { cbData: 0, pbData: std::ptr::null_mut() };
        let ok = CryptUnprotectData(
            &input,
            std::ptr::null_mut(),
            &entropy,
            std::ptr::null(),
            std::ptr::null(),
            CRYPTPROTECT_UI_FORBIDDEN,
            &mut out,
        );
        if ok == 0 || out.pbData.is_null() {
            return Err("Không giải mã được token (file không thuộc tài khoản Windows này hoặc đã hỏng)".into());
        }
        let v = std::slice::from_raw_parts(out.pbData, out.cbData as usize).to_vec();
        LocalFree(out.pbData as *mut core::ffi::c_void);
        Ok(v)
    }
}

fn seal(plain: &[u8]) -> Result<Vec<u8>, String> {
    #[cfg(windows)]
    let (method, payload) = (METHOD_DPAPI, dpapi_protect(plain)?);
    #[cfg(not(windows))]
    let (method, payload) = (METHOD_PLAIN, plain.to_vec());

    let mut out = Vec::with_capacity(MAGIC.len() + 1 + payload.len());
    out.extend_from_slice(MAGIC);
    out.push(method);
    out.extend_from_slice(&payload);
    Ok(out)
}

fn unseal(data: &[u8]) -> Result<Vec<u8>, String> {
    if data.len() < MAGIC.len() + 1 || &data[..MAGIC.len()] != MAGIC {
        return Err("File token không hợp lệ".into());
    }
    let payload = &data[MAGIC.len() + 1..];
    match data[MAGIC.len()] {
        METHOD_PLAIN => Ok(payload.to_vec()),
        METHOD_DPAPI => {
            #[cfg(windows)]
            {
                dpapi_unprotect(payload)
            }
            #[cfg(not(windows))]
            {
                Err("Token được mã hoá bằng Windows DPAPI, không đọc được trên hệ điều hành này".to_string())
            }
        }
        _ => Err("Định dạng file token không được hỗ trợ".into()),
    }
}

fn write_tokens(dir: &Path, t: &DriveTokens) -> Result<(), String> {
    let _ = std::fs::create_dir_all(dir);
    let json = serde_json::to_vec(t).map_err(|e| e.to_string())?;
    std::fs::write(dir.join(TOKEN_FILE), seal(&json)?).map_err(|e| e.to_string())
}

fn read_tokens(dir: &Path) -> Option<DriveTokens> {
    if let Ok(bytes) = std::fs::read(dir.join(TOKEN_FILE)) {
        let plain = unseal(&bytes).ok()?;
        return serde_json::from_slice(&plain).ok();
    }
    // Định dạng cũ (JSON thô): đọc 1 lần, ghi lại dạng mã hoá rồi xoá file thô.
    let legacy = dir.join(LEGACY_TOKEN_FILE);
    let content = std::fs::read_to_string(&legacy).ok()?;
    let t: DriveTokens = serde_json::from_str(&content).ok()?;
    if write_tokens(dir, &t).is_ok() {
        let _ = std::fs::remove_file(&legacy);
    }
    Some(t)
}

fn remove_tokens(dir: &Path) -> Result<(), String> {
    for name in [TOKEN_FILE, LEGACY_TOKEN_FILE] {
        let p = dir.join(name);
        if p.exists() {
            std::fs::remove_file(&p).map_err(|e| e.to_string())?;
        }
    }
    Ok(())
}

fn config_dir(app: &AppHandle) -> PathBuf {
    app.path().app_config_dir().unwrap_or_default()
}

fn load_tokens(app: &AppHandle) -> Option<DriveTokens> {
    read_tokens(&config_dir(app))
}

fn save_tokens(app: &AppHandle, t: &DriveTokens) -> Result<(), String> {
    write_tokens(&config_dir(app), t)
}

fn now_ms() -> u64 {
    std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .unwrap_or_default()
        .as_millis() as u64
}

/// PKCE code_verifier — 2 UUID v4 nối lại (64 ký tự hex ∈ tập "unreserved" của RFC 7636, độ dài
/// hợp lệ 43–128, ~244 bit ngẫu nhiên từ CSPRNG của hệ điều hành).
fn gen_code_verifier() -> String {
    format!("{}{}", uuid::Uuid::new_v4().simple(), uuid::Uuid::new_v4().simple())
}

/// PKCE `S256`: challenge = BASE64URL(SHA-256(verifier)). Khác `plain` (challenge = chính verifier),
/// kẻ nghe lén được URL xác thực (log trình duyệt, extension…) KHÔNG suy ra được verifier để đổi mã.
fn pkce_challenge_s256(verifier: &str) -> String {
    use base64::Engine;
    use sha2::{Digest, Sha256};
    base64::engine::general_purpose::URL_SAFE_NO_PAD.encode(Sha256::digest(verifier.as_bytes()))
}

/// `state` ngẫu nhiên cho mỗi lần đăng nhập: chống CSRF/"login CSRF" — trang web hay tiến trình
/// khác trên máy gọi thẳng cổng loopback kèm `code` của kẻ tấn công sẽ bị bỏ qua vì sai `state`.
fn gen_state() -> String {
    format!("{}{}", uuid::Uuid::new_v4().simple(), uuid::Uuid::new_v4().simple())
}

fn build_auth_url(client_id: &str, redirect_uri: &str, challenge: &str, state: &str) -> String {
    format!(
        "{AUTH_ENDPOINT}?client_id={}&redirect_uri={}&response_type=code&scope={}&code_challenge={}&code_challenge_method=S256&state={}&access_type=offline&prompt=consent",
        urlencode(client_id),
        urlencode(redirect_uri),
        urlencode(SCOPE),
        urlencode(challenge),
        urlencode(state),
    )
}

/// So sánh chuỗi hằng thời gian (không rò rỉ độ dài khớp qua thời gian phản hồi).
fn ct_eq_str(a: &str, b: &str) -> bool {
    let (a, b) = (a.as_bytes(), b.as_bytes());
    if a.len() != b.len() {
        return false;
    }
    a.iter().zip(b).fold(0u8, |d, (x, y)| d | (x ^ y)) == 0
}

/// Kết quả của 1 request tới cổng loopback.
#[derive(Debug, PartialEq)]
enum Callback {
    /// `code` hợp lệ kèm đúng `state`.
    Code(String),
    /// Google trả lỗi (người dùng bấm Từ chối…) kèm đúng `state`.
    Denied(String),
    /// Không phải callback của lần đăng nhập này (sai đường dẫn/`state`) → bỏ qua, tiếp tục chờ.
    Ignore,
}

fn classify_callback(url: &str, expected_state: &str) -> Callback {
    let (path, query) = match url.split_once('?') {
        Some((p, q)) => (p, q),
        None => (url, ""),
    };
    if path != "/callback" {
        return Callback::Ignore;
    }
    match parse_query_param(query, "state") {
        Some(st) if ct_eq_str(&st, expected_state) => {}
        _ => return Callback::Ignore,
    }
    if let Some(e) = parse_query_param(query, "error") {
        return Callback::Denied(e);
    }
    match parse_query_param(query, "code") {
        Some(c) if !c.is_empty() => Callback::Code(c),
        _ => Callback::Ignore,
    }
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
    let state = gen_state();
    let auth_url = build_auth_url(&client_id, &redirect_uri, &pkce_challenge_s256(&verifier), &state);

    {
        use tauri_plugin_opener::OpenerExt;
        app.opener()
            .open_url(auth_url, None::<&str>)
            .map_err(|e| format!("Không mở được trình duyệt hệ thống: {e}"))?;
    }

    // Chờ ĐÚNG callback của lần đăng nhập này (đúng đường dẫn + đúng `state`). Request lạ — favicon,
    // trình duyệt dò cổng, hoặc trang web/tiến trình khác cố nhét `code` giả — chỉ bị từ chối (404/400)
    // chứ không được "ăn" mất lượt chờ.
    let deadline = std::time::Instant::now() + Duration::from_secs(180);
    let code = loop {
        let remaining = deadline.saturating_duration_since(std::time::Instant::now());
        if remaining.is_zero() {
            return Err("Hết thời gian chờ đăng nhập Google (3 phút) — hãy thử Kết nối lại.".into());
        }
        let request = server
            .recv_timeout(remaining)
            .map_err(|e| format!("Lỗi chờ đăng nhập Google: {e}"))?
            .ok_or("Hết thời gian chờ đăng nhập Google (3 phút) — hãy thử Kết nối lại.")?;
        let outcome = classify_callback(request.url(), &state);
        if outcome == Callback::Ignore {
            let _ = request.respond(tiny_http::Response::from_string("Not found").with_status_code(404));
            continue;
        }
        let response_html = "<html><body style=\"font-family:sans-serif;text-align:center;padding-top:80px;color:#333\"><h2>Đã xong — bạn có thể đóng tab này và quay lại SnapDoc.</h2></body></html>";
        let header = tiny_http::Header::from_bytes(&b"Content-Type"[..], &b"text/html; charset=utf-8"[..])
            .map_err(|_| "Lỗi nội bộ (header)".to_string())?;
        let _ = request.respond(tiny_http::Response::from_string(response_html).with_header(header));
        match outcome {
            Callback::Code(c) => break c,
            Callback::Denied(e) => return Err(format!("Google từ chối cấp quyền: {e}")),
            Callback::Ignore => unreachable!(),
        }
    };

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
    remove_tokens(&config_dir(&app))
}

#[tauri::command]
pub async fn drive_upload(app: AppHandle, file_path: String, file_name: String) -> Result<DriveUploadResult, String> {
    tauri::async_runtime::spawn_blocking(move || upload_blocking(&app, file_path, file_name))
        .await
        .map_err(|e| e.to_string())?
}

#[cfg(test)]
mod tests {
    #[test]
    fn pkce_s256_matches_rfc7636_vector() {
        // RFC 7636, Appendix B.
        assert_eq!(
            pkce_challenge_s256("dBjftJeZ4CVP-mB92K27uhbUJU1p1r_wW1gFWFOEjXk"),
            "E9Melhoa2OwvFrEMTJguCHaoeK1t8URWbuGJSstw-cM"
        );
        let v = gen_code_verifier();
        assert!((43..=128).contains(&v.len()));
    }

    #[test]
    fn auth_url_uses_s256_and_state_never_plain() {
        let u = build_auth_url("cid", "http://127.0.0.1:1/callback", "CHAL", "ST");
        assert!(u.contains("code_challenge_method=S256"));
        assert!(!u.contains("plain"));
        assert!(u.contains("&state=ST&"));
    }

    #[test]
    fn callback_requires_exact_path_and_state() {
        let st = "abc123";
        assert_eq!(classify_callback("/callback?code=XYZ&state=abc123", st), Callback::Code("XYZ".into()));
        assert_eq!(classify_callback("/callback?code=XYZ", st), Callback::Ignore, "thiếu state");
        assert_eq!(classify_callback("/callback?code=XYZ&state=evil", st), Callback::Ignore, "sai state");
        assert_eq!(classify_callback("/other?code=XYZ&state=abc123", st), Callback::Ignore, "sai đường dẫn");
        assert_eq!(classify_callback("/favicon.ico", st), Callback::Ignore);
        assert_eq!(
            classify_callback("/callback?error=access_denied&state=abc123", st),
            Callback::Denied("access_denied".into())
        );
        assert_eq!(classify_callback("/callback?error=access_denied", st), Callback::Ignore, "lỗi giả không state");
        assert_eq!(classify_callback("/callback?code=&state=abc123", st), Callback::Ignore, "code rỗng");
    }

    #[test]
    fn ct_eq_str_basics() {
        assert!(ct_eq_str("a", "a"));
        assert!(!ct_eq_str("a", "b"));
        assert!(!ct_eq_str("ab", "a"));
    }

    use super::*;

    fn sample() -> DriveTokens {
        DriveTokens {
            client_id: "id.apps.googleusercontent.com".into(),
            client_secret: "GOCSPX-test-secret-value".into(),
            refresh_token: "1//refresh-token-very-secret".into(),
            access_token: "ya29.access-token".into(),
            expires_at_ms: 1_700_000_000_000,
        }
    }

    struct Tmp(PathBuf);
    impl Tmp {
        fn new() -> Self {
            let p = std::env::temp_dir().join(format!("snapdoc_drive_test_{}", uuid::Uuid::new_v4().simple()));
            std::fs::create_dir_all(&p).unwrap();
            Tmp(p)
        }
    }
    impl Drop for Tmp {
        fn drop(&mut self) {
            let _ = std::fs::remove_dir_all(&self.0);
        }
    }

    #[test]
    fn seal_unseal_roundtrip() {
        let sealed = seal(b"hello token").unwrap();
        assert_eq!(unseal(&sealed).unwrap(), b"hello token");
    }

    #[test]
    fn rejects_bad_header_and_unknown_method() {
        assert!(unseal(b"nope").is_err());
        assert!(unseal(b"XXXX\x01abc").is_err());
        assert!(unseal(b"SDT1\x09abc").is_err());
    }

    #[cfg(windows)]
    #[test]
    fn dpapi_blob_hides_plaintext_and_detects_tampering() {
        let secret = b"1//refresh-token-very-secret";
        let sealed = seal(secret).unwrap();
        assert_eq!(sealed[MAGIC.len()], METHOD_DPAPI);
        assert!(
            !sealed.windows(secret.len()).any(|w| w == secret),
            "blob mã hoá không được chứa token ở dạng thô"
        );
        let mut tampered = sealed.clone();
        let last = tampered.len() - 1;
        tampered[last] ^= 0xFF;
        assert!(unseal(&tampered).is_err(), "blob bị sửa phải bị từ chối");
    }

    #[test]
    fn write_then_read_roundtrip_and_file_is_not_plain_json() {
        let tmp = Tmp::new();
        write_tokens(&tmp.0, &sample()).unwrap();
        let raw = std::fs::read(tmp.0.join(TOKEN_FILE)).unwrap();
        if cfg!(windows) {
            assert!(!String::from_utf8_lossy(&raw).contains("refresh-token-very-secret"));
        }
        let back = read_tokens(&tmp.0).unwrap();
        assert_eq!(back.refresh_token, "1//refresh-token-very-secret");
        assert_eq!(back.expires_at_ms, 1_700_000_000_000);
    }

    #[test]
    fn migrates_legacy_plaintext_json_and_deletes_it() {
        let tmp = Tmp::new();
        let legacy = tmp.0.join(LEGACY_TOKEN_FILE);
        std::fs::write(&legacy, serde_json::to_string_pretty(&sample()).unwrap()).unwrap();

        let got = read_tokens(&tmp.0).expect("phải đọc được file cũ");
        assert_eq!(got.access_token, "ya29.access-token");
        assert!(!legacy.exists(), "file JSON thô phải bị xoá sau khi chuyển đổi");
        assert!(tmp.0.join(TOKEN_FILE).exists());
        // Lần đọc sau dùng file đã mã hoá.
        assert_eq!(read_tokens(&tmp.0).unwrap().refresh_token, got.refresh_token);
    }

    #[test]
    fn remove_tokens_deletes_both_formats() {
        let tmp = Tmp::new();
        write_tokens(&tmp.0, &sample()).unwrap();
        std::fs::write(tmp.0.join(LEGACY_TOKEN_FILE), "{}").unwrap();
        remove_tokens(&tmp.0).unwrap();
        assert!(read_tokens(&tmp.0).is_none());
        assert!(!tmp.0.join(TOKEN_FILE).exists() && !tmp.0.join(LEGACY_TOKEN_FILE).exists());
    }

    #[test]
    fn missing_directory_means_not_connected() {
        let tmp = Tmp::new();
        assert!(read_tokens(&tmp.0.join("does-not-exist")).is_none());
    }
}
