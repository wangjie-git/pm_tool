/* init 启动流程、导览、页签切换 —— 拆分自 ui/app.js（来源行 1-7, 537-635, 5008-5026） */

import { invoke } from './backend.js';
import { bindEvents } from './events.js';
import { updateRemindBtn, updateTaskbarProgress } from './focus.js';
import { closeModal, openModal } from './modal.js';
import { openTaskEdit } from './modals/task-edit.js';
import { render, renderHeader, renderView } from './render.js';
import { applyTheme } from './settings.js';
import { shutdownCheck } from './shutdown.js';
import { S, curProject, getTask } from './state.js';
import { checkDayRollover, createProject, loadFrogs, loadRules, refreshAll, refreshTrashCount, routineReset, switchProject, timerTick, updateTimerBar } from './tasks.js';
import { $id, toast, toastErr } from './utils.js';
import { generateFollowupTasks } from './views/contacts.js';
import { loadSmartViews } from './views/inbox.js';

/* PM 待办助手 v2.1 —— 前端逻辑
 * 桌面模式：通过 Tauri invoke 调用 Rust + SQLite
 * 浏览器模式（直接打开 index.html）：用 localStorage 模拟后端，便于开发预览
 */
'use strict';

/* ============ 后端桥接 ============ */

/* ============ 改版一次性导览（v2.1）：localStorage 记忆，任意方式关闭后不再弹 ============ */
export function ensureTourDom() {
  if ($id('mw-tour')) return;
  document.body.insertAdjacentHTML('beforeend',
    '<div class="mwrap" id="mw-tour" hidden>'
    + '<div class="modal tour-modal">'
    + '<h3>👋 界面焕新了 —— 功能一个没少，只是换了摆放位置</h3>'
    + '<div class="tour-sub">30 秒看完这 5 条，老功能都能找到：</div>'
    + '<div class="tour-row"><span class="ti">🧭</span><div><b>侧栏四分组</b>：今日聚焦 / 收件箱 → 项目（含已归档）→ 洞察（智能视图 / 需求池）→ 记录（会议纪要 / 干系人 / 每日笔记）；页脚只留 主题 / 提醒 / 回收站 / 设置</div></div>'
    + '<div class="tour-row"><span class="ti">🗂</span><div><b>项目内两层页签</b>：上面一层 任务 / 统计 / 决策 / 档案；任务页里再选 列表 / 看板 / 日历 / 时间线</div></div>'
    + '<div class="tour-row"><span class="ti">⋯</span><div><b>顶栏「项目工具」</b>：Excel 导入导出、CSV / Markdown 导出、项目设置、另存为模板，都收在这个菜单里</div></div>'
    + '<div class="tour-row"><span class="ti">⚙</span><div><b>设置分五节</b>：通用 / 自动化 / 桌面集成 / AI 供应商 / 数据（立即备份与 JSON 导入在这里）</div></div>'
    + '<div class="tour-row"><span class="ti">⌨</span><div><b>常用快捷键</b>：N 新建任务 ｜ 1-4 切换任务视图 ｜ 5-7 直达统计 / 决策 / 档案 ｜ / 搜索 ｜ Ctrl+K 命令面板</div></div>'
    + '<div class="tour-foot"><button class="btn blue" onclick="markTourSeen()">开始使用</button></div>'
    + '</div></div>');
}
export function markTourSeen() {
  try { localStorage.setItem('pm_seen_tour', '2.1'); } catch (e) {}
  closeModal('mw-tour');
}
export function maybeShowTour() {
  let seen = '';
  try { seen = localStorage.getItem('pm_seen_tour') || ''; } catch (e) {}
  if (!seen) openModal('mw-tour');
}

export async function init() {
  try {
    const data = await invoke('load_app');
    S.projects = data.projects || [];
    S.tasks = data.tasks || [];
    S.ideas = data.ideas || [];
    S.decisions = data.decisions || [];
    S.meetings = data.meetings || [];
    S.contacts = data.contacts || [];
    if (!S.ideas.length) { try { S.ideas = await invoke('list_ideas') || []; } catch (e) {} }
    if (!S.projects.length) await createProject('示例项目');
    S.cur = await invoke('get_meta', { key: 'currentId' }) || ('' + S.projects[0].id);
    S.view = await invoke('get_meta', { key: 'view' }) || 'list';
    S.theme = await invoke('get_meta', { key: 'theme' }) || 'light';
    if (!curProject()) S.cur = '' + S.projects[0].id;
    applyTheme();
    updateRemindBtn(await invoke('get_meta', { key: 'notifyTime' }) || '');
    await loadRules();
    await loadFrogs();
    await loadSmartViews();
    S.shutdownTime = await invoke('get_meta', { key: 'shutdownTime' }) || '';
    S.dailyGoal = +(await invoke('get_meta', { key: 'dailyGoal' })) || 5;
    /* v2.2：密度 / 列表排序 / 统计范围 / 附件目录 / 每日笔记搜索索引 */
    S.density = (await invoke('get_meta', { key: 'density' }).catch(() => '')) === 'cozy' ? 'cozy' : 'compact';
    S.listSort = (await invoke('get_meta', { key: 'listSort' }).catch(() => '')) || 'smart';
    S.statsRange = (await invoke('get_meta', { key: 'statsRange' }).catch(() => '')) || '7d';
    try { S.attachDir = await invoke('attachments_dir'); } catch (e) { S.attachDir = ''; }
    try { await buildDnIndex(); } catch (e) { S.dnIndex = []; }
    try {
      const tm = await invoke('get_timer');
      if (tm && getTask(tm.taskId)) S.timer = { taskId: tm.taskId, startedAt: tm.startedAt };
    } catch (e) {}
    try { S.trashCount = ((await invoke('list_deleted')) || []).length; } catch (e) { S.trashCount = 0; }
    await generateFollowupTasks();
    await routineReset();
    ensureTourDom();
    bindEvents();
    bindDesktopEvents();
    render();
    updateTimerBar();
    setInterval(timerTick, 1000);
    setInterval(shutdownCheck, 30000);
    setInterval(refreshTrashCount, 60000);
    setInterval(() => { try { updateTaskbarProgress(); } catch (e) {} }, 30000);
    setInterval(() => { checkDayRollover().catch(() => {}); }, 30000);
    maybeShowTour();
  } catch (e) {
    toastErr('加载数据失败', e);
    /* bindEvents 依赖 #mw-tour 等弹窗节点存在；ensureTourDom 原本只在 try 内调用，
     * 失败回退路径若跳过它，$id('mw-tour') 为 null 会中断全部后续键盘/弹窗绑定 */
    try { ensureTourDom(); } catch (e2) {}
    bindEvents();
  }
}

/* 每日笔记搜索索引（动线3 全局搜索用）：把 dailyNote_{date} 的正文扫进内存 */
async function buildDnIndex() {
  try {
    const rows = await invoke('list_meta_prefix', { prefix: 'dailyNote_' }) || [];
    S.dnIndex = rows
      .filter(r => r.key && r.key.indexOf('dailyNote_') === 0 && r.value)
      .map(r => ({ date: r.key.slice('dailyNote_'.length), text: String(r.value).slice(0, 400) }));
  } catch (e) { S.dnIndex = []; }
}

/* 桌面集成事件（包2）：深链接跳回任务/项目 + 快速捕获窗口新增任务后刷新 */
export function bindDesktopEvents() {
  try {
    const ev = window.__TAURI__.event;
    if (!ev || !ev.listen) return;
    ev.listen('pm-deeplink', e => {
      const url = String(e.payload || '');
      const m = url.match(/^pm-todo:\/\/task\/(\d+)/i);
      const mp = url.match(/^pm-todo:\/\/project\/(\d+)/i);
      if (m) {
        const t = getTask(+m[1]);
        if (t) {
          S.cur = '' + t.projectId;
          S.mode = 'project';
          render();
          openTaskEdit(t.id);
          toast('🔗 从链接跳入：' + t.title.slice(0, 24), 'info');
        } else toast('链接指向的任务不存在（可能已删除）', 'err');
      } else if (mp) {
        const p = S.projects.find(x => x.id == mp[1]);
        if (p) { switchProject(p.id); toast('🔗 从链接跳入项目：' + p.name, 'info'); }
      }
    });
    ev.listen('quick-task-added', () => { refreshAll(); toast('⚡ 已从快速捕获小窗加入收件箱', 'info'); });
  } catch (e) {}
}
export async function switchTab(v) {
  S.mode = 'project';
  S.view = v;
  try { await invoke('set_meta', { key: 'view', value: v }); } catch (e) {}
  renderHeader();
  renderView();
}
/* 一级页签切换：任务页记住当前呈现，其他页直达 */
export async function switchPage(page) {
  if (page === 'task') {
    const tv = ['list', 'kanban', 'calendar', 'timeline'];
    await switchTab(tv.indexOf(S.view) >= 0 ? S.view : 'list');
  } else {
    await switchTab(page);
  }
}

init();

