/* 静态检查：ui/js/ 里 $id() 引用的 id 必须存在于 index.html；onclick= 引用的全局函数必须已定义（含 compat.js 桥接） */
const fs = require('fs');
const path = require('path');

const jsDir = 'D:/ai/pm-todo/ui/js';
const files = [];
(function walk(dir) {
  for (const f of fs.readdirSync(dir)) {
    const fp = path.join(dir, f);
    if (fs.statSync(fp).isDirectory()) walk(fp);
    else if (f.endsWith('.js')) files.push(fp);
  }
})(jsDir);
const js = files.map(f => fs.readFileSync(f, 'utf8')).join('\n');
const html = fs.readFileSync('D:/ai/pm-todo/ui/index.html', 'utf8');

const ids = new Set();
let m;
const re = /\$id\('([^']+)'\)/g;
while ((m = re.exec(js))) ids.add(m[1]);
const missing = [];
ids.forEach(id => { if (!html.includes('id="' + id + '"')) missing.push(id); });
console.log('引用 id 总数:', ids.size);
console.log('HTML 缺失 id:', missing.length ? missing.join(', ') : '无');

/* onclick="fn(...)" 引用的函数 */
const called = new Set();
const re2 = /onclick="([A-Za-z_$][\w$]*)\(/g;
while ((m = re2.exec(html))) called.add(m[1]);
const re3 = /onclick=\\?"([A-Za-z_$][\w$]*)\(/g;
while ((m = re3.exec(js))) called.add(m[1]);
const noFn = [];
called.forEach(fn => {
  if (!new RegExp('function\\s+' + fn + '\\b').test(js) && !new RegExp('\\b' + fn + '\\s*=\\s*(async\\s*)?function|\\b' + fn + '\\s*=\\s*\\(').test(js)) noFn.push(fn);
});
console.log('onclick 引用函数:', called.size);
console.log('缺失函数:', noFn.length ? noFn.join(', ') : '无');
