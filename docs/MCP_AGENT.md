# SnapDoc × AI Agent (MCP)

SnapDoc có sẵn một **MCP server** chạy trong chính app (Windows). Claude Code, Claude Desktop, Antigravity… kết nối vào để đọc Thư viện và — khi bạn cho phép — nhập/cắt/crop/đổi tốc độ video, tạo phụ đề.

Mã nguồn: `src-tauri/src/mcp/`. Hướng dẫn cho người dùng cuối: mục “AI Agent (MCP)” trong trang Hướng dẫn sử dụng.

## Bật

`Cài đặt › AI Agent` → bật **Bật MCP server**. Mặc định server **tắt** và quyền ghi **tắt**.
Cấu hình (cổng, token, 2 công tắc) lưu ở `%APPDATA%\com.snapdoc.app\mcp.json`; nhật ký ở `mcp-audit.jsonl` cùng thư mục.

## Kết nối

Tab **KẾT NỐI** sinh sẵn cấu hình đã điền token. Ba kiểu:

**Claude Code** (HTTP trực tiếp)

```bash
claude mcp add --transport http snapdoc http://127.0.0.1:<PORT>/mcp --header "Authorization: Bearer <TOKEN>"
```

**Claude Desktop** — `claude_desktop_config.json` (Settings → Developer → Edit Config), qua cầu stdio:

```json
{
  "mcpServers": {
    "snapdoc": {
      "command": "C:\\Program Files\\SnapDoc\\snapdoc.exe",
      "args": ["--mcp-stdio"]
    }
  }
}
```

`snapdoc.exe --mcp-stdio` không mở cửa sổ: nó đọc `mcp.json` (cổng + token) mỗi lần có yêu cầu và chuyển sang server HTTP trong app đang chạy, nên **không cần sửa cấu hình khi đổi token/cổng**. Thêm `"--config-dir", "<thư mục>"` hoặc biến `SNAPDOC_CONFIG_DIR` nếu dùng thư mục dữ liệu khác.

**Antigravity** — `mcp_config.json`: dùng khối stdio ở trên, hoặc HTTP:

```json
{
  "mcpServers": {
    "snapdoc": {
      "serverUrl": "http://127.0.0.1:<PORT>/mcp",
      "headers": { "Authorization": "Bearer <TOKEN>" }
    }
  }
}
```

SnapDoc phải đang chạy. Cổng được chọn ngẫu nhiên lần bật đầu rồi nhớ lại.

## Ba lớp an toàn

1. **Công tắc quyền ghi** (mặc định tắt, có hộp xác nhận khi bật, hiệu lực ngay): tắt thì mọi tool ghi trả lỗi giải thích cách bật. File cấu hình hỏng/thiếu ⇒ mọi thứ tắt.
2. **Nhật ký** append-only: thời gian, tool, tham số rút gọn, kết quả/lỗi, tên client, thời gian chạy; gồm cả lời gọi bị từ chối và truy cập sai token. Agent đọc được (`get_activity_log`) nhưng không có tool nào sửa/xoá; chỉ người dùng xoá trong Cài đặt (việc xoá cũng được ghi).
3. **Xác nhận thao tác phá huỷ**: `delete_to_trash` và mọi chỉnh sửa có `replaceOriginal: true` (ghi đè file video gốc — lưu ý video nhập từ ngoài chính là file gốc của bạn) luôn bật hộp thoại Yes/No gốc của Windows; đóng hộp thoại/không trả lời trong 120 s = từ chối. Thêm: giới hạn 30 thao tác ghi/phút, đường dẫn xuất chỉ trong thư mục lưu của SnapDoc / thư mục video gốc / Videos·Downloads·Desktop·Documents·Pictures và không ghi đè file có sẵn. **Không có** tool xoá vĩnh viễn, dọn Thùng rác, đổi Cài đặt, chụp/quay màn hình.

Server chỉ bind `127.0.0.1`, yêu cầu Bearer token (so sánh thời gian không đổi), kiểm tra `Host` (chống DNS rebinding) và từ chối mọi yêu cầu có `Origin` (trang web trong trình duyệt).

## Tool

| Nhóm | Tool |
|---|---|
| Đọc | `app_status`, `list_history`, `get_item`, `get_preview`, `get_captions`, `captions_status`, `get_job`, `get_activity_log` |
| Ghi | `import_video`, `open_in_editor`, `rename_item`, `trim_video`, `crop_video`, `change_speed`, `captions_setup`, `generate_captions`, `export_srt`, `add_captions_to_video`, `restore_item` |
| Phá huỷ (hỏi từng lần) | `delete_to_trash`; `trim_video`/`crop_video`/`change_speed` với `replaceOriginal` |

Tác vụ lâu trả `jobId` sau 40 s; hỏi lại bằng `get_job`.

## Kiểm thử

- Unit test (Rust): `cd src-tauri && cargo test --lib mcp::` — công tắc ghi, nhật ký, xác thực token/Host/Origin, giới hạn tốc độ, xác nhận, server HTTP, cầu stdio.
- E2E thật: `scripts/e2e/s13_mcp.mjs` (xem `scripts/e2e/README.md`).
