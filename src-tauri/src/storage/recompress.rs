use std::path::PathBuf;
use std::sync::atomic::{AtomicBool, Ordering};
use tauri::{AppHandle, Emitter, Manager};

static CANCELLED: AtomicBool = AtomicBool::new(false);

#[derive(Clone, serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub struct RecompressProgress {
    pub current: usize,
    pub total: usize,
    pub compressed_count: usize,
    pub saved_bytes: u64,
    pub current_file: String,
}

#[derive(Clone, serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub struct RecompressResult {
    pub total_scanned: usize,
    pub compressed_count: usize,
    pub saved_bytes: u64,
    pub cancelled: bool,
}

/// Đặt cờ huỷ quá trình nén
pub fn cancel() {
    CANCELLED.store(true, Ordering::Relaxed);
}

/// Quét `saveDir` và thư mục thư viện History, nén lại mọi file PNG không mất chất lượng.
pub fn run_recompress(app: &AppHandle) -> Result<RecompressResult, String> {
    CANCELLED.store(false, Ordering::Relaxed);

    // 1. Tìm saveDir từ settings
    let config_dir = app.path().app_config_dir().unwrap_or_default();
    let s = super::settings::load(&config_dir);
    let save_dir_str = s.get("saveDir").and_then(|v| v.as_str()).unwrap_or("").to_string();
    let save_dir = if !save_dir_str.is_empty() {
        PathBuf::from(save_dir_str)
    } else {
        app.path()
            .picture_dir()
            .map(|p| p.join("SnapDoc"))
            .unwrap_or_default()
    };

    // 2. Tìm thư mục Library assets
    let library_assets = crate::history::assets::assets_dir(app).ok();

    // 3. Đường dẫn file đang active trong Editor (nếu có thì bỏ qua)
    let active_path: Option<String> = {
        let state = app.state::<crate::AppState>();
        state.pending.lock().ok().and_then(|g| g.as_ref().and_then(|p| p.file_path.clone()))
    };

    // Thu thập danh sách file PNG cần xử lý
    let mut files_to_scan: Vec<PathBuf> = Vec::new();

    // Quét saveDir (không đệ quy)
    if save_dir.is_dir() {
        if let Ok(entries) = std::fs::read_dir(&save_dir) {
            for entry in entries.flatten() {
                let p = entry.path();
                if p.is_file() {
                    if let Some(ext) = p.extension().and_then(|e| e.to_str()) {
                        if ext.eq_ignore_ascii_case("png") {
                            if let Some(ref act) = active_path {
                                if p.to_string_lossy() == *act {
                                    continue;
                                }
                            }
                            files_to_scan.push(p);
                        }
                    }
                }
            }
        }
    }

    // Quét library/assets (không đệ quy)
    if let Some(ref lib_dir) = library_assets {
        if lib_dir.is_dir() {
            if let Ok(entries) = std::fs::read_dir(lib_dir) {
                for entry in entries.flatten() {
                    let p = entry.path();
                    if p.is_file() {
                        if let Some(ext) = p.extension().and_then(|e| e.to_str()) {
                            if ext.eq_ignore_ascii_case("png") {
                                files_to_scan.push(p);
                            }
                        }
                    }
                }
            }
        }
    }

    // Loại bỏ file trùng nếu saveDir trùng library/assets
    files_to_scan.sort();
    files_to_scan.dedup();

    let total = files_to_scan.len();
    let mut compressed_count = 0usize;
    let mut saved_bytes = 0u64;
    let mut was_cancelled = false;

    for (idx, path) in files_to_scan.iter().enumerate() {
        if CANCELLED.load(Ordering::Relaxed) {
            was_cancelled = true;
            break;
        }

        let file_name = path
            .file_name()
            .map(|n| n.to_string_lossy().to_string())
            .unwrap_or_default();

        let _ = app.emit(
            "snapdoc:recompress-progress",
            RecompressProgress {
                current: idx + 1,
                total,
                compressed_count,
                saved_bytes,
                current_file: file_name,
            },
        );

        if let Ok((saved, changed)) = recompress_single_png(path) {
            if changed {
                compressed_count += 1;
                saved_bytes += saved;
            }
        }
    }

    Ok(RecompressResult {
        total_scanned: total,
        compressed_count,
        saved_bytes,
        cancelled: was_cancelled,
    })
}

/// Nén lại 1 file PNG cụ thể nếu có thể nén nhỏ hơn mà pixel giống hệt 100%.
/// Giữ nguyên mtime. Trả về (bytes_tiết_kiệm, đã_nén_thành_công).
pub fn recompress_single_png(path: &std::path::Path) -> Result<(u64, bool), String> {
    let metadata = std::fs::metadata(path).map_err(|e| e.to_string())?;
    let mtime = metadata.modified().map_err(|e| e.to_string())?;
    let old_bytes = std::fs::read(path).map_err(|e| e.to_string())?;

    let new_bytes = crate::capture::recompress_png(&old_bytes);
    if new_bytes.len() >= old_bytes.len() {
        return Ok((0, false));
    }

    // Decode cả 2 để so pixel từng vị trí
    let old_img = image::load_from_memory(&old_bytes)
        .map_err(|e| e.to_string())?
        .to_rgba8();
    let new_img = image::load_from_memory(&new_bytes)
        .map_err(|e| e.to_string())?
        .to_rgba8();

    if old_img.dimensions() != new_img.dimensions() || old_img.as_raw() != new_img.as_raw() {
        // Sai khác pixel — huỷ bỏ để đảm bảo an toàn tuyệt đối
        return Ok((0, false));
    }

    // Ghi atomic qua file tạm cùng thư mục
    let parent = path.parent().unwrap_or(std::path::Path::new("."));
    let tmp_path = parent.join(format!(
        ".snapdoc_tmp_{}.png",
        uuid::Uuid::new_v4().simple()
    ));

    std::fs::write(&tmp_path, &new_bytes).map_err(|e| e.to_string())?;

    // Đặt lại mtime cho file tạm trước khi rename
    let ft = filetime::FileTime::from_system_time(mtime);
    let _ = filetime::set_file_mtime(&tmp_path, ft);

    if let Err(e) = std::fs::rename(&tmp_path, path) {
        let _ = std::fs::remove_file(&tmp_path);
        return Err(format!("Lỗi atomic rename: {e}"));
    }

    let saved = (old_bytes.len() - new_bytes.len()) as u64;
    Ok((saved, true))
}

#[cfg(test)]
mod tests {
    use super::*;
    use image::{Rgba, RgbaImage};

    #[test]
    fn test_recompress_single_png_preserves_mtime_and_pixels() {
        let tmp_dir = std::env::temp_dir().join(format!("snapdoc_recompress_test_{}", uuid::Uuid::new_v4()));
        let _ = std::fs::create_dir_all(&tmp_dir);
        let test_file = tmp_dir.join("sample.png");

        let mut img = RgbaImage::new(100, 100);
        for x in 0..100 {
            for y in 0..100 {
                img.put_pixel(x, y, Rgba([x as u8, y as u8, 128, 255]));
            }
        }

        // Tạo file PNG mã hóa Fast (dung lượng lớn)
        let fast_bytes = crate::capture::encode_png(&img).unwrap();
        std::fs::write(&test_file, &fast_bytes).unwrap();

        // Đặt mtime cố định trong quá khứ (ví dụ 1000 giây trước)
        let past_time = std::time::SystemTime::now() - std::time::Duration::from_secs(1000);
        let past_ft = filetime::FileTime::from_system_time(past_time);
        filetime::set_file_mtime(&test_file, past_ft).unwrap();

        let initial_size = std::fs::metadata(&test_file).unwrap().len();

        // Chạy nén
        let (saved, changed) = recompress_single_png(&test_file).expect("recompress");
        assert!(changed, "File phải được nén thành công");
        assert!(saved > 0, "Dung lượng tiết kiệm phải > 0");

        let new_size = std::fs::metadata(&test_file).unwrap().len();
        assert_eq!(new_size, initial_size - saved);

        // Kiểm tra mtime giữ nguyên
        let new_mtime = std::fs::metadata(&test_file).unwrap().modified().unwrap();
        let diff = new_mtime
            .duration_since(past_time)
            .unwrap_or_else(|_| past_time.duration_since(new_mtime).unwrap());
        assert!(diff.as_secs() <= 2, "mtime phải được giữ nguyên");

        // Kiểm tra pixel giống hệt
        let reloaded = image::open(&test_file).unwrap().to_rgba8();
        assert_eq!(img.dimensions(), reloaded.dimensions());
        assert_eq!(img.as_raw(), reloaded.as_raw());

        // Dọn dẹp
        let _ = std::fs::remove_file(&test_file);
        let _ = std::fs::remove_dir(&tmp_dir);
    }
}
