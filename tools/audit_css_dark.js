const fs = require('fs');
const css = fs.readFileSync('ui/styles.css', 'utf8');

// Find selectors that set background without using var(--...)
const lines = css.split('\n');
const suspicious = [];
lines.forEach((line, idx) => {
  // Check if color or background uses hardcoded hex outside of :root and [data-theme=dark] and sidebar
  if (idx < 50) return; // skip theme vars
  if (line.includes('--side-')) return;
  // If background is set to a fixed light color like #fff or #ffffff or white
  if (/background:\s*(?:#fff|#ffffff|white)\b/i.test(line)) {
    suspicious.push({ line: idx + 1, text: line.trim() });
  }
  // If color is set to fixed dark color like #000 or #333 or black
  if (/color:\s*(?:#000|#111|#222|#333|black)\b/i.test(line)) {
    suspicious.push({ line: idx + 1, text: line.trim() });
  }
});

console.log('Suspicious hardcoded colors in CSS:');
suspicious.forEach(s => console.log(`Line ${s.line}: ${s.text}`));
