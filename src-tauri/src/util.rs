/* ---------- 通用小工具：错误转字符串 / 日期 ---------- */

pub fn es(e: rusqlite::Error) -> String {
    e.to_string()
}

pub fn today_str() -> String {
    chrono::Local::now().format("%Y-%m-%d").to_string()
}

pub fn now_str() -> String {
    chrono::Local::now().format("%Y-%m-%d %H:%M").to_string()
}

pub fn date_of_ts(ts: i64) -> String {
    use chrono::TimeZone;
    match chrono::Local.timestamp_opt(ts, 0).single() {
        Some(dt) => dt.format("%Y-%m-%d").to_string(),
        None => today_str(),
    }
}

/* 需求池打分（#14）：价值/努力收敛到 1-10 */
pub fn clamp5(v: i64) -> i64 {
    v.clamp(1, 10)
}
