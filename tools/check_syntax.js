/* 临时脚本：用 node --input-type=module --check 逐个做 ES Module 语法检查（不执行） */
const fs = require('fs');
const path = require('path');
const { execFileSync } = require('child_process');

const root = 'D:/ai/pm-todo/ui';
const files = [];
(function walk(dir) {
  for (const f of fs.readdirSync(dir)) {
    const fp = path.join(dir, f);
    if (fs.statSync(fp).isDirectory()) {
      if (f === 'node_modules') continue;
      walk(fp);
    } else if (f.endsWith('.js') || f.endsWith('.html')) {
      files.push(fp);
    }
  }
})(root);

let bad = 0;
for (const f of files) {
  if (!f.endsWith('.js')) continue; /* html 里的内联 script 另查 */
  const src = fs.readFileSync(f);
  try {
    execFileSync('node', ['--input-type=module', '--check'], { input: src, stdio: ['pipe', 'ignore', 'pipe'] });
    console.log('OK  ' + f.replace(root + '/', ''));
  } catch (e) {
    bad++;
    console.log('ERR ' + f);
    console.log(String(e.stderr || e.message));
  }
}
console.log(bad ? ('SYNTAX ERRORS: ' + bad) : 'ALL SYNTAX OK');
process.exit(bad ? 1 : 0);
