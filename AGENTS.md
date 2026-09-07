# AGENTS.md —— AI 协作指引

## 项目概览

Tauri v2 桌面应用（PM 待办助手）。前端 `ui/` 为**纯 ES Modules，无打包器**；后端 Rust + SQLite（`src-tauri/`）。

## 前端模块地图（ui/js/）

**改 bug 前先按此表定位模块，只读相关文件，不要通读所有文件。**

| 文件 | 职责 |
|------|------|
| `app.js` | 入口，仅按序 import；`main.js` 最后求值并调用 `init()` |
| `state.js` | 全局 `S`、`TODAY`（+`setToday`）、`PRI_W/RISK_RED`、模型选择器（curProject/getTask/parseSettings…） |
| `backend.js` | `invoke`/`TDialog` 封装、`getJsonMeta/putJsonMeta`、浏览器预览 mock |
| `utils.js` | `$id`、日期工具、`esc`、`toast`、markdown 渲染、wikilinks、`copyText` |
| `filter.js` | parseFilter / filteredTasks / cmpTask |
| `tasks.js` | 任务/项目 CRUD、置顶/推迟、计时器、回收站、`checkDayRollover` |
| `quickadd.js` | 自然语言解析（parseQuick）、快速添加、剪贴板建任务 |
| `stats.js` | 统计页、蒙特卡洛预测（statsSeq 竞态防护） |
| `render.js` | `render()`/renderSidebar/renderHeader/renderView + 视图切换函数 |
| `views/` | today（任务卡/卡片菜单/今日聚焦）、board（列表+看板拖拽）、calendar、inbox+智能视图、ideas、decisions、meetings、contacts、dailynote、archive |
| `modals/` | task-edit（任务编辑/清单/反链）、project（项目设置/模板）、newproject（新建项目） |
| `focus.js` `gantt.js` `excel.js` `report.js` `ai.js` `backup.js` `modal.js`（通用 confirm/prompt）`shutdown.js` `settings.js` `palette.js` | 各功能域 |
| `events.js` | `bindEvents()`：所有 `$id(...).onclick` 与键盘快捷键绑定 |
| `compat.js` | **window 桥接**：把 HTML 内联 `onclick=` 引用的函数挂到 `window` |

## 后端模块地图（src-tauri/src/）

**改后端 bug 前按此表定位模块，不要在 main.rs 里堆逻辑。**

| 文件 | 职责 |
|------|------|
| `main.rs` | 入口：插件注册、setup（建库/迁移/深链接/后台线程）、`generate_handler!`（命令按 `模块::命令` 路径注册）、窗口事件 |
| `state.rs` | `Db(Mutex<Connection>)`、`WinSaveGuard`（字段 `pub`，各模块直接 `db.0.lock()`） |
| `models.rs` | 与前端 JSON 对应的 9 个实体（Project/Task/Idea/TimeLog/DeletedItem/Decision/Meeting/Contact/AppData），字段全 `pub` |
| `util.rs` | `es`（错误转字符串）、`today_str/now_str/date_of_ts`、`clamp5` |
| `db.rs` | `MIGRATE` 建表、`ensure_column/seed_if_empty`、row mapper、`read_all`、meta 表读写命令（get/set/list_meta_prefix/list_all_meta）、`load_app`/`import_data` |
| `tasks.rs` | 任务/项目 CRUD、回收站（trash_insert/insert_task_tx 私有辅助） |
| `journal.rs` | 决策/会议/干系人/需求池 CRUD |
| `timer.rs` | 计时器（TimerState 存 meta）、time_logs 写入 |
| `webhook.rs` | 钉钉加签（dingtalk_sign 私有）、`webhook_post`（供 system 预算告警用）、`send_webhook` + 测试 |
| `ai.rs` | OpenAI 兼容 /chat/completions：`ai_chat`/`ai_list_models` + 测试 |
| `import_export.rs` | xlsx 读写、整项目 Markdown 导出、备份（`backup_serialize` 锁内序列化 + `persist_backup` 锁外写盘，供 main 启动自动备份）、附件/文本文件 + 测试 |
| `system.rs` | 托盘、通知、任务栏进度、自启、全局热键、窗口状态记忆、每日提醒/预算告警后台循环 |

## 必须遵守的约定

1. **跨模块可变状态只能通过 setter 写**。ES 导入绑定只读：`let` 声明所属模块之外直接赋值会抛 `Assignment to constant variable`。已有 setter：`setToday`（state.js）、`aiSetSelection`/`aiResetProfiles`（ai.js）、`saveProjectAsTemplateOf`（modals/project.js）。新增跨模块可写状态时照此模式。
2. **模板字符串/HTML 里的内联 `onclick="fn(...)"` 走全局作用域**：`fn` 必须已 export 且在 `compat.js` 挂到 window。新加此类函数时同步更新 compat.js。
3. **改完代码跑检查**：`node tools/check_ids.js`（$id 引用的 id 存在性 + onclick 函数定义）。该脚本扫描 `ui/js/**/*.js` 全量拼接，改结构无需改它。后端命令接线核对：`node tools/check_commands.js`（前端 invoke 命令名 vs 后端 `#[tauri::command]` fn 名交叉比对，改命令时同步跑）。**ESM 语法检查**：`node tools/check_syntax.js`（把模块当 ES Module 逐个 `--check`；注意 `node --check file.js` 按 CommonJS 解析会漏报——历史教训：`views/contacts.js` 曾在对象字面量里混入 `const fv = ...` 导致整个模块图加载失败、应用白屏，静态检查全绿但启动即崩）。**改交互代码后跑冒烟**：`node tools/smoke-ui.js`（模块图加载 + init() 全流程）与 `node tools/smoke-ui2.js`（逐个调用各视图渲染器与动作函数，共 50 项）。
4. **浏览器预览**用 `node tools/serve-ui.js`（含 no-store 缓存头 + 错误陷阱注入）；ES Modules 不能 `file://` 直开。Tauri 内（`cargo tauri dev`）正常。
5. 静态资源由 Tauri `frontendDist: ../ui` 直接服务，**不要引入打包器**；保持纯 ES Modules。

## 已知设计决策（不要回退）

- 2026-09 拆分：原 5017 行 `ui/app.js` 单文件拆为 33 个模块。拆分时删除了 `openNewProject` 的旧版死代码（原 2938 行，运行时被模板版覆盖）。
- 2026-09 后端拆分：原 2932 行 `src-tauri/src/main.rs` 拆为 11 个模块（见上表），命令改按 `module::command` 路径注册于 `main.rs` 的 `generate_handler!`。纯移动 + 加 `pub`，零逻辑改动；`Db` 的 Mutex 字段为 `pub` 以便各模块加锁。拆分时备份：`backup_src_before_split_20260907-105641.zip`。
- `statsSeq`/`headerSeq` 是渲染竞态防护计数器，各自归属 stats.js/render.js，勿合并。
- `TODAY` 只在 tasks.js 的 `checkDayRollover` 经 `setToday` 刷新（常驻托盘跨天场景）。

## 其他

- 未初始化 git（本机无 git 命令）。改动前建议先备份 `ui/`（拆分时备份：`backup_ui_before_split_20260906-191200.zip`）。
- `tools/msvc-portable/` 是便携 MSVC 工具链（700MB+），与前端无关，勿动。
- 编译/测试需先加载便携 MSVC 环境：`tools/cargo-env.cmd cargo build`（含 link.exe 等；裸 `cargo build` 会报 linker not found）。
