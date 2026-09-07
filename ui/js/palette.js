/* 命令面板 Ctrl+K —— 拆分自 ui/app.js（来源行 4636-4753） */

import { invoke } from './backend.js';
import { openExcelWizard } from './excel.js';
import { parseFilter } from './filter.js';
import { closeModal, openModal } from './modal.js';
import { openTaskEdit } from './modals/task-edit.js';
import { quickAddFromClipboard } from './quickadd.js';
import { openDailyNote, openIdeas, openInbox, render } from './render.js';
import { openSettings, toggleTheme } from './settings.js';
import { openShutdownManual } from './shutdown.js';
import { S, getTask, projNameOf, projTasks } from './state.js';
import { openTrash, switchProject } from './tasks.js';
import { $id, esc } from './utils.js';
import { openDecisionModal } from './views/decisions.js';
import { openMeetingModal } from './views/meetings.js';
import { openTodayFocus } from './views/today.js';


/* ============ 命令面板（Ctrl+K，跨项目直达） ============ */
export let palItems = [], palIdx = 0;
export function openPalette() {
  openModal('mw-palette');
  const inp = $id('pal-input');
  inp.value = '';
  renderPalette('');
  setTimeout(() => inp.focus(), 20);
}
export function renderPalette(q) {
  q = (q || '').trim().toLowerCase();
  const f = parseFilter(q);
  const kw = f.kw || q;
  palItems = [];
  /* 项目：有关键词时按名称过滤 */
  S.projects.filter(p => !p.archived).forEach(p => {
    if (kw && p.name.toLowerCase().indexOf(kw) < 0) return;
    const n = projTasks(p.id).filter(t => t.status !== 'done').length;
    palItems.push({ kind: 'proj', id: p.id, label: p.name, sub: '项目 · ' + n + ' 项未完成' });
  });
  /* 任务：按关键词过滤；无关键词显示最近要做的 8 条 */
  const archIds = S.projects.filter(p => p.archived).map(p => p.id);
  let taskList = S.tasks.filter(t => archIds.indexOf(t.projectId) < 0);
  if (kw) taskList = taskList.filter(t => (t.title + ' ' + (t.owner || '') + ' ' + (t.note || '')).toLowerCase().indexOf(kw) >= 0);
  taskList = taskList
    .sort((a, b) => ((a.status === 'done' ? 1 : 0) - (b.status === 'done' ? 1 : 0)) || (a.due < b.due ? -1 : 1))
    .slice(0, kw ? 60 : 8); /* v2.2：有关键词时放宽到 60 条（原 14 条上限不够用） */
  taskList.forEach(t => {
    palItems.push({ kind: 'task', id: t.id, label: t.title, sub: projNameOf(t.projectId) + ' · ' + (t.due || '无日期') + ' · ' + (t.owner || '我方') + (t.status === 'done' ? ' · ✔' : '') });
  });
  /* 决策 / 会议：纳入搜索（包3） */
  S.decisions.forEach(d => {
    if (kw && (d.title + ' ' + (d.decision || '')).toLowerCase().indexOf(kw) < 0) return;
    palItems.push({ kind: 'decision', id: d.id, label: d.title, sub: '决策 · ' + (d.date || '') + ' · ' + projNameOf(d.projectId) });
  });
  S.meetings.forEach(m => {
    if (kw && (m.title + ' ' + (m.attendees || '')).toLowerCase().indexOf(kw) < 0) return;
    palItems.push({ kind: 'meeting', id: m.id, label: m.title, sub: '会议 · ' + (m.date || '') });
  });
  if (!kw) {
    palItems.unshift(
      { kind: 'goto', id: 'today', label: '📅 今日聚焦', sub: '跨项目今日到期 / 逾期 / 进行中' },
      { kind: 'goto', id: 'inbox', label: '📥 收件箱', sub: '分拣无主任务' },
      { kind: 'goto', id: 'ideas', label: '💡 需求池', sub: '想法 / 需求优先级' },
      { kind: 'goto', id: 'trash', label: '🗑 回收站', sub: S.trashCount ? S.trashCount + ' 条可恢复' : '已删除的任务 / 项目' },
      { kind: 'act', id: 'new-task', label: '➕ 新建任务', sub: '快捷键 N；或顶部输入框回车快速添加' },
      { kind: 'act', id: 'shutdown', label: '🌙 每日收尾问答', sub: '今天干成什么 / 卡在哪 / 明天三件事' },
      { kind: 'act', id: 'theme', label: '🌓 切换明暗主题', sub: '当前是' + (S.theme === 'dark' ? '深色' : '浅色') + '主题' },
      { kind: 'act', id: 'settings', label: '⚙ 打开设置', sub: '通用 / 自动化 / 桌面集成 / AI 供应商 / 数据' },
      { kind: 'act', id: 'record-decision', label: '🏛 记录决策', sub: '写入当前项目决策日志（ADR）' },
      { kind: 'act', id: 'clip-task', label: '📌 从剪贴板建任务', sub: '把复制的文字变成任务' },
      { kind: 'act', id: 'excel', label: '📥 Excel 计划表导入', sub: 'Jira 式五步向导' },
      { kind: 'act', id: 'dailynote', label: '📝 打开每日笔记', sub: '今日任务 / 青蛙 / 收尾 / 会议聚合' }
    );
  }
  if (kw) palItems.sort((a, b) => (a.kind === 'proj' ? 1 : 0) - (b.kind === 'proj' ? 1 : 0)); /* 有关键词：任务优先 */
  palIdx = 0;
  $id('pal-list').innerHTML = palItems.length
    ? palItems.map((it, i) =>
        '<div class="pal-item' + (i === 0 ? ' on' : '') + '" data-i="' + i + '" onclick="palPick(' + i + ')">'
        + '<span class="pk">' + (it.kind === 'proj' ? '📂' : it.kind === 'goto' ? '⚡' : it.kind === 'decision' ? '🏛' : it.kind === 'meeting' ? '🗂' : '🛠') + '</span>'
        + '<span class="pl">' + esc(it.label) + '</span>'
        + '<span class="ps">' + esc(it.sub) + '</span></div>').join('')
    : '<div class="empty" style="padding:14px 6px;">没有匹配的项目或任务</div>';
}
export function palMark() {
  $id('pal-list').querySelectorAll('.pal-item').forEach(el => {
    el.classList.toggle('on', +el.getAttribute('data-i') === palIdx);
  });
  const on = $id('pal-list').querySelector('.pal-item.on');
  if (on) on.scrollIntoView({ block: 'nearest' });
}
export function palMove(delta) {
  if (!palItems.length) return;
  palIdx = (palIdx + delta + palItems.length) % palItems.length;
  palMark();
}
export async function palPick(i) {
  const it = palItems[i];
  if (!it) return;
  closeModal('mw-palette');
  if (it.kind === 'goto') {
    if (it.id === 'today') openTodayFocus();
    else if (it.id === 'inbox') openInbox();
    else if (it.id === 'ideas') openIdeas();
    else if (it.id === 'trash') openTrash();
    else if (it.id === 'dailynote') openDailyNote();
  } else if (it.kind === 'act') {
    if (it.id === 'record-decision') openDecisionModal(0);
    else if (it.id === 'clip-task') quickAddFromClipboard();
    else if (it.id === 'excel') openExcelWizard();
    else if (it.id === 'new-task') openTaskEdit(0);
    else if (it.id === 'shutdown') openShutdownManual();
    else if (it.id === 'theme') toggleTheme();
    else if (it.id === 'settings') openSettings();
  } else if (it.kind === 'decision') {
    const d = S.decisions.find(x => x.id == it.id);
    if (!d) return;
    if (d.projectId) await switchProject(d.projectId);
    S.mode = 'project'; S.view = 'decisions';
    render();
    openDecisionModal(d.id); /* 与全局搜索结果一致：直达该条决策，而不是只切视图 */
  } else if (it.kind === 'meeting') {
    S.mode = 'meetings';
    render();
    setTimeout(() => openMeetingModal(it.id), 30);
  } else if (it.kind === 'proj') {
    await switchProject(it.id);
  } else {
    const t = getTask(it.id);
    if (!t) return;
    S.cur = '' + t.projectId;
    S.mode = 'project';
    try { await invoke('set_meta', { key: 'currentId', value: S.cur }); } catch (e) {}
    render();
    openTaskEdit(t.id);
  }
}

