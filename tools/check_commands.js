#!/usr/bin/env node
/* 交叉核对：前端 invoke("...") 的命令名 与 后端 #[tauri::command] 注册的 fn 名 是否一致。
 * 用法：node tools/check_commands.js
 * - invoke 引用 tauri::模块::命令 或 命令 两种写法均可
 * - 只统计前后端出现过的名字，列出：前端调了但后端没有 / 后端有但前端没调
 */
const fs = require('fs');
const path = require('path');

const ROOT = path.resolve(__dirname, '..');

function walk(dir, ext, out) {
  for (const f of fs.readdirSync(dir)) {
    if (f === 'node_modules' || f.startsWith('.')) continue;
    const p = path.join(dir, f);
    const s = fs.statSync(p);
    if (s.isDirectory()) walk(p, ext, out);
    else if (f.endsWith(ext)) out.push(p);
  }
  return out;
}

function rustCommandNames() {
  const files = walk(path.join(ROOT, 'src-tauri', 'src'), '.rs', []);
  const cmds = new Set();
  for (const file of files) {
    const t = fs.readFileSync(file, 'utf8');
    const fns = [];
    const reFn = /fn\s+(\w+)/g;
    let m;
    while ((m = reFn.exec(t))) fns.push({ name: m[1], idx: m.index });
    const reAnnot = /#\[tauri::command[^\]]*\]/g;
    let a;
    while ((a = reAnnot.exec(t))) {
      const next = fns.filter((x) => x.idx > a.index).sort((x, y) => x.idx - y.idx)[0];
      if (next) cmds.add(next.name);
    }
  }
  return cmds;
}

function frontendInvokeNames() {
  const dir = path.join(ROOT, 'ui');
  const files = walk(dir, '.js', []);
  const names = new Set();
  for (const file of files) {
    const t = fs.readFileSync(file, 'utf8');
    const re = /invoke\(\s*(['"])([\w:]+)\1/g;
    let m;
    while ((m = re.exec(t))) names.add(m[2].split(':').pop());
  }
  return names;
}

const cmds = rustCommandNames();
const invokes = frontendInvokeNames();
const miss = [...invokes].filter((n) => !cmds.has(n));
const unused = [...cmds].filter((n) => !invokes.has(n));
console.log(`后端命令数: ${cmds.size}   前端 invoke 名数: ${invokes.size}`);
console.log('前端调用但后端无此命令:', miss.length ? miss.join(', ') : '无');
console.log('后端存在但前端从未调用:', unused.length ? unused.join(', ') : '无');
process.exit(miss.length ? 1 : 0);