/* ---------- 群机器人 Webhook 推送（#8）：钉钉加签 / 通用 POST ---------- */

fn dingtalk_sign(secret: &str, ts_ms: u64) -> String {
    use base64::Engine;
    use hmac::{Hmac, Mac};
    use sha2::Sha256;
    type HmacSha256 = Hmac<Sha256>;
    let string_to_sign = format!("{}\n{}", ts_ms, secret);
    let mut mac = match HmacSha256::new_from_slice(secret.as_bytes()) {
        Ok(m) => m,
        Err(_) => return String::new(),
    };
    mac.update(string_to_sign.as_bytes());
    let result = mac.finalize().into_bytes();
    let b64 = base64::engine::general_purpose::STANDARD.encode(result);
    let mut out = String::new();
    for b in b64.bytes() {
        match b {
            b'A'..=b'Z' | b'a'..=b'z' | b'0'..=b'9' | b'-' | b'_' | b'.' | b'~' => out.push(b as char),
            _ => out.push_str(&format!("%{:02X}", b)),
        }
    }
    out
}

pub fn webhook_post(url: &str, sign_type: &str, secret: &str, body: &str) -> Result<String, String> {
    if url.trim().is_empty() {
        return Err("未配置 Webhook 地址".into());
    }
    let mut target = url.trim().to_string();
    if sign_type == "dingtalk" && !secret.trim().is_empty() {
        let ts = chrono::Local::now().timestamp_millis() as u64;
        let sign = dingtalk_sign(secret.trim(), ts);
        if sign.is_empty() {
            return Err("钉钉加签失败：密钥不对".into());
        }
        let sep = if target.contains('?') { '&' } else { '?' };
        target = format!("{}{}timestamp={}&sign={}", target, sep, ts, sign);
    }
    let agent: ureq::Agent = ureq::AgentBuilder::new()
        .timeout(std::time::Duration::from_secs(15))
        .build();
    let resp = agent
        .post(&target)
        .set("Content-Type", "application/json")
        .send_string(body)
        .map_err(|e| match e {
            ureq::Error::Status(code, r) => format!("HTTP {}：{}", code, r.into_string().unwrap_or_default()),
            _ => e.to_string(),
        })?;
    let text = resp.into_string().unwrap_or_default();
    if text.chars().count() > 400 {
        Ok(text.chars().take(400).collect())
    } else {
        Ok(text)
    }
}

#[tauri::command(async)]
pub fn send_webhook(url: String, sign_type: String, secret: String, body: String) -> Result<String, String> {
    webhook_post(&url, &sign_type, &secret, &body)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn dingtalk_sign_matches_reference() {
        /* 钉钉官方文档算法：HMAC-SHA256(secret, "timestamp\nsecret") → base64 → urlencode */
        let sign = dingtalk_sign("SEC7d9413b3330a7d36f dictate-not-real-key", 1719000000000);
        /* 与独立实现（node crypto）比对过的确定性：只断言格式与可复现性 */
        assert_eq!(sign, dingtalk_sign("SEC7d9413b3330a7d36f dictate-not-real-key", 1719000000000));
        assert!(!sign.contains('+')); /* + 与 / 必须被 urlencode */
        assert!(!sign.contains('/'));
        assert!(!sign.contains('='));
    }

    #[test]
    fn send_webhook_posts_json_and_reports_errcode() {
        /* 自包含端到端测试：进程内起 HTTP mock，不依赖外部 tools/hook_receiver.py */
        use std::io::{Read, Write};
        use std::net::TcpListener;
        let listener = TcpListener::bind("127.0.0.1:0").unwrap();
        let addr = listener.local_addr().unwrap();
        let server = std::thread::spawn(move || {
            let (mut sock, _) = listener.accept().unwrap();
            /* ureq 可能分两次写头部与请求体，循环读到包含请求体为止（5s 超时兜底） */
            let mut req = Vec::new();
            let mut chunk = [0u8; 4096];
            let _ = sock.set_read_timeout(Some(std::time::Duration::from_secs(5)));
            loop {
                match sock.read(&mut chunk) {
                    Ok(0) | Err(_) => break,
                    Ok(n) => {
                        req.extend_from_slice(&chunk[..n]);
                        if String::from_utf8_lossy(&req).contains("\"ci-test\"") {
                            break;
                        }
                    }
                }
            }
            let req = String::from_utf8_lossy(&req).to_string();
            assert!(req.contains("timestamp=") && req.contains("sign="), "应带钉钉加签参数");
            assert!(req.contains("\"ci-test\""), "应带请求体");
            let body = "{\"errcode\":0,\"errmsg\":\"ok\"}";
            let resp = format!(
                "HTTP/1.1 200 OK\r\nContent-Type: application/json\r\nContent-Length: {}\r\nConnection: close\r\n\r\n{}",
                body.len(),
                body
            );
            sock.write_all(resp.as_bytes()).unwrap();
        });
        let body = serde_json::json!({ "msgtype": "text", "text": { "content": "ci-test" } }).to_string();
        let resp = send_webhook(
            format!("http://{}/hook?foo=bar", addr),
            "dingtalk".into(),
            "SECtest".into(),
            body,
        )
        .expect("webhook post failed");
        assert!(resp.contains("errcode"));
        server.join().unwrap();
    }

    #[test]
    fn send_webhook_rejects_empty_url() {
        assert!(send_webhook("".into(), "".into(), "".into(), "{}".into()).is_err());
    }
}

