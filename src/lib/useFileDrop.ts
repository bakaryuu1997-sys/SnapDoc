import { useEffect, useState } from "react";
import { getCurrentWebviewWindow } from "@tauri-apps/api/webviewWindow";
import { ipc } from "./ipc";
import { showError } from "./notify";

export const VIDEO_EXT_RE = /\.(mp4|mov|m4v|webm|mkv|avi)$/i;
const IMAGE_EXT_RE = /\.(png|jpe?g|webp|bmp|gif|snapdoc)$/i;

/** Dán/kéo đường dẫn: bỏ dấu ngoặc kép thừa (Explorer "Copy as path") và khoảng trắng. */
export function cleanPath(raw: string): string {
  return raw.trim().replace(/^"+|"+$/g, "").trim();
}

/** Giống đường dẫn tuyệt đối tới file video? (ổ đĩa `C:\…`, UNC `\\server\…` hoặc `/…`) */
export function looksLikeVideoPath(raw: string): boolean {
  const p = cleanPath(raw);
  return VIDEO_EXT_RE.test(p) && (/^[a-zA-Z]:[\\/]/.test(p) || p.startsWith("\\\\") || p.startsWith("/"));
}

/**
 * Cho phép kéo-thả file từ Explorer vào cửa sổ hiện tại: video → mở trong Editor (qua Library),
 * ảnh/.snapdoc → mở trong Editor. Trả về `true` khi đang kéo file lên cửa sổ (để hiện lớp gợi ý).
 *
 * Editor tự xử lý kéo-thả riêng (chèn ảnh vào canvas) nên KHÔNG dùng hook này ở Editor.
 */
export function useFileDrop(opts: { images?: boolean } = {}): boolean {
  const [over, setOver] = useState(false);
  const images = opts.images ?? true;

  useEffect(() => {
    if (!("__TAURI_INTERNALS__" in window)) return;
    let unlisten: (() => void) | null = null;
    let disposed = false;
    getCurrentWebviewWindow()
      .onDragDropEvent((event) => {
        const p = event.payload;
        if (p.type === "enter" || p.type === "over") {
          setOver(true);
        } else if (p.type === "leave") {
          setOver(false);
        } else if (p.type === "drop") {
          setOver(false);
          const video = p.paths.find((x) => VIDEO_EXT_RE.test(x));
          if (video) {
            ipc.openVideoFilePath(video).catch(showError);
            return;
          }
          const image = images ? p.paths.find((x) => IMAGE_EXT_RE.test(x)) : undefined;
          if (image) ipc.openFilePath(image).catch(showError);
        }
      })
      .then((un) => {
        if (disposed) un();
        else unlisten = un;
      });
    return () => {
      disposed = true;
      unlisten?.();
    };
  }, [images]);

  return over;
}
