/* Excel/CSV 导入向导、xlsx 导出 —— 拆分自 ui/app.js（来源行 4093-4504） */

import { TDialog, invoke } from './backend.js';
import { ganttBarDates, ganttRows } from './gantt.js';
import { openModal } from './modal.js';
import { S, TODAY, curProject, isOverdue, projNameOf, riskValue } from './state.js';
import { persistProject, persistTask, refreshAll } from './tasks.js';
import { $id, esc, pad, toast, toastErr } from './utils.js';

/* ============ 包5：Excel 计划表导入向导（Jira 五步模式） ============ */
export const XW_FIELDS = [
  { key: 'title', label: '标题（必填）', kw: /任务|事项|工作内容|名称|标题|内容/ },
  { key: 'due', label: '截止日期 → due', kw: /截止|完成时间|计划结束|结束时间|完成日期|交付/ },
  { key: 'start', label: '开始日期', kw: /开始|计划开始|启动/ },
  { key: 'owner', label: '负责人', kw: /负责人|责任人|owner|执行人|经办/ },
  { key: 'pri', label: '优先级', kw: /优先级|级别/ },
  { key: 'status', label: '状态 / 完成百分比', kw: /状态|完成|进度|百分比/ },
  { key: 'note', label: '备注 / 交付物', kw: /备注|说明|交付物|描述/ },
  { key: 'stage', label: '所属阶段（作父任务）', kw: /阶段|里程碑|wbs|模块/ }
];
export const XW_STEPS = ['① 选文件', '② 选工作表', '③ 列映射', '④ 预览', '⑤ 导入'];
export let XW = null;
let xwSheetSeq = 0; /* 工作表加载序号（xwLoadSheet 竞态防护，见 xwSheetChanged） */

/* 值映射下拉的委托监听：原始单元格值经 data-vm 传递，避免把单元格文本拼进内联 JS 字符串
 * （多行 / 结尾反斜杠 / 引号会炸掉内联 onchange，该行映射被静默忽略）。模块级注册一次即可。 */
document.addEventListener('change', e => {
  const el = e.target;
  if (!el || el.tagName !== 'SELECT' || !el.hasAttribute('data-vm') || !XW) return;
  XW.valueMap[el.getAttribute('data-vm')] = el.value;
});

export function openExcelWizard() {
  XW = { step: 1, path: '', fileName: '', sheets: [], sheet: '', headerRow: 0, rows: null,
    map: {}, valueMap: {}, pctToStatus: true, targetMode: 'new', newProjName: '', targetPid: 0, sample: false, result: null };
  $id('xw-next').hidden = false;
  $id('xw-import').hidden = true;
  renderExcelWizard();
  openModal('mw-xlsx');
}
export function xwStepsHtml() {
  return XW_STEPS.map((s, i) => '<span class="xw-step' + (XW.step === i + 1 ? ' on' : XW.step > i + 1 ? ' done' : '') + '">' + s + '</span>').join('<i class="xw-arrow">→</i>');
}
export function renderExcelWizard() {
  $id('xw-steps').innerHTML = xwStepsHtml();
  $id('xw-next').hidden = !(XW.step >= 2 && XW.step < 5);
  $id('xw-import').hidden = XW.step !== 5;
  const body = $id('xw-body');
  window._xwStatus = (msg, isErr) => { const el = $id('xw-status'); el.textContent = msg || ''; el.style.color = isErr ? 'var(--red)' : ''; };
  if (XW.step === 1) {
    body.innerHTML = '<div class="xw-hint">支持 <b>.xlsx / .xls</b>（.csv / .et 建议先在 Excel/WPS 里另存为 xlsx）。解析全部在本机完成，不上传任何数据。</div>'
      + '<div style="display:flex;gap:10px;margin-top:14px;align-items:center;"><button class="btn blue" onclick="xwPickFile()">📂 选择计划表文件</button>'
      + (XW.fileName ? '<span class="chip2 cd">已选：' + esc(XW.fileName) + '</span>' : '') + '</div>'
      + '<div class="xw-hint" style="margin-top:14px;">针对中国计划表的脏数据策略：<b>合并单元格</b>自动向下填充首值；<b>WBS 层级</b>三路探测（序号列点分 1/1.1/1.1.2 · 缩进前导空格 · 独立「阶段」列合并单元格），阶段行→父任务（进度上卷自动算）；<b>混合日期</b> 2026-09-01 / 2026/9/1 / 9月1日 / Excel 序列号全兼容，"9月上旬"标黄人工处理；<b>完成百分比</b> 50% / 0.5 / "50" 统一归一，≥100%→已完成、1~99%→进行中；<b>前置任务列</b>原文写回备注不做依赖解析；<b>无日期列</b> due 默认今天并在预览提示。</div>';
  } else if (XW.step === 2) {
    body.innerHTML = '<label>工作表</label><select id="xw-sheet" onchange="xwSheetChanged()">' + (XW.sheets || []).map(s => '<option' + (s === XW.sheet ? ' selected' : '') + '>' + esc(s) + '</option>').join('') + '</select>'
      + '<label>表头行（自动猜测，可手改）</label><select id="xw-hrow" onchange="xwHeaderChanged()">' + (XW._rowChoices || []).map((rc, i) => '<option value="' + i + '"' + (i === XW._rowChoiceIdx ? ' selected' : '') + '>' + esc(rc.label) + '</option>').join('') + '</select>'
      + '<div class="xw-preview">' + xwMatrixTable(XW.rows, 10, XW.headerRow) + '</div>';
  } else if (XW.step === 3) {
    const headers = XW.rows[XW.headerRow] || [];
    let h = '<div class="xw-maps">';
    XW_FIELDS.forEach(f => {
      h += '<div class="xw-map-row"><label>' + f.label + '</label><select id="xw-map-' + f.key + '" onchange="xwMapChanged()">'
        + '<option value="-1">（不导入）</option>'
        + headers.map((hd, ci) => '<option value="' + ci + '"' + (XW.map[f.key] === ci ? ' selected' : '') + '>' + (hd ? esc(String(hd).slice(0, 14)) : '列' + (ci + 1)) + '</option>').join('')
        + '</select></div>';
    });
    h += '</div>';
    const sIdx = XW.map.status;
    if (sIdx != null && sIdx >= 0) {
      const vals = [];
      for (let r = XW.headerRow + 1; r < XW.rows.length; r++) {
        const v = String((XW.rows[r] || [])[sIdx] || '').trim();
        if (v && vals.indexOf(v) < 0) vals.push(v);
        if (vals.length >= 24) break;
      }
      h += '<label class="xw-vm-title">值映射（Jira 特色：把表里的「已完成/100%/done」→已完成、「进行中/实施中」→进行中；留空 = 按关键词自动判断）</label><div class="xw-vmaps">';
      vals.forEach(v => {
        const auto = /完成|done|已|100|close/i.test(v) ? '已完成' : /进行|实施|doing|启动|开始/i.test(v) ? '进行中' : '待办';
        h += '<div class="xw-map-row"><label title="' + esc(v) + '">' + esc(v.slice(0, 16)) + '</label><select data-vm="' + esc(v) + '">'
          + '<option value="">自动（→' + auto + '）</option>'
          + ['todo', 'doing', 'done'].map(s2 => '<option value="' + s2 + '"' + (XW.valueMap[v] === s2 ? ' selected' : '') + '>' + ({ todo: '待办', doing: '进行中', done: '已完成' })[s2] + '</option>').join('')
          + '<option value="skip"' + (XW.valueMap[v] === 'skip' ? ' selected' : '') + '>跳过该行</option></select></div>';
      });
      h += '</div><label class="ck big"><input type="checkbox" ' + (XW.pctToStatus ? 'checked' : '') + ' onchange="XW.pctToStatus=this.checked"> 完成百分比归一：≥100% → 已完成，1~99% → 进行中</label>';
    }
    h += '<div class="xw-preview">' + xwMatrixTable(XW.rows, 6, XW.headerRow) + '</div>';
    body.innerHTML = h;
  } else if (XW.step === 4) {
    const built = xwBuildImportRows();
    XW.built = built;
    const bad = built.filter(r => r.err).length, warn = built.filter(r => r.warn && !r.err).length;
    let h = '<div class="chips-line" style="margin-bottom:10px;">'
      + '<span class="chip2 good">✅ 可导入 ' + built.filter(r => !r.err).length + ' 行</span>'
      + (warn ? '<span class="chip2 warn">⚠ 警告 ' + warn + ' 行</span>' : '')
      + (bad ? '<span class="chip2 bad">⛔ 跳过 ' + bad + ' 行</span>' : '')
      + '<span class="chip2">阶段父任务 ' + built.filter(r => r.isStage).length + ' 个</span></div>';
    h += '<div class="xw-preview"><table><thead><tr><th>行</th><th>层级</th><th>标题</th><th>截止</th><th>负责人</th><th>状态</th><th>提示</th></tr></thead><tbody>';
    built.slice(0, 20).forEach(r => {
      h += '<tr class="' + (r.err ? 'xw-bad' : r.warn ? 'xw-warn' : '') + '"><td>' + (r.srcIdx + 1) + '</td><td>' + (r.isStage ? '📂 父' : r.parentTitle ? '↳' : '—') + '</td>'
        + '<td>' + esc(r.title || '（空标题）') + '</td><td>' + esc(r.due || '—') + '</td><td>' + esc(r.owner || '') + '</td><td>' + esc(r.status || 'todo') + '</td>'
        + '<td>' + (r.err ? '⛔ ' + esc(r.err) : r.warn ? '⚠ ' + esc(r.warn) : '') + '</td></tr>';
    });
    h += '</tbody></table>' + (built.length > 20 ? '<div class="empty">仅预览前 20 行，共 ' + built.length + ' 行</div>' : '') + '</div>';
    body.innerHTML = h;
  } else if (XW.step === 5) {
    const alive = S.projects.filter(p => !p.archived);
    if (!XW.targetPid && alive.length) XW.targetPid = alive[0].id;
    body.innerHTML = '<label>导入到哪？</label>'
      + '<label class="ck big"><input type="radio" name="xw-target" value="new" ' + (XW.targetMode === 'new' ? 'checked' : '') + ' onchange="XW.targetMode=\'new\'"> 新建项目（名称默认取文件名）</label>'
      + '<div class="xw-map-row" style="margin-left:22px;"><input type="text" id="xw-newname" value="' + esc(XW.newProjName) + '" placeholder="项目名称"></div>'
      + '<label class="ck big"><input type="radio" name="xw-target" value="merge" ' + (XW.targetMode === 'merge' ? 'checked' : '') + ' onchange="XW.targetMode=\'merge\'"> 并入现有项目</label>'
      + '<div class="xw-map-row" style="margin-left:22px;"><select id="xw-targetpid" onchange="XW.targetPid=+this.value">' + alive.map(p => '<option value="' + p.id + '"' + (XW.targetPid == p.id ? ' selected' : '') + '>' + esc(p.name) + '</option>').join('') + '</select></div>'
      + '<label class="ck big"><input type="checkbox" ' + (XW.sample ? 'checked' : '') + ' onchange="XW.sample=this.checked"> 🧪 先导到「示例项目」试一把（Jira 最佳实践：先试跑看效果）</label>'
      + '<div class="hint" style="margin-top:10px;">共 <b>' + (XW.built || []).filter(r => !r.err).length + '</b> 行待导入。完成后给导入报告（成功 N 条 / 跳过 M 条及原因）。</div>';
  }
}
export async function xwPickFile() {
  let path = null;
  try {
    path = await TDialog().open({
      title: '选择 Excel 计划表',
      multiple: false,
      filters: [{ name: 'Excel / CSV', extensions: ['xlsx', 'xls', 'csv', 'xlsm'] }]
    });
  } catch (e) { toastErr('打开文件对话框失败', e); return; }
  if (!path) return;
  XW.path = Array.isArray(path) ? path[0] : path;
  XW.fileName = String(XW.path).split(/[\\/]/).pop();
  XW.rows = null;
  try {
    if (/\.csv$/i.test(XW.fileName)) {
      XW._csv = true;
      XW.sheets = ['CSV'];
      XW.sheet = 'CSV';
    } else {
      XW._csv = false;
      XW.sheets = await invoke('xlsx_sheets', { path: XW.path });
      XW.sheet = XW.sheets[0] || '';
    }
  } catch (e) { toastErr('读取文件失败', e); return; }
  try {
    await xwLoadSheet();
  } catch (e) { toastErr('解析失败', e); return; }
  if (XW.newProjName === '') XW.newProjName = XW.fileName.replace(/\.[^.]+$/, '').replace(/[-_]?计划表?$/, '');
  XW.step = 2;
  renderExcelWizard();
}
export async function xwLoadSheet() {
  /* 失败直接上抛给调用方（openExcelWizard 中止流程 / xwSheetChanged 回滚旧表），
   * 不能在这里吞错 return，否则调用方的 .catch 永远不执行（回滚变死代码） */
  const seq = ++xwSheetSeq; /* 加载序号：快速切表/重选文件时后发请求覆盖先发，防止旧表数据覆盖新表 */
  if (XW._csv) {
    if (!XW.rows) {
      const raw = await invoke('read_text_file', { path: XW.path });
      if (seq !== xwSheetSeq) return; /* 期间已切到别的表：本次结果作废 */
      XW.rows = parseCsvText(raw);
    }
  } else {
    const res = await invoke('xlsx_read', { path: XW.path, sheet: XW.sheet });
    if (seq !== xwSheetSeq) return; /* 期间已切到别的表：本次结果作废 */
    XW.rows = res.rows || [];
  }
  /* 表头行自动猜测：首个含「任务/事项/工作内容/名称」类关键词的非空行 */
  const choices = [];
  for (let r = 0; r < Math.min(XW.rows.length, 15); r++) {
    const row = XW.rows[r] || [];
    const nonEmpty = row.filter(c => String(c).trim()).length;
    if (nonEmpty < 2) continue;
    const hitKw = row.some(c => /任务|事项|工作内容|名称|标题|阶段|负责人/.test(String(c)));
    choices.push({ idx: r, label: '第 ' + (r + 1) + ' 行' + (hitKw ? ' ⭐' : '') + '：' + row.filter(c => String(c).trim()).slice(0, 4).map(c => String(c).slice(0, 8)).join(' / ') });
  }
  if (!choices.length) choices.push({ idx: 0, label: '第 1 行' });
  XW._rowChoices = choices;
  XW._rowChoiceIdx = Math.max(0, choices.findIndex(c => /⭐/.test(c.label)));
  XW.headerRow = choices[XW._rowChoiceIdx].idx;
  xwAutoMap();
}
export function xwSheetChanged() {
  const ns = $id('xw-sheet').value;
  if (ns === XW.sheet) return;
  const oldSheet = XW.sheet, oldRows = XW.rows;
  XW.sheet = ns;
  XW.rows = null;
  xwLoadSheet().then(() => {
    /* 竞态防护在 xwLoadSheet 内部（序号校验）；此处只负责渲染最新状态 */
    renderExcelWizard();
  }).catch(e => {
    /* 换表失败：回退到旧表状态并重渲染，避免停留在“旧内容+可点下一步”的中间态 */
    toastErr('读取工作表失败', e);
    XW.sheet = oldSheet; XW.rows = oldRows;
    renderExcelWizard();
  });
}
export function xwHeaderChanged() {
  XW._rowChoiceIdx = +$id('xw-hrow').value;
  XW.headerRow = XW._rowChoices[XW._rowChoiceIdx].idx;
  xwAutoMap();
  renderExcelWizard();
}
/* 自动预映射：按列名关键词猜（"截止/完成时间/计划结束"→due，"负责人/责任人/Owner"→负责人） */
export function xwAutoMap() {
  const headers = (XW.rows && XW.rows[XW.headerRow]) || [];
  XW.map = {};
  XW_FIELDS.forEach(f => {
    const i = headers.findIndex(hd => f.kw.test(String(hd || '')));
    if (i >= 0) XW.map[f.key] = i;
  });
  if (XW.map.title == null) {
    const i = headers.findIndex(hd => String(hd || '').trim());
    if (i >= 0) XW.map.title = i;
  }
  XW.valueMap = {};
}
export function xwMapChanged() {
  XW_FIELDS.forEach(f => { const el = $id('xw-map-' + f.key); if (el) XW.map[f.key] = +el.value; });
  renderExcelWizard();
}
export function xwValueMap(v, val) { XW.valueMap[v] = val; }
/* 日期解析：ISO / 斜杠 / 9月1日 / 2026年9月1日 / Excel 序列号；模糊表述标黄 */
export function xwParseDate(v) {
  const s = String(v || '').trim();
  if (!s) return { v: '' };
  let m = s.match(/^(\d{4})[-/.年](\d{1,2})[-/.月](\d{1,2})日?$/);
  if (m) return { v: m[1] + '-' + pad(+m[2]) + '-' + pad(+m[3]) };
  m = s.match(/^(\d{1,2})月(\d{1,2})[日号]?$/);
  if (m) return { v: TODAY.slice(0, 4) + '-' + pad(+m[1]) + '-' + pad(+m[2]) };
  if (/^\d{5}(\.\d+)?$/.test(s)) {
    const n = Math.round(+s);
    if (n >= 40000 && n <= 60000) {
      const d = new Date(Date.UTC(1899, 11, 30) + n * 86400000);
      return { v: d.getUTCFullYear() + '-' + pad(d.getUTCMonth() + 1) + '-' + pad(d.getUTCDate()) };
    }
  }
  if (/^[\d.]+$/.test(s)) return { v: '', warn: '日期列出现数字「' + s + '」，无法识别' };
  return { v: '', warn: '模糊日期「' + s.slice(0, 12) + '」，已留空待人工处理' };
}
export function xwStatusOf(raw) {
  const s = String(raw || '').trim();
  if (!s) return { status: 'todo' };
  if (XW.valueMap[s]) {
    if (XW.valueMap[s] === 'skip') return { skip: true };
    return { status: XW.valueMap[s] };
  }
  if (/^(\d+(\.\d+)?)\s*%$/.test(s) || /^0\.\d+$/.test(s) || /^\d+$/.test(s)) {
    if (!XW.pctToStatus) return { status: 'todo' };
    let pct = /%/.test(s) ? parseFloat(s) : (+s <= 1 ? +s * 100 : +s);
    if (isNaN(pct)) return { status: 'todo' };
    if (pct >= 100) return { status: 'done', pctNote: s };
    if (pct >= 1) return { status: 'doing', pctNote: s };
    return { status: 'todo' };
  }
  if (/完成|done|已结|关闭|100/i.test(s)) return { status: 'done' };
  if (/进行|实施|doing|启动|开始|处理/i.test(s)) return { status: 'doing' };
  if (/等待|挂起|暂停|hold/i.test(s)) return { status: 'wait' };
  return { status: 'todo' };
}
/* 层级探测：序号点分（1 / 1.1 / 1.1.2）或缩进前导空格（OpenProject 4 空格规则） */
export function xwDepthOf(title) {
  const t = String(title || '');
  const m = t.match(/^\s*(\d+(?:[.、]\d+)*)[、.\s]/);
  if (m) return m[1].split(/[.、]/).length;
  const indent = t.match(/^[ \t　]+/);
  if (indent) return Math.floor(indent[0].replace(/　/g, '  ').replace(/\t/g, '  ').length / 2) + 1;
  return 1;
}
export function xwBuildImportRows() {
  const map = XW.map;
  const rows = [];
  if (map.title == null || map.title < 0) return rows;
  const useStage = map.stage != null && map.stage >= 0;
  const stageParents = {};
  const stack = []; /* 层级栈：parents */
  const preIdx = (XW.rows[XW.headerRow] || []).findIndex(hd => /前置|依赖/.test(String(hd || '')));
  for (let r = XW.headerRow + 1; r < XW.rows.length; r++) {
    const row = XW.rows[r] || [];
    const rawTitle = String(row[map.title] || '');
    if (!rawTitle.trim()) continue;
    const rec = { srcIdx: r, title: rawTitle.trim().replace(/\s+/g, ' '), due: '', startDate: '', owner: '', pri: 'P1', status: 'todo', note: '', isStage: false, parentTitle: '', err: '', warn: '' };
    if (map.due != null && map.due >= 0) { const d = xwParseDate(row[map.due]); rec.due = d.v; if (d.warn) rec.warn = d.warn; }
    if (map.start != null && map.start >= 0) { const d = xwParseDate(row[map.start]); rec.startDate = d.v; }
    if (map.owner != null && map.owner >= 0) rec.owner = String(row[map.owner] || '').trim().slice(0, 20);
    if (map.pri != null && map.pri >= 0) {
      const pm = String(row[map.pri] || '').toUpperCase().match(/P([012])/);
      if (pm) rec.pri = 'P' + pm[1];
    }
    if (map.status != null && map.status >= 0) {
      const st = xwStatusOf(row[map.status]);
      if (st.skip) continue;
      rec.status = st.status;
      if (st.pctNote) rec.warn = (rec.warn ? rec.warn + '；' : '') + '完成度 ' + st.pctNote + ' → ' + ({ done: '已完成', doing: '进行中' }[st.status] || st.status);
    }
    if (map.note != null && map.note >= 0) rec.note = String(row[map.note] || '').trim().slice(0, 500);
    if (preIdx >= 0 && row[preIdx]) rec.note = (rec.note ? rec.note + '\n' : '') + '前置：' + String(row[preIdx]).trim();
    if (!rec.title) { rec.err = '标题为空'; rows.push(rec); continue; }
    if (useStage) {
      const stage = String(row[map.stage] || '').trim();
      if (stage) {
        if (!stageParents[stage]) {
          stageParents[stage] = { srcIdx: r, title: stage, due: '', startDate: '', owner: '', pri: 'P1', status: 'todo', note: '（阶段父任务，来自 Excel 阶段列）', isStage: true, parentTitle: '', err: '', warn: '' };
          rows.push(stageParents[stage]);
        }
        rec.parentTitle = stage;
      }
    } else {
      const depth = xwDepthOf(rec.title);
      while (stack.length >= depth) stack.pop();
      rec.parentTitle = stack.length ? stack[stack.length - 1].title : '';
      stack.push(rec);
    }
    rows.push(rec);
  }
  /* 序号/缩进模式：有孩子的行回填为阶段父任务，并修 parentTitle */
  if (!useStage) {
    for (let i = 0; i < rows.length; i++) {
      if (rows[i].isStage) continue;
      const dNext = i + 1 < rows.length ? xwDepthOf(rows[i + 1].title) : 1;
      if (dNext > xwDepthOf(rows[i].title)) rows[i].isStage = true;
    }
    const stack2 = [];
    rows.forEach(r => {
      const d = xwDepthOf(r.title);
      while (stack2.length >= d) stack2.pop();
      r.parentTitle = stack2.length ? stack2[stack2.length - 1].title : '';
      stack2.push(r);
      if (!r.isStage) stack2.pop();
    });
  }
  return rows;
}
export async function xwImport() {
  if (!XW || XW._importing) return; /* 导入进行中：忽略重复点击，防止同一批任务重复入库 */
  const built = XW.built || xwBuildImportRows();
  const good = built.filter(r => !r.err);
  if (!good.length) { toast('没有可导入的行', 'err'); return; }
  XW._importing = true;
  const btn = $id('xw-import');
  if (btn) { btn.disabled = true; btn.textContent = '⏳ 导入中…'; }
  try {
    let pid = 0, pname = '';
    try {
      if (XW.sample) {
        let p = S.projects.find(x => x.name === '示例项目' && !x.archived);
        if (!p) p = await persistProject({ id: 0, name: '示例项目', archived: false, createdAt: TODAY, settingsJson: '{}' });
        pid = p.id; pname = p.name;
      } else if (XW.targetMode === 'new') {
        const nm = ($id('xw-newname') && $id('xw-newname').value.trim()) || XW.newProjName || XW.fileName.replace(/\.[^.]+$/, '');
        const p = await persistProject({ id: 0, name: nm, archived: false, createdAt: TODAY, settingsJson: JSON.stringify({ report: nm + ' 进度日报', milestones: [{ label: '', date: '' }, { label: '', date: '' }, { label: '', date: '' }] }) });
        pid = p.id; pname = p.name;
      } else {
        pid = XW.targetPid || (+($id('xw-targetpid') && $id('xw-targetpid').value) || 0);
        pname = projNameOf(pid);
        if (!pid) { toast('请选择要并入的项目', 'err'); return; }
      }
    } catch (e) { toastErr('准备目标项目失败', e); return; }
    const parentIds = {};
    let ok = 0, skip = 0, done = 0;
    const skips = [];
    for (const r of good) {
      try {
        let parentId = 0;
        /* isStage 行也可能是别的阶段的子阶段（3 级 WBS），只要有已入库的父标题就挂上去 */
        if (r.parentTitle && parentIds[r.parentTitle] != null) {
          parentId = parentIds[r.parentTitle];
        }
        const base = {
          id: 0, projectId: pid, title: r.title, due: r.due || TODAY, owner: r.owner || '我方',
          pri: r.pri || 'P1', status: r.status === 'done' ? 'done' : r.status === 'doing' ? 'doing' : r.status === 'wait' ? 'wait' : 'todo',
          doneAt: r.status === 'done' ? (r.due || TODAY) : '', risk: false, repeat: '',
          note: r.note || '', createdAt: TODAY, sortOrder: 0, checklistJson: '[]',
          startDate: r.startDate || '', parentId: parentId
        };
        const saved = await persistTask(base);
        if (r.isStage) parentIds[r.title] = saved.id;
        ok++;
      } catch (e) {
        skip++;
        skips.push('第 ' + (r.srcIdx + 1) + ' 行「' + r.title.slice(0, 14) + '」：' + (e && e.message || e));
      }
      done++;
      if (done % 10 === 0 && typeof window._xwStatus === 'function') window._xwStatus('⏳ 已导入 ' + done + '/' + good.length + ' 条…');
    }
    /* 父任务修正：persistTask 保存后回填 parentId（同名阶段仅第一个父任务生效） */
    await refreshAll();
    const made = Object.keys(parentIds).length;
    $id('xw-body').innerHTML = '<div class="chips-line"><span class="chip2 good">✅ 成功导入 ' + ok + ' 条到「' + esc(pname) + '」</span>'
      + (made ? '<span class="chip2 cd">📂 阶段父任务 ' + made + ' 个（进度上卷自动生效）</span>' : '')
      + (skip ? '<span class="chip2 bad">跳过 ' + skip + ' 条</span>' : '') + '</div>'
      + (skips.length ? '<div class="xw-preview">' + skips.map(s => '<div class="dn-row">⛔ ' + esc(s) + '</div>').join('') + '</div>' : '')
      + '<div class="hint" style="margin-top:10px;">可在「📊 统计」看交付预测（哪天做完）、「⏱ 时间线」看计划条。</div>';
    $id('xw-import').hidden = true;
    $id('xw-next').hidden = true;
    toast('📥 导入完成：成功 ' + ok + ' 条' + (skip ? '，跳过 ' + skip + ' 条' : ''));
  } finally {
    XW._importing = false;
    if (btn) { btn.disabled = false; btn.textContent = '📥 开始导入'; }
  }
}
export function xwMatrixTable(rows, maxRows, headerRow) {
  if (!rows || !rows.length) return '<div class="empty">（空表）</div>';
  const nr = Math.min(rows.length, maxRows + headerRow + 1);
  let h = '<table><tbody>';
  for (let r = 0; r < nr; r++) {
    h += '<tr' + (r === headerRow ? ' class="xw-hr"' : '') + '>';
    for (let c = 0; c < Math.min((rows[r] || []).length, 10); c++) {
      h += '<td>' + esc(String(rows[r][c] || '').slice(0, 16)) + '</td>';
    }
    h += '</tr>';
  }
  h += '</tbody></table>';
  return h;
}
/* 向导「下一步」：2/3/4 步推进，第 5 步点开始导入 */
export function xwNext() {
  if (!XW) return;
  /* 防双击跳步：300ms 内第二次点击忽略（否则 ②→④ 静默跳过列映射 / ③→⑤ 跳过预览） */
  const now = Date.now();
  if (now - (XW._nextT || 0) < 300) return;
  XW._nextT = now;
  if (XW.step === 2 && XW.sheet) { XW.step = 3; renderExcelWizard(); }
  else if (XW.step === 3) { XW.step = 4; renderExcelWizard(); }
  else if (XW.step === 4) { XW.step = 5; renderExcelWizard(); }
}
/* 简易 CSV 解析（引号/转义/逗号），用于 .csv 文件 */
export function parseCsvText(text) {
  const rows = [];
  let row = [], cell = '', inQ = false;
  text = String(text || '').replace(/\r\n/g, '\n').replace(/\r/g, '\n');
  for (let i = 0; i < text.length; i++) {
    const ch = text[i];
    if (inQ) {
      if (ch === '"') { if (text[i + 1] === '"') { cell += '"'; i++; } else inQ = false; }
      else cell += ch;
    } else if (ch === '"') inQ = true;
    else if (ch === ',') { row.push(cell); cell = ''; }
    else if (ch === '\n') { row.push(cell); rows.push(row); row = []; cell = ''; }
    else cell += ch;
  }
  if (cell || row.length) { row.push(cell); rows.push(row); }
  return rows.filter(r => r.some(c => String(c).trim()));
}
/* 包5 姊妹功能：导出 .xlsx 计划表（按阶段分组、带样式表头，含状态/风险值/负责人） */
export async function exportProjectXlsx() {
  const p = curProject(); if (!p) return;
  let path = null;
  try {
    path = await TDialog().save({
      title: '导出 Excel 计划表',
      defaultPath: p.name + '-计划表-' + TODAY + '.xlsx',
      filters: [{ name: 'Excel', extensions: ['xlsx'] }]
    });
  } catch (e) { toastErr('打开保存对话框失败', e); return; }
  if (!path) { toast('已取消导出', 'info'); return; }
  const rows = ganttRows(p.id);
  const stMap = { todo: '待办', doing: '进行中', wait: '等待', done: '已完成' };
  const payload = { sheetName: p.name.slice(0, 28), headers: ['阶段/任务', '负责人', '开始', '截止', '状态', '优先级', '风险', '备注', '完成日期'], widths: [42, 10, 12, 12, 9, 8, 8, 36, 12], rows: [] };
  rows.forEach(r => {
    const t = r.t;
    const d = ganttBarDates(t);
    payload.rows.push({
      group: !!r.isParent,
      cells: [
        (r.depth ? '  '.repeat(r.depth) : '') + t.title,
        t.owner || '我方', t.startDate || d.start, t.due || '',
        (isOverdue(t) ? '已逾期·' : '') + (stMap[t.status] || t.status),
        t.pri || 'P1',
        t.risk ? 'R' + (riskValue(t) || '⚠') : '',
        t.note || '', t.status === 'done' ? (t.doneAt || '') : ''
      ]
    });
  });
  try {
    await invoke('export_xlsx', { path: path, payload: payload });
    toast('📤 已导出带样式计划表：' + path);
  } catch (e) { toastErr('导出 xlsx 失败', e); }
}
