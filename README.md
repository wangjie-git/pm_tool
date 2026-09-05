# PM 待办助手

> 本地优先的项目管理 / 待办工具，面向需要同时盯多个项目、多项任务的项目经理。

[![Release](https://img.shields.io/github/v/release/wangjie-git/pm_tool?label=%E4%B8%8B%E8%BD%BD)](https://github.com/wangjie-git/pm_tool/releases/latest)

基于 **Tauri 2 + SQLite**，前端为原生 HTML/JS，无任何外部依赖服务，数据 100% 存储在本机。

## 下载安装

到 [Releases](https://github.com/wangjie-git/pm_tool/releases/latest) 页面下载 `PMTodoAssistant_x.x.x_x64-setup.exe`（资产中文名见其 label），双击安装即可（Windows 10/11，安装时自动处理 WebView2 运行时）。

## 功能特性

- **多项目管理**：项目归档、项目设置、里程碑
- **今日聚焦**：跨项目汇总今天到期 / 逾期 / 进行中的任务，按项目分组，一键复制今日清单发给团队
- **四种视图**：列表（含搜索/筛选）、看板（拖拽，含 WIP 超限提醒）、日历（月历看截止日分布）、统计（含停滞任务清单）
- **快速添加语法**：`下周三 闸机联调 @李四 !P0 #风险 #每周`
  - 日期：今天 / 明天 / 后天 / 下周三 / +3天 / 2026-09-14
  - 负责人 `@张三`，优先级 `!P0 !P1 !P2`，标记 `#风险` `#每日` `#每周` `#每月`
- **任务属性**：截止日期、负责人、优先级、风险标记、每日/每周/每月循环任务、检查清单、置顶、停滞提醒（7 天未动自动打标）
- **Ctrl+K 命令面板**：跨项目搜项目 / 任务，键盘直达（参考 Linear）
- **日报 / 周报**：按项目一键生成进度日报，复制即发
- **每日定时提醒**：到点系统通知今日到期任务（默认 09:30，左下角 ⏰ 可改）
- **数据安全**：本机 SQLite 存储，启动自动备份（保留最近 30 份），支持 JSON 导入/导出、CSV 导出
- **系统集成**：系统托盘常驻、关闭窗口最小化到托盘、启动时通知今日到期任务、窗口状态记忆
- **体验细节**：明暗主题、快捷键（N 新建、1/2/3/4 切换视图、/ 搜索、Ctrl+K 面板）

新增功能的选型依据见 [docs/PM工具功能调研.md](docs/PM工具功能调研.md)。

## 从源码构建

依赖：Rust（MSVC 工具链）、WebView2（Win10/11 通常已内置）。

```bash
# 安装 Rust（Windows 也可使用本仓库 tools/install-rust.cmd 的便携方案）
rustup default stable

# 安装 Tauri CLI
cargo install tauri-cli

# 开发调试
cargo tauri dev

# 打包 Windows 安装包（NSIS）
cargo tauri build
```

产物位于 `src-tauri/target/release/bundle/nsis/`。

## 发布新版本

本项目配置了 GitHub Actions（[.github/workflows/release.yml](.github/workflows/release.yml)），推送 `v` 开头的标签即自动在 GitHub 服务器上编译并发布 Release：

```bash
# 1. 先把 src-tauri/tauri.conf.json 里的 version 改成新版本号并提交
# 2. 打标签（版本号与 version 一致）
git tag v1.2.0
git push origin v1.2.0
```

也可以在仓库 **Actions** 页面手动触发，版本号自动取自 `tauri.conf.json`。

## 许可证

[MIT](LICENSE)
