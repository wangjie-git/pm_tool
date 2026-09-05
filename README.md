# PM 待办助手

> 本地优先的项目管理 / 待办工具，面向需要同时盯多个项目、多项任务的项目经理。

[![Release](https://img.shields.io/github/v/release/wangjie-git/pm_tool?label=%E4%B8%8B%E8%BD%BD)](https://github.com/wangjie-git/pm_tool/releases/latest)

基于 **Tauri 2 + SQLite**，前端为原生 HTML/JS，无任何外部依赖服务，数据 100% 存储在本机。

## 下载安装

到 [Releases](https://github.com/wangjie-git/pm_tool/releases/latest) 页面下载 `PM待办助手_x.x.x_x64-setup.exe`，双击安装即可（Windows 10/11，安装时自动处理 WebView2 运行时）。

## 功能特性

- **多项目管理**：项目归档、项目设置、里程碑
- **三种视图**：列表（含搜索/筛选）、看板（拖拽）、统计
- **快速添加语法**：`下周三 闸机联调 @李四 !P0 #风险 #每日`
  - 日期：今天 / 明天 / 后天 / 下周三 / +3天 / 2026-09-14
  - 负责人 `@张三`，优先级 `!P0 !P1 !P2`，标记 `#风险` `#每日`
- **任务属性**：截止日期、负责人、优先级、风险标记、每日循环任务、清单 checklist、排序
- **日报 / 周报**：按项目一键生成进度日报，复制即发
- **数据安全**：本机 SQLite 存储，启动自动备份（保留最近 30 份），支持 JSON 导入/导出、CSV 导出
- **系统集成**：系统托盘常驻、关闭窗口最小化到托盘、启动时通知今日到期任务、窗口状态记忆
- **体验细节**：明暗主题、快捷键（N 新建、1/2/3 切换视图、/ 搜索）

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
