//! Xác thực yêu cầu HTTP tới server MCP cục bộ: Bearer token + chống DNS-rebinding
//! (kiểm tra `Host`) + chống CSRF từ trang web (từ chối mọi yêu cầu có `Origin`).

/// So sánh thời gian không đổi (không rò độ dài khớp qua thời gian trả lời).
pub fn ct_eq(a: &[u8], b: &[u8]) -> bool {
    let mut diff = (a.len() ^ b.len()) as u8;
    let n = a.len().max(b.len());
    for i in 0..n {
        let x = a.get(i).copied().unwrap_or(0);
        let y = b.get(i).copied().unwrap_or(0);
        diff |= x ^ y;
    }
    diff == 0
}

/// `Authorization: Bearer <token>` — token rỗng (chưa cấu hình) không bao giờ khớp.
pub fn check_bearer(header: Option<&str>, token: &str) -> bool {
    if token.is_empty() {
        return false;
    }
    let Some(h) = header else { return false };
    let h = h.trim();
    let Some((scheme, rest)) = h.split_once(char::is_whitespace) else { return false };
    if !scheme.eq_ignore_ascii_case("bearer") {
        return false;
    }
    ct_eq(rest.trim().as_bytes(), token.as_bytes())
}

/// Chỉ chấp nhận `Host` là chính loopback + đúng cổng đang nghe.
pub fn check_host(host: Option<&str>, port: u16) -> bool {
    let Some(h) = host else { return false };
    let h = h.trim().to_ascii_lowercase();
    [format!("127.0.0.1:{port}"), format!("localhost:{port}"), format!("[::1]:{port}")].contains(&h)
}

/// Client MCP (CLI/Desktop/IDE) KHÔNG gửi `Origin`; trình duyệt thì luôn gửi cho
/// yêu cầu cross-origin → có `Origin` nghĩa là trang web đang cố gọi server này.
pub fn check_origin(origin: Option<&str>) -> bool {
    origin.is_none()
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn bearer_accepts_only_exact_token() {
        let t = "a".repeat(64);
        assert!(check_bearer(Some(&format!("Bearer {t}")), &t));
        assert!(check_bearer(Some(&format!("bearer   {t}  ")), &t), "không phân biệt hoa thường scheme, bỏ khoảng trắng");
        assert!(!check_bearer(None, &t));
        assert!(!check_bearer(Some(""), &t));
        assert!(!check_bearer(Some(&t), &t), "thiếu scheme Bearer");
        assert!(!check_bearer(Some("Basic abc"), &t));
        assert!(!check_bearer(Some(&format!("Bearer {}b", &t[..63])), &t));
        assert!(!check_bearer(Some(&format!("Bearer {t}x")), &t), "dài hơn một ký tự");
        assert!(!check_bearer(Some(&format!("Bearer {}", &t[..63])), &t), "ngắn hơn một ký tự");
    }

    #[test]
    fn empty_configured_token_never_matches() {
        assert!(!check_bearer(Some("Bearer "), ""));
        assert!(!check_bearer(Some("Bearer x"), ""));
    }

    #[test]
    fn host_must_be_loopback_with_right_port() {
        assert!(check_host(Some("127.0.0.1:5000"), 5000));
        assert!(check_host(Some("LOCALHOST:5000"), 5000));
        assert!(check_host(Some("[::1]:5000"), 5000));
        assert!(!check_host(Some("127.0.0.1:5001"), 5000));
        assert!(!check_host(Some("evil.example.com:5000"), 5000), "DNS rebinding");
        assert!(!check_host(Some("127.0.0.1"), 5000), "thiếu cổng");
        assert!(!check_host(None, 5000));
    }

    #[test]
    fn any_origin_is_rejected() {
        assert!(check_origin(None));
        assert!(!check_origin(Some("https://evil.example.com")));
        assert!(!check_origin(Some("http://localhost:5000")));
        assert!(!check_origin(Some("null")));
    }

    #[test]
    fn ct_eq_basics() {
        assert!(ct_eq(b"abc", b"abc"));
        assert!(!ct_eq(b"abc", b"abd"));
        assert!(!ct_eq(b"abc", b"ab"));
        assert!(ct_eq(b"", b""));
    }
}
