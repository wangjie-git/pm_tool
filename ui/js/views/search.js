/* 全局搜索页（动线3）：跨项目搜索 任务 + 决策 + 会议 + 干系人 + 每日笔记，分组结果
 * 入口：顶栏搜索框回车；清空搜索框自动退出回项目视图 */

import { openTaskEdit } from '../modals/task-edit.js';
import { render } from '../render.js';
import { S, getTask, projNameOf } from '../state.js';
import { switchProject } from '../tasks.js';
import { $id, esc } from '../utils.js';
import { openContactModal } from './contacts.js';
import { openDecisionModal } from './decisions.js';
import { openMeetingModal } from './meetings.js';

function hi(text, kw) {
  const s = esc(String(text || ''));
  if (!kw) return s;
  const i = s.toLowerCase().indexOf(kw.toLowerCase());
  if (i < 0) return s;
  return s.slice(0, i) + '<mark>' + s.slice(i, i + kw.length) + '</mark>' + s.slice(i + kw.length);
}

export function renderSearch() {
  const box = $id('viewSearch');
  const kw = (S.search || '').trim();
  if (!kw) {
    S.visibleIds = [];
    box.innerHTML = '<div class="empty-state"><div class="es-icon">🔍</div>'
      + '<div class="es-title">在上方输入关键词开始全局搜索</div>'
      + '<div class="es-hint">同时搜索：任务 · 决策 · 会议纪要 · 干系人 · 每日笔记（跨全部未归档项目）</div></div>';
    return;
  }
  const lk = kw.toLowerCase();
  const archIds = S.projects.filter(p => p.archived).map(p => p.id);
  let n = 0;

  /* 任务：标题 / 备注 / 负责人 */
  const tasks = S.tasks.filter(t => archIds.indexOf(t.projectId) < 0
    && ((t.title || '') + ' ' + (t.note || '') + ' ' + (t.owner || '')).toLowerCase().indexOf(lk) >= 0)
    .sort((a, b) => (a.status === 'done' ? 1 : 0) - (b.status === 'done' ? 1 : 0) || (a.due < b.due ? -1 : 1))
    .slice(0, 40);
  n += tasks.length;
  let h = '';
  if (tasks.length) {
    h += '<div class="sr-group"><h2 class="grp">☰ 任务 <span class="gcnt">' + tasks.length + '</span></h2>';
    h += tasks.map(t => {
      const sub = esc(projNameOf(t.projectId)) + ' · ' + esc(t.due || '无日期') + ' · ' + esc(t.owner || '我方') + (t.status === 'done' ? ' · ✔' : '');
      return '<div class="sr-row" data-id="' + t.id + '" onclick="searchOpenTask(' + t.id + ')">'
        + '<span class="sr-ico">' + (t.status === 'done' ? '✅' : '☰') + '</span>'
        + '<span class="sr-t">' + hi(t.title, kw) + '</span>'
        + '<span class="sr-sub">' + sub + '</span></div>';
    }).join('') + '</div>';
  }
  /* 决策 */
  const decs = S.decisions.filter(d => ((d.title || '') + ' ' + (d.decision || '') + ' ' + (d.reason || '')).toLowerCase().indexOf(lk) >= 0).slice(0, 20);
  n += decs.length;
  if (decs.length) {
    h += '<div class="sr-group"><h2 class="grp">🏛 决策 <span class="gcnt">' + decs.length + '</span></h2>';
    h += decs.map(d =>
      '<div class="sr-row" onclick="searchOpenDecision(' + d.id + ')">'
      + '<span class="sr-ico">🏛</span><span class="sr-t">' + hi(d.title, kw) + '</span>'
      + '<span class="sr-sub">' + esc(projNameOf(d.projectId)) + ' · ' + esc(d.date || '') + ' · ' + esc(d.status || '') + '</span></div>').join('') + '</div>';
  }
  /* 会议 */
  const meets = S.meetings.filter(m => ((m.title || '') + ' ' + (m.conclusion || '') + ' ' + (m.attendees || '')).toLowerCase().indexOf(lk) >= 0).slice(0, 20);
  n += meets.length;
  if (meets.length) {
    h += '<div class="sr-group"><h2 class="grp">🗂 会议纪要 <span class="gcnt">' + meets.length + '</span></h2>';
    h += meets.map(m =>
      '<div class="sr-row" onclick="searchOpenMeeting(' + m.id + ')">'
      + '<span class="sr-ico">🗂</span><span class="sr-t">' + hi(m.title, kw) + '</span>'
      + '<span class="sr-sub">' + esc(m.date || '') + ' · ' + esc(m.attendees || '') + '</span></div>').join('') + '</div>';
  }
  /* 干系人 */
  const cts = S.contacts.filter(c => ((c.name || '') + ' ' + (c.org || '') + ' ' + (c.note || '')).toLowerCase().indexOf(lk) >= 0).slice(0, 20);
  n += cts.length;
  if (cts.length) {
    h += '<div class="sr-group"><h2 class="grp">👥 干系人 <span class="gcnt">' + cts.length + '</span></h2>';
    h += cts.map(c =>
      '<div class="sr-row" onclick="searchOpenContact(' + c.id + ')">'
      + '<span class="sr-ico">👥</span><span class="sr-t">' + hi(c.name, kw) + '</span>'
      + '<span class="sr-sub">' + esc(c.org || '') + '</span></div>').join('') + '</div>';
  }
  /* 每日笔记：正文按天存 meta dnNote:{date}，扫描时用启动时建好的索引 */
  const dnHits = (S.dnIndex || []).filter(x => (x.text || '').toLowerCase().indexOf(lk) >= 0).slice(0, 10);
  n += dnHits.length;
  if (dnHits.length) {
    h += '<div class="sr-group"><h2 class="grp">📝 每日笔记 <span class="gcnt">' + dnHits.length + '</span></h2>';
    h += dnHits.map(x =>
      '<div class="sr-row" onclick="openDailyNoteDate(\'' + x.date + '\')">'
      + '<span class="sr-ico">📝</span><span class="sr-t">' + hi((x.text || '').slice(0, 60), kw) + '</span>'
      + '<span class="sr-sub">' + esc(x.date) + '</span></div>').join('') + '</div>';
  }

  if (!n) {
    h = '<div class="empty-state"><div class="es-icon">🔍</div>'
      + '<div class="es-title">没有找到与「' + esc(kw) + '」相关的内容</div>'
      + '<div class="es-hint">换个更短的关键词试试；搜索范围：任务 / 决策 / 会议 / 干系人 / 每日笔记</div></div>';
  } else {
    h = '<div class="dim2" style="margin-bottom:10px;">找到 ' + n + ' 条结果（清空搜索框或按 Esc 退出全局搜索）</div>' + h;
  }
  S.visibleIds = tasks.map(t => t.id);
  box.innerHTML = h;
}

/* ---------- 结果跳转动作（挂 window 供内联 onclick 使用） ---------- */
export async function searchOpenTask(id) {
  const t = getTask(id);
  if (!t) return;
  S.cur = '' + t.projectId;
  S.mode = 'project';
  exitSearch();
  await switchProject(t.projectId);
  openTaskEdit(t.id);
}
export async function searchOpenDecision(id) {
  const d = S.decisions.find(x => x.id == id);
  if (!d) return;
  exitSearch();
  if (d.projectId) await switchProject(d.projectId);
  S.mode = 'project'; S.view = 'decisions';
  render();
  openDecisionModal(d.id);
}
export async function searchOpenMeeting(id) {
  exitSearch();
  S.mode = 'meetings';
  render();
  setTimeout(() => openMeetingModal(id), 30);
}
export async function searchOpenContact(id) {
  exitSearch();
  S.mode = 'contacts';
  render();
  setTimeout(() => openContactModal(id), 30);
}
export async function openDailyNoteDate(date) {
  exitSearch();
  S.noteDate = date;
  S.dnMonth = date.slice(0, 7);
  S.mode = 'dailynote';
  render();
}
function exitSearch() {
  S.search = '';
  const se = $id('search');
  if (se) se.value = '';
}
