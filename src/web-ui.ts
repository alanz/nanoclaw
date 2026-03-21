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
.md-body a{color:#58a6ff}
.md-body table{border-collapse:collapse;width:100%;margin:8px 0}
.md-body th,.md-body td{border:1px solid #30363d;padding:6px 12px}
.md-body th{background:#21262d}
.md-body hr{border:none;border-top:1px solid #30363d;margin:16px 0}
.subnav{display:flex;gap:4px;margin-bottom:20px;border-bottom:1px solid #30363d;padding-bottom:0}
.subnav a{padding:7px 14px;font-size:13px;color:#8b949e;cursor:pointer;text-decoration:none;border-bottom:2px solid transparent;margin-bottom:-1px;user-select:none}
.subnav a:hover{color:#e6edf3}
.subnav a.active{color:#e6edf3;border-bottom-color:#58a6ff}
#db-search:focus{border-color:#58a6ff;outline:none}
.db-table-item{padding:5px 8px;font-size:12px;color:#8b949e;cursor:pointer;border-radius:4px;display:flex;justify-content:space-between;align-items:center;user-select:none}
.db-table-item:hover,.db-table-item.active{background:#21262d;color:#e6edf3}
.db-null{color:#484f58;font-style:italic}
button:disabled{opacity:.4;cursor:not-allowed}
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
      </div>

      <!-- Chat tab -->
      <div id="group-tab-chat">
        <div id="group-msgs" class="msgs"></div>
        <div id="group-send-area"></div>
      </div>

      <!-- Tasks tab -->
      <div id="group-tab-tasks" style="display:none">
        <div id="group-tasks-body">Loading...</div>
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
<script>
document.addEventListener('DOMContentLoaded', function() {
  var currentGroup = null;   // group object from /api/groups
  var currentTab = 'chat';
  var pollTimer = null;
  var skipHashUpdate = false;

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

  window.addEventListener('popstate', restoreFromHash);

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
    if (name === 'groups') showGroupListInternal();
    if (name === 'feeds') loadFeeds();
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
    if (row) toggleLogs(row.dataset.taskId);
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
    if (tab !== 'files' && document.body.classList.contains('file-maximized')) {
      document.body.classList.remove('file-maximized');
      var btn = document.getElementById('file-maximize-btn');
      if (btn) { btn.innerHTML = '&#x26F6;'; btn.title = 'Maximise file view'; }
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
      el.innerHTML = '<div class="card"><table><thead><tr><th>Schedule</th><th>Status</th><th>Next Run</th><th>Last Run</th><th>Prompt</th><th></th></tr></thead><tbody>'
        + data.map(function(t) {
          var sc = t.status==='active' ? 'bg' : t.status==='paused' ? 'by' : 'br';
          return '<tr class="log-row" data-task-id="'+esc(t.id)+'">'
            +'<td class="dim">'+esc(t.schedule_type)+': '+esc(t.schedule_value)+'</td>'
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

  // ── Files tab ──────────────────────────────────────────────────────────────

  document.getElementById('file-maximize-btn').addEventListener('click', function() {
    var maximised = document.body.classList.toggle('file-maximized');
    this.innerHTML = maximised ? '&#x2715;' : '&#x26F6;';
    this.title = maximised ? 'Restore file view' : 'Maximise file view';
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
        var mdDiv = document.createElement('div');
        mdDiv.className = 'md-body';
        mdDiv.innerHTML = window.marked.parse(text);
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
