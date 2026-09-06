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

## 必须遵守的约定

1. **跨模块可变状态只能通过 setter 写**。ES 导入绑定只读：`let` 声明所属模块之外直接赋值会抛 `Assignment to constant variable`。已有 setter：`setToday`（state.js）、`aiSetSelection`/`aiResetProfiles`（ai.js）、`saveProjectAsTemplateOf`（modals/project.js）。新增跨模块可写状态时照此模式。
2. **模板字符串/HTML 里的内联 `onclick="fn(...)"` 走全局作用域**：`fn` 必须已 export 且在 `compat.js` 挂到 window。新加此类函数时同步更新 compat.js。
3. **改完代码跑检查**：`node tools/check_ids.js`（$id 引用的 id 存在性 + onclick 函数定义）。该脚本扫描 `ui/js/**/*.js` 全量拼接，改结构无需改它。
4. **浏览器预览**用 `node tools/serve-ui.js`（含 no-store 缓存头 + 错误陷阱注入）；ES Modules 不能 `file://` 直开。Tauri 内（`cargo tauri dev`）正常。
5. 静态资源由 Tauri `frontendDist: ../ui` 直接服务，**不要引入打包器**；保持纯 ES Modules。

## 已知设计决策（不要回退）

- 2026-09 拆分：原 5017 行 `ui/app.js` 单文件拆为 33 个模块。拆分时删除了 `openNewProject` 的旧版死代码（原 2938 行，运行时被模板版覆盖）。
- `statsSeq`/`headerSeq` 是渲染竞态防护计数器，各自归属 stats.js/render.js，勿合并。
- `TODAY` 只在 tasks.js 的 `checkDayRollover` 经 `setToday` 刷新（常驻托盘跨天场景）。

## 其他

- 未初始化 git（本机无 git 命令）。改动前建议先备份 `ui/`（拆分时备份：`backup_ui_before_split_20260906-191200.zip`）。
- `tools/msvc-portable/` 是便携 MSVC 工具链（700MB+），与前端无关，勿动。
