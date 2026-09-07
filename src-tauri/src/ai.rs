/* ---------- AI 润色（#16）：自定义模型供应商，统一走 OpenAI 兼容 /chat/completions ----------
 * 智谱 / DeepSeek / Kimi / 百炼 / SiliconFlow / OpenAI / OpenRouter 均兼容该协议；
 * 本机 Ollama 也提供 http://localhost:11434/v1 兼容端点，因此无需单独适配。
 * 供应商配置（baseUrl/apiKey/model）由前端存于 meta('aiProvider')，调用时整体传入。 */

use serde::{Deserialize, Serialize};

#[derive(Serialize, Deserialize, Clone, Debug, Default)]
#[serde(rename_all = "camelCase", default)]
struct AiProvider {
    name: String,
    base_url: String,
    api_key: String,
    model: String,
}

fn ai_provider_from_json(s: &str) -> Result<AiProvider, String> {
    serde_json::from_str(s).map_err(|e| format!("AI 供应商配置无效：{}（请到设置里重新保存一次）", e))
}

fn normalize_base_url(u: &str) -> String {
    u.trim().trim_end_matches('/').to_string()
}

fn ai_agent() -> ureq::Agent {
    ureq::AgentBuilder::new()
        .timeout_connect(std::time::Duration::from_secs(10))
        .timeout(std::time::Duration::from_secs(180))
        .build()
}

fn ai_http_err(e: ureq::Error) -> String {
    match e {
        ureq::Error::Status(code, r) => {
            let hint = match code {
                401 | 403 => "，通常是 API Key 不对或无权限",
                404 => "，通常是 Base URL 不对（要以 /v1 这类兼容前缀结尾）",
                429 => "，限流或余额不足",
                _ => "",
            };
            let body = r.into_string().unwrap_or_default();
            let short: String = body.chars().take(300).collect();
            format!("HTTP {}{}：{}", code, hint, short)
        }
        _ => {
            let msg = e.to_string();
            if msg.contains("connection") || msg.contains("Connection") || msg.contains("timed out") {
                format!("连接失败：{}（检查网络/代理与 Base URL；本机服务需先启动）", msg)
            } else {
                format!("请求失败：{}", msg)
            }
        }
    }
}

fn strip_code_fences(s: &str) -> String {
    let t = s.trim();
    if t.starts_with("```") {
        let body = t.trim_start_matches("```");
        let body = match body.find('\n') {
            Some(i) => &body[i + 1..],
            None => body,
        };
        let body = body.strip_suffix("```").unwrap_or(body);
        return body.trim().to_string();
    }
    t.to_string()
}

fn chat_content_from_json(v: &serde_json::Value) -> Result<String, String> {
    let content = v
        .get("choices")
        .and_then(|c| c.as_array())
        .and_then(|a| a.first())
        .and_then(|c| c.get("message"))
        .and_then(|m| m.get("content"))
        .and_then(|c| c.as_str())
        .map(|s| s.trim().to_string())
        .unwrap_or_default();
    if content.is_empty() {
        return Err("模型返回了空内容。若使用的是推理类模型（如 deepseek-reasoner），请换成普通对话模型重试。".into());
    }
    Ok(strip_code_fences(&content))
}

fn chat_request_body(cfg: &AiProvider, system: &str, user: &str) -> serde_json::Value {
    serde_json::json!({
        "model": cfg.model,
        "messages": [
            { "role": "system", "content": system },
            { "role": "user", "content": user }
        ],
        "stream": false
    })
}

#[tauri::command(async)]
pub fn ai_chat(cfg: String, system: String, user: String) -> Result<String, String> {
    let p = ai_provider_from_json(&cfg)?;
    if p.base_url.trim().is_empty() || p.model.trim().is_empty() {
        return Err("尚未配置模型供应商：请到「设置 ⚙ → AI 润色」选择预设、填写 API Key 与模型 ID".into());
    }
    let url = format!("{}/chat/completions", normalize_base_url(&p.base_url));
    let mut req = ai_agent().post(&url).set("Content-Type", "application/json");
    if !p.api_key.trim().is_empty() {
        req = req.set("Authorization", &format!("Bearer {}", p.api_key.trim()));
    }
    let resp: serde_json::Value = req
        .send_string(&chat_request_body(&p, &system, &user).to_string())
        .map_err(ai_http_err)?
        .into_json()
        .map_err(|e| format!("响应解析失败：{}", e))?;
    /* OpenAI 兼容错误体：{"error": {"message": …}}，部分供应商 200 也带 error */
    if let Some(err) = resp.get("error") {
        let m = err.get("message").and_then(|x| x.as_str()).unwrap_or("未知错误");
        return Err(format!("供应商返回错误：{}", m));
    }
    chat_content_from_json(&resp)
}

#[tauri::command(async)]
pub fn ai_list_models(cfg: String) -> Result<Vec<String>, String> {
    let p = ai_provider_from_json(&cfg)?;
    if p.base_url.trim().is_empty() {
        return Err("请先填写 API 地址（Base URL）".into());
    }
    let url = format!("{}/models", normalize_base_url(&p.base_url));
    let mut req = ai_agent().get(&url);
    if !p.api_key.trim().is_empty() {
        req = req.set("Authorization", &format!("Bearer {}", p.api_key.trim()));
    }
    let resp: serde_json::Value = req
        .call()
        .map_err(ai_http_err)?
        .into_json()
        .map_err(|e| format!("响应解析失败：{}", e))?;
    Ok(models_from_json(&resp))
}

fn models_from_json(v: &serde_json::Value) -> Vec<String> {
    let mut out: Vec<String> = v
        .get("data")
        .and_then(|d| d.as_array())
        .map(|a| {
            a.iter()
                .filter_map(|m| m.get("id").and_then(|i| i.as_str()))
                .map(|s| s.to_string())
                .collect()
        })
        .unwrap_or_default();
    out.sort();
    out
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn chat_content_extracts_and_unwraps_fences() {
        let v: serde_json::Value = serde_json::from_str(
            r#"{"choices":[{"message":{"role":"assistant","content":"```text\n润色后的日报正文\n```"}}]}"#,
        )
        .unwrap();
        assert_eq!(chat_content_from_json(&v).unwrap(), "润色后的日报正文");
    }

    #[test]
    fn chat_content_errors_on_empty_choices() {
        let v: serde_json::Value = serde_json::from_str(r#"{"choices":[]}"#).unwrap();
        assert!(chat_content_from_json(&v).is_err());
        let empty: serde_json::Value = serde_json::from_str(
            r#"{"choices":[{"message":{"content":"  "}}]}"#,
        )
        .unwrap();
        assert!(chat_content_from_json(&empty).is_err());
    }

    #[test]
    fn models_list_parses_openai_shape_and_sorts() {
        let v: serde_json::Value = serde_json::from_str(
            r#"{"object":"list","data":[{"id":"b-model"},{"id":"a-model"}]}"#,
        )
        .unwrap();
        assert_eq!(models_from_json(&v), vec!["a-model".to_string(), "b-model".to_string()]);
        let none: serde_json::Value = serde_json::from_str("{}").unwrap();
        assert!(models_from_json(&none).is_empty());
    }

    #[test]
    fn base_url_normalizes_trailing_slash_and_spaces() {
        assert_eq!(normalize_base_url(" https://api.x.com/v1/ "), "https://api.x.com/v1");
        assert_eq!(normalize_base_url("http://localhost:11434/v1"), "http://localhost:11434/v1");
    }

    #[test]
    fn chat_request_body_carries_model_and_messages() {
        let cfg = AiProvider {
            name: "t".into(),
            base_url: "https://api.x.com/v1".into(),
            api_key: "sk".into(),
            model: "m-1".into(),
        };
        let b = chat_request_body(&cfg, "sys", "usr");
        assert_eq!(b.get("model").and_then(|x| x.as_str()), Some("m-1"));
        let msgs = b.get("messages").and_then(|x| x.as_array()).unwrap();
        assert_eq!(msgs[0]["role"], "system");
        assert_eq!(msgs[1]["content"], "usr");
        assert_eq!(b.get("stream").and_then(|x| x.as_bool()), Some(false));
    }

    /* 端到端：本地起一个最小 OpenAI 兼容 mock，验证 URL 拼接 / 鉴权头 / 请求体 / 响应解析 */
    #[test]
    fn ai_chat_end_to_end_against_local_mock() {
        use std::io::{Read, Write};
        use std::net::TcpListener;
        let listener = TcpListener::bind("127.0.0.1:0").unwrap();
        let addr = listener.local_addr().unwrap();
        let h = std::thread::spawn(move || {
            let (mut sock, _) = listener.accept().unwrap();
            let mut buf = [0u8; 8192];
            let mut data = String::new();
            loop {
                let n = sock.read(&mut buf).unwrap();
                if n == 0 { break; }
                data.push_str(&String::from_utf8_lossy(&buf[..n]));
                let body = data.split("\r\n\r\n").nth(1).unwrap_or("");
                if data.contains("\r\n\r\n") && body.trim_end().ends_with('}') { break; }
            }
            assert!(data.starts_with("POST /v1/chat/completions "), "request line: {}", data);
            assert!(data.contains("Authorization: Bearer sk-test"), "auth header missing");
            assert!(data.contains("\"model\":\"mock-model\""));
            assert!(data.contains("\"content\":\"hi\""));
            let body = r#"{"choices":[{"message":{"role":"assistant","content":"```markdown\n## 测试通过\n```"}}]}"#;
            let resp = format!(
                "HTTP/1.1 200 OK\r\nContent-Type: application/json\r\nContent-Length: {}\r\nConnection: close\r\n\r\n{}",
                body.len(),
                body
            );
            sock.write_all(resp.as_bytes()).unwrap();
            sock.flush().unwrap();
        });
        let cfg = AiProvider {
            name: "mock".into(),
            base_url: format!("http://{}/v1", addr),
            api_key: "sk-test".into(),
            model: "mock-model".into(),
        };
        let out = ai_chat(serde_json::to_string(&cfg).unwrap(), "sys".into(), "hi".into())
            .expect("ai_chat should succeed against mock");
        h.join().unwrap();
        assert_eq!(out, "## 测试通过");
    }
}

