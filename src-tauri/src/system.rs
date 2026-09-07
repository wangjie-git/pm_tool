/* ---------- 系统集成：托盘 / 通知 / 任务栏进度 / 自启 / 全局热键 / 窗口状态 / 后台提醒循环 ---------- */

use rusqlite::params;
use tauri::{
    menu::{Menu, MenuItem},
    tray::{MouseButton, MouseButtonState, TrayIconBuilder, TrayIconEvent},
    Manager,
};
use tauri_plugin_notification::NotificationExt;

use crate::{
    db::{task_from_row, TASK_COLS},
    models::Task,
    state::Db,
    util::today_str,
    webhook::webhook_post,
};

/* ---------- 包2：桌面集成（通知 / 任务栏进度 / 自启 / 全局热键 / 深链接辅助） ---------- */

#[tauri::command]
pub fn notify_desktop(app: tauri::AppHandle, title: String, body: String) -> Result<(), String> {
    app.notification()
        .builder()
        .title(title)
        .body(body)
        .show()
        .map_err(|e| e.to_string())
}

/* 任务栏进度条（Windows ITaskbarList3，Tauri 官方封装）：专注计时显示会话进度，平时映射 今日完成/目标 */
#[tauri::command]
pub fn taskbar_progress(app: tauri::AppHandle, mode: String, value: f64) -> Result<(), String> {
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
pub fn autostart_set(app: tauri::AppHandle, enable: bool) -> Result<bool, String> {
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
pub fn autostart_status(app: tauri::AppHandle) -> Result<bool, String> {
    use tauri_plugin_autostart::ManagerExt;
    app.autolaunch().is_enabled().map_err(|e| e.to_string())
}

/* 全局快速捕获小窗的隐藏（Esc / 失焦） */
#[tauri::command]
pub fn quick_hide(app: tauri::AppHandle) -> Result<(), String> {
    if let Some(w) = app.get_webview_window("quick") {
        let _ = w.hide();
    }
    Ok(())
}

pub fn show_quick_capture(app: &tauri::AppHandle) {
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

/* 设置里改全局热键：空 / off = 关闭；先校验格式再动已注册的热键，
 * 坏输入（如漏写修饰键）不应把正在使用的热键清掉 */
#[tauri::command]
pub fn set_quick_hotkey(app: tauri::AppHandle, hotkey: String) -> Result<(), String> {
    use tauri_plugin_global_shortcut::{GlobalShortcutExt, Shortcut};
    let gs = app.global_shortcut();
    let hk = hotkey.trim();
    if hk.is_empty() || hk.eq_ignore_ascii_case("off") {
        let _ = gs.unregister_all();
        return Ok(());
    }
    let sc: Shortcut = hk
        .parse()
        .map_err(|_| format!("快捷键格式无法识别：{}（示例：Alt+Shift+A）", hk))?;
    let _ = gs.unregister_all();
    gs.register(sc)
        .map_err(|e| format!("注册全局快捷键失败（可能被其他程序占用）：{}", e))
}

/* ---------- 包1 #4：工时预算告警（托盘通知 + 群推送，每档每天最多一次） ---------- */
/* 进程内已通知集合：webhook 失败重试期间不重复弹本地通知（跨进程重启会重置，可接受） */
static NOTIFIED_ALERTS: std::sync::Mutex<Vec<String>> = std::sync::Mutex::new(Vec::new());

pub fn budget_alerts_check(h: &tauri::AppHandle) {
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
    /* 收集告警：Db 锁内只读库，通知/群推送等耗时 IO 放到锁外，
     * 否则 webhook（15s 超时/项目）会阻塞所有命令与提醒循环
     * 去重标记不在锁内写：发送成功后再写，失败则下轮循环自动重试 */
    let mut alerts: Vec<(String, String, Option<(String, String, String)>)> = Vec::new();
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
        alerts.push((key, msg, wh_cfg));
    }
    drop(conn);
    for (key, msg, wh_cfg) in alerts {
        /* 本地通知：每次进程内每个 key 最多弹一次（webhook 失败重试时不刷屏） */
        if let Ok(mut done) = NOTIFIED_ALERTS.lock() {
            if !done.iter().any(|k| k == &key) {
                let _ = h
                    .notification()
                    .builder()
                    .title("PM 待办助手 · 工时预算告警")
                    .body(msg.clone())
                    .show();
                done.push(key.clone());
            }
        }
        let mut delivered = true;
        if let Some((url, typ, secret)) = wh_cfg {
            let body = if typ == "feishu" {
                serde_json::json!({ "msg_type": "text", "content": { "text": msg } }).to_string()
            } else {
                serde_json::json!({ "msgtype": "text", "text": { "content": msg } }).to_string()
            };
            if webhook_post(&url, if typ == "dingtalk" { "dingtalk" } else { "" }, &secret, &body).is_err() {
                /* 发送失败：不写去重标记，30s 后的循环会重试（本地通知已去重） */
                delivered = false;
            }
        }
        if delivered {
            if let Ok(conn) = h.state::<Db>().0.lock() {
                let _ = conn.execute(
                    "INSERT INTO meta (key, value) VALUES (?1, ?2) ON CONFLICT(key) DO UPDATE SET value=?2",
                    params![key, today],
                );
            }
        }
    }
}

/* ---------- 启动通知 ---------- */

pub fn startup_notify(h: &tauri::AppHandle) {
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
pub fn is_hm(s: &str) -> bool {
    let b = s.as_bytes();
    b.len() == 5
        && b[2] == b':'
        && b[..2].iter().all(|c| c.is_ascii_digit())
        && b[3..].iter().all(|c| c.is_ascii_digit())
}

/* 单任务一次性提醒（★★★ remind_at，「开会前提醒我」）：到点发系统通知后清空字段防重发 */
pub fn remind_at_scan(h: &tauri::AppHandle) {
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

pub fn daily_reminder_loop(h: tauri::AppHandle) {
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
                /* 仅当确实有到期任务时才写当日标记：n==0 时同日稍后新建的到期任务仍会触发提醒 */
                if n > 0 {
                    let _ = conn.execute(
                        "INSERT INTO meta (key, value) VALUES ('lastNotifyDate', ?1) ON CONFLICT(key) DO UPDATE SET value=?1",
                        params![today],
                    );
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

pub fn save_window_state(app: &tauri::AppHandle) {
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

pub fn restore_window_state(w: &tauri::WebviewWindow) {
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

pub fn show_main(app: &tauri::AppHandle) {
    if let Some(w) = app.get_webview_window("main") {
        let _ = w.show();
        let _ = w.unminimize();
        let _ = w.set_focus();
    }
}

pub fn init_tray(app: &tauri::App) -> tauri::Result<()> {
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



