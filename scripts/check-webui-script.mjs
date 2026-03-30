#!/usr/bin/env node
/**
 * Extracts the inline <script> from the compiled web-ui.js DASHBOARD_HTML,
 * evaluates the template literal to get exactly what the browser receives,
 * then syntax-checks it with node --check.
 *
 * Evaluating the template literal is necessary because template literal
 * escape processing differs from raw string content: e.g. \n in the
 * raw source becomes a literal newline in the output (a browser syntax
 * error inside a JS string literal), while \\n becomes \n (valid escape).
 * Checking the raw content misses these bugs; checking the evaluated
 * content catches them.
 */
import { spawnSync } from 'child_process';
import fs from 'fs';
import os from 'os';
import path from 'path';
import vm from 'vm';

const src = fs.readFileSync('dist/web-ui.js', 'utf-8');
const marker = 'const DASHBOARD_HTML = `';
const htmlStart = src.indexOf(marker);
if (htmlStart < 0) {
  console.error('check-webui-script: could not locate DASHBOARD_HTML in dist/web-ui.js');
  process.exit(1);
}
const templateStart = htmlStart + marker.length - 1; // points to the opening backtick
// Find the closing backtick. DASHBOARD_HTML has no ${} expressions so we scan
// for `; on its own — but to be safe, use a simple backtick scan skipping \` escapes.
let depth = 0;
let templateEnd = -1;
for (let i = templateStart; i < src.length; i++) {
  if (src[i] === '\\') { i++; continue; } // skip escaped char
  if (src[i] === '`') {
    if (depth === 0) { depth = 1; continue; } // opening backtick
    templateEnd = i;
    break;
  }
}
if (templateEnd < 0) {
  console.error('check-webui-script: could not find end of DASHBOARD_HTML template literal');
  process.exit(1);
}

// Evaluate the template literal to get the actual HTML the browser receives.
const templateLiteral = src.slice(templateStart, templateEnd + 1);
let html;
try {
  html = vm.runInNewContext(templateLiteral);
} catch (e) {
  console.error('check-webui-script: failed to evaluate DASHBOARD_HTML template literal:');
  console.error(e.message);
  process.exit(1);
}

const scriptStart = html.indexOf('<script>\ndocument');
const scriptEnd = html.lastIndexOf('</script>');
if (scriptStart < 0 || scriptEnd < 0) {
  console.error('check-webui-script: could not locate <script> block in DASHBOARD_HTML');
  process.exit(1);
}

const script = html.slice(scriptStart + 8, scriptEnd);
const tmp = path.join(os.tmpdir(), 'nanoclaw-webui-check.js');
fs.writeFileSync(tmp, script);

const result = spawnSync(process.execPath, ['--check', tmp], { encoding: 'utf-8' });
if (result.status !== 0) {
  console.error('check-webui-script: syntax error in DASHBOARD_HTML <script> block:');
  console.error(result.stderr);
  process.exit(1);
}

console.log('check-webui-script: OK');
