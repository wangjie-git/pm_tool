/* 每日笔记 —— 拆分自 ui/app.js（来源行 3565-3628） */

import { invoke } from '../backend.js';
import { render, renderView } from '../render.js';
import { getShutdownMeta } from '../report.js';
import { S, TODAY, getTask, isOpen, projNameOf } from '../state.js';
import { $id, addDays, esc, mdRender, toast, toastErr } from '../utils.js';

export function dailyNoteNav(delta) {
  S.noteDate = addDays(S.noteDate, delta);
  render(); /* 页头 📝 日期 chip 由 renderHeader 渲染，只 renderView 会留下旧日期 */
}
export async function dailyNoteGoToday() {
  S.noteDate = TODAY;
  render(); /* 同上：今天按钮后页头日期也要同步 */
}
export async function saveDailyNoteText() {
  const ta = $id('dn-text');
  if (!ta) return;
  try {
    /* 用 textarea 上盖的日期戳定位存储键：渲染竞态期间（切日期后新页面未就绪、
     * 屏幕上还是旧日期的输入框）点保存，不能把旧正文写进新日期的 key 覆盖其笔记 */
    const date = ta.dataset.date || S.noteDate;
    await invoke('set_meta', { key: 'dailyNote_' + date, value: ta.value });
    toast('每日笔记已保存');
    renderView();
  } catch (e) { toastErr('保存失败', e); }
}
/* 渲染竞态防护（同 renderStats 的 statsSeq）：日期切换后丢弃过期的渲染结果 */
let dnSeq = 0;
export async function renderDailyNote() {
  const box = $id('viewDailyNote');
  const date = S.noteDate;
  const mySeq = ++dnSeq;
  const archIds = S.projects.filter(p => p.archived).map(p => p.id);
  const doneTasks = S.tasks.filter(t => t.status === 'done' && (t.doneAt || '').slice(0, 10) === date && archIds.indexOf(t.projectId) < 0);
  const dueTasks = S.tasks.filter(t => isOpen(t) && t.due === date && archIds.indexOf(t.projectId) < 0);
  const frogs = S.frogs.ids.map(id => getTask(id)).filter(t => t && t.status !== 'done');
  const meetings = S.meetings.filter(m => m.date === date);
  const shut = await getShutdownMeta(date);
  let logs = [];
  try { logs = await invoke('get_time_logs', { since: date }) || []; } catch (e) {}
  const mins = logs.filter(l => l.date === date).reduce((x, l) => x + (l.minutes || 0), 0);
  const myNote = await invoke('get_meta', { key: 'dailyNote_' + date }).catch(() => '') || '';

  let h = '<div class="cal-head">'
    + '<button class="btn ghost" onclick="dailyNoteNav(-1)">‹</button>'
    + '<b class="cal-title">' + date + (date === TODAY ? '（今天）' : '') + '</b>'
    + '<button class="btn ghost" onclick="dailyNoteNav(1)">›</button>'
    + '<button class="btn ghost" onclick="dailyNoteGoToday()">今天</button>'
    + '<span class="flex1"></span>'
    + (mins ? '<span class="chip2 cd">⏳ 投入 ' + (mins / 60).toFixed(1) + ' 小时</span>' : '')
    + '</div>';

  h += '<div class="dn-grid">';
  h += '<div class="stat-panel"><h3>🐸 今日三件要事</h3>'
    + (date === TODAY && frogs.length ? frogs.map(t => '<div class="dn-row">🐸 ' + esc(t.title) + '</div>').join('') : '<div class="empty">（当日未设置青蛙）</div>') + '</div>';
  h += '<div class="stat-panel"><h3>✅ 当日完成（' + doneTasks.length + '）</h3>'
    + (doneTasks.length ? doneTasks.map(t => '<div class="dn-row">✔ <span class="dim">' + esc(projNameOf(t.projectId)) + '</span> ' + esc(t.title) + '</div>').join('') : '<div class="empty">无</div>') + '</div>';
  h += '<div class="stat-panel"><h3>📆 当日到期（' + dueTasks.length + '）</h3>'
    + (dueTasks.length ? dueTasks.slice(0, 10).map(t => '<div class="dn-row">▸ <span class="dim">' + esc(projNameOf(t.projectId)) + '</span> ' + esc(t.title) + (t.status === 'doing' ? ' 🔨' : '') + '</div>').join('') + (dueTasks.length > 10 ? '<div class="empty">…还有 ' + (dueTasks.length - 10) + ' 条</div>' : '') : '<div class="empty">无</div>') + '</div>';
  h += '<div class="stat-panel"><h3>🗂 当日会议（' + meetings.length + '）</h3>'
    + (meetings.length ? meetings.map(m => '<div class="dn-row" onclick="openMeetingModal(' + m.id + ')" style="cursor:pointer;">🗂 ' + esc(m.title) + ' <span class="dim">' + esc(m.attendees || '') + '</span></div>').join('') : '<div class="empty">无</div>') + '</div>';
  h += '<div class="stat-panel"><h3>🌙 收尾问答</h3>'
    + (shut ? '<div class="dn-row">★ 干成：' + esc(shut.done || '—') + '</div><div class="dn-row">⛔ 卡点：' + esc(shut.stuck || '—') + '</div><div class="dn-row">⛔ 阻碍：' + esc(shut.block || '—') + '</div><div class="dn-row">➡ 明日：' + esc((shut.next3 || '').replace(/\n/g, ' / ')) + '</div>' : '<div class="empty">（当日未做收尾问答）</div>') + '</div>';
  h += '</div>';

  h += '<div class="stat-panel"><h3>📝 我的笔记（Markdown，Obsidian Daily Notes 模式）</h3>'
    + '<textarea id="dn-text" rows="6" placeholder="记录当天的过程、判断、待查线索…支持 Markdown 列表 / 粗体 / [[任务标题]] 反链">' + esc(myNote) + '</textarea>'
    + '<div style="margin-top:8px;display:flex;gap:8px;"><button class="btn blue" onclick="saveDailyNoteText()">💾 保存笔记</button>'
    + '<span class="hint">[[任务标题]] 会自动成为反链；保存后出现在引用它的任务详情里</span></div>'
    + (myNote ? '<div class="mdview" style="margin-top:10px;">' + mdRender(myNote) + '</div>' : '')
    + '</div>';
  /* await 期间切到其他日期时丢弃本次渲染：否则旧日期正文留在输入框，
   * 点「保存笔记」会把 A 的内容写进 dailyNote_B，静默覆盖 B 的笔记 */
  if (mySeq !== dnSeq || date !== S.noteDate) return;
  box.innerHTML = h;
  /* 给输入框盖日期戳：保存时以戳为准，双保险防上述竞态 */
  const ta = $id('dn-text');
  if (ta) {
    ta.dataset.date = date;
    ta.onkeydown = (e) => {
      if ((e.ctrlKey || e.metaKey) && e.key === 'Enter') {
        e.preventDefault();
        saveDailyNoteText();
      }
    };
  }
}
