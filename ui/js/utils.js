/* 工具函数、markdown、wikilinks、copyText —— 拆分自 ui/app.js（来源行 237-240, 243-255, 257-374, 1429-1442） */

import { openTaskEdit } from './modals/task-edit.js';
import { openPalette, renderPalette } from './palette.js';
import { render } from './render.js';
import { S, TODAY, parseSettings, projNameOf } from './state.js';
import { switchProject } from './tasks.js';
import { openDecisionModal } from './views/decisions.js';

/* ============ 工具 ============ */
export function $id(x) { return document.getElementById(x); }
export function pad(n) { return n < 10 ? '0' + n : '' + n; }
export function todayStr() { const d = new Date(); return d.getFullYear() + '-' + pad(d.getMonth() + 1) + '-' + pad(d.getDate()); }
export function nowMinStr() { const d = new Date(); return todayStr() + ' ' + pad(d.getHours()) + ':' + pad(d.getMinutes()); }
export function addDays(s, n) { const p = s.split('-'); const d = new Date(+p[0], +p[1] - 1, +p[2]); d.setDate(d.getDate() + n); return d.getFullYear() + '-' + pad(d.getMonth() + 1) + '-' + pad(d.getDate()); }
/* 月份加法：超出当月天数自动取月末（1-31 → 2-28/2-29） */
export function addMonths(s, n) {
  const p = s.split('-');
  let y = +p[0], m = +p[1] - 1 + n;
  y += Math.floor(m / 12); m = ((m % 12) + 12) % 12;
  const dim = new Date(y, m + 1, 0).getDate();
  const d = Math.min(+p[2], dim);
  return y + '-' + pad(m + 1) + '-' + pad(d);
}
export function esc(s) { return (s == null ? '' : '' + s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;'); }
export function daysDiff(d) { return Math.round((new Date(d) - new Date(TODAY)) / 86400000); }

export function toast(msg, type, action) {
  const el = document.createElement('div');
  el.className = 'toast ' + (type || 'ok');
  const span = document.createElement('span');
  span.textContent = msg;
  el.appendChild(span);
  if (action) {
    const btn = document.createElement('button');
    btn.textContent = action.label;
    btn.onclick = () => { action.onClick(); el.remove(); };
    el.appendChild(btn);
  }
  $id('toasts').appendChild(el);
  setTimeout(() => { el.style.opacity = '0'; el.style.transition = 'opacity .3s'; setTimeout(() => el.remove(), 320); }, action ? 6500 : 2600);
}
export function toastErr(context, e) { console.error(context, e); toast(context + '：' + (e && e.message || e), 'err'); }

/* ============ 轻量 Markdown 渲染（包4 #13）+ [[反链]]（#14） ============
 * 只覆盖备注/决策/笔记真正用到的子集：标题、列表、引用、粗斜体、行内码、代码块、分隔线、[[链接]]、@提及。
 * 输入先整体 HTML 转义再打标记，天然防注入。 */
export function mdInline(s) {
  let out = esc(s);
  /* 附件图片（★☆☆ 粘贴截图）：![](att:文件名) → 应用数据目录下的真实资源地址 */
  out = out.replace(/!\[([^\]]*)\]\(att:([^)\s]+)\)/g, (m, alt, name) => {
    if (!S.attachDir) return '<span class="dim2">📎 图片 ' + name + '</span>';
    return '<img alt="' + alt + '" src="' + attSrc(name) + '">';
  });
  out = out.replace(/\[\[([^\[\]]+)\]\]/g, (m, t) => '<a class="wikilink" data-w="' + esc(t) + '" title="跳转到「' + esc(t) + '」">' + esc(t) + '</a>');
  out = out.replace(/`([^`]+)`/g, (m, c) => '<code>' + c + '</code>');
  out = out.replace(/\*\*([^*]+)\*\*/g, '<b>$1</b>');
  out = out.replace(/(^|[^*])\*([^*\n]+)\*/g, '$1<i>$2</i>');
  return out;
}
/* att: 附件名 → 可显示的 URL（Tauri asset 协议；浏览器预览下返回空则显示占位） */
export function attSrc(name) {
  try {
    const c = window.__TAURI__ && window.__TAURI__.core && window.__TAURI__.core.convertFileSrc;
    if (c && S.attachDir) return c(S.attachDir + '\\' + name);
  } catch (e) {}
  return '';
}
export function mdRender(src) {
  const lines = String(src == null ? '' : src).replace(/\r\n/g, '\n').split('\n');
  let html = '', inCode = false, inList = false, listTag = 'ul', para = [];
  const flushPara = () => { if (para.length) { html += '<p>' + mdInline(para.join(' ')) + '</p>'; para = []; } };
  const closeList = () => { if (inList) { html += '</' + listTag + '>'; inList = false; } };
  for (const raw of lines) {
    const line = raw;
    if (/^```/.test(line.trim())) {
      flushPara(); closeList();
      if (inCode) { html += '</code></pre>'; inCode = false; }
      else { html += '<pre><code>'; inCode = true; }
      continue;
    }
    if (inCode) { html += esc(line) + '\n'; continue; }
    if (!line.trim()) { flushPara(); closeList(); continue; }
    const h = line.match(/^(#{1,4})\s+(.*)$/);
    if (h) { flushPara(); closeList(); html += '<h4 class="mdh">' + mdInline(h[2]) + '</h4>'; continue; }
    const ul = line.match(/^\s*[-*]\s+(.*)$/);
    const ol = line.match(/^\s*\d+[.、]\s+(.*)$/);
    if (ul || ol) {
      flushPara();
      const tag = ol ? 'ol' : 'ul';
      if (inList && listTag !== tag) closeList();
      if (!inList) { html += '<' + tag + '>'; inList = true; listTag = tag; }
      html += '<li>' + mdInline((ul || ol)[1]) + '</li>';
      continue;
    }
    const q = line.match(/^\s*>\s?(.*)$/);
    if (q) { flushPara(); closeList(); html += '<blockquote>' + mdInline(q[1]) + '</blockquote>'; continue; }
    if (/^\s*(---+|\*\*\*+)\s*$/.test(line)) { flushPara(); closeList(); html += '<hr>'; continue; }
    para.push(line.trim());
  }
  flushPara(); closeList();
  if (inCode) html += '</code></pre>';
  return html || '<p class="dim2">（空）</p>';
}
/* [[反链]] 索引：扫全库找提到 title 的地方（单机数据量小，动态扫描免维护同步表） */
export function extractWikilinks(text) {
  const out = [];
  const s = String(text || '');
  const re = /\[\[([^\[\]]+)\]\]/g;
  let m;
  while ((m = re.exec(s))) {
    const t = m[1].trim();
    if (t && out.indexOf(t) < 0) out.push(t);
  }
  return out;
}
export function findTaskByTitle(title) {
  return S.tasks.find(t => t.title === title) || null;
}
/* 谁/哪些记录提到了 title：任务备注、决策、会议、每日笔记、项目一页纸 */
export function backlinksOf(title) {
  const out = [];
  const hit = (text) => extractWikilinks(text).some(x => x === title) || new RegExp('(^|[^\\w])@' + title.replace(/[.*+?^${}()|[\]\\]/g, '\\$&') + '(?![\\w])').test(String(text || ''));
  S.tasks.forEach(t => {
    if (t.title === title) return;
    if (hit(t.note)) out.push({ kind: 'task', id: t.id, label: t.title, sub: '任务 · ' + projNameOf(t.projectId) });
  });
  S.decisions.forEach(d => {
    if (d.title === title) return;
    if (hit([d.background, d.options, d.decision, d.reason].join('\n'))) out.push({ kind: 'decision', id: d.id, label: d.title, sub: '决策 · ' + (d.date || '') });
  });
  S.meetings.forEach(mm => {
    if (hit([mm.conclusion, (mm.itemsJson || '')].join('\n'))) out.push({ kind: 'meeting', id: mm.id, label: mm.title, sub: '会议 · ' + (mm.date || '') });
  });
  S.projects.forEach(p => {
    const s = parseSettings(p);
    if (s.onePager && hit(s.onePager)) out.push({ kind: 'project', id: p.id, label: p.name + ' 一页纸', sub: '项目档案' });
  });
  return out.slice(0, 12);
}
/* [[链接]] / @提及 的点击代理：优先跳任务，其次决策，最后搜命令面板 */
export function handleWikilinkClick(e) {
  const a = e.target.closest ? e.target.closest('.wikilink') : null;
  if (!a) return;
  e.preventDefault();
  const t = a.getAttribute('data-w');
  if (!t) return;
  const task = findTaskByTitle(t);
  if (task) { S.cur = '' + task.projectId; S.mode = 'project'; render(); openTaskEdit(task.id); return; }
  const d = S.decisions.find(x => x.title === t);
  if (d) { if (d.projectId && S.projects.some(p => p.id == d.projectId)) switchProject(d.projectId); S.mode = 'project'; S.view = 'decisions'; render(); openDecisionModal(d.id); return; }
  openPalette();
  $id('pal-input').value = t;
  renderPalette(t);
}

/* ============ 包1 统计工具：吞吐量 / 蒙特卡洛 / SLE ============ */
export function copyText(text, okMsg) {
  let ok = false;
  try { if (navigator.clipboard && navigator.clipboard.writeText) { navigator.clipboard.writeText(text); ok = true; } } catch (e) {}
  if (!ok) {
    try {
      const ta = document.createElement('textarea');
      ta.value = text; document.body.appendChild(ta); ta.select();
      ok = document.execCommand('copy'); ta.remove();
    } catch (e) {}
  }
  toast(ok ? okMsg : '复制失败，请手动复制', ok ? 'ok' : 'err');
  return ok;
}

/* SVG 字符串 → PNG dataURL（2x 高清，白底）。甘特导出与统计导出共用（零依赖方案） */
export async function svgStringToPng(str, w, h, scale) {
  const sc = scale || 2;
  const img = new Image();
  const svg64 = 'data:image/svg+xml;charset=utf-8,' + encodeURIComponent(str);
  await new Promise((res, rej) => {
    img.onload = res;
    img.onerror = () => rej(new Error('SVG 渲染失败'));
    img.src = svg64;
  });
  const canvas = document.createElement('canvas');
  canvas.width = w * sc;
  canvas.height = h * sc;
  const ctx = canvas.getContext('2d');
  ctx.fillStyle = '#ffffff';
  ctx.fillRect(0, 0, canvas.width, canvas.height);
  ctx.drawImage(img, 0, 0, canvas.width, canvas.height);
  return canvas.toDataURL('image/png');
}

