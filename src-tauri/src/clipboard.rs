use base64::{engine::general_purpose::STANDARD, Engine};

/// Nhận base64 PNG (có thể kèm prefix data URL), trả về raw bytes.
fn decode(data: &str) -> Result<Vec<u8>, String> {
    let b64 = data.split(',').next_back().unwrap_or(data);
    STANDARD
        .decode(b64.trim())
        .map_err(|e| format!("Base64 không hợp lệ: {e}"))
}

/// Copy ảnh PNG (base64) vào clipboard hệ thống dưới dạng bitmap.
pub fn copy_png(data: &str) -> Result<(), String> {
    copy_png_bytes(&decode(data)?)
}

/// Copy ảnh PNG (raw bytes) vào clipboard — dùng khi ảnh đã có sẵn dạng bytes
/// (vd đọc thẳng từ file asset History), tránh vòng encode/decode base64 thừa.
pub fn copy_png_bytes(bytes: &[u8]) -> Result<(), String> {
    let img = image::load_from_memory(bytes)
        .map_err(|e| format!("Không đọc được ảnh: {e}"))?
        .to_rgba8();
    let (w, h) = (img.width() as usize, img.height() as usize);

    let mut clipboard =
        arboard::Clipboard::new().map_err(|e| format!("Không mở được clipboard: {e}"))?;
    clipboard
        .set_image(arboard::ImageData {
            width: w,
            height: h,
            bytes: img.into_raw().into(),
        })
        .map_err(|e| format!("Không copy được ảnh: {e}"))?;
    Ok(())
}

/// Copy chuỗi văn bản (text) vào clipboard hệ thống.
pub fn copy_text(text: &str) -> Result<(), String> {
    // 1. Thử ghi clipboard qua arboard với vòng lặp thử lại tối đa 5 lần (đề phòng app khác lock clipboard)
    for _ in 0..5 {
        if let Ok(mut clipboard) = arboard::Clipboard::new() {
            if clipboard.set_text(text).is_ok() {
                return Ok(());
            }
        }
        std::thread::sleep(std::time::Duration::from_millis(40));
    }

    // 2. Fallback đặc quyền trên Windows: Dùng Set-Clipboard qua stdin không sợ lỗi format/quote
    #[cfg(target_os = "windows")]
    {
        use std::io::Write;
        use std::os::windows::process::CommandExt;
        const CREATE_NO_WINDOW: u32 = 0x08000000;
        let child = std::process::Command::new("powershell")
            .args([
                "-NoProfile",
                "-NonInteractive",
                "-WindowStyle",
                "Hidden",
                "-Command",
                "[Console]::InputEncoding = [System.Text.Encoding]::UTF8; $input | Set-Clipboard",
            ])
            .stdin(std::process::Stdio::piped())
            .creation_flags(CREATE_NO_WINDOW)
            .spawn();
        if let Ok(mut c) = child {
            if let Some(mut stdin) = c.stdin.take() {
                let _ = stdin.write_all(text.as_bytes());
            }
            if let Ok(status) = c.wait() {
                if status.success() {
                    return Ok(());
                }
            }
        }
    }

    Err("Không copy được văn bản vào clipboard hệ thống".into())
}

/// Copy file ảnh GIF vào clipboard hệ thống dưới dạng ảnh động (hoặc file drop).
#[cfg(target_os = "macos")]
pub fn copy_gif_file(path: &std::path::Path) -> Result<(), String> {
    if !path.exists() {
        return Err(format!("File GIF không tồn tại: {}", path.display()));
    }
    let path_str = path.to_string_lossy();
    let script = format!(
        "set the clipboard to (read (POSIX file \"{}\") as «class GIFf»)",
        path_str.replace('"', "\\\"")
    );
    let out = std::process::Command::new("osascript")
        .arg("-e")
        .arg(&script)
        .output()
        .map_err(|e| format!("Lỗi gọi osascript: {e}"))?;
    if !out.status.success() {
        return Err(format!(
            "osascript copy GIF thất bại: {}",
            String::from_utf8_lossy(&out.stderr)
        ));
    }
    Ok(())
}

#[cfg(target_os = "windows")]
pub fn copy_gif_file(path: &std::path::Path) -> Result<(), String> {
    if !path.exists() {
        return Err(format!("File GIF không tồn tại: {}", path.display()));
    }
    // KHÔNG ghép đường dẫn vào chuỗi lệnh: PowerShell coi cả dấu nháy cong (‘ ’ ‚ ‛) là dấu nháy đơn,
    // nên chỉ thoát `'` vẫn để tên file chứa ký tự đó "thoát" khỏi chuỗi và chèn được lệnh.
    // Truyền qua biến môi trường + `-LiteralPath` (không diễn giải ký tự đại diện như `[`).
    let mut cmd = std::process::Command::new("powershell");
    cmd.env("SNAPDOC_CLIP_PATH", path.as_os_str());
    cmd.args([
        "-NoProfile",
        "-NonInteractive",
        "-WindowStyle",
        "Hidden",
        "-Command",
        "Set-Clipboard -LiteralPath $env:SNAPDOC_CLIP_PATH",
    ]);
    #[cfg(target_os = "windows")]
    {
        use std::os::windows::process::CommandExt;
        cmd.creation_flags(0x08000000);
    }
    let out = cmd
        .output()
        .map_err(|e| format!("Lỗi gọi powershell: {e}"))?;
    if !out.status.success() {
        return Err(format!(
            "powershell copy GIF thất bại: {}",
            String::from_utf8_lossy(&out.stderr)
        ));
    }
    Ok(())
}

#[cfg(not(any(target_os = "macos", target_os = "windows")))]
pub fn copy_gif_file(_path: &std::path::Path) -> Result<(), String> {
    Err("Nền tảng này chưa hỗ trợ copy file GIF vào clipboard".to_string())
}

