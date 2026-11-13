# E2E thực tế cho SnapDoc (điều khiển WebView2 qua DevTools Protocol)

Chạy **bản release thật** với IPC Tauri thật, bấm/gõ/chụp ảnh từng cửa sổ. Phát hiện được các lỗi mà `cargo check`, `tsc` và unit test không thấy (vd. app đơ do lệnh đồng bộ tạo cửa sổ, cửa sổ sập do hook sau `return`).

## An toàn: dùng bản build riêng

Không chạy bản test cùng định danh với bản đang cài (plugin một-phiên-bản sẽ chặn, và app **ghi đè mục autostart** `SnapDoc` trong registry mỗi lần khởi động). Build bản cô lập:

```powershell
npx tauri build --no-bundle --config scripts/e2e/e2e.conf.json   # identifier=com.snapdoc.e2etest, productName=SnapDocE2E
```

Copy `src-tauri/target/release/snapdoc.exe` + `ffmpeg.exe` ra một thư mục riêng, tạo sẵn
`%APPDATA%\com.snapdoc.e2etest\settings.json` với `launchAtLogin:false` và phím tắt khác (vd `CmdOrCtrl+Alt+Shift+F1…F9`), rồi chạy:

```powershell
$env:WEBVIEW2_ADDITIONAL_BROWSER_ARGUMENTS = "--remote-debugging-port=9333 --remote-allow-origins=*"
Start-Process .\snapdoc.exe
```

## Chạy kịch bản

`node scripts/e2e/s01_startup.mjs` … (Node ≥ 22). Mỗi kịch bản in `PASS/FAIL` theo mã test case và lưu ảnh chụp vào `scripts/e2e/shots/`.

Một số kịch bản (`s09`, `s10`) có đường dẫn tuyệt đối tới video/ffmpeg thử ở đầu file — sửa cho phù hợp máy bạn. `s09` tải engine + model Whisper thật (~70 MB).

`s12_captions_background.mjs` kiểm tra phụ đề chạy nền (popup tiến độ, đóng Editor giữa chừng không mất kết quả, tải nhiều model một lượt, huỷ). Tải thật `base` + `small` (~250 MB, ~4 phút). Lưu ý khi viết kịch bản CDP: đừng `await` lệnh `close_self` (cửa sổ bị huỷ nên không bao giờ trả lời → script treo); phím Esc qua CDP bị bỏ nếu phần tử đang focus là nút vừa bị disable — đóng hộp thoại bằng cách click nút ✕; Editor còn mở từ lần chạy trước giữ state cũ → đóng hẳn rồi mở lại đầu mỗi kịch bản.

`s13_mcp.mjs` kiểm tra MCP server cho AI agent (HTTP + cầu stdio), công tắc quyền ghi, nhật ký, xác nhận thao tác phá huỷ và các đường đưa video vào app. Đặt `E2E_EXE` = đường dẫn `snapdoc.exe` của bản e2e để test cầu stdio. Hộp thoại xác nhận (Yes/No gốc của Windows) được bấm bằng `click_dialog.ps1` (UI Automation, không chụp màn hình). Các thao tác "ghi đè bản gốc" chỉ chạy trên BẢN SAO video trong thư mục tạm. Kéo-thả được mô phỏng bằng cách phát sự kiện `tauri://drag-drop` (không thể kéo file thật qua CDP).

`s15_textgrab_2monitors.mjs` kiểm tra tính năng Text Grab (`Ctrl+Shift+T` / phím tắt cấu hình) trên thiết lập đa màn hình (2 màn hình trở lên):
- Yêu cầu đặt biến môi trường `$env:E2E_EXE = '<đường_dẫn_tới_snapdoc_e2e.exe>'`.
- Cấu hình phím tắt kiểm thử (mặc định e2e dùng `CmdOrCtrl+Alt+Shift+F10` cho `textGrab` trong `%APPDATA%\com.snapdoc.e2etest\settings.json`).
- Sử dụng các PowerShell helper trong `scripts/e2e/helpers/`: `textwin.ps1` (hiển thị text giả lập trên từng màn hình), `send_hotkey.ps1` (gửi phím tắt OS), `input.ps1` (mô phỏng thao tác kéo chuột OS thật vì overlay bắt sự kiện từ Win32 `GetAsyncKeyState`), `win_probe.ps1` (đếm và kiểm tra trạng thái cửa sổ overlay) và `restart_e2e.ps1` (khởi động app với cờ debug CDP :9333).
- Kiểm tra toàn diện: mở overlay trên mọi màn hình, kéo chọn và thả chuột đóng toàn bộ overlay trên tất cả các màn hình, sao chép kết quả OCR vào Clipboard, hiển thị toast tiếng Việt chuẩn UTF-8, đóng overlay bằng phím Esc và chuột phải.

## Không tự động hoá (cần test tay)

Chọn vùng/cuộn/quay màn hình, thumbnail sau chụp, tray, phím tắt toàn cục, OAuth Google thật, camera thật — vì chạm vào màn hình/camera/tài khoản của bạn.

Dọn sau test: xoá `%APPDATA%\com.snapdoc.e2etest`, `%LOCALAPPDATA%\com.snapdoc.e2etest` và mục `SnapDocE2E` (nếu có) trong `HKCU\Software\Microsoft\Windows\CurrentVersion\Run`.
