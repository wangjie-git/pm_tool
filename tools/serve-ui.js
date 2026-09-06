/* 本地预览服务器：node tools/serve-ui.js [端口]
 * 拆分成 ES modules 后 file:// 直开会因 CORS 被浏览器拦截，
 * 浏览器预览（mock 后端模式）请用本服务或任意静态服务器。 */
const http = require('http');
const fs = require('fs');
const path = require('path');

const ROOT = path.join(__dirname, '..', 'ui');
const PORT = Number(process.argv[2]) || 8123;
const MIME = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8', '.png': 'image/png', '.svg': 'image/svg+xml', '.ico': 'image/x-icon' };

http.createServer((req, res) => {
  const urlPath = decodeURIComponent(req.url.split('?')[0]);
  let fp = path.normalize(path.join(ROOT, urlPath === '/' ? 'index.html' : urlPath));
  if (!fp.startsWith(ROOT)) { res.writeHead(403); return res.end(); }
  fs.readFile(fp, (err, data) => {
    if (err) { res.writeHead(404); return res.end('not found'); }
    let body = data;
    if (path.extname(fp) === '.html') {
      /* 调试陷阱：赶在 deferred 模块脚本之前装好错误收集器 */
      const trap = '<script>window.__errs=[];window.addEventListener("error",function(e){window.__errs.push("ERR:"+e.message+" @"+(e.filename||"")+":"+e.lineno+":"+e.colno)});window.addEventListener("unhandledrejection",function(e){var r=e.reason||{};window.__errs.push("REJ:"+(r.message||r)+" | "+String(r.stack||"").split("\\n").slice(0,5).join(" ~ "))});</script>';
      body = Buffer.from(body.toString('utf8').replace('<head>', '<head>' + trap));
    }
    res.writeHead(200, { 'Content-Type': MIME[path.extname(fp).toLowerCase()] || 'application/octet-stream',
      'Cache-Control': 'no-store' });
    res.end(body);
  });
}).listen(PORT, () => console.log(`ui preview: http://127.0.0.1:${PORT}/`));
