/* 备份导入导出、CSV 导出 —— 拆分自 ui/app.js（来源行 2785-2910） */

import { TDialog, invoke } from './backend.js';
import { cmpTask } from './filter.js';
import { askConfirm } from './modal.js';
import { render } from './render.js';
import { S, TODAY, checklistSummary, curProject, getTask, projTasks, repeatLabel } from './state.js';
import { createProject, loadFrogs, loadRules, refreshTrashCount, updateTimerBar } from './tasks.js';
import { toast, toastErr } from './utils.js';

export async function exportBackup() {
  let path = null;
  try {
    path = await TDialog().save({
      title: '导出备份',
      defaultPath: 'pm-backup-' + TODAY + '.json',
      filters: [{ name: 'JSON', extensions: ['json'] }]
    });
  } catch (e) { toastErr('打开保存对话框失败', e); return; }
  if (!path) { toast('桌面版支持选择位置导出；浏览器预览模式不可用', 'info'); return; }
  let timeLogs = [];
  try { timeLogs = await invoke('get_time_logs', { since: '2000-01-01' }) || []; } catch (e) {}
  /* meta 一并导出：每日笔记/收尾问答/智能视图/项目模板/AI 配置都存 meta 表，漏掉换机恢复即丢 */
  let meta = [];
  try { meta = await invoke('list_all_meta') || []; } catch (e) {}
  const data = { v: 4, exportedAt: TODAY, projects: S.projects, tasks: S.tasks, ideas: S.ideas, timeLogs: timeLogs,
    decisions: S.decisions, meetings: S.meetings, contacts: S.contacts, meta: meta };
  try {
    await invoke('save_text_file', { path: path, content: JSON.stringify(data, null, 1) });
    toast('已备份到：' + path);
  } catch (e) { toastErr('备份失败', e); }
}

let importing = false; /* 导入进行中防重：二次点击不并发跑全量替换 */
export async function importBackup() {
  if (importing) return;
  importing = true;
  try {
    let path = null;
    try {
      path = await TDialog().open({
        title: '导入备份',
        multiple: false,
        filters: [{ name: 'JSON', extensions: ['json'] }]
      });
    } catch (e) { toastErr('打开文件对话框失败', e); return; }
  if (!path) { toast('未选择文件；浏览器预览模式不支持导入', 'info'); return; }
  let d = null;
  try {
    const raw = await invoke('read_text_file', { path: path });
    d = JSON.parse(raw);
  } catch (e) { toastErr('文件解析失败', e); return; }
  if (!d || !Array.isArray(d.projects)) { toast('文件格式不对：缺少 projects', 'err'); return; }
  const ok = await askConfirm('导入备份', '导入将<b>覆盖当前全部数据</b>（' + d.projects.length + ' 个项目 / ' + (d.tasks || []).length + ' 条事项），继续？', true);
  if (!ok) return;
  /* 数值字段防 NaN：损坏/缺字段的备份按 0 归位（后端按 id=0 视为新建），
   * 否则 NaN 序列化为 null 会让整次导入在反序列化 i64 时失败且不指明哪条记录 */
  const nid = v => { const n = +v; return Number.isFinite(n) ? n : 0; };
  d.projects = d.projects.map(p => ({
    id: nid(p.id), name: String(p.name || '未命名'), archived: !!p.archived,
    createdAt: p.createdAt || TODAY,
    settingsJson: typeof p.settingsJson === 'string'
      ? p.settingsJson
      : JSON.stringify(p.settings || { report: (p.name || '') + ' 进度日报', milestones: [{ label: '', date: '' }, { label: '', date: '' }, { label: '', date: '' }] })
  }));
  d.tasks = (d.tasks || []).map(t => ({
    id: nid(t.id), projectId: nid(t.projectId), title: String(t.title || ''), due: t.due || TODAY,
    owner: t.owner || '', pri: t.pri || 'P1', status: t.status || 'todo', doneAt: t.doneAt || '',
    risk: !!t.risk, repeat: t.repeat || '', note: t.note || '', createdAt: t.createdAt || TODAY, sortOrder: +t.sortOrder || 0,
    updatedAt: t.updatedAt || '',
    checklistJson: typeof t.checklistJson === 'string' ? t.checklistJson : '[]',
    deferCount: +t.deferCount || 0, riskProb: +t.riskProb || 0, riskImpact: +t.riskImpact || 0,
    riskMitigate: t.riskMitigate || '', riskEscalate: t.riskEscalate || '',
    doingSince: t.doingSince || '', parentId: nid(t.parentId),
    startDate: t.startDate || '', isMilestone: !!t.isMilestone,
    remindAt: t.remindAt || ''
  }));
  d.ideas = (d.ideas || []).map(i => ({
    id: nid(i.id), title: String(i.title || ''), note: String(i.note || ''),
    value: Math.max(1, Math.min(10, +i.value || 3)), effort: Math.max(1, Math.min(10, +i.effort || 3)),
    converted: +i.converted || 0, createdAt: i.createdAt || TODAY
  }));
  d.timeLogs = (d.timeLogs || []).map(l => ({
    id: nid(l.id), taskId: nid(l.taskId), projectId: nid(l.projectId),
    date: l.date || TODAY, minutes: +l.minutes || 0, note: l.note || ''
  }));
  /* 决策/会议/干系人必须一起导入：后端 import_data 是全量替换语义，
   * 不传这三类会先 DELETE 再插空数组，等于清空 */
  d.decisions = (d.decisions || []).map(x => ({
    id: nid(x.id), projectId: nid(x.projectId), title: String(x.title || ''),
    background: String(x.background || ''), options: String(x.options || ''),
    decision: String(x.decision || ''), reason: String(x.reason || ''),
    date: x.date || TODAY, status: x.status || '生效中',
    taskId: nid(x.taskId), meetingId: nid(x.meetingId), createdAt: x.createdAt || ''
  }));
  d.meetings = (d.meetings || []).map(x => ({
    id: nid(x.id), date: x.date || TODAY, title: String(x.title || ''),
    attendees: String(x.attendees || ''), conclusion: String(x.conclusion || ''),
    projectId: nid(x.projectId),
    itemsJson: typeof x.itemsJson === 'string' ? x.itemsJson : '[]',
    createdAt: x.createdAt || ''
  }));
  d.contacts = (d.contacts || []).map(x => ({
    id: nid(x.id), name: String(x.name || ''), org: String(x.org || ''),
    tags: String(x.tags || ''), projects: String(x.projects || ''), note: String(x.note || ''),
    lastContact: x.lastContact || '', followupDays: Math.max(1, +x.followupDays || 7), createdAt: x.createdAt || ''
  }));
  try {
    await invoke('import_data', { data: { projects: d.projects, tasks: d.tasks, ideas: d.ideas, timeLogs: d.timeLogs,
      decisions: d.decisions, meetings: d.meetings, contacts: d.contacts } });
    S.projects = d.projects; S.tasks = d.tasks; S.ideas = d.ideas;
    S.decisions = d.decisions; S.meetings = d.meetings; S.contacts = d.contacts;
    /* 恢复 meta（每日笔记/收尾问答/智能视图/模板/AI 配置等）；跳过计时器/窗口位置/当日去重标记等本机运行态 */
    const VOLATILE_META = /^(timerTaskId|timerStart|winW|winH|winX|winY|lastNotifyDate|lastShutdownNotify|budgetAlert)/;
    if (Array.isArray(d.meta)) {
      for (const m of d.meta) {
        if (!m || !m.key || VOLATILE_META.test(String(m.key))) continue;
        try { await invoke('set_meta', { key: String(m.key), value: String(m.value == null ? '' : m.value) }); } catch (e2) {}
      }
    }
    /* 全量替换后清理运行态引用，避免计时条挂着已删除的任务、青蛙指向失效 id */
    await loadRules();
    await loadFrogs();
    /* 重建每日笔记搜索索引：导入的笔记若不带索引，全局搜索会漏掉直到重启 */
    try {
      const rows = await invoke('list_meta_prefix', { prefix: 'dailyNote_' }) || [];
      S.dnIndex = rows
        .filter(r => r.key && r.key.indexOf('dailyNote_') === 0 && r.value)
        .map(r => ({ date: r.key.slice('dailyNote_'.length), text: String(r.value).slice(0, 400) }));
    } catch (e2) { S.dnIndex = []; }
    if (S.timer && !getTask(S.timer.taskId)) { S.timer = null; updateTimerBar(); }
    if (S.kbId != null && !getTask(S.kbId)) S.kbId = null;
    S.sel = [];
    if (!S.projects.length) await createProject('示例项目');
    if (!curProject()) S.cur = '' + S.projects[0].id;
    await refreshTrashCount(); /* 导入清空回收站（后端 DELETE deleted_items），同步角标避免残留旧数字 */
    render();
    toast('导入完成');
  } catch (e) { toastErr('导入失败', e); }
  } finally { importing = false; }
}

export async function exportCsv() {
  const p = curProject(); if (!p) return;
  let path = null;
  try {
    path = await TDialog().save({
      title: '导出 CSV',
      defaultPath: p.name + '-任务-' + TODAY + '.csv',
      filters: [{ name: 'CSV', extensions: ['csv'] }]
    });
  } catch (e) { toastErr('打开保存对话框失败', e); return; }
  if (!path) { toast('桌面版支持选择位置导出；浏览器预览模式不可用', 'info'); return; }
  const stMap = { todo: '待办', doing: '进行中', wait: '等人/等外部', done: '已完成' };
  const q = v => '"' + String(v == null ? '' : v).replace(/"/g, '""') + '"';
  const rows = [['标题', '截止日期', '负责人', '优先级', '状态', '风险', '循环', '检查清单', '备注', '完成日期', '创建日期', '更新时间']];
  projTasks(p.id).slice().sort(cmpTask).forEach(t => {
    const cl = checklistSummary(t);
    rows.push([t.title, t.due, t.owner || '我方', t.pri || 'P1', stMap[t.status] || t.status,
      t.risk ? '是' : '', repeatLabel(t.repeat),
      cl ? cl.done + '/' + cl.total : '', t.note, t.doneAt, t.createdAt, t.updatedAt || '']);
  });
  const csv = '\uFEFF' + rows.map(r => r.map(q).join(',')).join('\r\n');
  try {
    await invoke('save_text_file', { path: path, content: csv });
    toast('已导出 CSV：' + path);
  } catch (e) { toastErr('导出失败', e); }
}

/* ============ 弹窗基础 / 确认 / 输入 ============ */
