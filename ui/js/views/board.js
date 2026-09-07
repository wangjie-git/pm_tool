/* 列表视图 + 看板拖拽 —— 拆分自 ui/app.js（来源行 1588-1737） */

import { invoke } from '../backend.js';
import { cmpTask, filteredTasks } from '../filter.js';
import { renderView } from '../render.js';
import { RISK_RED, S, TODAY, curProject, getTask, isOpen, projTasks, riskValue, rollupSummary, staleDays } from '../state.js';
import { persistTask } from '../tasks.js';
import { sleP85Days, wipAgeDays } from '../stats.js';
import { setStatus } from '../tasks.js';
import { $id, addDays, esc, toast, toastErr } from '../utils.js';
import { cardHtml, dueChipHtml, listEmptyHtml } from '../views/today.js';

/* 列表排序选择器（动线2）：智能（现行规则链）/截止日/创建时间/负责人/手动 */
export const LIST_SORTS = [['smart', '智能'], ['due', '截止日'], ['created', '创建'], ['owner', '负责人'], ['manual', '手动']];
export function listSortCmp(a, b) {
  if (S.listSort === 'due') return (a.due || '9999') < (b.due || '9999') ? -1 : (a.due === b.due ? (a.sortOrder || 0) - (b.sortOrder || 0) : 1);
  if (S.listSort === 'created') return (a.createdAt || '') < (b.createdAt || '') ? 1 : (a.createdAt === b.createdAt ? (a.sortOrder || 0) - (b.sortOrder || 0) : -1);
  if (S.listSort === 'owner') {
    const oa = a.owner || '我方', ob = b.owner || '我方';
    return oa < ob ? -1 : oa > ob ? 1 : (a.sortOrder || 0) - (b.sortOrder || 0);
  }
  if (S.listSort === 'manual') return (a.sortOrder || 0) - (b.sortOrder || 0);
  return cmpTask(a, b);
}
export function setListSort(v) {
  S.listSort = v;
  invoke('set_meta', { key: 'listSort', value: v }).catch(() => {});
  renderView();
}
export function renderList() {
  const ts = filteredTasks();
  if (!ts.length) { S.visibleIds = []; $id('viewList').innerHTML = listEmptyHtml(); return; }
  const weekEnd = addDays(TODAY, 7);
  const g = { today: [], week: [], later: [], wait: [], done: [] };
  ts.forEach(t => {
    if (t.status === 'done') { g.done.push(t); return; }
    if (t.status === 'wait') { g.wait.push(t); return; }
    if (t.due && t.due <= TODAY) g.today.push(t);
    else if (t.due && t.due <= weekEnd) g.week.push(t);
    else g.later.push(t);
  });
  const cmp = listSortCmp;
  g.today.sort(cmp); g.week.sort(cmp); g.later.sort(cmp); g.wait.sort(cmp);
  g.done.sort((a, b) => (b.doneAt || '') > (a.doneAt || '') ? 1 : -1);

  /* 页头：总数 + 排序选择器 */
  let h = '<div class="list-head"><span class="dim2">共 ' + ts.length + ' 项</span>'
    + '<span class="sortseg" title="列表排序方式；「手动」下可拖拽卡片调整顺序">' + LIST_SORTS.map(s =>
      '<button class="' + (S.listSort === s[0] ? 'on' : '') + '" onclick="setListSort(\'' + s[0] + '\')">' + s[1] + '</button>').join('') + '</span></div>';
  /* 空组跳过渲染（A4）：不再出现「0 / 无」占位两行 */
  const vis = [];
  if (g.today.length) { h += '<h2 class="grp">🔴 今天到期 / 已逾期 <span class="gcnt">' + g.today.length + '</span></h2>' + g.today.map(t => { vis.push(t.id); return cardHtml(t); }).join(''); }
  if (g.week.length) { h += '<h2 class="grp">🟠 未来 7 天 <span class="gcnt">' + g.week.length + '</span></h2>' + g.week.map(t => { vis.push(t.id); return cardHtml(t); }).join(''); }
  if (g.later.length) { h += '<h2 class="grp">⚪ 更远 <span class="gcnt">' + g.later.length + '</span></h2>' + g.later.map(t => { vis.push(t.id); return cardHtml(t); }).join(''); }
  if (g.wait.length) { h += '<h2 class="grp">⏳ 等人 / 等外部 <span class="gcnt">' + g.wait.length + '</span> —— 到点没回复就升级</h2>' + g.wait.map(t => { vis.push(t.id); return cardHtml(t); }).join(''); }
  if (g.done.length) {
    h += '<details class="grp-done"><summary>✅ 已完成 <span class="gcnt">' + g.done.length + '</span></summary>';
    h += g.done.slice(0, 80).map(t => { vis.push(t.id); return cardHtml(t); }).join('') + '</details>';
  }
  if (!vis.length) h += listEmptyHtml();
  S.visibleIds = vis;
  $id('viewList').innerHTML = h;
  if (S.listSort === 'manual') bindListDrag();
}

/* ---------- 列表手动排序拖拽（动线2）：排序选「手动」时按住卡片拖到目标位置 ---------- */
export let listSuppressClickUntil = 0;
let ldrag = null;
let listDragBound = false;
export function bindListDrag() {
  if (listDragBound) return;
  listDragBound = true;
  document.addEventListener('mousedown', e => {
    if (e.button !== 0) return;
    if (S.mode !== 'project' || S.view !== 'list' || S.listSort !== 'manual') return;
    const card = e.target.closest ? e.target.closest('.card[data-id]') : null;
    if (!card) return;
    /* 不劫持控件点击：按钮/输入/菜单仍走原逻辑 */
    if (e.target.closest('button, input, select, textarea, a, .more-wrap, .card-menu, .acts')) return;
    const id = +card.getAttribute('data-id');
    const t = getTask(id);
    if (!t || t.sortOrder < 0) return; /* 置顶卡不参与拖拽 */
    ldrag = { id, srcEl: card, started: false, startX: e.clientX, startY: e.clientY };
    e.preventDefault();
  });
  document.addEventListener('mousemove', e => {
    if (!ldrag) return;
    /* 鼠标在窗口外松开过（mouseup 不送达）：按钮已抬起则清理残留拖拽态，
     * 避免悬浮高亮残留、下一次 mouseup 被误当作落点 */
    if (e.buttons === 0) {
      const d = ldrag; ldrag = null;
      document.body.classList.remove('dragging-card');
      if (d.srcEl) d.srcEl.classList.remove('drag-src-list');
      document.querySelectorAll('.card.list-drop-before, .card.list-drop-after').forEach(el => el.classList.remove('list-drop-before', 'list-drop-after'));
      if (d.started) listSuppressClickUntil = Date.now() + 400;
      return;
    }
    if (!ldrag.started) {
      if (Math.abs(e.clientX - ldrag.startX) < 5 && Math.abs(e.clientY - ldrag.startY) < 5) return;
      ldrag.started = true;
      ldrag.srcEl.classList.add('drag-src-list');
      document.body.classList.add('dragging-card');
    }
    e.preventDefault();
    document.querySelectorAll('.card.list-drop-before, .card.list-drop-after').forEach(el => el.classList.remove('list-drop-before', 'list-drop-after'));
    const stack = document.elementsFromPoint ? document.elementsFromPoint(e.clientX, e.clientY) : [document.elementFromPoint(e.clientX, e.clientY)];
    for (const el of stack) {
      const target = el.closest ? el.closest('.card[data-id]') : null;
      if (target && target !== ldrag.srcEl && +target.getAttribute('data-id') !== ldrag.id) {
        const r = target.getBoundingClientRect();
        target.classList.add(e.clientY < r.top + r.height / 2 ? 'list-drop-before' : 'list-drop-after');
        break;
      }
    }
  });
  document.addEventListener('mouseup', async e => {
    if (!ldrag) return;
    const d = ldrag; ldrag = null;
    document.body.classList.remove('dragging-card');
    if (d.srcEl) d.srcEl.classList.remove('drag-src-list');
    document.querySelectorAll('.card.list-drop-before, .card.list-drop-after').forEach(el => el.classList.remove('list-drop-before', 'list-drop-after'));
    if (!d.started) return;
    listSuppressClickUntil = Date.now() + 400;
    const stack = document.elementsFromPoint ? document.elementsFromPoint(e.clientX, e.clientY) : [document.elementFromPoint(e.clientX, e.clientY)];
    let targetId = 0, before = false;
    for (const el of stack) {
      const target = el.closest ? el.closest('.card[data-id]') : null;
      if (target && +target.getAttribute('data-id') !== d.id) {
        targetId = +target.getAttribute('data-id');
        const r = target.getBoundingClientRect();
        before = e.clientY < r.top + r.height / 2;
        break;
      }
    }
    const t = getTask(d.id);
    if (!t || !targetId) { renderView(); return; }
    /* 全量重排序号（sortOrder 为整数：拖拽后按新顺序 1..n 重排，仅写变化的行） */
    const rest = projTasks(t.projectId).filter(x => x.sortOrder >= 0 && x.id !== t.id)
      .sort((a, b) => (a.sortOrder || 0) - (b.sortOrder || 0));
    let ti = rest.findIndex(x => x.id === targetId);
    if (ti < 0) ti = rest.length;
    rest.splice(before ? ti : ti + 1, 0, t);
    const changed = [];
    rest.forEach((x, i) => { const o = i + 1; if (x.sortOrder !== o) { x.sortOrder = o; changed.push(x); } });
    try {
      for (const x of changed) await persistTask(x);
      if (changed.length) toast('已调整顺序：' + t.title.slice(0, 14), 'info');
    } catch (err) { toastErr('保存顺序失败', err); }
    renderView();
  });
}

/* ---------- 看板视图 ---------- */
export const KANBAN_COLS = [['todo', '📥 待办', '#7b849e'], ['doing', '🔨 进行中', '#4c6ef5'], ['wait', '⏳ 等待', '#f08c00'], ['done', '✅ 已完成', '#2f9e44']];
export const WIP_LIMIT = 5; /* 进行中超过此数亮黄提示（Jira kanban WIP limit 实践） */
export function renderKanban() {
  const p = curProject();
  const sle = p ? sleP85Days(p.id) : null; /* 包1 #3：历史 cycle time 85 分位做离群线 */
  const ts = filteredTasks();
  const vis = []; /* 键盘行导航/批量选择可见序：与列表视图一致，看板也要填 */
  let h = '';
  if (sle) {
    h += '<div class="sle-note" title="ActionableAgile SLE：最近完成的任务从开始到完成的 85 分位时长">📏 SLE：85% 的任务在 ' + sle.p85 + ' 天内完成（近 ' + sle.n + ' 条样本）；进行中超过该时长标红</div>';
  }
  KANBAN_COLS.forEach(col => {
    const cards = ts.filter(t => t.status === col[0]).sort(cmpTask);
    const wipOver = col[0] === 'doing' && cards.length > WIP_LIMIT;
    h += '<div class="kcol" data-status="' + col[0] + '">'
      + '<div class="khead"><span class="kdot" style="background:' + col[2] + '"></span>' + col[1]
      + '<span class="kcnt">' + cards.length + '</span>'
      + (wipOver ? '<span class="wipwarn" title="WIP 限制：进行中别超过 ' + WIP_LIMIT + ' 项，先完成再开始">⚠ 超过 ' + WIP_LIMIT + ' 项</span>' : '')
      + '</div>'
      + (cards.length ? cards.map(t => {
          vis.push(t.id);
          const roll = rollupSummary(t);
          const stale = staleDays(t);
          const pct = roll && roll.total ? Math.round(roll.done / roll.total * 100) : 0;
          return '<div class="kcard ' + (t.sortOrder < 0 ? 'pinned' : '') + (riskValue(t) >= RISK_RED && isOpen(t) ? ' risk-high' : '') + (S.sel.indexOf(t.id) >= 0 ? ' sel' : '') + (S.kbId === t.id ? ' kb-on' : '') + '" data-id="' + t.id + '" onclick="cardTitleClick(event,' + t.id + ')">'
          + '<div class="kt">' + (t.sortOrder < 0 ? '📌 ' : '') + (S.frogs.ids.indexOf(t.id) >= 0 ? '🐸 ' : '') + esc(t.title) + '</div>'
          + (roll && roll.total && t.status !== 'done' ? '<div class="kbar"><i style="width:' + pct + '%"></i></div>' : '')
          + '<div class="km">' + dueChipHtml(t)
          + '<span class="chip ' + (t.pri === 'P0' ? 'p0' : (t.pri === 'P1' ? 'p1' : '')) + '">' + esc(t.pri || 'P1') + '</span>'
          + '<span class="chip">👤 ' + esc(t.owner || '我方') + '</span>'
          + (t.risk ? '<span class="chip risk' + (riskValue(t) >= RISK_RED ? ' riskred' : '') + '">' + (riskValue(t) ? '⚠R' + riskValue(t) : '⚠') + '</span>' : '')
          + (t.repeat ? '<span class="chip">🔄</span>' : '')
          + (t.status !== 'done' && stale >= 7 ? '<span class="chip stale">💤' + stale + '天</span>' : '')
          + (t.status === 'doing' && sle && wipAgeDays(t) > sle.p85 ? '<span class="chip aging-red" title="WIP Aging：在制 ' + wipAgeDays(t) + ' 天已超过 SLE 85 分位（' + sle.p85 + ' 天），大概率离群，考虑拆分/升级/砍范围">⏳ WIP ' + wipAgeDays(t) + ' 天 &gt; SLE</span>' : '')
          + (t.status !== 'done' && (t.deferCount || 0) >= 3 ? '<span class="chip defer">⚠推迟' + t.deferCount + '次</span>' : '')
          + (S.timer && S.timer.taskId == t.id ? '<span class="chip timing">⏱</span>' : '')
          + (roll ? '<span class="chip clprog">☑ ' + roll.done + '/' + roll.total + (roll.subs ? ' 子' + roll.subs : '') + '</span>' : '')
          + '</div></div>';
        }).join('')
        : '<div class="empty">把卡片拖到这里</div>')
      + '</div>';
  });
  S.visibleIds = vis; /* 键盘行导航（J/K/空格/Enter）与批量选择在看板视图同样可用 */
  $id('viewKanban').innerHTML = h;
}

/* ---------- 看板：指针拖拽（自实现，替代 HTML5 DnD，WebView2/浏览器行为一致） ---------- */
export let kdrag = null;              // { id, srcEl, started, startX, startY, ghost, offsetY, hoverCol }
export let kanbanSuppressClickUntil = 0;

export function bindKanbanDrag() {
  document.addEventListener('mousedown', e => {
    if (e.button !== 0) return;
    const card = e.target.closest ? e.target.closest('.kcard') : null;
    if (!card || !card.getAttribute) return;
    const id = +card.getAttribute('data-id');
    if (!id || !getTask(id)) return;
    kdrag = { id, srcEl: card, started: false, startX: e.clientX, startY: e.clientY, ghost: null, hoverCol: null, offsetY: 20 };
    e.preventDefault(); // 阻止原生文字拖选，由我们自己判定拖拽
  });
  document.addEventListener('mousemove', e => {
    if (!kdrag) return;
    /* 鼠标在窗口外松开过（无 pointer capture，mouseup 不送达）：按钮已抬起则清理残留拖拽态 */
    if (e.buttons === 0) {
      if (kdrag.ghost) kdrag.ghost.remove();
      if (kdrag.srcEl) kdrag.srcEl.classList.remove('drag-src');
      if (kdrag.hoverCol) kdrag.hoverCol.classList.remove('drop');
      document.body.classList.remove('dragging-card');
      if (kdrag.started) kanbanSuppressClickUntil = Date.now() + 400;
      kdrag = null;
      return;
    }
    if (!kdrag.started) {
      if (Math.abs(e.clientX - kdrag.startX) < 5 && Math.abs(e.clientY - kdrag.startY) < 5) return;
      startKanbanGhost(e);
    }
    moveKanbanGhost(e);
    highlightKanbanCol(e);
    e.preventDefault();
  });
  document.addEventListener('mouseup', e => {
    if (!kdrag) return;
    const d = kdrag;
    kdrag = null;
    document.body.classList.remove('dragging-card');
    if (!d.started) return; // 未超过阈值 = 普通点击，正常打开编辑
    kanbanSuppressClickUntil = Date.now() + 400;
    if (d.ghost) d.ghost.remove();
    if (d.srcEl) d.srcEl.classList.remove('drag-src');
    if (d.hoverCol) d.hoverCol.classList.remove('drop');
    const col = kanbanColAt(e.clientX, e.clientY);
    if (col) {
      const status = col.getAttribute('data-status');
      const t = getTask(d.id);
      if (t && t.status !== status) setStatus(d.id, status);
    }
  });
}
export function kanbanColAt(x, y) {
  const stack = document.elementsFromPoint ? document.elementsFromPoint(x, y) : [document.elementFromPoint(x, y)];
  for (const el of stack) {
    const col = el.closest ? el.closest('.kcol') : null;
    if (col) return col;
  }
  return null;
}
export function startKanbanGhost(e) {
  kdrag.started = true;
  const rect = kdrag.srcEl.getBoundingClientRect();
  kdrag.offsetY = Math.min(24, e.clientY - rect.y);
  const ghost = kdrag.srcEl.cloneNode(true);
  ghost.className = 'kcard kdrag-ghost';
  ghost.style.width = rect.width + 'px';
  ghost.style.left = (e.clientX - rect.width / 2) + 'px';
  ghost.style.top = (e.clientY - kdrag.offsetY) + 'px';
  document.body.appendChild(ghost);
  kdrag.ghost = ghost;
  kdrag.srcEl.classList.add('drag-src');
  document.body.classList.add('dragging-card');
}
export function moveKanbanGhost(e) {
  if (!kdrag.ghost) return;
  kdrag.ghost.style.left = (e.clientX - kdrag.ghost.getBoundingClientRect().width / 2) + 'px';
  kdrag.ghost.style.top = (e.clientY - kdrag.offsetY) + 'px';
}
export function highlightKanbanCol(e) {
  const col = kanbanColAt(e.clientX, e.clientY);
  if (kdrag.hoverCol && kdrag.hoverCol !== col) kdrag.hoverCol.classList.remove('drop');
  if (col && kdrag.hoverCol !== col) col.classList.add('drop');
  kdrag.hoverCol = col;
}

/* ---------- 统计视图 ---------- */
