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

struct Db(Mutex<Connection>);

struct WinSaveGuard(Mutex<std::time::Instant>);

fn es(e: rusqlite::Error) -> String {
    e.to_string()
}

fn today_str() -> String {
    chrono::Local::now().format("%Y-%m-%d").to_string()
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
    sort_order: i64,
    checklist_json: String,
}

#[derive(Serialize, Deserialize, Clone, Debug, Default)]
#[serde(rename_all = "camelCase", default)]
struct AppData {
    projects: Vec<Project>,
    tasks: Vec<Task>,
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
  sort_order INTEGER NOT NULL DEFAULT 0
);
CREATE INDEX IF NOT EXISTS idx_tasks_project ON tasks(project_id);
CREATE INDEX IF NOT EXISTS idx_tasks_due ON tasks(due);
CREATE TABLE IF NOT EXISTS meta (
  key TEXT PRIMARY KEY,
  value TEXT NOT NULL DEFAULT ''
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
    let mut stmt = conn.prepare(
        "SELECT id, project_id, title, due, owner, pri, status, done_at, risk, repeat, note, created_at, sort_order, checklist_json
         FROM tasks ORDER BY sort_order, id",
    )?;
    for row in stmt.query_map([], task_from_row)? {
        tasks.push(row?);
    }
    Ok(AppData { projects, tasks })
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
    let cl = if task.checklist_json.is_empty() { "[]".to_string() } else { task.checklist_json.clone() };
    if task.id > 0 {
        conn.execute(
            "UPDATE tasks SET project_id=?1, title=?2, due=?3, owner=?4, pri=?5, status=?6,
             done_at=?7, risk=?8, repeat=?9, note=?10, created_at=?11, sort_order=?12, checklist_json=?13 WHERE id=?14",
            params![
                task.project_id, task.title, task.due, task.owner, task.pri, task.status,
                task.done_at, risk_i, task.repeat, task.note, task.created_at, task.sort_order,
                cl, task.id
            ],
        )
        .map_err(es)?;
    } else {
        let next: i64 = conn
            .query_row(
                "SELECT COALESCE(MAX(sort_order), 0) + 1 FROM tasks WHERE project_id=?1",
                params![task.project_id],
                |r| r.get(0),
            )
            .map_err(es)?;
        conn.execute(
            "INSERT INTO tasks (project_id, title, due, owner, pri, status, done_at, risk, repeat, note, created_at, sort_order, checklist_json)
             VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11, ?12, ?13)",
            params![
                task.project_id, task.title, task.due, task.owner, task.pri, task.status,
                task.done_at, risk_i, task.repeat, task.note, task.created_at, next, cl
            ],
        )
        .map_err(es)?;
        task.id = conn.last_insert_rowid();
        task.sort_order = next;
    }
    Ok(task)
}

#[tauri::command]
fn delete_task(db: State<Db>, id: i64) -> Result<(), String> {
    let conn = db.0.lock().map_err(|e| e.to_string())?;
    conn.execute("DELETE FROM tasks WHERE id=?1", params![id]).map_err(es)?;
    Ok(())
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

#[tauri::command]
fn delete_project(db: State<Db>, id: i64) -> Result<(), String> {
    let conn = db.0.lock().map_err(|e| e.to_string())?;
    conn.execute("DELETE FROM tasks WHERE project_id=?1", params![id]).map_err(es)?;
    conn.execute("DELETE FROM projects WHERE id=?1", params![id]).map_err(es)?;
    Ok(())
}

#[tauri::command]
fn import_data(db: State<Db>, data: AppData) -> Result<(), String> {
    let mut conn = db.0.lock().map_err(|e| e.to_string())?;
    let tx = conn.transaction().map_err(es)?;
    tx.execute("DELETE FROM tasks", []).map_err(es)?;
    tx.execute("DELETE FROM projects", []).map_err(es)?;
    for p in &data.projects {
        tx.execute(
            "INSERT INTO projects (id, name, archived, created_at, settings_json) VALUES (?1, ?2, ?3, ?4, ?5)",
            params![p.id, p.name, p.archived as i64, p.created_at, p.settings_json],
        )
        .map_err(es)?;
    }
    for t in &data.tasks {
        tx.execute(
            "INSERT INTO tasks (id, project_id, title, due, owner, pri, status, done_at, risk, repeat, note, created_at, sort_order, checklist_json)
             VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11, ?12, ?13, ?14)",
            params![t.id, t.project_id, t.title, t.due, t.owner, t.pri, t.status, t.done_at,
                    t.risk as i64, t.repeat, t.note, t.created_at, t.sort_order, t.checklist_json],
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

#[tauri::command]
fn save_text_file(path: String, content: String) -> Result<(), String> {
    fs::write(&path, content.as_bytes()).map_err(|e| e.to_string())
}

#[tauri::command]
fn read_text_file(path: String) -> Result<String, String> {
    fs::read_to_string(&path).map_err(|e| e.to_string())
}

fn backup_to_dir(conn: &Connection, dir: &PathBuf) -> Result<String, String> {
    let data = read_all(conn).map_err(es)?;
    let name = format!("pm-backup-{}.json", today_str());
    let path = dir.join(name);
    let json = serde_json::to_string_pretty(&data).map_err(|e| e.to_string())?;
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

#[tauri::command]
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
        .plugin(tauri_plugin_dialog::init())
        .plugin(tauri_plugin_notification::init())
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
            seed_if_empty(&conn);
            app.manage(Db(Mutex::new(conn)));
            app.manage(WinSaveGuard(Mutex::new(std::time::Instant::now())));

            if let Some(w) = app.get_webview_window("main") {
                restore_window_state(&w);
            }

            let handle = app.handle().clone();
            std::thread::spawn(move || {
                {
                    let state = handle.state::<Db>();
                    let lock = state.0.lock();
                    if let Ok(conn) = lock {
                        match backup_to_dir(&conn, &backups) {
                            Ok(p) => eprintln!("[auto-backup] {}", p),
                            Err(e) => eprintln!("[auto-backup] failed: {}", e),
                        }
                    }
                }
                startup_notify(&handle);
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
            backup_now
        ])
        .on_window_event(|window, event| match event {
            // 关闭窗口 = 隐藏到托盘，退出走托盘菜单
            tauri::WindowEvent::CloseRequested { api, .. } => {
                save_window_state(window.app_handle());
                api.prevent_close();
                let _ = window.hide();
            }
            tauri::WindowEvent::Resized { .. } | tauri::WindowEvent::Moved { .. } => {
                // 节流：每秒最多写一次，避免拖动时频繁写库
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
