/* AI 配置、AI 拆任务、AI 清单、报告润色 —— 拆分自 ui/app.js（来源行 2422-2784） */

import { getJsonMeta, invoke } from './backend.js';
import { askConfirm, closeModal, openModal } from './modal.js';
import { editChecklist, editingTaskId, renderChecklistEditor } from './modals/task-edit.js';
import { render } from './render.js';
import { openSettings } from './settings.js';
import { reportOpenSeq } from './report.js';
import { S, TODAY, curProject, projNameOf } from './state.js';
import { persistTask } from './tasks.js';
import { $id, esc, toast, toastErr } from './utils.js';

export const AI_PRESETS = [
  { id: 'zhipu',       name: '智谱 GLM（有免费档）',       baseUrl: 'https://open.bigmodel.cn/api/paas/v4',              model: 'glm-4.6' },
  { id: 'deepseek',    name: 'DeepSeek',                  baseUrl: 'https://api.deepseek.com/v1',                       model: 'deepseek-chat' },
  { id: 'moonshot',    name: '月之暗面 Kimi',              baseUrl: 'https://api.moonshot.cn/v1',                        model: 'kimi-k2-0905-preview' },
  { id: 'dashscope',   name: '阿里云百炼（通义千问）',      baseUrl: 'https://dashscope.aliyuncs.com/compatible-mode/v1', model: 'qwen-plus' },
  { id: 'siliconflow', name: '硅基流动 SiliconFlow',       baseUrl: 'https://api.siliconflow.cn/v1',                     model: 'Qwen/Qwen2.5-7B-Instruct' },
  { id: 'openai',      name: 'OpenAI',                    baseUrl: 'https://api.openai.com/v1',                         model: 'gpt-4o-mini' },
  { id: 'openrouter',  name: 'OpenRouter（多模型聚合）',    baseUrl: 'https://openrouter.ai/api/v1',                      model: '' },
  { id: 'ollama',      name: '本机 Ollama（无需 Key）',    baseUrl: 'http://localhost:11434/v1',                         model: 'qwen2.5:3b' },
  { id: 'custom',      name: '自定义（任何 OpenAI 兼容服务）', baseUrl: '', model: '' }
];
export const AI_POLISH_SYSTEM = '你是资深项目经理。把用户给出的项目日报/周报草稿润色成适合直接发到工作群的版本：保持事实、数字与事项完全不变，不得虚构或遗漏；结构清晰、语气专业简练；保留原有分段标题与条目顺序。直接输出润色后的全文，不要任何解释、前后缀或代码块标记。';

/* ---- 供应商档案管理：可保存多家（各存各的 Key），点卡片一键切换启用 ---- */
export async function loadAiProfiles() {
  const list = await getJsonMeta('aiProviders', null);
  if (Array.isArray(list)) {
    const ok = list.filter(p => p && typeof p === 'object' && p.baseUrl);
    if (ok.length) {
      return ok.map((p, i) => ({
        id: String(p.id || (p.preset || 'custom') + '-' + i),
        preset: p.preset || 'custom',
        name: p.name || '供应商' + (i + 1),
        baseUrl: String(p.baseUrl || ''),
        apiKey: String(p.apiKey || ''),
        model: String(p.model || '')
      }));
    }
  }
  /* 迁移：单供应商版 meta aiProvider → 档案列表 */
  const single = await getJsonMeta('aiProvider', null);
  if (single && typeof single === 'object' && single.baseUrl) {
    return [{
      id: String(single.preset || 'custom'), preset: single.preset || 'custom',
      name: single.name || '自定义', baseUrl: String(single.baseUrl),
      apiKey: String(single.apiKey || ''), model: String(single.model || '')
    }];
  }
  /* 迁移：初版 meta aiModel（Ollama 模型名）→ 本机 Ollama 档案 */
  const legacy = (await invoke('get_meta', { key: 'aiModel' }).catch(() => null)) || '';
  const p0 = AI_PRESETS.find(x => x.id === 'ollama');
  return [{ id: 'ollama', preset: p0.id, name: p0.name, baseUrl: p0.baseUrl, apiKey: '', model: String(legacy).trim() || p0.model }];
}
/* AI 功能入口读取当前启用的供应商（无需打开设置） */
export async function loadAiCfg() {
  const profiles = await loadAiProfiles();
  const activeId = await getJsonMeta('aiActiveId', null);
  const p = profiles.find(x => x.id === activeId) || profiles[0];
  return { id: p.id, preset: p.preset, name: p.name, baseUrl: p.baseUrl, apiKey: p.apiKey, model: p.model };
}
export let aiProfiles = [], aiActiveId = '', aiSelId = '';
/* settings.js 等外部模块经 setter 更新 AI 状态（ES 导入绑定只读） */
export function aiSetSelection(profiles, activeId) { aiProfiles = profiles; aiActiveId = activeId; aiSelId = activeId; }
export function aiResetProfiles() { aiProfiles = []; }
export function aiFieldsToProfile() {
  const pid = $id('st-ai-preset').value;
  const preset = AI_PRESETS.find(x => x.id === pid) || AI_PRESETS[AI_PRESETS.length - 1];
  return {
    preset: preset.id,
    baseUrl: $id('st-ai-baseurl').value.trim(),
    apiKey: $id('st-ai-key').value.trim(),
    model: $id('st-ai-model').value.trim()
  };
}
/* 切换选中前把表单里未保存的改动暂存回内存档案，避免来回点丢修改。
 * preset 不回写：onchange 触发时下拉已是新值，而预设只是填写模板，另存时才固化进档案。 */
export function aiStashFields() {
  const p = aiProfiles.find(x => x.id === aiSelId);
  if (p) Object.assign(p, aiFieldsToProfile(), { preset: p.preset });
}
export function aiRenderProfiles() {
  $id('st-ai-profiles').innerHTML = aiProfiles.map(p =>
    '<div class="ai-prof' + (p.id === aiSelId ? ' sel' : '') + '" onclick="aiPickProfile(\'' + esc(p.id).replace(/[\\'\r\n]/g, '') + '\')">'
    + '<span class="ai-dot' + (p.id === aiActiveId ? ' on' : '') + '"></span>'
    + '<span class="ai-pn">' + esc(p.name) + (p.id === aiActiveId ? '<i class="ai-cur">当前</i>' : '') + '</span>'
    + '<span class="ai-pm">' + esc(p.model || '未设模型') + '</span></div>'
  ).join('');
}
export function aiPickProfile(id) {
  if (id === aiSelId) return;
  aiStashFields();
  const p = aiProfiles.find(x => x.id === id);
  if (!p) return; /* 非法/被转义截断的 id：忽略，避免崩溃与误导性切换 */
  aiSelId = id; aiActiveId = id;
  aiRenderProfiles();
  aiFillSettings(p);
  aiStatus('已切换到「' + p.name + '」，点底部「保存」生效');
}
export function aiFillSettings(p) {
  p = p || {};
  $id('st-ai-preset').value = AI_PRESETS.some(x => x.id === p.preset) ? p.preset : 'custom';
  $id('st-ai-baseurl').value = p.baseUrl || '';
  $id('st-ai-key').value = p.apiKey || '';
  $id('st-ai-model').value = p.model || '';
  $id('st-ai-key').placeholder = $id('st-ai-preset').value === 'ollama' ? '本机 Ollama 无需 Key' : 'sk-…';
}
export function aiPresetChanged() {
  const p = AI_PRESETS.find(x => x.id === $id('st-ai-preset').value);
  if (!p) return;
  /* 换预设 = 开始填一份新草稿：先把当前档案已填的内容暂存回去，避免被预设默认值覆盖 */
  aiStashFields();
  if (p.baseUrl) $id('st-ai-baseurl').value = p.baseUrl;
  if (p.model) $id('st-ai-model').value = p.model;
  $id('st-ai-key').placeholder = p.id === 'ollama' ? '本机 Ollama 无需 Key' : 'sk-…';
  aiRenderChips([]);
  aiStatus('');
}
export function aiStatus(msg, isErr) {
  const el = $id('st-ai-status');
  el.textContent = msg;
  el.hidden = !msg;
  el.classList.toggle('ai-status-err', !!isErr);
}
/* 拉取到的模型以可点选 chip 呈现（比 datalist 少一次空输入+双击） */
export function aiRenderChips(list) {
  const box = $id('st-ai-chips');
  list = (list || []).slice(0, 20);
  if (!list.length) { box.hidden = true; box.innerHTML = ''; return; }
  box.innerHTML = list.map(m => '<button type="button" class="ai-chip" data-m="' + esc(m) + '" onclick="aiPickModel(this)">' + esc(m) + '</button>').join('');
  box.hidden = false;
}
export function aiPickModel(btn) {
  const m = btn.getAttribute('data-m');
  $id('st-ai-model').value = m;
  aiStatus('已选择模型 ' + m);
}
export async function aiFetchModels() {
  const cfg = aiFieldsToProfile();
  if (!cfg.baseUrl) { aiStatus('请先填写 API 地址（Base URL）', true); return; }
  const btn = $id('st-ai-models');
  btn.disabled = true; aiStatus('正在拉取模型列表…');
  try {
    const list = await invoke('ai_list_models', { cfg: JSON.stringify(cfg) });
    $id('aiModelList').innerHTML = (list || []).map(m => '<option value="' + esc(m) + '">').join('');
    if (list && list.length) {
      aiRenderChips(list);
      aiStatus('拉取到 ' + list.length + ' 个模型：点击下方模型名即可填入' + (list.length > 20 ? '（仅显示前 20 个）' : ''));
    } else {
      aiRenderChips([]);
      aiStatus('该服务未返回模型列表，直接手动填写模型 ID 即可');
    }
  } catch (e) {
    aiStatus('拉取失败：' + (e && e.message || e) + '（不影响使用，可直接手动填模型 ID）', true);
  } finally { btn.disabled = false; }
}
export async function aiTestConn() {
  const cfg = aiFieldsToProfile();
  if (!cfg.baseUrl || !cfg.model) { aiStatus('Base URL 和模型 ID 都填好才能测试', true); return; }
  const btn = $id('st-ai-test');
  btn.disabled = true; aiStatus('正在发送测试消息（首次调用可能较慢）…');
  try {
    const out = await invoke('ai_chat', { cfg: JSON.stringify(cfg), system: '你是连通性测试助手，只回复两个字：正常', user: 'ping' });
    aiStatus('✅ 连接成功，模型回复：' + String(out).slice(0, 60));
  } catch (e) {
    aiStatus('❌ ' + (e && e.message || e), true);
  } finally { btn.disabled = false; }
}
export async function aiAddProfile() {
  if (aiAdding) return;
  aiAdding = true;
  try {
    /* 注意：不回写当前选中档案——表单里是要另存的新供应商草稿 */
    const f = aiFieldsToProfile();
    if (!f.baseUrl || !f.model) { aiStatus('Base URL 和模型 ID 填好后再添加为新供应商', true); return; }
    const preset = AI_PRESETS.find(x => x.id === f.preset) || AI_PRESETS[AI_PRESETS.length - 1];
    let name = preset.name;
    if (aiProfiles.some(p => p.name === name)) name = preset.name + '（' + (aiProfiles.filter(p => p.preset === f.preset).length + 1) + '）';
    const prof = { id: 'p' + Date.now().toString(36) + '-' + (++aiProfSeq), preset: f.preset, name: name, baseUrl: f.baseUrl, apiKey: f.apiKey, model: f.model };
    aiProfiles.push(prof);
    aiSelId = prof.id; aiActiveId = prof.id;
    aiRenderProfiles();
    aiStatus('已添加「' + name + '」并设为当前，点底部「保存」生效');
  } finally { aiAdding = false; }
}
/* 删除用按钮二连击确认：设置弹窗层级高于确认弹窗，不能用 askConfirm */
export let aiDelArm = false, aiDelTimer = null;
let aiAdding = false; /* 另存供应商防重：双击只创建一条档案 */
let aiProfSeq = 0; /* 档案 id 后缀序号：同毫秒连续另存时保证 id 唯一，避免删除时一次删掉两条 */
export function aiDelProfile() {
  const btn = $id('st-ai-del');
  if (aiProfiles.length <= 1) { aiStatus('至少保留一个供应商，无法删除', true); return; }
  if (!aiDelArm) {
    aiDelArm = true;
    btn.textContent = '确认删除？';
    btn.classList.add('armed');
    aiDelTimer = setTimeout(() => { aiDelArm = false; btn.textContent = '🗑'; btn.classList.remove('armed'); }, 3000);
    return;
  }
  clearTimeout(aiDelTimer); aiDelArm = false;
  btn.textContent = '🗑'; btn.classList.remove('armed');
  const p = aiProfiles.find(x => x.id === aiSelId);
  aiProfiles = aiProfiles.filter(x => x.id !== aiSelId);
  if (aiActiveId === p.id) aiActiveId = aiProfiles[0].id;
  aiSelId = aiActiveId;
  aiRenderProfiles();
  aiFillSettings(aiProfiles.find(x => x.id === aiSelId));
  aiStatus('已删除「' + p.name + '」，点底部「保存」生效');
}
/* AI 入口共用守卫：未配置供应商时引导打开设置，返回 null 表示中断 */
export async function ensureAiCfg() {
  let cfg = null;
  try { cfg = await loadAiCfg(); } catch (e) { toastErr('读取 AI 配置', e); return null; }
  if (!cfg.baseUrl || !cfg.model) {
    toast('想用 AI：先在设置（⚙）里选择模型供应商并保存', 'err');
    openSettings();
    return null;
  }
  return cfg;
}
/* AI 常把数组包在 ```json 围栏或解释文字里，取第一个 [ 到最后一个 ] 再解析 */
export function extractJsonArray(text) {
  const t = String(text || '');
  const s = t.indexOf('['), e = t.lastIndexOf(']');
  if (s < 0 || e <= s) throw new Error('AI 没有返回任务列表 JSON');
  let arr;
  try { arr = JSON.parse(t.slice(s, e + 1)); } catch (err) { throw new Error('AI 返回格式无法解析，请重试一次'); }
  if (!Array.isArray(arr)) throw new Error('AI 没有返回任务列表');
  return arr;
}
/* 润色报告：走设置里配置的供应商；结果可一键撤销（AI 措辞未必比原文好） */
export async function aiPolishReport() {
  const btn = $id('r-ai');
  const orig = btn.textContent;
  btn.textContent = '⏳ 润色中…'; btn.disabled = true; /* 在首个 await 前禁用：快速双击不会并发两次 AI 请求 */
  try {
    const cfg = await ensureAiCfg(); if (!cfg) return;
    const seq = reportOpenSeq;
    const before = $id('r-area').value;
    const out = await invoke('ai_chat', { cfg: JSON.stringify(cfg), system: AI_POLISH_SYSTEM, user: before });
    if (out === before) { toast('AI 看过了：已足够好，未做改动', 'info'); return; }
    if (seq !== reportOpenSeq) { toast('报告已重新生成，放弃旧润色结果', 'info'); return; } /* 润色期间另开了新报告：不得覆盖新预览 */
    $id('r-area').value = out;
    toast('✨ AI 润色完成（' + (cfg.name || cfg.preset) + ' · ' + cfg.model + '）', 'ok',
      { label: '撤销', onClick: () => { if (reportOpenSeq === seq) $id('r-area').value = before; } });
  } catch (e) {
    toastErr('AI 润色失败', e);
  } finally {
    btn.textContent = orig; btn.disabled = false;
  }
}

/* ============ AI 粘贴转任务（#16 增强） ============
 * PM 最耗时的整理工作：把会议记录 / 群聊 / 邮件里的待办搬进系统。
 * AI 只产出「草稿」，先预览可改，勾选确认后才写数据。 */
export const AI_PARSE_SYSTEM = '你是项目管理助手，从用户给的原始文字（会议记录/群聊/邮件/笔记）中提取所有需要跟进的任务。'
  + '今天是 {today}。只输出严格的 JSON 数组，不要解释、不要代码块，每项形如：'
  + '{"title":"一句话可执行的任务标题","due":"YYYY-MM-DD 或空","owner":"人名或空","pri":"P0|P1|P2，不明确给P1","risk":true或false,"note":"一句话补充背景或卡点，可空"}。'
  + '规则：明天/下周五/月底等相对时间按 {today} 换算成具体日期，无法判断就留空；owner 只取原文明确提到的人名；原文提到卡住/延期/风险/依赖则 risk=true；同一件事只出一条；没有任务就输出 []。';
export let atParsed = [];
let atImporting = false; /* 批量入库重入防护：循环 persistTask 期间忽略重复点击 */
let atOpenSeq = 0; /* AI 转任务弹窗打开序号：解析结果只写回本次会话，弹窗重置后旧结果作废 */
export function atRowHtml(it, i) {
  return '<div class="at-row">'
    + '<input type="checkbox" class="at-ck" checked data-i="' + i + '" title="勾选后才会添加">'
    + '<input type="text" class="at-title" value="' + esc(it.title) + '">'
    + '<input type="date" class="at-due" value="' + esc(it.due || '') + '" title="截止日期">'
    + '<input type="text" class="at-owner" value="' + esc(it.owner || '') + '" placeholder="负责人">'
    + '<select class="at-pri">' + ['P0', 'P1', 'P2'].map(p => '<option' + (p === (it.pri || 'P1') ? ' selected' : '') + '>' + p + '</option>').join('') + '</select>'
    + '<label class="at-risk" title="计入日报风险栏"><input type="checkbox" class="at-riskck"' + (it.risk ? ' checked' : '') + '>⚠</label>'
    + '</div>';
}
export async function openAiTask() {
  atParsed = [];
  atOpenSeq++; /* 使上一轮未完成的解析结果作废 */
  $id('at-input').value = '';
  const res = $id('at-results');
  res.hidden = true; res.innerHTML = '';
  $id('at-import').hidden = true;
  $id('at-status').textContent = '';
  const opts = [{ v: 0, n: '📥 收件箱（稍后分拣）' }].concat(
    S.projects.filter(p => !p.archived).map(p => ({ v: p.id, n: p.name }))
  );
  $id('at-proj').innerHTML = opts.map(o => '<option value="' + o.v + '">' + esc(o.n) + '</option>').join('');
  /* 默认目标：收件箱模式 → 收件箱；否则当前项目 */
  const cur = curProject();
  const defPid = S.qInbox ? 0 : (cur ? cur.id : 0);
  $id('at-proj').value = opts.some(o => String(o.v) === String(defPid)) ? String(defPid) : '0';
  openModal('mw-aitask');
  setTimeout(() => $id('at-input').focus(), 20);
}
export async function aiParseTasks() {
  const btn = $id('at-parse');
  btn.disabled = true; btn.textContent = '⏳ 解析中…'; /* 在首个 await 前禁用：快速双击不会并发两次 AI 请求 */
  const seq = atOpenSeq; /* 会话序号在首个 await 前捕获：期间弹窗被重开时旧解析结果必须作废 */
  $id('at-status').textContent = 'AI 正在拆解任务（一般 3-10 秒）…';
  try {
    const text = $id('at-input').value.trim();
    if (!text) { $id('at-status').textContent = '先粘贴原始文字（会议记录 / 群聊 / 邮件都行）'; return; }
    const cfg = await ensureAiCfg(); if (!cfg) return;
    const out = await invoke('ai_chat', {
      cfg: JSON.stringify(cfg),
      system: AI_PARSE_SYSTEM.split('{today}').join(TODAY),
      user: text
    });
    if (seq !== atOpenSeq) { btn.disabled = false; btn.textContent = '🔍 AI 解析'; toast('弹窗已重置，放弃本次解析结果', 'info'); return; } /* 解析期间弹窗被重开 */
    atParsed = extractJsonArray(out)
      .map(x => x && typeof x === 'object' ? x : { title: x })
      .map(x => ({
        title: String(x.title || '').trim(),
        due: /^\d{4}-\d{2}-\d{2}$/.test(String(x.due || '')) ? String(x.due) : '',
        owner: String(x.owner || '').trim().slice(0, 20),
        pri: ['P0', 'P1', 'P2'].indexOf(x.pri) >= 0 ? x.pri : 'P1',
        risk: !!x.risk,
        note: String(x.note || '').trim().slice(0, 500)
      }))
      .filter(x => x.title);
    if (!atParsed.length) {
      $id('at-status').textContent = 'AI 没从这段文字里识别出任务：若原文确实没有待办就算了，否则换个说法重试';
      return;
    }
    $id('at-results').innerHTML = atParsed.map(atRowHtml).join('');
    $id('at-results').hidden = false;
    $id('at-import').hidden = false;
    $id('at-import').disabled = false; /* 重新解析后解除上次部分失败锁定的禁用态 */
    $id('at-import').textContent = '✅ 添加所选（' + atParsed.length + '）';
    $id('at-status').textContent = '解析出 ' + atParsed.length + ' 条草稿，可直接修改后勾选添加';
  } catch (e) {
    $id('at-status').textContent = '解析失败：' + (e && e.message || e);
  } finally {
    btn.disabled = false; btn.textContent = '🔍 AI 解析';
  }
}
export async function aiImportParsed() {
  if (atImporting) return;
  const rows = Array.from($id('at-results').querySelectorAll('.at-row'));
  const pid = +$id('at-proj').value || 0;
  const picked = [];
  rows.forEach((row, i) => {
    if (!row.querySelector('.at-ck').checked) return;
    const src = atParsed[i] || {};
    picked.push({
      id: 0, projectId: pid,
      title: row.querySelector('.at-title').value.trim(),
      due: row.querySelector('.at-due').value || TODAY,
      owner: row.querySelector('.at-owner').value.trim() || '我方',
      pri: row.querySelector('.at-pri').value,
      status: 'todo', doneAt: '',
      risk: row.querySelector('.at-riskck').checked,
      repeat: '', note: src.note || '',
      createdAt: TODAY, sortOrder: 0, checklistJson: '[]'
    });
  });
  if (!picked.length) { $id('at-status').textContent = '至少勾选一条要添加的任务'; return; }
  atImporting = true;
  const btn = $id('at-import');
  if (btn) { btn.disabled = true; btn.textContent = '⏳ 添加中…'; }
  let added = 0, failed = false;
  try {
    for (const t of picked) { await persistTask(t); added++; }
    closeModal('mw-aitask');
    const where = pid === 0 ? '📥 收件箱' : '「' + projNameOf(pid) + '」';
    toast('🤖 AI 已添加 ' + picked.length + ' 条任务到' + where + (pid === 0 ? '，记得去收件箱分拣' : ''));
    render();
  } catch (e) {
    /* 循环中途失败：已入库的不能重试（会重复插入），要求重新解析后再添加 */
    failed = true;
    toastErr('添加失败（已成功 ' + added + '/' + picked.length + ' 条）', e);
    $id('at-status').textContent = '⚠ 部分失败：请重新粘贴并解析后再添加，避免重复入库';
  }
  finally {
    atImporting = false;
    if (btn) {
      if (failed) { btn.disabled = true; btn.textContent = '⚠ 需重新解析后再添加'; }
      else { btn.disabled = false; btn.textContent = '✅ 添加所选（' + picked.length + '）'; }
    }
  }
}

/* AI 生成检查清单：任务拆解草稿（进编辑器，可改可删后才随任务保存） */
export async function aiGenChecklist() {
  /* 目标任务上下文在首个 await 前全部捕获：ensureAiCfg 期间用户切任务/关弹窗时，
   * 结果不得写进新任务的清单草稿 */
  const title = $id('m-title').value.trim();
  const me = editingTaskId;
  const note = $id('m-note').value.trim();
  if (!title) { toast('先填写任务标题，AI 才能生成清单', 'err'); return; }
  const btn = $id('m-cl-ai');
  btn.disabled = true; btn.textContent = '⏳…'; /* 在首个 await 前禁用：快速双击不会并发两次 AI 请求 */
  try {
    const cfg = await ensureAiCfg(); if (!cfg) return;
    const out = await invoke('ai_chat', {
      cfg: JSON.stringify(cfg),
      system: '你是资深项目经理。为任务生成检查清单：3-6 条，每条一句话、可验证、按执行顺序，覆盖关键风险点与验收标准。只输出 JSON 数组如 ["条目1","条目2"]，不要解释、不要代码块。',
      user: '任务标题：' + title + (note ? '\n任务备注：' + note : '')
    });
    if (editingTaskId !== me || $id('mw-task').hidden) { toast('任务已切换或弹窗已关闭，放弃清单结果', 'info'); return; }
    const items = extractJsonArray(out)
      .map(x => String(x && typeof x === 'object' ? (x.text || x.title || '') : x).trim())
      .filter(Boolean)
      .slice(0, 8);
    if (!items.length) { toast('AI 没有生成清单项，请重试', 'err'); return; }
    let added = 0;
    items.forEach(s => {
      if (!editChecklist.some(c => c.text === s)) { editChecklist.push({ text: s, done: false }); added++; }
    });
    renderChecklistEditor();
    toast(added ? '🤖 已生成 ' + added + ' 条清单草稿，可修改或删除后再保存' : '清单里已有这些条目，未重复添加', added ? 'ok' : 'info');
  } catch (e) { toastErr('AI 生成清单', e); }
  finally { btn.disabled = false; btn.textContent = '🤖'; }
}

/* ============ 备份 / 导入 / CSV ============ */
