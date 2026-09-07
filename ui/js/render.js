/* 主渲染循环、侧栏、页头、视图分发 —— 拆分自 ui/app.js（来源行 1128-1359） */

import { invoke } from './backend.js';
import { renderTimeline } from './gantt.js';
import { hideQPop } from './quickadd.js';
import { S, TODAY, curProject, isOpen, parseSettings, projTasks, staleDays } from './state.js';
import { renderStats } from './stats.js';
import { $id, addDays, daysDiff, esc } from './utils.js';
import { renderArchive } from './views/archive.js';
import { renderKanban, renderList } from './views/board.js';
import { renderCalendar } from './views/calendar.js';
import { contactDueDays, renderContacts } from './views/contacts.js';
import { renderDailyNote } from './views/dailynote.js';
import { renderDecisions } from './views/decisions.js';
import { renderIdeas } from './views/ideas.js';
import { matchSmart, renderInbox, renderSmart, smartTaskCount } from './views/inbox.js';
import { renderMeetings } from './views/meetings.js';
import { renderSearch } from './views/search.js';
import { renderToday, todayGroups } from './views/today.js';
import { renderBatchBar } from './tasks.js';

/* ============ 渲染 ============ */
export function render() {
  renderSidebar();
  renderHeader();
  renderView();
}

/* 滚动保持（动线2）：同一 mode+view+项目 内的重渲染（勾完成/改状态/批量选择）恢复原滚动位置，切视图/项目才回顶 */
let lastViewCtx = '';
export function renderView() {
  const ctx = S.mode + '|' + S.view + '|' + (S.cur || '') + '|' + (S.smartId || '') + '|' + (S.mode === 'search' ? S.search : '');
  const content = $id('content');
  const sameCtx = ctx === lastViewCtx;
  const keep = sameCtx ? content.scrollTop : 0;
  if (!sameCtx) {
    S.visibleIds = []; /* 键盘行导航/批量选择的可见任务序，由支持的任务视图渲染器填充，防跨视图残留 */
    S.kbId = null;
    S.sel = [];
  }
  lastViewCtx = ctx;
  renderViewInner();
  renderBatchBar();
  content.scrollTop = keep;
}

export function renderSidebar() {
  /* 今日聚焦：跨项目的今日待办总数 */
  const archIds = S.projects.filter(p => p.archived).map(p => p.id);
  const tCnt = S.tasks.filter(t => archIds.indexOf(t.projectId) < 0 && t.status !== 'done' && t.status !== 'wait' && t.due && t.due <= TODAY).length;
  const iCnt = S.tasks.filter(t => t.projectId == 0 && t.status === 'todo').length;
  $id('todayNav').innerHTML =
    '<div class="proj today ' + (S.mode === 'today' ? 'on' : '') + '" onclick="openTodayFocus()" title="所有项目的今日到期 / 逾期 / 进行中">'
    + '<span class="dot"></span><span class="nm">📅 今日聚焦</span>'
    + '<span class="cnt ' + (tCnt ? 'hot' : '') + '">' + tCnt + '</span></div>'
    + '<div class="proj ' + (S.mode === 'inbox' ? 'on' : '') + '" onclick="openInbox()" title="快速添加时选 📥 先进收件箱，之后再分派到项目">'
    + '<span class="dot"></span><span class="nm">📥 收件箱</span>'
    + '<span class="cnt ' + (iCnt ? 'hot' : '') + '">' + iCnt + '</span></div>';

  const alive = S.projects.filter(p => !p.archived);
  $id('projNav').innerHTML = alive.map(p => {
    const n = projTasks(p.id).filter(t => t.status !== 'done').length;
    return '<div class="proj ' + (S.mode === 'project' && p.id == S.cur ? 'on' : '') + '" data-pid="' + p.id + '" onclick="switchProject(' + p.id + ')">'
      + '<span class="dot"></span><span class="nm">' + esc(p.name) + '</span>'
      + '<span class="cnt">' + n + '</span>'
      + '<button class="gear" title="项目设置" onclick="event.stopPropagation();openProjectSettings(' + p.id + ')">⚙</button></div>';
  }).join('') || '<div class="empty">暂无项目，点上方 ＋ 新建</div>';

  /* 智能视图（#9） + 规则自动化出的「待清理」（#13） */
  let smartHtml = S.smartViews.map(v =>
    '<div class="proj smart ' + (S.mode === 'smart' && S.smartId === v.id ? 'on' : '') + '" onclick="openSmartView(\'' + v.id + '\')">'
    + '<span class="dot"></span><span class="nm">' + esc(v.name) + '</span>'
    + '<span class="cnt">' + smartTaskCount(v) + '</span></div>').join('');
  if (S.rules.staleCleanup) {
    const staleCnt = S.tasks.filter(t => archIds.indexOf(t.projectId) < 0 && isOpen(t) && staleDays(t) >= 14).length;
    if (staleCnt) {
      smartHtml += '<div class="proj smart ' + (S.mode === 'smart' && S.smartId === 'auto-stale' ? 'on' : '') + '" onclick="openSmartView(\'auto-stale\')" title="停滞超 14 天，建议每周回顾时清理">'
        + '<span class="dot"></span><span class="nm">🧹 待清理</span>'
        + '<span class="cnt hot">' + staleCnt + '</span></div>';
    }
  }
  $id('smartNav').innerHTML = smartHtml || '<div class="empty">暂无智能视图</div>';

  /* 需求池（#14） */
  const openIdeas = S.ideas.filter(x => !x.converted).length;
  $id('ideasNav').innerHTML =
    '<div class="proj ' + (S.mode === 'ideas' ? 'on' : '') + '" onclick="openIdeas()" title="记下领导口头诉求，评审时按 价值/工时 排优先级">'
    + '<span class="dot"></span><span class="nm">💡 需求池</span>'
    + '<span class="cnt ' + (openIdeas ? '' : '') + '">' + openIdeas + '</span></div>';

  /* 组织记忆（包3/包4）：会议纪要 / 干系人 / 每日笔记 */
  const dueContacts = S.contacts.filter(c => contactDueDays(c) <= 0).length;
  $id('memoryNav').innerHTML =
    '<div class="proj ' + (S.mode === 'meetings' ? 'on' : '') + '" onclick="openMeetings()" title="会后笔记模板：议题/参与人/结论/行动项，行动项一键转任务">'
    + '<span class="dot"></span><span class="nm">🗂 会议纪要</span><span class="cnt">' + S.meetings.length + '</span></div>'
    + '<div class="proj ' + (S.mode === 'contacts' ? 'on' : '') + '" onclick="openContacts()" title="干系人档案 + 跟进周期，到期自动生成跟进任务">'
    + '<span class="dot"></span><span class="nm">👥 干系人</span>'
    + '<span class="cnt ' + (dueContacts ? 'hot' : '') + '">' + (dueContacts ? dueContacts + '!' : S.contacts.length) + '</span></div>'
    + '<div class="proj ' + (S.mode === 'dailynote' ? 'on' : '') + '" onclick="openDailyNote()" title="每日笔记：当日任务+青蛙+收尾+会议自动聚合，可写自己的 MD">'
    + '<span class="dot"></span><span class="nm">📝 每日笔记</span></div>';

  const arch = S.projects.filter(p => p.archived);
  $id('archWrap').innerHTML = arch.length
    ? '<details><summary>已归档（' + arch.length + '）</summary>' + arch.map(p =>
        '<div class="proj ' + (S.mode === 'project' && p.id == S.cur ? 'on' : '') + '" data-pid="' + p.id + '" onclick="switchProject(' + p.id + ')">'
        + '<span class="dot"></span><span class="nm">' + esc(p.name) + '</span>'
        + '<button class="gear" title="项目设置" onclick="event.stopPropagation();openProjectSettings(' + p.id + ')">⚙</button></div>').join('') + '</details>'
    : '';
}

export let headerSeq = 0;
export async function renderHeader() {
  const p = curProject(); if (!p) return;
  const seq = ++headerSeq; /* 异步渲染竞态防护：await 后若已有更新一次渲染，本次结果作废 */
  const todayMode = S.mode === 'today';
  const specialMode = S.mode === 'inbox' || S.mode === 'ideas' || S.mode === 'smart' || S.mode === 'meetings' || S.mode === 'contacts' || S.mode === 'dailynote' || S.mode === 'search';
  $id('projName').textContent = S.mode === 'inbox' ? '📥 收件箱 · 待分拣'
    : S.mode === 'search' ? '🔍 全局搜索'
    : S.mode === 'ideas' ? '💡 需求池'
    : S.mode === 'meetings' ? '🗂 会议纪要'
    : S.mode === 'contacts' ? '👥 干系人'
    : S.mode === 'dailynote' ? '📝 每日笔记'
    : S.mode === 'smart' ? (S.smartId === 'auto-stale' ? '🧹 待清理（停滞 ≥14 天）' : (smartViewById(S.smartId) || {}).name || '智能视图')
    : todayMode ? '📅 今日聚焦' : p.name;
  $id('projName').style.cursor = (todayMode || specialMode) ? 'default' : 'pointer';
  /* 两层页签高亮：一级=页面，二级=任务呈现 */
  const taskViews = ['list', 'kanban', 'calendar', 'timeline'];
  const isProj = !todayMode && S.mode !== 'search' && S.mode !== 'inbox' && S.mode !== 'ideas' && S.mode !== 'smart' && S.mode !== 'meetings' && S.mode !== 'contacts' && S.mode !== 'dailynote';
  /* A2：全局模式（今日聚焦/收件箱/统计外页等）隐藏项目页签，语义不再混乱 */
  $id('pageTabs').hidden = !isProj;
  document.querySelectorAll('#pageTabs button').forEach(b => {
    const on = isProj && (b.dataset.page === 'task' ? taskViews.indexOf(S.view) >= 0 : b.dataset.page === S.view);
    b.classList.toggle('on', on);
  });
  $id('viewSeg').hidden = !isProj || taskViews.indexOf(S.view) < 0;
  document.querySelectorAll('#viewSeg button').forEach(b => b.classList.toggle('on', isProj && b.dataset.view === S.view));
  $id('projMoreWrap').hidden = !isProj;

  /* 日报/周报是项目级操作，今日聚焦/收件箱/需求池/智能视图下隐藏 */
  $id('btnDay').hidden = todayMode || specialMode;
  $id('btnWeek').hidden = todayMode || specialMode;
  $id('btnTodayCopy').hidden = !todayMode;
  $id('qProj').hidden = !(todayMode || isProj);

  /* A10：不支持搜索的模式（会议/干系人/需求池/每日笔记）禁用搜索框并说明 */
  const searchOff = S.mode === 'meetings' || S.mode === 'contacts' || S.mode === 'ideas' || S.mode === 'dailynote';
  const se = $id('search');
  if (searchOff) {
    se.disabled = true;
    se.value = ''; S.search = '';
    se.title = '该页面暂不支持搜索';
    se.placeholder = '此页面不支持搜索';
  } else {
    se.disabled = false;
    se.title = '筛选当前列表（@负责人 !P0 #风险）；回车 = 跨项目全局搜索';
    se.placeholder = '搜索，回车全局搜；@负责人 !P0 #风险 筛选（/）';
  }

  /* A6：统计/决策/档案不是任务列表，隐藏快速添加行 */
  const hideQuickRow = isProj && (S.view === 'stats' || S.view === 'decisions' || S.view === 'archive');
  const qRow = $id('quickAddRow');
  if (qRow) qRow.hidden = hideQuickRow;
  if (hideQuickRow) { const qp = $id('quickPreview'); if (qp) qp.hidden = true; hideQPop(); }

  if (S.mode === 'inbox') {
    const list = S.tasks.filter(t => t.projectId == 0 && t.status === 'todo');
    $id('countdown').innerHTML = '<span class="chip2 ' + (list.length ? 'cd' : 'good') + '">📥 待分拣 ' + list.length + ' 条</span>'
      + '<span class="chip2">每天先花 2 分钟：逐条分派到项目，或改期/删除</span>';
    $id('statsbar').innerHTML = '';
  } else if (S.mode === 'meetings') {
    const recent = S.meetings.filter(m => m.date >= addDays(TODAY, -30)).length;
    $id('countdown').innerHTML = '<span class="chip2 cd">🗂 近 30 天 ' + recent + ' 场</span>'
      + '<span class="chip2">行动项必须落成任务才有人追（Fellow 核心交互）</span>';
    $id('statsbar').innerHTML = '';
  } else if (S.mode === 'contacts') {
    const due = S.contacts.filter(c => contactDueDays(c) <= 0);
    $id('countdown').innerHTML = '<span class="chip2 ' + (due.length ? 'bad' : 'good') + '">👥 待跟进 ' + due.length + ' 人</span>'
      + '<span class="chip2">到期自动生成「跟进某人」进今日聚焦（FollowUpThen 机制）</span>';
    $id('statsbar').innerHTML = '';
  } else if (S.mode === 'dailynote') {
    $id('countdown').innerHTML = '<span class="chip2 cd">📝 ' + S.noteDate + '</span>'
      + '<span class="chip2">任务 / 青蛙 / 收尾 / 会议自动聚合，下方可写自己的笔记</span>';
    $id('statsbar').innerHTML = '';
  } else if (S.mode === 'ideas') {
    const open = S.ideas.filter(x => !x.converted);
    $id('countdown').innerHTML = '<span class="chip2 cd">💡 待评审 ' + open.length + ' 条</span>'
      + '<span class="chip2">按 价值/工时 排序，四象限辅助决策</span>';
    $id('statsbar').innerHTML = '';
  } else if (S.mode === 'smart') {
    const v = smartViewById(S.smartId);
    const archIds = S.projects.filter(pp => pp.archived).map(pp => pp.id);
    const crit = S.smartId === 'auto-stale' ? { staleDays: 14 } : (v ? v.crit : null);
    const n = crit ? S.tasks.filter(t => archIds.indexOf(t.projectId) < 0 && matchSmart(t, crit)).length : 0;
    $id('countdown').innerHTML = '<span class="chip2 cd">' + esc(v ? v.name : '🧹 待清理') + ' · ' + n + ' 条</span>'
      + (v && !v.builtin ? '<button class="linkbtn" onclick="deleteSmartView(\'' + v.id + '\')">删除此视图</button>' : '');
    $id('statsbar').innerHTML = '';
  } else if (todayMode) {
    const groups = todayGroups();
    let nOver = 0, nToday = 0, nDoing = 0;
    groups.forEach(g => { nOver += g.over.length; nToday += g.today.length; nDoing += g.doing.length; });
    $id('countdown').innerHTML =
      (nOver ? '<span class="chip2 bad">🔴 逾期 ' + nOver + '</span>' : '<span class="chip2 good">无逾期</span>')
      + '<span class="chip2 cd">📆 今天到期 ' + nToday + '</span>'
      + '<span class="chip2">🔨 进行中 ' + nDoing + '</span>'
      + '<span class="chip2">共 ' + (nOver + nToday + nDoing) + ' 项 · ' + groups.length + ' 个项目</span>';
    $id('statsbar').innerHTML = '';
  } else {
    const s = parseSettings(p);
    const cds = [];
    s.milestones.forEach(m => {
      if (m.label && m.date) {
        const diff = daysDiff(m.date);
        cds.push('<span class="chip2 cd">🏁 ' + esc(m.label) + ' ' + m.date.slice(5) + ' · ' + (diff >= 0 ? '剩 ' + diff + ' 天' : '已过 ' + (-diff) + ' 天') + '</span>');
      }
    });
    /* A3：教学提示只在「该项目完全没设置过里程碑」且用户没打开过项目设置时显示 */
    let msDismissed = false;
    try { msDismissed = localStorage.getItem('pm_ms_hint_done') === '1'; } catch (e) {}
    const hasMs = s.milestones.some(m => m.label || m.date);
    $id('countdown').innerHTML = cds.length ? cds.join('')
      : (hasMs || msDismissed ? '' : '<span class="chip2">⚙ 点项目名可设置里程碑倒计时</span>');

    const ts = projTasks(p.id);
    const overdue = ts.filter(t => t.status !== 'done' && t.status !== 'wait' && t.due && t.due < TODAY).length;
    const risks = ts.filter(t => t.risk && t.status !== 'done').length;
    const wk = addDays(TODAY, -6);
    const wkDone = ts.filter(t => t.status === 'done' && t.doneAt && t.doneAt >= wk && t.doneAt <= TODAY).length;
    let budgetChip = '';
    const s0 = parseSettings(p);
    if (s0.budgetHours > 0) {
      try {
        const logs = await invoke('get_time_logs', { since: '2000-01-01' }) || [];
        if (seq !== headerSeq) return; /* await 期间用户切走时，旧项目的工时不得写入新页头 */
        const used = logs.filter(l => l.projectId == p.id).reduce((x, l) => x + (l.minutes || 0), 0) / 60;
        const pct = Math.round(used / s0.budgetHours * 100);
        budgetChip = '<span class="chip2 ' + (pct >= 100 ? 'bad' : pct >= 80 ? 'warn' : 'good') + '" title="80%/100% 触发托盘通知与群推送">⏳ 工时 ' + used.toFixed(1) + '/' + s0.budgetHours + 'h（' + pct + '%）</span>';
      } catch (e) {}
    }
    $id('statsbar').innerHTML =
      '<span class="chip2 good">本周完成 ' + wkDone + '</span>' +
      (overdue ? '<span class="chip2 bad">逾期 ' + overdue + '</span>' : '') +
      (risks ? '<span class="chip2 warn">风险 ' + risks + '</span>' : '') +
      budgetChip +
      '<span class="chip2">共 ' + ts.length + ' 项</span>';
  }

  const owners = [];
  S.tasks.forEach(t => { if (t.owner && owners.indexOf(t.owner) < 0) owners.push(t.owner); });
  $id('ownerList').innerHTML = owners.map(o => '<option value="' + esc(o) + '">').join('');

  /* 快速添加目标项目：项目视图与今日聚焦都显示下拉（默认当前/上次浏览项目，可改） */
  if (todayMode || isProj) {
    const alive = S.projects.filter(x => !x.archived);
    if (!S.quickPid || !alive.some(x => x.id == S.quickPid)) S.quickPid = S.cur;
    if (S.mode === 'project') S.quickPid = S.cur; /* 项目视图下跟随当前项目，避免加错地方 */
    $id('qProj').innerHTML = alive.map(x =>
      '<option value="' + x.id + '"' + (x.id == S.quickPid ? ' selected' : '') + '>' + esc(x.name) + '</option>').join('');
  }
}

function renderViewInner() {
  const isToday = S.mode === 'today';
  const special = !isToday && S.mode !== 'project';
  /* 注意：S.visibleIds/kbId/sel 的跨视图重置在 renderView 包装器按上下文变化处理 */
  $id('viewToday').hidden = !isToday;
  $id('viewInbox').hidden = S.mode !== 'inbox';
  $id('viewIdeas').hidden = S.mode !== 'ideas';
  $id('viewSmart').hidden = S.mode !== 'smart';
  $id('viewMeetings').hidden = S.mode !== 'meetings';
  $id('viewContacts').hidden = S.mode !== 'contacts';
  $id('viewDailyNote').hidden = S.mode !== 'dailynote';
  $id('viewSearch').hidden = S.mode !== 'search';
  $id('viewList').hidden = isToday || special || S.view !== 'list';
  $id('viewKanban').hidden = isToday || special || S.view !== 'kanban';
  $id('viewCalendar').hidden = isToday || special || S.view !== 'calendar';
  $id('viewTimeline').hidden = isToday || special || S.view !== 'timeline';
  $id('viewStats').hidden = isToday || special || S.view !== 'stats';
  $id('viewDecisions').hidden = isToday || special || S.view !== 'decisions';
  $id('viewArchive').hidden = isToday || special || S.view !== 'archive';
  if (isToday) renderToday();
  else if (S.mode === 'inbox') renderInbox();
  else if (S.mode === 'ideas') renderIdeas();
  else if (S.mode === 'meetings') renderMeetings();
  else if (S.mode === 'contacts') renderContacts();
  else if (S.mode === 'dailynote') renderDailyNote();
  else if (S.mode === 'smart') renderSmart();
  else if (S.mode === 'search') renderSearch();
  else if (S.view === 'list') renderList();
  else if (S.view === 'kanban') renderKanban();
  else if (S.view === 'calendar') renderCalendar();
  else if (S.view === 'timeline') renderTimeline();
  else if (S.view === 'decisions') renderDecisions();
  else if (S.view === 'archive') renderArchive();
  else renderStats();
}

export function openInbox() { S.mode = 'inbox'; hideQPop(); render(); }
export function openIdeas() { S.mode = 'ideas'; render(); }
export function openMeetings() { S.mode = 'meetings'; render(); }
export function openContacts() { S.mode = 'contacts'; render(); }
export function openDailyNote() { S.mode = 'dailynote'; render(); }
export function openSmartView(id) { S.mode = 'smart'; S.smartId = id; render(); }
export function smartViewById(id) { return S.smartViews.find(v => v.id === id) || null; }
