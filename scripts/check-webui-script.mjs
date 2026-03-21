#!/usr/bin/env node
/**
 * Extracts the inline <script> from the compiled web-ui.js DASHBOARD_HTML
 * and syntax-checks it with node --check. Catches issues like unescaped
 * newlines in string literals (which tsc won't catch inside template literals).
 */
import { execFileSync, spawnSync } from 'child_process';
import fs from 'fs';
import os from 'os';
import path from 'path';

const src = fs.readFileSync('dist/web-ui.js', 'utf-8');
const htmlStart = src.indexOf('const DASHBOARD_HTML = `') + 'const DASHBOARD_HTML = `'.length;
const htmlEnd = src.indexOf('`;', htmlStart);
if (htmlStart <= 0 || htmlEnd <= 0) {
  console.error('check-webui-script: could not locate DASHBOARD_HTML in dist/web-ui.js');
  process.exit(1);
}

const html = src.slice(htmlStart, htmlEnd);
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
