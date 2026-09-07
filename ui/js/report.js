/* 日报/周报生成、发送 —— 拆分自 ui/app.js（来源行 2269-2421） */

import { getJsonMeta, invoke, putJsonMeta } from './backend.js';
import { openModal } from './modal.js';
import { S, TODAY, checklistSummary, curProject, parseSettings, projNameOf, projTasks, riskValue } from './state.js';
import { $id, addDays, copyText, toast, toastErr } from './utils.js';
import { ganttBarDates } from './gantt.js';

export async function getShutdownMeta(dateStr) {
  return getJsonMeta('shutdown_' + dateStr, null);
}
export let reportOpenSeq = 0; /* 报告生成序号：快速连点日报/周报时后点击者胜，防止先发请求晚返回覆盖新预览（aiPolishReport 也用） */
/* 报告所属上下文：发送时用「生成报告时的项目」，不能重读当前项目——
 * 报告弹窗打开期间经 Ctrl+K / 深链接切换项目后，重读会拿 B 项目的 Webhook 推 A 的报告 */
let reportCtx = null;
export async function openReport(kind) {
  const p = curProject(); if (!p) return;
  const seq = ++reportOpenSeq;
  const s = parseSettings(p);
  reportCtx = { pid: p.id, webhook: s.webhook || {} };
  const ts = projTasks(p.id);
  let out = '';
  if (kind === 'day') {
    const yest = addDays(TODAY, -1);
    const doneToday = ts.filter(t => t.status === 'done' && t.doneAt === TODAY);
    const doneYest = ts.filter(t => t.status === 'done' && t.doneAt === yest);
    const planL = ts.filter(t => (t.status === 'todo' || t.status === 'doing') && t.due && t.due <= TODAY).sort((a, b) => a.due < b.due ? -1 : 1);
    const riskL = ts.filter(t => t.risk && t.status !== 'done')
      .slice().sort((a, b) => riskValue(b) - riskValue(a));
    const shut = await getShutdownMeta(yest);
    const shutToday = await getShutdownMeta(TODAY);

    out = '【' + s.report + '】' + TODAY + '\n\n';
    if (doneToday.length || (shutToday && shutToday.done && shutToday.done.trim())) {
      out += '一、今日完成（' + doneToday.length + ' 项）：\n';
      if (shutToday && shutToday.done && shutToday.done.trim()) out += '  ★ ' + shutToday.done.trim() + '\n';
      out += doneToday.length ? doneToday.map(t => '  ✔ ' + t.title + clSuffix(t)).join('\n') : '';
      if (doneYest.length) {
        out += '\n\n昨日完成：\n' + doneYest.map(t => '  ✔ ' + t.title + clSuffix(t)).join('\n');
      }
    } else {
      out += '一、昨日完成：\n';
      let hadShut = false;
      if (shut && shut.done && shut.done.trim()) { hadShut = true; out += '  ★ ' + shut.done.trim() + '\n'; }
      out += doneYest.length ? doneYest.map(t => '  ✔ ' + t.title + clSuffix(t)).join('\n') : (hadShut ? '' : '  （无，请补录昨天完成的事项）');
    }
    /* 收尾问答的「明天三件事」进入今日计划最前（#2） */
    let planLines = [];
    if (shut && shut.next3 && shut.next3.trim()) {
      shut.next3.trim().split(/\n+/).forEach(l => planLines.push('  ★ ' + l.trim()));
    }
    planL.forEach(t => planLines.push('  ▶ ' + t.title + '（' + (t.owner || '我方') + '）' + clSuffix(t)));
    out += '\n\n二、今日计划：\n' + (planLines.length ? planLines.join('\n') : '  （无）');
    out += '\n\n三、风险与需您决策事项：\n';
    out += riskL.length ? riskL.map(t => {
      const rv = riskValue(t);
      return '  ⚠ ' + t.title + (rv ? '［风险值 ' + rv + '：概率' + t.riskProb + '×影响' + t.riskImpact + '］' : '')
        + ' ｜ 状态：' + (t.status === 'wait' ? '等待' + (t.owner || '对方') + '回复' : '推进中')
        + (t.riskMitigate ? ' ｜ 应对：' + t.riskMitigate : '')
        + (t.riskEscalate ? ' ｜ 升级条件：' + t.riskEscalate : '')
        + (t.note && !t.riskMitigate ? ' ｜ ' + t.note : '');
    }).join('\n') : '  （无）';
    /* 包3 #9：日报自动附最近决策 */
    const recentDec = S.decisions.filter(d => d.projectId == p.id).slice(0, 3);
    out += '\n\n四、最近决策（决策日志）：\n';
    out += recentDec.length ? recentDec.map(d =>
      '  🏛 [' + (d.date || '') + '·' + (d.status || '生效中') + '] ' + d.title + (d.decision ? ' → ' + d.decision : '')).join('\n') : '  （无）';
    try {
      const logs = await invoke('get_time_logs', { since: TODAY }) || [];
      const mine = logs.filter(l => l.date === TODAY && projTasks(p.id).some(t => t.id == l.taskId));
      if (mine.length) {
        const mins = mine.reduce((x, l) => x + (l.minutes || 0), 0);
        out += '\n\n五、今日投入：' + (mins / 60).toFixed(1) + ' 小时（' + mine.length + ' 段计时）';
      }
    } catch (e) {}
    /* 包1 #4：日报附预算燃烧率（已用=全量累计；燃烧=近 7 天折算） */
    if (s.budgetHours > 0) {
      try {
        const [allLogs, wkLogs] = await Promise.all([
          invoke('get_time_logs', { since: '2000-01-01' }).catch(() => []),
          invoke('get_time_logs', { since: addDays(TODAY, -7) }).catch(() => [])
        ]);
        const usedAll = (allLogs || []).filter(l => l.projectId == p.id).reduce((x, l) => x + (l.minutes || 0), 0) / 60;
        const burnWk = (wkLogs || []).filter(l => l.projectId == p.id).reduce((x, l) => x + (l.minutes || 0), 0) / 60;
        const pct = Math.round(usedAll / s.budgetHours * 100);
        out += '\n\n六、工时预算：已用 ' + usedAll.toFixed(1) + ' / ' + s.budgetHours + ' 小时（' + pct + '%），近 7 天燃烧 ' + burnWk.toFixed(1) + ' 小时/周。';
      } catch (e) {}
    }
    if (shut && shut.stuck && shut.stuck.trim()) {
      out += '\n\n附：昨日收尾记录的卡点\n  ⛔ ' + shut.stuck.trim();
    }
    if (shut && shut.block && shut.block.trim()) {
      out += '\n  🛡 阻碍：' + shut.block.trim().replace(/\n/g, '；');
    }
    out += '\n\n—— 在本机点开项目：pm-todo://project/' + p.id;
  } else {
    const wkStart = addDays(TODAY, -6), wkEnd = addDays(TODAY, 7);
    const d1 = ts.filter(t => t.status === 'done' && t.doneAt && t.doneAt >= wkStart && t.doneAt <= TODAY);
    const d2 = ts.filter(t => (t.status === 'todo' || t.status === 'doing') && t.due > TODAY && t.due <= wkEnd);
    const d3 = ts.filter(t => t.status !== 'done' && (t.risk || t.status === 'wait'))
      .slice().sort((a, b) => riskValue(b) - riskValue(a));
    out = '【' + s.report.replace('日报', '周报') + '】' + wkStart + ' ~ ' + TODAY + '\n\n一、本周完成（' + d1.length + ' 项）：\n';
    out += d1.length ? d1.map(t => '  ✔ ' + t.title + clSuffix(t)).join('\n') : '  （无）';
    out += '\n\n二、下周计划：\n';
    out += d2.length ? d2.map(t => '  ▶ ' + t.title + '（' + (t.owner || '我方') + '，' + t.due + '）').join('\n') : '  （无）';
    out += '\n\n三、当前风险与阻塞项：\n';
    out += d3.length ? d3.map(t => {
      const rv = riskValue(t);
      return '  ⚠ ' + t.title + (rv ? '［风险值 ' + rv + '］' : '') + (t.riskMitigate ? ' ｜ 应对：' + t.riskMitigate : '') + (t.note && !t.riskMitigate ? ' ｜ ' + t.note : '');
    }).join('\n') : '  （无）';
    try {
      const logs = await invoke('get_time_logs', { since: wkStart }) || [];
      const week = logs.filter(l => l.date >= wkStart && l.date <= TODAY);
      if (week.length) {
        const byProj = {};
        week.forEach(l => { const k = l.projectId || 0; byProj[k] = (byProj[k] || 0) + (l.minutes || 0); });
        out += '\n\n四、本周各项目投入工时：\n';
        Object.keys(byProj).sort((a, b) => byProj[b] - byProj[a]).forEach(k => {
          out += '  📂 ' + (k === '0' ? '收件箱' : projNameOf(+k) || '（已删项目）') + '：' + (byProj[k] / 60).toFixed(1) + ' 小时\n';
        });
      }
    } catch (e) {}
    /* 包3 #9 + 包1 #4：周报附最近决策与预算燃烧率 */
    const recentDec = S.decisions.filter(d => d.projectId == p.id).slice(0, 5);
    if (recentDec.length) {
      out += '\n五、近期决策：\n';
      out += recentDec.map(d => '  🏛 [' + (d.date || '') + '] ' + d.title).join('\n');
    }
    if (s.budgetHours > 0) {
      try {
        const logs = await invoke('get_time_logs', { since: wkStart }) || [];
        const usedAll = await invoke('get_time_logs', { since: '2000-01-01' }).catch(() => []) || [];
        const used = usedAll.filter(l => l.projectId == p.id).reduce((x, l) => x + (l.minutes || 0), 0) / 60;
        const burnWk = logs.filter(l => l.projectId == p.id).reduce((x, l) => x + (l.minutes || 0), 0) / 60;
        out += '\n\n六、工时预算：已用 ' + used.toFixed(1) + ' / ' + s.budgetHours + ' 小时（' + Math.round(used / s.budgetHours * 100) + '%），本周燃烧 ' + burnWk.toFixed(1) + ' 小时。';
      } catch (e) {}
    }
    out += '\n\n—— 在本机点开项目：pm-todo://project/' + p.id;
  }
  if (seq !== reportOpenSeq) return; /* 期间又点了日报/周报：本次结果作废，避免旧报告覆盖新预览 */
  $id('r-title').textContent = kind === 'day' ? '日报预览（发送前补全括号内容）' : '周报预览（发送前核对日期范围）';
  $id('r-kind').value = kind;
  $id('r-area').value = out;
  $id('r-wh').hidden = !(s.webhook && s.webhook.type && s.webhook.url);
  $id('r-wh').textContent = '📤 发到群（' + ({ wecom: '企业微信', dingtalk: '钉钉', feishu: '飞书' }[s.webhook.type] || s.webhook.type) + '）';
  openModal('mw-report');
}
export function clSuffix(t) {
  const cl = checklistSummary(t);
  return cl && cl.total ? '［清单 ' + cl.done + '/' + cl.total + '］' : '';
}
/* 按 UTF-8 字节数切段（不拆代理对/多字节字符），用于群机器人单条上限 */
function chunkByUtf8Bytes(s, max) {
  const out = [];
  let cur = '', n = 0;
  for (const ch of s) {
    const cp = ch.codePointAt(0);
    const b = cp <= 0x7f ? 1 : cp <= 0x7ff ? 2 : cp <= 0xffff ? 3 : 4;
    if (n + b > max && cur) { out.push(cur); cur = ''; n = 0; }
    cur += ch; n += b;
  }
  if (cur || !out.length) out.push(cur);
  return out;
}
export function copyReport() {
  copyText($id('r-area').value, '已复制，去微信/邮件粘贴即可');
}
/* 日报/周报一键发到群机器人（#8）：企微/钉钉/飞书 Webhook */
let reportSending = false; /* 发送中防护：多段发送期间忽略重复点击，避免向群里重复推送 */
let reportSendFrom = 0; /* 已投递段数：中途失败后重试只发未送达的段，不重复推送前几段 */
export async function sendReportToGroup() {
  if (reportSending) return;
  if (!reportCtx) return;
  const wh = reportCtx.webhook || {};
  if (!wh.type || !wh.url) { toast('先在项目设置里配置群机器人 Webhook', 'err'); return; }
  const text = $id('r-area').value;
  if (!text.trim()) { toast('报告内容是空的，先写点内容再发', 'err'); return; }
  let body;
  if (wh.type === 'feishu') body = { msg_type: 'text', content: { text: text } };
  else body = { msgtype: 'text', text: { content: text } };
  /* 企业微信/钉钉单条上限约 4096 字节：中文 UTF-8 每字 3 字节，必须按字节而非字符数分段 */
  const chunks = chunkByUtf8Bytes(text, 3000);
  if (!chunks.length) chunks.push('');
  const btn = $id('r-wh');
  reportSending = true;
  if (btn) { btn.disabled = true; btn.textContent = '⏳ 发送中…'; }
  try {
    for (let i = reportSendFrom; i < chunks.length; i++) {
      const b = wh.type === 'feishu' ? { msg_type: 'text', content: { text: chunks[i] } } : { msgtype: 'text', text: { content: chunks[i] } };
      const resp = await invoke('send_webhook', { url: wh.url, signType: wh.type === 'dingtalk' ? 'dingtalk' : '', secret: wh.secret || '', body: JSON.stringify(b) });
      if (/errcode["']?\s*[:=]\s*[^0]/i.test(resp) && /errmsg/i.test(resp)) {
        reportSendFrom = i; /* 记住失败段：重试从这一段开始，不重发已投递的前缀 */
        throw new Error('机器人返回错误（第 ' + (i + 1) + ' 段）：' + resp);
      }
    }
    reportSendFrom = 0;
    toast('已发送到' + ({ wecom: '企业微信', dingtalk: '钉钉', feishu: '飞书' }[wh.type]) + '群（' + chunks.length + ' 条消息）');
    if ($id('r-kind').value === 'week') await saveWeekBaseline(reportCtx.pid);
  } catch (e) { toastErr('发送失败', e); }
  finally {
    reportSending = false;
    if (btn) { btn.disabled = false; btn.textContent = '📤 发到群（' + ({ wecom: '企业微信', dingtalk: '钉钉', feishu: '飞书' }[wh.type] || wh.type) + '）'; }
  }
}
/* ★★☆ 周报基线快照：发送周报时保存当前任务起止分布，时间线「🫥 上周对比」叠加虚影看计划漂移 */
export async function saveWeekBaseline(pid) {
  try {
    const snap = {};
    projTasks(pid).forEach(t => {
      const d = t.due ? ganttBarDates(t) : null;
      if (d) snap[t.id] = { start: d.start, due: d.due, title: t.title.slice(0, 40), status: t.status };
    });
    await putJsonMeta('weekSnapshot:' + pid, snap);
    toast('🫥 已保存本周基线快照（时间线里点「上周对比」可看计划漂移）', 'info');
  } catch (e) { /* 快照失败不影响发送 */ }
}
/* ============ AI 润色（#16）：自定义模型供应商 ============
 * 参考 ZCode 的自定义模型供应商：预设一家供应商（或完全自定义）+ Base URL + API Key + 模型 ID。
 * 统一走 OpenAI 兼容 /chat/completions 协议；本机 Ollama 的 /v1 端点也兼容，无需单独适配。
 * 配置存 meta('aiProvider')，密钥只存本机 SQLite，请求由本地 Rust 进程直连供应商。 */
