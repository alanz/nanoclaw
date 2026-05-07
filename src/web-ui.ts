/**
 * NanoClaw v2 Web Dashboard
 * Read-only web UI for inspecting groups, sessions, files, and the memory graph.
 * Intended to be exposed over Tailscale Serve (HTTPS) — bind to localhost only.
 */
import { createServer, IncomingMessage, Server, ServerResponse } from 'http';
import fs from 'fs';
import path from 'path';
import { URL } from 'url';
import Database from 'better-sqlite3';

import { GROUPS_DIR } from './config.js';
import { getDb } from './db/connection.js';
import { getAllAgentGroups, getAgentGroupByFolder } from './db/agent-groups.js';
import { getAllMessagingGroups } from './db/messaging-groups.js';
import { getActiveSessions, getSession, getSessionsByAgentGroup } from './db/sessions.js';
import { getActiveContainerCount, getQueueStatus } from './container-runner.js';
import { inboundDbPath, outboundDbPath } from './session-manager.js';
import { log } from './log.js';

// ---------------------------------------------------------------------------
// HTML dashboard
// ---------------------------------------------------------------------------

const DASHBOARD_HTML = `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>NanoClaw</title>
<link rel="stylesheet" href="https://cdnjs.cloudflare.com/ajax/libs/highlight.js/11.9.0/styles/github-dark.min.css">
<style>
*{box-sizing:border-box;margin:0;padding:0}
body{font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',sans-serif;background:#0d1117;color:#e6edf3;display:flex;height:100vh;overflow:hidden}
nav{width:180px;background:#161b22;border-right:1px solid #30363d;padding:16px;flex-shrink:0;display:flex;flex-direction:column;gap:4px}
nav h1{font-size:13px;font-weight:700;color:#f0f6fc;margin-bottom:20px;letter-spacing:.5px}
nav a{display:block;padding:8px 10px;color:#8b949e;text-decoration:none;border-radius:6px;font-size:13px;cursor:pointer;user-select:none}
nav a:hover,nav a.active{background:#21262d;color:#e6edf3}
main{flex:1;overflow:auto;padding:24px}
.section{display:none}.section.active{display:block}
h2{font-size:17px;font-weight:600;margin-bottom:16px;color:#f0f6fc}
.card{background:#161b22;border:1px solid #30363d;border-radius:8px;padding:16px;margin-bottom:12px}
.group-card{cursor:pointer;transition:border-color .15s}
.group-card:hover{border-color:#58a6ff}
.badge{display:inline-block;padding:2px 8px;border-radius:12px;font-size:11px;font-weight:600}
.bg{background:#1f4a2b;color:#3fb950}.by{background:#3d2e0a;color:#d29922}.br{background:#3d1010;color:#f85149}.bb{background:#0d2744;color:#58a6ff}
table{width:100%;border-collapse:collapse;font-size:13px}
th{text-align:left;padding:8px 12px;color:#8b949e;font-weight:600;border-bottom:1px solid #30363d}
td{padding:8px 12px;border-bottom:1px solid #21262d;vertical-align:top}
tr:last-child td{border-bottom:none}
tr:hover td{background:#1c2128}
.msgs{max-height:calc(100vh - 280px);overflow-y:auto;border:1px solid #30363d;border-radius:8px;padding:12px;background:#161b22;margin-bottom:12px}
.msg{padding:6px 0;border-bottom:1px solid #21262d}
.msg:last-child{border-bottom:none}
.msg-meta{font-size:11px;color:#8b949e;margin-bottom:3px}
.msg-body{font-size:13px;white-space:pre-wrap;word-break:break-word}
.msg.outbound .msg-body{color:#79c0ff}.msg.inbound .msg-body{color:#e6edf3}
.back{color:#8b949e;font-size:13px;cursor:pointer;margin-bottom:16px;display:inline-block}
.back:hover{color:#e6edf3}
.empty{color:#8b949e;font-style:italic;text-align:center;padding:32px}
.dim{color:#8b949e;font-size:12px}
.ftree-dir{padding:4px 6px;font-size:13px;font-weight:600;color:#8b949e;cursor:pointer;user-select:none;border-radius:4px}
.ftree-dir:hover{color:#e6edf3}
.ftree-file{padding:3px 6px 3px 18px;font-size:12px;color:#8b949e;cursor:pointer;border-radius:4px;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
.ftree-file:hover,.ftree-file.active{background:#21262d;color:#e6edf3}
.ftree-children{margin-left:8px}
.file-maximize-btn{position:absolute;top:8px;right:8px;background:#21262d;border:1px solid #30363d;border-radius:4px;color:#8b949e;font-size:14px;width:26px;height:26px;display:flex;align-items:center;justify-content:center;cursor:pointer;z-index:10;line-height:1}
.file-maximize-btn:hover{background:#30363d;color:#e6edf3}
body.file-maximized nav{display:none}
body.file-maximized #group-back{display:none}
body.file-maximized #group-detail-name,body.file-maximized #group-detail-badges{display:none}
body.file-maximized .subnav{display:none}
body.file-maximized #group-file-tree{display:none}
body.file-maximized #group-tab-files>div{height:100vh;padding:0}
body.file-maximized main{padding:0}
body.file-maximized #group-file-view{border-radius:0;height:100vh}
.md-body{font-size:14px;line-height:1.6;color:#e6edf3}
.md-body h1,.md-body h2,.md-body h3{color:#79c0ff;margin:16px 0 8px;border-bottom:1px solid #30363d;padding-bottom:4px}
.md-body h1{font-size:20px}.md-body h2{font-size:17px}.md-body h3{font-size:15px}
.md-body p{margin:8px 0}
.md-body ul,.md-body ol{padding-left:20px;margin:8px 0}
.md-body li{margin:3px 0}
.md-body code{background:#21262d;border-radius:3px;padding:1px 5px;font-size:12px;font-family:monospace}
.md-body pre{background:#161b22;border:1px solid #30363d;border-radius:6px;padding:12px;overflow-x:auto;margin:8px 0;max-height:none}
.md-body pre code{background:none;padding:0}
.md-body blockquote{border-left:3px solid #30363d;margin:8px 0;padding:4px 12px;color:#8b949e}
.md-body a{color:#58a6ff}.md-body a.link-internal{color:#7ee787}.md-body a.link-external{color:#58a6ff}
.md-body table{border-collapse:collapse;width:100%;margin:8px 0}
.md-body th,.md-body td{border:1px solid #30363d;padding:6px 12px}
.md-body th{background:#21262d}
.md-body hr{border:none;border-top:1px solid #30363d;margin:16px 0}
.fm-card{background:#161b22;border:1px solid #30363d;border-radius:6px;padding:10px 14px;margin-bottom:16px;font-size:12px;display:grid;grid-template-columns:auto 1fr;gap:4px 14px;align-items:baseline}
.fm-key{color:#8b949e;white-space:nowrap;user-select:none}
.fm-val{color:#e6edf3;word-break:break-word}
.fm-tag{display:inline-block;background:#21262d;border:1px solid #30363d;border-radius:10px;padding:1px 8px;font-size:11px;color:#8b949e;margin:1px 2px 1px 0}
.subnav{display:flex;gap:4px;margin-bottom:20px;border-bottom:1px solid #30363d;padding-bottom:0}
.subnav a{padding:7px 14px;font-size:13px;color:#8b949e;cursor:pointer;text-decoration:none;border-bottom:2px solid transparent;margin-bottom:-1px;user-select:none}
.subnav a:hover{color:#e6edf3}
.subnav a.active{color:#e6edf3;border-bottom-color:#58a6ff}
#db-search:focus{border-color:#58a6ff;outline:none}
.db-table-item{padding:5px 8px;font-size:12px;color:#8b949e;cursor:pointer;border-radius:4px;display:flex;justify-content:space-between;align-items:center;user-select:none}
.db-table-item:hover,.db-table-item.active{background:#21262d;color:#e6edf3}
.db-null{color:#484f58;font-style:italic}
button:disabled{opacity:.4;cursor:not-allowed}
#mobile-nav{display:none;position:fixed;bottom:0;left:0;right:0;background:#161b22;border-top:1px solid #30363d;z-index:100;height:60px}
#mobile-nav a{flex:1;display:flex;align-items:center;justify-content:center;padding:10px 4px;color:#8b949e;text-decoration:none;font-size:12px;cursor:pointer;user-select:none}
#mobile-nav a:hover,#mobile-nav a.active{color:#e6edf3;background:#21262d}
@media(max-width:640px){
  nav{display:none}
  #mobile-nav{display:flex}
  main{padding:16px;padding-bottom:76px}
  .msgs{max-height:calc(100vh - 360px)}
  body{overflow:auto}
  #group-tab-files>div{flex-direction:column!important;height:calc(100vh - 280px)!important}
  #group-file-tree{width:100%!important;height:35%!important;flex-shrink:unset!important}
  #group-file-view{height:65%!important}
}
/* Graph tab */
#graph-container{width:100%;height:calc(100vh - 340px);min-height:400px;background:#0d1117;border:1px solid #30363d;border-radius:8px;position:relative}
#graph-toolbar{display:flex;gap:8px;align-items:center;margin-bottom:10px}
#graph-search{flex:1;background:#21262d;border:1px solid #30363d;border-radius:6px;padding:7px 12px;color:#e6edf3;font-size:13px;outline:none}
#graph-search:focus{border-color:#58a6ff}
#graph-status{font-size:12px;color:#8b949e;white-space:nowrap}
#graph-legend{display:flex;flex-wrap:wrap;gap:6px;margin-bottom:10px}
.graph-legend-item{display:flex;align-items:center;gap:4px;font-size:11px;color:#8b949e;cursor:pointer;padding:2px 6px;border-radius:4px;border:1px solid transparent;user-select:none}
.graph-legend-item:hover{color:#e6edf3;background:rgba(255,255,255,0.05)}
.graph-legend-item.active{color:#e6edf3;border-color:currentColor;background:rgba(255,255,255,0.08)}
.graph-legend-item.node-highlighted{background:rgba(88,166,255,0.08);color:#e6edf3}
.graph-legend-dot{width:10px;height:10px;border-radius:50%;flex-shrink:0}
#graph-legend-footer{display:none;align-items:center;gap:8px;margin-bottom:10px}
#graph-legend-more{font-size:11px;color:#58a6ff;cursor:pointer;user-select:none}
#graph-legend-filter{flex:1;max-width:180px;background:#21262d;border:1px solid #30363d;border-radius:4px;padding:4px 8px;color:#e6edf3;font-size:11px;outline:none}
#graph-node-panel{display:none;position:absolute;bottom:12px;right:12px;width:320px;background:rgba(22,27,34,0.95);border:1px solid #30363d;border-radius:8px;padding:14px;z-index:10;backdrop-filter:blur(8px)}
#graph-node-panel h3{font-size:13px;font-weight:600;color:#f0f6fc;margin:0 0 10px;word-break:break-all}
/* Session picker */
.sess-item{padding:6px 10px;font-size:12px;color:#8b949e;cursor:pointer;border-radius:4px;border:1px solid transparent;margin-bottom:4px}
.sess-item:hover{background:#21262d;color:#e6edf3}
.sess-item.active{background:#0d2744;color:#58a6ff;border-color:#1f6feb}
</style>
</head>
<body>
<nav>
  <h1>NanoClaw</h1>
  <a id="nav-overview" href="#overview">Overview</a>
  <a id="nav-groups" href="#groups">Groups</a>
  <a id="nav-system" href="#system">System</a>
  <a id="nav-database" href="#database">Database</a>
</nav>
<main>
  <!-- Overview -->
  <div id="section-overview" class="section">
    <div style="display:flex;align-items:center;justify-content:space-between;margin-bottom:16px">
      <h2 style="margin-bottom:0">System Overview</h2>
      <span id="overview-refresh-status" class="dim" style="font-size:12px"></span>
    </div>
    <div id="overview-stats" style="display:grid;grid-template-columns:repeat(auto-fill,minmax(150px,1fr));gap:12px;margin-bottom:24px"></div>
    <div style="font-size:11px;font-weight:600;color:#8b949e;text-transform:uppercase;letter-spacing:.5px;margin-bottom:8px">Active Sessions</div>
    <div id="overview-sessions" class="card" style="padding:0;margin-bottom:20px;overflow:hidden"></div>
    <div id="overview-orphans-label" style="font-size:11px;font-weight:600;color:#8b949e;text-transform:uppercase;letter-spacing:.5px;margin-bottom:8px">Orphan Containers</div>
    <div id="overview-orphans" class="card" style="padding:0;overflow:hidden"></div>
  </div>

  <!-- Groups: list + detail -->
  <div id="section-groups" class="section">
    <div id="groups-list">
      <h2>Groups</h2>
      <div id="groups-body">Loading…</div>
    </div>
    <div id="group-detail" style="display:none">
      <a id="group-back" class="back">&#8592; Groups</a>
      <div style="display:flex;align-items:center;gap:10px;margin-bottom:16px">
        <h2 id="group-detail-name" style="margin-bottom:0"></h2>
        <span id="group-detail-badges"></span>
      </div>
      <div class="subnav" id="group-subnav">
        <a data-tab="messages">Messages</a>
        <a data-tab="files">Files</a>
        <a data-tab="notes">Graph</a>
      </div>

      <!-- Messages tab -->
      <div id="group-tab-messages">
        <div id="group-sess-pick" style="margin-bottom:12px"></div>
        <div id="group-msgs" class="msgs"></div>
      </div>

      <!-- Files tab -->
      <div id="group-tab-files" style="display:none">
        <div style="display:flex;gap:16px;height:calc(100vh - 220px)">
          <div id="group-file-tree" style="width:260px;flex-shrink:0;overflow-y:auto;background:#161b22;border:1px solid #30363d;border-radius:8px;padding:8px"></div>
          <div id="group-file-view" style="flex:1;overflow:auto;background:#161b22;border:1px solid #30363d;border-radius:8px;padding:16px;position:relative">
            <button class="file-maximize-btn" id="file-maximize-btn" title="Maximise file view">&#x26F6;</button>
            <div id="group-file-content"><div class="empty">Select a file to view its contents</div></div>
          </div>
        </div>
      </div>

      <!-- Graph tab -->
      <div id="group-tab-notes" style="display:none">
        <div id="graph-toolbar">
          <input id="graph-search" type="text" placeholder="Filter by keyword or tag…">
          <span id="graph-status"></span>
        </div>
        <div id="graph-legend"></div>
        <div id="graph-legend-footer">
          <span id="graph-legend-more"></span>
          <input id="graph-legend-filter" type="text" placeholder="filter tags…">
        </div>
        <div id="graph-wrap" style="position:relative">
          <div id="graph-container"></div>
          <div id="graph-node-panel">
            <h3 id="graph-node-id"></h3>
            <div class="fm-card" id="graph-node-meta"></div>
          </div>
        </div>
      </div>
    </div>
  </div>

  <!-- System -->
  <div id="section-system" class="section">
    <h2>Sessions</h2>
    <div id="sessions-body">Loading…</div>
    <h2 style="margin-top:24px">Messaging Groups</h2>
    <div id="messaging-groups-body">Loading…</div>
  </div>

  <!-- Database Explorer -->
  <div id="section-database" class="section">
    <h2>Database Explorer</h2>
    <div style="display:flex;gap:16px;height:calc(100vh - 120px)">
      <div id="db-table-list" style="width:190px;flex-shrink:0;overflow-y:auto;background:#161b22;border:1px solid #30363d;border-radius:8px;padding:8px">
        <div class="dim" style="font-size:11px;padding:4px 6px;margin-bottom:4px;font-weight:600;letter-spacing:.4px;text-transform:uppercase">Tables</div>
      </div>
      <div style="flex:1;overflow:hidden;display:flex;flex-direction:column;gap:10px">
        <div id="db-table-header" style="display:none">
          <div style="display:flex;align-items:center;gap:12px">
            <strong id="db-table-name" style="font-size:14px;color:#f0f6fc"></strong>
            <span id="db-table-count" class="dim" style="font-size:12px"></span>
            <input id="db-search" type="text" placeholder="Search…" style="margin-left:auto;width:220px;background:#21262d;border:1px solid #30363d;border-radius:6px;padding:6px 10px;color:#e6edf3;font-size:13px">
          </div>
        </div>
        <div id="db-table-body" style="flex:1;overflow:auto"></div>
        <div id="db-pagination" style="display:none;align-items:center;gap:10px;padding-bottom:4px">
          <button id="db-prev" style="background:#21262d;border:1px solid #30363d;border-radius:6px;padding:5px 12px;color:#e6edf3;font-size:13px;cursor:pointer">&#8592; Prev</button>
          <span id="db-page-info" class="dim" style="font-size:12px"></span>
          <button id="db-next" style="background:#21262d;border:1px solid #30363d;border-radius:6px;padding:5px 12px;color:#e6edf3;font-size:13px;cursor:pointer">Next &#8594;</button>
        </div>
      </div>
    </div>
  </div>
</main>

<script src="https://cdn.jsdelivr.net/npm/marked@12/marked.min.js"></script>
<script src="https://cdnjs.cloudflare.com/ajax/libs/highlight.js/11.9.0/highlight.min.js"></script>
<script src="https://cdn.jsdelivr.net/npm/d3@7/dist/d3.min.js"></script>
<script src="https://cdn.jsdelivr.net/npm/cytoscape@3.28.1/dist/cytoscape.min.js"></script>
<script>
document.addEventListener('DOMContentLoaded', function() {
  var currentGroup = null;
  var currentTab = 'messages';
  var currentSession = null;
  var pollTimer = null;
  var orgIdCache = null;
  var pendingGraphSelect = null;

  async function fetchOrgIds() {
    if (orgIdCache) return orgIdCache;
    try { orgIdCache = await (await fetch('/api/org-ids')).json(); } catch { orgIdCache = {}; }
    return orgIdCache;
  }

  function esc(s) {
    if (s == null) return '';
    return String(s).replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;').replace(/"/g,'&quot;');
  }

  function fmtDate(ts) {
    if (!ts) return '';
    try {
      var d = new Date(ts), now = new Date(), diff = now - d;
      if (diff < 0) {
        var abs = -diff;
        if (abs < 3600000) return 'in '+Math.ceil(abs/60000)+'m';
        if (abs < 86400000) return 'in '+Math.ceil(abs/3600000)+'h';
        return 'in '+Math.ceil(abs/86400000)+'d';
      }
      if (diff < 60000) return 'just now';
      if (diff < 3600000) return Math.floor(diff/60000)+'m ago';
      if (diff < 86400000) return Math.floor(diff/3600000)+'h ago';
      return d.toLocaleDateString()+' '+d.toLocaleTimeString();
    } catch(e) { return ts; }
  }

  function fmtTime(ts) {
    if (!ts) return '';
    try { return new Date(ts).toLocaleTimeString(); } catch(e) { return ts; }
  }

  // ── URL routing ──────────────────────────────────────────────────────────
  // #overview
  // #groups
  // #groups/{folder}                → messages tab
  // #groups/{folder}/messages       → messages tab
  // #groups/{folder}/files          → files tab
  // #groups/{folder}/files/{path}   → files tab with file open
  // #groups/{folder}/notes          → graph tab
  // #groups/{folder}/notes/{id}     → graph tab with node selected
  // #system
  // #database/{table}

  function pushHash(hash) { history.pushState(null, '', '#' + hash); }

  function parseHash(hash) {
    var qIdx = hash.indexOf('?');
    var query = qIdx !== -1 ? hash.slice(qIdx + 1) : '';
    hash = (qIdx !== -1 ? hash.slice(0, qIdx) : hash).replace(/^#/, '') || 'groups';
    var parts = hash.split('/');
    var section = parts[0] || 'groups';
    if (section === 'overview') return { section: 'overview' };
    if (section === 'system') return { section: 'system' };
    if (section === 'database') {
      var dbTable = parts[1] || null;
      var dbPage = 0, dbSearch = '';
      if (query) query.split('&').forEach(function(kv) {
        var eq = kv.indexOf('=');
        if (eq === -1) return;
        var k = decodeURIComponent(kv.slice(0, eq)), v = decodeURIComponent(kv.slice(eq + 1));
        if (k === 'page') dbPage = Math.max(0, parseInt(v, 10) || 0);
        if (k === 'search') dbSearch = v;
      });
      return { section: 'database', table: dbTable, page: dbPage, search: dbSearch };
    }
    var folder = parts[1] || null;
    if (!folder) return { section: 'groups', folder: null };
    var tab = parts[2] || 'messages';
    var filePath = (tab === 'files' && parts.length > 3) ? parts.slice(3).join('/') : null;
    var noteId = (tab === 'notes' && parts.length > 3) ? parts[3] : null;
    return { section: 'groups', folder: folder, tab: tab, filePath: filePath, noteId: noteId };
  }

  async function restoreFromHash() {
    var state = parseHash(location.hash);
    try {
      if (state.section === 'overview') { activateSection('overview'); clearInterval(pollTimer); pollTimer = null; startOverview(); return; }
      stopOverview();
      if (state.section === 'system') { activateSection('system'); clearInterval(pollTimer); pollTimer = null; loadSystem(); return; }
      if (state.section === 'database') {
        activateSection('database'); clearInterval(pollTimer); pollTimer = null;
        if (state.table) { pendingDbTable = state.table; pendingDbPage = state.page || 0; pendingDbSearch = state.search || ''; }
        loadDbTables(); return;
      }
      activateSection('groups');
      clearInterval(pollTimer); pollTimer = null;
      if (!state.folder) { showGroupListInternal(); return; }
      var data = await fetch('/api/groups').then(function(r) { return r.json(); });
      var g = data.find(function(x) { return x.folder === state.folder; });
      if (!g) { showGroupListInternal(); return; }
      currentGroup = g;
      document.getElementById('groups-list').style.display = 'none';
      document.getElementById('group-detail').style.display = '';
      document.getElementById('group-detail-name').textContent = g.name;
      document.getElementById('group-detail-badges').innerHTML = '<code style="font-size:11px;color:#8b949e">'+esc(g.folder)+'</code>';
      if (state.noteId) pendingGraphSelect = state.noteId;
      switchTab(state.tab || 'messages', state.filePath);
    } catch(e) {}
  }

  window.addEventListener('popstate', function() {
    var maximized = document.body.classList.contains('file-maximized');
    if (maximized) {
      document.body.classList.remove('file-maximized');
      var btn = document.getElementById('file-maximize-btn');
      if (btn) { btn.innerHTML = '&#x26F6;'; btn.title = 'Maximise file view'; }
      return;
    }
    restoreFromHash();
  });

  // ── Top-level nav ──────────────────────────────────────────────────────────

  function activateSection(name) {
    document.querySelectorAll('.section').forEach(function(s) { s.classList.remove('active'); });
    document.querySelectorAll('nav a').forEach(function(a) { a.classList.remove('active'); });
    var sec = document.getElementById('section-'+name);
    var nav = document.getElementById('nav-'+name);
    if (sec) sec.classList.add('active');
    if (nav) nav.classList.add('active');
  }

  function show(name) {
    pushHash(name);
    activateSection(name);
    clearInterval(pollTimer); pollTimer = null;
    stopOverview();
    if (name === 'overview') startOverview();
    if (name === 'groups') showGroupListInternal();
    if (name === 'system') loadSystem();
    if (name === 'database') loadDbTables();
  }

  document.querySelectorAll('nav a').forEach(function(a) {
    a.addEventListener('click', function(e) {
      e.preventDefault();
      show((a.getAttribute('href') || '#groups').replace('#',''));
    });
  });

  // ── Group list ─────────────────────────────────────────────────────────────

  function showGroupListInternal() {
    clearInterval(pollTimer); pollTimer = null;
    currentGroup = null;
    document.getElementById('groups-list').style.display = '';
    document.getElementById('group-detail').style.display = 'none';
    loadGroups();
  }

  function showGroupList() { pushHash('groups'); showGroupListInternal(); }

  async function loadGroups() {
    var el = document.getElementById('groups-body');
    try {
      var data = await fetch('/api/groups').then(function(r) { return r.json(); });
      if (!data.length) { el.innerHTML = '<div class="empty">No agent groups</div>'; return; }
      el.innerHTML = data.map(function(g) {
        return '<div class="card group-card" data-folder="'+esc(g.folder)+'">'
          +'<div style="display:flex;justify-content:space-between;align-items:center">'
          +'<strong>'+esc(g.name)+'</strong>'
          +'<span>'
          +(g.sessionCount > 0 ? '<span class="badge bg">'+g.sessionCount+' session'+(g.sessionCount>1?'s':'')+'</span> ' : '<span class="badge" style="background:#1c2128;color:#8b949e">no sessions</span> ')
          +(g.messagingGroupCount > 0 ? '<span class="badge bb">'+g.messagingGroupCount+' channel'+(g.messagingGroupCount>1?'s':'')+'</span>' : '')
          +'</span>'
          +'</div>'
          +'<div class="dim" style="margin-top:6px"><code>'+esc(g.folder)+'</code> &nbsp;&middot;&nbsp; added '+fmtDate(g.created_at)+'</div>'
          +'</div>';
      }).join('');
      el._groups = data;
    } catch(e) { el.innerHTML = '<div class="empty">Error loading groups</div>'; }
  }

  document.getElementById('groups-body').addEventListener('click', function(e) {
    var card = e.target.closest('[data-folder]');
    if (!card) return;
    var folder = card.dataset.folder;
    var groups = document.getElementById('groups-body')._groups || [];
    var g = groups.find(function(x) { return x.folder === folder; });
    if (g) openGroup(g);
  });

  // ── Group detail ───────────────────────────────────────────────────────────

  document.getElementById('group-back').addEventListener('click', showGroupList);

  document.getElementById('group-subnav').addEventListener('click', function(e) {
    var a = e.target.closest('[data-tab]');
    if (a) switchTab(a.dataset.tab);
  });

  function openGroup(g) {
    currentGroup = g;
    currentSession = null;
    document.getElementById('groups-list').style.display = 'none';
    document.getElementById('group-detail').style.display = '';
    document.getElementById('group-detail-name').textContent = g.name;
    document.getElementById('group-detail-badges').innerHTML = '<code style="font-size:11px;color:#8b949e">'+esc(g.folder)+'</code>';
    switchTab('messages');
  }

  function switchTab(tab, autoFilePath) {
    clearInterval(pollTimer); pollTimer = null;
    currentTab = tab;
    document.querySelectorAll('#group-subnav [data-tab]').forEach(function(a) {
      a.classList.toggle('active', a.dataset.tab === tab);
    });
    document.getElementById('group-tab-messages').style.display = tab === 'messages' ? '' : 'none';
    document.getElementById('group-tab-files').style.display   = tab === 'files'    ? '' : 'none';
    document.getElementById('group-tab-notes').style.display   = tab === 'notes'    ? '' : 'none';
    if (tab !== 'files' && document.body.classList.contains('file-maximized')) {
      document.body.classList.remove('file-maximized');
      var btn = document.getElementById('file-maximize-btn');
      if (btn) { btn.innerHTML = '&#x26F6;'; btn.title = 'Maximise file view'; }
    }
    if (currentGroup) {
      var base = 'groups/' + currentGroup.folder;
      if (tab === 'messages') pushHash(base + '/messages');
      else if (tab === 'files' && autoFilePath) pushHash(base + '/files/' + autoFilePath);
      else if (tab === 'notes' && pendingGraphSelect) pushHash(base + '/notes/' + pendingGraphSelect);
      else pushHash(base + '/' + tab);
    }
    if (tab === 'messages') loadGroupMessages();
    if (tab === 'files')    loadGroupFiles(autoFilePath);
    if (tab === 'notes')    loadGroupGraph();
  }

  // ── Messages tab ───────────────────────────────────────────────────────────

  var groupSessions = [];

  async function loadGroupMessages() {
    if (!currentGroup) return;
    var pickEl = document.getElementById('group-sess-pick');
    var msgsEl = document.getElementById('group-msgs');
    pickEl.innerHTML = '<div class="dim">Loading sessions…</div>';
    msgsEl.innerHTML = '';
    try {
      var sessions = await fetch('/api/sessions?group='+encodeURIComponent(currentGroup.folder)).then(function(r) { return r.json(); });
      groupSessions = sessions;
      if (!sessions.length) {
        pickEl.innerHTML = '<div class="empty" style="padding:8px">No sessions yet</div>';
        return;
      }
      // Auto-select most recent session
      if (!currentSession || !sessions.find(function(s) { return s.id === currentSession; })) {
        currentSession = sessions[0].id;
      }
      renderSessionPicker(sessions);
      await loadSessionMessages(currentSession);
      clearInterval(pollTimer);
      pollTimer = setInterval(function() { loadSessionMessages(currentSession); }, 5000);
    } catch(e) { pickEl.innerHTML = '<div class="empty">Error loading sessions</div>'; }
  }

  function renderSessionPicker(sessions) {
    var el = document.getElementById('group-sess-pick');
    if (sessions.length === 1) {
      var s = sessions[0];
      el.innerHTML = '<div class="dim" style="margin-bottom:8px">'
        +'Session: <code>'+esc(s.id.slice(0,12))+'…</code>'
        +' &nbsp;&middot;&nbsp; <span class="badge '+(s.container_status==='running'?'bg':s.container_status==='idle'?'bb':'')+'">'+esc(s.container_status||'stopped')+'</span>'
        +(s.messaging_group_name ? ' &nbsp;&middot;&nbsp; '+esc(s.messaging_group_name) : '')
        +' &nbsp;&middot;&nbsp; active '+fmtDate(s.last_active)
        +'</div>';
      return;
    }
    el.innerHTML = sessions.map(function(s) {
      var cls = s.id === currentSession ? 'sess-item active' : 'sess-item';
      return '<div class="'+cls+'" data-sess-id="'+esc(s.id)+'">'
        +(s.messaging_group_name ? esc(s.messaging_group_name)+' &nbsp;&middot;&nbsp; ' : '')
        +'<code style="font-size:11px">'+esc(s.id.slice(0,12))+'…</code>'
        +' &nbsp;<span class="badge '+(s.container_status==='running'?'bg':s.container_status==='idle'?'bb':'')+'">'+esc(s.container_status||'stopped')+'</span>'
        +' <span class="dim">&middot; '+fmtDate(s.last_active)+'</span>'
        +'</div>';
    }).join('');
    el.querySelectorAll('.sess-item').forEach(function(item) {
      item.addEventListener('click', function() {
        currentSession = item.dataset.sessId;
        el.querySelectorAll('.sess-item').forEach(function(i) { i.classList.toggle('active', i.dataset.sessId === currentSession); });
        loadSessionMessages(currentSession);
      });
    });
  }

  async function loadSessionMessages(sessionId) {
    if (!sessionId || currentTab !== 'messages') return;
    var el = document.getElementById('group-msgs');
    try {
      var data = await fetch('/api/messages?session='+encodeURIComponent(sessionId)+'&limit=150').then(function(r) { return r.json(); });
      if (!data.length) { el.innerHTML = '<div class="empty">No messages yet</div>'; return; }
      var atBottom = el.scrollHeight - el.scrollTop <= el.clientHeight + 60;
      el.innerHTML = data.map(function(m) {
        var cls = m.direction === 'outbound' ? 'outbound' : 'inbound';
        var dirLabel = m.direction === 'outbound' ? 'Agent' : (m.sender || 'User');
        return '<div class="msg '+cls+'"><div class="msg-meta">'+esc(dirLabel)+' &middot; '+fmtTime(m.timestamp)+'</div><div class="msg-body">'+esc(m.text)+'</div></div>';
      }).join('');
      if (atBottom) el.scrollTop = el.scrollHeight;
    } catch(e) {}
  }

  // ── Files tab ──────────────────────────────────────────────────────────────

  document.getElementById('file-maximize-btn').addEventListener('click', function() {
    var maximised = document.body.classList.toggle('file-maximized');
    this.innerHTML = maximised ? '&#x2715;' : '&#x26F6;';
    this.title = maximised ? 'Restore file view' : 'Maximise file view';
    if (maximised) history.pushState(null, '', location.href);
  });

  async function loadGroupFiles(autoFilePath) {
    if (!currentGroup) return;
    var tree = document.getElementById('group-file-tree');
    var view = document.getElementById('group-file-content');
    tree.innerHTML = '<div class="dim">Loading…</div>';
    view.innerHTML = '<div class="empty">Select a file to view its contents</div>';
    try {
      var data = await fetch('/api/files').then(function(r) { return r.json(); });
      var groupFiles = data.find(function(gf) { return gf.name === currentGroup.folder; });
      tree.innerHTML = '';
      if (!groupFiles || !groupFiles.entries.length) {
        tree.innerHTML = '<div class="empty">No files</div>';
        return;
      }
      renderFileTree(groupFiles.entries, tree);
      if (autoFilePath) {
        var fullPath = currentGroup.folder + '/' + autoFilePath;
        var fileName = autoFilePath.split('/').pop();
        tree.querySelectorAll('.ftree-children').forEach(function(el) { el.style.display = ''; });
        tree.querySelectorAll('.ftree-file').forEach(function(el) {
          if (el.dataset.path === fullPath) el.classList.add('active');
        });
        openFile(fullPath, fileName);
      }
    } catch(e) { tree.innerHTML = '<div class="empty">Error loading files</div>'; }
  }

  function renderFileTree(entries, container) {
    entries.forEach(function(entry) {
      if (entry.isDir) {
        var dirEl = document.createElement('div');
        dirEl.innerHTML = '<div class="ftree-dir" style="font-size:12px;font-weight:400">&#128193; '+esc(entry.name)+'</div>';
        var sub = document.createElement('div');
        sub.className = 'ftree-children';
        sub.style.display = 'none';
        dirEl.querySelector('.ftree-dir').addEventListener('click', function() {
          sub.style.display = sub.style.display === 'none' ? '' : 'none';
        });
        renderFileTree(entry.children, sub);
        dirEl.appendChild(sub);
        container.appendChild(dirEl);
      } else {
        var fileEl = document.createElement('div');
        fileEl.className = 'ftree-file';
        fileEl.textContent = entry.name;
        fileEl.dataset.path = entry.path;
        fileEl.addEventListener('click', function() {
          container.querySelectorAll('.ftree-file').forEach(function(f) { f.classList.remove('active'); });
          // Also search sibling trees
          document.getElementById('group-file-tree').querySelectorAll('.ftree-file').forEach(function(f) { f.classList.remove('active'); });
          fileEl.classList.add('active');
          var rel = fileEl.dataset.path;
          var name = rel.split('/').pop();
          // Push hash: strip group folder prefix
          var prefix = currentGroup ? currentGroup.folder + '/' : '';
          var relToGroup = rel.startsWith(prefix) ? rel.slice(prefix.length) : rel;
          if (currentGroup) pushHash('groups/'+currentGroup.folder+'/files/'+relToGroup);
          openFile(rel, name);
        });
        container.appendChild(fileEl);
      }
    });
  }

  // ── Frontmatter / markdown helpers (identical to v1) ───────────────────────

  function parseFrontMatter(text) {
    if (!text.startsWith('---')) return null;
    var nl = text.indexOf('\\n');
    var end = text.indexOf('\\n---', nl + 1);
    if (nl < 0 || end < 0) return null;
    var fm = text.slice(nl + 1, end);
    var meta = {};
    fm.split('\\n').forEach(function(line) {
      var c = line.indexOf(': ');
      if (c > 0) meta[line.slice(0, c).trim()] = line.slice(c + 2).trim();
    });
    return { meta: meta, body: text.slice(end + 4) };
  }

  function renderFrontMatter(meta, filePath) {
    var div = document.createElement('div');
    div.className = 'fm-card';
    var isNote = filePath && (filePath.indexOf('/memory/notes/MEM-') !== -1 || filePath.indexOf('/memory/notes/SYN-') !== -1);
    Object.entries(meta).forEach(function(kv) {
      var k = kv[0], v = kv[1];
      var kEl = document.createElement('div'); kEl.className = 'fm-key'; kEl.textContent = k; div.appendChild(kEl);
      var vEl = document.createElement('div'); vEl.className = 'fm-val';
      if (k === 'tags' || k === 'keywords' || k === 'links' || k === 'supersedes' || k === 'synthesises') {
        var items = v.replace(/^\\[|\\]$/g, '').split(',').map(function(s) { return s.trim(); }).filter(Boolean);
        if (isNote && (k === 'tags') && currentGroup) {
          items.forEach(function(tag) {
            var a = document.createElement('a');
            a.className = 'fm-tag';
            a.style.cursor = 'pointer';
            a.style.color = '#58a6ff';
            a.textContent = tag;
            a.addEventListener('click', function(e) {
              e.preventDefault();
              pendingGraphTag = tag;
              switchTab('notes');
            });
            vEl.appendChild(a);
          });
        } else if (isNote && k === 'links') {
          items.forEach(function(id) {
            var sp = document.createElement('span');
            sp.className = 'fm-tag';
            sp.style.cursor = 'pointer';
            sp.style.color = '#79c0ff';
            sp.textContent = id;
            sp.addEventListener('click', function() {
              pendingGraphSelect = id;
              switchTab('notes');
            });
            vEl.appendChild(sp);
          });
        } else {
          vEl.innerHTML = items.map(function(t) { return '<span class="fm-tag">'+esc(t)+'</span>'; }).join('');
        }
      } else {
        vEl.textContent = v;
      }
      div.appendChild(vEl);
    });
    return div;
  }

  var pendingGraphTag = null;

  async function openFile(filePath, name) {
    var view = document.getElementById('group-file-content');
    view.innerHTML = '<div class="dim">Loading…</div>';
    try {
      var r = await fetch('/api/file?path='+encodeURIComponent(filePath));
      if (!r.ok) { view.innerHTML = '<div class="empty">Could not read file</div>'; return; }
      var text = await r.text();
      var isNote = filePath.indexOf('/memory/notes/MEM-') !== -1 || filePath.indexOf('/memory/notes/SYN-') !== -1;
      var noteIdMatch = filePath.match(/((MEM|SYN)-[^/]+)\\.md$/);
      var graphBtnHash = (currentGroup && noteIdMatch ? '#groups/'+currentGroup.folder+'/notes/'+noteIdMatch[1] : currentGroup ? '#groups/'+currentGroup.folder+'/notes' : '#');
      var graphBtn = isNote ? ' <a href="'+graphBtnHash+'" class="graph-file-btn" data-path="'+esc(filePath)+'" style="color:#58a6ff;font-size:11px;margin-left:8px;text-decoration:none">&#x29BF; Show in Graph</a>' : '';
      var header = '<div class="dim" style="margin-bottom:12px">'+esc(filePath)+graphBtn+'</div>';
      var ext = name.split('.').pop();
      if (ext === 'md' && window.marked) {
        var fm = parseFrontMatter(text);
        var mdDiv = document.createElement('div');
        mdDiv.className = 'md-body';
        if (fm && Object.keys(fm.meta).length > 0) mdDiv.appendChild(renderFrontMatter(fm.meta, filePath));
        var parsedDiv = document.createElement('div');
        parsedDiv.innerHTML = window.marked.parse(fm ? fm.body : text);
        parsedDiv.querySelectorAll('a').forEach(function(a) {
          var href = a.getAttribute('href') || '';
          var isInternal = href.charAt(0) === '#' || (href.indexOf(location.origin) === 0 && href.indexOf('#groups/') !== -1);
          a.classList.add(isInternal ? 'link-internal' : 'link-external');
        });
        mdDiv.appendChild(parsedDiv);
        view.innerHTML = header;
        view.appendChild(mdDiv);
        if (window.hljs) mdDiv.querySelectorAll('pre code').forEach(function(el) { hljs.highlightElement(el); });
      } else if ((ext === 'json' || ext === 'ts' || ext === 'js' || ext === 'mjs') && window.hljs) {
        var lang = ext === 'json' ? 'json' : 'javascript';
        var codeEl = document.createElement('code');
        codeEl.textContent = text;
        codeEl.className = 'language-'+lang;
        hljs.highlightElement(codeEl);
        var pre = document.createElement('pre');
        pre.style.cssText = 'background:#0d1117;border:1px solid #30363d;border-radius:6px;padding:12px;font-size:12px;overflow-x:auto;margin:0;max-height:none';
        pre.appendChild(codeEl);
        view.innerHTML = header;
        view.appendChild(pre);
      } else if (ext === 'log') {
        view.innerHTML = header + '<pre style="font-size:11px;color:#8b949e;background:transparent;border:none;padding:0;margin:0;max-height:none">'+esc(text)+'</pre>';
      } else {
        view.innerHTML = header + '<pre style="font-size:13px;background:transparent;border:none;padding:0;margin:0;max-height:none">'+esc(text)+'</pre>';
      }
    } catch(e) { view.innerHTML = '<div class="empty">Error reading file</div>'; }
  }

  document.getElementById('group-file-content').addEventListener('click', function(e) {
    var btn = e.target.closest('.graph-file-btn');
    if (!btn) return;
    e.preventDefault();
    var filePath = btn.dataset.path;
    var match = filePath.match(/((?:MEM|SYN)-[^/]+)\\.md$/);
    if (!match || !currentGroup) return;
    pendingGraphSelect = match[1];
    switchTab('notes');
  });

  // ── Graph tab ──────────────────────────────────────────────────────────────

  var GRAPH_COLORS = ['#58a6ff','#3fb950','#d29922','#f85149','#bc8cff','#ff7b72','#79c0ff','#56d364','#e3b341','#db61a2'];
  var graphTagMap = {};
  var graphColorIdx = 0;
  var graphCy = null;
  var graphData = null;
  var graphActiveTag = null;
  var graphSim = null;

  function tagColor(tag) {
    if (!tag) return '#484f58';
    if (!graphTagMap[tag]) { graphTagMap[tag] = GRAPH_COLORS[graphColorIdx++ % GRAPH_COLORS.length]; }
    return graphTagMap[tag];
  }

  async function loadGroupGraph() {
    if (!currentGroup) return;
    graphTagMap = {}; graphColorIdx = 0; graphActiveTag = null;
    var status = document.getElementById('graph-status');
    var legend = document.getElementById('graph-legend');
    var panel = document.getElementById('graph-node-panel');
    status.textContent = 'Loading…';
    legend.innerHTML = '';
    panel.style.display = 'none';
    if (graphSim) { graphSim.stop(); graphSim = null; }
    if (graphCy) { graphCy.destroy(); graphCy = null; }
    document.getElementById('graph-container').innerHTML = '';
    try {
      var data = await fetch('/api/notes-graph?group='+encodeURIComponent(currentGroup.folder)).then(function(r){ return r.json(); });
      graphData = data;
      if (!data.nodes.length) { status.textContent = 'No notes found.'; return; }
      renderGraph(data.nodes, data.edges, null);
      applyGraphFilter();
      if (pendingGraphTag) {
        graphActiveTag = pendingGraphTag;
        pendingGraphTag = null;
        if (!graphTagMap[graphActiveTag]) {
          tagColor(graphActiveTag);
          var extraLegend = document.getElementById('graph-legend');
          var extraTag = graphActiveTag;
          var item = document.createElement('div');
          item.className = 'graph-legend-item active';
          item.dataset.tag = extraTag;
          item.innerHTML = '<div class="graph-legend-dot" style="background:'+graphTagMap[extraTag]+'"></div>'+esc(extraTag);
          item.addEventListener('click', function() {
            graphActiveTag = graphActiveTag === extraTag ? null : extraTag;
            document.querySelectorAll('.graph-legend-item').forEach(function(el) {
              el.classList.toggle('active', el.dataset.tag === graphActiveTag);
            });
            applyGraphFilter();
          });
          extraLegend.appendChild(item);
        }
        document.querySelectorAll('.graph-legend-item').forEach(function(el) {
          el.classList.toggle('active', el.dataset.tag === graphActiveTag);
        });
        applyGraphFilter();
      }
      if (pendingGraphSelect && graphCy) {
        var targetId = pendingGraphSelect;
        pendingGraphSelect = null;
        setTimeout(function() {
          var node = graphCy.getElementById(targetId);
          if (node.length) {
            node.select();
            node.emit('tap');
            graphCy.animate({ fit: { eles: node.union(node.neighborhood()), padding: 60 }, duration: 400 });
          }
        }, 900);
      }
    } catch(e) { status.textContent = 'Error loading graph.'; }
  }

  function renderGraph(nodes, edges, highlightIds) {
    if (graphCy) { graphCy.destroy(); graphCy = null; }
    if (graphSim) { graphSim.stop(); graphSim = null; }
    var container = document.getElementById('graph-container');
    var legend = document.getElementById('graph-legend');
    var status = document.getElementById('graph-status');
    container.innerHTML = '';

    // Build id→index map for d3 links
    var idMap = {};
    nodes.forEach(function(n, i) { idMap[n.id] = i; });

    // Count global tag frequency across all notes
    var tagFreq = {};
    nodes.forEach(function(n) {
      (n.tags || []).forEach(function(t) { tagFreq[t] = (tagFreq[t] || 0) + 1; });
    });

    // Register every tag so all appear in the legend and have a stable colour
    Object.keys(tagFreq).sort().forEach(function(t) { tagColor(t); });

    // Sort tags by global frequency descending; pick 2nd most common for colour
    // (most common tag dominates too many nodes — 2nd gives better spread)
    var tagsByFreq = Object.keys(tagFreq).sort(function(a, b) { return tagFreq[b] - tagFreq[a]; });
    var mostCommonTag = tagsByFreq[0] || null;

    function dominantTag(tags) {
      if (!tags || !tags.length) return null;
      // If node has a tag other than the single most common, prefer that
      var best = null, bestCount = -1;
      for (var i = 0; i < tags.length; i++) {
        var c = tagFreq[tags[i]] || 0;
        if (tags[i] !== mostCommonTag && c > bestCount) { best = tags[i]; bestCount = c; }
      }
      // Fall back to most common if it's the only tag
      return best || tags[0];
    }

    // d3 simulation nodes — seed with random positions
    var simNodes = nodes.map(function(n) {
      return { id: n.id, label: n.label, tags: n.tags, keywords: n.keywords, created: n.created, path: n.path, source_task_id: n.source_task_id||null, color: tagColor(dominantTag(n.tags)), isSynthesis: n.isSynthesis||false, x: Math.random() * 800 - 400, y: Math.random() * 600 - 300 };
    });
    var simLinks = [];
    edges.forEach(function(e) {
      if (idMap[e.source] !== undefined && idMap[e.target] !== undefined) {
        simLinks.push({ source: idMap[e.source], target: idMap[e.target] });
      }
    });

    // Find connected components via BFS.
    // Each non-main component is placed at its own position in a ring around
    // the main cluster so islands stay separate rather than merging into it.
    var adj = simNodes.map(function() { return []; });
    simLinks.forEach(function(l) { adj[l.source].push(l.target); adj[l.target].push(l.source); });
    var compOf = new Array(simNodes.length).fill(-1);
    var compSize = [];
    for (var si = 0; si < simNodes.length; si++) {
      if (compOf[si] !== -1) continue;
      var cid = compSize.length;
      var queue = [si]; compOf[si] = cid; var sz = 0;
      while (queue.length) {
        var cur = queue.shift(); sz++;
        adj[cur].forEach(function(nb) { if (compOf[nb] === -1) { compOf[nb] = cid; queue.push(nb); } });
      }
      compSize.push(sz);
    }
    var mainCompSize = compSize.length ? Math.max.apply(null, compSize) : 0;
    var mainCompId = compSize.indexOf(mainCompSize);
    // Assign a ring position (anchor) to each non-main component.
    var nonMainIds = compSize.map(function(_, i) { return i; }).filter(function(i) { return i !== mainCompId; });
    var ringRadius = 700;
    var compAnchor = {}; // compId -> {x, y}
    nonMainIds.forEach(function(id, idx) {
      var angle = (2 * Math.PI * idx) / Math.max(nonMainIds.length, 1);
      compAnchor[id] = { x: Math.cos(angle) * ringRadius, y: Math.sin(angle) * ringRadius };
    });
    // Seed non-main nodes near their anchor so they settle there from the start.
    simNodes.forEach(function(n, i) {
      var anchor = compAnchor[compOf[i]];
      if (anchor) { n.x = anchor.x + (Math.random() - 0.5) * 80; n.y = anchor.y + (Math.random() - 0.5) * 80; }
    });
    // forceX/Y targets: non-main nodes pulled to their anchor, main nodes gently to origin.
    function nodeTargetX(n, i) { var a = compAnchor[compOf[i]]; return a ? a.x : 0; }
    function nodeTargetY(n, i) { var a = compAnchor[compOf[i]]; return a ? a.y : 0; }
    function centerStrength(n, i) { return compAnchor[compOf[i]] ? 0.12 : 0.02; }

    // Build cytoscape elements with initial positions
    var elements = [];
    simNodes.forEach(function(n) {
      var faded = highlightIds && highlightIds.size > 0 && !highlightIds.has(n.id);
      elements.push({ group:'nodes', data:{ id:n.id, label:n.label, tags:n.tags, keywords:n.keywords, created:n.created, path:n.path, source_task_id:n.source_task_id, color:n.color, isSynthesis:n.isSynthesis||false }, classes: faded ? 'faded' : '', position:{ x:n.x, y:n.y } });
    });
    edges.forEach(function(e, i) {
      elements.push({ group:'edges', data:{ id:'e'+i, source:e.source, target:e.target, supersedes:e.supersedes||false, synthesises:e.synthesises||false } });
    });

    // Legend — clickable tag filters with frequency threshold + text filter
    var legendFooter = document.getElementById('graph-legend-footer');
    var legendMore = document.getElementById('graph-legend-more');
    var legendFilterEl = document.getElementById('graph-legend-filter');
    var FREQ_MIN = 2;
    var allLegendTags = Object.keys(graphTagMap).sort();
    var freqTags = allLegendTags.filter(function(t) { return (tagFreq[t]||0) >= FREQ_MIN; });
    var rareTags = allLegendTags.filter(function(t) { return (tagFreq[t]||0) < FREQ_MIN; });
    var legendShowAll = false;

    function buildLegendItems() {
      legend.innerHTML = '';
      var q = legendFilterEl.value.trim().toLowerCase();
      var pool = (legendShowAll || q) ? allLegendTags : freqTags;
      pool.forEach(function(tag) {
        if (q && tag.toLowerCase().indexOf(q) === -1) return;
        var item = document.createElement('div');
        item.className = 'graph-legend-item' + (graphActiveTag === tag ? ' active' : '');
        item.dataset.tag = tag;
        item.innerHTML = '<div class="graph-legend-dot" style="background:'+graphTagMap[tag]+'"></div>'+esc(tag);
        item.addEventListener('click', function() {
          graphActiveTag = graphActiveTag === tag ? null : tag;
          document.querySelectorAll('.graph-legend-item').forEach(function(el) {
            el.classList.toggle('active', el.dataset.tag === graphActiveTag);
          });
          applyGraphFilter();
        });
        legend.appendChild(item);
      });
      if (rareTags.length > 0) {
        legendFooter.style.display = 'flex';
        legendMore.textContent = legendShowAll ? 'show fewer' : rareTags.length + ' more…';
      } else {
        legendFooter.style.display = 'none';
      }
    }

    legendMore.onclick = function() { legendShowAll = !legendShowAll; buildLegendItems(); };
    legendFilterEl.value = '';
    legendFilterEl.oninput = function() { buildLegendItems(); };
    buildLegendItems();

    // Create cytoscape with preset layout (positions set by d3)
    graphCy = cytoscape({
      container: container,
      elements: elements,
      style: [
        { selector:'node', style:{ shape:'ellipse', width:18, height:18, 'background-color':'data(color)', 'border-width':1, 'border-color':'rgba(255,255,255,0.15)', 'text-opacity':0, label:'data(label)', color:'#e6edf3', 'font-size':11, 'text-valign':'bottom', 'text-halign':'center', 'text-margin-y':4, 'text-wrap':'wrap', 'text-max-width':120 } },
        { selector:'node[?isSynthesis]', style:{ shape:'diamond', width:22, height:22, 'border-color':'rgba(188,140,255,0.5)', 'border-width':1.5 } },
        { selector:'node.faded', style:{ opacity:0.25 } },
        { selector:'node.hovered', style:{ 'text-opacity':1, width:22, height:22, 'border-color':'#8b949e', 'border-width':2, opacity:1 } },
        { selector:'node[?isSynthesis].hovered', style:{ width:26, height:26 } },
        { selector:'node:selected', style:{ 'text-opacity':1, 'border-width':2, 'border-color':'#f0f6fc', width:24, height:24 } },
        { selector:'node[?isSynthesis]:selected', style:{ width:28, height:28 } },
        { selector:'node.dimmed', style:{ opacity:0.12 } },
        { selector:'node.dimmed.hovered', style:{ opacity:1, 'text-opacity':1 } },
        { selector:'node.neighbor', style:{ 'text-opacity':1, 'border-width':2, 'border-color':'#58a6ff', width:22, height:22 } },
        { selector:'edge', style:{ width:1, 'line-color':'#6e7681', 'curve-style':'bezier', opacity:0.6 } },
        { selector:'edge[?supersedes]', style:{ 'line-color':'#d29922', 'line-style':'dashed', 'line-dash-pattern':[6,3], opacity:0.7, 'target-arrow-shape':'triangle', 'target-arrow-color':'#d29922', 'arrow-scale':1.2 } },
        { selector:'edge[?synthesises]', style:{ 'line-color':'#bc8cff', 'line-style':'dashed', 'line-dash-pattern':[3,4], opacity:0.65, 'target-arrow-shape':'triangle', 'target-arrow-color':'#bc8cff', 'arrow-scale':1.0 } },
        { selector:'edge.dimmed', style:{ opacity:0.06 } },
        { selector:'edge.highlighted', style:{ width:2, 'line-color':'#58a6ff', opacity:0.8 } },
        { selector:'node.hover-neighbor', style:{ 'text-opacity':1, 'border-color':'rgba(88,166,255,0.5)', 'border-width':2, opacity:1 } },
        { selector:'edge.hover-highlighted', style:{ width:1.5, 'line-color':'rgba(88,166,255,0.5)', opacity:0.6 } },
        { selector:'node.filter-match', style:{ 'text-opacity':1, width:26, height:26, 'border-width':2, 'border-color':'#f0f6fc' } },
      ],
      maxZoom: 1.5,
      minZoom: 0.1,
      layout: { name: 'preset' },
    });
    graphCy.resize();

    // ── d3-force simulation ──
    graphSim = d3.forceSimulation(simNodes)
      .alphaDecay(0.005)         // very slow cooling — long settling time
      .velocityDecay(0.3)        // friction: 0=none, 1=max (0.3 = smooth glide)
      .force('link', d3.forceLink(simLinks).distance(120).strength(0.15))
      .force('charge', d3.forceManyBody().strength(-200))
      .force('center', d3.forceCenter(0, 0).strength(0.05))
      .force('collide', d3.forceCollide(14))
      .force('x', d3.forceX(nodeTargetX).strength(centerStrength))
      .force('y', d3.forceY(nodeTargetY).strength(centerStrength))
      .on('tick', function() {
        // Push d3 positions into cytoscape
        simNodes.forEach(function(sn) {
          var cyNode = graphCy.getElementById(sn.id);
          if (cyNode.length && !cyNode.grabbed()) {
            cyNode.position({ x: sn.x, y: sn.y });
          }
        });
      });

    // One-shot fit after initial spread
    setTimeout(function() { if (graphCy) graphCy.fit(undefined, 30); }, 800);

    // Drag: lock node in d3 while dragging, reheat simulation
    graphCy.on('grab', 'node', function(evt) {
      var sn = simNodes[idMap[evt.target.id()]];
      if (sn) { sn.fx = sn.x; sn.fy = sn.y; }
      graphSim.alphaTarget(0.3).restart();
    });
    graphCy.on('drag', 'node', function(evt) {
      var pos = evt.target.position();
      var sn = simNodes[idMap[evt.target.id()]];
      if (sn) { sn.fx = pos.x; sn.fy = pos.y; }
    });
    graphCy.on('free', 'node', function(evt) {
      var sn = simNodes[idMap[evt.target.id()]];
      if (sn) { sn.fx = null; sn.fy = null; }
      graphSim.alphaTarget(0);
    });

    status.textContent = nodes.length + ' notes, ' + edges.length + ' links';

    function highlightSubgraph(node) {
      // Clear previous highlights
      graphCy.elements().removeClass('dimmed neighbor highlighted');
      document.querySelectorAll('.graph-legend-item').forEach(function(el) {
        el.classList.remove('node-highlighted');
      });
      // Get connected edges and neighbour nodes
      var connEdges = node.connectedEdges();
      var neighbors = node.neighborhood().nodes();
      // Dim everything
      graphCy.elements().addClass('dimmed');
      // Un-dim the selected node, its neighbours, and connecting edges
      node.removeClass('dimmed');
      neighbors.removeClass('dimmed').addClass('neighbor');
      connEdges.removeClass('dimmed').addClass('highlighted');
      // Highlight the selected node's tags in the legend
      var nodeTags = node.data('tags') || [];
      nodeTags.forEach(function(tag) {
        document.querySelectorAll('.graph-legend-item').forEach(function(el) {
          if (el.dataset.tag === tag) el.classList.add('node-highlighted');
        });
      });
    }

    function clearHighlight() {
      graphCy.elements().removeClass('dimmed neighbor highlighted');
      document.querySelectorAll('.graph-legend-item').forEach(function(el) {
        el.classList.remove('node-highlighted');
      });
    }

    graphCy.on('select', 'node', function(evt) {
      highlightSubgraph(evt.target);
    });
    graphCy.on('unselect', 'node', function() {
      clearHighlight();
    });

    graphCy.on('tap', 'node', function(evt) {
      var d = evt.target.data();
      if (currentGroup) pushHash('groups/' + currentGroup.folder + '/notes/' + d.id);
      var panel = document.getElementById('graph-node-panel');
      var tagsHtml = (d.tags||[]).map(function(t){ return '<span class="fm-tag" style="background:'+tagColor(t)+';color:#0d1117;border-color:transparent">'+esc(t)+'</span>'; }).join(' ');
      var kwHtml = (d.keywords||[]).map(function(k){ return '<span class="fm-tag">'+esc(k)+'</span>'; }).join(' ');
      var fileRel = (d.path && currentGroup && d.path.startsWith(currentGroup.folder+'/')) ? d.path.slice(currentGroup.folder.length+1) : d.path;
      var fileHash = (fileRel && currentGroup) ? '#groups/'+currentGroup.folder+'/files/'+fileRel : '#';
      var titleEl = document.getElementById('graph-node-id');
      var synthBadge = d.isSynthesis ? ' <span style="font-size:10px;background:#21262d;border:1px solid #bc8cff;border-radius:8px;padding:1px 6px;color:#bc8cff;vertical-align:middle">synthesis</span>' : '';
      titleEl.innerHTML = '<a href="'+fileHash+'" id="graph-open-link" style="color:inherit;text-decoration:none">'+esc(d.id)+'</a>'+synthBadge;
      document.getElementById('graph-node-meta').innerHTML =
        '<div class="fm-key">Created</div><div class="fm-val">'+esc(d.created)+'</div>'
        +(tagsHtml ? '<div class="fm-key">Tags</div><div class="fm-val">'+tagsHtml+'</div>' : '')
        +(kwHtml   ? '<div class="fm-key">Keywords</div><div class="fm-val">'+kwHtml+'</div>' : '')
        +(d.source_task_id
          ? '<div class="fm-key">Research Task</div><div class="fm-val"><a href="#" id="graph-task-link" data-task-id="'+esc(d.source_task_id)+'" style="color:#58a6ff;font-family:monospace;font-size:10px">'+esc(d.source_task_id.slice(0,8))+'… →</a></div>'
          : '');
      panel.style.display = 'block';
      document.getElementById('graph-open-link').onclick = function(e) {
        e.preventDefault();
        if (fileRel) switchTab('files', fileRel);
      };
    });

    graphCy.on('mouseover', 'node', function(evt) {
      evt.target.addClass('hovered');
      evt.target.connectedEdges().addClass('hover-highlighted');
      evt.target.neighborhood().nodes().addClass('hover-neighbor');
      var nodeTags = evt.target.data('tags') || [];
      nodeTags.forEach(function(tag) {
        document.querySelectorAll('.graph-legend-item').forEach(function(el) {
          if (el.dataset.tag === tag) el.classList.add('node-highlighted');
        });
      });
    });
    graphCy.on('mouseout', 'node', function(evt) {
      evt.target.removeClass('hovered');
      evt.target.connectedEdges().removeClass('hover-highlighted');
      evt.target.neighborhood().nodes().removeClass('hover-neighbor');
      // Only clear node-highlighted if no node is currently selected
      if (graphCy.$('node:selected').length === 0) {
        document.querySelectorAll('.graph-legend-item').forEach(function(el) {
          el.classList.remove('node-highlighted');
        });
      }
    });

    graphCy.on('tap', function(evt) {
      if (evt.target === graphCy) {
        clearHighlight();
        document.getElementById('graph-node-panel').style.display = 'none';
      }
    });
  }

  function applyGraphFilter() {
    if (!graphCy || !graphData) return;
    var q = (document.getElementById('graph-search').value || '').trim().toLowerCase();
    var hits = new Set();
    var hasFilter = !!(q || graphActiveTag);
    if (hasFilter) {
      graphData.nodes.forEach(function(n) {
        var textMatch = !q || [n.id, n.label].concat(n.tags||[]).concat(n.keywords||[]).some(function(t){ return t && t.toLowerCase().indexOf(q)!==-1; });
        var tagMatch = !graphActiveTag || (n.tags||[]).indexOf(graphActiveTag) !== -1;
        if (textMatch && tagMatch) hits.add(n.id);
      });
    }
    graphCy.nodes().forEach(function(node) {
      var faded = hasFilter && !hits.has(node.id());
      if (faded) {
        node.addClass('faded');
        node.removeClass('filter-match');
      } else {
        node.removeClass('faded');
        if (hasFilter) node.addClass('filter-match'); else node.removeClass('filter-match');
      }
    });
    var statusEl = document.getElementById('graph-status');
    if (statusEl) {
      if (!hasFilter) statusEl.textContent = graphData.nodes.length + ' notes, ' + graphData.edges.length + ' links';
      else if (hits.size === 0) statusEl.textContent = 'No matches';
      else statusEl.textContent = hits.size + ' / ' + graphData.nodes.length;
    }
    // Fit viewport to matching nodes so they're always visible, even if they
    // ended up in a distant island.
    if (hasFilter && hits.size > 0) {
      var matchEles = graphCy.nodes('.filter-match');
      if (matchEles.length) graphCy.animate({ fit: { eles: matchEles, padding: 80 }, duration: 300 });
    }
  }

  var graphFilterTimer = null;
  document.getElementById('graph-search').addEventListener('input', function() {
    if (!graphData) return;
    if (graphFilterTimer) clearTimeout(graphFilterTimer);
    graphFilterTimer = setTimeout(function() { graphFilterTimer = null; applyGraphFilter(); }, 150);
  });

  // ── Overview ────────────────────────────────────────────────────────────────

  var overviewTimer = null;

  function stopOverview() {
    if (overviewTimer) { clearInterval(overviewTimer); overviewTimer = null; }
  }

  function startOverview() { loadOverview(); overviewTimer = setInterval(loadOverview, 5000); }

  async function loadOverview() {
    var statsEl = document.getElementById('overview-stats');
    var sessionsEl = document.getElementById('overview-sessions');
    var orphansEl = document.getElementById('overview-orphans');
    var orphansLabelEl = document.getElementById('overview-orphans-label');
    var statusEl = document.getElementById('overview-refresh-status');
    try {
      var data = await fetch('/api/status').then(function(r) { return r.json(); });
      statusEl.textContent = 'Updated '+fmtTime(new Date().toISOString());

      statsEl.innerHTML = [
        { label: 'Uptime', value: data.uptimeStr, color: '#3fb950' },
        { label: 'Agent Groups', value: data.agentGroups, color: '#f0f6fc' },
        { label: 'Active Sessions', value: data.sessions.active, color: data.sessions.active > 0 ? '#58a6ff' : '#8b949e' },
        { label: 'Running', value: data.sessions.running, color: data.sessions.running > 0 ? '#3fb950' : '#8b949e' },
        { label: 'Orphans', value: data.orphans, color: data.orphans > 0 ? '#f85149' : '#8b949e' },
      ].map(function(s) {
        return '<div class="card" style="padding:14px 16px;text-align:center">'
          +'<div style="font-size:24px;font-weight:700;color:'+s.color+';margin-bottom:4px;line-height:1">'+esc(String(s.value))+'</div>'
          +'<div class="dim" style="font-size:10px;text-transform:uppercase;letter-spacing:.6px;margin-top:2px">'+esc(s.label)+'</div>'
          +'</div>';
      }).join('');

      var runningSessions = data.runningSessions || [];
      if (!runningSessions.length) {
        sessionsEl.innerHTML = '<div class="empty" style="padding:16px">No running sessions</div>';
      } else {
        sessionsEl.innerHTML = '<table><thead><tr><th>Agent Group</th><th>Messaging Group</th><th>Container</th><th>State</th><th>Last Active</th></tr></thead><tbody>'
          + runningSessions.map(function(s) {
            var cs = s.container_status;
            var scls = cs==='running'?'bg':cs==='idle'?'bb':'';
            return '<tr>'
              +'<td style="font-size:12px">'+esc(s.agent_group_name||s.agent_group_id)+'</td>'
              +'<td class="dim" style="font-size:11px">'+esc(s.messaging_group_name||'—')+'</td>'
              +'<td class="dim" style="font-size:11px">'+esc(s.id.slice(0,12))+'…</td>'
              +'<td><span class="badge '+scls+'">'+esc(cs||'stopped')+'</span></td>'
              +'<td class="dim" style="font-size:11px">'+fmtDate(s.last_active)+'</td>'
              +'</tr>';
          }).join('')
          +'</tbody></table>';
      }

      var orphans = data.orphanContainers || [];
      if (orphansLabelEl) orphansLabelEl.style.color = orphans.length > 0 ? '#f85149' : '#8b949e';
      if (!orphans.length) {
        orphansEl.innerHTML = '<div class="empty" style="padding:16px">None</div>';
      } else {
        orphansEl.innerHTML = '<table><thead><tr><th>Name</th><th>Running For</th></tr></thead><tbody>'
          + orphans.map(function(c) {
            var s = Math.floor(c.ageMs/1000);
            var age = s < 60 ? s+'s' : s < 3600 ? Math.floor(s/60)+'m '+s%60+'s' : Math.floor(s/3600)+'h '+Math.floor(s%3600/60)+'m';
            return '<tr><td style="font-family:monospace;font-size:11px">'+esc(c.name)+'</td><td class="dim" style="font-size:12px">'+esc(age)+'</td></tr>';
          }).join('')
          +'</tbody></table>';
      }
    } catch(e) {}
  }

  // ── System ────────────────────────────────────────────────────────────────

  async function loadSystem() {
    var sel = document.getElementById('sessions-body');
    var mgel = document.getElementById('messaging-groups-body');
    sel.innerHTML = 'Loading…';
    mgel.innerHTML = 'Loading…';
    try {
      var data = await fetch('/api/system').then(function(r) { return r.json(); });
      var sessions = data.sessions || [];
      if (!sessions.length) { sel.innerHTML = '<div class="empty">No sessions</div>'; }
      else {
        sel.innerHTML = '<div class="card"><table><thead><tr><th>Agent Group</th><th>Messaging Group</th><th>Thread</th><th>Status</th><th>Container</th><th>Last Active</th></tr></thead><tbody>'
          + sessions.map(function(s) {
            var cs = s.container_status;
            var scls = cs==='running'?'bg':cs==='idle'?'bb':'';
            return '<tr>'
              +'<td style="font-size:12px;cursor:pointer;color:#58a6ff" data-group-folder="'+esc(s.agent_group_folder)+'">'+esc(s.agent_group_name||s.agent_group_id)+'</td>'
              +'<td class="dim" style="font-size:11px">'+esc(s.messaging_group_name||'—')+'</td>'
              +'<td class="dim" style="font-family:monospace;font-size:10px">'+esc(s.thread_id||'—')+'</td>'
              +'<td><span class="badge '+scls+'">'+esc(cs||'stopped')+'</span></td>'
              +'<td class="dim" style="font-family:monospace;font-size:10px">'+esc(s.id.slice(0,12))+'…</td>'
              +'<td class="dim" style="font-size:11px">'+fmtDate(s.last_active)+'</td>'
              +'</tr>';
          }).join('')
          +'</tbody></table></div>';
        sel.querySelectorAll('[data-group-folder]').forEach(function(td) {
          td.addEventListener('click', function() {
            var folder = td.dataset.groupFolder;
            var g = { folder: folder, name: td.textContent };
            show('groups');
            // navigate to group
            setTimeout(function() {
              openGroup(g);
            }, 50);
          });
        });
      }

      var mgroups = data.messagingGroups || [];
      if (!mgroups.length) { mgel.innerHTML = '<div class="empty">No messaging groups</div>'; }
      else {
        mgel.innerHTML = '<div class="card"><table><thead><tr><th>Name</th><th>Channel</th><th>Platform ID</th><th>Wired Agent Groups</th></tr></thead><tbody>'
          + mgroups.map(function(mg) {
            return '<tr>'
              +'<td style="font-size:12px">'+esc(mg.name||mg.platform_id)+'</td>'
              +'<td><span class="badge bb">'+esc(mg.channel_type)+'</span></td>'
              +'<td class="dim" style="font-family:monospace;font-size:11px">'+esc(mg.platform_id)+'</td>'
              +'<td class="dim" style="font-size:11px">'+esc((mg.agent_groups||[]).join(', ')||'—')+'</td>'
              +'</tr>';
          }).join('')
          +'</tbody></table></div>';
      }
    } catch(e) { sel.innerHTML = '<div class="empty">Error loading system data</div>'; }
  }

  // ── Database Explorer ──────────────────────────────────────────────────────

  var dbCurrentTable = null;
  var dbCurrentPage = 0;
  var dbCurrentSearch = '';
  var dbPageSize = 50;
  var dbTotalRows = 0;
  var pendingDbTable = null;
  var pendingDbPage = 0;
  var pendingDbSearch = '';

  async function loadDbTables() {
    var listEl = document.getElementById('db-table-list');
    listEl.innerHTML = '<div class="dim" style="font-size:11px;padding:4px 6px;margin-bottom:4px;font-weight:600;letter-spacing:.4px;text-transform:uppercase">Tables</div>';
    try {
      var tables = await fetch('/api/db/tables').then(function(r) { return r.json(); });
      tables.forEach(function(t) {
        var item = document.createElement('div');
        item.className = 'db-table-item' + (t.name === dbCurrentTable ? ' active' : '');
        item.innerHTML = '<span>'+esc(t.name)+'</span><span class="dim">'+t.count+'</span>';
        item.addEventListener('click', function() {
          listEl.querySelectorAll('.db-table-item').forEach(function(i) { i.classList.remove('active'); });
          item.classList.add('active');
          dbCurrentTable = t.name;
          dbCurrentPage = 0; dbCurrentSearch = '';
          var si = document.getElementById('db-search');
          if (si) si.value = '';
          pushHash('database/'+encodeURIComponent(t.name));
          loadDbTable();
        });
        listEl.appendChild(item);
      });
      if (pendingDbTable) {
        var target = pendingDbTable; pendingDbTable = null;
        dbCurrentPage = pendingDbPage; pendingDbPage = 0;
        dbCurrentSearch = pendingDbSearch; pendingDbSearch = '';
        var matchItem = Array.from(listEl.querySelectorAll('.db-table-item')).find(function(el) { return el.querySelector('span').textContent === target; });
        if (matchItem) matchItem.click();
      }
    } catch(e) {}
  }

  async function loadDbTable() {
    if (!dbCurrentTable) return;
    var bodyEl = document.getElementById('db-table-body');
    var headerEl = document.getElementById('db-table-header');
    var paginEl = document.getElementById('db-pagination');
    var nameEl = document.getElementById('db-table-name');
    var countEl = document.getElementById('db-table-count');
    headerEl.style.display = '';
    nameEl.textContent = dbCurrentTable;
    bodyEl.innerHTML = 'Loading…';
    try {
      var url = '/api/db/table?name='+encodeURIComponent(dbCurrentTable)+'&limit='+dbPageSize+'&offset='+(dbCurrentPage*dbPageSize)+(dbCurrentSearch?'&search='+encodeURIComponent(dbCurrentSearch):'');
      var data = await fetch(url).then(function(r) { return r.json(); });
      dbTotalRows = data.total;
      countEl.textContent = dbTotalRows + ' rows' + (dbCurrentSearch ? ' (filtered)' : '');
      if (!data.rows.length) { bodyEl.innerHTML = '<div class="empty">No rows</div>'; paginEl.style.display = 'none'; return; }
      var cols = data.columns;
      bodyEl.innerHTML = '<div class="card" style="padding:0;overflow:auto"><table><thead><tr>'+cols.map(function(c){ return '<th>'+esc(c)+'</th>'; }).join('')+'</tr></thead><tbody>'
        + data.rows.map(function(row) {
          return '<tr>'+cols.map(function(c) {
            var v = row[c];
            if (v === null || v === undefined) return '<td><span class="db-null">null</span></td>';
            var s = String(v);
            if (s.length > 200) s = s.slice(0,200)+'…';
            return '<td style="max-width:300px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap" title="'+esc(String(row[c]))+'">'+esc(s)+'</td>';
          }).join('')+'</tr>';
        }).join('')
        +'</tbody></table></div>';
      var totalPages = Math.ceil(dbTotalRows / dbPageSize);
      if (totalPages > 1) {
        paginEl.style.display = 'flex';
        document.getElementById('db-page-info').textContent = 'Page '+(dbCurrentPage+1)+' of '+totalPages;
        document.getElementById('db-prev').disabled = dbCurrentPage === 0;
        document.getElementById('db-next').disabled = dbCurrentPage >= totalPages - 1;
      } else {
        paginEl.style.display = 'none';
      }
    } catch(e) { bodyEl.innerHTML = '<div class="empty">Error loading table</div>'; }
  }

  document.getElementById('db-prev').addEventListener('click', function() { if (dbCurrentPage > 0) { dbCurrentPage--; loadDbTable(); } });
  document.getElementById('db-next').addEventListener('click', function() { dbCurrentPage++; loadDbTable(); });

  var dbSearchTimer = null;
  document.getElementById('db-search').addEventListener('input', function() {
    if (dbSearchTimer) clearTimeout(dbSearchTimer);
    var val = this.value;
    dbSearchTimer = setTimeout(function() {
      dbCurrentSearch = val;
      dbCurrentPage = 0;
      if (dbCurrentTable) {
        pushHash('database/'+encodeURIComponent(dbCurrentTable)+(dbCurrentSearch?'?search='+encodeURIComponent(dbCurrentSearch):''));
        loadDbTable();
      }
    }, 300);
  });

  // ── Init ───────────────────────────────────────────────────────────────────

  restoreFromHash();
  if (location.hash === '' || location.hash === '#') show('groups');
});
</script>
</body>
</html>`;

// ---------------------------------------------------------------------------
// File tree helpers (identical logic to v1)
// ---------------------------------------------------------------------------

type FileEntry = {
  name: string;
  path: string;
  isDir: boolean;
  children?: FileEntry[];
};

function readDirEntries(dir: string, relBase: string): FileEntry[] {
  let names: string[];
  try {
    names = fs.readdirSync(dir).sort();
  } catch {
    return [];
  }
  const files: FileEntry[] = [];
  const dirs: FileEntry[] = [];
  for (const name of names) {
    // skip hidden files/dirs except .claude-shared
    if (name.startsWith('.') && name !== '.claude-shared') continue;
    const abs = path.join(dir, name);
    const rel = path.join(relBase, name);
    let stat: fs.Stats;
    try {
      stat = fs.statSync(abs);
    } catch {
      continue;
    }
    if (stat.isDirectory()) {
      dirs.push({ name, path: rel, isDir: true, children: readDirEntries(abs, rel) });
    } else {
      files.push({ name, path: rel, isDir: false });
    }
  }
  return [...files, ...dirs];
}

function listGroupFiles(): Array<{ name: string; entries: FileEntry[] }> {
  let groups: string[];
  try {
    groups = fs.readdirSync(GROUPS_DIR).sort();
  } catch {
    return [];
  }
  return groups
    .filter((g) => {
      try {
        return fs.statSync(path.join(GROUPS_DIR, g)).isDirectory();
      } catch {
        return false;
      }
    })
    .map((g) => ({ name: g, entries: readDirEntries(path.join(GROUPS_DIR, g), g) }));
}

function safeReadFile(relPath: string): string | null {
  const abs = path.resolve(GROUPS_DIR, relPath);
  if (!abs.startsWith(path.resolve(GROUPS_DIR) + path.sep)) return null;
  try {
    return fs.readFileSync(abs, 'utf-8');
  } catch {
    return null;
  }
}

// ---------------------------------------------------------------------------
// Note frontmatter parser (identical logic to v1)
// ---------------------------------------------------------------------------

function parseNoteFrontmatter(text: string): {
  id: string;
  created: string;
  keywords: string[];
  tags: string[];
  links: string[];
  supersedes: string[];
  superseded_by: string[];
  synthesises: string[];
  source_report_path: string | null;
} | null {
  if (!text.startsWith('---')) return null;
  const nl = text.indexOf('\n');
  const end = text.indexOf('\n---', nl + 1);
  if (nl < 0 || end < 0) return null;
  const fmText = text.slice(nl + 1, end);
  const fields: Record<string, string> = {};
  for (const line of fmText.split('\n')) {
    const c = line.indexOf(': ');
    if (c > 0) fields[line.slice(0, c).trim()] = line.slice(c + 2).trim();
  }
  const parseList = (raw: string | undefined): string[] => {
    if (!raw) return [];
    const m = raw.match(/^\[(.+)\]$/);
    if (m)
      return m[1]
        .split(',')
        .map((s) => s.trim())
        .filter(Boolean);
    return [raw.trim()].filter(Boolean);
  };
  if (!fields['id']) return null;
  let source_report_path: string | null = null;
  for (const line of fmText.split('\n')) {
    const m = line.match(/^\s+path:\s+(.+)$/);
    if (m) {
      const p = m[1].trim();
      if (p.startsWith('memory/reports/')) {
        source_report_path = p;
        break;
      }
    }
  }
  return {
    id: fields['id'],
    created: fields['created'] ?? '',
    keywords: parseList(fields['keywords']),
    tags: parseList(fields['tags']),
    links: parseList(fields['links']),
    supersedes: parseList(fields['supersedes']),
    superseded_by: parseList(fields['superseded_by']),
    synthesises: parseList(fields['synthesises']),
    source_report_path,
  };
}

// ---------------------------------------------------------------------------
// Org ID index (for file viewer link resolution)
// ---------------------------------------------------------------------------

let orgIdIndexCache: { ts: number; data: Record<string, string> } | null = null;

function buildOrgIdIndex(): Record<string, string> {
  const result: Record<string, string> = {};
  // scan all org files under groups/
  function scanDir(dir: string, groupFolder: string) {
    let names: string[];
    try {
      names = fs.readdirSync(dir);
    } catch {
      return;
    }
    for (const name of names) {
      const abs = path.join(dir, name);
      try {
        const stat = fs.statSync(abs);
        if (stat.isDirectory()) {
          scanDir(abs, groupFolder);
          continue;
        }
        if (!name.endsWith('.org')) continue;
        const text = fs.readFileSync(abs, 'utf-8');
        const rel = path.relative(path.join(GROUPS_DIR, groupFolder), abs);
        let inProps = false;
        for (const line of text.split('\n')) {
          const t = line.trim();
          if (t === ':PROPERTIES:') {
            inProps = true;
            continue;
          }
          if (t === ':END:') {
            inProps = false;
            continue;
          }
          if (inProps) {
            const m = t.match(/^:ID:\s+(.+)$/);
            if (m) result[m[1].trim()] = `#groups/${groupFolder}/files/${rel}`;
          }
        }
      } catch {
        /* skip */
      }
    }
  }
  try {
    for (const g of fs.readdirSync(GROUPS_DIR)) {
      if (fs.statSync(path.join(GROUPS_DIR, g)).isDirectory()) scanDir(path.join(GROUPS_DIR, g), g);
    }
  } catch {
    /* skip */
  }
  return result;
}

function getOrgIdIndex(): Record<string, string> {
  const now = Date.now();
  if (orgIdIndexCache && now - orgIdIndexCache.ts < 60_000) return orgIdIndexCache.data;
  const data = buildOrgIdIndex();
  orgIdIndexCache = { ts: now, data };
  return data;
}

// ---------------------------------------------------------------------------
// DB browser helpers
// ---------------------------------------------------------------------------

function getDbTables(): Array<{ name: string; count: number }> {
  const db = getDb();
  const tables = db
    .prepare(`SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%' ORDER BY name`)
    .all() as Array<{ name: string }>;
  return tables.map((t) => {
    try {
      const row = db.prepare(`SELECT COUNT(*) AS n FROM "${t.name}"`).get() as { n: number };
      return { name: t.name, count: row.n };
    } catch {
      return { name: t.name, count: 0 };
    }
  });
}

function getDbTableData(
  tableName: string,
  limit: number,
  offset: number,
  search?: string,
): { columns: string[]; rows: Record<string, unknown>[]; total: number } {
  const db = getDb();
  // validate table name exists
  const exists = db.prepare(`SELECT 1 FROM sqlite_master WHERE type='table' AND name=?`).get(tableName);
  if (!exists) return { columns: [], rows: [], total: 0 };

  const cols = (db.prepare(`PRAGMA table_info("${tableName}")`).all() as Array<{ name: string }>).map((c) => c.name);
  if (!cols.length) return { columns: [], rows: [], total: 0 };

  let where = '';
  const params: unknown[] = [];
  if (search) {
    const conds = cols.map((c) => `CAST("${c}" AS TEXT) LIKE ?`);
    where = ' WHERE ' + conds.join(' OR ');
    const like = `%${search}%`;
    params.push(...cols.map(() => like));
  }

  const total = (db.prepare(`SELECT COUNT(*) AS n FROM "${tableName}"${where}`).get(...params) as { n: number }).n;
  const rows = db
    .prepare(`SELECT * FROM "${tableName}"${where} LIMIT ? OFFSET ?`)
    .all(...params, limit, offset) as Record<string, unknown>[];

  return { columns: cols, rows, total };
}

// ---------------------------------------------------------------------------
// Message reading from session DBs
// ---------------------------------------------------------------------------

type SessionMessage = {
  id: string;
  timestamp: string;
  direction: 'inbound' | 'outbound';
  kind: string;
  text: string;
  sender?: string | null;
};

function parseContentText(contentJson: string, kind: string): string {
  try {
    const obj = JSON.parse(contentJson);
    if (typeof obj === 'string') return obj;
    if (typeof obj.text === 'string') return obj.text;
    if (Array.isArray(obj)) {
      // Anthropic content block array
      return obj
        .map((b: Record<string, unknown>) => (typeof b.text === 'string' ? b.text : ''))
        .filter(Boolean)
        .join('\n');
    }
    if (kind === 'text' || kind === 'message') return JSON.stringify(obj);
    return JSON.stringify(obj);
  } catch {
    return contentJson;
  }
}

function readSessionMessages(agentGroupId: string, sessionId: string, limit: number): SessionMessage[] {
  const messages: SessionMessage[] = [];

  const iPath = inboundDbPath(agentGroupId, sessionId);
  if (fs.existsSync(iPath)) {
    let db: Database.Database | null = null;
    try {
      db = new Database(iPath, { readonly: true });
      db.pragma('busy_timeout = 3000');
      const rows = db
        .prepare(`SELECT id, timestamp, kind, content, platform_id FROM messages_in ORDER BY seq ASC LIMIT ?`)
        .all(limit) as Array<{
        id: string;
        timestamp: string;
        kind: string;
        content: string;
        platform_id: string | null;
      }>;
      for (const r of rows) {
        messages.push({
          id: r.id,
          timestamp: r.timestamp,
          direction: 'inbound',
          kind: r.kind,
          text: parseContentText(r.content, r.kind),
          sender: r.platform_id,
        });
      }
    } catch {
      /* DB may not exist yet */
    } finally {
      db?.close();
    }
  }

  const oPath = outboundDbPath(agentGroupId, sessionId);
  if (fs.existsSync(oPath)) {
    let db: Database.Database | null = null;
    try {
      db = new Database(oPath, { readonly: true });
      db.pragma('busy_timeout = 3000');
      const rows = db
        .prepare(`SELECT id, timestamp, kind, content FROM messages_out ORDER BY seq ASC LIMIT ?`)
        .all(limit) as Array<{ id: string; timestamp: string; kind: string; content: string }>;
      for (const r of rows) {
        messages.push({
          id: r.id,
          timestamp: r.timestamp,
          direction: 'outbound',
          kind: r.kind,
          text: parseContentText(r.content, r.kind),
        });
      }
    } catch {
      /* DB may not exist yet */
    } finally {
      db?.close();
    }
  }

  // merge and sort by timestamp, take most recent `limit`
  messages.sort((a, b) => (a.timestamp < b.timestamp ? -1 : a.timestamp > b.timestamp ? 1 : 0));
  return messages.slice(-limit);
}

// ---------------------------------------------------------------------------
// HTTP helpers
// ---------------------------------------------------------------------------

function sendJson(res: ServerResponse, data: unknown, status = 200): void {
  const body = JSON.stringify(data);
  res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' });
  res.end(body);
}

// ---------------------------------------------------------------------------
// startWebUi
// ---------------------------------------------------------------------------

export function startWebUi(port: number, host = '127.0.0.1'): Server {
  const server = createServer(async (req: IncomingMessage, res: ServerResponse) => {
    const baseUrl = `http://${req.headers.host || host}`;
    let url: URL;
    try {
      url = new URL(req.url || '/', baseUrl);
    } catch {
      res.writeHead(400);
      res.end('Bad request');
      return;
    }
    const pathname = url.pathname;

    try {
      // Serve dashboard
      if (req.method === 'GET' && pathname === '/') {
        res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
        res.end(DASHBOARD_HTML);
        return;
      }

      // GET /api/groups — agent groups with session + messaging group counts
      if (req.method === 'GET' && pathname === '/api/groups') {
        const groups = getAllAgentGroups();
        const allSessions = getActiveSessions();
        const sessionCountByGroup: Record<string, number> = {};
        for (const s of allSessions)
          sessionCountByGroup[s.agent_group_id] = (sessionCountByGroup[s.agent_group_id] || 0) + 1;
        const db = getDb();
        const mgCounts = db
          .prepare('SELECT agent_group_id, COUNT(*) AS n FROM messaging_group_agents GROUP BY agent_group_id')
          .all() as Array<{ agent_group_id: string; n: number }>;
        const mgCountByGroup = new Map(mgCounts.map((r) => [r.agent_group_id, r.n]));
        const result = groups.map((g) => ({
          id: g.id,
          name: g.name,
          folder: g.folder,
          created_at: g.created_at,
          sessionCount: sessionCountByGroup[g.id] || 0,
          messagingGroupCount: mgCountByGroup.get(g.id) || 0,
        }));
        sendJson(res, result);
        return;
      }

      // GET /api/sessions?group=<folder> — sessions for an agent group
      if (req.method === 'GET' && pathname === '/api/sessions') {
        const folder = url.searchParams.get('group');
        if (!folder) {
          sendJson(res, { error: 'group required' }, 400);
          return;
        }
        const group = getAgentGroupByFolder(folder);
        if (!group) {
          sendJson(res, [], 200);
          return;
        }
        const sessions = getSessionsByAgentGroup(group.id);
        // Enrich with messaging group names
        const allMgs = getAllMessagingGroups();
        const mgById = new Map(allMgs.map((m) => [m.id, m]));
        const result = sessions
          .sort((a, b) => ((b.last_active || '') < (a.last_active || '') ? -1 : 1))
          .map((s) => ({
            id: s.id,
            agent_group_id: s.agent_group_id,
            messaging_group_id: s.messaging_group_id,
            messaging_group_name: s.messaging_group_id ? (mgById.get(s.messaging_group_id)?.name ?? null) : null,
            thread_id: s.thread_id,
            status: s.status,
            container_status: s.container_status,
            processing_state: s.processing_state,
            last_active: s.last_active,
            created_at: s.created_at,
          }));
        sendJson(res, result);
        return;
      }

      // GET /api/messages?session=<id>&limit=N
      if (req.method === 'GET' && pathname === '/api/messages') {
        const sessionId = url.searchParams.get('session');
        if (!sessionId) {
          sendJson(res, { error: 'session required' }, 400);
          return;
        }
        const limit = Math.min(parseInt(url.searchParams.get('limit') || '150', 10) || 150, 500);
        const session = getSession(sessionId);
        if (!session) {
          sendJson(res, [], 200);
          return;
        }
        const messages = readSessionMessages(session.agent_group_id, sessionId, limit);
        sendJson(res, messages);
        return;
      }

      // GET /api/files
      if (req.method === 'GET' && pathname === '/api/files') {
        sendJson(res, listGroupFiles());
        return;
      }

      // GET /api/org-ids
      if (req.method === 'GET' && pathname === '/api/org-ids') {
        sendJson(res, getOrgIdIndex());
        return;
      }

      // GET /api/file?path=
      if (req.method === 'GET' && pathname === '/api/file') {
        const relPath = url.searchParams.get('path');
        if (!relPath) {
          sendJson(res, { error: 'path required' }, 400);
          return;
        }
        const content = safeReadFile(relPath);
        if (content === null) {
          res.writeHead(404, { 'Content-Type': 'text/plain' });
          res.end('Not found');
          return;
        }
        res.writeHead(200, { 'Content-Type': 'text/plain; charset=utf-8', 'Cache-Control': 'no-store' });
        res.end(content);
        return;
      }

      // GET /api/notes-graph?group=<folder>
      if (req.method === 'GET' && pathname === '/api/notes-graph') {
        const folder = url.searchParams.get('group');
        if (!folder) {
          sendJson(res, { error: 'group required' }, 400);
          return;
        }
        const notesDir = path.resolve(GROUPS_DIR, folder, 'memory', 'notes');
        if (!notesDir.startsWith(path.resolve(GROUPS_DIR) + path.sep)) {
          sendJson(res, { error: 'invalid group' }, 400);
          return;
        }
        let noteFiles: string[];
        try {
          noteFiles = fs.readdirSync(notesDir).filter((f) => f.endsWith('.md'));
        } catch {
          sendJson(res, { nodes: [], edges: [] });
          return;
        }
        type NoteNode = {
          id: string;
          label: string;
          tags: string[];
          keywords: string[];
          created: string;
          path: string;
          source_task_id: string | null;
          isSynthesis: boolean;
        };
        const nodes: NoteNode[] = [];
        const nodeIds = new Set<string>();
        const fmMap = new Map<string, ReturnType<typeof parseNoteFrontmatter>>();
        const db = getDb();
        const taskByReportPath = db.prepare<[string], { id: string }>(
          `SELECT id FROM specialist_tasks
           WHERE committed_files IS NOT NULL AND instr(committed_files, ?) > 0
             AND closed_at IS NOT NULL
           LIMIT 1`,
        );
        for (const file of noteFiles) {
          let text: string;
          try {
            text = fs.readFileSync(path.join(notesDir, file), 'utf-8');
          } catch {
            continue;
          }
          const fm = parseNoteFrontmatter(text);
          if (!fm) continue;
          fmMap.set(file, fm);
          let source_task_id: string | null = null;
          if (fm.source_report_path) {
            const row = taskByReportPath.get(fm.source_report_path);
            if (row) source_task_id = row.id;
          }
          nodes.push({
            id: fm.id,
            label: fm.id.replace(/^(?:MEM|SYN)-\d{4}-\d{2}-\d{2}-/, '').replace(/-/g, ' '),
            tags: fm.tags,
            keywords: fm.keywords,
            created: fm.created,
            path: folder + '/memory/notes/' + file,
            source_task_id,
            isSynthesis: fm.id.startsWith('SYN-'),
          });
          nodeIds.add(fm.id);
        }
        const edges: Array<{ source: string; target: string; supersedes?: boolean; synthesises?: boolean }> = [];
        const seen = new Set<string>();
        const supersedesPairs = new Set<string>();
        for (const fm of fmMap.values()) {
          if (!fm) continue;
          for (const tgt of fm.supersedes) supersedesPairs.add([fm.id, tgt].sort().join('||'));
          for (const tgt of fm.superseded_by) supersedesPairs.add([fm.id, tgt].sort().join('||'));
        }
        for (const fm of fmMap.values()) {
          if (!fm) continue;
          for (const tgt of fm.links) {
            if (!nodeIds.has(fm.id) || !nodeIds.has(tgt)) continue;
            const key = [fm.id, tgt].sort().join('||');
            if (!seen.has(key)) {
              seen.add(key);
              edges.push({ source: fm.id, target: tgt, supersedes: supersedesPairs.has(key) || undefined });
            }
          }
          for (const tgt of fm.synthesises) {
            if (!nodeIds.has(fm.id) || !nodeIds.has(tgt)) continue;
            const key = fm.id + '||SYN||' + tgt;
            if (!seen.has(key)) {
              seen.add(key);
              edges.push({ source: fm.id, target: tgt, synthesises: true });
            }
          }
        }
        sendJson(res, { nodes, edges });
        return;
      }

      // GET /api/status
      if (req.method === 'GET' && pathname === '/api/status') {
        const groups = getAllAgentGroups();
        const activeSessions = getActiveSessions();
        const allMgs = getAllMessagingGroups();
        const mgById = new Map(allMgs.map((m) => [m.id, m]));
        const agGroupById = new Map(groups.map((g) => [g.id, g]));
        const queueStatus = getQueueStatus();
        const runningSessions = activeSessions
          .filter((s) => s.container_status === 'running' || s.container_status === 'idle')
          .map((s) => ({
            ...s,
            agent_group_name: agGroupById.get(s.agent_group_id)?.name ?? null,
            messaging_group_name: s.messaging_group_id ? (mgById.get(s.messaging_group_id)?.name ?? null) : null,
          }));
        const up = Math.floor(process.uptime());
        const uptimeStr =
          up < 3600
            ? Math.floor(up / 60) + 'm ' + (up % 60) + 's'
            : Math.floor(up / 3600) + 'h ' + Math.floor((up % 3600) / 60) + 'm';
        sendJson(res, {
          uptime: up,
          uptimeStr,
          agentGroups: groups.length,
          sessions: {
            active: activeSessions.length,
            running: runningSessions.length,
          },
          runningSessions,
          queue: queueStatus,
          activeContainers: getActiveContainerCount(),
          orphans: 0,
          orphanContainers: [],
        });
        return;
      }

      // GET /api/system
      if (req.method === 'GET' && pathname === '/api/system') {
        const groups = getAllAgentGroups();
        const agGroupById = new Map(groups.map((g) => [g.id, g]));
        const allSessions = getActiveSessions();
        const allMgs = getAllMessagingGroups();
        const mgById = new Map(allMgs.map((m) => [m.id, m]));
        const sessions = allSessions.map((s) => ({
          ...s,
          agent_group_name: agGroupById.get(s.agent_group_id)?.name ?? null,
          agent_group_folder: agGroupById.get(s.agent_group_id)?.folder ?? null,
          messaging_group_name: s.messaging_group_id ? (mgById.get(s.messaging_group_id)?.name ?? null) : null,
        }));
        // Enrich messaging groups with their wired agent groups
        const db = getDb();
        const messagingGroups = allMgs.map((mg) => {
          const wiredAgents = db
            .prepare(
              'SELECT ag.name FROM messaging_group_agents mga JOIN agent_groups ag ON ag.id = mga.agent_group_id WHERE mga.messaging_group_id = ?',
            )
            .all(mg.id) as Array<{ name: string }>;
          return { ...mg, agent_groups: wiredAgents.map((a) => a.name) };
        });
        sendJson(res, { sessions, messagingGroups });
        return;
      }

      // GET /api/db/tables
      if (req.method === 'GET' && pathname === '/api/db/tables') {
        sendJson(res, getDbTables());
        return;
      }

      // GET /api/db/table?name=&limit=&offset=&search=
      if (req.method === 'GET' && pathname === '/api/db/table') {
        const name = url.searchParams.get('name');
        if (!name) {
          sendJson(res, { error: 'name required' }, 400);
          return;
        }
        const limit = Math.min(parseInt(url.searchParams.get('limit') || '50', 10) || 50, 200);
        const offset = Math.max(parseInt(url.searchParams.get('offset') || '0', 10) || 0, 0);
        const search = url.searchParams.get('search') || undefined;
        sendJson(res, getDbTableData(name, limit, offset, search));
        return;
      }

      res.writeHead(404, { 'Content-Type': 'text/plain' });
      res.end('Not found');
    } catch (err) {
      log.error('Web UI request error', { err, pathname });
      sendJson(res, { error: 'Internal server error' }, 500);
    }
  });

  server.listen(port, host, () => {
    log.info('Web UI started', { port, host, url: `http://localhost:${port}` });
  });

  return server;
}
