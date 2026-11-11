//! Hướng dẫn sử dụng SnapDoc — 1 trang HTML tự chứa (màu sắc, mục lục, sơ đồ, ảnh
//! nhúng sẵn) được đóng gói trong app, mở nhanh từ menu "Tuỳ chọn".
//!
//! Bản trong app được chép ra thư mục dữ liệu cục bộ để người dùng SỬA ĐƯỢC (chính
//! trang cũng có chế độ sửa/thêm/xoá mục). Quy tắc để không bao giờ mất chỉnh sửa:
//! - chưa có file → chép bản gốc;
//! - có file chưa bị sửa mà app có bản hướng dẫn mới hơn → cập nhật êm;
//! - có file đã bị người dùng sửa mà app có bản mới → GIỮ nguyên file của họ và đặt
//!   bản mới cạnh đó (`HUONG_DAN_SU_DUNG.moi.html`) để họ tự đối chiếu.

use sha2::{Digest, Sha256};
use std::fs;
use std::path::{Path, PathBuf};
use tauri::{AppHandle, Manager};

const GUIDE_HTML: &str = include_str!("../guide/HUONG_DAN_SU_DUNG.html");
const FILE_NAME: &str = "HUONG_DAN_SU_DUNG.html";
const NEW_NAME: &str = "HUONG_DAN_SU_DUNG.moi.html";
const SHA_NAME: &str = ".bundled.sha256";

fn sha_hex(bytes: &[u8]) -> String {
    let mut h = Sha256::new();
    h.update(bytes);
    format!("{:x}", h.finalize())
}

fn guide_dir(app: &AppHandle) -> PathBuf {
    app.path()
        .app_local_data_dir()
        .or_else(|_| app.path().app_config_dir())
        .unwrap_or_default()
        .join("guide")
}

/// Đảm bảo file hướng dẫn có trong `dir` (xem quy tắc ở đầu file) và trả về
/// đường dẫn file để mở.
fn sync_guide(dir: &Path, bundled: &str) -> Result<PathBuf, String> {
    fs::create_dir_all(dir).map_err(|e| format!("Không tạo được thư mục hướng dẫn: {e}"))?;
    let file = dir.join(FILE_NAME);
    let sha_file = dir.join(SHA_NAME);
    let bundled_sha = sha_hex(bundled.as_bytes());
    let write = |p: &Path, s: &str| fs::write(p, s).map_err(|e| format!("Không ghi được file hướng dẫn: {e}"));

    if !file.is_file() {
        write(&file, bundled)?;
        let _ = fs::write(&sha_file, &bundled_sha);
        return Ok(file);
    }
    let stored = fs::read_to_string(&sha_file).unwrap_or_default();
    let stored = stored.trim();
    if stored == bundled_sha {
        return Ok(file); // đã là bản mới nhất của app
    }
    let current_sha = fs::read(&file).map(|b| sha_hex(&b)).unwrap_or_default();
    if current_sha == stored {
        // Người dùng chưa sửa gì → cập nhật êm lên bản mới.
        write(&file, bundled)?;
        let _ = fs::write(&sha_file, &bundled_sha);
    } else {
        // Đã bị sửa: không đụng vào, chỉ đặt bản mới cạnh bên.
        write(&dir.join(NEW_NAME), bundled)?;
    }
    Ok(file)
}

/// Mở hướng dẫn sử dụng bằng trình duyệt mặc định; trả về đường dẫn file.
#[tauri::command]
pub async fn open_guide(app: AppHandle) -> Result<String, String> {
    let dir = guide_dir(&app);
    let file = tauri::async_runtime::spawn_blocking(move || sync_guide(&dir, GUIDE_HTML))
        .await
        .map_err(|e| format!("Task join error: {e}"))??;
    let path = file.to_string_lossy().to_string();
    use tauri_plugin_opener::OpenerExt;
    app.opener()
        .open_path(&path, None::<&str>)
        .map_err(|e| format!("Không mở được hướng dẫn: {e}"))?;
    Ok(path)
}

#[cfg(test)]
mod tests {
    use super::*;

    fn tmp() -> PathBuf {
        let p = std::env::temp_dir().join(format!("snapdoc_guide_{}", uuid::Uuid::new_v4().simple()));
        let _ = fs::remove_dir_all(&p);
        p
    }

    #[test]
    fn bundled_guide_is_self_contained_html() {
        assert!(GUIDE_HTML.starts_with("<!DOCTYPE html>") || GUIDE_HTML.starts_with("<!doctype html>"));
        assert!(GUIDE_HTML.contains("</html>"));
        assert!(!GUIDE_HTML.contains("{{img:"), "còn placeholder ảnh chưa nhúng — chạy `node scripts/build-guide.mjs`");
    }

    #[test]
    fn first_open_copies_the_bundled_guide() {
        let d = tmp();
        let f = sync_guide(&d, "<html>v1</html>").unwrap();
        assert_eq!(fs::read_to_string(&f).unwrap(), "<html>v1</html>");
        let _ = fs::remove_dir_all(&d);
    }

    #[test]
    fn untouched_file_is_updated_silently() {
        let d = tmp();
        sync_guide(&d, "v1").unwrap();
        let f = sync_guide(&d, "v2").unwrap();
        assert_eq!(fs::read_to_string(&f).unwrap(), "v2");
        assert!(!d.join(NEW_NAME).exists());
        let _ = fs::remove_dir_all(&d);
    }

    #[test]
    fn edited_file_is_never_overwritten() {
        let d = tmp();
        let f = sync_guide(&d, "v1").unwrap();
        fs::write(&f, "v1 + chỉnh sửa của tôi").unwrap();
        let f = sync_guide(&d, "v2").unwrap();
        assert_eq!(fs::read_to_string(&f).unwrap(), "v1 + chỉnh sửa của tôi");
        assert_eq!(fs::read_to_string(d.join(NEW_NAME)).unwrap(), "v2");
        let _ = fs::remove_dir_all(&d);
    }

    #[test]
    fn same_version_is_a_no_op() {
        let d = tmp();
        let f = sync_guide(&d, "v1").unwrap();
        fs::write(&f, "sửa").unwrap();
        sync_guide(&d, "v1").unwrap();
        assert_eq!(fs::read_to_string(&f).unwrap(), "sửa");
        assert!(!d.join(NEW_NAME).exists());
        let _ = fs::remove_dir_all(&d);
    }
}
