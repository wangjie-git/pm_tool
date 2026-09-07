/* ---------- 专注计时：meta 存开始状态，停表写 time_logs ---------- */

use rusqlite::{params, Connection};
use tauri::State;
use serde::{Deserialize, Serialize};

use crate::{
    models::TimeLog,
    state::Db,
    util::{date_of_ts, es},
};

#[derive(Serialize, Deserialize, Clone, Debug, Default)]
#[serde(rename_all = "camelCase", default)]
pub struct TimerState {
    task_id: i64,
    started_at: i64,
}

fn read_timer(conn: &Connection) -> Option<TimerState> {
    let tid: Option<String> = conn
        .query_row("SELECT value FROM meta WHERE key='timerTaskId'", [], |r| r.get(0))
        .ok();
    let ts: Option<String> = conn
        .query_row("SELECT value FROM meta WHERE key='timerStart'", [], |r| r.get(0))
        .ok();
    let tid = tid?.parse::<i64>().ok()?;
    let ts = ts?.parse::<i64>().ok()?;
    if tid <= 0 || ts <= 0 {
        return None;
    }
    Some(TimerState { task_id: tid, started_at: ts })
}

/* 按当前会话写一条 time_log（不足 1 分钟记 1 分钟，与 stop_timer 口径一致），返回分钟数 */
fn log_running_sessions(conn: &mut Connection) -> Result<Option<i64>, String> {
    let st = match read_timer(conn) {
        Some(s) => s,
        None => return Ok(None),
    };
    let now = chrono::Local::now().timestamp();
    let secs = (now - st.started_at).max(0);
    let minutes = ((secs + 30) / 60).max(1);
    let date = date_of_ts(st.started_at);
    let pid: i64 = conn
        .query_row("SELECT project_id FROM tasks WHERE id=?1", params![st.task_id], |r| r.get(0))
        .unwrap_or(0);
    /* 写 time_log 与清 meta 同事务：任一步失败整体回滚，避免「重复计时」或「会话丢半」 */
    let tx = conn.transaction().map_err(es)?;
    tx.execute(
        "INSERT INTO time_logs (task_id, project_id, date, minutes, note) VALUES (?1, ?2, ?3, ?4, '')",
        params![st.task_id, pid, date, minutes],
    )
    .map_err(es)?;
    tx.execute("DELETE FROM meta WHERE key IN ('timerTaskId','timerStart')", []).map_err(es)?;
    tx.commit().map_err(es)?;
    Ok(Some(minutes))
}

#[tauri::command]
pub fn get_timer(db: State<Db>) -> Result<Option<TimerState>, String> {
    let conn = db.0.lock().map_err(|e| e.to_string())?;
    Ok(read_timer(&conn))
}

#[tauri::command]
pub fn start_timer(db: State<Db>, task_id: i64) -> Result<(), String> {
    let mut conn = db.0.lock().map_err(|e| e.to_string())?;
    /* 防护：已有会话在跑时先把旧会话计时落库再切换，不静默丢弃未记录时长 */
    log_running_sessions(&mut conn)?;
    let now = chrono::Local::now().timestamp();
    for (k, v) in [("timerTaskId", task_id.to_string()), ("timerStart", now.to_string())] {
        conn.execute(
            "INSERT INTO meta (key, value) VALUES (?1, ?2) ON CONFLICT(key) DO UPDATE SET value=?2",
            params![k, v],
        )
        .map_err(es)?;
    }
    Ok(())
}

/* 停表：写入 time_logs（按开始日期归属，不足 1 分钟记 1 分钟），返回本次记录的分钟数 */
#[tauri::command]
pub fn stop_timer(db: State<Db>) -> Result<i64, String> {
    let mut conn = db.0.lock().map_err(|e| e.to_string())?;
    match log_running_sessions(&mut conn)? {
        Some(mins) => Ok(mins),
        None => Ok(0),
    }
}

#[tauri::command]
pub fn get_time_logs(db: State<Db>, since: String) -> Result<Vec<TimeLog>, String> {
    let conn = db.0.lock().map_err(|e| e.to_string())?;
    let mut out = Vec::new();
    let mut stmt = conn
        .prepare("SELECT id, task_id, project_id, date, minutes, note FROM time_logs WHERE date >= ?1 ORDER BY id")
        .map_err(es)?;
    for row in stmt
        .query_map(params![since], |r| {
            Ok(TimeLog {
                id: r.get(0)?,
                task_id: r.get(1)?,
                project_id: r.get(2)?,
                date: r.get(3)?,
                minutes: r.get(4)?,
                note: r.get(5)?,
            })
        })
        .map_err(es)?
    {
        out.push(row.map_err(es)?);
    }
    Ok(out)
}



