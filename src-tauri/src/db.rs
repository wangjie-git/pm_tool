/* ---------- 数据层：建库 / 迁移 / 全量读取 / 批量导入 / meta 表 ---------- */

use rusqlite::{params, Connection, Row};
use serde::Serialize;
use tauri::State;

use crate::{
    models::{AppData, Contact, Decision, Idea, Meeting, Project, Task, TimeLog},
    state::Db,
    util::{es, today_str},
};

pub const MIGRATE: &str = "
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

pub fn ensure_column(conn: &Connection, table: &str, column: &str, ddl: &str) {
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

pub fn init_db(conn: &Connection) -> Result<(), rusqlite::Error> {
    conn.execute_batch(MIGRATE)?;
    ensure_column(
        conn,
        "tasks",
        "checklist_json",
        "ALTER TABLE tasks ADD COLUMN checklist_json TEXT NOT NULL DEFAULT '[]'",
    );
    ensure_column(
        conn,
        "tasks",
        "updated_at",
        "ALTER TABLE tasks ADD COLUMN updated_at TEXT NOT NULL DEFAULT ''",
    );
    ensure_column(
        conn,
        "tasks",
        "defer_count",
        "ALTER TABLE tasks ADD COLUMN defer_count INTEGER NOT NULL DEFAULT 0",
    );
    ensure_column(
        conn,
        "tasks",
        "risk_prob",
        "ALTER TABLE tasks ADD COLUMN risk_prob INTEGER NOT NULL DEFAULT 0",
    );
    ensure_column(
        conn,
        "tasks",
        "risk_impact",
        "ALTER TABLE tasks ADD COLUMN risk_impact INTEGER NOT NULL DEFAULT 0",
    );
    ensure_column(
        conn,
        "tasks",
        "risk_mitigate",
        "ALTER TABLE tasks ADD COLUMN risk_mitigate TEXT NOT NULL DEFAULT ''",
    );
    ensure_column(
        conn,
        "tasks",
        "risk_escalate",
        "ALTER TABLE tasks ADD COLUMN risk_escalate TEXT NOT NULL DEFAULT ''",
    );
    ensure_column(
        conn,
        "tasks",
        "doing_since",
        "ALTER TABLE tasks ADD COLUMN doing_since TEXT NOT NULL DEFAULT ''",
    );
    ensure_column(
        conn,
        "tasks",
        "parent_id",
        "ALTER TABLE tasks ADD COLUMN parent_id INTEGER NOT NULL DEFAULT 0",
    );
    ensure_column(
        conn,
        "tasks",
        "start_date",
        "ALTER TABLE tasks ADD COLUMN start_date TEXT NOT NULL DEFAULT ''",
    );
    ensure_column(
        conn,
        "tasks",
        "is_milestone",
        "ALTER TABLE tasks ADD COLUMN is_milestone INTEGER NOT NULL DEFAULT 0",
    );
    ensure_column(
        conn,
        "tasks",
        "remind_at",
        "ALTER TABLE tasks ADD COLUMN remind_at TEXT NOT NULL DEFAULT ''",
    );
    Ok(())
}

pub fn seed_if_empty(conn: &Connection) {
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

pub fn project_from_row(r: &Row) -> rusqlite::Result<Project> {
    Ok(Project {
        id: r.get(0)?,
        name: r.get(1)?,
        archived: r.get::<_, i64>(2)? != 0,
        created_at: r.get(3)?,
        settings_json: r.get(4)?,
    })
}

/* 任务列清单：新增列时只改这里，各 SELECT/INSERT 引用同一常量 */
pub const TASK_COLS: &str = "id, project_id, title, due, owner, pri, status, done_at, risk, repeat, note, created_at, sort_order, checklist_json, updated_at, \
defer_count, risk_prob, risk_impact, risk_mitigate, risk_escalate, doing_since, parent_id, start_date, is_milestone, remind_at";

pub fn task_from_row(r: &Row) -> rusqlite::Result<Task> {
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

pub fn idea_from_row(r: &Row) -> rusqlite::Result<Idea> {
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

pub fn read_all(conn: &Connection) -> rusqlite::Result<AppData> {
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

pub fn decision_from_row(r: &Row) -> rusqlite::Result<Decision> {
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

pub fn read_decisions(conn: &Connection, project_id: Option<i64>) -> rusqlite::Result<Vec<Decision>> {
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

pub fn read_meetings(conn: &Connection) -> rusqlite::Result<Vec<Meeting>> {
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

pub fn read_contacts(conn: &Connection) -> rusqlite::Result<Vec<Contact>> {
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

/* 前缀列举 meta（全局搜索每日笔记用：dailyNote_{date} 的正文扫描） */
#[derive(Serialize)]
pub struct MetaRow {
    key: String,
    value: String,
}

/* 全量 meta（JSON 备份用）：每日笔记/收尾问答/智能视图/模板/AI 配置都在 meta 表 */
pub fn read_all_meta(conn: &Connection) -> rusqlite::Result<Vec<MetaRow>> {
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
pub fn get_meta(db: State<Db>, key: String) -> Result<Option<String>, String> {
    let conn = db.0.lock().map_err(|e| e.to_string())?;
    let v = conn
        .query_row("SELECT value FROM meta WHERE key=?1", params![key], |r| r.get(0))
        .ok();
    Ok(v)
}

#[tauri::command]
pub fn set_meta(db: State<Db>, key: String, value: String) -> Result<(), String> {
    let conn = db.0.lock().map_err(|e| e.to_string())?;
    conn.execute(
        "INSERT INTO meta (key, value) VALUES (?1, ?2) ON CONFLICT(key) DO UPDATE SET value=?2",
        params![key, value],
    )
    .map_err(es)?;
    Ok(())
}

#[tauri::command]
pub fn list_meta_prefix(db: State<Db>, prefix: String) -> Result<Vec<MetaRow>, String> {
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

#[tauri::command]
pub fn list_all_meta(db: State<Db>) -> Result<Vec<MetaRow>, String> {
    let conn = db.0.lock().map_err(|e| e.to_string())?;
    read_all_meta(&conn).map_err(es)
}

#[tauri::command]
pub fn load_app(db: State<Db>) -> Result<AppData, String> {
    let conn = db.0.lock().map_err(|e| e.to_string())?;
    read_all(&conn).map_err(es)
}

pub fn import_data_conn(conn: &mut Connection, data: &AppData) -> Result<(), String> {
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
    /* 全量替换语义：time_logs 无条件清空（旧备份/手改 JSON 缺 timeLogs 时不能残留旧工时）；
     * deleted_items 不随备份导出，同样清空，避免旧回收站恢复后在新数据里制造重复任务；
     * 计时器关联旧数据，全量导入时清除旧计时状态防僵尸计时 */
    tx.execute("DELETE FROM time_logs", []).map_err(es)?;
    tx.execute("DELETE FROM meta WHERE key IN ('timerTaskId', 'timerStart')", []).map_err(es)?;
    for l in &data.time_logs {
        let lid = if l.id > 0 { Some(l.id) } else { None };
        tx.execute(
            "INSERT INTO time_logs (id, task_id, project_id, date, minutes, note) VALUES (?1, ?2, ?3, ?4, ?5, ?6)",
            params![lid, l.task_id, l.project_id, l.date, l.minutes, l.note],
        )
        .map_err(es)?;
    }
    tx.execute("DELETE FROM deleted_items", []).map_err(es)?;
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

#[tauri::command(async)]
pub fn import_data(db: State<Db>, data: AppData) -> Result<(), String> {
    let mut conn = db.0.lock().map_err(|e| e.to_string())?;
    import_data_conn(&mut conn, &data)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn import_data_clears_timer_meta() {
        let mut conn = Connection::open_in_memory().unwrap();
        init_db(&conn).unwrap();
        conn.execute("INSERT INTO meta (key, value) VALUES ('timerTaskId', '101'), ('timerStart', '123456')", []).unwrap();

        let data = AppData {
            projects: vec![],
            tasks: vec![],
            ideas: vec![],
            time_logs: vec![],
            decisions: vec![],
            meetings: vec![],
            contacts: vec![],
        };
        import_data_conn(&mut conn, &data).unwrap();

        let count: i64 = conn.query_row("SELECT COUNT(*) FROM meta WHERE key IN ('timerTaskId', 'timerStart')", [], |r| r.get(0)).unwrap();
        assert_eq!(count, 0);
    }
}



