/* ---------- 导入导出：Excel（calamine/rust_xlsxwriter）/ Markdown / 备份 / 附件 / 文本文件 ---------- */

use calamine::{Data, Reader};
use rusqlite::{params, Connection};
use serde::Deserialize;
use std::{fs, path::PathBuf};
use tauri::{Manager, State};

use crate::{
    db::{project_from_row, read_all, read_all_meta, read_decisions, task_from_row, TASK_COLS},
    models::Project,
    state::Db,
    util::es,
};

/* 二进制文件保存（甘特图导出 PNG：前端 canvas.toDataURL → base64 传回写盘） */
#[tauri::command(async)]
pub fn save_binary_file(path: String, data_base64: String) -> Result<(), String> {
    use base64::Engine;
    let bytes = base64::engine::general_purpose::STANDARD
        .decode(data_base64.as_bytes())
        .map_err(|e| format!("base64 解码失败：{}", e))?;
    fs::write(&path, bytes).map_err(|e| e.to_string())
}

/* 附件目录（★★★ 备注粘贴截图）：appdata/attachments，不存在则创建；前端缓存后拼 att: 图片地址 */
#[tauri::command]
pub fn attachments_dir(app: tauri::AppHandle) -> Result<String, String> {
    let dir = app.path().app_data_dir().map_err(|e| e.to_string())?;
    let att = dir.join("attachments");
    fs::create_dir_all(&att).map_err(|e| e.to_string())?;
    Ok(att.to_string_lossy().to_string())
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
    /* 防 OOM：按绝对边界分配的稠密矩阵，对伪造/误按 Ctrl+End 拉出的超大 dimension（上限 1048576×16384）
     * 会一次性分配数百 GB 直接把应用 abort 掉。超过上限返回可读错误，不进入分配。 */
    const MAX_CELLS: usize = 1_000_000;
    if nrows.saturating_mul(ncols) > MAX_CELLS {
        return Err(format!(
            "工作表「{}」尺寸过大（{} 行 × {} 列 ≈ {} 单元格，上限 {}），请先精简数据或另存小表",
            sheet, nrows, ncols, nrows.saturating_mul(ncols), MAX_CELLS
        ));
    }
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
pub fn xlsx_sheets(path: String) -> Result<Vec<String>, String> {
    let wb = calamine::open_workbook_auto(&path).map_err(|e| format!("打开文件失败：{}", e))?;
    Ok(wb.sheet_names())
}

#[tauri::command(async)]
pub fn xlsx_read(path: String, sheet: String) -> Result<serde_json::Value, String> {
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
pub struct XlsxRow {
    cells: Vec<String>,
    #[serde(default)]
    group: bool,
}

#[derive(Deserialize, Default)]
#[serde(rename_all = "camelCase")]
pub struct XlsxExportPayload {
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
pub fn export_xlsx(path: String, payload: XlsxExportPayload) -> Result<(), String> {
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
        /* 附件名必须是纯文件名：拒绝路径分隔符/冒号/..，防止 (att:..\..\x) 从附件目录外读、向外写 */
        let is_bare = !name.is_empty()
            && name != "."
            && name != ".."
            && !name.starts_with("..")
            && !name.contains('/')
            && !name.contains('\\')
            && !name.contains(':')
            && !name.contains('\0');
        if !is_bare {
            continue;
        }
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
pub fn export_project_md(app: tauri::AppHandle, db: State<Db>, dir: String, project_id: i64) -> Result<String, String> {
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

#[tauri::command(async)]
pub fn save_text_file(path: String, content: String) -> Result<(), String> {
    fs::write(&path, content.as_bytes()).map_err(|e| e.to_string())
}

#[tauri::command(async)]
pub fn read_text_file(path: String) -> Result<String, String> {
    fs::read_to_string(&path).map_err(|e| e.to_string())
}

/* 锁内轻量步骤：全量读 + 序列化（不触碰文件系统，避免备份写盘占用 Db 锁阻塞 UI 命令） */
pub fn backup_serialize(conn: &Connection) -> Result<String, String> {
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
    serde_json::to_string_pretty(&v).map_err(|e| e.to_string())
}

/* 锁外步骤：写盘 + 保留最近 30 份（耗时 IO 不占 Db 锁；main.rs 启动自动备份同样走这里） */
pub fn persist_backup(dir: &PathBuf, json: &str) -> Result<String, String> {
    /* 文件名带到秒的时间戳：同一天多次备份互不覆盖（每次启动自动备份 + 手动备份都会触发） */
    let name = format!("pm-backup-{}.json", chrono::Local::now().format("%Y-%m-%d-%H%M%S"));
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
pub fn backup_now(app: tauri::AppHandle, db: State<Db>) -> Result<String, String> {
    let dir = app
        .path()
        .app_data_dir()
        .map_err(|e| e.to_string())?
        .join("backups");
    fs::create_dir_all(&dir).map_err(|e| e.to_string())?;
    /* 只把序列化留在锁内，写盘在锁外，避免大库备份时卡住所有 UI 命令 */
    let json = {
        let conn = db.0.lock().map_err(|e| e.to_string())?;
        backup_serialize(&conn)?
    };
    persist_backup(&dir, &json)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn xlsx_roundtrip_dates_and_merged_cells() {
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





