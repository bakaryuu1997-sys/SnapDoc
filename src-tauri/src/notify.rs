//! Thông báo lỗi/cảnh báo cho người dùng bằng hộp thoại NATIVE.
//!
//! Trước đây mọi lỗi đi qua event `snapdoc-error` → `window.alert()` trong
//! webview CaptureBar: WKWebView (macOS) KHÔNG hiện `alert()` nên người dùng
//! không bao giờ thấy lỗi (mic hỏng, ghép audio lỗi, quay không khởi động
//! được...), còn trên Windows alert hiện trong cửa sổ CaptureBar đang ẩn.
//!
//! Giờ hiển thị bằng `tauri-plugin-dialog` (NSAlert / MessageBox — không phụ
//! thuộc webview nào còn sống). Trong lúc đang quay (bắt đầu → quay → lưu),
//! thông báo được GOM LẠI và chỉ hiện sau khi phiên quay kết thúc: hộp thoại
//! giữa chừng vừa che màn hình đang quay, vừa có thể lọt vào chính video.

use std::sync::Mutex;
use tauri::{AppHandle, Listener};
use tauri_plugin_dialog::{DialogExt, MessageDialogKind};

#[derive(Clone, Copy, PartialEq, Eq, PartialOrd, Ord, Debug)]
pub enum Level {
    Info,
    Warning,
    Error,
}

static DEFERRED: Mutex<Vec<(Level, String)>> = Mutex::new(Vec::new());

pub fn error(app: &AppHandle, msg: &str) {
    notify(app, Level::Error, msg);
}

pub fn warning(app: &AppHandle, msg: &str) {
    notify(app, Level::Warning, msg);
}

pub fn info(app: &AppHandle, msg: &str) {
    notify(app, Level::Info, msg);
}

/// Như `info_now` nhưng mức cảnh báo — dùng cho sự cố lúc BẮT ĐẦU quay mà
/// người dùng cần biết ngay (mic hỏng, có thể quay nhầm màn hình...), không
/// đợi tới khi quay xong cả tiếng đồng hồ mới biết.
pub fn warning_now(app: &AppHandle, msg: &str) {
    eprintln!("[SnapDoc][notify:Warning] {msg}");
    show(app, Level::Warning, msg);
}

/// Hiện NGAY cả khi đang quay — chỉ dùng để phản hồi trực tiếp 1 thao tác
/// người dùng vừa làm (vd bấm chụp trong lúc đang quay): hoãn tới lúc dừng
/// quay thì thông báo mất ý nghĩa.
pub fn info_now(app: &AppHandle, msg: &str) {
    eprintln!("[SnapDoc][notify:Info] {msg}");
    show(app, Level::Info, msg);
}

fn notify(app: &AppHandle, level: Level, msg: &str) {
    let msg = msg.trim();
    if msg.is_empty() {
        return;
    }
    eprintln!("[SnapDoc][notify:{level:?}] {msg}");
    {
        // Kiểm tra "đang quay" và đẩy vào hàng chờ TRONG CÙNG 1 lần giữ lock —
        // `flush_deferred` (chạy ngay sau khi phiên quay về rảnh) lấy cùng
        // lock này, nên không thể có thông báo bị kẹt lại trong hàng chờ.
        let mut g = DEFERRED.lock().unwrap_or_else(|p| p.into_inner());
        if crate::record::is_busy(app) {
            if !g.iter().any(|(_, m)| m == msg) {
                g.push((level, msg.to_string()));
            }
            return;
        }
    }
    show(app, level, msg);
}

/// Hiện gộp mọi thông báo đã hoãn — `record` gọi mỗi khi phiên quay trở về
/// trạng thái rảnh (dừng xong, hoặc bắt đầu thất bại).
pub fn flush_deferred(app: &AppHandle) {
    let items = std::mem::take(&mut *DEFERRED.lock().unwrap_or_else(|p| p.into_inner()));
    if items.is_empty() {
        return;
    }
    let level = items.iter().map(|(l, _)| *l).max().unwrap_or(Level::Info);
    let text = items.into_iter().map(|(_, m)| m).collect::<Vec<_>>().join("\n\n");
    show(app, level, &text);
}

fn show(app: &AppHandle, level: Level, msg: &str) {
    let kind = match level {
        Level::Info => MessageDialogKind::Info,
        Level::Warning => MessageDialogKind::Warning,
        Level::Error => MessageDialogKind::Error,
    };
    // `show` không chặn: plugin tự đưa sang main thread rồi chờ ở thread riêng.
    app.dialog().message(msg).title("SnapDoc").kind(kind).show(|_| {});
}

/// Mọi nơi trong app (Rust lẫn webview) vẫn `emit("snapdoc-error", msg)` như
/// cũ — cầu nối này nhận event đó ở phía Rust và hiện hộp thoại native, không
/// còn phụ thuộc CaptureBar có đang sống/hiển thị hay không.
pub fn install_error_bridge(app: &AppHandle) {
    let handle = app.clone();
    app.listen_any("snapdoc-error", move |event| {
        let raw = event.payload();
        let msg = serde_json::from_str::<String>(raw).unwrap_or_else(|_| raw.to_string());
        error(&handle, &msg);
    });
}

/// Script PowerShell hiện balloon tip. Nội dung toast KHÔNG ghép vào dòng lệnh:
/// đi qua stdin. Dòng `InputEncoding = UTF8` là BẮT BUỘC — thiếu nó PowerShell
/// đọc stdin bằng codepage ANSI và tiếng Việt bị vỡ chữ.
#[cfg(target_os = "windows")]
const TOAST_SCRIPT: &str = r#"[Console]::InputEncoding = [System.Text.Encoding]::UTF8;
Add-Type -AssemblyName System.Windows.Forms
$msg = [Console]::In.ReadToEnd()
$n = New-Object System.Windows.Forms.NotifyIcon
$n.Icon = [System.Drawing.SystemIcons]::Information
$n.BalloonTipTitle = "SnapDoc"
$n.BalloonTipText = $msg
$n.Visible = $True
$n.ShowBalloonTip(4000)
Start-Sleep -Milliseconds 2500
$n.Dispose()
"#;

/// Phát thông báo desktop dạng toast/balloon không chặn luồng (non-blocking).
/// Dùng cho Text Grab (Ctrl+Shift+T): overlay đã đóng, CaptureBar báo kết quả.
pub fn show_toast(_app: &AppHandle, msg: &str) {
    let msg_owned = msg.to_string();
    std::thread::spawn(move || {
        #[cfg(target_os = "windows")]
        {
            use std::io::Write;
            use std::os::windows::process::CommandExt;
            const CREATE_NO_WINDOW: u32 = 0x08000000;
            if let Ok(mut child) = std::process::Command::new("powershell")
                .args([
                    "-NoProfile",
                    "-NonInteractive",
                    "-WindowStyle",
                    "Hidden",
                    "-Command",
                    TOAST_SCRIPT,
                ])
                .stdin(std::process::Stdio::piped())
                .creation_flags(CREATE_NO_WINDOW)
                .spawn()
            {
                if let Some(mut stdin) = child.stdin.take() {
                    let _ = stdin.write_all(msg_owned.as_bytes());
                }
                let _ = child.wait();
            }
        }
        #[cfg(target_os = "macos")]
        {
            let script = format!(
                "display notification \"{}\" with title \"SnapDoc\"",
                msg_owned
                    .replace('\\', "\\\\")
                    .replace('"', "\\\"")
                    .replace('\n', " ")
            );
            let _ = std::process::Command::new("osascript")
                .args(["-e", &script])
                .spawn();
        }
        #[cfg(not(any(target_os = "windows", target_os = "macos")))]
        {
            let _ = msg_owned;
        }
    });
}

#[cfg(all(test, target_os = "windows"))]
mod toast_tests {
    use super::TOAST_SCRIPT;

    #[test]
    fn toast_script_reads_stdin_as_utf8() {
        // Dòng đầu tiên phải đặt InputEncoding = UTF8 (lỗi vỡ chữ tiếng Việt).
        assert!(TOAST_SCRIPT.starts_with("[Console]::InputEncoding = [System.Text.Encoding]::UTF8;"));
        assert!(TOAST_SCRIPT.contains("[Console]::In.ReadToEnd()"));
    }

    #[test]
    fn toast_script_never_embeds_user_text() {
        // Nội dung toast chỉ đến từ stdin, không có chỗ ghép chuỗi (format!/{}).
        assert!(!TOAST_SCRIPT.contains("{}"));
    }
}
