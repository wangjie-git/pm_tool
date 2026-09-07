const fs = require('fs');
const path = require('path');

const compat = fs.readFileSync('ui/js/compat.js', 'utf8');
const files = [];

function walk(dir) {
  for (const f of fs.readdirSync(dir)) {
    const fp = path.join(dir, f);
    if (fs.statSync(fp).isDirectory()) walk(fp);
    else if (f.endsWith('.js') || f.endsWith('.html')) files.push(fp);
  }
}
walk('ui');

const called = new Set();
for (const f of files) {
  if (f.includes('compat.js')) continue;
  const content = fs.readFileSync(f, 'utf8');
  const re = /on(?:click|change|keydown|keyup|input)=\\?"([A-Za-z_$][\w$]*)\(/g;
  let m;
  while ((m = re.exec(content))) {
    called.add(m[1]);
  }
}

const missing = [];
for (const fn of called) {
  if (['if', 'event', 'closeModal', 'openModal', 'stopPropagation'].includes(fn)) continue;
  if (!compat.includes(fn)) missing.push(fn);
}

console.log('Total event handler functions called:', called.size);
console.log('Handler names:', Array.from(called).sort().join(', '));
console.log('Missing from compat.js:', missing.length ? missing.join(', ') : 'NONE');
