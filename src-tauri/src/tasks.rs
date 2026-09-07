/* ---------- 任务 / 项目 CRUD + 回收站 ---------- */

use rusqlite::{params, Connection};
use tauri::State;

use crate::{
    db::{project_from_row, task_from_row, TASK_COLS},
    models::{DeletedItem, Project, Task},
    state::Db,
    util::{es, now_str, today_str},
};

#[tauri::command]
pub fn upsert_task(db: State<Db>, mut task: Task) -> Result<Task, String> {
    let conn = db.0.lock().map_err(|e| e.to_string())?;
    let risk_i = task.risk as i64;
    let milestone_i = task.is_milestone as i64;
    let cl = if task.checklist_json.is_empty() { "[]".to_string() } else { task.checklist_json.clone() };
    if task.id > 0 {
        let ts = now_str(); /* 写库与返回用同一时间戳，避免跨分钟不一致 */
        let n = conn.execute(
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
        /* UPDATE 影响 0 行 = 任务已被删：报错而非假装保存成功，避免前端静默丢数据 */
        if n == 0 {
            return Err("任务不存在或已被删除，保存失败".into());
        }
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

pub fn delete_task_conn(conn: &mut Connection, id: i64) -> Result<i64, String> {
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
    /* 入回收站与真实删除在同一事务：任一步失败整体回滚，避免「已删但回收站没有/还在库里」的半残状态 */
    let tx = conn.transaction().map_err(es)?;
    let mut trash_id = 0i64;
    for tid in &all_ids {
        let t: Option<Task> = tx
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
        let tid_ret = trash_insert(&tx, "task", &payload, &t.title)?;
        if *tid == id {
            trash_id = tid_ret;
        }
    }
    for tid in &all_ids {
        tx.execute("DELETE FROM tasks WHERE id=?1", params![tid]).map_err(es)?;
    }
    let timer_task_id: Option<String> = tx
        .query_row(
            "SELECT value FROM meta WHERE key='timerTaskId'",
            [],
            |r| r.get(0),
        )
        .ok();
    if let Some(ref tid_str) = timer_task_id {
        if let Ok(tid_num) = tid_str.parse::<i64>() {
            if all_ids.contains(&tid_num) {
                let _ = tx.execute("DELETE FROM meta WHERE key IN ('timerTaskId', 'timerStart')", []);
            }
        }
    }
    tx.commit().map_err(es)?;
    Ok(trash_id)
}

#[tauri::command]
pub fn delete_task(db: State<Db>, id: i64) -> Result<i64, String> {
    let mut conn = db.0.lock().map_err(|e| e.to_string())?;
    delete_task_conn(&mut conn, id)
}

pub fn delete_project_conn(conn: &mut Connection, id: i64) -> Result<i64, String> {
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
    {
        let mut stmt = conn
            .prepare(&format!(
                "SELECT {} FROM tasks WHERE project_id=?1 ORDER BY sort_order, id",
                TASK_COLS
            ))
            .map_err(es)?;
        for row in stmt.query_map(params![id], task_from_row).map_err(es)? {
            pts.push(row.map_err(es)?);
        }
    }
    let payload = serde_json::to_string(&serde_json::json!({ "project": p, "tasks": pts }))
        .map_err(|e| e.to_string())?;
    let timer_task_id: Option<String> = conn
        .query_row(
            "SELECT value FROM meta WHERE key='timerTaskId'",
            [],
            |r| r.get(0),
        )
        .ok();
    let is_timing_in_proj = if let Some(ref tid_str) = timer_task_id {
        if let Ok(tid_num) = tid_str.parse::<i64>() {
            conn.query_row(
                "SELECT 1 FROM tasks WHERE id=?1 AND project_id=?2",
                params![tid_num, id],
                |_| Ok(true),
            )
            .unwrap_or(false)
        } else {
            false
        }
    } else {
        false
    };
    let tx = conn.transaction().map_err(es)?;
    let trash_id = trash_insert(&tx, "project", &payload, &format!("{}（含 {} 条事项）", p.name, pts.len()))?;
    tx.execute("DELETE FROM tasks WHERE project_id=?1", params![id]).map_err(es)?;
    tx.execute("DELETE FROM projects WHERE id=?1", params![id]).map_err(es)?;
    if is_timing_in_proj {
        let _ = tx.execute("DELETE FROM meta WHERE key IN ('timerTaskId', 'timerStart')", []);
    }
    tx.commit().map_err(es)?;
    Ok(trash_id)
}

#[tauri::command]
pub fn delete_project(db: State<Db>, id: i64) -> Result<i64, String> {
    let mut conn = db.0.lock().map_err(|e| e.to_string())?;
    delete_project_conn(&mut conn, id)
}

#[tauri::command]
pub fn upsert_project(db: State<Db>, mut project: Project) -> Result<Project, String> {
    let conn = db.0.lock().map_err(|e| e.to_string())?;
    let arch_i = project.archived as i64;
    if project.id > 0 {
        let n = conn
            .execute(
                "UPDATE projects SET name=?1, archived=?2, created_at=?3, settings_json=?4 WHERE id=?5",
                params![project.name, arch_i, project.created_at, project.settings_json, project.id],
            )
            .map_err(es)?;
        if n == 0 {
            return Err("项目不存在或已被删除，保存失败".into());
        }
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
pub fn list_deleted(db: State<Db>) -> Result<Vec<DeletedItem>, String> {
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
pub fn restore_deleted(db: State<Db>, id: i64) -> Result<(), String> {
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
pub fn purge_deleted(db: State<Db>, id: Option<i64>) -> Result<(), String> {
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

#[cfg(test)]
mod tests {
    use super::*;
    use crate::db::init_db;

    #[test]
    fn delete_task_clears_timer_when_task_is_timed() {
        let mut conn = Connection::open_in_memory().unwrap();
        init_db(&conn).unwrap();
        conn.execute("INSERT INTO tasks (id, title) VALUES (101, 'Test Task')", []).unwrap();
        conn.execute("INSERT INTO meta (key, value) VALUES ('timerTaskId', '101'), ('timerStart', '123456')", []).unwrap();

        delete_task_conn(&mut conn, 101).unwrap();

        let count: i64 = conn.query_row("SELECT COUNT(*) FROM meta WHERE key IN ('timerTaskId', 'timerStart')", [], |r| r.get(0)).unwrap();
        assert_eq!(count, 0);
    }

    #[test]
    fn delete_task_preserves_timer_when_other_task_is_timed() {
        let mut conn = Connection::open_in_memory().unwrap();
        init_db(&conn).unwrap();
        conn.execute("INSERT INTO tasks (id, title) VALUES (101, 'Task 1'), (102, 'Task 2')", []).unwrap();
        conn.execute("INSERT INTO meta (key, value) VALUES ('timerTaskId', '102'), ('timerStart', '123456')", []).unwrap();

        delete_task_conn(&mut conn, 101).unwrap();

        let count: i64 = conn.query_row("SELECT COUNT(*) FROM meta WHERE key IN ('timerTaskId', 'timerStart')", [], |r| r.get(0)).unwrap();
        assert_eq!(count, 2);
    }

    #[test]
    fn delete_project_clears_timer_when_task_in_project_is_timed() {
        let mut conn = Connection::open_in_memory().unwrap();
        init_db(&conn).unwrap();
        conn.execute("INSERT INTO projects (id, name) VALUES (5, 'Project 5')", []).unwrap();
        conn.execute("INSERT INTO tasks (id, project_id, title) VALUES (101, 5, 'Task 101')", []).unwrap();
        conn.execute("INSERT INTO meta (key, value) VALUES ('timerTaskId', '101'), ('timerStart', '123456')", []).unwrap();

        delete_project_conn(&mut conn, 5).unwrap();

        let count: i64 = conn.query_row("SELECT COUNT(*) FROM meta WHERE key IN ('timerTaskId', 'timerStart')", [], |r| r.get(0)).unwrap();
        assert_eq!(count, 0);
    }
}

