/* 甘特图/时间线、PNG 导出 —— 拆分自 ui/app.js（来源行 3825-4092） */

import { TDialog, invoke } from './backend.js';
import { renderView } from './render.js';
import { S, TODAY, curProject, getTask, isOpen, projTasks, rollupSummary, subTasksOf } from './state.js';
import { persistTask } from './tasks.js';
import { $id, addDays, esc, toast, toastErr } from './utils.js';

/* ============ 包6：时间线甘特视图（自绘 SVG，只读+轻编辑+导出PNG） ============ */
export const GANTT_ZOOM = { day: { px: 34 }, week: { px: 12 }, month: { px: 4 } };
export function ganttState() {
  if (!S.ganttZoom) S.ganttZoom = 'day';
  if (!S.ganttPx) S.ganttPx = GANTT_ZOOM[S.ganttZoom].px;
  return S.ganttPx;
}
export function ganttBarDates(t) {
  /* start 回退链：start_date → due-2 天 → created_at → 今天 */
  let start = t.startDate;
  if (!start && t.due) start = addDays(t.due, -2);
  if (!start) start = (t.createdAt || TODAY).slice(0, 10);
  const due = t.due || start;
  return { start: start <= due ? start : due, due: due };
}
/* 树序：父任务在前，子任务缩进；父任务条 = min(子start)~max(子due) + 进度上卷 */
export function ganttRows(pid) {
  const ts = projTasks(pid);
  /* parentId 指向的任务不存在（单独恢复子任务/导入脏数据）时也按根处理，否则该子树在时间线里整体隐形 */
  const allIds = ts.map(t => t.id);
  const roots = ts.filter(t => !t.parentId || allIds.indexOf(t.parentId) < 0);
  const rows = [];
  const seen = []; /* 防御：脏数据成环时避免无限递归把时间线视图打崩 */
  const addTask = (t, depth) => {
    if (seen.indexOf(t.id) >= 0) return;
    seen.push(t.id);
    const subs = subTasksOf(t.id);
    let roll = null;
    if (subs.length) {
      let mn = null, mx = null;
      subs.forEach(s2 => {
        const d2 = ganttBarDates(s2);
        if (!mn || d2.start < mn) mn = d2.start;
        if (!mx || d2.due > mx) mx = d2.due;
      });
      const r = rollupSummary(t);
      roll = { start: mn, due: mx, pct: r && r.total ? Math.round(r.done / r.total * 100) : 0 };
    }
    rows.push({ t: t, depth: depth, isParent: subs.length > 0, roll: roll });
    subs.forEach(s2 => addTask(s2, depth + 1));
  };
  roots.forEach(t => addTask(t, 0));
  return rows;
}
export function renderTimeline() {
  const p = curProject(); if (!p) return;
  const px = ganttState();
  const rows = ganttRows(p.id);
  const headerH = 44, labelW = 250;
  /* 动线3 A8：行高随任务数自适应（任务少时行距拉开，充满窗口高度） */
  const availH = Math.max(240, window.innerHeight - 265);
  const rowH = rows.length ? Math.max(30, Math.min(56, Math.floor((availH - headerH) / rows.length))) : 30;
  /* 时间窗口：所有条的 min~max ± 7 天，并包含今天 */
  let mn = TODAY, mx = TODAY;
  rows.forEach(r => {
    const d = r.roll || ganttBarDates(r.t);
    if (d.start < mn) mn = d.start;
    if (d.due > mx) mx = d.due;
  });
  mn = addDays(mn, -7); mx = addDays(mx, 7);
  if (!S.ganttOffset) S.ganttOffset = 0;
  /* 左右平移必须同时移动起止，否则窗口越移越窄、最终画到可视区外整图空白 */
  mn = addDays(mn, S.ganttOffset * 14);
  mx = addDays(mx, S.ganttOffset * 14);
  const nDays = Math.max(14, Math.round((new Date(mx) - new Date(mn)) / 86400000) + 1);
  const gridW = nDays * px;
  const svgH = headerH + rows.length * rowH + 8;
  const dayX = d => Math.round((new Date(d) - new Date(mn)) / 86400000) * px;
  S.ganttWin = { mn: mn, nDays: nDays, px: px }; /* 拖画新建：把窗口暴露给日期反算 */

  /* SVG 字符串（内联样式，便于导出 PNG） */
  const sv = [];
  sv.push('<svg id="gantt-svg" xmlns="http://www.w3.org/2000/svg" width="' + (gridW) + '" height="' + svgH + '" style="display:block;background:var(--panel);font-family:Segoe UI,Microsoft YaHei,sans-serif">');
  /* 表头 */
  sv.push('<rect x="0" y="0" width="' + gridW + '" height="' + headerH + '" fill="#f6f8fb"/>');
  if (S.ganttZoom === 'day') {
    for (let i = 0; i < nDays; i++) {
      const d = addDays(mn, i);
      const dow = new Date(d).getDay();
      const x = i * px;
      if (dow === 0 || dow === 6) sv.push('<rect x="' + x + '" y="' + headerH + '" width="' + px + '" height="' + (svgH - headerH) + '" fill="rgba(122,132,158,.07)"/>');
      const isToday = d === TODAY;
      sv.push('<text x="' + (x + px / 2) + '" y="16" text-anchor="middle" font-size="10" fill="' + (isToday ? '#4c6ef5' : '#77809a') + '">' + d.slice(8) + '</text>');
      if (d.slice(8) === '01' || i === 0) sv.push('<text x="' + (x + 3) + '" y="32" text-anchor="start" font-size="10" font-weight="bold" fill="#77809a">' + d.slice(0, 7) + '</text>');
      sv.push('<line x1="' + x + '" y1="' + headerH + '" x2="' + x + '" y2="' + svgH + '" stroke="rgba(229,233,241,.8)" stroke-width="1"/>');
    }
  } else {
    const step = S.ganttZoom === 'week' ? 7 : 1;
    let lastMonth = '';
    for (let i = 0; i < nDays; i += step) {
      const d = addDays(mn, i);
      const x = i * px;
      const w = step * px;
      const isToday = d === TODAY || (S.ganttZoom === 'month' && d.slice(0, 7) === TODAY.slice(0, 7) && addDays(d, step - 1) >= TODAY);
      if (S.ganttZoom === 'week') sv.push('<rect x="' + x + '" y="' + headerH + '" width="' + w + '" height="' + (svgH - headerH) + '" fill="' + (Math.floor(i / 7) % 2 ? 'rgba(122,132,158,.05)' : 'transparent') + '"/>');
      sv.push('<text x="' + (x + w / 2) + '" y="16" text-anchor="middle" font-size="10" fill="' + (isToday ? '#4c6ef5' : '#77809a') + '">' + (S.ganttZoom === 'week' ? d.slice(5) : d.slice(0, 7)) + '</text>');
      if (d.slice(0, 7) !== lastMonth) { sv.push('<text x="' + (x + 3) + '" y="32" font-size="11" font-weight="bold" fill="#77809a">' + d.slice(0, 7) + '</text>'); lastMonth = d.slice(0, 7); }
      sv.push('<line x1="' + x + '" y1="' + headerH + '" x2="' + x + '" y2="' + svgH + '" stroke="rgba(229,233,241,.8)"/>');
    }
  }
  /* 今日线 */
  const tx = dayX(TODAY);
  if (tx >= 0 && tx <= gridW) sv.push('<line x1="' + tx + '" y1="0" x2="' + tx + '" y2="' + svgH + '" stroke="#e03131" stroke-width="1.5" stroke-dasharray="4 3"/><text x="' + (tx + 3) + '" y="' + (headerH - 4) + '" font-size="10" fill="#e03131">今天</text>');
  /* 条 */
  const snap = (S.ganttCompare && weekSnapPid == p.id) ? weekSnapCache : null;
  rows.forEach((r, i) => {
    const y = headerH + i * rowH + 6;
    sv.push('<line x1="0" y1="' + (y - 6 + rowH) + '" x2="' + gridW + '" y2="' + (y - 6 + rowH) + '" stroke="rgba(229,233,241,.5)"/>');
    const t = r.t;
    const d = r.roll || ganttBarDates(t);
    /* 上周快照虚影（★★☆ 周报基线）：看计划漂移 */
    if (snap && snap[t.id]) {
      const od = snap[t.id];
      const ox = dayX(od.start), ox2 = dayX(od.due) + px;
      const obw = Math.max(6, ox2 - ox);
      sv.push('<rect class="gbar-ghost-old" x="' + ox + '" y="' + (y + 2) + '" width="' + obw + '" height="16" rx="4" pointer-events="none"><title>上周快照：' + esc(t.title) + ' · ' + od.start + ' → ' + od.due + '</title></rect>');
    }
    const bx = dayX(d.start), bx2 = dayX(d.due) + px;
    const bw = Math.max(6, bx2 - bx);
    const hgt = r.isParent ? 10 : 16;
    const by = r.isParent ? y + 4 : y + 2;
    let fill = '#7b849e';
    if (t.status === 'done') fill = '#2f9e44';
    else if (t.status === 'doing') fill = '#4c6ef5';
    else if (t.status === 'wait') fill = '#f08c00';
    else if (t.isMilestone) fill = '#9775fa';
    if (t.isMilestone && !r.isParent) {
      const cx = dayX(t.due || ganttBarDates(t).due) + px / 2, cy = y + 9;
      sv.push('<path d="M ' + cx + ' ' + (cy - 9) + ' L ' + (cx + 9) + ' ' + cy + ' L ' + cx + ' ' + (cy + 9) + ' L ' + (cx - 9) + ' ' + cy + ' Z" fill="' + (t.status === 'done' ? '#2f9e44' : '#9775fa') + '"><title>' + esc(t.title) + '（里程碑 ' + (t.due || '') + '）</title></path>');
      return;
    }
    const cls = isOpen(t) && t.status !== 'wait' && t.due && t.due < TODAY ? ' gantt-over' : '';
    const stroke = cls ? '#e03131' : 'rgba(16,24,40,.18)';
    sv.push('<rect class="gbar' + cls + '" data-id="' + t.id + '" x="' + bx + '" y="' + by + '" width="' + bw + '" height="' + hgt + '" rx="4" fill="' + fill + '" fill-opacity="' + (t.status === 'done' ? .55 : .92) + '" stroke="' + stroke + '" style="cursor:' + (r.isParent ? 'default' : 'grab') + '"><title>' + esc(t.title) + ' · ' + d.start + ' → ' + d.due + '</title></rect>');
    /* 进度填充 */
    let pct = 0;
    if (r.isParent && r.roll) pct = r.roll.pct;
    else if (t.status === 'done') pct = 100;
    else { const roll = rollupSummary(t); if (roll && roll.total) pct = Math.round(roll.done / roll.total * 100); else if (t.status === 'doing') pct = 50; }
    if (pct > 0) sv.push('<rect x="' + bx + '" y="' + by + '" width="' + Math.max(2, bw * pct / 100) + '" height="' + hgt + '" rx="4" fill="rgba(255,255,255,.55)" pointer-events="none"/>');
  });
  sv.push('</svg>');

  /* 左侧标签列（sticky） */
  let labels = '<div class="glabel head" style="height:' + headerH + 'px"></div>';
  rows.forEach(r => {
    const t = r.t;
    labels += '<div class="glabel' + (t.status === 'done' ? ' done' : '') + '" style="height:' + rowH + 'px;padding-left:' + (8 + r.depth * 16) + 'px;" onclick="openTaskEdit(' + t.id + ')" title="' + esc(t.title) + '">'
      + (r.isParent ? '📂 ' : t.isMilestone ? '🏁 ' : '▸ ')
      + '<span class="gl-t">' + esc(t.title) + '</span>'
      + '<span class="gl-o">' + esc(t.owner || '我方') + '</span></div>';
  });

  const h = '<div class="gantt-head">'
    + '<div class="tabs" style="padding:2px;">' + ['day', 'week', 'month'].map(z =>
      '<button data-zoom="' + z + '" class="' + (S.ganttZoom === z ? 'on' : '') + '" onclick="ganttSetZoom(\'' + z + '\')">' + ({ day: '日', week: '周', month: '月' })[z] + '</button>').join('') + '</div>'
    + '<button class="btn ghost" onclick="ganttPan(-1)">‹ 左移</button><button class="btn ghost" onclick="ganttPan(1)">右移 ›</button>'
    + '<span class="chip2">拖条改日期 · 拖右边缘改截止 · 空白处拖画=新建</span>'
    + '<span class="chip2">🏁 里程碑 = 编辑任务勾选「里程碑」</span>'
    + '<span class="flex1"></span>'
    + '<button class="btn ghost' + (S.ganttCompare ? ' blue' : '') + '" onclick="toggleGanttCompare()" title="叠加周报发送时保存的任务分布快照，看计划漂移">🫥 上周对比</button>'
    + '<button class="btn ghost" onclick="ganttNewMilestone()">＋ 里程碑</button>'
    + '<button class="btn ghost" onclick="ganttNewAtRange()">＋ 新建任务</button>'
    + '<button class="btn teal" onclick="exportGanttPng()">📸 导出 PNG 发领导</button>'
    + '</div>'
    + '<div class="gantt-scroll"><div class="gantt-inner" style="grid-template-columns:' + labelW + 'px ' + gridW + 'px;">'
    + '<div class="gantt-labels">' + labels + '</div>'
    + sv.join('')
    + '</div></div>';
  $id('viewTimeline').innerHTML = h;
  bindGanttDrag();
  /* 上周对比开启但快照缓存未就绪：加载后补一次渲染 */
  if (S.ganttCompare && weekSnapPid != p.id && !weekSnapLoading) {
    loadWeekSnap().then(() => { if (S.ganttCompare) renderView(); });
  }
}
export function ganttSetZoom(z) {
  S.ganttZoom = z;
  S.ganttPx = GANTT_ZOOM[z].px;
  S.ganttOffset = 0;
  renderView();
}
export function ganttPan(dir) {
  S.ganttOffset = (S.ganttOffset || 0) + dir;
  renderView();
}
/* ---------- 上周快照对比（★★☆ 周报基线）：meta weekSnapshot:{pid} = { taskId: {start,due} } ---------- */
import { getJsonMeta } from './backend.js';
let weekSnapCache = null, weekSnapPid = null, weekSnapLoading = false;
export async function loadWeekSnap() {
  const p = curProject(); if (!p) return;
  weekSnapLoading = true;
  weekSnapPid = p.id;
  try { weekSnapCache = await getJsonMeta('weekSnapshot:' + p.id, null); } catch (e) { weekSnapCache = null; }
  weekSnapLoading = false;
}
export async function toggleGanttCompare() {
  S.ganttCompare = !S.ganttCompare;
  const p = curProject();
  if (S.ganttCompare) {
    await loadWeekSnap();
    if (!weekSnapCache || !Object.keys(weekSnapCache).length) {
      toast('该项目还没有上周快照：周报「📤 发到群」时会自动保存任务分布基线', 'info');
      S.ganttCompare = false;
    }
  }
  renderView();
}
export function ganttNewMilestone() {
  import('./modals/task-edit.js').then(m => m.openTaskEdit(0, { isMilestone: true, due: TODAY }));
}
export function ganttNewAtRange() {
  import('./modals/task-edit.js').then(m => m.openTaskEdit(0, { startDate: TODAY, due: addDays(TODAY, 2) }));
}
/* ---------- 空白格拖画新建（动线3）：在时间线空白处横向拖一段 → 新任务预填起止 ---------- */
let cdrag = null;
export function ganttXToDate(clientX) {
  const svg = $id('gantt-svg');
  if (!svg || !S.ganttWin) return null;
  const r = svg.getBoundingClientRect();
  const i = Math.floor((clientX - r.left) / S.ganttWin.px);
  const di = Math.max(0, Math.min(S.ganttWin.nDays - 1, i));
  return addDays(S.ganttWin.mn, di);
}
/* 甘特拖拽：拖条移动 / 左右边缘改日期（吸附到天，复用看板指针拖拽思路）；空白处拖画=新建 */
export let gdrag = null;
export function bindGanttDrag() {
  const svg = $id('gantt-svg');
  if (!svg) return;
  svg.addEventListener('mousedown', e => {
    const bar = e.target.closest ? e.target.closest('.gbar') : null;
    if (!bar) {
      /* 空白格拖画新建：起一个临时选区矩形 */
      if (e.button !== 0 || !S.ganttWin) return;
      const rect = document.createElementNS('http://www.w3.org/2000/svg', 'rect');
      rect.setAttribute('id', 'gantt-create-rect');
      rect.setAttribute('y', headerHOffset());
      rect.setAttribute('height', '99999');
      rect.setAttribute('fill', 'rgba(76,110,245,.12)');
      rect.setAttribute('stroke', '#4c6ef5');
      rect.setAttribute('stroke-dasharray', '5 3');
      svg.appendChild(rect);
      cdrag = { rect: rect, x0: e.clientX, d0: ganttXToDate(e.clientX) };
      e.preventDefault();
      return;
    }
    const id = +bar.getAttribute('data-id');
    const t = getTask(id);
    if (!t || subTasksOf(t.id).length) return; /* 父任务条是上卷结果，不允许拖 */
    const rect = bar.getBoundingClientRect();
    let mode = 'move';
    if (e.clientX - rect.left <= 7) mode = 'resize-l';
    else if (rect.right - e.clientX <= 7) mode = 'resize-r';
    const d0 = ganttBarDates(t);
    gdrag = { id, mode, startX: e.clientX, start: d0.start, due: d0.due, px: ganttState(), bar };
    e.preventDefault();
    e.stopPropagation();
  });
}
function headerHOffset() { return 44; }
document.addEventListener('mousemove', e => {
  if (cdrag) {
    if (!cdrag.rect) return;
    const svg = $id('gantt-svg');
    if (!svg) return;
    const r = svg.getBoundingClientRect();
    const x1 = Math.max(0, Math.min(e.clientX - r.left, r.width));
    const x0raw = cdrag.x0 - r.left;
    const x0 = Math.max(0, Math.min(x0raw, r.width));
    cdrag.rect.setAttribute('x', Math.min(x0, x1));
    cdrag.rect.setAttribute('width', Math.max(2, Math.abs(x1 - x0)));
    return;
  }
  if (!gdrag) return;
  const delta = Math.round((e.clientX - gdrag.startX) / gdrag.px);
  if (delta === 0 && !gdrag.moved) return;
  gdrag.moved = true;
  const t = getTask(gdrag.id);
  if (!t) return;
  let { start, due } = gdrag;
  if (gdrag.mode === 'move') { start = addDays(gdrag.start, delta); due = addDays(gdrag.due, delta); }
  else if (gdrag.mode === 'resize-r') { due = addDays(gdrag.due, delta); if (due < start) due = start; }
  else { start = addDays(gdrag.start, delta); if (start > due) start = due; }
  gdrag.ns = start; gdrag.nd = due;
  gdrag.bar.setAttribute('title', t.title + ' · ' + start + ' → ' + due);
});
document.addEventListener('mouseup', async e => {
  if (cdrag) {
    const c = cdrag; cdrag = null;
    const el = $id('gantt-create-rect');
    if (el) el.remove();
    if (!c.d0 || Math.abs(e.clientX - c.x0) < 5) return; /* 单击空白不弹窗，拖画才建 */
    const d1 = ganttXToDate(e.clientX) || c.d0;
    let start = c.d0, due = d1;
    if (due < start) { const tmp = start; start = due; due = tmp; }
    if (start === due) due = addDays(start, 1);
    import('./modals/task-edit.js').then(m => m.openTaskEdit(0, { startDate: start, due: due }));
    return;
  }
  if (!gdrag) return;
  const g = gdrag; gdrag = null;
  if (!g.moved || g.ns == null) return;
  const t = getTask(g.id);
  if (!t) return;
  t.startDate = g.ns;
  t.due = g.nd;
  try {
    await persistTask(t);
    toast('📅 「' + t.title.slice(0, 14) + '」已调整为 ' + g.ns + ' → ' + g.nd);
    renderView();
  } catch (err) { toastErr('保存失败', err); }
});
/* 导出 PNG：SVG 序列化 → img → canvas 2x 高清 → 写盘（零依赖方案） */
export async function exportGanttPng() {
  const svg = $id('gantt-svg');
  const p = curProject();
  if (!svg || !p) return;
  try {
    const clone = svg.cloneNode(true);
    clone.setAttribute('xmlns', 'http://www.w3.org/2000/svg');
    clone.style.background = '#ffffff';
    clone.querySelectorAll('[fill="var(--panel)"]').forEach(el => el.setAttribute('fill', '#ffffff'));
    clone.querySelectorAll('[fill="#f6f8fb"]').forEach(el => el.setAttribute('fill', '#f2f4f8'));
    let str = new XMLSerializer().serializeToString(clone);
    str = str.replace(/var\(--panel\)/g, '#ffffff');
    const scale = 2;
    const img = new Image();
    const svg64 = 'data:image/svg+xml;charset=utf-8,' + encodeURIComponent(str);
    await new Promise((res, rej) => {
      img.onload = res;
      img.onerror = () => rej(new Error('SVG 渲染失败'));
      img.src = svg64;
    });
    const canvas = document.createElement('canvas');
    canvas.width = svg.width.baseVal.value * scale;
    canvas.height = svg.height.baseVal.value * scale;
    const ctx = canvas.getContext('2d');
    ctx.fillStyle = '#ffffff';
    ctx.fillRect(0, 0, canvas.width, canvas.height);
    ctx.drawImage(img, 0, 0, canvas.width, canvas.height);
    const dataUrl = canvas.toDataURL('image/png');
    let path = null;
    path = await TDialog().save({
      title: '导出时间线 PNG',
      defaultPath: p.name + '-时间线-' + TODAY + '.png',
      filters: [{ name: 'PNG', extensions: ['png'] }]
    });
    if (!path) { toast('已取消导出', 'info'); return; }
    await invoke('save_binary_file', { path: path, dataBase64: dataUrl.split(',')[1] });
    toast('📸 已导出：' + path);
  } catch (e) { toastErr('导出 PNG 失败', e); }
}
