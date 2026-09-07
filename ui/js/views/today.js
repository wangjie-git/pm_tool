/* 今日聚焦、任务卡片、卡片菜单 —— 拆分自 ui/app.js（来源行 1360-1428, 1443-1587） */

import { cmpTask, parseFilter } from '../filter.js';
import { openTaskEdit } from '../modals/task-edit.js';
import { hideQPop } from '../quickadd.js';
import { render, renderView } from '../render.js';
import { clSuffix } from '../report.js';
import { RISK_RED, S, STATUS_CYCLE, STATUS_LABEL, TODAY, checklistSummary, curProject, getTask, isOpen, projNameOf, repeatLabel, riskValue, rollupSummary, staleDays } from '../state.js';
import { shiftSelectTo, toggleTaskSel, cycleStatus, delTaskById, setStatus, snoozeTask, timerText, toggleFrog, togglePin, toggleTimer } from '../tasks.js';
import { $id, copyText, daysDiff, esc, mdRender, toast } from '../utils.js';
import { kanbanSuppressClickUntil, listSuppressClickUntil } from './board.js';
import { calSuppressClickUntil } from './calendar.js';


/* ============ 今日聚焦（跨项目） ============ */
export function openTodayFocus() {
  S.mode = 'today';
  const p = curProject();
  if (p) S.todayPid = '' + p.id;
  hideQPop();
  render();
}

/* 所有未归档项目中：逾期 / 今天到期 / 进行中的任务，按项目分组 */
export function todayGroups() {
  const f = parseFilter(S.search);
  const out = [];
  S.projects.filter(p => !p.archived).forEach(p => {
    let ts = S.tasks.filter(t => t.projectId == p.id && t.status !== 'done' && t.status !== 'wait');
    if (f.owner) ts = ts.filter(t => (t.owner || '').indexOf(f.owner) >= 0);
    if (f.pri) ts = ts.filter(t => (t.pri || 'P1') === f.pri);
    if (f.risk) ts = ts.filter(t => t.risk);
    if (f.rep) ts = ts.filter(t => t.repeat === f.rep);
    if (f.kw) ts = ts.filter(t => (t.title + ' ' + (t.owner || '') + ' ' + p.name).toLowerCase().indexOf(f.kw) >= 0);
    const over = ts.filter(t => t.due && t.due < TODAY && t.status !== 'doing').sort(cmpTask);
    const today = ts.filter(t => t.due === TODAY && t.status !== 'doing').sort(cmpTask);
    const doing = ts.filter(t => t.status === 'doing').sort(cmpTask); /* 进行中全部带上，避免漏掉今天到期的 */
    if (over.length || today.length || doing.length) out.push({ p: p, over: over, today: today, doing: doing });
  });
  return out;
}

/* 今日三只青蛙（#7 MIT）：置顶展示；空槽压缩为一行引导（A5），已选青蛙横排小卡 */
export function frogBarHtml() {
  const frogs = S.frogs.ids.map(id => getTask(id)).filter(t => t && t.status !== 'done');
  let h = '<div class="frog-bar"><div class="frog-head">🐸 今日三件要事（MIT）<span class="frog-hint">先吃掉青蛙，再做别的</span></div><div class="frog-list">';
  h += frogs.map(t =>
    '<div class="frog-item" onclick="openTaskEdit(' + t.id + ')" title="' + esc(projNameOf(t.projectId)) + ' · 点击编辑">'
    + '<b class="fno">' + (S.frogs.ids.indexOf(t.id) + 1) + '</b>'
    + '<span class="ft">' + esc(t.title) + '</span>'
    + '<button class="frog-done" title="标记完成" onclick="event.stopPropagation();setStatus(' + t.id + ',\'done\')">✔</button>'
    + '<button class="frog-rm" title="移出" onclick="event.stopPropagation();toggleFrog(' + t.id + ')">✕</button></div>').join('');
  if (frogs.length < 3) h += '<div class="frog-empty-hint">🐸 从下方任务卡 hover 点 🐸 选今天三件要事（已选 ' + frogs.length + '/3）</div>';
  h += '</div></div>';
  return h;
}

export function renderToday() {
  const groups = todayGroups();
  const frogs = S.frogs.ids.map(id => getTask(id)).filter(t => t && t.status !== 'done');
  if (!groups.length && !frogs.length) {
    S.visibleIds = [];
    $id('viewToday').innerHTML = frogBarHtml() + '<div class="empty" style="padding:60px 0;text-align:center;font-size:14px;">🎉 今天没有到期任务，去「未来 7 天」里提前布局，或者休息一下</div>';
    return;
  }
  let h = frogBarHtml();
  const vis = frogs.map(t => t.id);
  if (!groups.length) {
    S.visibleIds = vis;
    $id('viewToday').innerHTML = h;
    return;
  }
  groups.forEach(g => {
    const total = g.over.length + g.today.length + g.doing.length;
    h += '<h2 class="grp">📂 ' + esc(g.p.name) + ' <span class="gcnt">' + total + ' 项</span>'
      + '<button class="linkbtn" onclick="switchProject(' + g.p.id + ')">进入项目 →</button></h2>';
    g.over.forEach(t => { h += cardHtml(t, true); vis.push(t.id); });
    g.today.forEach(t => { h += cardHtml(t, true); vis.push(t.id); });
    g.doing.forEach(t => { h += cardHtml(t, true); vis.push(t.id); });
  });
  S.visibleIds = vis;
  $id('viewToday').innerHTML = h;
}

export function copyTodayList() {
  const groups = todayGroups();
  const frogs = S.frogs.ids.map(id => getTask(id)).filter(t => t && t.status !== 'done');
  if (!groups.length && !frogs.length) { toast('今天没有可复制的待办', 'info'); return; }
  let n = 0;
  let out = '【今日聚焦】' + TODAY + '\n';
  if (frogs.length) {
    out += '\n🐸 今日三件要事\n';
    frogs.forEach(t => { n++; out += '  ' + (S.frogs.ids.indexOf(t.id) + 1) + '. ' + t.title + '（' + (t.owner || '我方') + '）' + clSuffix(t) + '\n'; });
  }
  groups.forEach(g => {
    out += '\n◆ ' + g.p.name + '\n';
    g.over.forEach(t => { if (S.frogs.ids.indexOf(t.id) < 0) { n++; out += '  ⚠ [逾期' + t.due.slice(5) + '] ' + t.title + '（' + (t.owner || '我方') + '）' + clSuffix(t) + '\n'; } });
    g.today.forEach(t => { if (S.frogs.ids.indexOf(t.id) < 0) { n++; out += '  ▸ ' + t.title + '（' + (t.owner || '我方') + '）' + clSuffix(t) + '\n'; } });
    g.doing.forEach(t => { if (S.frogs.ids.indexOf(t.id) < 0) { n++; out += '  🔨 ' + t.title + '（' + (t.owner || '我方') + '）' + clSuffix(t) + '\n'; } });
  });
  copyText(out, '已复制今日清单（' + n + ' 项），去微信/邮件粘贴即可');
}

/* ---------- 列表视图 ---------- */
export function dueChipHtml(t) {
  if (t.status === 'done') return '<span class="chip">✔ 完成于 ' + esc(t.doneAt || '') + '</span>';
  if (!t.due) return '<span class="chip">📆 无日期</span>';
  let cls = '', label = t.due;
  if (t.due < TODAY) { cls = 'due-over'; label = '逾期 ' + t.due; }
  else if (t.due === TODAY) { cls = 'due-today'; label = '今天到期'; }
  else {
    const diff = daysDiff(t.due);
    label = t.due + '（还剩 ' + diff + ' 天）';
  }
  return '<span class="chip ' + cls + '">📆 ' + esc(label) + '</span>';
}
export function cardHtml(t, showProj) {
  const dense = S.density === 'compact';
  const cls = 'card' + (dense ? ' dense' : '') + (t.risk && t.status !== 'done' ? ' risk' : '') + (t.status === 'wait' ? ' wait' : '')
    + (t.status === 'doing' ? ' doing' : '') + (t.status === 'done' ? ' done' : '') + (t.sortOrder < 0 ? ' pinned' : '')
    + (riskValue(t) >= RISK_RED && isOpen(t) ? ' risk-high' : '')
    + (S.sel.indexOf(t.id) >= 0 ? ' sel' : '') + (S.kbId === t.id ? ' kb-on' : '');
  const st = [['todo', '待办'], ['doing', '进行中'], ['wait', '等待'], ['done', '完成']];
  const btns = st.map(pp => '<button class="' + (t.status === pp[0] ? 'on' : '') + '" onclick="setStatus(' + t.id + ',\'' + pp[0] + '\')">' + pp[1] + '</button>').join('');
  const cl = checklistSummary(t);
  const roll = rollupSummary(t);
  const clChip = roll ? '<span class="chip clprog">☑ ' + roll.done + '/' + roll.total + (roll.subs ? ' 子' + roll.subs : '') + '</span>' : '';
  const pinChip = t.sortOrder < 0 ? '<span class="chip pinchip">📌 置顶</span>' : '';
  const repChip = t.repeat ? '<span class="chip">🔄 ' + repeatLabel(t.repeat) + '</span>' : '';
  const stale = staleDays(t);
  const staleChip = (t.status !== 'done' && stale >= 7) ? '<span class="chip stale" title="超过 7 天没有任何更新，考虑清理、改期或升级">💤 停滞 ' + stale + ' 天</span>' : '';
  const projChip = showProj ? '<span class="chip projchip">📂 ' + esc(projNameOf(t.projectId)) + '</span>' : '';
  const rv = riskValue(t);
  const riskChip = t.risk && isOpen(t)
    ? '<span class="chip risk' + (rv >= RISK_RED ? ' riskred' : '') + '" title="' + (rv ? '风险值 ' + rv + '（概率' + t.riskProb + '×影响' + t.riskImpact + '）' : '未评分，编辑里完善概率/影响') + '">⚠ ' + (rv ? 'R' + rv : '风险') + '</span>'
    : '';
  const deferChip = (t.status !== 'done' && (t.deferCount || 0) >= 3)
    ? '<span class="chip defer" title="已连续推迟 ' + t.deferCount + ' 次：删 / 改期 / 升级，三选一">⚠ 已推迟 ' + t.deferCount + ' 次</span>' : '';
  const frogOn = S.frogs.ids.indexOf(t.id) >= 0;
  const frogChip = frogOn ? '<span class="chip frogchip" title="今日三件要事">🐸 要事 ' + (frogOn ? S.frogs.ids.indexOf(t.id) + 1 : '') + '</span>' : '';
  const frogBtn = '<button class="frog-quick' + (frogOn ? ' on' : '') + '" title="' + (frogOn ? '移出今日要事' : '设为今日三件要事') + '" onclick="event.stopPropagation();toggleFrog(' + t.id + ')">🐸</button>';
  const timing = S.timer && S.timer.taskId == t.id ? '<span class="chip timing">⏱ 计时中 ' + timerText(S.timer.startedAt) + '</span>' : '';
  const remindChip = (t.remindAt && t.status !== 'done')
    ? '<span class="chip timing" title="单次提醒：到点弹系统通知">⏰ ' + esc(String(t.remindAt).slice(5, 16)) + '</span>' : '';
  const parent = t.parentId ? getTask(t.parentId) : null;
  const parentChip = parent ? '<span class="chip parentchip" title="父任务：' + esc(parent.title) + '">↳ ' + esc(parent.title.slice(0, 10)) + '</span>' : '';
  const open = t.status !== 'done';
  const titleClick = 'cardTitleClick(event,' + t.id + ')';
  /* 紧凑模式：状态收成一枚可点击循环的色块 chip（降噪，动线1） */
  const stClsMap = { todo: 'st-todo', doing: 'st-doing', wait: 'st-wait', done: 'st-done' };
  const stCycle = '<span class="chip stcycle ' + (stClsMap[t.status] || 'st-todo') + '" title="点击循环切换状态（紧凑模式降噪）" onclick="event.stopPropagation();cycleStatus(' + t.id + ',event)">' + (STATUS_LABEL[t.status] || esc(t.status)) + '</span>';
  if (dense) {
    const inlineChips = projChip + dueChipHtml(t)
      + '<span class="chip ' + (t.pri === 'P0' ? 'p0' : (t.pri === 'P1' ? 'p1' : '')) + '">' + esc(t.pri || 'P1') + '</span>'
      + '<span class="chip">👤 ' + esc(t.owner || '我方') + '</span>'
      + riskChip + remindChip + clChip + frogChip + timing + stCycle;
    return '<div class="' + cls + '" data-id="' + t.id + '">'
      + '<button class="ccircle ' + (t.status === 'done' ? 'on' : '') + '" title="点击完成/恢复" onclick="toggleDone(' + t.id + ')"></button>'
      + '<div class="cbody">'
      + '<div class="crow1">'
      + '<div class="title" onclick="' + titleClick + '">' + esc(t.title) + '</div>'
      + frogBtn
      + '<span class="chips-inline">' + inlineChips + '</span>'
      + '</div>'
      + '<div class="acts">' + btns
      + '<span class="spacer"></span>'
      + '<span class="more-wrap"><button class="more-btn" title="更多操作：计时 / 推迟 / 要事 / 置顶 / 复制链接 / 删除" onclick="toggleCardMenu(event,' + t.id + ')">⋯</button>'
      + '<div class="menu-pop card-menu" hidden></div></span></div>'
      + '</div></div>';
  }
  return '<div class="' + cls + '" data-id="' + t.id + '">'
    + '<button class="ccircle ' + (t.status === 'done' ? 'on' : '') + '" title="点击完成/恢复" onclick="toggleDone(' + t.id + ')"></button>'
    + '<div class="cbody">'
    + '<div class="title" onclick="' + titleClick + '">' + esc(t.title) + frogBtn + '</div>'
    + (roll && roll.total && open ? '<div class="kbar"><i style="width:' + Math.round(roll.done / roll.total * 100) + '%"></i></div>' : '')
    + '<div class="meta">' + projChip + dueChipHtml(t)
    + '<span class="chip ' + (t.pri === 'P0' ? 'p0' : (t.pri === 'P1' ? 'p1' : '')) + '">' + esc(t.pri || 'P1') + '</span>'
    + '<span class="chip">👤 ' + esc(t.owner || '我方') + '</span>'
    + riskChip + remindChip
    + repChip
    + clChip + staleChip + deferChip + frogChip + timing + pinChip + parentChip
    + '</div>'
    + (t.note ? '<div class="note mdview-inline">' + mdRender(t.note) + '</div>' : '')
    + (open && t.risk && (t.riskMitigate || t.riskEscalate) ? '<div class="note">🛡 ' + esc(t.riskMitigate || '（未填应对措施）') + (t.riskEscalate ? ' ｜ 升级条件：' + esc(t.riskEscalate) : '') + '</div>' : '')
    + '<div class="acts">' + btns
    + '<span class="spacer"></span>'
    + frogBtn
    + '<span class="more-wrap"><button class="more-btn" title="更多操作：计时 / 推迟 / 要事 / 置顶 / 复制链接 / 删除" onclick="toggleCardMenu(event,' + t.id + ')">⋯</button>'
    + '<div class="menu-pop card-menu" hidden></div></span></div>'
    + '</div></div>';
}
export async function toggleDone(id) {
  const t = getTask(id); if (!t) return;
  await setStatus(id, t.status === 'done' ? 'todo' : 'done');
}
/* 卡片标题点击（动线2）：普通=编辑详情；Ctrl/Cmd=多选；Shift=范围多选 */
export function cardTitleClick(e, id) {
  if (Date.now() < kanbanSuppressClickUntil || Date.now() < listSuppressClickUntil || Date.now() < calSuppressClickUntil) return;
  if (e.ctrlKey || e.metaKey) { e.preventDefault(); toggleTaskSel(id); return; }
  if (e.shiftKey) { e.preventDefault(); shiftSelectTo(id); return; }
  openTaskEdit(id);
}
/* 任务卡 ⋯ 菜单（v2.1）：低频操作收进二级菜单，卡片默认只留状态切换 + ⋯，打开时按任务最新状态重建内容 */
export function cardMenuHtml(t) {
  if (!t) return '';
  const open = t.status !== 'done';
  const timing = S.timer && S.timer.taskId == t.id;
  const frog = S.frogs.ids.indexOf(t.id) >= 0;
  let h = '';
  if (open) {
    h += '<button onclick="event.stopPropagation();cardMenuAct(' + t.id + ',\'timer\')">' + (timing ? '⏹ 停止计时' : '⏱ 开始计时（计入工时）') + '</button>'
      + '<button onclick="event.stopPropagation();cardMenuAct(' + t.id + ',\'snooze\')">⏭ 推迟到明天</button>'
      + '<button onclick="event.stopPropagation();cardMenuAct(' + t.id + ',\'frog\')">' + (frog ? '🐸 移出今日要事' : '🐸 设为今日要事') + '</button>';
  }
  h += '<button onclick="event.stopPropagation();cardMenuAct(' + t.id + ',\'pin\')">' + (t.sortOrder < 0 ? '📌 取消置顶' : '📌 置顶') + '</button>'
    + '<button onclick="event.stopPropagation();cardMenuAct(' + t.id + ',\'edit\')">✎ 编辑详情</button>'
    + '<button onclick="event.stopPropagation();cardMenuAct(' + t.id + ',\'copylink\')">🔗 复制任务链接（pm-todo://）</button>'
    + '<div class="menu-sep"></div>'
    + '<button class="danger" onclick="event.stopPropagation();cardMenuAct(' + t.id + ',\'del\')">🗑 删除（可在回收站恢复）</button>';
  return h;
}
export function toggleCardMenu(e, id) {
  const wrap = e.currentTarget.closest('.more-wrap');
  const menu = wrap.querySelector('.card-menu');
  const show = menu.hidden;
  closeCardMenus();
  if (show) { menu.innerHTML = cardMenuHtml(getTask(id)); menu.hidden = false; }
}
export function closeCardMenus() { document.querySelectorAll('.card-menu').forEach(m => { m.hidden = true; }); }
export async function cardMenuAct(id, act) {
  closeCardMenus();
  /* 右键菜单复用同一批动作：执行后立即收起，避免菜单悬浮遮挡页面（不 import events.js 避免循环依赖） */
  const cm = document.getElementById('ctxMenu');
  if (cm) cm.hidden = true;
  if (act === 'timer') toggleTimer(id);
  else if (act === 'snooze') snoozeTask(id);
  else if (act === 'frog') toggleFrog(id);
  else if (act === 'pin') togglePin(id);
  else if (act === 'edit') openTaskEdit(id);
  else if (act === 'copylink') copyText('pm-todo://task/' + id, '🔗 已复制任务链接，粘贴到群/日报可跳回本任务');
  else if (act === 'del') delTaskById(id, true);
}
/* 列表富空状态（v2.1）：区分「真没任务」与「筛选无结果」，给出下一步动作 */
export function listEmptyHtml() {
  const kw = (S.search || '').trim();
  if (kw) {
    return '<div class="empty-state"><div class="es-icon">🔍</div>'
      + '<div class="es-title">没有匹配「' + esc(kw) + '」的任务</div>'
      + '<div class="es-hint">换个更短的关键词，或清除筛选查看全部任务</div>'
      + '<div class="es-actions"><button class="btn ghost" onclick="clearSearch()">🧹 清除筛选</button></div></div>';
  }
  return '<div class="empty-state"><div class="es-icon">🚀</div>'
    + '<div class="es-title">这个项目还没有任务</div>'
    + '<div class="es-hint">在上方输入框用自然语言快速添加，回车即可：</div>'
    + '<div class="es-syntax"><code>下周三 联调测试 @李四 !P0 #风险</code></div>'
    + '<div class="es-legend">📅 今天 / 明天 / 下周三 / +3天 ｜ 👤 @负责人 ｜ ⚡ 优先级 !P0 !P1 !P2 ｜ 标记 #风险 #每日 #每周 #每月</div>'
    + '<div class="es-actions"><button class="btn blue" onclick="focusQuickAdd()">⌨ 快速添加</button>'
    + '<button class="btn ghost" onclick="openTaskEdit(0)">＋ 详细新建</button>'
    + '<button class="btn ghost" onclick="quickAddFromClipboard()">📌 从剪贴板导入</button></div>'
    + '<div class="es-hint">批量导入：右上「⋯ 项目工具」→ Excel 计划表导入向导</div></div>';
}
export function clearSearch() {
  S.search = '';
  $id('search').value = '';
  renderView();
}
export function focusQuickAdd() {
  const q = $id('quick');
  if (!q) return;
  q.focus();
  q.scrollIntoView({ block: 'nearest' });
}
