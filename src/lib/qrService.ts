import jsQR from "jsqr";

/**
 * Thử giải mã mã QR từ ảnh dataUrl hoặc ImageData.
 * Trả về chuỗi nội dung nếu tìm thấy mã QR hợp lệ, hoặc null nếu không có QR.
 * Chạy offline 100%, thời gian xử lý cực nhanh (~1-10ms).
 */
export async function decodeQrFromDataUrl(dataUrl: string): Promise<string | null> {
  if (!dataUrl || typeof Image === "undefined") {
    return null;
  }
  return new Promise((resolve) => {
    const img = new Image();
    img.crossOrigin = "anonymous";
    img.onload = () => {
      try {
        const { naturalWidth: w, naturalHeight: h } = img;
        if (w <= 0 || h <= 0) {
          resolve(null);
          return;
        }
        const canvas = document.createElement("canvas");
        canvas.width = w;
        canvas.height = h;
        const ctx = canvas.getContext("2d", { willReadFrequently: true });
        if (!ctx) {
          resolve(null);
          return;
        }
        ctx.drawImage(img, 0, 0);
        const imageData = ctx.getImageData(0, 0, w, h);
        const code = jsQR(imageData.data, w, h, {
          inversionAttempts: "attemptBoth",
        });
        resolve(code && code.data ? code.data : null);
      } catch {
        resolve(null);
      }
    };
    img.onerror = () => resolve(null);
    img.src = dataUrl;
  });
}
