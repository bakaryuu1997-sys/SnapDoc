pub mod frame;
pub mod freeze;
pub mod fullscreen;
pub mod monitor;
pub mod region;
pub mod scroll_stitch;
pub mod window;

#[cfg(target_os = "macos")]
pub mod mac_sck;
#[cfg(target_os = "macos")]
pub mod mac_stream;
#[cfg(target_os = "windows")]
pub mod windows_stream;
#[cfg(target_os = "windows")]
pub mod win_affinity;

use base64::{engine::general_purpose::STANDARD, Engine};
use image::codecs::png::{CompressionType, FilterType, PngEncoder};
use image::{ExtendedColorType, ImageEncoder, RgbaImage};

/// Kết quả chụp: PNG raw bytes + base64 PNG + kích thước pixel vật lý.
#[derive(Clone)]
pub struct Capture {
    pub bytes: Vec<u8>,
    pub base64: String,
    pub width: u32,
    pub height: u32,
}

/// Mã hoá PNG ưu tiên TỐC ĐỘ (CompressionType::Fast + NoFilter) thay vì kích
/// thước file — phù hợp luồng chụp nhanh, ảnh thường được copy/sửa ngay.
pub fn encode_png(img: &RgbaImage) -> Result<Vec<u8>, String> {
    let mut bytes = Vec::new();
    PngEncoder::new_with_quality(&mut bytes, CompressionType::Fast, FilterType::NoFilter)
        .write_image(img.as_raw(), img.width(), img.height(), ExtendedColorType::Rgba8)
        .map_err(|e| format!("Lỗi mã hoá PNG: {e}"))?;
    Ok(bytes)
}

pub fn persist(img: &RgbaImage) -> Result<Capture, String> {
    let bytes = encode_png(img)?;
    let base64 = STANDARD.encode(&bytes);
    Ok(Capture {
        bytes,
        base64,
        width: img.width(),
        height: img.height(),
    })
}

/// Mã hoá PNG nén tối ưu (lossless) cho việc ghi ra đĩa:
/// - Nếu mọi pixel có alpha = 255 thì encode dạng RGB8 (tiết kiệm 25% kênh alpha thừa).
/// - Dùng `CompressionType::Default` + `FilterType::Adaptive`.
pub fn encode_png_compact(img: &RgbaImage) -> Result<Vec<u8>, String> {
    let mut bytes = Vec::new();
    let is_opaque = img.pixels().all(|p| p.0[3] == 255);
    let encoder = PngEncoder::new_with_quality(&mut bytes, CompressionType::Default, FilterType::Adaptive);
    if is_opaque {
        let (w, h) = (img.width(), img.height());
        let raw = img.as_raw();
        let mut rgb = Vec::with_capacity((w * h * 3) as usize);
        for chunk in raw.chunks_exact(4) {
            rgb.push(chunk[0]);
            rgb.push(chunk[1]);
            rgb.push(chunk[2]);
        }
        encoder
            .write_image(&rgb, w, h, ExtendedColorType::Rgb8)
            .map_err(|e| format!("Lỗi mã hoá PNG compact RGB: {e}"))?;
    } else {
        encoder
            .write_image(img.as_raw(), img.width(), img.height(), ExtendedColorType::Rgba8)
            .map_err(|e| format!("Lỗi mã hoá PNG compact RGBA: {e}"))?;
    }
    Ok(bytes)
}

/// Nén lại dữ liệu ảnh PNG trước khi ghi ra đĩa: decode rồi encode lại bằng `encode_png_compact`.
/// Best-effort: nếu lỗi hoặc kết quả không nhỏ hơn thì trả lại bytes gốc.
pub fn recompress_png(bytes: &[u8]) -> Vec<u8> {
    if !bytes.starts_with(&[0x89, b'P', b'N', b'G']) {
        return bytes.to_vec();
    }
    let start = std::time::Instant::now();
    let Ok(img) = image::load_from_memory(bytes) else {
        return bytes.to_vec();
    };
    let rgba = img.to_rgba8();
    match encode_png_compact(&rgba) {
        Ok(compact) => {
            let elapsed = start.elapsed();
            if compact.len() < bytes.len() {
                eprintln!(
                    "[SnapDoc Timing] recompress_png: {} bytes -> {} bytes ({:.1}% giảm) trong {:?}",
                    bytes.len(),
                    compact.len(),
                    (1.0 - (compact.len() as f64 / bytes.len() as f64)) * 100.0,
                    elapsed
                );
                compact
            } else {
                bytes.to_vec()
            }
        }
        Err(e) => {
            eprintln!("[SnapDoc] recompress_png thất bại ({e}), giữ bytes gốc");
            bytes.to_vec()
        }
    }
}

/// Mã hoá JPEG chất lượng cao (mặc định quality 92) — đặc biệt tối ưu cho ảnh cuộn siêu dài.
/// Giảm 85-90% dung lượng RAM/file và kích hoạt Hardware JPEG Decoder trên WebKit macOS.
pub fn encode_jpeg(img: &RgbaImage, quality: u8) -> Result<Vec<u8>, String> {
    #[cfg(target_os = "macos")]
    {
        if let Ok(bytes) = encode_jpeg_native_macos(img, quality as f32 / 100.0) {
            return Ok(bytes);
        }
    }
    encode_jpeg_cpu(img, quality)
}

#[cfg(target_os = "macos")]
fn encode_jpeg_native_macos(img: &RgbaImage, quality: f32) -> Result<Vec<u8>, String> {
    use objc2::{class, msg_send, rc::autoreleasepool, runtime::AnyObject};
    use objc2_foundation::ns_string;

    let width = img.width() as usize;
    let height = img.height() as usize;
    if width == 0 || height == 0 {
        return Err("Kích thước ảnh bằng 0".to_string());
    }
    let raw_ptr = img.as_raw().as_ptr() as *mut u8;

    autoreleasepool(|_| unsafe {
        let rep_alloc: *mut AnyObject = msg_send![class!(NSBitmapImageRep), alloc];
        if rep_alloc.is_null() {
            return Err("Alloc NSBitmapImageRep thất bại".to_string());
        }

        let mut planes: [*mut u8; 5] = [
            raw_ptr,
            std::ptr::null_mut(),
            std::ptr::null_mut(),
            std::ptr::null_mut(),
            std::ptr::null_mut(),
        ];
        let color_space = ns_string!("NSDeviceRGBColorSpace");

        let rep: *mut AnyObject = msg_send![
            rep_alloc,
            initWithBitmapDataPlanes: planes.as_mut_ptr(),
            pixelsWide: width as isize,
            pixelsHigh: height as isize,
            bitsPerSample: 8isize,
            samplesPerPixel: 4isize,
            hasAlpha: true,
            isPlanar: false,
            colorSpaceName: color_space,
            bytesPerRow: (width * 4) as isize,
            bitsPerPixel: 32isize
        ];

        if rep.is_null() {
            return Err("initWithBitmapDataPlanes thất bại".to_string());
        }

        let num: *mut AnyObject = msg_send![class!(NSNumber), numberWithDouble: quality as f64];
        let key = ns_string!("NSImageCompressionFactor");
        let props: *mut AnyObject = msg_send![class!(NSDictionary), dictionaryWithObject: num, forKey: key];

        // 3 = NSBitmapImageFileTypeJPEG
        let data: *mut AnyObject = msg_send![rep, representationUsingType: 3usize, properties: props];

        let result = if !data.is_null() {
            let len: usize = msg_send![data, length];
            let bytes: *const u8 = msg_send![data, bytes];
            if !bytes.is_null() && len > 0 {
                let slice = std::slice::from_raw_parts(bytes, len);
                Ok(slice.to_vec())
            } else {
                Err("Dữ liệu NSData JPEG rỗng".to_string())
            }
        } else {
            Err("representationUsingType thất bại".to_string())
        };

        let _: () = msg_send![rep, release];
        result
    })
}

pub fn encode_jpeg_cpu(img: &RgbaImage, quality: u8) -> Result<Vec<u8>, String> {
    let mut buf: Vec<u8> = Vec::new();
    let (w, h) = (img.width(), img.height());
    let raw = img.as_raw();
    let mut rgb = Vec::with_capacity((w * h * 3) as usize);
    for chunk in raw.chunks_exact(4) {
        rgb.push(chunk[0]);
        rgb.push(chunk[1]);
        rgb.push(chunk[2]);
    }
    image::codecs::jpeg::JpegEncoder::new_with_quality(&mut buf, quality)
        .write_image(&rgb, w, h, ExtendedColorType::Rgb8)
        .map_err(|e| format!("Lỗi mã hoá JPEG CPU: {e}"))?;
    Ok(buf)
}

/// Dành riêng cho chụp cuộn: lưu thành JPEG chất lượng 92% thay vì PNG,
/// giúp WebKit decode trong <100ms thay vì 2-3 giây.
pub fn persist_scroll(img: &RgbaImage) -> Result<Capture, String> {
    let bytes = encode_jpeg(img, 92)?;
    let base64 = STANDARD.encode(&bytes);
    Ok(Capture {
        bytes,
        base64,
        width: img.width(),
        height: img.height(),
    })
}

/// Encode WebP lossless từ RgbaImage
pub fn encode_webp(img: &RgbaImage) -> Result<Vec<u8>, String> {
    let mut buf = std::io::Cursor::new(Vec::new());
    img.write_to(&mut buf, image::ImageFormat::WebP)
        .map_err(|e| format!("Lỗi mã hoá WebP: {e}"))?;
    Ok(buf.into_inner())
}

/// Chuyển đổi định dạng ảnh lưu dựa trên cấu hình người dùng: "png" | "jpg" | "webp".
/// Trả về (bytes đã mã hóa, đuôi file tương ứng).
pub fn encode_formatted(bytes: &[u8], format: &str, quality: u8) -> Result<(Vec<u8>, &'static str), String> {
    match format.to_lowercase().as_str() {
        "jpg" | "jpeg" => {
            let img = image::load_from_memory(bytes)
                .map_err(|e| format!("Không đọc được ảnh để chuyển đổi sang JPG: {e}"))?
                .to_rgba8();
            let encoded = encode_jpeg(&img, quality)?;
            Ok((encoded, "jpg"))
        }
        "webp" => {
            let img = image::load_from_memory(bytes)
                .map_err(|e| format!("Không đọc được ảnh để chuyển đổi sang WebP: {e}"))?
                .to_rgba8();
            let encoded = encode_webp(&img)?;
            Ok((encoded, "webp"))
        }
        _ => {
            let encoded = recompress_png(bytes);
            Ok((encoded, "png"))
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use image::Rgba;

    #[test]
    fn test_encode_png_compact_and_recompress_opaque() {
        let mut img = RgbaImage::new(100, 100);
        for x in 0..100 {
            for y in 0..100 {
                img.put_pixel(x, y, Rgba([(x * 2) as u8, (y * 2) as u8, ((x + y) % 256) as u8, 255]));
            }
        }
        let fast_bytes = encode_png(&img).expect("encode_png fast");
        let compact_bytes = recompress_png(&fast_bytes);

        assert!(
            compact_bytes.len() < fast_bytes.len(),
            "compact ({}) phải nhỏ hơn fast ({})",
            compact_bytes.len(),
            fast_bytes.len()
        );

        // Decode cả hai và so sánh từng pixel bằng nhau
        let decoded_fast = image::load_from_memory(&fast_bytes).unwrap().to_rgba8();
        let decoded_compact = image::load_from_memory(&compact_bytes).unwrap().to_rgba8();
        assert_eq!(decoded_fast.dimensions(), decoded_compact.dimensions());
        for (p1, p2) in decoded_fast.pixels().zip(decoded_compact.pixels()) {
            assert_eq!(p1, p2, "Mỗi pixel phải giống hệt giữa fast và compact");
        }
    }

    #[test]
    fn test_encode_png_compact_with_alpha() {
        let mut img = RgbaImage::new(50, 50);
        for x in 0..50 {
            for y in 0..50 {
                let alpha = if (x + y) % 2 == 0 { 255 } else { 128 };
                img.put_pixel(x, y, Rgba([x as u8, y as u8, 200, alpha]));
            }
        }
        let fast_bytes = encode_png(&img).expect("encode_png fast");
        let compact_bytes = recompress_png(&fast_bytes);

        let decoded_fast = image::load_from_memory(&fast_bytes).unwrap().to_rgba8();
        let decoded_compact = image::load_from_memory(&compact_bytes).unwrap().to_rgba8();
        assert_eq!(decoded_fast.dimensions(), decoded_compact.dimensions());
        for (p1, p2) in decoded_fast.pixels().zip(decoded_compact.pixels()) {
            assert_eq!(p1, p2, "Pixel có alpha phải được bảo toàn chính xác");
        }
    }

    #[test]
    fn test_benchmark_compression_sizes() {
        let test_cases = [
            ("1080p (1920x1080)", 1920, 1080),
            ("2K / 1440p (2560x1440)", 2560, 1440),
            ("2 màn hình (3840x1080)", 3840, 1080),
        ];

        println!("\n=== BẢNG ĐO LƯỜNG NÉN PNG T1 ===");
        println!("| Trường hợp | Trước (Fast) | Sau (Compact) | Giảm | Thời gian nén |");
        println!("|---|---|---|---|---|");

        for (name, w, h) in test_cases {
            let mut img = RgbaImage::new(w, h);
            // Giả lập giao diện desktop: nền màu đậm, một số thanh taskbar, cửa sổ
            for x in 0..w {
                for y in 0..h {
                    let pixel = if y < 40 {
                        Rgba([32, 34, 37, 255]) // thanh tiêu đề
                    } else if y > h - 48 {
                        Rgba([24, 25, 28, 255]) // taskbar
                    } else if x > 200 && x < w - 200 && y > 100 && y < h - 100 {
                        if (x / 30 + y / 30) % 2 == 0 {
                            Rgba([245, 245, 247, 255])
                        } else {
                            Rgba([255, 255, 255, 255])
                        }
                    } else {
                        Rgba([45, 52, 64, 255])
                    };
                    img.put_pixel(x, y, pixel);
                }
            }

            let fast = encode_png(&img).unwrap();
            let start = std::time::Instant::now();
            let compact = encode_png_compact(&img).unwrap();
            let elapsed = start.elapsed();

            let fast_mb = fast.len() as f64 / (1024.0 * 1024.0);
            let compact_mb = compact.len() as f64 / (1024.0 * 1024.0);
            let pct = (1.0 - (compact.len() as f64 / fast.len() as f64)) * 100.0;

            println!(
                "| {} | {:.2} MB | {:.2} MB | {:.1}% | {:?} |",
                name, fast_mb, compact_mb, pct, elapsed
            );
        }
    }

    #[test]
    fn test_encode_formatted_png_jpg_webp() {
        let mut img = RgbaImage::new(50, 50);
        for x in 0..50 {
            for y in 0..50 {
                img.put_pixel(x, y, Rgba([x as u8 * 4, y as u8 * 4, 128, 255]));
            }
        }
        let png_raw = encode_png(&img).unwrap();

        // 1. Format PNG
        let (png_out, ext_png) = encode_formatted(&png_raw, "png", 90).unwrap();
        assert_eq!(ext_png, "png");
        assert_eq!(&png_out[0..4], &[0x89, 0x50, 0x4E, 0x47]);

        // 2. Format JPG
        let (jpg_out, ext_jpg) = encode_formatted(&png_raw, "jpg", 85).unwrap();
        assert_eq!(ext_jpg, "jpg");
        assert_eq!(&jpg_out[0..2], &[0xFF, 0xD8]);

        // 3. Format WebP
        let (webp_out, ext_webp) = encode_formatted(&png_raw, "webp", 90).unwrap();
        assert_eq!(ext_webp, "webp");
        assert_eq!(&webp_out[0..4], b"RIFF");
        assert_eq!(&webp_out[8..12], b"WEBP");
    }
}

