/* 收件箱、智能视图及其数据操作 —— 拆分自 ui/app.js（来源行 3000-3109, 666-690） */

import { getJsonMeta, putJsonMeta } from '../backend.js';
import { cmpTask } from '../filter.js';
import { askConfirm, closeModal, openModal } from '../modal.js';
import { render, smartViewById } from '../render.js';
import { RISK_RED, S, getTask, isOpen, isOverdue, projNameOf, riskValue, staleDays } from '../state.js';
import { persistTask } from '../tasks.js';
import { $id, esc, toast, toastErr } from '../utils.js';
import { cardHtml } from '../views/today.js';

export function renderInbox() {
  const list = S.tasks.filter(t => t.projectId == 0 && t.status === 'todo').sort(cmpTask);
  const alive = S.projects.filter(x => !x.archived);
  if (!list.length) {
    $id('viewInbox').innerHTML = '<div class="empty" style="padding:60px 0;text-align:center;">📥 收件箱已清空。快速添加时点 📥 按钮可先把任务丢进收件箱（Linear Triage 实践）</div>';
    return;
  }
  /* 🤖 建议分派（动线4）：先给每条算一次建议项目，头部汇总 + 卡片上一键采纳 */
  const sugg = {};
  let nSugg = 0;
  list.forEach(t => { const p = suggestProjectFor(t); if (p) { sugg[t.id] = p; nSugg++; } });
  let h = '<div class="inbox-hint">每天花 2 分钟分拣：给每条任务选项目后点「分派」，无主任务不入项目池。</div>';
  if (nSugg > 0) {
    h += '<div class="inbox-sugg-head">🤖 建议分派：已为 <b>' + nSugg + '</b> / ' + list.length + ' 条猜好目标项目（按标题关键词与项目已有任务重合度）——逐条点「采纳」即可，收件箱一次清一屏。</div>';
  }
  const vis = [];
  list.forEach(t => {
    vis.push(t.id);
    const sug = sugg[t.id];
    const sugChip = sug
      ? '<button class="sugg-chip" title="按标题关键词猜测的目标项目，点击一键采纳" onclick="adoptSuggestion(' + t.id + ',' + sug.id + ')">🤖 猜：' + esc(sug.name) + ' · 采纳</button>'
      : '';
    h += '<div class="inbox-card">' + cardHtml(t, false)
      + '<div class="assign-row"><span class="assign-lb">分派到：</span>'
      + '<select id="assign-' + t.id + '">' + alive.map(x => '<option value="' + x.id + '"' + (sug && x.id == sug.id ? ' selected' : '') + '>' + esc(x.name) + '</option>').join('') + '</select>'
      + '<button class="btn blue" onclick="assignInbox(' + t.id + ')">分派 →</button>'
      + sugChip
      + '<button class="btn ghost" onclick="snoozeTask(' + t.id + ')">⏭ 明天再说</button>'
      + '<button class="btn danger ghost" onclick="delTaskById(' + t.id + ', true)">删除</button>'
      + '</div></div>';
  });
  S.visibleIds = vis;
  $id('viewInbox').innerHTML = h;
}
/* 按标题 bigram 与项目名 / 项目已有任务标题的重合度猜目标项目（本地规则，无需联网） */
export function suggestProjectFor(t) {
  const alive = S.projects.filter(p => !p.archived);
  if (!alive.length) return null;
  const grams = s => {
    const out = [];
    const str = String(s || '').toLowerCase().replace(/\s+/g, '');
    for (let i = 0; i < str.length - 1; i++) out.push(str.slice(i, i + 2));
    return out;
  };
  const tg = new Set(grams(t.title + (t.note || '')));
  if (!tg.size) return null;
  let best = null, bestScore = 0;
  alive.forEach(p => {
    let score = 0;
    grams(p.name).forEach(g => { if (tg.has(g)) score += 3; });
    const pts = S.tasks.filter(x => x.projectId == p.id).slice(-40);
    pts.forEach(x => { grams(x.title).forEach(g => { if (tg.has(g)) score += 1; }); });
    if (score > bestScore) { bestScore = score; best = p; }
  });
  return bestScore >= 2 ? best : null; /* ≥2 个 bigram 重合才建议，避免乱猜 */
}
export async function adoptSuggestion(id, pid) {
  const t = getTask(id); if (!t) return;
  t.projectId = pid;
  try {
    await persistTask(t);
    toast('🤖 已采纳建议，分派到「' + projNameOf(pid) + '」');
    render();
  } catch (e) { toastErr('分派失败', e); }
}
export async function assignInbox(id) {
  const sel = $id('assign-' + id);
  if (!sel || !sel.value) return;
  const t = getTask(id); if (!t) return;
  t.projectId = +sel.value;
  try {
    await persistTask(t);
    toast('已分派到「' + projNameOf(t.projectId) + '」');
    render();
  } catch (e) { toastErr('分派失败', e); }
}

/* ============ 智能视图（#9） ============ */
export function renderSmart() {
  const v = smartViewById(S.smartId);
  const isAutoStale = S.smartId === 'auto-stale';
  const box = $id('viewSmart');
  if (!v && !isAutoStale) { box.innerHTML = '<div class="empty">视图不存在</div>'; return; }
  const archIds = S.projects.filter(p => p.archived).map(p => p.id);
  const crit = isAutoStale ? { staleDays: 14 } : v.crit;

  /* 风险登记册：表格化，按风险值排序（#6） */
  if (v && v.register) {
    const rows = S.tasks.filter(t => archIds.indexOf(t.projectId) < 0 && matchSmart(t, crit))
      .sort((a, b) => riskValue(b) - riskValue(a) || (a.due < b.due ? -1 : 1));
    let h = '<div class="riskreg">';
    h += '<div class="riskreg-head">风险登记册 · 按 概率(1-5)×影响(1-5) 排序，风险值 ≥ ' + RISK_RED + ' 标红置顶并强制进日报风险栏</div>';
    h += '<table><thead><tr><th>项目</th><th>风险</th><th>概率×影响</th><th>风险值</th><th>应对措施</th><th>升级条件</th><th>负责人</th><th>截止</th></tr></thead><tbody>';
    h += rows.length ? rows.map(t => {
      const rv = riskValue(t);
      return '<tr class="' + (rv >= RISK_RED ? 'bad' : rv >= 8 ? 'warn' : '') + '" onclick="openTaskEdit(' + t.id + ')">'
        + '<td>' + esc(projNameOf(t.projectId)) + '</td>'
        + '<td class="rt">' + esc(t.title) + '</td>'
        + '<td>' + (rv ? t.riskProb + ' × ' + t.riskImpact : '<span class="dim">未评分</span>') + '</td>'
        + '<td><b>' + (rv || '—') + '</b></td>'
        + '<td>' + esc(t.riskMitigate || '—') + '</td>'
        + '<td>' + esc(t.riskEscalate || '—') + '</td>'
        + '<td>' + esc(t.owner || '我方') + '</td>'
        + '<td>' + esc(t.due) + '</td></tr>';
    }).join('') : '<tr><td colspan="8" class="empty">暂无风险任务。给任务勾选「⚠ 计入日报风险栏」并在编辑里评分</td></tr>';
    h += '</tbody></table></div>';
    box.innerHTML = h;
    return;
  }

  const groups = [];
  S.projects.filter(p => !p.archived).forEach(p => {
    let ts2 = S.tasks.filter(t => t.projectId == p.id && matchSmart(t, crit));
    if (ts2.length) groups.push({ p: p, ts: ts2.sort(cmpTask) });
  });
  let h = groups.length ? '' : '<div class="empty" style="padding:60px 0;text-align:center;">没有匹配的任务 🎉</div>';
  groups.forEach(g => {
    h += '<h2 class="grp">📂 ' + esc(g.p.name) + ' <span class="gcnt">' + g.ts.length + ' 项</span>'
      + '<button class="linkbtn" onclick="switchProject(' + g.p.id + ')">进入项目 →</button></h2>';
    g.ts.forEach(t => { h += cardHtml(t, false); });
  });
  box.innerHTML = h;
}
export function openSaveSmartView() {
  $id('sv-name').value = '';
  $id('sv-risk').checked = false; $id('sv-overdue').checked = false;
  $id('sv-wait').value = ''; $id('sv-stale').value = ''; $id('sv-pri').value = '';
  openModal('mw-smart');
}
export async function saveSmartViewModal() {
  const name = $id('sv-name').value.trim();
  if (!name) { toast('给视图起个名字', 'err'); return; }
  const crit = readSmartCrit();
  if (!Object.keys(crit).length) { toast('至少选一个条件', 'err'); return; }
  S.smartViews.push({ id: 'v' + Date.now(), name: name, crit: crit, builtin: 0 });
  await putJsonMeta('smartViews', S.smartViews);
  closeModal('mw-smart');
  render();
  toast('智能视图「' + name + '」已保存');
}
function readSmartCrit() {
  const crit = {};
  if ($id('sv-risk').checked) crit.risk = 1;
  if ($id('sv-overdue').checked) crit.overdue = 1;
  if (+$id('sv-wait').value > 0) crit.waitDays = +$id('sv-wait').value;
  if (+$id('sv-stale').value > 0) crit.staleDays = +$id('sv-stale').value;
  if ($id('sv-pri').value) crit.pri = $id('sv-pri').value;
  return crit;
}
/* ★★☆ NL 建智能视图：把「逾期且有风险的 P0」这类一句话解析成勾选项（字段枚举可穷举校验） */
export function parseSmartNl() {
  const s = ($id('sv-nl').value || '').trim();
  if (!s) { toast('先输入一句描述，如：逾期且有风险的 P0', 'info'); return; }
  let hit = 0;
  if (/逾期|过期|overdue/i.test(s)) { $id('sv-overdue').checked = true; hit++; }
  if (/风险|⚠/.test(s)) { $id('sv-risk').checked = true; hit++; }
  const pri = s.match(/P([012])/i);
  if (pri) { $id('sv-pri').value = 'P' + pri[1].toUpperCase(); hit++; }
  const stale = s.match(/停滞\s*(\d+)\s*天/) || s.match(/(\d+)\s*天没(动静|更新)/);
  if (stale) { $id('sv-stale').value = Math.max(1, +stale[1]); hit++; }
  else if (/停滞/.test(s)) { $id('sv-stale').value = 7; hit++; }
  const wait = s.match(/等待超\s*(\d+)\s*天/) || s.match(/等超\s*(\d+)\s*天/);
  if (wait) { $id('sv-wait').value = Math.max(1, +wait[1]); hit++; }
  else if (/等待/.test(s)) { $id('sv-wait').value = 3; hit++; }
  if (!hit) {
    toast('没认出条件。可识别字段：逾期 / 风险 / P0-P2 / 停滞N天 / 等待超N天', 'err');
    return;
  }
  toast('已按描述勾选 ' + hit + ' 个条件，补充视图名后保存');
}
export async function deleteSmartView(id) {
  const v = smartViewById(id); if (!v) return;
  const ok = await askConfirm('删除智能视图', '删除「' + esc(v.name) + '」？只删视图，不动任务。', false);
  if (!ok) return;
  S.smartViews = S.smartViews.filter(x => x.id !== id);
  if (S.smartId === id) S.smartId = null; /* 清除指向已删除视图的残留引用 */
  await putJsonMeta('smartViews', S.smartViews);
  S.mode = 'project';
  render();
}

/* ============ 需求池（#14，RICE 简化为 价值/工时） ============ */
/* ---------- 智能视图（#9） ---------- */
export const SMART_SEED = [
  { id: 'risk-reg', name: '⚠ 风险登记册', crit: { risk: 1 }, builtin: 1, register: 1 },
  { id: 'risk-over', name: '⚠ 风险且逾期', crit: { risk: 1, overdue: 1 }, builtin: 1 },
  { id: 'wait-3', name: '⏳ 等待超 3 天', crit: { waitDays: 3 }, builtin: 1 }
];
export async function loadSmartViews() {
  const v = await getJsonMeta('smartViews', null);
  if (!v || !Array.isArray(v) || !v.length) S.smartViews = SMART_SEED.slice();
  else S.smartViews = v;
}
export function matchSmart(t, crit) {
  if (!isOpen(t)) return false;
  if (crit.risk && !t.risk) return false;
  if (crit.overdue && !isOverdue(t)) return false;
  if (crit.waitDays && !(t.status === 'wait' && staleDays(t) >= crit.waitDays)) return false;
  if (crit.staleDays && !(staleDays(t) >= crit.staleDays)) return false;
  if (crit.pri && (t.pri || 'P1') !== crit.pri) return false;
  return true;
}
export function smartTaskCount(v) {
  const archIds = S.projects.filter(p => p.archived).map(p => p.id);
  return S.tasks.filter(t => archIds.indexOf(t.projectId) < 0 && matchSmart(t, v.crit)).length;
}

