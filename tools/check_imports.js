/* 一次性交叉验证：所有 ES module 的命名导入必须存在于目标模块的导出中 */
const fs = require('fs'), path = require('path');
const root = path.join(__dirname, '..', 'ui', 'js');
const files = [];
(function walk(d) {
  for (const f of fs.readdirSync(d)) {
    const p = path.join(d, f);
    if (fs.statSync(p).isDirectory()) walk(p);
    else if (f.endsWith('.js')) files.push(p);
  }
})(root);
const src = {};
for (const f of files) src[path.relative(root, f).replace(/\\/g, '/')] = fs.readFileSync(f, 'utf8');
const exp = {};
for (const [f, s] of Object.entries(src)) {
  const set = new Set();
  let m;
  const re1 = /export\s+(async\s+)?(function\*?|class|let|const|var)\s+([A-Za-z_$][\w$]*)/g;
  while ((m = re1.exec(s))) {
    set.add(m[3]);
    /* let/const/var 支持逗号多声明：export let a = 1, b = 2 */
    if (/^(let|const|var)$/.test(m[2])) {
      let i = re1.lastIndex, depth = 0;
      while (i < s.length) {
        const c = s[i];
        if (c === ';' || c === '\n') break;
        if (c === '(' || c === '{' || c === '[') depth++;
        else if (c === ')' || c === '}' || c === ']') { if (depth === 0) break; depth--; }
        else if (c === ',' && depth === 0) {
          const next = s.slice(i + 1).match(/^\s*([A-Za-z_$][\w$]*)/);
          if (next) set.add(next[1]);
        }
        i++;
      }
    }
  }
  const re2 = /export\s*\{([^}]*)\}/g;
  while ((m = re2.exec(s))) {
    m[1].split(',').forEach(x => {
      const n = x.trim().split(/\s+as\s+/).pop().trim();
      if (n) set.add(n);
    });
  }
  exp[f] = set;
}
let bad = 0;
for (const [f, s] of Object.entries(src)) {
  const re = /import\s*\{([^}]*)\}\s*from\s*['"]([^'"]+)['"]/g;
  let m;
  while ((m = re.exec(s))) {
    const target = path.posix.join(path.posix.dirname(f), m[2]);
    if (!exp[target]) { console.log('MISSING FILE', f, '->', target); bad++; continue; }
    for (const raw of m[1].split(',')) {
      const n = raw.trim().split(/\s+as\s+/)[0].trim();
      if (n && !exp[target].has(n)) { console.log('BAD IMPORT', f, 'imports', n, 'from', target); bad++; }
    }
  }
}
console.log(bad ? bad + ' problems' : 'ALL IMPORTS OK');
process.exit(bad ? 1 : 0);
