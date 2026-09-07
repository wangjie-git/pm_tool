/* 前端模块图冒烟测试（无浏览器）：用最小 DOM 桩加载 ui/js/app.js，
 * 验证：模块图求值无异常、main.js init() 全流程（mock 后端 load_app → render → 导览）跑通。
 * 用法：node tools/smoke-ui.js */
'use strict';

/* ---- 最小 DOM 桩 ---- */
const elCache = {};
function makeEl(id) {
  const lsn = {};
  const el = {
    id: id || 'dyn',
    hidden: false, disabled: false, checked: false, value: '', textContent: '', innerHTML: '',
    className: '', title: '', placeholder: '', type: '', style: {}, dataset: {},
    classList: { add() {}, remove() {}, toggle() {}, contains() { return false; } },
    addEventListener(t, fn) { lsn[t] = fn; },
    removeEventListener() {},
    set onclick(fn) { this._onclick = fn; }, get onclick() { return this._onclick || null; },
    appendChild() {}, remove() {}, focus() {}, select() {}, scrollIntoView() {},
    querySelector() { return null; }, querySelectorAll() { return []; },
    closest() { return null; }, contains() { return false; },
    getBoundingClientRect() { return { left: 0, top: 0, right: 200, bottom: 40, width: 200, height: 40 }; },
    setAttribute() {}, getAttribute() { return null; }, cloneNode() { return makeEl(id); },
    getContext() { return { fillRect() {}, drawImage() {}, fillStyle: '' }; },
    toDataURL() { return 'data:image/png;base64,xx'; },
    scrollTop: 0, offsetWidth: 200, offsetHeight: 40,
  };
  return el;
}
const docListeners = {};
global.window = {
  innerWidth: 1280, innerHeight: 800,
  addEventListener(t, fn) { docListeners[t] = fn; },
  removeEventListener() {},
  __TAURI__: undefined, /* 强制走 localStorage mock 后端 */
};
global.document = {
  getElementById(id) { return (elCache[id] = elCache[id] || makeEl(id)); },
  querySelector() { return null; },
  querySelectorAll() { return []; },
  createElement() { return makeEl('dyn'); },
  createElementNS() { return makeEl('dyn'); },
  addEventListener(t, fn) { docListeners[t] = fn; },
  removeEventListener() {},
  body: { appendChild() {}, insertAdjacentHTML() {}, classList: { add() {}, remove() {} } },
  documentElement: { dataset: {} },
};
global.localStorage = {
  _d: {},
  getItem(k) { return Object.prototype.hasOwnProperty.call(this._d, k) ? this._d[k] : null; },
  setItem(k, v) { this._d[k] = String(v); },
  removeItem(k) { delete this._d[k]; },
};
Object.defineProperty(globalThis, 'navigator', { value: { clipboard: { writeText() { return Promise.resolve(); }, readText() { return Promise.resolve(''); } } }, configurable: true });
global.XMLSerializer = class { serializeToString() { return '<svg/>'; } };
global.Image = class { set src(v) { this._loaded = true; if (this.onload) setTimeout(() => this.onload(), 0); } };
global.FileReader = class { readAsDataURL() { if (this.onload) setTimeout(() => this.onload({ target: { result: 'data:image/png;base64,xx' } }), 0); } };
global.setInterval = () => 0;
global.clearInterval = () => {};
global.requestAnimationFrame = () => 0;
global.execCommand = () => true;

/* ---- 加载模块图并等 init() 完成 ---- */
(async () => {
  try {
    await import('../ui/js/app.js');
    /* init 是异步的：轮询 S 是否被填充（示例项目已建）来判断 init 走到 render */
    const stateMod = await import('../ui/js/state.js');
    const deadline = Date.now() + 3000;
    while (Date.now() < deadline) {
      await new Promise(r => setTimeout(r, 50));
      if (stateMod.S.projects && stateMod.S.projects.length) break;
    }
    if (!stateMod.S.projects || !stateMod.S.projects.length) {
      console.error('SMOKE FAIL: init() 未完成（S.projects 为空）');
      process.exit(1);
    }
    const renders = elCache;
    const emptyText = Object.values(renders).filter(e => e.id && e.innerHTML === '' && !e.hidden).length;
    console.log('SMOKE OK: 模块图加载成功，init() 完成');
    console.log('  S.projects:', stateMod.S.projects.length, '| S.tasks:', stateMod.S.tasks.length);
    console.log('  已渲染容器:', Object.keys(renders).length, '个');
    console.log('  viewList 内容长度:', (elCache['viewList'] && elCache['viewList'].innerHTML || '').length);
    process.exit(0);
  } catch (e) {
    console.error('SMOKE FAIL:', e && e.stack || e);
    process.exit(1);
  }
})();
