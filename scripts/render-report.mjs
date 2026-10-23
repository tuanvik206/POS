import { readFile, writeFile, stat } from 'node:fs/promises';
import { spawnSync } from 'node:child_process';
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';

const root = resolve(import.meta.dirname, '..');
const markdownPath = resolve(root, 'BAO_CAO_DE_21.md');
const htmlPath = resolve(root, 'BAO_CAO_DE_21.html');
const pdfPath = resolve(root, 'BAO_CAO_DE_21.pdf');
const edgePath = process.env.POS_EDGE_PATH || 'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe';
const markdown = await readFile(markdownPath, 'utf8');

function escapeHtml(value) {
  return value.replaceAll('&', '&amp;').replaceAll('<', '&lt;').replaceAll('>', '&gt;').replaceAll('"', '&quot;');
}

function inline(value) {
  let text = escapeHtml(value);
  const preserved = [];
  const hold = (html) => {
    const key = `@@INLINE${preserved.length}@@`;
    preserved.push(html);
    return key;
  };
  text = text.replace(/`([^`]+)`/g, (_match, code) => hold(`<code>${code}</code>`));
  text = text.replace(/!\[([^\]]*)\]\(([^\s)]+)\)/g, (_match, alt, src) => hold(`<img src="${src}" alt="${alt}">`));
  text = text.replace(/\[([^\]]+)\]\(([^\s)]+)\)/g, (_match, label, url) => hold(`<a href="${url}">${label}</a>`));
  text = text.replace(/&lt;(https?:\/\/[^&]+)&gt;/g, '<a href="$1">$1</a>');
  text = text.replace(/\*\*([^*]+)\*\*/g, '<strong>$1</strong>');
  text = text.replace(/\*([^*]+)\*/g, '<em>$1</em>');
  return text.replace(/@@INLINE(\d+)@@/g, (_match, index) => preserved[Number(index)]);
}

function parseBlocks(lines) {
  const output = [];
  let i = 0;
  while (i < lines.length) {
    const line = lines[i].trim();
    if (!line) { i += 1; continue; }
    if (line === '\\newpage') { output.push('<div class="page-break"></div>'); i += 1; continue; }
    if (line.startsWith('```')) {
      const language = line.slice(3).trim();
      const code = [];
      i += 1;
      while (i < lines.length && !lines[i].trim().startsWith('```')) code.push(lines[i++]);
      if (i < lines.length) i += 1;
      output.push(`<pre><code${language ? ` class="language-${escapeHtml(language)}"` : ''}>${escapeHtml(code.join('\n'))}</code></pre>`);
      continue;
    }
    if (/^!\[[^\]]*\]\([^)]+\)$/.test(line)) {
      const [, alt, src] = line.match(/^!\[([^\]]*)\]\(([^)]+)\)$/);
      output.push(`<figure><img src="${escapeHtml(src)}" alt="${escapeHtml(alt)}"><figcaption>${inline(alt)}</figcaption></figure>`);
      i += 1;
      continue;
    }
    if (/^#{1,6}\s/.test(line)) {
      const [, marks, title] = line.match(/^(#{1,6})\s+(.+)$/);
      const level = marks.length;
      const id = `section-${title.normalize('NFD').replace(/[\u0300-\u036f]/g, '').toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '')}`;
      output.push(`<h${level} id="${id}">${inline(title)}</h${level}>`);
      i += 1;
      continue;
    }
    if (line.startsWith('|')) {
      const rows = [];
      while (i < lines.length && lines[i].trim().startsWith('|')) rows.push(lines[i++].trim());
      const cells = (row) => row.replace(/^\||\|$/g, '').split('|').map((cell) => cell.trim());
      const headers = cells(rows[0]);
      const body = rows.slice(1).filter((row) => !/^\|?\s*:?-{3,}/.test(row)).map(cells);
      output.push(`<table><thead><tr>${headers.map((cell) => `<th>${inline(cell)}</th>`).join('')}</tr></thead><tbody>${body.map((row) => `<tr>${row.map((cell) => `<td>${inline(cell)}</td>`).join('')}</tr>`).join('')}</tbody></table>`);
      continue;
    }
    if (/^[-*]\s/.test(line) || /^\d+\.\s/.test(line)) {
      const ordered = /^\d+\.\s/.test(line);
      const items = [];
      while (i < lines.length && (ordered ? /^\s*\d+\.\s/ : /^\s*[-*]\s/).test(lines[i])) {
        items.push(lines[i++].trim().replace(ordered ? /^\d+\.\s/ : /^[-*]\s/, ''));
      }
      const tag = ordered ? 'ol' : 'ul';
      output.push(`<${tag}>${items.map((item) => `<li>${inline(item)}</li>`).join('')}</${tag}>`);
      continue;
    }
    if (line.startsWith('>')) {
      const quote = [];
      while (i < lines.length && lines[i].trim().startsWith('>')) quote.push(lines[i++].trim().replace(/^>\s?/, ''));
      output.push(`<blockquote>${parseBlocks(quote)}</blockquote>`);
      continue;
    }
    const paragraph = [line];
    i += 1;
    while (i < lines.length && lines[i].trim() && !/^(#{1,6}\s|```|\\newpage|\||[-*]\s|\d+\.\s|>\s|!\[)/.test(lines[i].trim())) paragraph.push(lines[i++].trim());
    output.push(`<p>${paragraph.map(inline).join('<br>')}</p>`);
  }
  return output.join('\n');
}

const lines = markdown.replaceAll('\r\n', '\n').split('\n');
const coverBreak = lines.indexOf('\\newpage');
if (coverBreak < 0) throw new Error('Report is missing the cover page break');
const coverHtml = parseBlocks(lines.slice(0, coverBreak));
const bodyHtml = parseBlocks(lines.slice(coverBreak + 1));
const html = `<!doctype html>
<html lang="vi"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>Báo cáo đề tài 21 · POS Store</title>
<style>
@page{size:A4;margin:17mm 16mm 18mm}*{box-sizing:border-box}html{font-family:"Aptos","Segoe UI",Arial,sans-serif;color:#172033;font-size:10.3pt;line-height:1.52}body{margin:0}h1,h2,h3,h4{color:#12315a;line-height:1.2;break-after:avoid}h1{font-size:24pt;margin:0 0 22pt}h2{font-size:17pt;margin:0 0 15pt;padding-bottom:5pt;border-bottom:1px solid #cbd5e1}h3{font-size:12.5pt;margin:15pt 0 6pt}h4{font-size:11pt;margin:12pt 0 5pt}p{margin:0 0 8pt;text-align:justify}ul,ol{margin:3pt 0 10pt;padding-left:22pt}li{margin:0 0 3pt}strong{color:#12315a}a{color:#1558a6;text-decoration:none;overflow-wrap:anywhere}blockquote{margin:20pt 0 0;padding:12pt 15pt;border-left:3pt solid #2070d7;background:#eff6ff;color:#334155}blockquote p{margin:0;text-align:left}code{font-family:Consolas,"Cascadia Code",monospace;font-size:9pt;background:#f1f5f9;padding:1pt 3pt;border-radius:3pt}pre{margin:7pt 0 10pt;padding:10pt 12pt;background:#0f172a;color:#e2e8f0;border-radius:7pt;white-space:pre-wrap;overflow-wrap:anywhere;break-inside:avoid}pre code{padding:0;background:none;color:inherit;font-size:8.5pt}table{width:100%;border-collapse:collapse;margin:8pt 0 12pt;font-size:9pt;break-inside:auto}thead{display:table-header-group}tr{break-inside:avoid}th{background:#eaf1fb;color:#12315a;text-align:left;font-weight:700}th,td{border:1px solid #cbd5e1;padding:5pt 6pt;vertical-align:top}figure{margin:13pt 0 15pt;text-align:center;break-inside:avoid}figure img{display:block;width:100%;max-height:226mm;object-fit:contain;margin:auto;border:1px solid #d9e2ef;border-radius:5pt}figcaption{margin-top:4pt;color:#52627a;font-size:9pt;font-style:italic}.page-break{break-before:page;page-break-before:always}.cover{height:260mm;display:flex;flex-direction:column;justify-content:center;align-items:center;text-align:center;padding:18mm 15mm;background:linear-gradient(150deg,#f7fbff,#fff 58%,#eef5ff);border:1px solid #d9e7f7}.cover h1{font-size:27pt;line-height:1.28;letter-spacing:.3pt;color:#12315a;margin:0 0 11pt}.cover h2{font-size:13pt;letter-spacing:1.8pt;text-transform:uppercase;border:0;padding:0;margin:0 0 32pt;color:#2563a6}.cover p{font-size:12pt;text-align:center;line-height:1.8;margin:0}.cover blockquote{align-self:stretch;margin-top:28pt;font-size:9.5pt;text-align:left}.cover h1::before{content:"BÁO CÁO ĐỒ ÁN MÔN HỌC";display:block;font-size:12pt;letter-spacing:2pt;color:#2563a6;margin-bottom:20pt}.cover h1{font-size:0}.cover h1::after{content:attr(data-title);font-size:27pt}.cover h1{font-size:27pt}.cover h1::before{display:none}.cover h1{position:relative}.cover h1:first-child{font-size:27pt}.cover p:first-of-type{margin-top:2pt}.cover blockquote{font-size:9.5pt}.cover::before{content:"TRIỂN KHAI VÀ QUẢN TRỊ HỆ THỐNG PHẦN MỀM";color:#2563a6;font-size:12pt;font-weight:700;letter-spacing:1.4pt;margin-bottom:28pt}.cover h1{border-bottom:0}.cover h1 + p{font-size:13pt;font-weight:600;color:#334155;margin:5pt 0 17pt}.cover p strong{color:#12315a}.cover p br{line-height:2}
</style></head><body><section class="cover">${coverHtml}</section>${bodyHtml}</body></html>`;
await writeFile(htmlPath, html, 'utf8');
const htmlUrl = pathToFileURL(htmlPath).href;
const result = spawnSync(edgePath, ['--headless=new', '--disable-gpu', '--no-first-run', '--no-default-browser-check', '--no-pdf-header-footer', `--print-to-pdf=${pdfPath}`, htmlUrl], { stdio: 'ignore', windowsHide: true, timeout: 120000 });
if (result.error) throw new Error(`Could not run Microsoft Edge: ${result.error.message}`);
if (result.status !== 0) throw new Error(`Microsoft Edge PDF rendering failed with exit code ${result.status}`);
const pdf = await stat(pdfPath);
if (pdf.size < 50000) throw new Error(`Generated PDF appears incomplete (${pdf.size} bytes)`);
console.log(JSON.stringify({ html: 'BAO_CAO_DE_21.html', pdf: 'BAO_CAO_DE_21.pdf', bytes: pdf.size }));
