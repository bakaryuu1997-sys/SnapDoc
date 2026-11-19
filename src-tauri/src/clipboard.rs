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

/// Copy nhiều ảnh/file vào clipboard hệ thống cùng lúc.
/// Trên Windows: ghi trong một lần mở clipboard 3 định dạng:
/// 1. CF_HDROP: danh sách file Unicode (Explorer, Slack, Teams, Telegram, Discord...)
/// 2. "HTML Format" (CF_HTML): các thẻ <img src="file:///..."> (Word, Outlook...)
/// 3. CF_DIB: bitmap ảnh đầu tiên (Paint, app đồ hoạ cổ điển)
#[cfg(target_os = "windows")]
pub fn copy_images_multi(paths: &[std::path::PathBuf]) -> Result<(), String> {
    if paths.is_empty() {
        return Ok(());
    }

    use std::os::windows::ffi::OsStrExt;
    use windows_sys::Win32::Foundation::POINT;
    use windows_sys::Win32::System::DataExchange::{
        CloseClipboard, EmptyClipboard, OpenClipboard, RegisterClipboardFormatA, SetClipboardData,
    };
    use windows_sys::Win32::System::Memory::{GlobalAlloc, GlobalLock, GlobalUnlock, GHND};
    use windows_sys::Win32::UI::Shell::DROPFILES;

    const CF_DIB: u32 = 8;
    const CF_HDROP: u32 = 15;

    // 1. Chuẩn bị dữ liệu CF_HDROP (danh sách file Unicode null-terminated kết thúc bằng double null)
    let mut wide_paths: Vec<u16> = Vec::new();
    for path in paths {
        let abs_path = if path.is_absolute() {
            path.to_path_buf()
        } else if let Ok(cur) = std::env::current_dir() {
            cur.join(path)
        } else {
            path.to_path_buf()
        };
        for code in abs_path.as_os_str().encode_wide() {
            wide_paths.push(code);
        }
        wide_paths.push(0);
    }
    wide_paths.push(0);

    let dropfiles_size = std::mem::size_of::<DROPFILES>();
    let total_drop_bytes = dropfiles_size + wide_paths.len() * 2;

    let h_drop = unsafe { GlobalAlloc(GHND, total_drop_bytes) };
    if h_drop.is_null() {
        return Err("Không thể cấp phát bộ nhớ cho CF_HDROP".to_string());
    }

    unsafe {
        let ptr = GlobalLock(h_drop);
        if ptr.is_null() {
            return Err("Không thể khóa bộ nhớ cho CF_HDROP".to_string());
        }
        let df = DROPFILES {
            pFiles: dropfiles_size as u32,
            pt: POINT { x: 0, y: 0 },
            fNC: 0,
            fWide: 1, // UTF-16 Unicode
        };
        std::ptr::copy_nonoverlapping(&df as *const _ as *const u8, ptr as *mut u8, dropfiles_size);
        std::ptr::copy_nonoverlapping(
            wide_paths.as_ptr() as *const u8,
            (ptr as *mut u8).add(dropfiles_size),
            wide_paths.len() * 2,
        );
        GlobalUnlock(h_drop);
    }

    // 2. Chuẩn bị dữ liệu HTML Format (CF_HTML) với thẻ <img src="file:///...">
    let cf_html = unsafe { RegisterClipboardFormatA(b"HTML Format\0".as_ptr()) };
    let mut h_html: windows_sys::Win32::Foundation::HGLOBAL = std::ptr::null_mut();

    if cf_html != 0 {
        let mut img_tags = String::new();
        for path in paths {
            let abs_path = if path.is_absolute() {
                path.to_path_buf()
            } else if let Ok(cur) = std::env::current_dir() {
                cur.join(path)
            } else {
                path.to_path_buf()
            };
            let path_str = abs_path.to_string_lossy().replace('\\', "/");
            let url = if path_str.starts_with('/') {
                format!("file://{path_str}")
            } else {
                format!("file:///{path_str}")
            };
            img_tags.push_str(&format!(r#"<img src="{url}" /><br />"#));
        }

        let html_prefix = "<html><body><!--StartFragment-->";
        let html_suffix = "<!--EndFragment--></body></html>";
        // Header length là đúng 109 bytes:
        // Version:0.9\r\n (13)
        // StartHTML:0000000000\r\n (23)
        // EndHTML:0000000000\r\n (21)
        // StartFragment:0000000000\r\n (27)
        // EndFragment:0000000000\r\n (25)
        let header_len = 109;
        let start_html = header_len;
        let start_fragment = start_html + html_prefix.len();
        let end_fragment = start_fragment + img_tags.len();
        let end_html = end_fragment + html_suffix.len();

        let header = format!(
            "Version:0.9\r\nStartHTML:{:010}\r\nEndHTML:{:010}\r\nStartFragment:{:010}\r\nEndFragment:{:010}\r\n",
            start_html, end_html, start_fragment, end_fragment
        );
        let full_html = format!("{header}{html_prefix}{img_tags}{html_suffix}\0");
        let html_bytes = full_html.as_bytes();

        let mem = unsafe { GlobalAlloc(GHND, html_bytes.len()) };
        if !mem.is_null() {
            let ptr = unsafe { GlobalLock(mem) };
            if !ptr.is_null() {
                unsafe {
                    std::ptr::copy_nonoverlapping(html_bytes.as_ptr(), ptr as *mut u8, html_bytes.len());
                    GlobalUnlock(mem);
                }
                h_html = mem;
            }
        }
    }

    // 3. Chuẩn bị dữ liệu CF_DIB (ảnh đầu tiên)
    let mut h_dib: windows_sys::Win32::Foundation::HGLOBAL = std::ptr::null_mut();
    if let Some(first_path) = paths.first() {
        if let Ok(img) = image::open(first_path) {
            let rgba = img.to_rgba8();
            let (w, h) = (rgba.width() as usize, rgba.height() as usize);
            if w > 0 && h > 0 {
                let header_size = 40usize;
                let image_size = w * h * 4;
                let total_size = header_size + image_size;
                let mem = unsafe { GlobalAlloc(GHND, total_size) };
                if !mem.is_null() {
                    let ptr = unsafe { GlobalLock(mem) };
                    if !ptr.is_null() {
                        unsafe {
                            let header_slice = std::slice::from_raw_parts_mut(ptr as *mut u8, header_size);
                            header_slice[0..4].copy_from_slice(&(40u32).to_le_bytes());
                            header_slice[4..8].copy_from_slice(&(w as i32).to_le_bytes());
                            header_slice[8..12].copy_from_slice(&(h as i32).to_le_bytes());
                            header_slice[12..14].copy_from_slice(&(1u16).to_le_bytes());
                            header_slice[14..16].copy_from_slice(&(32u16).to_le_bytes());
                            header_slice[16..20].copy_from_slice(&(0u32).to_le_bytes()); // BI_RGB
                            header_slice[20..24].copy_from_slice(&(image_size as u32).to_le_bytes());
                            header_slice[24..40].fill(0);

                            let pixel_ptr = (ptr as *mut u8).add(header_size);
                            let mut offset = 0usize;
                            for y in (0..h).rev() {
                                for x in 0..w {
                                    let pixel = rgba.get_pixel(x as u32, y as u32);
                                    *pixel_ptr.add(offset) = pixel[2];     // B
                                    *pixel_ptr.add(offset + 1) = pixel[1]; // G
                                    *pixel_ptr.add(offset + 2) = pixel[0]; // R
                                    *pixel_ptr.add(offset + 3) = pixel[3]; // A
                                    offset += 4;
                                }
                            }
                            GlobalUnlock(mem);
                        }
                        h_dib = mem;
                    }
                }
            }
        }
    }

    // 4. Mở Clipboard và ghi cả 3 định dạng trong 1 lần mở
    let mut opened = false;
    for _ in 0..10 {
        if unsafe { OpenClipboard(std::ptr::null_mut()) } != 0 {
            opened = true;
            break;
        }
        std::thread::sleep(std::time::Duration::from_millis(30));
    }
    if !opened {
        return Err("Không mở được clipboard hệ thống (đang bị ứng dụng khác khóa)".to_string());
    }

    unsafe {
        EmptyClipboard();
        SetClipboardData(CF_HDROP, h_drop as _);
        if !h_html.is_null() && cf_html != 0 {
            SetClipboardData(cf_html, h_html as _);
        }
        if !h_dib.is_null() {
            SetClipboardData(CF_DIB, h_dib as _);
        }
        CloseClipboard();
    }

    Ok(())
}

#[cfg(target_os = "macos")]
pub fn copy_images_multi(_paths: &[std::path::PathBuf]) -> Result<(), String> {
    Err("Chưa hỗ trợ trên macOS".to_string())
}

#[cfg(not(any(target_os = "windows", target_os = "macos")))]
pub fn copy_images_multi(_paths: &[std::path::PathBuf]) -> Result<(), String> {
    Err("Nền tảng này chưa hỗ trợ copy nhiều ảnh vào clipboard".to_string())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn test_copy_images_multi_empty() {
        assert!(copy_images_multi(&[]).is_ok());
    }

    #[test]
    fn test_copy_images_multi_with_unicode_path() {
        let tmp_dir = std::env::temp_dir().join("snapdoc_test_clipboard_マイドライブ_dự án");
        let _ = std::fs::create_dir_all(&tmp_dir);
        let img_path = tmp_dir.join("test_img.png");

        // Tạo 1 ảnh PNG nhỏ hợp lệ
        let img = image::RgbaImage::new(10, 10);
        let _ = img.save(&img_path);

        let res = copy_images_multi(&[img_path.clone()]);
        assert!(res.is_ok(), "copy_images_multi thất bại: {:?}", res.err());

        // Dọn dẹp
        let _ = std::fs::remove_file(&img_path);
        let _ = std::fs::remove_dir(&tmp_dir);
    }
}

