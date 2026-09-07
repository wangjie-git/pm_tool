const fs = require('fs');
const path = require('path');

const files = [];
function walk(dir) {
  for (const f of fs.readdirSync(dir)) {
    const fp = path.join(dir, f);
    if (fs.statSync(fp).isDirectory()) walk(fp);
    else if (f.endsWith('.js') || f.endsWith('.html')) files.push(fp);
  }
}
walk('ui');

console.log('--- Scanning for string arguments in inline handlers ---');
const suspicious = [];
for (const f of files) {
  const content = fs.readFileSync(f, 'utf8');
  const lines = content.split('\n');
  lines.forEach((line, idx) => {
    // Match onclick="func(...)" or onclick='...'
    const matches = line.matchAll(/on[a-z]+\s*=\s*(?:'([^']*)'|"([^"]*)")/gi);
    for (const m of matches) {
      const handler = m[1] || m[2];
      // Check if variable interpolation is inside string literal quotes e.g. '${...}' or ' + ... + '
      if (handler && (handler.includes("'${") || handler.includes("'\${") || /'\s*\+\s*[a-zA-Z0-9_.]+\s*\+\s*'/.test(handler))) {
        suspicious.push({ file: f, line: idx + 1, code: line.trim() });
      }
    }
  });
}

console.log(`Found ${suspicious.length} potentially unsafe string interpolation in inline handlers:`);
suspicious.forEach(s => console.log(`${s.file}:${s.line} => ${s.code}`));
