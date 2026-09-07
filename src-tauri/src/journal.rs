/* ---------- 包3：决策日志 / 会议记录 / 干系人 + 需求池（#14） ---------- */

use rusqlite::params;
use tauri::State;

use crate::{
    db::{idea_from_row, read_contacts, read_decisions, read_meetings},
    models::{Contact, Decision, Idea, Meeting},
    state::Db,
    util::{clamp5, es, now_str, today_str},
};

/* ---------- 包3：决策日志 / 会议记录 / 干系人 CRUD ---------- */

#[tauri::command]
pub fn list_decisions(db: State<Db>, project_id: Option<i64>) -> Result<Vec<Decision>, String> {
    let conn = db.0.lock().map_err(|e| e.to_string())?;
    read_decisions(&conn, project_id).map_err(es)
}

#[tauri::command]
pub fn upsert_decision(db: State<Db>, mut d: Decision) -> Result<Decision, String> {
    let conn = db.0.lock().map_err(|e| e.to_string())?;
    if d.status.trim().is_empty() { d.status = "生效中".into(); }
    if d.date.trim().is_empty() { d.date = today_str(); }
    if d.id > 0 {
        let n = conn
            .execute(
                "UPDATE decisions SET project_id=?1, title=?2, background=?3, options=?4, decision=?5, reason=?6, date=?7, status=?8, task_id=?9, meeting_id=?10 WHERE id=?11",
                params![d.project_id, d.title, d.background, d.options, d.decision, d.reason, d.date, d.status, d.task_id, d.meeting_id, d.id],
            )
            .map_err(es)?;
        if n == 0 {
            return Err("决策不存在或已被删除，保存失败".into());
        }
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
pub fn delete_decision(db: State<Db>, id: i64) -> Result<(), String> {
    let conn = db.0.lock().map_err(|e| e.to_string())?;
    conn.execute("DELETE FROM decisions WHERE id=?1", params![id]).map_err(es)?;
    Ok(())
}

#[tauri::command]
pub fn list_meetings(db: State<Db>) -> Result<Vec<Meeting>, String> {
    let conn = db.0.lock().map_err(|e| e.to_string())?;
    read_meetings(&conn).map_err(es)
}

#[tauri::command]
pub fn upsert_meeting(db: State<Db>, mut m: Meeting) -> Result<Meeting, String> {
    let conn = db.0.lock().map_err(|e| e.to_string())?;
    if m.items_json.trim().is_empty() { m.items_json = "[]".into(); }
    if m.date.trim().is_empty() { m.date = today_str(); }
    if m.id > 0 {
        let n = conn
            .execute(
                "UPDATE meetings SET date=?1, title=?2, attendees=?3, conclusion=?4, project_id=?5, items_json=?6 WHERE id=?7",
                params![m.date, m.title, m.attendees, m.conclusion, m.project_id, m.items_json, m.id],
            )
            .map_err(es)?;
        if n == 0 {
            return Err("会议不存在或已被删除，保存失败".into());
        }
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
pub fn delete_meeting(db: State<Db>, id: i64) -> Result<(), String> {
    let conn = db.0.lock().map_err(|e| e.to_string())?;
    conn.execute("DELETE FROM meetings WHERE id=?1", params![id]).map_err(es)?;
    Ok(())
}

#[tauri::command]
pub fn list_contacts(db: State<Db>) -> Result<Vec<Contact>, String> {
    let conn = db.0.lock().map_err(|e| e.to_string())?;
    read_contacts(&conn).map_err(es)
}

#[tauri::command]
pub fn upsert_contact(db: State<Db>, mut c: Contact) -> Result<Contact, String> {
    let conn = db.0.lock().map_err(|e| e.to_string())?;
    c.followup_days = c.followup_days.clamp(1, 365);
    if c.id > 0 {
        let n = conn
            .execute(
                "UPDATE contacts SET name=?1, org=?2, tags=?3, projects=?4, note=?5, last_contact=?6, followup_days=?7 WHERE id=?8",
                params![c.name, c.org, c.tags, c.projects, c.note, c.last_contact, c.followup_days, c.id],
            )
            .map_err(es)?;
        if n == 0 {
            return Err("干系人不存在或已被删除，保存失败".into());
        }
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
pub fn delete_contact(db: State<Db>, id: i64) -> Result<(), String> {
    let conn = db.0.lock().map_err(|e| e.to_string())?;
    conn.execute("DELETE FROM contacts WHERE id=?1", params![id]).map_err(es)?;
    Ok(())
}

#[tauri::command]
pub fn list_ideas(db: State<Db>) -> Result<Vec<Idea>, String> {
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
pub fn upsert_idea(db: State<Db>, mut idea: Idea) -> Result<Idea, String> {
    let conn = db.0.lock().map_err(|e| e.to_string())?;
    idea.value = clamp5(idea.value);
    idea.effort = clamp5(idea.effort);
    if idea.id > 0 {
        let n = conn
            .execute(
                "UPDATE ideas SET title=?1, note=?2, value=?3, effort=?4, converted=?5 WHERE id=?6",
                params![idea.title, idea.note, idea.value, idea.effort, idea.converted, idea.id],
            )
            .map_err(es)?;
        if n == 0 {
            return Err("需求不存在或已被删除，保存失败".into());
        }
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
pub fn delete_idea(db: State<Db>, id: i64) -> Result<(), String> {
    let conn = db.0.lock().map_err(|e| e.to_string())?;
    conn.execute("DELETE FROM ideas WHERE id=?1", params![id]).map_err(es)?;
    Ok(())
}

