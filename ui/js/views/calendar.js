/* 日历视图 —— 拆分自 ui/app.js（来源行 1951-2030）
 * v2.2 动线3：任务块拖到其他日期=改截止；点空白处新建（预填日期）；「还有 N 项」点开当日浮层 */

import { cmpTask } from '../filter.js';
import { openTaskEdit } from '../modals/task-edit.js';
import { renderView } from '../render.js';
import { S, TODAY, curProject, getTask, projTasks, repeatLabel } from '../state.js';
import { persistTask } from '../tasks.js';
import { $id, addDays, addMonths, esc, pad, toast, toastErr } from '../utils.js';

export let calSuppressClickUntil = 0;

export function renderCalendar() {
  const p = curProject(); if (!p) return;
  if (!S.calMonth) S.calMonth = TODAY.slice(0, 7);
  const parts = S.calMonth.split('-');
  const y = +parts[0], m = +parts[1];
  const firstDow = (new Date(y, m - 1, 1).getDay() + 6) % 7; // 周一=0
  const dim = new Date(y, m, 0).getDate();
  const prevYm = m === 1 ? (y - 1) + '-12' : y + '-' + pad(m - 1);
  const nextYm = m === 12 ? (y + 1) + '-01' : y + '-' + pad(m + 1);

  const byDay = {};
  projTasks(p.id).forEach(t => {
    if (!t.due || t.due.slice(0, 7) !== S.calMonth) return;
    (byDay[t.due] = byDay[t.due] || []).push(t);
  });

  /* 循环任务预占（#15）：每周/每月循环在当月的下一次及后续占位 */
  const monthEnd = y + '-' + pad(m) + '-' + pad(dim);
  const ghosts = {};
  projTasks(p.id).forEach(t => {
    if (t.status === 'done' || !t.repeat || !t.due) return;
    const monthStart = y + '-' + pad(m) + '-01';
    let cur = t.due;
    /* 老循环任务先按周期步长快进到本月，再逐格预占：
     * 否则逐天/逐周推进会在到达本月之前耗尽 62 次守护，当月一块都不显示 */
    if (cur < monthStart) {
      if (t.repeat === 'daily') cur = monthStart;
      else if (t.repeat === 'weekly') {
        const dd = Math.round((new Date(monthStart) - new Date(t.due)) / 86400000);
        cur = addDays(t.due, Math.ceil(dd / 7) * 7); /* 整周快进，保持星期对齐 */
      } else {
        const p2 = t.due.split('-');
        cur = addMonths(t.due, (y - +p2[0]) * 12 + (m - +p2[1]));
      }
    }
    let guard = 0;
    while (cur <= monthEnd && guard++ < 62) {
      if (cur > t.due && cur >= y + '-' + pad(m) + '-01' && cur <= monthEnd) {
        (ghosts[cur] = ghosts[cur] || []).push(t);
      }
      cur = t.repeat === 'daily' ? addDays(cur, 1)
        : t.repeat === 'weekly' ? addDays(cur, 7)
        : addMonths(cur, 1);
    }
  });

  const wkChars = ['一', '二', '三', '四', '五', '六', '日'];
  let h = '<div class="cal-head">'
    + '<button class="btn ghost" onclick="calNav(-1)">‹</button>'
    + '<b class="cal-title">' + y + ' 年 ' + m + ' 月</b>'
    + '<button class="btn ghost" onclick="calNav(1)">›</button>'
    + '<button class="btn ghost" onclick="calGoToday()">今天</button>'
    + '<span class="flex1"></span>'
    + '<span class="chip2">🖱 拖任务到其他日期改截止 · 点空白格新建当日任务</span>'
    + '<span class="chip2">📆 ' + esc(p.name) + ' · 本月 ' + Object.keys(byDay).reduce((s, d) => s + byDay[d].length, 0) + ' 项截止</span>'
    + '</div>';
  h += '<div class="cal-grid" id="calGrid">';
  wkChars.forEach(c => { h += '<div class="cal-wk">' + c + '</div>'; });
  for (let i = 0; i < firstDow; i++) h += '<div class="cal-cell blank"></div>';
  for (let d = 1; d <= dim; d++) {
    const ds = y + '-' + pad(m) + '-' + pad(d);
    const items = (byDay[ds] || []).sort(cmpTask);
    const gs = (ghosts[ds] || []);
    const isToday = ds === TODAY;
    let cells = '';
    items.slice(0, 3).forEach(t => {
      const doneCls = t.status === 'done' ? ' done' : '';
      const overCls = (t.status !== 'done' && t.due < TODAY) ? ' over' : '';
      cells += '<div class="cal-task' + doneCls + overCls + '" data-id="' + t.id + '" title="' + esc(t.title) + '（' + (t.owner || '我方') + ' · ' + esc(t.pri || 'P1') + '）· 拖到其他日期改截止" onclick="event.stopPropagation();openTaskEdit(' + t.id + ')">'
        + '<i class="pdot ' + (t.pri === 'P0' ? 'p0' : (t.pri === 'P1' ? 'p1' : 'p2')) + '"></i>' + esc(t.title) + '</div>';
    });
    if (items.length > 3) cells += '<div class="cal-more" data-day="' + ds + '" onclick="event.stopPropagation();calShowDay(\'' + ds + '\', this)">…还有 ' + (items.length - 3) + ' 项</div>';
    gs.slice(0, items.length > 3 ? 1 : Math.max(0, 3 - items.length)).forEach(t => {
      cells += '<div class="cal-task ghost" title="循环任务预占：' + esc(t.title) + '（' + repeatLabel(t.repeat) + '）—— 到期未完成会自动顺延" onclick="event.stopPropagation();openTaskEdit(' + t.id + ')">🔄 ' + esc(t.title) + '</div>';
    });
    if (gs.length > 3 - Math.min(items.length, 3) && items.length <= 3) cells += '<div class="cal-more dim" title="仅展示预占数量，预占到期未完成会自动顺延">…还有 ' + (gs.length - Math.max(0, 3 - items.length)) + ' 次预占</div>';
    const dcnt = items.length + gs.length;
    h += '<div class="cal-cell cal-creatable' + (isToday ? ' today' : '') + '" data-day="' + ds + '">'
      + '<div class="cal-d">' + d + (dcnt ? ' <span class="cal-n">' + dcnt + '</span>' : '') + '</div>'
      + '<span class="cal-add-hint" data-day="' + ds + '" onclick="event.stopPropagation();calNewAt(\'' + ds + '\')">＋</span>'
      + cells + '</div>';
  }
  h += '</div>';
  h += '<div class="cal-legend"><span class="chip2"><i class="pdot p0"></i>P0</span><span class="chip2"><i class="pdot p1"></i>P1</span><span class="chip2"><i class="pdot p2"></i>P2</span><span class="chip2">🔄 虚块 = 循环任务预占（Reclaim 思路简化版）</span><span class="chip2">点任务直接编辑</span></div>';
  $id('viewCalendar').innerHTML = h;
  bindCalDrag();
}

/* 点空白格 / ＋ 角标：新建任务并预填该日期 */
export function calNewAt(ds) {
  openTaskEdit(0, { due: ds, startDate: ds });
}

/* 关闭当日浮层：从浮层打开编辑弹窗时先收起，避免弹窗关闭后浮层残留悬浮 */
export function calClosePop() {
  const old = document.querySelector('.cal-day-pop');
  if (old) old.remove();
}
/* 「还有 N 项」当日浮层：列出当天全部任务，可新建 */
export function calShowDay(ds, anchor) {
  calClosePop();
  const p = curProject(); if (!p) return;
  const items = projTasks(p.id).filter(t => t.due === ds).sort(cmpTask);
  const pop = document.createElement('div');
  pop.className = 'cal-day-pop';
  const r = anchor.getBoundingClientRect();
  pop.style.left = Math.min(r.left, window.innerWidth - 340) + 'px';
  pop.style.top = Math.min(r.bottom + 6, window.innerHeight - 320) + 'px';
  let h = '<div class="cdp-title">📆 ' + ds + ' · ' + items.length + ' 项</div>';
  h += items.map(t =>
    '<div class="cal-task' + (t.status === 'done' ? ' done' : '') + ((t.status !== 'done' && t.due < TODAY) ? ' over' : '') + '" onclick="calClosePop();openTaskEdit(' + t.id + ')">'
    + '<i class="pdot ' + (t.pri === 'P0' ? 'p0' : (t.pri === 'P1' ? 'p1' : 'p2')) + '"></i>' + esc(t.title) + '</div>').join('')
    || '<div class="empty">这一天没有任务</div>';
  h += '<button class="cdp-add" onclick="calClosePop();calNewAt(\'' + ds + '\')">＋ 新建 ' + ds.slice(5) + ' 的任务</button>';
  pop.innerHTML = h;
  document.body.appendChild(pop);
  setTimeout(() => {
    const close = (ev) => {
      if (!pop.contains(ev.target)) { pop.remove(); document.removeEventListener('mousedown', close); }
    };
    document.addEventListener('mousedown', close);
  }, 0);
}

export function calNav(delta) {
  const parts = S.calMonth.split('-');
  const d = new Date(+parts[0], +parts[1] - 1 + delta, 1);
  S.calMonth = d.getFullYear() + '-' + pad(d.getMonth() + 1);
  renderView();
}
export function calGoToday() { S.calMonth = TODAY.slice(0, 7); renderView(); }

/* ---------- 日历拖拽（动线3）：拖任务块到其他日期=改截止（指针拖拽，与看板同思路） ---------- */
let cdrag = null;
let calDragBound = false;
export function bindCalDrag() {
  if (calDragBound) return;
  calDragBound = true;
  document.addEventListener('mousedown', e => {
    if (e.button !== 0) return;
    if (S.mode !== 'project' || S.view !== 'calendar') return;
    const task = e.target.closest ? e.target.closest('.cal-task[data-id]') : null;
    if (!task || task.classList.contains('ghost')) return;
    const id = +task.getAttribute('data-id');
    if (!getTask(id)) return;
    cdrag = { id, srcEl: task, started: false, startX: e.clientX, startY: e.clientY, ghost: null };
    e.preventDefault();
  });
  document.addEventListener('mousemove', e => {
    if (!cdrag) return;
    /* 鼠标在窗口外松开过（无 pointer capture，mouseup 不送达）：按钮状态为零时清理残留拖拽态，
     * 否则悬浮 ghost 会残留、下一次任意 mouseup 会被误当作拖拽结束并改期任务 */
    if (e.buttons === 0) {
      if (cdrag.ghost) cdrag.ghost.remove();
      if (cdrag.srcEl) cdrag.srcEl.classList.remove('drag-src');
      document.body.classList.remove('dragging-cal');
      cdrag = null;
      return;
    }
    if (!cdrag.started) {
      if (Math.abs(e.clientX - cdrag.startX) < 5 && Math.abs(e.clientY - cdrag.startY) < 5) return;
      cdrag.started = true;
      const t = getTask(cdrag.id);
      const ghost = document.createElement('div');
      ghost.className = 'cal-drag-ghost';
      ghost.textContent = t ? '📅 ' + t.title : '';
      document.body.appendChild(ghost);
      cdrag.ghost = ghost;
      cdrag.srcEl.classList.add('drag-src');
      document.body.classList.add('dragging-cal');
    }
    if (cdrag.ghost) {
      cdrag.ghost.style.left = (e.clientX + 10) + 'px';
      cdrag.ghost.style.top = (e.clientY + 10) + 'px';
    }
    e.preventDefault();
    document.querySelectorAll('.cal-cell.drop-target').forEach(el => el.classList.remove('drop-target'));
    const cell = calCellAt(e.clientX, e.clientY);
    if (cell && !cell.classList.contains('blank')) cell.classList.add('drop-target');
  });
  document.addEventListener('mouseup', async e => {
    if (!cdrag) return;
    const d = cdrag; cdrag = null;
    document.body.classList.remove('dragging-cal');
    if (d.ghost) d.ghost.remove();
    if (d.srcEl) d.srcEl.classList.remove('drag-src');
    document.querySelectorAll('.cal-cell.drop-target').forEach(el => el.classList.remove('drop-target'));
    if (!d.started) return;
    const cell = calCellAt(e.clientX, e.clientY);
    if (!cell || cell.classList.contains('blank')) return;
    calSuppressClickUntil = Date.now() + 400; /* 只在有效落点后武装抑制：拖出网格/空白格时 400ms 内不吞正常点击 */
    const ds = cell.getAttribute('data-day');
    const t = getTask(d.id);
    if (!t || !ds || t.due === ds) return;
    t.due = ds;
    try {
      await persistTask(t);
      toast('📅 「' + t.title.slice(0, 16) + '」截止已改为 ' + ds);
      renderView();
    } catch (err) { toastErr('改期失败', err); }
  });
}
function calCellAt(x, y) {
  const stack = document.elementsFromPoint ? document.elementsFromPoint(x, y) : [document.elementFromPoint(x, y)];
  for (const el of stack) {
    const cell = el.closest ? el.closest('.cal-cell') : null;
    if (cell) return cell;
  }
  return null;
}

/* ============ 任务编辑弹窗（含检查清单 / 风险登记册 / 父任务） ============ */
