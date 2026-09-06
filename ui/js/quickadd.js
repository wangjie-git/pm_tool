/* 快速添加自然语言解析、剪贴板建任务 —— 拆分自 ui/app.js（来源行 923-1090, 4505-4518） */

import { render } from './render.js';
import { S, TODAY, curProject, projNameOf, projTasks, repeatLabel } from './state.js';
import { persistTask } from './tasks.js';
import { $id, addDays, addMonths, esc, pad, toast, toastErr } from './utils.js';

/* ============ 快速添加（自然语言解析） ============ */
export function parseQuick(raw) {
  let s = ' ' + raw.trim() + ' ';
  const t = { due: TODAY, owner: '我方', pri: 'P1', risk: false, repeat: '', title: '' };
  const rel = { '大后天': 3, '后天': 2, '明天': 1, '今天': 0 };
  s = s.replace(/(大后天|后天|明天|今天)/g, m => { t.due = addDays(TODAY, rel[m]); return ' '; });
  s = s.replace(/下周([一二三四五六日天])/g, (m, d) => {
    t.due = nextWeekday(d, true);
    return ' ';
  });
  /* 每周五 / 每月20号：循环 + 具体到期日（必须放在通用「周X」解析之前） */
  s = s.replace(/每周([一二三四五六日天])/g, (m, d) => {
    t.repeat = 'weekly';
    t.due = nextWeekday(d, false);
    return ' ';
  });
  s = s.replace(/每月\s*(\d{1,2})\s*[号日]?/g, (m, d) => {
    t.repeat = 'monthly';
    const dd = Math.max(1, +d);
    const curYm = TODAY.slice(0, 7);
    const dim = new Date(+curYm.slice(0, 4), +curYm.slice(5), 0).getDate();
    let due = curYm + '-' + pad(Math.min(dd, dim));
    if (due < TODAY) {
      /* 下月天数：月份参数 +1 才是下月（复制粘贴错误会漏掉下月比本月长的场景，如 2 月设"每月30号"） */
      const nextDim = new Date(+curYm.slice(0, 4), +curYm.slice(5) + 1, 0).getDate();
      due = addMonths(curYm + '-15', 1).slice(0, 8) + pad(Math.min(dd, nextDim));
    }
    t.due = due;
    return ' ';
  });
  s = s.replace(/(?<![0-9])周([一二三四五六日天天])(?![\d月])/g, (m, d) => {
    t.due = nextWeekday(d, false);
    return ' ';
  });
  s = s.replace(/[+＋]\s*(\d+)\s*天?/g, (m, n) => { t.due = addDays(TODAY, +n); return ' '; });
  s = s.replace(/(\d{4}-\d{1,2}-\d{1,2})/g, m => {
    const p = m.split('-');
    t.due = p[0] + '-' + pad(+p[1]) + '-' + pad(+p[2]);
    return ' ';
  });
  s = s.replace(/@([^\s!#@]+)/g, (m, o) => { t.owner = o; return ' '; });
  s = s.replace(/!(P0|P1|P2)/gi, (m, p) => { t.pri = p.toUpperCase(); return ' '; });
  s = s.replace(/#风险/g, () => { t.risk = true; return ' '; });
  s = s.replace(/#(每日|每天)/g, () => { t.repeat = 'daily'; return ' '; });
  s = s.replace(/#每周/g, () => { t.repeat = 'weekly'; return ' '; });
  s = s.replace(/#每月/g, () => { t.repeat = 'monthly'; return ' '; });
  t.title = s.replace(/\s+/g, ' ').trim();
  return t;
}
export function nextWeekday(cn, nextWeek) {
  const map = { '一': 1, '二': 2, '三': 3, '四': 4, '五': 5, '六': 6, '日': 7, '天': 7 };
  const target = map[cn] || 1;
  const curDow = new Date().getDay() || 7;
  let delta;
  if (nextWeek) delta = (8 - curDow) + (target - 1);
  else {
    delta = target - curDow;
    if (delta < 0) delta += 7;
    if (delta === 0) delta = 7;
  }
  return addDays(TODAY, delta);
}

export async function quickAdd() {
  const raw = $id('quick').value;
  if (!raw.trim()) { toast('先输入内容，回车添加；点 ？ 按钮看语法面板', 'info'); return; }
  const t = parseQuick(raw);
  if (!t.title) { toast('没解析出标题：日期/负责人等要写在前、后留出标题文字', 'err'); return; }
  /* 目标项目：📥 收件箱模式先进收件箱；否则用快速添加行的项目下拉（跟随当前/上次浏览项目） */
  let pid;
  if (S.qInbox) {
    pid = 0;
  } else {
    const sel = $id('qProj');
    pid = (sel && !sel.hidden && +sel.value) ? +sel.value : 0;
    if (!pid) { const p = curProject(); pid = p ? p.id : 0; }
  }
  if (pid !== 0 && !pid) { toast('请先创建一个项目', 'err'); return; }
  try {
    await persistTask({
      id: 0, projectId: pid, title: t.title, due: t.due, owner: t.owner, pri: t.pri,
      status: 'todo', doneAt: '', risk: t.risk, repeat: t.repeat, note: '', createdAt: TODAY, sortOrder: 0, checklistJson: '[]'
    });
    $id('quick').value = '';
    quickPreviewRender();
    $id('quick').focus();
    const where = pid === 0 ? '📥 收件箱' : '「' + projNameOf(pid) + '」';
    const dueLabel = t.due === TODAY ? '今天' : t.due;
    toast('已添加到' + where + '：' + t.title + '（' + dueLabel + ' · ' + t.owner + ' · ' + t.pri
      + (t.risk ? ' · ⚠风险' : '') + (t.repeat ? ' · 🔄' + repeatLabel(t.repeat) : '') + '）');
    render();
  } catch (e) { toastErr('添加失败', e); }
}
export function toggleQInbox() {
  S.qInbox = !S.qInbox;
  $id('q-inbox').classList.toggle('on', S.qInbox);
  $id('quick').placeholder = S.qInbox ? '📥 收件箱模式：输入后回车，先不分项目，之后再分拣' : '输入任务，回车添加；输入 / 呼出语法面板';
  $id('quick').focus();
}

/* ---------- 快速添加：实时预览 + 语法面板（A6：彩色按钮收敛为一个 ？ 面板） ---------- */
export function quickPreviewRender() {
  const v = $id('quick').value;
  const box = $id('quickPreview');
  if (!v.trim()) { box.hidden = true; hideQPop(); return; }
  const t = parseQuick(v);
  let chips = '<span class="chip2 cd">📆 ' + esc(t.due === TODAY ? '今天' : t.due) + '</span>'
    + '<span class="chip2">👤 ' + esc(t.owner) + '</span>'
    + '<span class="chip2 ' + (t.pri === 'P0' ? 'bad' : '') + '">' + esc(t.pri) + '</span>';
  if (t.risk) chips += '<span class="chip2 warn">⚠ 风险</span>';
  if (t.repeat) chips += '<span class="chip2">🔄 ' + repeatLabel(t.repeat) + '</span>';
  chips += '<span class="qp-title">' + (t.title ? esc(t.title) : '<i>继续输入任务内容…</i>') + '</span>';
  box.innerHTML = chips;
  box.hidden = false;
}
export function qInsert(token) {
  const el = $id('quick');
  const has = el.value.indexOf(token) >= 0;
  if (!has) el.value = (el.value.trimEnd() + (el.value.trim() ? ' ' : '') + token).trim();
  el.focus();
  quickPreviewRender();
}
export function qRemoveToken(re) {
  const el = $id('quick');
  el.value = el.value.replace(re, ' ').replace(/\s+/g, ' ').trim();
}
export let qPopKind = null;
export function hideQPop() { $id('qPop').hidden = true; qPopKind = null; }
export function qTogglePop(kind, btn) {
  if (qPopKind === kind) { hideQPop(); return; }
  qPopKind = kind;
  const pop = $id('qPop');
  if (kind === 'syntax') {
    /* A6：原 7 个彩色图标按钮收敛为一个语法面板，分区给出全部令牌 */
    const owners = [];
    S.tasks.forEach(t => { if (t.owner && t.owner !== '我方' && owners.indexOf(t.owner) < 0) owners.push(t.owner); });
    const ownerBtns = owners.slice(0, 8).map(o =>
      '<button onclick="qPickOwner(\'' + esc(o).replace(/'/g, '') + '\')">' + esc(o) + '</button>').join('');
    pop.innerHTML = '<div class="q-sec">📆 日期</div>'
      + '<button onclick="qPick(\'今天\')">今天</button><button onclick="qPick(\'明天\')">明天</button>'
      + '<button onclick="qPick(\'后天\')">后天</button><button onclick="qPick(\'下周三\')">下周三</button>'
      + '<button onclick="qPick(\'+3天\')">+3天</button>'
      + '<input type="date" onchange="if(this.value){qInsert(this.value);hideQPop()}">'
      + '<div class="q-sec">👤 负责人</div>'
      + '<button onclick="qPickOwner(\'我方\')">我方</button>' + ownerBtns
      + '<div class="q-sec">🚩 优先级</div>'
      + '<button onclick="qPickPri(\'P0\')">P0 紧急</button><button onclick="qPickPri(\'P1\')">P1 常规</button><button onclick="qPickPri(\'P2\')">P2 低</button>'
      + '<div class="q-sec">标记</div>'
      + '<button onclick="qPick(\'#风险\')">⚠ 风险</button><button onclick="qPick(\'#每日\')">🔄 每日</button>'
      + '<button onclick="qPick(\'#每周\')">🔄 每周</button><button onclick="qPick(\'#每月\')">🔄 每月</button>'
      + '<div class="q-sec">示例：下周三 联调测试 @李四 !P0 #风险</div>';
  } else if (kind === 'date') {
    pop.innerHTML = '<span class="q-pop-label">选择截止日期</span>'
      + ['今天|今天', '明天|明天', '后天|后天', '大后天|大后天'].map(x => {
          const p = x.split('|');
          return '<button onclick="qInsert(\'' + p[1] + '\');hideQPop()">' + p[0] + '</button>';
        }).join('')
      + '<button onclick="qInsert(\'下周三\');hideQPop()">下周三</button>'
      + '<input type="date" onchange="if(this.value){qInsert(this.value);hideQPop()}">';
  } else if (kind === 'owner') {
    const owners = [];
    const p = curProject();
    if (p) projTasks(p.id).forEach(t => { if (t.owner && owners.indexOf(t.owner) < 0 && t.owner !== '我方') owners.push(t.owner); });
    pop.innerHTML = '<span class="q-pop-label">选择负责人</span>'
      + '<button onclick="qRemoveToken(/@[^\\s!#@]+/g);qInsert(\'@我方\');hideQPop()">我方</button>'
      + owners.slice(0, 8).map(o => '<button onclick="qRemoveToken(/@[^\\s!#@]+/g);qInsert(\'@' + esc(o).replace(/'/g, '') + '\');hideQPop()">' + esc(o) + '</button>').join('');
  } else if (kind === 'pri') {
    pop.innerHTML = '<span class="q-pop-label">选择优先级</span>'
      + [['P0', 'P0 紧急'], ['P1', 'P1 常规'], ['P2', 'P2 低']].map(x =>
          '<button onclick="qRemoveToken(/\\s*!P\\d/gi);qInsert(\'!' + x[0] + '\');hideQPop()">' + x[1] + '</button>').join('');
  }
  pop.hidden = false;
  const r = btn.getBoundingClientRect();
  pop.style.left = Math.min(r.left, window.innerWidth - 300) + 'px';
  pop.style.top = (r.bottom + 6) + 'px';
}
/* 语法面板的令牌点击助手（挂 window 供内联 onclick 使用） */
export function qPick(token) { qInsert(token); hideQPop(); }
export function qPickOwner(o) { qRemoveToken(/@[^\s!#@]+/g); qInsert('@' + o); hideQPop(); }
export function qPickPri(p) { qRemoveToken(/\s*!P\d/gi); qInsert('!' + p); hideQPop(); }

/* ============ 搜索与筛选令牌 ============ */
/* 从剪贴板建任务（替代后台剪贴板监听的合规方案，见定位边界） */
export async function quickAddFromClipboard() {
  let text = '';
  try { text = await navigator.clipboard.readText(); } catch (e) { toast('读取剪贴板失败或无内容', 'err'); return; }
  if (!text.trim()) { toast('剪贴板是空的', 'info'); return; }
  const t = parseQuick(text.split('\n')[0]);
  if (!t.title) { toast('剪贴板内容没解析出标题', 'err'); return; }
  const p = curProject();
  try {
    await persistTask({ id: 0, projectId: p ? p.id : 0, title: t.title, due: t.due, owner: t.owner, pri: t.pri, status: 'todo', doneAt: '', risk: t.risk, repeat: t.repeat, note: '📌 来自剪贴板', createdAt: TODAY, sortOrder: 0, checklistJson: '[]' });
    render();
    toast('📌 已从剪贴板建任务：' + t.title.slice(0, 24));
  } catch (e) { toastErr('建任务失败', e); }
}
