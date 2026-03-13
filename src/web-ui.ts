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
  getAllSessions,
  getAllTasks,
  getChatMessages,
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
.msg.bot .msg-body{color:#79c0ff}.msg.me .msg-body{color:#56d364}
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
</style>
</head>
<body>
<nav>
  <h1>NanoClaw</h1>
  <a id="nav-groups" href="#groups">Groups</a>
  <a id="nav-system" href="#system">System</a>
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
          <div id="group-file-view" style="flex:1;overflow:auto;background:#161b22;border:1px solid #30363d;border-radius:8px;padding:16px">
            <div class="empty">Select a file to view its contents</div>
          </div>
        </div>
      </div>
    </div>

  </div>

  <!-- System -->
  <div id="section-system" class="section">
    <h2>Sessions</h2>
    <div id="sessions-body">Loading...</div>
    <h2 style="margin-top:24px">Router State</h2>
    <div id="routerstate-body">Loading...</div>
  </div>
</main>

<script src="https://cdn.jsdelivr.net/npm/marked@12/marked.min.js"></script>
<script src="https://cdnjs.cloudflare.com/ajax/libs/highlight.js/11.9.0/highlight.min.js"></script>
<script>
document.addEventListener('DOMContentLoaded', function() {
  var currentGroup = null;   // group object from /api/groups
  var currentTab = 'chat';
  var pollTimer = null;

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

  // ── Top-level nav ──────────────────────────────────────────────────────────

  function show(name) {
    document.querySelectorAll('.section').forEach(function(s) { s.classList.remove('active'); });
    document.querySelectorAll('nav a').forEach(function(a) { a.classList.remove('active'); });
    var sec = document.getElementById('section-'+name);
    var nav = document.getElementById('nav-'+name);
    if (sec) sec.classList.add('active');
    if (nav) nav.classList.add('active');
    clearInterval(pollTimer); pollTimer = null;
    if (name === 'groups') showGroupList();
    if (name === 'system') loadSystem();
  }

  document.querySelectorAll('nav a').forEach(function(a) {
    a.addEventListener('click', function(e) {
      e.preventDefault();
      show((a.getAttribute('href') || '#groups').replace('#',''));
    });
  });

  // ── Group list ─────────────────────────────────────────────────────────────

  function showGroupList() {
    clearInterval(pollTimer); pollTimer = null;
    currentGroup = null;
    document.getElementById('groups-list').style.display = '';
    document.getElementById('group-detail').style.display = 'none';
    loadGroups();
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
          +'<span>'+(g.isMain ? '<span class="badge bb">main</span> ' : '')+'<span class="badge bg">'+esc(g.channel)+'</span></span>'
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

  function switchTab(tab) {
    clearInterval(pollTimer); pollTimer = null;
    currentTab = tab;
    document.querySelectorAll('#group-subnav [data-tab]').forEach(function(a) {
      a.classList.toggle('active', a.dataset.tab === tab);
    });
    document.getElementById('group-tab-chat').style.display  = tab === 'chat'  ? '' : 'none';
    document.getElementById('group-tab-tasks').style.display = tab === 'tasks' ? '' : 'none';
    document.getElementById('group-tab-files').style.display = tab === 'files' ? '' : 'none';
    if (tab === 'chat')  loadGroupChat();
    if (tab === 'tasks') loadGroupTasks();
    if (tab === 'files') loadGroupFiles();
  }

  // ── Chat tab ───────────────────────────────────────────────────────────────

  async function loadGroupChat() {
    var g = currentGroup;
    var sendArea = document.getElementById('group-send-area');
    sendArea.innerHTML = g.requiresTrigger === false || g.isMain
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
        return '<div class="msg '+cls+'"><div class="msg-meta">'+who+' &middot; '+fmtTime(m.timestamp)+'</div><div class="msg-body">'+esc(m.content)+'</div></div>';
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

  async function loadGroupFiles() {
    if (!currentGroup) return;
    var tree = document.getElementById('group-file-tree');
    var view = document.getElementById('group-file-view');
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
          openFile(entry.path, entry.name);
        });
        container.appendChild(fileEl);
      }
    });
  }

  async function openFile(filePath, name) {
    var view = document.getElementById('group-file-view');
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

  // ── Boot ───────────────────────────────────────────────────────────────────
  show('groups');
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
        const needsTrigger = !group.isMain && group.requiresTrigger !== false;
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
