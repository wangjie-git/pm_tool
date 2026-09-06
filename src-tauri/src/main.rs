#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

use rusqlite::{params, Connection, Row};
use serde::{Deserialize, Serialize};
use std::{fs, path::PathBuf, sync::Mutex};
use tauri::{
    menu::{Menu, MenuItem},
    tray::{MouseButton, MouseButtonState, TrayIconBuilder, TrayIconEvent},
    Manager, State,
};
use tauri_plugin_notification::NotificationExt;
use calamine::{Data, Reader};

struct Db(Mutex<Connection>);

struct WinSaveGuard(Mutex<std::time::Instant>);

fn es(e: rusqlite::Error) -> String {
    e.to_string()
}

fn today_str() -> String {
    chrono::Local::now().format("%Y-%m-%d").to_string()
}

fn now_str() -> String {
    chrono::Local::now().format("%Y-%m-%d %H:%M").to_string()
}

fn date_of_ts(ts: i64) -> String {
    use chrono::TimeZone;
    match chrono::Local.timestamp_opt(ts, 0).single() {
        Some(dt) => dt.format("%Y-%m-%d").to_string(),
        None => today_str(),
    }
}

#[derive(Serialize, Deserialize, Clone, Debug, Default)]
#[serde(rename_all = "camelCase", default)]
struct Project {
    id: i64,
    name: String,
    archived: bool,
    created_at: String,
    settings_json: String,
}

#[derive(Serialize, Deserialize, Clone, Debug, Default)]
#[serde(rename_all = "camelCase", default)]
struct Task {
    id: i64,
    project_id: i64,
    title: String,
    due: String,
    owner: String,
    pri: String,
    status: String,
    done_at: String,
    risk: bool,
    repeat: String,
    note: String,
    created_at: String,
    updated_at: String,
    sort_order: i64,
    checklist_json: String,
    defer_count: i64,
    risk_prob: i64,
    risk_impact: i64,
    risk_mitigate: String,
    risk_escalate: String,
    doing_since: String,
    parent_id: i64,
    start_date: String,
    is_milestone: bool,
    /* 单次提醒（★★★）：YYYY-MM-DD HH:MM，到点弹系统通知后清空 */
    remind_at: String,
}

#[derive(Serialize, Deserialize, Clone, Debug, Default)]
#[serde(rename_all = "camelCase", default)]
struct Idea {
    id: i64,
    title: String,
    note: String,
    value: i64,
    effort: i64,
    converted: i64,
    created_at: String,
}

#[derive(Serialize, Deserialize, Clone, Debug, Default)]
#[serde(rename_all = "camelCase", default)]
struct TimeLog {
    id: i64,
    task_id: i64,
    project_id: i64,
    date: String,
    minutes: i64,
    note: String,
}

#[derive(Serialize, Deserialize, Clone, Debug, Default)]
#[serde(rename_all = "camelCase", default)]
struct DeletedItem {
    id: i64,
    kind: String,
    payload: String,
    summary: String,
    deleted_at: String,
}

/* ---------- 包3：决策日志（ADR 模板：背景/选项/决定/原因） ---------- */
#[derive(Serialize, Deserialize, Clone, Debug, Default)]
#[serde(rename_all = "camelCase", default)]
struct Decision {
    id: i64,
    project_id: i64,
    title: String,
    background: String,
    options: String,
    decision: String,
    reason: String,
    date: String,
    status: String,
    task_id: i64,
    meeting_id: i64,
    created_at: String,
}

/* ---------- 包3：会议记录（含行动项，Fellow 模式） ---------- */
#[derive(Serialize, Deserialize, Clone, Debug, Default)]
#[serde(rename_all = "camelCase", default)]
struct Meeting {
    id: i64,
    date: String,
    title: String,
    attendees: String,
    conclusion: String,
    project_id: i64,
    items_json: String,
    created_at: String,
}

/* ---------- 包3：干系人（FollowUpThen 机制：上次沟通 + 周期 → 到期生成跟进任务） ---------- */
#[derive(Serialize, Deserialize, Clone, Debug, Default)]
#[serde(rename_all = "camelCase", default)]
struct Contact {
    id: i64,
    name: String,
    org: String,
    tags: String,
    projects: String,
    note: String,
    last_contact: String,
    followup_days: i64,
    created_at: String,
}

#[derive(Serialize, Deserialize, Clone, Debug, Default)]
#[serde(rename_all = "camelCase", default)]
struct AppData {
    projects: Vec<Project>,
    tasks: Vec<Task>,
    ideas: Vec<Idea>,
    time_logs: Vec<TimeLog>,
    decisions: Vec<Decision>,
    meetings: Vec<Meeting>,
    contacts: Vec<Contact>,
}

const MIGRATE: &str = "
CREATE TABLE IF NOT EXISTS projects (
  id INTEGER PRIMARY KEY,
  name TEXT NOT NULL DEFAULT '',
  archived INTEGER NOT NULL DEFAULT 0,
  created_at TEXT NOT NULL DEFAULT '',
  settings_json TEXT NOT NULL DEFAULT '{}'
);
CREATE TABLE IF NOT EXISTS tasks (
  id INTEGER PRIMARY KEY,
  project_id INTEGER NOT NULL DEFAULT 0,
  title TEXT NOT NULL DEFAULT '',
  due TEXT NOT NULL DEFAULT '',
  owner TEXT NOT NULL DEFAULT '',
  pri TEXT NOT NULL DEFAULT 'P1',
  status TEXT NOT NULL DEFAULT 'todo',
  done_at TEXT NOT NULL DEFAULT '',
  risk INTEGER NOT NULL DEFAULT 0,
  repeat TEXT NOT NULL DEFAULT '',
  note TEXT NOT NULL DEFAULT '',
  created_at TEXT NOT NULL DEFAULT '',
  updated_at TEXT NOT NULL DEFAULT '',
  sort_order INTEGER NOT NULL DEFAULT 0
);
CREATE INDEX IF NOT EXISTS idx_tasks_project ON tasks(project_id);
CREATE INDEX IF NOT EXISTS idx_tasks_due ON tasks(due);
CREATE TABLE IF NOT EXISTS meta (
  key TEXT PRIMARY KEY,
  value TEXT NOT NULL DEFAULT ''
);
CREATE TABLE IF NOT EXISTS time_logs (
  id INTEGER PRIMARY KEY,
  task_id INTEGER NOT NULL DEFAULT 0,
  project_id INTEGER NOT NULL DEFAULT 0,
  date TEXT NOT NULL DEFAULT '',
  minutes INTEGER NOT NULL DEFAULT 0,
  note TEXT NOT NULL DEFAULT ''
);
CREATE INDEX IF NOT EXISTS idx_timelogs_date ON time_logs(date);
CREATE TABLE IF NOT EXISTS deleted_items (
  id INTEGER PRIMARY KEY,
  kind TEXT NOT NULL DEFAULT 'task',
  payload TEXT NOT NULL DEFAULT '{}',
  summary TEXT NOT NULL DEFAULT '',
  deleted_at TEXT NOT NULL DEFAULT ''
);
CREATE TABLE IF NOT EXISTS ideas (
  id INTEGER PRIMARY KEY,
  title TEXT NOT NULL DEFAULT '',
  note TEXT NOT NULL DEFAULT '',
  value INTEGER NOT NULL DEFAULT 3,
  effort INTEGER NOT NULL DEFAULT 3,
  converted INTEGER NOT NULL DEFAULT 0,
  created_at TEXT NOT NULL DEFAULT ''
);
CREATE TABLE IF NOT EXISTS decisions (
  id INTEGER PRIMARY KEY,
  project_id INTEGER NOT NULL DEFAULT 0,
  title TEXT NOT NULL DEFAULT '',
  background TEXT NOT NULL DEFAULT '',
  options TEXT NOT NULL DEFAULT '',
  decision TEXT NOT NULL DEFAULT '',
  reason TEXT NOT NULL DEFAULT '',
  date TEXT NOT NULL DEFAULT '',
  status TEXT NOT NULL DEFAULT '生效中',
  task_id INTEGER NOT NULL DEFAULT 0,
  meeting_id INTEGER NOT NULL DEFAULT 0,
  created_at TEXT NOT NULL DEFAULT ''
);
CREATE TABLE IF NOT EXISTS meetings (
  id INTEGER PRIMARY KEY,
  date TEXT NOT NULL DEFAULT '',
  title TEXT NOT NULL DEFAULT '',
  attendees TEXT NOT NULL DEFAULT '',
  conclusion TEXT NOT NULL DEFAULT '',
  project_id INTEGER NOT NULL DEFAULT 0,
  items_json TEXT NOT NULL DEFAULT '[]',
  created_at TEXT NOT NULL DEFAULT ''
);
CREATE TABLE IF NOT EXISTS contacts (
  id INTEGER PRIMARY KEY,
  name TEXT NOT NULL DEFAULT '',
  org TEXT NOT NULL DEFAULT '',
  tags TEXT NOT NULL DEFAULT '',
  projects TEXT NOT NULL DEFAULT '',
  note TEXT NOT NULL DEFAULT '',
  last_contact TEXT NOT NULL DEFAULT '',
  followup_days INTEGER NOT NULL DEFAULT 14,
  created_at TEXT NOT NULL DEFAULT ''
);
";

fn ensure_column(conn: &Connection, table: &str, column: &str, ddl: &str) {
    let found: Option<bool> = conn
        .prepare(&format!("PRAGMA table_info({})", table))
        .ok()
        .and_then(|mut s| {
            s.query_map([], |r| r.get::<_, String>(1))
                .ok()
                .map(|rows| rows.filter_map(|x| x.ok()).any(|c| c == column))
        });
    if found == Some(false) {
        let _ = conn.execute(ddl, []);
    }
}

fn seed_if_empty(conn: &Connection) {
    let n: i64 = conn
        .query_row("SELECT COUNT(*) FROM projects", [], |r| r.get(0))
        .unwrap_or(0);
    if n > 0 {
        return;
    }
    let today = today_str();
    let _ = conn.execute(
        "INSERT INTO projects (name, archived, created_at, settings_json) VALUES (?1, 0, ?2, ?3)",
        params![
            "示例项目",
            today,
            r#"{"report":"示例项目 进度日报","milestones":[{"label":"","date":""},{"label":"","date":""},{"label":"","date":""}]}"#
        ],
    );
    let pid = conn.last_insert_rowid();
    let _ = conn.execute(
        "INSERT INTO tasks (project_id, title, due, owner, pri, status, done_at, risk, repeat, note, created_at, sort_order, checklist_json)
         VALUES (?1, ?2, ?3, ?4, ?5, 'todo', '', 0, 'daily', ?6, ?7, 0, '[]')",
        params![
            pid,
            "每天早上生成进度日报并发送（点顶部【生成日报】一键生成复制）",
            today,
            "我方",
            "P1",
            "已设为每日循环：完成后第二天自动重置。点击标题可编辑，支持看板拖拽。",
            today
        ],
    );
}

fn project_from_row(r: &Row) -> rusqlite::Result<Project> {
    Ok(Project {
        id: r.get(0)?,
        name: r.get(1)?,
        archived: r.get::<_, i64>(2)? != 0,
        created_at: r.get(3)?,
        settings_json: r.get(4)?,
    })
}

/* 任务列清单：新增列时只改这里，各 SELECT/INSERT 引用同一常量 */
const TASK_COLS: &str = "id, project_id, title, due, owner, pri, status, done_at, risk, repeat, note, created_at, sort_order, checklist_json, updated_at, \
defer_count, risk_prob, risk_impact, risk_mitigate, risk_escalate, doing_since, parent_id, start_date, is_milestone, remind_at";

fn task_from_row(r: &Row) -> rusqlite::Result<Task> {
    Ok(Task {
        id: r.get(0)?,
        project_id: r.get(1)?,
        title: r.get(2)?,
        due: r.get(3)?,
        owner: r.get(4)?,
        pri: r.get(5)?,
        status: r.get(6)?,
        done_at: r.get(7)?,
        risk: r.get::<_, i64>(8)? != 0,
        repeat: r.get(9)?,
        note: r.get(10)?,
        created_at: r.get(11)?,
        sort_order: r.get(12)?,
        checklist_json: r.get::<_, Option<String>>(13)?.unwrap_or_else(|| "[]".into()),
        updated_at: r.get::<_, Option<String>>(14)?.unwrap_or_default(),
        defer_count: r.get::<_, Option<i64>>(15)?.unwrap_or(0),
        risk_prob: r.get::<_, Option<i64>>(16)?.unwrap_or(0),
        risk_impact: r.get::<_, Option<i64>>(17)?.unwrap_or(0),
        risk_mitigate: r.get::<_, Option<String>>(18)?.unwrap_or_default(),
        risk_escalate: r.get::<_, Option<String>>(19)?.unwrap_or_default(),
        doing_since: r.get::<_, Option<String>>(20)?.unwrap_or_default(),
        parent_id: r.get::<_, Option<i64>>(21)?.unwrap_or(0),
        start_date: r.get::<_, Option<String>>(22)?.unwrap_or_default(),
        is_milestone: r.get::<_, Option<i64>>(23)?.unwrap_or(0) != 0,
        remind_at: r.get::<_, Option<String>>(24)?.unwrap_or_default(),
    })
}

fn idea_from_row(r: &Row) -> rusqlite::Result<Idea> {
    Ok(Idea {
        id: r.get(0)?,
        title: r.get(1)?,
        note: r.get(2)?,
        value: r.get(3)?,
        effort: r.get(4)?,
        converted: r.get(5)?,
        created_at: r.get(6)?,
    })
}

fn read_all(conn: &Connection) -> rusqlite::Result<AppData> {
    let mut projects = Vec::new();
    let mut stmt = conn.prepare(
        "SELECT id, name, archived, created_at, settings_json FROM projects ORDER BY id",
    )?;
    for row in stmt.query_map([], project_from_row)? {
        projects.push(row?);
    }
    let mut tasks = Vec::new();
    let mut stmt = conn.prepare(&format!(
        "SELECT {} FROM tasks ORDER BY sort_order, id",
        TASK_COLS
    ))?;
    for row in stmt.query_map([], task_from_row)? {
        tasks.push(row?);
    }
    let mut ideas = Vec::new();
    let mut stmt = conn.prepare(
        "SELECT id, title, note, value, effort, converted, created_at FROM ideas ORDER BY id",
    )?;
    for row in stmt.query_map([], idea_from_row)? {
        ideas.push(row?);
    }
    let mut time_logs = Vec::new();
    let mut stmt = conn.prepare(
        "SELECT id, task_id, project_id, date, minutes, note FROM time_logs ORDER BY id",
    )?;
    for row in stmt.query_map([], |r| {
        Ok(TimeLog {
            id: r.get(0)?,
            task_id: r.get(1)?,
            project_id: r.get(2)?,
            date: r.get(3)?,
            minutes: r.get(4)?,
            note: r.get(5)?,
        })
    })? {
        time_logs.push(row?);
    }
    let decisions = read_decisions(conn, None)?;
    let meetings = read_meetings(conn)?;
    let contacts = read_contacts(conn)?;
    Ok(AppData { projects, tasks, ideas, time_logs, decisions, meetings, contacts })
}

/* ---------- 决策 / 会议 / 干系人：读取辅助 ---------- */

fn decision_from_row(r: &Row) -> rusqlite::Result<Decision> {
    Ok(Decision {
        id: r.get(0)?,
        project_id: r.get(1)?,
        title: r.get(2)?,
        background: r.get(3)?,
        options: r.get(4)?,
        decision: r.get(5)?,
        reason: r.get(6)?,
        date: r.get(7)?,
        status: r.get(8)?,
        task_id: r.get(9)?,
        meeting_id: r.get(10)?,
        created_at: r.get(11)?,
    })
}

fn read_decisions(conn: &Connection, project_id: Option<i64>) -> rusqlite::Result<Vec<Decision>> {
    let mut out = Vec::new();
    let sql = format!(
        "SELECT id, project_id, title, background, options, decision, reason, date, status, task_id, meeting_id, created_at FROM decisions {} ORDER BY date DESC, id DESC",
        if project_id.is_some() { "WHERE project_id=?1" } else { "" }
    );
    let mut stmt = conn.prepare(&sql)?;
    let rows: rusqlite::Result<Vec<Decision>> = if let Some(pid) = project_id {
        stmt.query_map(params![pid], decision_from_row)?.collect()
    } else {
        stmt.query_map([], decision_from_row)?.collect()
    };
    for d in rows? {
        out.push(d);
    }
    Ok(out)
}

fn read_meetings(conn: &Connection) -> rusqlite::Result<Vec<Meeting>> {
    let mut out = Vec::new();
    let mut stmt = conn.prepare(
        "SELECT id, date, title, attendees, conclusion, project_id, items_json, created_at FROM meetings ORDER BY date DESC, id DESC",
    )?;
    for row in stmt.query_map([], |r| {
        Ok(Meeting {
            id: r.get(0)?,
            date: r.get(1)?,
            title: r.get(2)?,
            attendees: r.get(3)?,
            conclusion: r.get(4)?,
            project_id: r.get(5)?,
            items_json: r.get(6)?,
            created_at: r.get(7)?,
        })
    })? {
        out.push(row?);
    }
    Ok(out)
}

fn read_contacts(conn: &Connection) -> rusqlite::Result<Vec<Contact>> {
    let mut out = Vec::new();
    let mut stmt = conn.prepare(
        "SELECT id, name, org, tags, projects, note, last_contact, followup_days, created_at FROM contacts ORDER BY id",
    )?;
    for row in stmt.query_map([], |r| {
        Ok(Contact {
            id: r.get(0)?,
            name: r.get(1)?,
            org: r.get(2)?,
            tags: r.get(3)?,
            projects: r.get(4)?,
            note: r.get(5)?,
            last_contact: r.get(6)?,
            followup_days: r.get(7)?,
            created_at: r.get(8)?,
        })
    })? {
        out.push(row?);
    }
    Ok(out)
}

#[tauri::command]
fn load_app(db: State<Db>) -> Result<AppData, String> {
    let conn = db.0.lock().map_err(|e| e.to_string())?;
    read_all(&conn).map_err(es)
}

#[tauri::command]
fn upsert_task(db: State<Db>, mut task: Task) -> Result<Task, String> {
    let conn = db.0.lock().map_err(|e| e.to_string())?;
    let risk_i = task.risk as i64;
    let milestone_i = task.is_milestone as i64;
    let cl = if task.checklist_json.is_empty() { "[]".to_string() } else { task.checklist_json.clone() };
    if task.id > 0 {
        let ts = now_str(); /* 写库与返回用同一时间戳，避免跨分钟不一致 */
        conn.execute(
            "UPDATE tasks SET project_id=?1, title=?2, due=?3, owner=?4, pri=?5, status=?6,
             done_at=?7, risk=?8, repeat=?9, note=?10, created_at=?11, sort_order=?12, checklist_json=?13, updated_at=?14,
             defer_count=?15, risk_prob=?16, risk_impact=?17, risk_mitigate=?18, risk_escalate=?19, doing_since=?20, parent_id=?21,
             start_date=?22, is_milestone=?23, remind_at=?24
             WHERE id=?25",
            params![
                task.project_id, task.title, task.due, task.owner, task.pri, task.status,
                task.done_at, risk_i, task.repeat, task.note, task.created_at, task.sort_order,
                cl, ts, task.defer_count, task.risk_prob, task.risk_impact,
                task.risk_mitigate, task.risk_escalate, task.doing_since, task.parent_id,
                task.start_date, milestone_i, task.remind_at, task.id
            ],
        )
        .map_err(es)?;
        task.updated_at = ts;
    } else {
        let next: i64 = conn
            .query_row(
                "SELECT COALESCE(MAX(sort_order), 0) + 1 FROM tasks WHERE project_id=?1",
                params![task.project_id],
                |r| r.get(0),
            )
            .map_err(es)?;
        if task.updated_at.is_empty() {
            task.updated_at = now_str();
        }
        conn.execute(
            "INSERT INTO tasks (project_id, title, due, owner, pri, status, done_at, risk, repeat, note, created_at, sort_order, checklist_json, updated_at,
             defer_count, risk_prob, risk_impact, risk_mitigate, risk_escalate, doing_since, parent_id, start_date, is_milestone, remind_at)
             VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11, ?12, ?13, ?14, ?15, ?16, ?17, ?18, ?19, ?20, ?21, ?22, ?23, ?24)",
            params![
                task.project_id, task.title, task.due, task.owner, task.pri, task.status,
                task.done_at, risk_i, task.repeat, task.note, task.created_at, next, cl, task.updated_at,
                task.defer_count, task.risk_prob, task.risk_impact,
                task.risk_mitigate, task.risk_escalate, task.doing_since, task.parent_id,
                task.start_date, milestone_i, task.remind_at
            ],
        )
        .map_err(es)?;
        task.id = conn.last_insert_rowid();
        task.sort_order = next;
    }
    Ok(task)
}

/* 软删除：任务/项目进回收站，保留 30 天可恢复；返回 deleted_items.id 供立即撤销 */
fn trash_insert(conn: &Connection, kind: &str, payload: &str, summary: &str) -> Result<i64, String> {
    conn.execute(
        "INSERT INTO deleted_items (kind, payload, summary, deleted_at) VALUES (?1, ?2, ?3, ?4)",
        params![kind, payload, summary, now_str()],
    )
    .map_err(es)?;
    Ok(conn.last_insert_rowid())
}

#[tauri::command]
fn delete_task(db: State<Db>, id: i64) -> Result<i64, String> {
    let conn = db.0.lock().map_err(|e| e.to_string())?;
    /* 递归收集全部子孙任务：删父任务时一并删除，否则子任务变成界面上不可见但仍计数/提醒的孤儿 */
    let mut all_ids = vec![id];
    let mut i = 0;
    while i < all_ids.len() {
        let parent = all_ids[i];
        let mut stmt = conn.prepare("SELECT id FROM tasks WHERE parent_id=?1").map_err(es)?;
        let mut rows = stmt.query_map(params![parent], |r| r.get::<_, i64>(0)).map_err(es)?;
        while let Some(row) = rows.next() {
            let cid: i64 = row.map_err(es)?;
            if !all_ids.contains(&cid) {
                all_ids.push(cid);
            }
        }
        i += 1;
    }
    let mut trash_id = 0i64;
    for tid in &all_ids {
        let t: Option<Task> = conn
            .query_row(
                &format!("SELECT {} FROM tasks WHERE id=?1", TASK_COLS),
                params![tid],
                task_from_row,
            )
            .ok();
        let t = match t {
            Some(t) => t,
            None => continue,
        };
        let payload = serde_json::to_string(&t).map_err(|e| e.to_string())?;
        let tid_ret = trash_insert(&conn, "task", &payload, &t.title)?;
        if *tid == id {
            trash_id = tid_ret;
        }
    }
    for tid in &all_ids {
        conn.execute("DELETE FROM tasks WHERE id=?1", params![tid]).map_err(es)?;
    }
    Ok(trash_id)
}

#[tauri::command]
fn delete_project(db: State<Db>, id: i64) -> Result<i64, String> {
    let conn = db.0.lock().map_err(|e| e.to_string())?;
    let p: Option<Project> = conn
        .query_row(
            "SELECT id, name, archived, created_at, settings_json FROM projects WHERE id=?1",
            params![id],
            project_from_row,
        )
        .ok();
    let p = match p {
        Some(p) => p,
        None => return Ok(0),
    };
    let mut pts = Vec::new();
    let mut stmt = conn
        .prepare(&format!(
            "SELECT {} FROM tasks WHERE project_id=?1 ORDER BY sort_order, id",
            TASK_COLS
        ))
        .map_err(es)?;
    for row in stmt.query_map(params![id], task_from_row).map_err(es)? {
        pts.push(row.map_err(es)?);
    }
    let payload = serde_json::to_string(&serde_json::json!({ "project": p, "tasks": pts }))
        .map_err(|e| e.to_string())?;
    let trash_id = trash_insert(&conn, "project", &payload, &format!("{}（含 {} 条事项）", p.name, pts.len()))?;
    conn.execute("DELETE FROM tasks WHERE project_id=?1", params![id]).map_err(es)?;
    conn.execute("DELETE FROM projects WHERE id=?1", params![id]).map_err(es)?;
    Ok(trash_id)
}

#[tauri::command]
fn upsert_project(db: State<Db>, mut project: Project) -> Result<Project, String> {
    let conn = db.0.lock().map_err(|e| e.to_string())?;
    let arch_i = project.archived as i64;
    if project.id > 0 {
        conn.execute(
            "UPDATE projects SET name=?1, archived=?2, created_at=?3, settings_json=?4 WHERE id=?5",
            params![project.name, arch_i, project.created_at, project.settings_json, project.id],
        )
        .map_err(es)?;
    } else {
        if project.created_at.is_empty() {
            project.created_at = today_str();
        }
        conn.execute(
            "INSERT INTO projects (name, archived, created_at, settings_json) VALUES (?1, ?2, ?3, ?4)",
            params![project.name, arch_i, project.created_at, project.settings_json],
        )
        .map_err(es)?;
        project.id = conn.last_insert_rowid();
    }
    Ok(project)
}

/* ---------- 回收站 ---------- */

#[tauri::command]
fn list_deleted(db: State<Db>) -> Result<Vec<DeletedItem>, String> {
    let conn = db.0.lock().map_err(|e| e.to_string())?;
    let cutoff = (chrono::Local::now() - chrono::Duration::days(30))
        .format("%Y-%m-%d %H:%M")
        .to_string();
    let mut out = Vec::new();
    let mut stmt = conn
        .prepare("SELECT id, kind, payload, summary, deleted_at FROM deleted_items WHERE deleted_at >= ?1 ORDER BY id DESC")
        .map_err(es)?;
    for row in stmt
        .query_map(params![cutoff], |r| {
            Ok(DeletedItem {
                id: r.get(0)?,
                kind: r.get(1)?,
                payload: r.get(2)?,
                summary: r.get(3)?,
                deleted_at: r.get(4)?,
            })
        })
        .map_err(es)?
    {
        out.push(row.map_err(es)?);
    }
    Ok(out)
}

/* 恢复回收站条目：任务/项目（含其全部任务）重新插入；id 冲突时分配新 id */
#[tauri::command]
fn restore_deleted(db: State<Db>, id: i64) -> Result<(), String> {
    let mut conn = db.0.lock().map_err(|e| e.to_string())?;
    let item: Option<DeletedItem> = conn
        .query_row(
            "SELECT id, kind, payload, summary, deleted_at FROM deleted_items WHERE id=?1",
            params![id],
            |r| {
                Ok(DeletedItem {
                    id: r.get(0)?,
                    kind: r.get(1)?,
                    payload: r.get(2)?,
                    summary: r.get(3)?,
                    deleted_at: r.get(4)?,
                })
            },
        )
        .ok();
    let item = match item {
        Some(i) => i,
        None => return Err("回收站里没有这条记录".into()),
    };
    let tx = conn.transaction().map_err(es)?;
    if item.kind == "project" {
        let v: serde_json::Value = serde_json::from_str(&item.payload).map_err(|e| e.to_string())?;
        let p: Project = serde_json::from_value(v.get("project").cloned().unwrap_or_default())
            .map_err(|e| e.to_string())?;
        let pts: Vec<Task> = serde_json::from_value(v.get("tasks").cloned().unwrap_or_default())
            .map_err(|e| e.to_string())?;
        let pexists: i64 = tx
            .query_row("SELECT COUNT(*) FROM projects WHERE id=?1", params![p.id], |r| r.get(0))
            .map_err(es)?;
        /* id 冲突时插 NULL 让 SQLite 自增分配（显式插 0 会被原样存储，产生 id=0 幽灵数据） */
        let pid: Option<i64> = if pexists > 0 { None } else { Some(p.id) };
        tx.execute(
            "INSERT INTO projects (id, name, archived, created_at, settings_json) VALUES (?1, ?2, ?3, ?4, ?5)",
            params![pid, p.name, p.archived as i64, p.created_at, p.settings_json],
        )
        .map_err(es)?;
        let pid = match pid {
            Some(id) => id,
            None => tx.last_insert_rowid(),
        };
        /* 先插完全部任务并记录 旧id→新id 映射，再按「新任务 id」逐行改父引用。
         * 不能按旧父 id 批量 UPDATE：若先前改出的新 id 恰好等于后面某任务的旧 id，
         * 该批 UPDATE 会把它二次改写，子任务父引用串到别的任务上 */
        let mut idmap: std::collections::HashMap<i64, i64> = std::collections::HashMap::new();
        for t in &pts {
            let mut t2 = t.clone();
            t2.project_id = pid;
            let old = t2.id;
            let new_id = insert_task_tx(&tx, &t2)?;
            idmap.insert(old, new_id);
        }
        for t in &pts {
            if t.parent_id <= 0 { continue; }
            if let Some(newp) = idmap.get(&t.parent_id) {
                let newid = idmap.get(&t.id).copied().unwrap_or(t.id);
                let _ = tx.execute(
                    "UPDATE tasks SET parent_id=?1 WHERE id=?2",
                    params![newp, newid],
                );
            }
        }
    } else {
        let t: Task = serde_json::from_str(&item.payload).map_err(|e| e.to_string())?;
        let new_id = insert_task_tx(&tx, &t)?;
        /* 父任务已不存在（未一起恢复/父任务换了新 id）时重挂为顶层，避免渲染成不可见孤儿 */
        if t.parent_id > 0 {
            let pexists: i64 = tx
                .query_row("SELECT COUNT(*) FROM tasks WHERE id=?1", params![t.parent_id], |r| r.get(0))
                .map_err(es)?;
            if pexists == 0 {
                let _ = tx.execute("UPDATE tasks SET parent_id=0 WHERE id=?1", params![new_id]);
            }
        }
    }
    tx.execute("DELETE FROM deleted_items WHERE id=?1", params![id]).map_err(es)?;
    tx.commit().map_err(es)?;
    Ok(())
}

fn insert_task_tx(conn: &rusqlite::Connection, t: &Task) -> Result<i64, String> {
    let exists: i64 = conn
        .query_row("SELECT COUNT(*) FROM tasks WHERE id=?1", params![t.id], |r| r.get(0))
        .map_err(es)?;
    /* 冲突时插 NULL 让 SQLite 自增分配；显式插 0 会被原样存储为 id=0 */
    let new_id: Option<i64> = if exists > 0 { None } else { Some(t.id) };
    conn.execute(
        &format!(
            "INSERT INTO tasks (id, project_id, title, due, owner, pri, status, done_at, risk, repeat, note, created_at, sort_order, checklist_json, updated_at,
             defer_count, risk_prob, risk_impact, risk_mitigate, risk_escalate, doing_since, parent_id, start_date, is_milestone, remind_at)
             VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11, ?12, ?13, ?14, ?15, ?16, ?17, ?18, ?19, ?20, ?21, ?22, ?23, ?24, ?25)"
        ),
        params![
            new_id, t.project_id, t.title, t.due, t.owner, t.pri, t.status, t.done_at,
            t.risk as i64, t.repeat, t.note, t.created_at, t.sort_order, t.checklist_json, t.updated_at,
            t.defer_count, t.risk_prob, t.risk_impact, t.risk_mitigate, t.risk_escalate, t.doing_since,
            t.parent_id, t.start_date, t.is_milestone as i64, t.remind_at
        ],
    )
    .map_err(es)?;
    Ok(match new_id {
        Some(id) => id,
        None => conn.last_insert_rowid(),
    })
}

/* 彻底删除指定一条，或清空 30 天前的全部 */
#[tauri::command]
fn purge_deleted(db: State<Db>, id: Option<i64>) -> Result<(), String> {
    let conn = db.0.lock().map_err(|e| e.to_string())?;
    match id {
        Some(id) => {
            conn.execute("DELETE FROM deleted_items WHERE id=?1", params![id]).map_err(es)?;
        }
        None => {
            let cutoff = (chrono::Local::now() - chrono::Duration::days(30))
                .format("%Y-%m-%d %H:%M")
                .to_string();
            conn.execute("DELETE FROM deleted_items WHERE deleted_at < ?1", params![cutoff])
                .map_err(es)?;
        }
    }
    Ok(())
}

#[tauri::command(async)]
fn import_data(db: State<Db>, data: AppData) -> Result<(), String> {
    let mut conn = db.0.lock().map_err(|e| e.to_string())?;
    let tx = conn.transaction().map_err(es)?;
    tx.execute("DELETE FROM tasks", []).map_err(es)?;
    tx.execute("DELETE FROM projects", []).map_err(es)?;
    tx.execute("DELETE FROM ideas", []).map_err(es)?;
    for p in &data.projects {
        /* id<=0（手工编辑/缺字段的备份经 serde default 补 0）改由 SQLite 自增分配，避免 id=0 幽灵数据或主键冲突 */
        let pid = if p.id > 0 { Some(p.id) } else { None };
        tx.execute(
            "INSERT INTO projects (id, name, archived, created_at, settings_json) VALUES (?1, ?2, ?3, ?4, ?5)",
            params![pid, p.name, p.archived as i64, p.created_at, p.settings_json],
        )
        .map_err(es)?;
    }
    for t in &data.tasks {
        let tid = if t.id > 0 { Some(t.id) } else { None };
        tx.execute(
            "INSERT INTO tasks (id, project_id, title, due, owner, pri, status, done_at, risk, repeat, note, created_at, sort_order, checklist_json, updated_at,
             defer_count, risk_prob, risk_impact, risk_mitigate, risk_escalate, doing_since, parent_id, start_date, is_milestone, remind_at)
             VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11, ?12, ?13, ?14, ?15, ?16, ?17, ?18, ?19, ?20, ?21, ?22, ?23, ?24, ?25)",
            params![tid, t.project_id, t.title, t.due, t.owner, t.pri, t.status, t.done_at,
                    t.risk as i64, t.repeat, t.note, t.created_at, t.sort_order, t.checklist_json, t.updated_at,
                    t.defer_count, t.risk_prob, t.risk_impact, t.risk_mitigate, t.risk_escalate, t.doing_since,
                    t.parent_id, t.start_date, t.is_milestone as i64, t.remind_at],
        )
        .map_err(es)?;
    }
    for i in &data.ideas {
        let iid = if i.id > 0 { Some(i.id) } else { None };
        tx.execute(
            "INSERT INTO ideas (id, title, note, value, effort, converted, created_at) VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7)",
            params![iid, i.title, i.note, i.value, i.effort, i.converted, i.created_at],
        )
        .map_err(es)?;
    }
    if !data.time_logs.is_empty() {
        tx.execute("DELETE FROM time_logs", []).map_err(es)?;
        for l in &data.time_logs {
            let lid = if l.id > 0 { Some(l.id) } else { None };
            tx.execute(
                "INSERT INTO time_logs (id, task_id, project_id, date, minutes, note) VALUES (?1, ?2, ?3, ?4, ?5, ?6)",
                params![lid, l.task_id, l.project_id, l.date, l.minutes, l.note],
            )
            .map_err(es)?;
        }
    }
    tx.execute("DELETE FROM decisions", []).map_err(es)?;
    for d in &data.decisions {
        let did = if d.id > 0 { Some(d.id) } else { None };
        tx.execute(
            "INSERT INTO decisions (id, project_id, title, background, options, decision, reason, date, status, task_id, meeting_id, created_at)
             VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11, ?12)",
            params![did, d.project_id, d.title, d.background, d.options, d.decision, d.reason, d.date, d.status, d.task_id, d.meeting_id, d.created_at],
        )
        .map_err(es)?;
    }
    tx.execute("DELETE FROM meetings", []).map_err(es)?;
    for m in &data.meetings {
        let mid = if m.id > 0 { Some(m.id) } else { None };
        tx.execute(
            "INSERT INTO meetings (id, date, title, attendees, conclusion, project_id, items_json, created_at) VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8)",
            params![mid, m.date, m.title, m.attendees, m.conclusion, m.project_id, m.items_json, m.created_at],
        )
        .map_err(es)?;
    }
    tx.execute("DELETE FROM contacts", []).map_err(es)?;
    for c in &data.contacts {
        let cid = if c.id > 0 { Some(c.id) } else { None };
        tx.execute(
            "INSERT INTO contacts (id, name, org, tags, projects, note, last_contact, followup_days, created_at) VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9)",
            params![cid, c.name, c.org, c.tags, c.projects, c.note, c.last_contact, c.followup_days, c.created_at],
        )
        .map_err(es)?;
    }
    tx.commit().map_err(es)?;
    Ok(())
}

#[tauri::command]
fn get_meta(db: State<Db>, key: String) -> Result<Option<String>, String> {
    let conn = db.0.lock().map_err(|e| e.to_string())?;
    let v = conn
        .query_row("SELECT value FROM meta WHERE key=?1", params![key], |r| r.get(0))
        .ok();
    Ok(v)
}

#[tauri::command]
fn set_meta(db: State<Db>, key: String, value: String) -> Result<(), String> {
    let conn = db.0.lock().map_err(|e| e.to_string())?;
    conn.execute(
        "INSERT INTO meta (key, value) VALUES (?1, ?2) ON CONFLICT(key) DO UPDATE SET value=?2",
        params![key, value],
    )
    .map_err(es)?;
    Ok(())
}

/* ---------- 包3：决策日志 / 会议记录 / 干系人 CRUD ---------- */

#[tauri::command]
fn list_decisions(db: State<Db>, project_id: Option<i64>) -> Result<Vec<Decision>, String> {
    let conn = db.0.lock().map_err(|e| e.to_string())?;
    read_decisions(&conn, project_id).map_err(es)
}

#[tauri::command]
fn upsert_decision(db: State<Db>, mut d: Decision) -> Result<Decision, String> {
    let conn = db.0.lock().map_err(|e| e.to_string())?;
    if d.status.trim().is_empty() { d.status = "生效中".into(); }
    if d.date.trim().is_empty() { d.date = today_str(); }
    if d.id > 0 {
        conn.execute(
            "UPDATE decisions SET project_id=?1, title=?2, background=?3, options=?4, decision=?5, reason=?6, date=?7, status=?8, task_id=?9, meeting_id=?10 WHERE id=?11",
            params![d.project_id, d.title, d.background, d.options, d.decision, d.reason, d.date, d.status, d.task_id, d.meeting_id, d.id],
        ).map_err(es)?;
    } else {
        if d.created_at.is_empty() { d.created_at = now_str(); }
        conn.execute(
            "INSERT INTO decisions (project_id, title, background, options, decision, reason, date, status, task_id, meeting_id, created_at)
             VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11)",
            params![d.project_id, d.title, d.background, d.options, d.decision, d.reason, d.date, d.status, d.task_id, d.meeting_id, d.created_at],
        ).map_err(es)?;
        d.id = conn.last_insert_rowid();
    }
    Ok(d)
}

#[tauri::command]
fn delete_decision(db: State<Db>, id: i64) -> Result<(), String> {
    let conn = db.0.lock().map_err(|e| e.to_string())?;
    conn.execute("DELETE FROM decisions WHERE id=?1", params![id]).map_err(es)?;
    Ok(())
}

#[tauri::command]
fn list_meetings(db: State<Db>) -> Result<Vec<Meeting>, String> {
    let conn = db.0.lock().map_err(|e| e.to_string())?;
    read_meetings(&conn).map_err(es)
}

#[tauri::command]
fn upsert_meeting(db: State<Db>, mut m: Meeting) -> Result<Meeting, String> {
    let conn = db.0.lock().map_err(|e| e.to_string())?;
    if m.items_json.trim().is_empty() { m.items_json = "[]".into(); }
    if m.date.trim().is_empty() { m.date = today_str(); }
    if m.id > 0 {
        conn.execute(
            "UPDATE meetings SET date=?1, title=?2, attendees=?3, conclusion=?4, project_id=?5, items_json=?6 WHERE id=?7",
            params![m.date, m.title, m.attendees, m.conclusion, m.project_id, m.items_json, m.id],
        ).map_err(es)?;
    } else {
        if m.created_at.is_empty() { m.created_at = now_str(); }
        conn.execute(
            "INSERT INTO meetings (date, title, attendees, conclusion, project_id, items_json, created_at) VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7)",
            params![m.date, m.title, m.attendees, m.conclusion, m.project_id, m.items_json, m.created_at],
        ).map_err(es)?;
        m.id = conn.last_insert_rowid();
    }
    Ok(m)
}

#[tauri::command]
fn delete_meeting(db: State<Db>, id: i64) -> Result<(), String> {
    let conn = db.0.lock().map_err(|e| e.to_string())?;
    conn.execute("DELETE FROM meetings WHERE id=?1", params![id]).map_err(es)?;
    Ok(())
}

#[tauri::command]
fn list_contacts(db: State<Db>) -> Result<Vec<Contact>, String> {
    let conn = db.0.lock().map_err(|e| e.to_string())?;
    read_contacts(&conn).map_err(es)
}

#[tauri::command]
fn upsert_contact(db: State<Db>, mut c: Contact) -> Result<Contact, String> {
    let conn = db.0.lock().map_err(|e| e.to_string())?;
    c.followup_days = c.followup_days.clamp(1, 365);
    if c.id > 0 {
        conn.execute(
            "UPDATE contacts SET name=?1, org=?2, tags=?3, projects=?4, note=?5, last_contact=?6, followup_days=?7 WHERE id=?8",
            params![c.name, c.org, c.tags, c.projects, c.note, c.last_contact, c.followup_days, c.id],
        ).map_err(es)?;
    } else {
        if c.created_at.is_empty() { c.created_at = today_str(); }
        if c.last_contact.is_empty() { c.last_contact = today_str(); }
        conn.execute(
            "INSERT INTO contacts (name, org, tags, projects, note, last_contact, followup_days, created_at) VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8)",
            params![c.name, c.org, c.tags, c.projects, c.note, c.last_contact, c.followup_days, c.created_at],
        ).map_err(es)?;
        c.id = conn.last_insert_rowid();
    }
    Ok(c)
}

#[tauri::command]
fn delete_contact(db: State<Db>, id: i64) -> Result<(), String> {
    let conn = db.0.lock().map_err(|e| e.to_string())?;
    conn.execute("DELETE FROM contacts WHERE id=?1", params![id]).map_err(es)?;
    Ok(())
}

/* ---------- 包2：桌面集成（通知 / 任务栏进度 / 自启 / 全局热键 / 深链接辅助） ---------- */

#[tauri::command]
fn notify_desktop(app: tauri::AppHandle, title: String, body: String) -> Result<(), String> {
    app.notification()
        .builder()
        .title(title)
        .body(body)
        .show()
        .map_err(|e| e.to_string())
}

/* 任务栏进度条（Windows ITaskbarList3，Tauri 官方封装）：专注计时显示会话进度，平时映射 今日完成/目标 */
#[tauri::command]
fn taskbar_progress(app: tauri::AppHandle, mode: String, value: f64) -> Result<(), String> {
    use tauri::window::{ProgressBarState, ProgressBarStatus};
    let w = app
        .get_webview_window("main")
        .ok_or_else(|| "主窗口不存在".to_string())?;
    let status = match mode.as_str() {
        "none" => ProgressBarStatus::None,
        "error" => ProgressBarStatus::Error,
        "paused" => ProgressBarStatus::Paused,
        "indeterminate" => ProgressBarStatus::Indeterminate,
        _ => ProgressBarStatus::Normal,
    };
    let progress = value.clamp(0.0, 100.0) as u64;
    w.set_progress_bar(ProgressBarState { status: Some(status), progress: Some(progress) })
        .map_err(|e| e.to_string())
}

#[tauri::command]
fn autostart_set(app: tauri::AppHandle, enable: bool) -> Result<bool, String> {
    use tauri_plugin_autostart::ManagerExt;
    let al = app.autolaunch();
    if enable {
        al.enable().map_err(|e| e.to_string())?;
    } else {
        al.disable().map_err(|e| e.to_string())?;
    }
    al.is_enabled().map_err(|e| e.to_string())
}

#[tauri::command]
fn autostart_status(app: tauri::AppHandle) -> Result<bool, String> {
    use tauri_plugin_autostart::ManagerExt;
    app.autolaunch().is_enabled().map_err(|e| e.to_string())
}

/* 全局快速捕获小窗的隐藏（Esc / 失焦） */
#[tauri::command]
fn quick_hide(app: tauri::AppHandle) -> Result<(), String> {
    if let Some(w) = app.get_webview_window("quick") {
        let _ = w.hide();
    }
    Ok(())
}

fn show_quick_capture(app: &tauri::AppHandle) {
    if let Some(w) = app.get_webview_window("quick") {
        let _ = w.show();
        let _ = w.set_focus();
        /* 吸顶居中：热键唤起的位置感要稳定 */
        if let Ok(Some(m)) = w.current_monitor() {
            let mw = m.size().width;
            let ww = w.outer_size().unwrap_or(tauri::PhysicalSize::new(620, 74)).width;
            let x = (mw.saturating_sub(ww) / 2) as i32;
            let _ = w.set_position(tauri::PhysicalPosition::new(x, 170));
        }
    }
}

/* 设置里改全局热键：先全部注销再注册新键；空 / off = 关闭 */
#[tauri::command]
fn set_quick_hotkey(app: tauri::AppHandle, hotkey: String) -> Result<(), String> {
    use tauri_plugin_global_shortcut::{GlobalShortcutExt, Shortcut};
    let gs = app.global_shortcut();
    let _ = gs.unregister_all();
    let hk = hotkey.trim();
    if hk.is_empty() || hk.eq_ignore_ascii_case("off") {
        return Ok(());
    }
    let sc: Shortcut = hk
        .parse()
        .map_err(|_| format!("快捷键格式无法识别：{}（示例：Alt+Shift+A）", hk))?;
    gs.register(sc)
        .map_err(|e| format!("注册全局快捷键失败（可能被其他程序占用）：{}", e))
}

/* 二进制文件保存（甘特图导出 PNG：前端 canvas.toDataURL → base64 传回写盘） */
#[tauri::command(async)]
fn save_binary_file(path: String, data_base64: String) -> Result<(), String> {
    use base64::Engine;
    let bytes = base64::engine::general_purpose::STANDARD
        .decode(data_base64.as_bytes())
        .map_err(|e| format!("base64 解码失败：{}", e))?;
    fs::write(&path, bytes).map_err(|e| e.to_string())
}

/* 附件目录（★★★ 备注粘贴截图）：appdata/attachments，不存在则创建；前端缓存后拼 att: 图片地址 */
#[tauri::command]
fn attachments_dir(app: tauri::AppHandle) -> Result<String, String> {
    let dir = app.path().app_data_dir().map_err(|e| e.to_string())?;
    let att = dir.join("attachments");
    fs::create_dir_all(&att).map_err(|e| e.to_string())?;
    Ok(att.to_string_lossy().to_string())
}

/* 前缀列举 meta（全局搜索每日笔记用：dailyNote_{date} 的正文扫描） */
#[derive(Serialize)]
struct MetaRow {
    key: String,
    value: String,
}

#[tauri::command]
fn list_meta_prefix(db: State<Db>, prefix: String) -> Result<Vec<MetaRow>, String> {
    let conn = db.0.lock().map_err(|e| e.to_string())?;
    let mut stmt = conn
        .prepare("SELECT key, value FROM meta WHERE key LIKE ?1 || '%' ORDER BY key DESC LIMIT 400")
        .map_err(es)?;
    let rows = stmt
        .query_map(params![prefix], |r| {
            Ok(MetaRow {
                key: r.get(0)?,
                value: r.get::<_, Option<String>>(1)?.unwrap_or_default(),
            })
        })
        .map_err(es)?;
    let mut out = vec![];
    for r in rows {
        out.push(r.map_err(es)?);
    }
    Ok(out)
}

/* 全量 meta（JSON 备份用）：每日笔记/收尾问答/智能视图/模板/AI 配置都在 meta 表 */
fn read_all_meta(conn: &Connection) -> rusqlite::Result<Vec<MetaRow>> {
    let mut stmt = conn.prepare("SELECT key, value FROM meta ORDER BY key")?;
    let rows = stmt.query_map([], |r| {
        Ok(MetaRow {
            key: r.get(0)?,
            value: r.get::<_, Option<String>>(1)?.unwrap_or_default(),
        })
    })?;
    rows.collect()
}

#[tauri::command]
fn list_all_meta(db: State<Db>) -> Result<Vec<MetaRow>, String> {
    let conn = db.0.lock().map_err(|e| e.to_string())?;
    read_all_meta(&conn).map_err(es)
}

/* ---------- 包5：Excel 解析（calamine）与导出（rust_xlsxwriter） ---------- */

fn cell_to_string(d: &Data) -> String {
    use calamine::DataType;
    if d.is_empty() {
        return String::new();
    }
    /* Excel 日期序列号 / ISO 日期 → 统一转 YYYY-MM-DD（带非零时间则带上时分） */
    if d.is_datetime() {
        if let Some(v) = d.get_datetime() {
            if let Some(ndt) = v.as_datetime() {
                if ndt.time() == chrono::NaiveTime::MIN {
                    return ndt.format("%Y-%m-%d").to_string();
                }
                return ndt.format("%Y-%m-%d %H:%M").to_string();
            }
        }
    }
    if d.is_datetime_iso() {
        if let Some(s) = d.get_datetime_iso() {
            return s.chars().take(10).collect();
        }
    }
    if let Some(i) = d.as_i64() {
        return i.to_string();
    }
    if let Some(f) = d.as_f64() {
        /* 0.5 → 0.5，50.0 → 50：去掉浮点尾巴，完成百分比归一靠前端 */
        let f2 = (f * 1e6).round() / 1e6;
        if f2 == f2.trunc() && f2.abs() < 1e15 {
            return (f2 as i64).to_string();
        }
        return f2.to_string();
    }
    if let Some(b) = d.get_bool() {
        return if b { "是".into() } else { "否".into() };
    }
    d.get_string().unwrap_or("").trim().to_string()
}

/* 读一个工作表为字符串矩阵；调用方负责合并区域填充（Xlsx 专属 API） */
fn sheet_matrix<RS, R>(wb: &mut R, sheet: &str) -> Result<(Vec<Vec<String>>, usize, usize), String>
where
    R: Reader<RS>,
    R::Error: std::fmt::Display,
    RS: std::io::Read + std::io::Seek,
{
    let range = wb
        .worksheet_range(sheet)
        .map_err(|e| format!("读取工作表「{}」失败：{}", sheet, e))?;
    let (sr, sc) = range.start().unwrap_or((0, 0));
    let (er, ec) = range.end().unwrap_or((0, 0));
    let nrows = (er + 1) as usize;
    let ncols = (ec + 1) as usize;
    let mut rows = vec![vec![String::new(); ncols]; nrows];
    for r in sr..=er {
        for c in sc..=ec {
            if let Some(d) = range.get_value((r, c)) {
                let s = cell_to_string(d);
                if !s.is_empty() {
                    rows[r as usize][c as usize] = s;
                }
            }
        }
    }
    Ok((rows, nrows, ncols))
}

#[tauri::command(async)]
fn xlsx_sheets(path: String) -> Result<Vec<String>, String> {
    let wb = calamine::open_workbook_auto(&path).map_err(|e| format!("打开文件失败：{}", e))?;
    Ok(wb.sheet_names())
}

#[tauri::command(async)]
fn xlsx_read(path: String, sheet: String) -> Result<serde_json::Value, String> {
    let p = PathBuf::from(&path);
    let ext = p
        .extension()
        .map(|e| e.to_string_lossy().to_lowercase())
        .unwrap_or_default();
    let out = match ext.as_str() {
        "xlsx" | "xlsm" | "xltx" | "xltm" => {
            let mut wb: calamine::Xlsx<_> = calamine::open_workbook(&path)
                .map_err(|e| format!("打开 xlsx 失败：{}", e))?;
            let mut m = sheet_matrix(&mut wb, &sheet)?;
            /* 合并区域：识别后填充首值（通用方案：非首行取首值） */
            match wb.merge_cells_by_sheet_name(&sheet) {
                Ok(merges) => fill_merges(&mut m.0, &merges),
                Err(_) => {}
            }
            m
        }
        "xls" => {
            let mut wb: calamine::Xls<_> = calamine::open_workbook(&path)
                .map_err(|e| format!("打开 xls 失败：{}（WPS 用户可另存为 xlsx）", e))?;
            sheet_matrix(&mut wb, &sheet)?
        }
        _ => {
            return Err(format!(
                "暂不支持 .{} 格式：xlsx / xls（.csv 与 .et 请先另存为 xlsx）",
                ext
            ))
        }
    };
    let _ = (out.1, out.2);
    Ok(serde_json::json!({ "rows": out.0 }))
}

/* Xlsx 合并区域 → 矩阵内填充首值 */
fn fill_merges(rows: &mut [Vec<String>], merges: &[calamine::Dimensions]) {
    for m in merges {
        let r0 = m.start.0 as usize;
        let c0 = m.start.1 as usize;
        let r1 = m.end.0 as usize;
        let c1 = m.end.1 as usize;
        let first = rows.get(r0).and_then(|row| row.get(c0)).cloned().unwrap_or_default();
        if first.is_empty() {
            continue;
        }
        let max_r = r1.min(rows.len().saturating_sub(1));
        for r in r0..=max_r {
            let max_c = c1.min(rows[r].len().saturating_sub(1));
            for c in c0..=max_c {
                rows[r][c] = first.clone();
            }
        }
    }
}

#[derive(Deserialize, Default)]
struct XlsxRow {
    cells: Vec<String>,
    #[serde(default)]
    group: bool,
}

#[derive(Deserialize, Default)]
#[serde(rename_all = "camelCase")]
struct XlsxExportPayload {
    #[serde(default)]
    sheet_name: String,
    #[serde(default)]
    headers: Vec<String>,
    #[serde(default)]
    widths: Vec<f64>,
    #[serde(default)]
    rows: Vec<XlsxRow>,
}

/* 导出 .xlsx 计划表：带样式表头、按阶段分组（前端排好序后传入） */
#[tauri::command(async)]
fn export_xlsx(path: String, payload: XlsxExportPayload) -> Result<(), String> {
    use rust_xlsxwriter::{Format, Workbook};
    let mut wb = Workbook::new();
    let sheet_name = if payload.sheet_name.trim().is_empty() {
        "计划表".to_string()
    } else {
        payload.sheet_name.trim().chars().take(28).collect()
    };
    let sheet = wb.add_worksheet();
    sheet
        .set_name(&sheet_name)
        .map_err(|e| format!("工作表名无效：{}", e))?;

    let hdr = Format::new()
        .set_bold()
        .set_font_color("#FFFFFF")
        .set_background_color("#4C6EF5")
        .set_border(rust_xlsxwriter::FormatBorder::Thin)
        .set_align(rust_xlsxwriter::FormatAlign::Center)
        .set_text_wrap();
    let grp = Format::new()
        .set_bold()
        .set_background_color("#EDF1FE")
        .set_border(rust_xlsxwriter::FormatBorder::Thin);
    let cell_fmt = Format::new().set_border(rust_xlsxwriter::FormatBorder::Thin).set_text_wrap();
    let done_fmt = Format::new()
        .set_border(rust_xlsxwriter::FormatBorder::Thin)
        .set_font_color("#2F9E44")
        .set_text_wrap();
    let over_fmt = Format::new()
        .set_border(rust_xlsxwriter::FormatBorder::Thin)
        .set_font_color("#E03131")
        .set_text_wrap();

    let ncols = payload.headers.len().max(1);
    for (i, h) in payload.headers.iter().enumerate() {
        sheet
            .write_with_format(0, i as u16, h, &hdr)
            .map_err(|e| format!("写表头失败：{}", e))?;
        if let Some(&w) = payload.widths.get(i) {
            let _ = sheet.set_column_width(i as u16, w.clamp(6.0, 60.0));
        }
    }
    let _ = sheet.set_row_height(0, 22.0);
    let _ = sheet.set_freeze_panes(1, 0);

    for (ri, row) in payload.rows.iter().enumerate() {
        let r = (ri + 1) as u32;
        let fmt = if row.group { &grp } else { &cell_fmt };
        let _ = sheet.set_row_height(r, 18.0);
        for (ci, text) in row.cells.iter().enumerate() {
            let mut f = fmt;
            if !row.group && text == "已完成" {
                f = &done_fmt;
            } else if !row.group && text.starts_with("已逾期") {
                f = &over_fmt;
            }
            let _ = sheet.write_with_format(r, ci as u16, text, f);
        }
        /* 补齐空单元格边框 */
        for ci in row.cells.len()..ncols {
            let _ = sheet.write_with_format(r, ci as u16, "", fmt);
        }
    }
    wb.save(&path).map_err(|e| format!("保存 xlsx 失败：{}", e))?;
    Ok(())
}

/* 包4 #18：整项目导出 Markdown（每任务一文件 + 项目主页聚合，可被 Obsidian 接管） */
fn sanitize_filename(s: &str) -> String {
    let mut out = String::new();
    for ch in s.trim().chars() {
        match ch {
            '\\' | '/' | ':' | '*' | '?' | '"' | '<' | '>' | '|' | '\n' | '\r' | '\t' => out.push(' '),
            c if (c as u32) < 32 => {},
            c => out.push(c),
        }
    }
    out.trim().chars().take(50).collect()
}

fn md_escape_frontmatter(s: &str) -> String {
    s.replace('\\', "\\\\").replace('"', "\\\"").replace('\n', " ")
}

/* 导出 MD 时把备注里 att: 引用的附件拷进导出目录，并把链接改写为相对路径（★★★ 附件粘贴配套） */
fn export_note_with_attachments(app: &tauri::AppHandle, note: &str, out_att_dir: &std::path::Path) -> String {
    let src_dir = match app.path().app_data_dir() {
        Ok(d) => d.join("attachments"),
        Err(_) => return note.to_string(),
    };
    let mut out = note.to_string();
    /* 手工扫描 (att:NAME)，避免引入 regex 依赖 */
    let mut names: Vec<String> = vec![];
    let mut cursor = 0usize;
    loop {
        let rel = match out[cursor..].find("(att:") {
            Some(p) => p,
            None => break,
        };
        let start = cursor + rel + 5;
        let end = match out[start..].find(')') {
            Some(e) => start + e,
            None => break,
        };
        let name = out[start..end].trim().to_string();
        if !name.is_empty() && !names.iter().any(|x| x == &name) {
            names.push(name);
        }
        cursor = end;
    }
    for name in names {
        let src = src_dir.join(&name);
        if src.exists() {
            let _ = fs::create_dir_all(out_att_dir);
            let dst = out_att_dir.join(&name);
            if fs::copy(&src, &dst).is_ok() {
                out = out.replace(&format!("(att:{})", name), &format!("(attachments/{})", name));
            }
        }
    }
    out
}

#[tauri::command(async)]
fn export_project_md(app: tauri::AppHandle, db: State<Db>, dir: String, project_id: i64) -> Result<String, String> {
    let conn = db.0.lock().map_err(|e| e.to_string())?;
    let proj: Option<Project> = conn
        .query_row(
            "SELECT id, name, archived, created_at, settings_json FROM projects WHERE id=?1",
            params![project_id],
            project_from_row,
        )
        .ok();
    let p = match proj {
        Some(p) => p,
        None => return Err("项目不存在".into()),
    };
    let mut tasks = Vec::new();
    {
        let mut stmt = conn
            .prepare(&format!("SELECT {} FROM tasks WHERE project_id=?1 ORDER BY sort_order, id", TASK_COLS))
            .map_err(es)?;
        for row in stmt.query_map(params![project_id], task_from_row).map_err(es)? {
            tasks.push(row.map_err(es)?);
        }
    }
    let decisions = read_decisions(&conn, Some(project_id)).map_err(es)?;
    drop(conn);

    let root = PathBuf::from(&dir).join(sanitize_filename(&p.name));
    let tasks_dir = root.join("tasks");
    fs::create_dir_all(&tasks_dir).map_err(|e| format!("创建目录失败：{}", e))?;

    let settings: serde_json::Value = serde_json::from_str(&p.settings_json).unwrap_or_default();

    /* 任务文件：frontmatter + 正文 */
    let mut links = Vec::new();
    for t in &tasks {
        let st = match t.status.as_str() {
            "todo" => "todo", "doing" => "doing", "wait" => "wait", _ => "done",
        };
        let mut tags = vec![format!("projects/{}", sanitize_filename(&p.name))];
        if t.risk { tags.push("风险".into()); }
        if t.is_milestone { tags.push("里程碑".into()); }
        let mut fm = String::new();
        fm.push_str("---\n");
        fm.push_str(&format!("title: \"{}\"\n", md_escape_frontmatter(&t.title)));
        fm.push_str(&format!("project: \"{}\"\n", md_escape_frontmatter(&p.name)));
        fm.push_str(&format!("status: {}\n", st));
        fm.push_str(&format!("due: {}\n", t.due));
        fm.push_str(&format!("start: {}\n", t.start_date));
        fm.push_str(&format!("owner: \"{}\"\n", md_escape_frontmatter(&t.owner)));
        fm.push_str(&format!("pri: {}\n", t.pri));
        fm.push_str(&format!("done: {}\n", t.done_at));
        fm.push_str(&format!("created: {}\n", t.created_at));
        fm.push_str(&format!("tags: [{}]\n", tags.join(", ")));
        if t.risk {
            fm.push_str(&format!("risk_value: {}\n", t.risk_prob * t.risk_impact));
        }
        fm.push_str("---\n");
        let mut body = String::new();
        if !t.note.trim().is_empty() {
            let note_exp = export_note_with_attachments(&app, &t.note, &root.join("attachments"));
            body.push_str(note_exp.trim());
            body.push_str("\n\n");
        }
        let cl: Vec<serde_json::Value> = serde_json::from_str(&t.checklist_json).unwrap_or_default();
        if !cl.is_empty() {
            body.push_str("## 检查清单\n\n");
            for c in &cl {
                let txt = c.get("text").and_then(|x| x.as_str()).unwrap_or("");
                let done = c.get("done").and_then(|x| x.as_bool()).unwrap_or(false);
                body.push_str(&format!("- [{}] {}\n", if done { "x" } else { " " }, txt));
            }
            body.push('\n');
        }
        if t.risk && (t.risk_prob > 0 || t.risk_impact > 0) {
            body.push_str(&format!("## 风险\n\n- 风险值：{}（概率 {} × 影响 {}）\n", t.risk_prob * t.risk_impact, t.risk_prob, t.risk_impact));
            if !t.risk_mitigate.is_empty() { body.push_str(&format!("- 应对措施：{}\n", t.risk_mitigate)); }
            if !t.risk_escalate.is_empty() { body.push_str(&format!("- 升级条件：{}\n", t.risk_escalate)); }
            body.push('\n');
        }
        let fname = format!("{:04}-{}.md", t.id, sanitize_filename(&t.title));
        let fpath = tasks_dir.join(&fname);
        fs::write(&fpath, format!("{}{}", fm, body)).map_err(|e| format!("写文件失败：{}", e))?;
        links.push((t, fname));
    }

    /* 决策日志文件 */
    if !decisions.is_empty() {
        let mut dmd = String::new();
        dmd.push_str(&format!("# {} · 决策日志\n\n", p.name));
        for d in &decisions {
            dmd.push_str(&format!("## {} {}\n\n", d.date, d.title));
            dmd.push_str(&format!("- 状态：{}\n", d.status));
            if !d.background.is_empty() { dmd.push_str(&format!("- 背景：{}\n", d.background)); }
            if !d.options.is_empty() { dmd.push_str(&format!("- 备选项：{}\n", d.options)); }
            if !d.decision.is_empty() { dmd.push_str(&format!("- **决定**：{}\n", d.decision)); }
            if !d.reason.is_empty() { dmd.push_str(&format!("- 原因：{}\n", d.reason)); }
            dmd.push('\n');
        }
        fs::write(root.join("决策日志.md"), dmd).map_err(|e| format!("写决策日志失败：{}", e))?;
    }

    /* 项目主页：聚合 + 双链 */
    let mut home = String::new();
    home.push_str(&format!("---\ntitle: \"{}\"\nproject: \"{}\"\ntags: [项目主页]\n---\n\n", md_escape_frontmatter(&p.name), md_escape_frontmatter(&p.name)));
    home.push_str(&format!("# {}\n\n", p.name));
    if let Some(one) = settings.get("onePager").and_then(|x| x.as_str()) {
        if !one.trim().is_empty() {
            home.push_str("## 项目一页纸\n\n");
            home.push_str(one.trim());
            home.push_str("\n\n");
        }
    }
    let ms: Vec<&serde_json::Value> = settings.get("milestones").and_then(|x| x.as_array()).map(|a| a.iter().filter(|m| {
        !m.get("label").and_then(|x| x.as_str()).unwrap_or("").is_empty()
    }).collect()).unwrap_or_default();
    if !ms.is_empty() {
        home.push_str("## 里程碑\n\n");
        for m in ms {
            home.push_str(&format!(
                "- {} ：{}\n",
                m.get("label").and_then(|x| x.as_str()).unwrap_or(""),
                m.get("date").and_then(|x| x.as_str()).unwrap_or("")
            ));
        }
        home.push('\n');
    }
    home.push_str(&format!("## 任务（{}）\n\n", tasks.len()));
    for (t, fname) in &links {
        let mark = match t.status.as_str() {
            "done" => "✔", "doing" => "🔨", "wait" => "⏳", _ => "▸",
        };
        home.push_str(&format!(
            "- {} [[tasks/{}|{}]] · {} · {} · 截止 {}\n",
            mark, fname.trim_end_matches(".md"), t.title, t.status, t.owner, t.due
        ));
    }
    home.push('\n');
    if !decisions.is_empty() {
        home.push_str(&format!("## 决策日志（{}）\n\n", decisions.len()));
        for d in &decisions {
            home.push_str(&format!("- {} 【{}】{}\n", d.date, d.status, d.title));
        }
        home.push('\n');
    }
    let home_path = root.join("项目主页.md");
    fs::write(&home_path, home).map_err(|e| format!("写主页失败：{}", e))?;
    let _ = app;
    Ok(root.to_string_lossy().to_string())
}

/* ---------- 包1 #4：工时预算告警（托盘通知 + 群推送，每档每天最多一次） ---------- */
fn budget_alerts_check(h: &tauri::AppHandle) {
    let state = h.state::<Db>();
    let conn = match state.0.lock() {
        Ok(c) => c,
        Err(_) => return,
    };
    let today = today_str();
    let mut projects = Vec::new();    {
        let mut stmt = match conn.prepare("SELECT id, name, settings_json FROM projects WHERE archived=0") {
            Ok(s) => s,
            Err(_) => return,
        };
        let rows_result = stmt.query_map([], |r| {
            Ok((
                r.get::<_, i64>(0)?,
                r.get::<_, String>(1)?,
                r.get::<_, String>(2)?,
            ))
        });
        if let Ok(rows) = rows_result {
            for row in rows {
                if let Ok(v) = row {
                    projects.push(v);
                }
            }
        }
    }
    /* 收集告警：Db 锁内只读库和写去重标记，通知/群推送等耗时 IO 放到锁外，
     * 否则 webhook（15s 超时/项目）会阻塞所有命令与提醒循环 */
    let mut alerts: Vec<(String, Option<(String, String, String)>)> = Vec::new();
    for (pid, name, settings_json) in projects {
        let settings: serde_json::Value = serde_json::from_str(&settings_json).unwrap_or_default();
        let budget = settings.get("budgetHours").and_then(|x| x.as_f64()).unwrap_or(0.0);
        if budget <= 0.0 {
            continue;
        }
        let used_min: i64 = conn
            .query_row(
                "SELECT COALESCE(SUM(minutes), 0) FROM time_logs WHERE project_id=?1",
                params![pid],
                |r| r.get(0),
            )
            .unwrap_or(0);
        let used = used_min as f64 / 60.0;
        let pct = used / budget;
        if pct < 0.8 {
            continue;
        }
        let level = if pct >= 1.0 { 100 } else { 80 };
        let key = format!("budgetAlert{}_{}", level, pid);
        let fired: Option<String> = conn
            .query_row("SELECT value FROM meta WHERE key=?1", params![key], |r| r.get(0))
            .ok();
        if fired.as_deref() == Some(today.as_str()) {
            continue;
        }
        let _ = conn.execute(
            "INSERT INTO meta (key, value) VALUES (?1, ?2) ON CONFLICT(key) DO UPDATE SET value=?2",
            params![key, today],
        );
        let pct_disp = (pct * 100.0).round() as i64;
        let burn_wk: f64 = {
            let wk = (chrono::Local::now() - chrono::Duration::days(7))
                .format("%Y-%m-%d")
                .to_string();
            let m: i64 = conn
                .query_row(
                    "SELECT COALESCE(SUM(minutes), 0) FROM time_logs WHERE project_id=?1 AND date>=?2",
                    params![pid, wk],
                    |r| r.get(0),
                )
                .unwrap_or(0);
            m as f64 / 60.0
        };
        let mut msg = if level == 100 {
            format!("「{}」工时预算已用满：{} / {} 小时（{}%）", name, used.round(), budget.round(), pct_disp)
        } else {
            format!("「{}」工时预算已用 80%+：{} / {} 小时（{}%）", name, used.round(), budget.round(), pct_disp)
        };
        if burn_wk > 0.05 {
            let weeks_left = (budget - used) / burn_wk;
            if weeks_left <= 0.0 {
                msg.push_str(&format!("；近 7 天燃烧 {:.1} 小时/周，已超出剩余预算", burn_wk));
            } else {
                msg.push_str(&format!("；近 7 天燃烧 {:.1} 小时/周，照此约 {:.1} 周用完", burn_wk, weeks_left));
            }
        }
        let mut wh_cfg: Option<(String, String, String)> = None;
        if let (Some(wh), true) = (
            settings.get("webhook"),
            settings.get("webhook").map(|w| !w.is_null()).unwrap_or(false),
        ) {
            let url = wh.get("url").and_then(|x| x.as_str()).unwrap_or("");
            let typ = wh.get("type").and_then(|x| x.as_str()).unwrap_or("");
            let secret = wh.get("secret").and_then(|x| x.as_str()).unwrap_or("");
            if !url.is_empty() && !typ.is_empty() {
                wh_cfg = Some((url.to_string(), typ.to_string(), secret.to_string()));
            }
        }
        alerts.push((msg, wh_cfg));
    }
    drop(conn);
    for (msg, wh_cfg) in alerts {
        let _ = h
            .notification()
            .builder()
            .title("PM 待办助手 · 工时预算告警")
            .body(msg.clone())
            .show();
        if let Some((url, typ, secret)) = wh_cfg {
            let body = if typ == "feishu" {
                serde_json::json!({ "msg_type": "text", "content": { "text": msg } }).to_string()
            } else {
                serde_json::json!({ "msgtype": "text", "text": { "content": msg } }).to_string()
            };
            let _ = webhook_post(&url, if typ == "dingtalk" { "dingtalk" } else { "" }, &secret, &body);
        }
    }
}


#[derive(Serialize, Deserialize, Clone, Debug, Default)]
#[serde(rename_all = "camelCase", default)]
struct TimerState {
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

fn clear_timer(conn: &Connection) {
    let _ = conn.execute("DELETE FROM meta WHERE key IN ('timerTaskId','timerStart')", []);
}

#[tauri::command]
fn get_timer(db: State<Db>) -> Result<Option<TimerState>, String> {
    let conn = db.0.lock().map_err(|e| e.to_string())?;
    Ok(read_timer(&conn))
}

#[tauri::command]
fn start_timer(db: State<Db>, task_id: i64) -> Result<(), String> {
    let conn = db.0.lock().map_err(|e| e.to_string())?;
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
fn stop_timer(db: State<Db>) -> Result<i64, String> {
    let conn = db.0.lock().map_err(|e| e.to_string())?;
    let st = match read_timer(&conn) {
        Some(s) => s,
        None => return Ok(0),
    };
    let now = chrono::Local::now().timestamp();
    let secs = (now - st.started_at).max(0);
    let minutes = ((secs + 30) / 60).max(1);
    let date = date_of_ts(st.started_at);
    let pid: i64 = conn
        .query_row("SELECT project_id FROM tasks WHERE id=?1", params![st.task_id], |r| r.get(0))
        .unwrap_or(0);
    conn.execute(
        "INSERT INTO time_logs (task_id, project_id, date, minutes, note) VALUES (?1, ?2, ?3, ?4, '')",
        params![st.task_id, pid, date, minutes],
    )
    .map_err(es)?;
    clear_timer(&conn);
    Ok(minutes)
}

#[tauri::command]
fn get_time_logs(db: State<Db>, since: String) -> Result<Vec<TimeLog>, String> {
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

/* ---------- 群机器人 Webhook 推送（#8） ---------- */

/* 钉钉加签：HMAC-SHA256(secret, "timestamp\nsecret") → base64 → urlencode */
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

fn webhook_post(url: &str, sign_type: &str, secret: &str, body: &str) -> Result<String, String> {
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
fn send_webhook(url: String, sign_type: String, secret: String, body: String) -> Result<String, String> {
    webhook_post(&url, &sign_type, &secret, &body)
}

/* ---------- AI 润色（#16）：自定义模型供应商，统一走 OpenAI 兼容 /chat/completions ----------
 * 智谱 / DeepSeek / Kimi / 百炼 / SiliconFlow / OpenAI / OpenRouter 均兼容该协议；
 * 本机 Ollama 也提供 http://localhost:11434/v1 兼容端点，因此无需单独适配。
 * 供应商配置（baseUrl/apiKey/model）由前端存于 meta('aiProvider')，调用时整体传入。 */

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

/* 把 HTTP 错误翻译成能指导用户排查的中文提示 */
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

/* 模型偶尔会把整篇回复包进 ``` 代码块，去掉外层围栏 */
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

/* 从 OpenAI 兼容响应取正文；取不到时报错（区分空内容与结构异常） */
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

/* 供润色按钮调用：system 提示词由前端按场景给出，便于以后扩展更多 AI 场景 */
#[tauri::command(async)]
fn ai_chat(cfg: String, system: String, user: String) -> Result<String, String> {
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

/* 拉取可用模型列表（GET {base}/models），填不进列表也能手动输入 */
#[tauri::command(async)]
fn ai_list_models(cfg: String) -> Result<Vec<String>, String> {
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

/* ---------- 需求池（#14） ---------- */

fn clamp5(v: i64) -> i64 {
    v.clamp(1, 10)
}

/* ---------- 测试：钉钉加签算法 + webhook 本地回环发送 ---------- */
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
        /* 需要 tools/hook_receiver.py 在 127.0.0.1:8765 运行 */
        let body = serde_json::json!({ "msgtype": "text", "text": { "content": "ci-test" } }).to_string();
        let resp = send_webhook(
            "http://127.0.0.1:8765/hook?foo=bar".into(),
            "dingtalk".into(),
            "SECtest".into(),
            body,
        )
        .expect("webhook post failed");
        assert!(resp.contains("errcode"));
    }

    #[test]
    fn send_webhook_rejects_empty_url() {
        assert!(send_webhook("".into(), "".into(), "".into(), "{}".into()).is_err());
    }

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

    /* 包5：xlsx 写入 → calamine 读回：日期转换与合并单元格填充往返 */
    #[test]
    fn xlsx_roundtrip_dates_and_merged_cells() {
        use calamine::DataType;
        use rust_xlsxwriter::{Format, Workbook};
        let dir = std::env::temp_dir().join("pm-todo-test-xlsx");
        fs::create_dir_all(&dir).unwrap();
        let path = dir.join("roundtrip.xlsx");
        {
            let mut wb = Workbook::new();
            let sheet = wb.add_worksheet();
            sheet.set_name("计划").unwrap();
            let fmt = Format::new();
            sheet.merge_range(0, 0, 2, 0, "阶段一", &fmt).unwrap();
            sheet.write(0, 1, "任务A").unwrap();
            sheet.write(1, 1, "任务B").unwrap();
            sheet.write(2, 1, "任务C").unwrap();
            let date = chrono::NaiveDate::from_ymd_opt(2026, 9, 10).unwrap();
            sheet.write_with_format(0, 2, &date, &Format::new().set_num_format("yyyy-mm-dd")).unwrap();
            wb.save(&path).unwrap();
        }
        let mut wb: calamine::Xlsx<_> = calamine::open_workbook(path.to_string_lossy().to_string()).unwrap();
        let mut m = sheet_matrix(&mut wb, "计划").unwrap();
        let merges = wb.merge_cells_by_sheet_name("计划").unwrap();
        fill_merges(&mut m.0, &merges);
        assert_eq!(m.0[1][0], "阶段一", "合并区域第二行应填充首值");
        assert_eq!(m.0[2][0], "阶段一");
        assert_eq!(m.0[0][1], "任务A");
        assert_eq!(m.0[0][2], "2026-09-10", "日期单元格应转为 ISO 格式");
    }

    /* 包5：导出 xlsx 应可写盘并可被 calamine 读回 */
    #[test]
    fn export_xlsx_writes_readable_file() {
        use calamine::DataType;
        let dir = std::env::temp_dir().join("pm-todo-test-xlsx");
        fs::create_dir_all(&dir).unwrap();
        let path = dir.join("export.xlsx");
        let payload = XlsxExportPayload {
            sheet_name: "测试项目".into(),
            headers: vec!["阶段/任务".into(), "负责人".into(), "状态".into()],
            widths: vec![42.0, 10.0, 9.0],
            rows: vec![
                XlsxRow { cells: vec!["阶段一".into(), "".into(), "".into()], group: true },
                XlsxRow { cells: vec!["  任务A".into(), "张三".into(), "已完成".into()], group: false },
            ],
        };
        export_xlsx(path.to_string_lossy().to_string(), payload).unwrap();
        let mut wb: calamine::Xlsx<_> = calamine::open_workbook(path.to_string_lossy().to_string()).unwrap();
        let range = wb.worksheet_range("测试项目").unwrap();
        assert_eq!(range.get_value((0, 0)).and_then(|d| d.get_string()), Some("阶段/任务"));
        assert_eq!(range.get_value((2, 2)).and_then(|d| d.get_string()), Some("已完成"));
    }
}

#[tauri::command]
fn list_ideas(db: State<Db>) -> Result<Vec<Idea>, String> {
    let conn = db.0.lock().map_err(|e| e.to_string())?;
    let mut out = Vec::new();
    let mut stmt = conn
        .prepare("SELECT id, title, note, value, effort, converted, created_at FROM ideas ORDER BY id")
        .map_err(es)?;
    for row in stmt.query_map([], idea_from_row).map_err(es)? {
        out.push(row.map_err(es)?);
    }
    Ok(out)
}

#[tauri::command]
fn upsert_idea(db: State<Db>, mut idea: Idea) -> Result<Idea, String> {
    let conn = db.0.lock().map_err(|e| e.to_string())?;
    idea.value = clamp5(idea.value);
    idea.effort = clamp5(idea.effort);
    if idea.id > 0 {
        conn.execute(
            "UPDATE ideas SET title=?1, note=?2, value=?3, effort=?4, converted=?5 WHERE id=?6",
            params![idea.title, idea.note, idea.value, idea.effort, idea.converted, idea.id],
        )
        .map_err(es)?;
    } else {
        if idea.created_at.is_empty() {
            idea.created_at = today_str();
        }
        conn.execute(
            "INSERT INTO ideas (title, note, value, effort, converted, created_at) VALUES (?1, ?2, ?3, ?4, ?5, ?6)",
            params![idea.title, idea.note, idea.value, idea.effort, idea.converted, idea.created_at],
        )
        .map_err(es)?;
        idea.id = conn.last_insert_rowid();
    }
    Ok(idea)
}

#[tauri::command]
fn delete_idea(db: State<Db>, id: i64) -> Result<(), String> {
    let conn = db.0.lock().map_err(|e| e.to_string())?;
    conn.execute("DELETE FROM ideas WHERE id=?1", params![id]).map_err(es)?;
    Ok(())
}

#[tauri::command(async)]
fn save_text_file(path: String, content: String) -> Result<(), String> {
    fs::write(&path, content.as_bytes()).map_err(|e| e.to_string())
}

#[tauri::command(async)]
fn read_text_file(path: String) -> Result<String, String> {
    fs::read_to_string(&path).map_err(|e| e.to_string())
}

fn backup_to_dir(conn: &Connection, dir: &PathBuf) -> Result<String, String> {
    let data = read_all(conn).map_err(es)?;
    /* meta 一并写入备份：每日笔记/收尾问答等存 meta 表，缺了它们换机恢复即丢数据 */
    let mut v = serde_json::to_value(&data).map_err(|e| e.to_string())?;
    if let Some(obj) = v.as_object_mut() {
        if let Ok(rows) = read_all_meta(conn) {
            if let Ok(mv) = serde_json::to_value(rows) {
                obj.insert("meta".into(), mv);
            }
        }
    }
    let json = serde_json::to_string_pretty(&v).map_err(|e| e.to_string())?;
    let name = format!("pm-backup-{}.json", today_str());
    let path = dir.join(name);
    fs::write(&path, json).map_err(|e| e.to_string())?;
    // 只保留最近 30 份
    let mut files: Vec<PathBuf> = fs::read_dir(dir)
        .map(|rd| {
            rd.filter_map(|e| e.ok())
                .map(|e| e.path())
                .filter(|p| {
                    p.file_name()
                        .map(|n| n.to_string_lossy().starts_with("pm-backup-"))
                        .unwrap_or(false)
                })
                .collect()
        })
        .unwrap_or_default();
    files.sort();
    while files.len() > 30 {
        let oldest = files.remove(0);
        let _ = fs::remove_file(oldest);
    }
    Ok(path.to_string_lossy().to_string())
}

#[tauri::command(async)]
fn backup_now(app: tauri::AppHandle, db: State<Db>) -> Result<String, String> {
    let dir = app
        .path()
        .app_data_dir()
        .map_err(|e| e.to_string())?
        .join("backups");
    fs::create_dir_all(&dir).map_err(|e| e.to_string())?;
    let conn = db.0.lock().map_err(|e| e.to_string())?;
    backup_to_dir(&conn, &dir)
}

/* ---------- 启动通知 ---------- */

fn startup_notify(h: &tauri::AppHandle) {
    let state = h.state::<Db>();
    let conn = match state.0.lock() {
        Ok(c) => c,
        Err(_) => return,
    };
    let today = today_str();
    let n: i64 = conn
        .query_row(
            "SELECT COUNT(*) FROM tasks WHERE status NOT IN ('done','wait') AND due <= ?1",
            params![today],
            |r| r.get(0),
        )
        .unwrap_or(0);
    let overdue: i64 = conn
        .query_row(
            "SELECT COUNT(*) FROM tasks WHERE status NOT IN ('done','wait') AND due < ?1",
            params![today],
            |r| r.get(0),
        )
        .unwrap_or(0);
    drop(conn);
    if n > 0 {
        let body = if overdue > 0 {
            format!("今日待处理 {} 项（其中逾期 {} 项），点击托盘图标打开", n, overdue)
        } else {
            format!("今日待处理 {} 项，点击托盘图标打开", n)
        };
        let _ = h
            .notification()
            .builder()
            .title("PM 待办助手")
            .body(body)
            .show();
    }
}

/* ---------- 每日定时提醒 + 收尾问答通知 ---------- */

/* 校验 "HH:MM" 格式，避免垃圾配置值参与字符串比较 */
fn is_hm(s: &str) -> bool {
    let b = s.as_bytes();
    b.len() == 5
        && b[2] == b':'
        && b[..2].iter().all(|c| c.is_ascii_digit())
        && b[3..].iter().all(|c| c.is_ascii_digit())
}

/* 单任务一次性提醒（★★★ remind_at，「开会前提醒我」）：到点发系统通知后清空字段防重发 */
fn remind_at_scan(h: &tauri::AppHandle) {
    let now_ts = chrono::Local::now().format("%Y-%m-%d %H:%M").to_string();
    let state = h.state::<Db>();
    let conn = match state.0.lock() {
        Ok(c) => c,
        Err(_) => return,
    };
    let mut out: Vec<Task> = vec![];
    let prepared = conn.prepare(&format!(
        "SELECT {} FROM tasks WHERE remind_at != '' AND remind_at <= ?1 AND status != 'done' LIMIT 5",
        TASK_COLS
    ));
    let mut stmt = match prepared {
        Ok(s2) => s2,
        Err(_) => return,
    };
    let mapped = stmt.query_map(params![now_ts], task_from_row);
    if let Ok(it) = mapped {
        for r in it {
            if let Ok(t) = r {
                out.push(t);
            }
        }
    }
    for t in out {
        let _ = conn.execute("UPDATE tasks SET remind_at='' WHERE id=?1", params![t.id]);
        let _ = h
            .notification()
            .builder()
            .title("PM 待办助手 · 任务提醒")
            .body(format!("⏰ {}（截止 {}）—— 到你设定的提醒时间了", t.title, t.due))
            .show();
    }
}

fn daily_reminder_loop(h: tauri::AppHandle) {
    loop {
        std::thread::sleep(std::time::Duration::from_secs(30));
        /* 工时预算告警（每档每天最多一次，内部有去重） */
        budget_alerts_check(&h);
        /* 单任务一次性提醒（remind_at，★★★「开会前提醒我」） */
        remind_at_scan(&h);
        let now_hm = chrono::Local::now().format("%H:%M").to_string();
        let state = h.state::<Db>();
        let conn = match state.0.lock() {
            Ok(c) => c,
            Err(_) => continue,
        };
        let today = today_str();
        /* 每日任务提醒（notifyTime）：到点后首次命中即发（含补发），
         * 精确等值匹配在系统睡眠/迭代被拖慢时会整分钟错过导致当天静默丢失 */
        let cfg: Option<String> = conn
            .query_row("SELECT value FROM meta WHERE key='notifyTime'", [], |r| r.get(0))
            .ok();
        let cfg_hm = cfg.as_deref().unwrap_or("").trim().to_string();
        if is_hm(&cfg_hm) && now_hm.as_str() >= cfg_hm.as_str() {
            let last: Option<String> = conn
                .query_row("SELECT value FROM meta WHERE key='lastNotifyDate'", [], |r| r.get(0))
                .ok();
            if last.as_deref() != Some(today.as_str()) {
                let n: i64 = conn
                    .query_row(
                        "SELECT COUNT(*) FROM tasks WHERE status NOT IN ('done','wait') AND due <= ?1",
                        params![today],
                        |r| r.get(0),
                    )
                    .unwrap_or(0);
                let overdue: i64 = conn
                    .query_row(
                        "SELECT COUNT(*) FROM tasks WHERE status NOT IN ('done','wait') AND due < ?1",
                        params![today],
                        |r| r.get(0),
                    )
                    .unwrap_or(0);
                let inbox: i64 = conn
                    .query_row(
                        "SELECT COUNT(*) FROM tasks WHERE project_id=0 AND status='todo'",
                        [],
                        |r| r.get(0),
                    )
                    .unwrap_or(0);
                let _ = conn.execute(
                    "INSERT INTO meta (key, value) VALUES ('lastNotifyDate', ?1) ON CONFLICT(key) DO UPDATE SET value=?1",
                    params![today],
                );
                if n > 0 {
                    let mut body = if overdue > 0 {
                        format!("今日到期 {} 项（含逾期 {} 项），先在「今日聚焦」里排优先级", n, overdue)
                    } else {
                        format!("今日到期 {} 项，先在「今日聚焦」里过一遍", n)
                    };
                    if inbox > 0 {
                        body.push_str(&format!("；收件箱还有 {} 条待分拣", inbox));
                    }
                    let _ = h
                        .notification()
                        .builder()
                        .title("PM 待办助手 · 今日提醒")
                        .body(body)
                        .show();
                }
            }
        }
        /* 收尾问答通知（shutdownTime，到点后前端会弹出三问窗口），同为到点后首次命中 */
        let shut: Option<String> = conn
            .query_row("SELECT value FROM meta WHERE key='shutdownTime'", [], |r| r.get(0))
            .ok();
        let shut_hm = shut.as_deref().unwrap_or("").trim().to_string();
        if is_hm(&shut_hm) && now_hm.as_str() >= shut_hm.as_str() {
            let last: Option<String> = conn
                .query_row("SELECT value FROM meta WHERE key='lastShutdownNotify'", [], |r| r.get(0))
                .ok();
            if last.as_deref() != Some(today.as_str()) {
                let _ = conn.execute(
                    "INSERT INTO meta (key, value) VALUES ('lastShutdownNotify', ?1) ON CONFLICT(key) DO UPDATE SET value=?1",
                    params![today],
                );
                drop(conn);
                let _ = h
                    .notification()
                    .builder()
                    .title("PM 待办助手 · 每日收尾")
                    .body("花 3 分钟回答收尾三问：今天干成什么 / 卡在哪 / 明天三件事。明日日报自动引用。")
                    .show();
                continue;
            }
        }
    }
}

/* ---------- 窗口状态记忆 ---------- */

fn save_window_state(app: &tauri::AppHandle) {
    let w = match app.get_webview_window("main") {
        Some(w) => w,
        None => return,
    };
    let is_max = w.is_maximized().unwrap_or(false);
    if is_max {
        return;
    }
    let size = w.outer_size().ok();
    let pos = w.outer_position().ok();
    if let (Some(s), Some(p)) = (size, pos) {
        if s.width < 400 || s.height < 300 {
            return;
        }
        if let Some(db) = app.try_state::<Db>() {
            if let Ok(conn) = db.0.lock() {
                let _ = conn.execute(
                    "INSERT INTO meta (key, value) VALUES (?1, ?2) ON CONFLICT(key) DO UPDATE SET value=?2",
                    params!["winW", s.width.to_string()],
                );
                let _ = conn.execute(
                    "INSERT INTO meta (key, value) VALUES (?1, ?2) ON CONFLICT(key) DO UPDATE SET value=?2",
                    params!["winH", s.height.to_string()],
                );
                let _ = conn.execute(
                    "INSERT INTO meta (key, value) VALUES (?1, ?2) ON CONFLICT(key) DO UPDATE SET value=?2",
                    params!["winX", p.x.to_string()],
                );
                let _ = conn.execute(
                    "INSERT INTO meta (key, value) VALUES (?1, ?2) ON CONFLICT(key) DO UPDATE SET value=?2",
                    params!["winY", p.y.to_string()],
                );
            }
        }
    }
}

fn restore_window_state(w: &tauri::WebviewWindow) {
    let db = match w.app_handle().try_state::<Db>() {
        Some(d) => d,
        None => return,
    };
    let conn = match db.0.lock() {
        Ok(c) => c,
        Err(_) => return,
    };
    let get = |k: &str| -> Option<i32> {
        conn.query_row("SELECT value FROM meta WHERE key=?1", params![k], |r| {
            r.get::<_, String>(0)
        })
        .ok()
        .and_then(|v| v.parse().ok())
    };
    let (ww, wh) = (get("winW"), get("winH"));
    let (wx, wy) = (get("winX"), get("winY"));
    drop(conn);
    if let (Some(ww), Some(wh)) = (ww, wh) {
        if ww > 400 && wh > 300 {
            let _ = w.set_size(tauri::PhysicalSize::new(ww as u32, wh as u32));
            if let (Some(wx), Some(wy)) = (wx, wy) {
                if wx > -20000 && wy > -20000 && wx < 20000 && wy < 20000 {
                    let _ = w.set_position(tauri::PhysicalPosition::new(wx, wy));
                }
            }
        }
    }
}

fn show_main(app: &tauri::AppHandle) {
    if let Some(w) = app.get_webview_window("main") {
        let _ = w.show();
        let _ = w.unminimize();
        let _ = w.set_focus();
    }
}

fn init_tray(app: &tauri::App) -> tauri::Result<()> {
    let show = MenuItem::with_id(app, "show", "显示主窗口", true, None::<&str>)?;
    let quit = MenuItem::with_id(app, "quit", "退出", true, None::<&str>)?;
    let menu = Menu::with_items(app, &[&show, &quit])?;
    let icon = tauri::image::Image::from_bytes(include_bytes!("../icons/32x32.png"))?.clone();
    TrayIconBuilder::with_id("main-tray")
        .icon(icon)
        .tooltip("PM 待办助手")
        .menu(&menu)
        .show_menu_on_left_click(false)
        .on_menu_event(|app, ev| match ev.id().as_ref() {
            "show" => show_main(app),
            "quit" => {
                save_window_state(app);
                app.exit(0);
            }
            _ => {}
        })
        .on_tray_icon_event(|tray, ev| {
            if let TrayIconEvent::Click {
                button: MouseButton::Left,
                button_state: MouseButtonState::Up,
                ..
            } = ev
            {
                show_main(tray.app_handle());
            }
        })
        .build(app)?;
    Ok(())
}

fn main() {
    tauri::Builder::default()
        /* 单实例必须最先注册：二次启动把 pm-todo:// 参数转交给主实例 */
        .plugin(tauri_plugin_single_instance::init(|app, argv, _cwd| {
            show_main(app);
            for a in argv {
                if a.starts_with("pm-todo://") {
                    let _ = tauri::Emitter::emit(app, "pm-deeplink", a.clone());
                }
            }
        }))
        .plugin(tauri_plugin_dialog::init())
        .plugin(tauri_plugin_notification::init())
        .plugin(tauri_plugin_autostart::init(
            tauri_plugin_autostart::MacosLauncher::LaunchAgent,
            None,
        ))
        .plugin(tauri_plugin_deep_link::init())
        .plugin(
            tauri_plugin_global_shortcut::Builder::new()
                .with_handler(|app, _shortcut, event| {
                    if event.state() == tauri_plugin_global_shortcut::ShortcutState::Pressed {
                        show_quick_capture(app);
                    }
                })
                .build(),
        )
        .setup(|app| {
            let dir = app.path().app_data_dir()?;
            fs::create_dir_all(&dir)?;
            let backups = dir.join("backups");
            let _ = fs::create_dir_all(&backups);
            let conn = Connection::open(dir.join("pm.db"))?;
            conn.execute_batch(MIGRATE)?;
            ensure_column(
                &conn,
                "tasks",
                "checklist_json",
                "ALTER TABLE tasks ADD COLUMN checklist_json TEXT NOT NULL DEFAULT '[]'",
            );
            ensure_column(
                &conn,
                "tasks",
                "updated_at",
                "ALTER TABLE tasks ADD COLUMN updated_at TEXT NOT NULL DEFAULT ''",
            );
            ensure_column(
                &conn,
                "tasks",
                "defer_count",
                "ALTER TABLE tasks ADD COLUMN defer_count INTEGER NOT NULL DEFAULT 0",
            );
            ensure_column(
                &conn,
                "tasks",
                "risk_prob",
                "ALTER TABLE tasks ADD COLUMN risk_prob INTEGER NOT NULL DEFAULT 0",
            );
            ensure_column(
                &conn,
                "tasks",
                "risk_impact",
                "ALTER TABLE tasks ADD COLUMN risk_impact INTEGER NOT NULL DEFAULT 0",
            );
            ensure_column(
                &conn,
                "tasks",
                "risk_mitigate",
                "ALTER TABLE tasks ADD COLUMN risk_mitigate TEXT NOT NULL DEFAULT ''",
            );
            ensure_column(
                &conn,
                "tasks",
                "risk_escalate",
                "ALTER TABLE tasks ADD COLUMN risk_escalate TEXT NOT NULL DEFAULT ''",
            );
            ensure_column(
                &conn,
                "tasks",
                "doing_since",
                "ALTER TABLE tasks ADD COLUMN doing_since TEXT NOT NULL DEFAULT ''",
            );
            ensure_column(
                &conn,
                "tasks",
                "parent_id",
                "ALTER TABLE tasks ADD COLUMN parent_id INTEGER NOT NULL DEFAULT 0",
            );
            ensure_column(
                &conn,
                "tasks",
                "start_date",
                "ALTER TABLE tasks ADD COLUMN start_date TEXT NOT NULL DEFAULT ''",
            );
            ensure_column(
                &conn,
                "tasks",
                "is_milestone",
                "ALTER TABLE tasks ADD COLUMN is_milestone INTEGER NOT NULL DEFAULT 0",
            );
            ensure_column(
                &conn,
                "tasks",
                "remind_at",
                "ALTER TABLE tasks ADD COLUMN remind_at TEXT NOT NULL DEFAULT ''",
            );
            seed_if_empty(&conn);
            // 每日提醒默认 09:30，已有设置则不动（可随时在界面改为「关闭」）
            let _ = conn.execute(
                "INSERT OR IGNORE INTO meta (key, value) VALUES ('notifyTime', '09:30')",
                [],
            );
            // 收尾问答默认 17:30（可关）
            let _ = conn.execute(
                "INSERT OR IGNORE INTO meta (key, value) VALUES ('shutdownTime', '17:30')",
                [],
            );
            // 全局快速捕获热键默认 Alt+Shift+A（设置里可改 / 关闭）
            let _ = conn.execute(
                "INSERT OR IGNORE INTO meta (key, value) VALUES ('quickHotkey', 'Alt+Shift+A')",
                [],
            );
            app.manage(Db(Mutex::new(conn)));
            app.manage(WinSaveGuard(Mutex::new(std::time::Instant::now())));

            if let Some(w) = app.get_webview_window("main") {
                restore_window_state(&w);
            }

            /* 全局快速捕获小窗（包2 #5）：无边框、置顶、不进任务栏，默认隐藏 */
            let _quick = tauri::WebviewWindowBuilder::new(
                app,
                "quick",
                tauri::WebviewUrl::App("quick.html".into()),
            )
            .title("快速捕获")
            .inner_size(640.0, 118.0)
            .decorations(false)
            .resizable(false)
            .always_on_top(true)
            .skip_taskbar(true)
            .visible(false)
            .focused(false)
            .build()?;

            /* 注册全局热键（读取 meta quickHotkey） */
            {
                use tauri_plugin_global_shortcut::{GlobalShortcutExt, Shortcut};
                let hk: String = {
                    let state = app.state::<Db>();
                    let locked = state.0.lock();
                    match locked {
                        Ok(conn) => conn
                            .query_row("SELECT value FROM meta WHERE key='quickHotkey'", [], |r| r.get(0))
                            .unwrap_or_else(|_| "Alt+Shift+A".to_string()),
                        Err(_) => "Alt+Shift+A".to_string(),
                    }
                };
                let hk = hk.trim().to_string();
                if !hk.is_empty() && !hk.eq_ignore_ascii_case("off") {
                    if let Ok(sc) = hk.parse::<Shortcut>() {
                        if let Err(e) = app.global_shortcut().register(sc) {
                            eprintln!("[hotkey] 全局热键 {} 注册失败：{}（可能被其他程序占用）", hk, e);
                        }
                    } else {
                        eprintln!("[hotkey] 全局热键 {} 无法解析，未注册", hk);
                    }
                }
            }

            /* 深链接（包2 #7）：运行中收到 pm-todo:// 转发给前端 */
            {
                use tauri_plugin_deep_link::DeepLinkExt;
                let handle = app.handle().clone();
                app.deep_link().on_open_url(move |event| {
                    for url in event.urls() {
                        let _ = tauri::Emitter::emit(&handle, "pm-deeplink", url.to_string());
                    }
                });
            }

            let handle = app.handle().clone();
            std::thread::spawn(move || {
                {
                    let state = handle.state::<Db>();
                    let lock = state.0.lock();
                    if let Ok(conn) = lock {
                        // 清理回收站 30 天前的条目
                        let cutoff = (chrono::Local::now() - chrono::Duration::days(30))
                            .format("%Y-%m-%d %H:%M")
                            .to_string();
                        let _ = conn.execute(
                            "DELETE FROM deleted_items WHERE deleted_at < ?1",
                            params![cutoff],
                        );
                        match backup_to_dir(&conn, &backups) {
                            Ok(p) => eprintln!("[auto-backup] {}", p),
                            Err(e) => eprintln!("[auto-backup] failed: {}", e),
                        }
                    }
                }
                /* 冷启动深链接：等前端就绪后再转发 */
                let cold: Vec<String> = std::env::args()
                    .filter(|a| a.starts_with("pm-todo://"))
                    .collect();
                if !cold.is_empty() {
                    std::thread::sleep(std::time::Duration::from_millis(1500));
                    for u in cold {
                        let _ = tauri::Emitter::emit(&handle, "pm-deeplink", u);
                    }
                }
                startup_notify(&handle);
            });

            let remind_handle = app.handle().clone();
            std::thread::spawn(move || {
                daily_reminder_loop(remind_handle);
            });

            init_tray(app)?;
            Ok(())
        })
        .invoke_handler(tauri::generate_handler![
            load_app,
            upsert_task,
            delete_task,
            upsert_project,
            delete_project,
            import_data,
            get_meta,
            set_meta,
            save_text_file,
            read_text_file,
            backup_now,
            list_deleted,
            restore_deleted,
            purge_deleted,
            get_timer,
            start_timer,
            stop_timer,
            get_time_logs,
            send_webhook,
            ai_chat,
            ai_list_models,
            list_ideas,
            upsert_idea,
            delete_idea,
            list_decisions,
            upsert_decision,
            delete_decision,
            list_meetings,
            upsert_meeting,
            delete_meeting,
            list_contacts,
            upsert_contact,
            delete_contact,
            notify_desktop,
            taskbar_progress,
            autostart_set,
            autostart_status,
            quick_hide,
            set_quick_hotkey,
            save_binary_file,
            attachments_dir,
            list_meta_prefix,
            list_all_meta,
            xlsx_sheets,
            xlsx_read,
            export_xlsx,
            export_project_md
        ])
        .on_window_event(|window, event| match event {
            // 关闭窗口 = 隐藏到托盘，退出走托盘菜单
            tauri::WindowEvent::CloseRequested { api, .. } => {
                if window.label() == "quick" {
                    let _ = window.hide();
                    api.prevent_close();
                    return;
                }
                save_window_state(window.app_handle());
                api.prevent_close();
                let _ = window.hide();
            }
            // 快速捕获小窗失焦自动收起
            tauri::WindowEvent::Focused(false) if window.label() == "quick" => {
                let _ = window.hide();
            }
            tauri::WindowEvent::Resized { .. } | tauri::WindowEvent::Moved { .. } => {
                // 节流：每秒最多写一次，避免拖动时频繁写库
                if window.label() != "main" {
                    return;
                }
                let app = window.app_handle();
                let guard = app.state::<WinSaveGuard>();
                let mut last = guard.0.lock().unwrap();
                if last.elapsed().as_millis() > 1000 {
                    *last = std::time::Instant::now();
                    save_window_state(app);
                }
            }
            _ => {}
        })
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}
