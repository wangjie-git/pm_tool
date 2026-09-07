#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

/* ---------- 入口：插件 / 窗口 / 托盘 / 命令注册；领域代码按模块拆分 ---------- */

mod ai;
mod db;
mod import_export;
mod journal;
mod models;
mod state;
mod system;
mod tasks;
mod timer;
mod util;
mod webhook;

use rusqlite::{params, Connection};
use std::{fs, sync::Mutex};
use tauri::Manager;

use crate::{
    db::{init_db, seed_if_empty},
    import_export::{backup_serialize, persist_backup},
    state::{Db, WinSaveGuard},
    system::{
        daily_reminder_loop, init_tray, restore_window_state, save_window_state, show_main,
        show_quick_capture, startup_notify,
    },
};

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
            init_db(&conn)?;
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
                /* 自动备份：序列化留在锁内，写盘放到锁外，避免大库启动时阻塞 UI 命令 */
                let json = {
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
                        match backup_serialize(&conn) {
                            Ok(j) => Some(j),
                            Err(e) => {
                                eprintln!("[auto-backup] failed: {}", e);
                                None
                            }
                        }
                    } else {
                        None
                    }
                };
                if let Some(json) = json {
                    match persist_backup(&backups, &json) {
                        Ok(p) => eprintln!("[auto-backup] {}", p),
                        Err(e) => eprintln!("[auto-backup] failed: {}", e),
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
            db::load_app,
            db::import_data,
            db::get_meta,
            db::set_meta,
            db::list_meta_prefix,
            db::list_all_meta,
            tasks::upsert_task,
            tasks::delete_task,
            tasks::upsert_project,
            tasks::delete_project,
            tasks::list_deleted,
            tasks::restore_deleted,
            tasks::purge_deleted,
            journal::list_decisions,
            journal::upsert_decision,
            journal::delete_decision,
            journal::list_meetings,
            journal::upsert_meeting,
            journal::delete_meeting,
            journal::list_contacts,
            journal::upsert_contact,
            journal::delete_contact,
            journal::list_ideas,
            journal::upsert_idea,
            journal::delete_idea,
            timer::get_timer,
            timer::start_timer,
            timer::stop_timer,
            timer::get_time_logs,
            webhook::send_webhook,
            ai::ai_chat,
            ai::ai_list_models,
            import_export::save_text_file,
            import_export::read_text_file,
            import_export::backup_now,
            import_export::save_binary_file,
            import_export::attachments_dir,
            import_export::xlsx_sheets,
            import_export::xlsx_read,
            import_export::export_xlsx,
            import_export::export_project_md,
            system::notify_desktop,
            system::taskbar_progress,
            system::autostart_set,
            system::autostart_status,
            system::quick_hide,
            system::set_quick_hotkey
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
                /* 窗口事件里不 unwrap：锁被污染时跳过本次保存，与其余 Db 锁风格一致 */
                let locked = guard.0.lock();
                if let Ok(mut last) = locked {
                    if last.elapsed().as_millis() > 1000 {
                        *last = std::time::Instant::now();
                        save_window_state(app);
                    }
                }
            }
            _ => {}
        })
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}
