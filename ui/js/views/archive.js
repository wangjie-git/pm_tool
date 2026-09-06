/* 归档、一页纸摘要 —— 拆分自 ui/app.js（来源行 3749-3824） */

import { TDialog, invoke } from '../backend.js';
import { cmpTask } from '../filter.js';
import { renderView } from '../render.js';
import { S, curProject, isOpen, parseSettings, projTasks, riskValue } from '../state.js';
import { monteCarloForecast } from '../stats.js';
import { persistProject } from '../tasks.js';
import { $id, esc, mdRender, toast, toastErr } from '../utils.js';

export function renderArchive() {
  const p = curProject(); if (!p) return;
  const s = parseSettings(p);
  const ts = projTasks(p.id);
  const open = ts.filter(t => isOpen(t)).sort(cmpTask);
  const done = ts.filter(t => t.status === 'done');
  const risks = open.filter(t => t.risk).sort((a, b) => riskValue(b) - riskValue(a));
  let h = '<div class="dec-head">'
    + '<span class="chip2 cd">📄 项目档案 · ' + esc(p.name) + '</span>'
    + '<button class="btn ghost" onclick="toggleOnePagerEditor()">✏️ 编辑一页纸</button>'
    + '<button class="btn ghost" onclick="exportProjectMd()">📤 整项目导出 Markdown（Obsidian）</button>'
    + '<button class="btn ghost" onclick="exportProjectXlsx()">📤 导出 .xlsx 计划表</button>'
    + '</div>';
  h += '<div class="stat-panel"><h3>一页纸（背景 / 目标 / 干系人 / 关键决策，支持 Markdown 与 [[反链]]）</h3>';
  h += '<div id="op-view" class="mdview">' + (s.onePager.trim() ? mdRender(s.onePager) : '<div class="empty">尚未撰写。点「✏️ 编辑一页纸」写下项目背景与目标，新人交接 / 向领导汇报一页讲清。</div>') + '</div>';
  h += '<div id="op-editor" hidden style="margin-top:10px;">'
    + '<textarea id="op-text" rows="8" placeholder="# 项目背景\n- 为什么立项、甲方是谁\n\n# 目标\n- 验收标准\n\n# 干系人\n- 决策人：[[某人]]\n\n# 关键决策\n- 引用决策日志里的 [[决策标题]]">' + esc(s.onePager) + '</textarea>'
    + '<div style="margin-top:8px;"><button class="btn blue" onclick="saveOnePager()">💾 保存</button> <button class="btn ghost" onclick="toggleOnePagerEditor()">取消</button></div></div>';
  h += '</div>';

  /* 任务总表 */
  h += '<div class="stat-panel"><h3>任务总表（未完成 ' + open.length + ' / 已完成 ' + done.length + '）</h3><table class="riskreg-table"><thead><tr><th>任务</th><th>负责人</th><th>优先级</th><th>截止</th><th>状态</th></tr></thead><tbody>'
    + (open.slice(0, 30).map(t => '<tr onclick="openTaskEdit(' + t.id + ')" style="cursor:pointer;"><td>' + esc(t.title) + '</td><td>' + esc(t.owner || '我方') + '</td><td>' + esc(t.pri || 'P1') + '</td><td>' + esc(t.due) + '</td><td>' + ({ todo: '待办', doing: '🔨 进行中', wait: '⏳ 等待' }[t.status] || '') + '</td></tr>').join('') || '<tr><td colspan="5" class="empty">无未完成任务</td></tr>')
    + '</tbody></table></div>';
  /* 风险册 */
  h += '<div class="stat-panel"><h3>风险册（' + risks.length + '）</h3>'
    + (risks.length ? '<table class="riskreg-table"><thead><tr><th>风险</th><th>风险值</th><th>应对</th><th>升级条件</th></tr></thead><tbody>'
      + risks.map(t => '<tr onclick="openTaskEdit(' + t.id + ')" style="cursor:pointer;"><td>' + esc(t.title) + '</td><td><b>' + (riskValue(t) || '—') + '</b></td><td>' + esc(t.riskMitigate || '—') + '</td><td>' + esc(t.riskEscalate || '—') + '</td></tr>').join('')
      + '</tbody></table>' : '<div class="empty">无开放风险</div>') + '</div>';
  /* 交付预测 brief + 统计 */
  const fc = monteCarloForecast(p.id, Math.max(1, open.filter(t => t.status !== 'wait').length));
  h += '<div class="stat-panel"><h3>交付预测 & 统计速览</h3><div class="chips-line">';
  if (fc.ok) h += '<span class="chip2 cd">🎯 剩余 ' + fc.remaining + ' 项：50% 于 ' + fc.p50 + ' · 85% 于 ' + fc.p85 + (fc.weekly ? '' : ' · 95% 于 ' + fc.p95) + '</span>';
  h += '<span class="chip2 good">已完成 ' + done.length + '</span>'
    + '<span class="chip2">未完成 ' + open.length + '</span>'
    + '<span class="chip2 warn">风险 ' + risks.length + '</span>'
    + '<span class="chip2">🏛 决策 ' + S.decisions.filter(d => d.projectId == p.id).length + ' 条</span>';
  h += '</div></div>';
  $id('viewArchive').innerHTML = h;
}
export function toggleOnePagerEditor() {
  const p = curProject(); if (!p) return;
  const ed = $id('op-editor'), vw = $id('op-view');
  if (ed.hidden) {
    const s = parseSettings(p);
    $id('op-text').value = s.onePager || '';
    ed.hidden = false; vw.hidden = true;
  } else {
    ed.hidden = true; vw.hidden = false;
  }
}
export async function saveOnePager() {
  const p = curProject(); if (!p) return;
  const s = parseSettings(p);
  s.onePager = $id('op-text').value;
  p.settingsJson = JSON.stringify(s);
  try {
    await persistProject(p);
    toast('一页纸已保存');
    renderView();
  } catch (e) { toastErr('保存失败', e); }
}
/* 包4 #18：整项目导出 Markdown（每任务一文件 + 项目主页） */
export async function exportProjectMd() {
  const p = curProject(); if (!p) return;
  let dir = null;
  try {
    dir = await TDialog().open({ title: '选择导出位置（会在其中创建项目文件夹）', directory: true, multiple: false });
  } catch (e) { toastErr('打开目录选择失败', e); return; }
  if (!dir) { toast('已取消导出', 'info'); return; }
  try {
    const out = await invoke('export_project_md', { dir: dir, projectId: p.id });
    toast('📦 已导出到：' + out + '（项目主页.md + tasks/ 目录 + 决策日志.md）');
  } catch (e) { toastErr('导出失败', e); }
}

