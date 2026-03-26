/**
 * NanoClaw Web Dashboard
 * Provides a read/write web UI for inspecting the database and chatting with agents.
 * Intended to be exposed over Tailscale Serve (HTTPS) — bind to localhost only.
 */
import { createServer, IncomingMessage, Server, ServerResponse } from 'http';
import fs from 'fs';
import path from 'path';
import { URL } from 'url';

import { ASSISTANT_NAME, GROUPS_DIR } from './config.js';
import {
  getAllChats,
  getAllRegisteredGroups,
  getAllRouterStateRows,
  getAllRssFeeds,
  getAllSessions,
  getAllTasks,
  getChatMessages,
  getDbTableData,
  getDbTables,
  getTaskRunLogs,
  storeMessage,
} from './db.js';
import { logger } from './logger.js';

// ---------------------------------------------------------------------------
// HTML dashboard (inline, no external assets needed)
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
.msg.bot .msg-body{color:#79c0ff}.msg.me .msg-body{color:#56d364}.msg-sender{font-size:12px;font-weight:600;color:#c8922a;margin-bottom:2px}
.send-row{display:flex;gap:8px}
.send-row input{flex:1;background:#21262d;border:1px solid #30363d;border-radius:6px;padding:8px 12px;color:#e6edf3;font-size:14px;outline:none}
.send-row input:focus{border-color:#58a6ff}
.send-row button{background:#238636;border:none;border-radius:6px;padding:8px 16px;color:#fff;font-size:14px;cursor:pointer}
.send-row button:hover{background:#2ea043}
.back{color:#8b949e;font-size:13px;cursor:pointer;margin-bottom:16px;display:inline-block}
.back:hover{color:#e6edf3}
.empty{color:#8b949e;font-style:italic;text-align:center;padding:32px}
.log-row{cursor:pointer}.log-body{display:none;padding:8px 12px;background:#0d1117}
.log-row.task-selected td{background:#0d2744 !important;border-top:1px solid #1f6feb;border-bottom:1px solid #1f6feb}
pre{background:#0d1117;border:1px solid #30363d;border-radius:6px;padding:10px;font-size:12px;overflow-x:auto;white-space:pre-wrap;word-break:break-word;max-height:200px}
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
body.task-maximized nav{display:none}
body.task-maximized #group-back{display:none}
body.task-maximized #group-detail-name,body.task-maximized #group-detail-badges{display:none}
body.task-maximized .subnav{display:none}
body.task-maximized #group-tasks-body{display:none}
body.task-maximized #group-tasks-split{height:100vh}
body.task-maximized main{padding:0}
body.task-maximized #group-task-detail{border-radius:0;height:100vh}
body.task-result-maximized nav{display:none}
body.task-result-maximized #group-back{display:none}
body.task-result-maximized #group-detail-name,body.task-result-maximized #group-detail-badges{display:none}
body.task-result-maximized .subnav{display:none}
body.task-result-maximized #group-tasks-body{display:none}
body.task-result-maximized #group-task-detail{display:none}
body.task-result-maximized #group-tasks-split{height:100vh}
body.task-result-maximized main{padding:0}
body.task-result-maximized #group-task-result{border-radius:0;height:100vh}
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
/* ── Graph tab ── */
#graph-container{width:100%;height:calc(100vh - 340px);min-height:400px;background:#0d1117;border:1px solid #30363d;border-radius:8px;position:relative}
#graph-toolbar{display:flex;gap:8px;align-items:center;margin-bottom:10px}
#graph-search{flex:1;background:#21262d;border:1px solid #30363d;border-radius:6px;padding:7px 12px;color:#e6edf3;font-size:13px;outline:none}
#graph-search:focus{border-color:#58a6ff}
#graph-status{font-size:12px;color:#8b949e;white-space:nowrap}
#graph-legend{display:flex;flex-wrap:wrap;gap:6px;margin-bottom:10px}
.graph-legend-item{display:flex;align-items:center;gap:4px;font-size:11px;color:#8b949e}
.graph-legend-dot{width:10px;height:10px;border-radius:50%;flex-shrink:0}
#graph-node-panel{display:none;position:absolute;bottom:12px;right:12px;width:320px;background:rgba(22,27,34,0.95);border:1px solid #30363d;border-radius:8px;padding:14px;z-index:10;backdrop-filter:blur(8px)}
#graph-node-panel h3{font-size:13px;font-weight:600;color:#f0f6fc;margin:0 0 10px;word-break:break-all}
</style>
</head>
<body>
<nav>
  <h1>NanoClaw</h1>
  <a id="nav-groups" href="#groups">Groups</a>
  <a id="nav-feeds" href="#feeds">Feeds</a>
  <a id="nav-system" href="#system">System</a>
  <a id="nav-database" href="#database">Database</a>
</nav>
<main>
  <!-- Groups: list + detail -->
  <div id="section-groups" class="section">

    <!-- Group list -->
    <div id="groups-list">
      <h2>Groups</h2>
      <div id="groups-body">Loading...</div>
    </div>

    <!-- Group detail -->
    <div id="group-detail" style="display:none">
      <a id="group-back" class="back">&#8592; Groups</a>
      <div style="display:flex;align-items:center;gap:10px;margin-bottom:16px">
        <h2 id="group-detail-name" style="margin-bottom:0"></h2>
        <span id="group-detail-badges"></span>
      </div>
      <div class="subnav" id="group-subnav">
        <a data-tab="chat">Chat</a>
        <a data-tab="tasks">Tasks</a>
        <a data-tab="files">Files</a>
        <a data-tab="notes">Graph</a>
      </div>

      <!-- Chat tab -->
      <div id="group-tab-chat">
        <div id="group-msgs" class="msgs"></div>
        <div id="group-send-area"></div>
      </div>

      <!-- Tasks tab -->
      <div id="group-tab-tasks" style="display:none">
        <div id="group-tasks-split" style="display:flex;gap:16px;height:calc(100vh - 220px)">
          <div id="group-tasks-body" style="flex:1;overflow-y:auto;min-width:0">Loading...</div>
          <div id="group-task-detail" style="flex:1;overflow:auto;background:#161b22;border:1px solid #30363d;border-radius:8px;padding:16px;position:relative;display:none">
            <button class="file-maximize-btn" id="task-maximize-btn" title="Maximise task view">&#x26F6;</button>
            <div id="group-task-detail-content"><div class="empty">Click a task schedule to view details</div></div>
          </div>
          <div id="group-task-result" style="flex:1;overflow:auto;background:#161b22;border:1px solid #30363d;border-radius:8px;padding:16px;position:relative;display:none">
            <button class="file-maximize-btn" id="task-result-maximize-btn" title="Maximise result view">&#x26F6;</button>
            <div id="group-task-result-content"></div>
          </div>
        </div>
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
          <input id="graph-search" type="text" placeholder="Filter by keyword or tag&#x2026;">
          <span id="graph-status"></span>
        </div>
        <div id="graph-legend"></div>
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

  <!-- Feeds -->
  <div id="section-feeds" class="section">
    <h2>RSS Feeds</h2>
    <div id="feeds-body">Loading...</div>
  </div>

  <!-- System -->
  <div id="section-system" class="section">
    <h2>Sessions</h2>
    <div id="sessions-body">Loading...</div>
    <h2 style="margin-top:24px">Router State</h2>
    <div id="routerstate-body">Loading...</div>
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
            <input id="db-search" type="text" placeholder="Search\u2026" style="margin-left:auto;width:220px;background:#21262d;border:1px solid #30363d;border-radius:6px;padding:6px 10px;color:#e6edf3;font-size:13px">
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
<script src="https://cdnjs.cloudflare.com/ajax/libs/cytoscape/3.28.1/cytoscape.min.js"></script>
<script src="https://cdn.jsdelivr.net/npm/d3@7/dist/d3.min.js"></script>
<script>
document.addEventListener('DOMContentLoaded', function() {
  var currentGroup = null;   // group object from /api/groups
  var currentTab = 'chat';
  var pollTimer = null;
  var skipHashUpdate = false;
  var groupTasksData = {};   // task id → task object
  var taskDetailLogs = [];   // run logs for currently open task detail

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

  // ── URL routing ─────────────────────────────────────────────────────────────
  // URL scheme:
  //   #groups                        → group list
  //   #groups/{folder}               → group chat tab (default)
  //   #groups/{folder}/tasks         → group tasks tab
  //   #groups/{folder}/files         → group files tab, no file selected
  //   #groups/{folder}/files/{path}  → group files tab, file open
  //                                    ({path} is relative within the group folder)
  //   #feeds                         → feeds
  //   #system                        → system

  function pushHash(hash) {
    if (!skipHashUpdate) history.pushState(null, '', '#' + hash);
  }

  function parseHash(hash) {
    hash = (hash || '').replace(/^#/, '') || 'groups';
    var parts = hash.split('/');
    var section = parts[0] || 'groups';
    if (section === 'feeds') return { section: 'feeds' };
    if (section === 'system') return { section: 'system' };
    if (section === 'database') return { section: 'database' };
    var folder = parts[1] || null;
    if (!folder) return { section: 'groups', folder: null };
    var tab = parts[2] || 'chat';
    var filePath = (tab === 'files' && parts.length > 3) ? parts.slice(3).join('/') : null;
    return { section: 'groups', folder: folder, tab: tab, filePath: filePath };
  }

  async function restoreFromHash() {
    var state = parseHash(location.hash);
    skipHashUpdate = true;
    try {
      if (state.section === 'feeds') {
        activateSection('feeds'); clearInterval(pollTimer); pollTimer = null; loadFeeds(); return;
      }
      if (state.section === 'system') {
        activateSection('system'); clearInterval(pollTimer); pollTimer = null; loadSystem(); return;
      }
      if (state.section === 'database') {
        activateSection('database'); clearInterval(pollTimer); pollTimer = null; loadDbTables(); return;
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
      document.getElementById('group-detail-badges').innerHTML =
        (g.isMain ? '<span class="badge bb">main</span> ' : '')
        + '<span class="badge bg">'+esc(g.channel)+'</span>';
      switchTab(state.tab || 'chat', state.filePath);
    } finally {
      skipHashUpdate = false;
    }
  }

  window.addEventListener('popstate', function() {
    // If a pane is maximised, back button de-maximises instead of navigating.
    var maximizeMap = [
      { cls: 'task-result-maximized', btn: 'task-result-maximize-btn', label: 'Maximise result view' },
      { cls: 'task-maximized',        btn: 'task-maximize-btn',        label: 'Maximise task view'   },
      { cls: 'file-maximized',        btn: 'file-maximize-btn',        label: 'Maximise file view'   },
    ];
    for (var i = 0; i < maximizeMap.length; i++) {
      if (document.body.classList.contains(maximizeMap[i].cls)) {
        document.body.classList.remove(maximizeMap[i].cls);
        var b = document.getElementById(maximizeMap[i].btn);
        if (b) { b.innerHTML = '&#x26F6;'; b.title = maximizeMap[i].label; }
        return;
      }
    }
    restoreFromHash();
  });

  // ── Top-level nav ──────────────────────────────────────────────────────────

  function activateSection(name) {
    document.querySelectorAll('.section').forEach(function(s) { s.classList.remove('active'); });
    document.querySelectorAll('nav a').forEach(function(a) { a.classList.remove('active'); });
    document.querySelectorAll('#mobile-nav a').forEach(function(a) { a.classList.remove('active'); });
    var sec = document.getElementById('section-'+name);
    var nav = document.getElementById('nav-'+name);
    var mnav = document.getElementById('mnav-'+name);
    if (sec) sec.classList.add('active');
    if (nav) nav.classList.add('active');
    if (mnav) mnav.classList.add('active');
  }

  function show(name) {
    pushHash(name);
    activateSection(name);
    clearInterval(pollTimer); pollTimer = null;
    if (name === 'groups') showGroupListInternal();
    if (name === 'feeds') loadFeeds();
    if (name === 'system') loadSystem();
    if (name === 'database') loadDbTables();
  }

  document.querySelectorAll('nav a, #mobile-nav a').forEach(function(a) {
    a.addEventListener('click', function(e) {
      e.preventDefault();
      show((a.getAttribute('href') || '#groups').replace('#',''));
    });
  });

  // ── Group list ─────────────────────────────────────────────────────────────

  // No hash push — caller is responsible for setting the hash.
  function showGroupListInternal() {
    clearInterval(pollTimer); pollTimer = null;
    currentGroup = null;
    document.getElementById('groups-list').style.display = '';
    document.getElementById('group-detail').style.display = 'none';
    loadGroups();
  }

  function showGroupList() {
    pushHash('groups');
    showGroupListInternal();
  }

  async function loadGroups() {
    var el = document.getElementById('groups-body');
    try {
      var data = await fetch('/api/groups').then(function(r) { return r.json(); });
      if (!data.length) { el.innerHTML = '<div class="empty">No registered groups</div>'; return; }
      el.innerHTML = data.map(function(g) {
        return '<div class="card group-card" data-jid="'+esc(g.jid)+'">'
          +'<div style="display:flex;justify-content:space-between;align-items:center">'
          +'<strong>'+esc(g.name)+'</strong>'
          +'<span>'+(g.isMain ? '<span class="badge bb">main</span> ' : '')+(g.trustedGroup ? '<span class="badge bb">trusted</span> ' : '')+(!g.isMain && !g.trustedGroup && g.requiresTrigger !== false ? '<span class="badge">trigger required</span> ' : '')+'<span class="badge bg">'+esc(g.channel)+'</span></span>'
          +'</div>'
          +'<div class="dim" style="margin-top:6px">'+esc(g.folder)+(g.trigger ? ' &nbsp;&middot;&nbsp; trigger: <code>'+esc(g.trigger)+'</code>' : '')+' &nbsp;&middot;&nbsp; added '+fmtDate(g.added_at)+'</div>'
          +'</div>';
      }).join('');
      // store data for lookup on click
      el._groups = data;
    } catch(e) { el.innerHTML = '<div class="empty">Error loading groups</div>'; }
  }

  document.getElementById('groups-body').addEventListener('click', function(e) {
    var card = e.target.closest('[data-jid]');
    if (!card) return;
    var jid = card.dataset.jid;
    var groups = document.getElementById('groups-body')._groups || [];
    var g = groups.find(function(x) { return x.jid === jid; });
    if (g) openGroup(g);
  });

  // ── Group detail ───────────────────────────────────────────────────────────

  document.getElementById('group-back').addEventListener('click', showGroupList);

  document.getElementById('group-subnav').addEventListener('click', function(e) {
    var a = e.target.closest('[data-tab]');
    if (a) switchTab(a.dataset.tab);
  });

  document.getElementById('group-send-area').addEventListener('click', function(e) {
    if (e.target.tagName === 'BUTTON') sendMsg();
  });
  document.getElementById('group-send-area').addEventListener('keydown', function(e) {
    if (e.key === 'Enter') sendMsg();
  });

  document.getElementById('group-tasks-body').addEventListener('click', function(e) {
    var row = e.target.closest('[data-task-id]');
    if (!row) return;
    if (e.target.closest('[data-schedule-click]')) {
      document.querySelectorAll('.log-row.task-selected').forEach(function(r) { r.classList.remove('task-selected'); });
      row.classList.add('task-selected');
      openTaskDetail(groupTasksData[row.dataset.taskId]);
    } else {
      toggleLogs(row.dataset.taskId);
    }
  });

  function openGroup(g) {
    currentGroup = g;
    document.getElementById('groups-list').style.display = 'none';
    document.getElementById('group-detail').style.display = '';
    document.getElementById('group-detail-name').textContent = g.name;
    document.getElementById('group-detail-badges').innerHTML =
      (g.isMain ? '<span class="badge bb">main</span> ' : '')
      + '<span class="badge bg">'+esc(g.channel)+'</span>';
    switchTab('chat');
  }

  function switchTab(tab, autoFilePath) {
    clearInterval(pollTimer); pollTimer = null;
    currentTab = tab;
    document.querySelectorAll('#group-subnav [data-tab]').forEach(function(a) {
      a.classList.toggle('active', a.dataset.tab === tab);
    });
    document.getElementById('group-tab-chat').style.display  = tab === 'chat'  ? '' : 'none';
    document.getElementById('group-tab-tasks').style.display = tab === 'tasks' ? '' : 'none';
    document.getElementById('group-tab-files').style.display = tab === 'files' ? '' : 'none';
    document.getElementById('group-tab-notes').style.display = tab === 'notes' ? '' : 'none';
    if (tab !== 'files' && document.body.classList.contains('file-maximized')) {
      document.body.classList.remove('file-maximized');
      var btn = document.getElementById('file-maximize-btn');
      if (btn) { btn.innerHTML = '&#x26F6;'; btn.title = 'Maximise file view'; }
    }
    if (tab !== 'tasks' && document.body.classList.contains('task-maximized')) {
      document.body.classList.remove('task-maximized');
      var tbtn = document.getElementById('task-maximize-btn');
      if (tbtn) { tbtn.innerHTML = '&#x26F6;'; tbtn.title = 'Maximise task view'; }
    }
    if (tab !== 'tasks' && document.body.classList.contains('task-result-maximized')) {
      document.body.classList.remove('task-result-maximized');
      var trbtn = document.getElementById('task-result-maximize-btn');
      if (trbtn) { trbtn.innerHTML = '&#x26F6;'; trbtn.title = 'Maximise result view'; }
    }
    if (currentGroup) {
      var base = 'groups/' + currentGroup.folder;
      if (tab === 'chat') pushHash(base);
      else if (tab === 'files' && autoFilePath) pushHash(base + '/files/' + autoFilePath);
      else pushHash(base + '/' + tab);
    }
    if (tab === 'chat')  loadGroupChat();
    if (tab === 'tasks') loadGroupTasks();
    if (tab === 'files') loadGroupFiles(autoFilePath);
    if (tab === 'notes') loadGroupGraph();
  }

  // ── Chat tab ───────────────────────────────────────────────────────────────

  async function loadGroupChat() {
    var g = currentGroup;
    var sendArea = document.getElementById('group-send-area');
    sendArea.innerHTML = g.isMain || g.trustedGroup || g.requiresTrigger === false
      ? '<div class="send-row"><input id="msg-input" type="text" placeholder="Message\u2026"><button type="button">Send</button></div>'
      : '<div class="send-row"><input id="msg-input" type="text" placeholder="Message (trigger will be prepended)\u2026"><button type="button">Send</button></div>';
    await loadMsgs();
    clearInterval(pollTimer);
    pollTimer = setInterval(loadMsgs, 3000);
  }

  async function loadMsgs() {
    if (!currentGroup || currentTab !== 'chat') return;
    var el = document.getElementById('group-msgs');
    if (!el) return;
    try {
      var data = await fetch('/api/messages?jid='+encodeURIComponent(currentGroup.jid)+'&limit=150').then(function(r) { return r.json(); });
      if (!data.length) { el.innerHTML = '<div class="empty">No messages yet</div>'; return; }
      var atBottom = el.scrollHeight - el.scrollTop <= el.clientHeight + 60;
      el.innerHTML = data.map(function(m) {
        var cls = m.is_bot_message ? 'bot' : (m.is_from_me ? 'me' : '');
        var who = m.is_bot_message ? 'Bot' : esc(m.sender_name || m.sender);
        var senderHdr = (m.is_bot_message && m.sender_name && m.sender_name !== 'Bot') ? '<div class="msg-sender">~'+esc(m.sender_name)+'</div>' : '';
        return '<div class="msg '+cls+'"><div class="msg-meta">'+who+' &middot; '+fmtTime(m.timestamp)+'</div>'+senderHdr+'<div class="msg-body">'+esc(m.content)+'</div></div>';
      }).join('');
      if (atBottom) el.scrollTop = el.scrollHeight;
    } catch(e) {}
  }

  async function sendMsg() {
    var input = document.getElementById('msg-input');
    if (!input || !currentGroup) return;
    var text = (input.value || '').trim();
    if (!text) return;
    input.value = '';
    try {
      await fetch('/api/chat', {method:'POST', headers:{'Content-Type':'application/json'}, body:JSON.stringify({jid:currentGroup.jid, message:text})});
      await loadMsgs();
    } catch(e) {}
  }

  // ── Tasks tab ──────────────────────────────────────────────────────────────

  async function loadGroupTasks() {
    if (!currentGroup) return;
    var el = document.getElementById('group-tasks-body');
    el.innerHTML = 'Loading\u2026';
    try {
      var all = await fetch('/api/tasks').then(function(r) { return r.json(); });
      var data = all.filter(function(t) { return t.group_folder === currentGroup.folder; });
      if (!data.length) { el.innerHTML = '<div class="empty">No scheduled tasks for this group</div>'; return; }
      groupTasksData = {};
      data.forEach(function(t) { groupTasksData[t.id] = t; });
      el.innerHTML = '<div class="card"><table><thead><tr><th>Schedule</th><th>Status</th><th>Next Run</th><th>Last Run</th><th>Prompt</th><th></th></tr></thead><tbody>'
        + data.map(function(t) {
          var sc = t.status==='active' ? 'bg' : t.status==='paused' ? 'by' : 'br';
          return '<tr class="log-row" data-task-id="'+esc(t.id)+'">'
            +'<td class="dim" data-schedule-click="1" style="cursor:pointer;text-decoration:underline dotted;text-underline-offset:3px">'+esc(t.schedule_type)+': '+esc(t.schedule_value)+'</td>'
            +'<td><span class="badge '+sc+'">'+esc(t.status)+'</span></td>'
            +'<td class="dim">'+(t.next_run ? fmtDate(t.next_run) : '&mdash;')+'</td>'
            +'<td class="dim">'+(t.last_run ? fmtDate(t.last_run) : '&mdash;')+'</td>'
            +'<td style="max-width:220px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap" title="'+esc(t.prompt)+'">'+esc(t.prompt)+'</td>'
            +'<td class="dim">&#9660;</td>'
            +'</tr>'
            +'<tr id="logs-'+esc(t.id)+'"><td colspan="6" class="log-body"><div id="logs-inner-'+esc(t.id)+'" class="dim">Loading\u2026</div></td></tr>';
        }).join('')
        + '</tbody></table></div>';
    } catch(e) { el.innerHTML = '<div class="empty">Error loading tasks</div>'; }
  }

  async function toggleLogs(taskId) {
    var row = document.getElementById('logs-'+taskId);
    var inner = document.getElementById('logs-inner-'+taskId);
    if (!row) return;
    var visible = row.style.display === 'table-row';
    row.style.display = visible ? 'none' : 'table-row';
    if (!visible) {
      try {
        var data = await fetch('/api/task-logs?task_id='+encodeURIComponent(taskId)).then(function(r) { return r.json(); });
        if (!data.length) { inner.textContent = 'No run logs yet.'; return; }
        inner.innerHTML = data.map(function(l) {
          var sc = l.status === 'success' ? 'bg' : 'br';
          return '<div style="margin-bottom:8px"><span class="badge '+sc+'">'+esc(l.status)+'</span>'
            +' <span class="dim">'+fmtDate(l.run_at)+' &middot; '+l.duration_ms+'ms</span>'
            +(l.result ? '<pre>'+esc(l.result)+'</pre>' : '')
            +(l.error ? '<pre style="color:#f85149">'+esc(l.error)+'</pre>' : '')
            +'</div>';
        }).join('');
      } catch(e) { inner.textContent = 'Error loading logs.'; }
    }
  }

  async function openTaskDetail(task) {
    if (!task) return;
    var panel = document.getElementById('group-task-detail');
    var content = document.getElementById('group-task-detail-content');
    panel.style.display = '';
    document.getElementById('group-task-result').style.display = 'none';
    taskDetailLogs = [];
    var sc = task.status==='active' ? 'bg' : task.status==='paused' ? 'by' : 'br';
    content.innerHTML = '<div class="dim" style="margin-bottom:12px;font-size:11px;text-transform:uppercase;letter-spacing:.4px">Task Detail</div>'
      +'<div class="fm-card">'
      +'<div class="fm-key">Schedule</div><div class="fm-val">'+esc(task.schedule_type)+': '+esc(task.schedule_value)+'</div>'
      +'<div class="fm-key">Status</div><div class="fm-val"><span class="badge '+sc+'">'+esc(task.status)+'</span></div>'
      +(task.next_run ? '<div class="fm-key">Next Run</div><div class="fm-val">'+fmtDate(task.next_run)+'</div>' : '')
      +(task.last_run ? '<div class="fm-key">Last Run</div><div class="fm-val">'+fmtDate(task.last_run)+'</div>' : '')
      +'</div>'
      +'<div class="dim" style="margin-bottom:8px;font-size:11px;text-transform:uppercase;letter-spacing:.4px">Prompt</div>'
      +'<pre style="max-height:180px;font-size:13px">'+esc(task.prompt)+'</pre>'
      +'<div class="dim" style="margin:16px 0 8px;font-size:11px;text-transform:uppercase;letter-spacing:.4px">Run Logs</div>'
      +'<div id="task-detail-logs"><div class="dim">Loading\u2026</div></div>';
    try {
      var logs = await fetch('/api/task-logs?task_id='+encodeURIComponent(task.id)).then(function(r) { return r.json(); });
      taskDetailLogs = logs;
      var logsEl = document.getElementById('task-detail-logs');
      if (!logsEl) return;
      if (!logs.length) { logsEl.innerHTML = '<div class="dim" style="font-style:italic">No run logs yet.</div>'; return; }
      logsEl.innerHTML = logs.map(function(l) {
        var lsc = l.status === 'success' ? 'bg' : 'br';
        var hasResult = l.result || l.error;
        return '<div style="display:flex;align-items:center;gap:8px;padding:6px 0;border-bottom:1px solid #21262d">'
          +'<span class="badge '+lsc+'">'+esc(l.status)+'</span>'
          +'<span class="dim">'+fmtDate(l.run_at)+' &middot; '+l.duration_ms+'ms</span>'
          +(hasResult
            ? '<button data-log-id="'+esc(l.id)+'" style="margin-left:auto;background:#21262d;border:1px solid #30363d;border-radius:4px;color:#8b949e;font-size:11px;padding:2px 8px;cursor:pointer">View result</button>'
            : '<span class="dim" style="margin-left:auto;font-size:11px;font-style:italic">no result</span>')
          +'</div>';
      }).join('');
    } catch(e) {
      var logsEl = document.getElementById('task-detail-logs');
      if (logsEl) logsEl.innerHTML = '<div class="dim">Error loading logs.</div>';
    }
  }

  document.getElementById('group-task-detail').addEventListener('click', function(e) {
    var btn = e.target.closest('[data-log-id]');
    if (!btn) return;
    var logId = parseInt(btn.dataset.logId, 10);
    var log = taskDetailLogs.find(function(l) { return l.id === logId; });
    if (log) openTaskResult(log);
  });

  function openTaskResult(log) {
    var panel = document.getElementById('group-task-result');
    var content = document.getElementById('group-task-result-content');
    panel.style.display = '';
    var lsc = log.status === 'success' ? 'bg' : 'br';
    content.innerHTML = '<div class="dim" style="margin-bottom:12px;font-size:11px;text-transform:uppercase;letter-spacing:.4px">Run Result</div>'
      +'<div class="fm-card">'
      +'<div class="fm-key">Status</div><div class="fm-val"><span class="badge '+lsc+'">'+esc(log.status)+'</span></div>'
      +'<div class="fm-key">Run At</div><div class="fm-val">'+fmtDate(log.run_at)+'</div>'
      +'<div class="fm-key">Duration</div><div class="fm-val">'+log.duration_ms+'ms</div>'
      +'</div>'
      +(log.result
        ? '<div class="dim" style="margin-bottom:8px;font-size:11px;text-transform:uppercase;letter-spacing:.4px">Result</div>'
          +'<pre style="max-height:none;font-size:13px">'+esc(log.result)+'</pre>'
        : '')
      +(log.error
        ? '<div class="dim" style="margin-bottom:8px;font-size:11px;text-transform:uppercase;letter-spacing:.4px">Error</div>'
          +'<pre style="max-height:none;font-size:13px;color:#f85149">'+esc(log.error)+'</pre>'
        : '');
  }

  document.getElementById('task-maximize-btn').addEventListener('click', function() {
    var maximised = document.body.classList.toggle('task-maximized');
    this.innerHTML = maximised ? '&#x2715;' : '&#x26F6;';
    this.title = maximised ? 'Restore task view' : 'Maximise task view';
    if (maximised) history.pushState(null, '', location.href);
  });

  document.getElementById('task-result-maximize-btn').addEventListener('click', function() {
    var maximised = document.body.classList.toggle('task-result-maximized');
    this.innerHTML = maximised ? '&#x2715;' : '&#x26F6;';
    this.title = maximised ? 'Restore result view' : 'Maximise result view';
    if (maximised) history.pushState(null, '', location.href);
  });

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
    tree.innerHTML = '<div class="dim">Loading\u2026</div>';
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
        // Expand all directories so the target file is reachable
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
          document.querySelectorAll('.ftree-file.active').forEach(function(el) { el.classList.remove('active'); });
          fileEl.classList.add('active');
          if (currentGroup) {
            var folder = currentGroup.folder;
            var relPath = entry.path.startsWith(folder + '/') ? entry.path.slice(folder.length + 1) : entry.path;
            pushHash('groups/' + folder + '/files/' + relPath);
          }
          openFile(entry.path, entry.name);
        });
        container.appendChild(fileEl);
      }
    });
  }

  function parseFrontMatter(text) {
    if (!text.startsWith('---')) return null;
    var nl = text.indexOf('\\n');
    if (nl < 3) return null;
    var end = text.indexOf('\\n---', nl + 1);
    if (end === -1) return null;
    var fmText = text.slice(nl + 1, end);
    var bodyStart = end + 4;
    if (text[bodyStart] === '\\r') bodyStart++;
    if (text[bodyStart] === '\\n') bodyStart++;
    var meta = {};
    fmText.split('\\n').forEach(function(line) {
      line = line.replace(/\\r$/, '');
      var colon = line.indexOf(': ');
      if (colon > 0) meta[line.slice(0, colon).trim()] = line.slice(colon + 2).trim();
    });
    return { meta: meta, body: text.slice(bodyStart) };
  }

  function renderFrontMatter(meta) {
    var el = document.createElement('div');
    el.className = 'fm-card';
    var SKIP = { title: 1 }; // already shown as # heading in body
    Object.keys(meta).forEach(function(key) {
      if (SKIP[key]) return;
      var val = meta[key];
      var keyEl = document.createElement('div');
      keyEl.className = 'fm-key';
      keyEl.textContent = key;
      var valEl = document.createElement('div');
      valEl.className = 'fm-val';
      if (key === 'tags') {
        val.split(',').forEach(function(t) {
          var tag = document.createElement('span');
          tag.className = 'fm-tag';
          tag.textContent = t.trim();
          valEl.appendChild(tag);
        });
      } else if (key === 'doi') {
        var a = document.createElement('a');
        a.href = val.startsWith('http') ? val : 'https://doi.org/' + val;
        a.target = '_blank';
        a.className = 'fm-val';
        a.textContent = val;
        valEl.appendChild(a);
      } else if (key === 'url' && val.startsWith('http')) {
        var a = document.createElement('a');
        a.href = val;
        a.target = '_blank';
        a.className = 'fm-val';
        a.textContent = val;
        valEl.appendChild(a);
      } else {
        valEl.textContent = val;
      }
      el.appendChild(keyEl);
      el.appendChild(valEl);
    });
    return el;
  }

  async function openFile(filePath, name) {
    var view = document.getElementById('group-file-content');
    view.innerHTML = '<div class="dim">Loading\u2026</div>';
    try {
      var r = await fetch('/api/file?path='+encodeURIComponent(filePath));
      if (!r.ok) { view.innerHTML = '<div class="empty">Could not read file</div>'; return; }
      var text = await r.text();
      var header = '<div class="dim" style="margin-bottom:12px">'+esc(filePath)+'</div>';
      var ext = name.split('.').pop();
      if (ext === 'md' && window.marked) {
        var fm = parseFrontMatter(text);
        var mdDiv = document.createElement('div');
        mdDiv.className = 'md-body';
        if (fm && Object.keys(fm.meta).length > 0) mdDiv.appendChild(renderFrontMatter(fm.meta));
        var bodyEl = document.createElement('div');
        var parsedDiv = document.createElement('div');
        parsedDiv.innerHTML = window.marked.parse(fm ? fm.body : text);
        parsedDiv.querySelectorAll('a').forEach(function(a) {
          var href = a.getAttribute('href') || '';
          var isInternal = href.charAt(0) === '#' || (href.indexOf(location.origin) === 0 && href.indexOf('#groups/') !== -1);
          a.classList.add(isInternal ? 'link-internal' : 'link-external');
        });
        bodyEl.innerHTML = parsedDiv.innerHTML;
        mdDiv.appendChild(bodyEl);
        view.innerHTML = header;
        view.appendChild(mdDiv);
        if (window.hljs) mdDiv.querySelectorAll('pre code').forEach(function(el) { hljs.highlightElement(el); });
      } else if ((ext === 'json' || ext === 'ts' || ext === 'js') && window.hljs) {
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

  // ── Graph tab ──────────────────────────────────────────────────────────────

  var GRAPH_COLORS = ['#58a6ff','#3fb950','#d29922','#f85149','#bc8cff','#ff7b72','#79c0ff','#56d364','#e3b341','#db61a2'];
  var graphTagMap = {};
  var graphColorIdx = 0;
  var graphCy = null;
  var graphData = null;

  function tagColor(tag) {
    if (!tag) return '#484f58';
    if (!graphTagMap[tag]) { graphTagMap[tag] = GRAPH_COLORS[graphColorIdx++ % GRAPH_COLORS.length]; }
    return graphTagMap[tag];
  }

  async function loadGroupGraph() {
    if (!currentGroup) return;
    graphTagMap = {}; graphColorIdx = 0;
    var status = document.getElementById('graph-status');
    var legend = document.getElementById('graph-legend');
    var panel = document.getElementById('graph-node-panel');
    status.textContent = 'Loading\u2026';
    legend.innerHTML = '';
    panel.style.display = 'none';
    if (graphSim) { graphSim.stop(); graphSim = null; }
    if (graphCy) { graphCy.destroy(); graphCy = null; }
    document.getElementById('graph-container').innerHTML = '';
    try {
      var data = await fetch('/api/notes-graph?group=' + encodeURIComponent(currentGroup.folder)).then(function(r){ return r.json(); });
      graphData = data;
      if (!data.nodes.length) { status.textContent = 'No notes found.'; return; }
      renderGraph(data.nodes, data.edges, null);
    } catch(e) { status.textContent = 'Error loading graph.'; }
  }

  var graphSim = null; // d3 force simulation

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
      return { id: n.id, label: n.label, tags: n.tags, keywords: n.keywords, created: n.created, path: n.path, color: tagColor(dominantTag(n.tags)), x: Math.random() * 800 - 400, y: Math.random() * 600 - 300 };
    });
    var simLinks = [];
    edges.forEach(function(e) {
      if (idMap[e.source] !== undefined && idMap[e.target] !== undefined) {
        simLinks.push({ source: idMap[e.source], target: idMap[e.target] });
      }
    });

    // Build cytoscape elements with initial positions
    var elements = [];
    simNodes.forEach(function(n) {
      var faded = highlightIds && highlightIds.size > 0 && !highlightIds.has(n.id);
      elements.push({ group:'nodes', data:{ id:n.id, label:n.label, tags:n.tags, keywords:n.keywords, created:n.created, path:n.path, color:n.color }, classes: faded ? 'faded' : '', position:{ x:n.x, y:n.y } });
    });
    edges.forEach(function(e, i) {
      elements.push({ group:'edges', data:{ id:'e'+i, source:e.source, target:e.target } });
    });

    // Legend
    legend.innerHTML = '';
    Object.keys(graphTagMap).forEach(function(tag) {
      var item = document.createElement('div');
      item.className = 'graph-legend-item';
      item.innerHTML = '<div class="graph-legend-dot" style="background:'+graphTagMap[tag]+'"></div>'+esc(tag);
      legend.appendChild(item);
    });

    // Create cytoscape with preset layout (positions set by d3)
    graphCy = cytoscape({
      container: container,
      elements: elements,
      style: [
        { selector:'node', style:{ shape:'ellipse', width:18, height:18, 'background-color':'data(color)', 'border-width':1, 'border-color':'rgba(255,255,255,0.15)', 'text-opacity':0, label:'data(label)', color:'#e6edf3', 'font-size':11, 'text-valign':'bottom', 'text-halign':'center', 'text-margin-y':4, 'text-wrap':'wrap', 'text-max-width':120 } },
        { selector:'node.faded', style:{ opacity:0.12 } },
        { selector:'node.hovered', style:{ 'text-opacity':1, width:22, height:22, 'border-color':'#8b949e', 'border-width':2, opacity:1 } },
        { selector:'node:selected', style:{ 'text-opacity':1, 'border-width':2, 'border-color':'#f0f6fc', width:24, height:24 } },
        { selector:'node.dimmed', style:{ opacity:0.12 } },
        { selector:'node.dimmed.hovered', style:{ opacity:1, 'text-opacity':1 } },
        { selector:'node.neighbor', style:{ 'text-opacity':1, 'border-width':2, 'border-color':'#58a6ff', width:22, height:22 } },
        { selector:'edge', style:{ width:0.5, 'line-color':'#484f58', 'curve-style':'bezier', opacity:0.35 } },
        { selector:'edge.dimmed', style:{ opacity:0.06 } },
        { selector:'edge.highlighted', style:{ width:2, 'line-color':'#58a6ff', opacity:0.8 } },
        { selector:'node.hover-neighbor', style:{ 'text-opacity':1, 'border-color':'rgba(88,166,255,0.5)', 'border-width':2, opacity:1 } },
        { selector:'edge.hover-highlighted', style:{ width:1.5, 'line-color':'rgba(88,166,255,0.5)', opacity:0.6 } },
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
      // Get connected edges and neighbour nodes
      var connEdges = node.connectedEdges();
      var neighbors = node.neighborhood().nodes();
      // Dim everything
      graphCy.elements().addClass('dimmed');
      // Un-dim the selected node, its neighbours, and connecting edges
      node.removeClass('dimmed');
      neighbors.removeClass('dimmed').addClass('neighbor');
      connEdges.removeClass('dimmed').addClass('highlighted');
    }

    function clearHighlight() {
      graphCy.elements().removeClass('dimmed neighbor highlighted');
    }

    graphCy.on('select', 'node', function(evt) {
      highlightSubgraph(evt.target);
    });
    graphCy.on('unselect', 'node', function() {
      clearHighlight();
    });

    graphCy.on('tap', 'node', function(evt) {
      var d = evt.target.data();
      var panel = document.getElementById('graph-node-panel');
      document.getElementById('graph-node-id').textContent = d.id;
      var tagsHtml = (d.tags||[]).map(function(t){ return '<span class="fm-tag" style="background:'+tagColor(t)+';color:#0d1117;border-color:transparent">'+esc(t)+'</span>'; }).join(' ');
      var kwHtml = (d.keywords||[]).map(function(k){ return '<span class="fm-tag">'+esc(k)+'</span>'; }).join(' ');
      document.getElementById('graph-node-meta').innerHTML =
        '<div class="fm-key">Created</div><div class="fm-val">'+esc(d.created)+'</div>'
        +(tagsHtml ? '<div class="fm-key">Tags</div><div class="fm-val">'+tagsHtml+'</div>' : '')
        +(kwHtml   ? '<div class="fm-key">Keywords</div><div class="fm-val">'+kwHtml+'</div>' : '')
        +'<div class="fm-key">File</div><div class="fm-val"><a href="#" id="graph-open-link" style="color:#58a6ff;font-size:11px">Open in Files tab \u2192</a></div>';
      panel.style.display = 'block';
      document.getElementById('graph-open-link').onclick = function(e) {
        e.preventDefault();
        if (d.path) {
          var rel = currentGroup && d.path.startsWith(currentGroup.folder+'/') ? d.path.slice(currentGroup.folder.length+1) : d.path;
          switchTab('files', rel);
        }
      };
    });

    graphCy.on('mouseover', 'node', function(evt) {
      evt.target.addClass('hovered');
      evt.target.connectedEdges().addClass('hover-highlighted');
      evt.target.neighborhood().nodes().addClass('hover-neighbor');
    });
    graphCy.on('mouseout', 'node', function(evt) {
      evt.target.removeClass('hovered');
      evt.target.connectedEdges().removeClass('hover-highlighted');
      evt.target.neighborhood().nodes().removeClass('hover-neighbor');
    });

    graphCy.on('tap', function(evt) {
      if (evt.target === graphCy) {
        clearHighlight();
        document.getElementById('graph-node-panel').style.display = 'none';
      }
    });
  }

  document.getElementById('graph-search').addEventListener('input', function() {
    if (!graphData) return;
    var q = this.value.trim().toLowerCase();
    if (!q) { renderGraph(graphData.nodes, graphData.edges, null); return; }
    var hits = new Set();
    graphData.nodes.forEach(function(n) {
      if ([n.id, n.label].concat(n.tags||[]).concat(n.keywords||[]).some(function(t){ return t && t.toLowerCase().indexOf(q)!==-1; })) hits.add(n.id);
    });
    renderGraph(graphData.nodes, graphData.edges, hits);
  });

  // ── System ─────────────────────────────────────────────────────────────────

  async function loadSystem() {
    var sel = document.getElementById('sessions-body');
    var rsel = document.getElementById('routerstate-body');
    try {
      var sessions = await fetch('/api/sessions').then(function(r) { return r.json(); });
      if (!sessions.length) { sel.innerHTML = '<div class="empty">No sessions</div>'; }
      else {
        sel.innerHTML = '<div class="card"><table><thead><tr><th>Group Folder</th><th>Session ID</th></tr></thead><tbody>'
          + sessions.map(function(s) {
            return '<tr><td>'+esc(s.group_folder)+'</td><td class="dim" style="font-family:monospace">'+esc(s.session_id)+'</td></tr>';
          }).join('')
          + '</tbody></table></div>';
      }
    } catch(e) { sel.innerHTML = '<div class="empty">Error loading sessions</div>'; }

    try {
      var state = await fetch('/api/router-state').then(function(r) { return r.json(); });
      if (!state.length) { rsel.innerHTML = '<div class="empty">No state</div>'; }
      else {
        rsel.innerHTML = '<div class="card"><table><thead><tr><th>Key</th><th>Value</th></tr></thead><tbody>'
          + state.map(function(row) {
            return '<tr><td>'+esc(row.key)+'</td><td class="dim" style="font-family:monospace;word-break:break-all">'+esc(row.value)+'</td></tr>';
          }).join('')
          + '</tbody></table></div>';
      }
    } catch(e) { rsel.innerHTML = '<div class="empty">Error loading router state</div>'; }
  }

  // ── Feeds ──────────────────────────────────────────────────────────────────

  async function loadFeeds() {
    var el = document.getElementById('feeds-body');
    el.innerHTML = 'Loading\u2026';
    try {
      var data = await fetch('/api/rss-feeds').then(function(r) { return r.json(); });
      if (!data.length) { el.innerHTML = '<div class="empty">No RSS feed subscriptions</div>'; return; }
      el.innerHTML = '<div class="card"><table><thead><tr><th>Feed</th><th>Group</th><th>Schedule</th><th>Interests</th><th>Next Check</th></tr></thead><tbody>'
        + data.map(function(f) {
          var label = esc(f.title || f.url);
          var url = esc(f.url);
          var schedStr = f.schedule_type === 'interval'
            ? (parseInt(f.schedule_value) >= 3600000 ? Math.round(parseInt(f.schedule_value)/3600000)+'h' : Math.round(parseInt(f.schedule_value)/60000)+'m')
            : esc(f.schedule_value);
          return '<tr>'
            +'<td><a href="'+url+'" target="_blank" style="color:#58a6ff;text-decoration:none">'+label+'</a><div class="dim" style="font-size:11px;margin-top:2px">'+url+'</div></td>'
            +'<td class="dim">'+esc(f.group_folder)+'</td>'
            +'<td class="dim">'+esc(f.schedule_type)+': '+schedStr+'</td>'
            +'<td class="dim" style="max-width:200px">'+esc(f.interest || '\u2014')+'</td>'
            +'<td class="dim">'+(f.next_check ? fmtDate(f.next_check) : '\u2014')+'</td>'
            +'</tr>';
        }).join('')
        + '</tbody></table></div>';
    } catch(e) { el.innerHTML = '<div class="empty">Error loading feeds</div>'; }
  }

  // ── Database Explorer ──────────────────────────────────────────────────────

  var dbCurrentTable = null;
  var dbOffset = 0;
  var dbLimit = 50;
  var dbTotal = 0;
  var dbSearchTimer = null;

  async function loadDbTables() {
    var el = document.getElementById('db-table-list');
    // Keep the heading, clear everything else
    el.innerHTML = '<div class="dim" style="font-size:11px;padding:4px 6px;margin-bottom:4px;font-weight:600;letter-spacing:.4px;text-transform:uppercase">Tables</div>';
    try {
      var data = await fetch('/api/db/tables').then(function(r) { return r.json(); });
      if (!data.length) {
        el.innerHTML += '<div class="empty">No tables</div>';
        return;
      }
      data.forEach(function(t) {
        var item = document.createElement('div');
        item.className = 'db-table-item';
        item.dataset.table = t.name;
        item.innerHTML = '<span>'+esc(t.name)+'</span><span class="dim" style="font-size:11px">'+t.count+'</span>';
        item.addEventListener('click', function() {
          document.querySelectorAll('.db-table-item').forEach(function(x) { x.classList.remove('active'); });
          item.classList.add('active');
          dbCurrentTable = t.name;
          dbOffset = 0;
          document.getElementById('db-search').value = '';
          loadDbTable();
        });
        el.appendChild(item);
      });
    } catch(e) {
      el.innerHTML += '<div class="empty">Error loading tables</div>';
    }
  }

  async function loadDbTable() {
    if (!dbCurrentTable) return;
    var body = document.getElementById('db-table-body');
    var header = document.getElementById('db-table-header');
    var pagination = document.getElementById('db-pagination');
    var search = document.getElementById('db-search').value.trim();
    body.innerHTML = '<div class="dim" style="padding:16px">Loading\u2026</div>';
    header.style.display = '';
    document.getElementById('db-table-name').textContent = dbCurrentTable;
    try {
      var reqUrl = '/api/db/table?name='+encodeURIComponent(dbCurrentTable)+'&limit='+dbLimit+'&offset='+dbOffset;
      if (search) reqUrl += '&search='+encodeURIComponent(search);
      var data = await fetch(reqUrl).then(function(r) { return r.json(); });
      dbTotal = data.total;
      document.getElementById('db-table-count').textContent = data.total + ' row'+(data.total===1?'':'s')+(search?' (filtered)':'');
      if (!data.columns.length) {
        body.innerHTML = '<div class="empty">No columns found</div>';
        pagination.style.display = 'none';
        return;
      }
      var html = '<div class="card" style="padding:0;overflow:auto"><table>'
        +'<thead><tr>'+data.columns.map(function(c) { return '<th>'+esc(c)+'</th>'; }).join('')+'</tr></thead>'
        +'<tbody>';
      if (!data.rows.length) {
        html += '<tr><td colspan="'+data.columns.length+'" style="text-align:center;color:#8b949e;font-style:italic;padding:24px">No rows</td></tr>';
      } else {
        html += data.rows.map(function(row) {
          return '<tr>'+data.columns.map(function(c) {
            var v = row[c];
            if (v == null) return '<td><span class="db-null">NULL</span></td>';
            var s = String(v);
            if (s.length > 120) {
              return '<td style="max-width:280px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap" title="'+esc(s)+'">'+esc(s.slice(0,120))+'\u2026</td>';
            }
            return '<td style="max-width:280px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap">'+esc(s)+'</td>';
          }).join('')+'</tr>';
        }).join('');
      }
      html += '</tbody></table></div>';
      body.innerHTML = html;
      var totalPages = Math.ceil(dbTotal / dbLimit) || 1;
      var currentPage = Math.floor(dbOffset / dbLimit) + 1;
      document.getElementById('db-page-info').textContent = 'Page '+currentPage+' of '+totalPages;
      document.getElementById('db-prev').disabled = dbOffset === 0;
      document.getElementById('db-next').disabled = dbOffset + dbLimit >= dbTotal;
      pagination.style.display = 'flex';
    } catch(e) {
      body.innerHTML = '<div class="empty">Error loading table data</div>';
      pagination.style.display = 'none';
    }
  }

  document.getElementById('db-prev').addEventListener('click', function() {
    if (dbOffset > 0) { dbOffset = Math.max(0, dbOffset - dbLimit); loadDbTable(); }
  });
  document.getElementById('db-next').addEventListener('click', function() {
    if (dbOffset + dbLimit < dbTotal) { dbOffset += dbLimit; loadDbTable(); }
  });
  document.getElementById('db-search').addEventListener('input', function() {
    clearTimeout(dbSearchTimer);
    dbSearchTimer = setTimeout(function() { dbOffset = 0; loadDbTable(); }, 350);
  });

  // ── Boot ───────────────────────────────────────────────────────────────────
  restoreFromHash();
});
</script>
<div id="mobile-nav">
  <a id="mnav-groups" href="#groups">Groups</a>
  <a id="mnav-feeds" href="#feeds">Feeds</a>
  <a id="mnav-system" href="#system">System</a>
  <a id="mnav-database" href="#database">Database</a>
</div>
</body>
</html>`;

// ---------------------------------------------------------------------------
// HTTP server
// ---------------------------------------------------------------------------

function sendJson(res: ServerResponse, data: unknown, status = 200): void {
  const body = JSON.stringify(data);
  res.writeHead(status, {
    'Content-Type': 'application/json',
    'X-Content-Type-Options': 'nosniff',
    'Cache-Control': 'no-store',
  });
  res.end(body);
}

function readBody(req: IncomingMessage): Promise<string> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    req.on('data', (c) => chunks.push(c));
    req.on('end', () => resolve(Buffer.concat(chunks).toString('utf-8')));
    req.on('error', reject);
  });
}

function guessChannel(jid: string): string {
  if (jid.endsWith('@g.us') || jid.endsWith('@s.whatsapp.net'))
    return 'whatsapp';
  if (jid.startsWith('tg:')) return 'telegram';
  if (jid.startsWith('dc:')) return 'deltachat';
  if (jid.startsWith('sl:')) return 'slack';
  return 'unknown';
}

interface FileEntry {
  name: string;
  path: string;
  isDir: boolean;
  children?: FileEntry[];
}

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
    const abs = path.join(dir, name);
    const rel = path.join(relBase, name);
    let stat: fs.Stats;
    try {
      stat = fs.statSync(abs);
    } catch {
      continue;
    }
    if (stat.isDirectory()) {
      dirs.push({
        name,
        path: rel,
        isDir: true,
        children: readDirEntries(abs, rel),
      });
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
    .map((g) => ({
      name: g,
      entries: readDirEntries(path.join(GROUPS_DIR, g), g),
    }));
}

function safeReadFile(relPath: string): string | null {
  // Prevent path traversal — resolved path must stay within GROUPS_DIR
  const abs = path.resolve(GROUPS_DIR, relPath);
  if (!abs.startsWith(path.resolve(GROUPS_DIR) + path.sep)) return null;
  try {
    return fs.readFileSync(abs, 'utf-8');
  } catch {
    return null;
  }
}

function parseNoteFrontmatter(text: string): {
  id: string;
  created: string;
  keywords: string[];
  tags: string[];
  links: string[];
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
    if (!m) return [];
    return m[1]
      .split(',')
      .map((s) => s.trim())
      .filter(Boolean);
  };
  if (!fields['id']) return null;
  return {
    id: fields['id'],
    created: fields['created'] ?? '',
    keywords: parseList(fields['keywords']),
    tags: parseList(fields['tags']),
    links: parseList(fields['links']),
  };
}

export function startWebUi(
  port: number,
  host = '127.0.0.1',
  opts: { sendMessage?: (jid: string, text: string) => Promise<void> } = {},
): Server {
  const server = createServer(async (req, res) => {
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

      // GET /api/groups
      if (req.method === 'GET' && pathname === '/api/groups') {
        const groups = getAllRegisteredGroups();
        const result = Object.entries(groups).map(([jid, g]) => ({
          jid,
          name: g.name,
          folder: g.folder,
          trigger: g.trigger,
          added_at: g.added_at,
          isMain: g.isMain ?? false,
          requiresTrigger: g.requiresTrigger ?? true,
          trustedGroup: g.trustedGroup ?? false,
          channel: guessChannel(jid),
        }));
        sendJson(res, result);
        return;
      }

      // GET /api/chats
      if (req.method === 'GET' && pathname === '/api/chats') {
        const chats = getAllChats().filter((c) => c.jid !== '__group_sync__');
        const groups = getAllRegisteredGroups();
        const registeredJids = new Set(Object.keys(groups));
        const result = chats.map((c) => ({
          jid: c.jid,
          name: c.name || c.jid,
          last_message_time: c.last_message_time,
          channel: c.channel || guessChannel(c.jid),
          is_group: c.is_group,
          isRegistered: registeredJids.has(c.jid),
        }));
        sendJson(res, result);
        return;
      }

      // GET /api/messages?jid=&limit=
      if (req.method === 'GET' && pathname === '/api/messages') {
        const jid = url.searchParams.get('jid');
        if (!jid) {
          sendJson(res, { error: 'jid required' }, 400);
          return;
        }
        const limit = Math.min(
          parseInt(url.searchParams.get('limit') || '150', 10) || 150,
          500,
        );
        const messages = getChatMessages(jid, limit);
        sendJson(res, messages);
        return;
      }

      // GET /api/tasks
      if (req.method === 'GET' && pathname === '/api/tasks') {
        sendJson(res, getAllTasks());
        return;
      }

      // GET /api/rss-feeds
      if (req.method === 'GET' && pathname === '/api/rss-feeds') {
        sendJson(res, getAllRssFeeds());
        return;
      }

      // GET /api/files
      if (req.method === 'GET' && pathname === '/api/files') {
        sendJson(res, listGroupFiles());
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
        res.writeHead(200, {
          'Content-Type': 'text/plain; charset=utf-8',
          'Cache-Control': 'no-store',
        });
        res.end(content);
        return;
      }

      // GET /api/notes-graph?group={folder}
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
        };
        const nodes: NoteNode[] = [];
        const nodeIds = new Set<string>();
        const fmMap = new Map<
          string,
          ReturnType<typeof parseNoteFrontmatter>
        >();
        for (const file of noteFiles) {
          const abs = path.join(notesDir, file);
          let text: string;
          try {
            text = fs.readFileSync(abs, 'utf-8');
          } catch {
            continue;
          }
          const fm = parseNoteFrontmatter(text);
          if (!fm) continue;
          fmMap.set(file, fm);
          nodes.push({
            id: fm.id,
            label: fm.id
              .replace(/^MEM-\d{4}-\d{2}-\d{2}-/, '')
              .replace(/-/g, ' '),
            tags: fm.tags,
            keywords: fm.keywords,
            created: fm.created,
            path: folder + '/memory/notes/' + file,
          });
          nodeIds.add(fm.id);
        }
        const edges: Array<{ source: string; target: string }> = [];
        const seen = new Set<string>();
        for (const fm of fmMap.values()) {
          if (!fm) continue;
          for (const tgt of fm.links) {
            if (!nodeIds.has(fm.id) || !nodeIds.has(tgt)) continue;
            const key = [fm.id, tgt].sort().join('||');
            if (!seen.has(key)) {
              seen.add(key);
              edges.push({ source: fm.id, target: tgt });
            }
          }
        }
        sendJson(res, { nodes, edges });
        return;
      }

      // GET /api/sessions
      if (req.method === 'GET' && pathname === '/api/sessions') {
        const rows = getAllSessions();
        sendJson(
          res,
          Object.entries(rows).map(([group_folder, session_id]) => ({
            group_folder,
            session_id,
          })),
        );
        return;
      }

      // GET /api/router-state
      if (req.method === 'GET' && pathname === '/api/router-state') {
        const rows = getAllRouterStateRows();
        sendJson(res, rows);
        return;
      }

      // GET /api/task-logs?task_id=
      if (req.method === 'GET' && pathname === '/api/task-logs') {
        const taskId = url.searchParams.get('task_id');
        if (!taskId) {
          sendJson(res, { error: 'task_id required' }, 400);
          return;
        }
        sendJson(res, getTaskRunLogs(taskId, 50));
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
        const limit = Math.min(
          parseInt(url.searchParams.get('limit') || '50', 10) || 50,
          200,
        );
        const offset = Math.max(
          parseInt(url.searchParams.get('offset') || '0', 10) || 0,
          0,
        );
        const search = url.searchParams.get('search') || undefined;
        sendJson(res, getDbTableData(name, limit, offset, search));
        return;
      }

      // POST /api/chat — inject a message into a registered group
      if (req.method === 'POST' && pathname === '/api/chat') {
        let parsed: unknown;
        try {
          parsed = JSON.parse(await readBody(req));
        } catch {
          sendJson(res, { error: 'Invalid JSON' }, 400);
          return;
        }
        if (
          typeof parsed !== 'object' ||
          parsed === null ||
          typeof (parsed as Record<string, unknown>).jid !== 'string' ||
          typeof (parsed as Record<string, unknown>).message !== 'string'
        ) {
          sendJson(res, { error: 'jid and message required' }, 400);
          return;
        }
        const { jid, message } = parsed as { jid: string; message: string };

        const groups = getAllRegisteredGroups();
        const group = groups[jid];
        if (!group) {
          sendJson(res, { error: 'Group not registered' }, 400);
          return;
        }

        // Prepend trigger if the group requires one
        const needsTrigger =
          !group.isMain &&
          !group.trustedGroup &&
          group.requiresTrigger !== false;
        const content = needsTrigger
          ? `@${ASSISTANT_NAME} ${message}`
          : message;

        const msgId = `web-${Date.now()}-${Math.random().toString(36).slice(2)}`;
        const timestamp = new Date().toISOString();

        storeMessage({
          id: msgId,
          chat_jid: jid,
          sender: 'web-ui',
          sender_name: 'Web UI',
          content,
          timestamp,
          is_from_me: false,
          is_bot_message: false,
        });

        logger.debug({ jid, msgId }, 'Web UI injected message');

        // Echo the user message to the native channel so the other side sees it
        if (opts.sendMessage) {
          opts.sendMessage(jid, `[web] ${message}`).catch((err: unknown) => {
            logger.warn({ err, jid }, 'Failed to echo web message to channel');
          });
        }

        sendJson(res, { ok: true, id: msgId, timestamp });
        return;
      }

      res.writeHead(404, { 'Content-Type': 'text/plain' });
      res.end('Not found');
    } catch (err) {
      logger.error({ err, pathname }, 'Web UI request error');
      sendJson(res, { error: 'Internal server error' }, 500);
    }
  });

  server.listen(port, host, () => {
    logger.info(
      { port, host },
      'Web UI started — visit http://localhost:' + port,
    );
  });

  return server;
}
