// Big Dog dashboard — vanilla JS, talks to the REST API in src/server.ts.

const $ = (sel) => document.querySelector(sel);
let state = null;

// ── Helpers ──────────────────────────────────────────────────────────────
async function api(path, opts = {}) {
  const res = await fetch(path, {
    headers: { 'Content-Type': 'application/json' },
    ...opts,
    body: opts.body ? JSON.stringify(opts.body) : undefined,
  });
  if (!res.ok) {
    const err = await res.json().catch(() => ({ error: res.statusText }));
    throw new Error(err.error || 'request failed');
  }
  return res.json();
}

function toast(msg) {
  const t = $('#toast');
  t.textContent = msg;
  t.classList.add('show');
  setTimeout(() => t.classList.remove('show'), 2600);
}

function esc(s = '') {
  return s.replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
}

function fmtDate(iso) {
  if (!iso) return '';
  const d = new Date(iso);
  return d.toLocaleString([], { month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit' });
}

function money(v) {
  return v == null ? '—' : '$' + Number(v).toLocaleString();
}

// Minimal markdown → HTML (headings, bold, lists).
function md(text = '') {
  const lines = esc(text).split('\n');
  let html = '';
  let inList = false;
  for (const line of lines) {
    if (/^- /.test(line)) {
      if (!inList) { html += '<ul>'; inList = true; }
      html += '<li>' + line.slice(2) + '</li>';
      continue;
    }
    if (inList) { html += '</ul>'; inList = false; }
    if (/^## /.test(line)) html += '<h2>' + line.slice(3) + '</h2>';
    else if (/^### /.test(line)) html += '<h3>' + line.slice(4) + '</h3>';
    else if (line.trim() === '') html += '<br/>';
    else html += '<p>' + line + '</p>';
  }
  if (inList) html += '</ul>';
  return html.replace(/\*\*(.+?)\*\*/g, '<strong>$1</strong>');
}

// ── Data load ────────────────────────────────────────────────────────────
async function load() {
  state = await api('/api/state');
  $('#tagline').textContent = `What's up, ${state.owner.name}!?`;
  const pill = $('#brain-pill');
  pill.textContent = state.brainLive ? `brain: ${state.backend}` : 'brain: offline';
  pill.className = 'pill ' + (state.brainLive ? 'live' : 'offline');
  renderAll();
}

function renderAll() {
  const unread = state.messages.filter((m) => m.unread).length;
  $('#inbox-count').textContent = unread || '';
  $('#pipeline-count').textContent = state.deals.filter((d) => d.stage !== 'won' && d.stage !== 'lost').length || '';
  $('#cal-count').textContent = state.events.length || '';
  $('#drafts-count').textContent = state.drafts.length || '';
  renderInbox();
  renderPipeline();
  renderCalendar();
  renderDrafts();
}

// ── Inbox ────────────────────────────────────────────────────────────────
function renderInbox() {
  const el = $('#inbox');
  const msgs = state.messages;
  if (!msgs.length) { el.innerHTML = '<div class="empty">Inbox empty. Hit “Sync &amp; work the inbox”.</div>'; return; }
  el.innerHTML = msgs
    .map((m) => {
      const p = m.priority || 'cold';
      return `
      <div class="card ${p}">
        <div class="row">
          <div>
            <strong>${esc(m.fromName)}</strong>
            <span class="muted small">&lt;${esc(m.fromEmail)}&gt;</span>
            <div>${esc(m.subject)}</div>
            ${m.summary ? `<div class="muted small">🐕 ${esc(m.summary)}</div>` : ''}
          </div>
          <div style="text-align:right;white-space:nowrap">
            <span class="tag ${p}">${p}</span>
            <div class="muted small">${fmtDate(m.date)}</div>
          </div>
        </div>
        <div class="msg-body" id="body-${m.id}">${esc(m.body)}</div>
        <div class="actions">
          <button class="btn small ghost" onclick="toggleBody('${m.id}')">Read</button>
          <button class="btn small primary" onclick="draftReply('${m.id}')">🐕 Draft my reply</button>
        </div>
      </div>`;
    })
    .join('');
}

window.toggleBody = (id) => {
  $('#body-' + id).classList.toggle('open');
  api(`/api/messages/${id}/read`, { method: 'POST' }).catch(() => {});
};

window.draftReply = async (id) => {
  toast('Big Dog is drafting…');
  try {
    const { autoSent } = await api(`/api/messages/${id}/draft`, { method: 'POST' });
    await load();
    if (autoSent) { toast('Sent it. 🐕'); }
    else { switchTab('drafts'); toast('Draft ready — review it.'); }
  } catch (e) { toast('Error: ' + e.message); }
};

// ── Pipeline ─────────────────────────────────────────────────────────────
function renderPipeline() {
  const el = $('#pipeline');
  const stages = state.stages;
  const board = stages
    .map((stage) => {
      const inStage = state.deals.filter((d) => d.stage === stage);
      const cards = inStage
        .map(
          (d) => `
        <div class="deal">
          <h4>${esc(d.title)}</h4>
          <div class="muted small">${esc(d.company || d.contactName)} · ${money(d.value)}</div>
          <div class="next">→ ${esc(d.nextStep)}${d.nextStepDue ? ` (by ${d.nextStepDue})` : ''}</div>
          <select onchange="moveDeal('${d.id}', this.value)">
            ${stages.map((s) => `<option value="${s}" ${s === d.stage ? 'selected' : ''}>${s}</option>`).join('')}
          </select>
        </div>`,
        )
        .join('');
      return `<div class="col"><h3>${stage} (${inStage.length})</h3>${cards}</div>`;
    })
    .join('');
  el.innerHTML = `<div class="board">${board}</div>`;
}

window.moveDeal = async (id, stage) => {
  try { await api(`/api/deals/${id}`, { method: 'PATCH', body: { stage } }); await load(); toast('Deal moved.'); }
  catch (e) { toast('Error: ' + e.message); }
};

// ── Calendar ─────────────────────────────────────────────────────────────
function renderCalendar() {
  const el = $('#calendar');
  const evts = [...state.events].sort((a, b) => a.start.localeCompare(b.start));
  const list = evts.length
    ? evts
        .map(
          (e) => `
      <div class="card">
        <div class="evt">
          <div class="when">${fmtDate(e.start)}</div>
          <div>
            <strong>${esc(e.title)}</strong>
            <div class="muted small">${esc(e.location)} ${e.attendees ? '· ' + esc(e.attendees) : ''}</div>
            ${e.notes ? `<div class="muted small">${esc(e.notes)}</div>` : ''}
          </div>
        </div>
      </div>`,
        )
        .join('')
    : '<div class="empty">Nothing scheduled. Meeting requests land here automatically.</div>';
  const cal = state.calcom || {};
  const calBtns = [
    cal.bookingUrl ? `<a class="btn small primary" href="${esc(cal.bookingUrl)}" target="_blank">📅 Book a call</a>` : '',
    cal.configured ? `<button class="btn small" onclick="syncCalcom()">↻ Sync Cal.com</button>` : '',
    `<a class="btn small" href="/calendar.ics">⬇ Subscribe (.ics)</a>`,
  ].join(' ');
  el.innerHTML = `
    <div class="row" style="margin-bottom:14px">
      <h2>One calendar${cal.configured ? ' <span class="muted small">· Cal.com connected</span>' : ''}</h2>
      <div>${calBtns}</div>
    </div>${list}`;
}

window.syncCalcom = async () => {
  try { const r = await api('/api/calcom/sync', { method: 'POST' }); await load(); switchTab('calendar'); toast(`Pulled ${r.bookings} Cal.com booking(s).`); }
  catch (e) { toast('Error: ' + e.message); }
};

// ── Drafts ───────────────────────────────────────────────────────────────
function renderDrafts() {
  const el = $('#drafts');
  if (!state.drafts.length) { el.innerHTML = '<div class="empty">No drafts waiting. Draft a reply from the Inbox.</div>'; return; }
  el.innerHTML = state.drafts
    .map(
      (d) => `
    <div class="card">
      <div class="muted small">To: ${esc(d.toEmails)}</div>
      <input class="subj" id="subj-${d.id}" value="${esc(d.subject)}" />
      <textarea class="edit" id="draft-${d.id}">${esc(d.body)}</textarea>
      ${d.rationale ? `<div class="muted small" style="margin-top:6px">🐕 ${esc(d.rationale)}</div>` : ''}
      <div class="actions">
        <button class="btn small good" onclick="sendDraft('${d.id}')">Send as me</button>
        <button class="btn small ghost" onclick="discardDraft('${d.id}')">Discard</button>
      </div>
    </div>`,
    )
    .join('');
}

window.sendDraft = async (id) => {
  const body = $('#draft-' + id).value;
  const subject = $('#subj-' + id).value;
  try {
    const r = await api(`/api/drafts/${id}/send`, { method: 'POST', body: { body, subject } });
    await load();
    toast(r.note || 'Sent. 🐕');
  } catch (e) { toast('Error: ' + e.message); }
};

window.discardDraft = async (id) => {
  try { await api(`/api/drafts/${id}/discard`, { method: 'POST' }); await load(); toast('Discarded.'); }
  catch (e) { toast('Error: ' + e.message); }
};

// ── Digest ───────────────────────────────────────────────────────────────
async function renderDigest() {
  const el = $('#digest');
  el.innerHTML = `
    <div class="row" style="margin-bottom:14px">
      <h2>Morning brief</h2>
      <button class="btn small primary" onclick="genDigest()">🐕 Brief me</button>
    </div>
    <div class="card markdown" id="digest-body"><div class="muted">Hit “Brief me” for today's rundown.</div></div>`;
}

window.genDigest = async () => {
  $('#digest-body').innerHTML = '<div class="muted">Big Dog is pulling it together…</div>';
  try {
    const { content } = await api('/api/digest', { method: 'POST' });
    $('#digest-body').innerHTML = md(content);
  } catch (e) { $('#digest-body').innerHTML = 'Error: ' + esc(e.message); }
};

// ── Chat ─────────────────────────────────────────────────────────────────
function renderChat() {
  const el = $('#chat');
  if (el.dataset.init) return;
  el.dataset.init = '1';
  el.innerHTML = `
    <div class="chatlog" id="chatlog">
      <div class="bubble dog">What's up, ${esc(state.owner.name)}! Ask me anything about your deals, your day, or who's going cold.</div>
    </div>
    <div class="chat-input">
      <input id="chat-q" placeholder="e.g. which deals are at risk this week?" />
      <button class="btn primary" onclick="ask()">Ask</button>
    </div>`;
  $('#chat-q').addEventListener('keydown', (e) => { if (e.key === 'Enter') ask(); });
}

window.ask = async () => {
  const input = $('#chat-q');
  const q = input.value.trim();
  if (!q) return;
  const log = $('#chatlog');
  log.innerHTML += `<div class="bubble me">${esc(q)}</div>`;
  input.value = '';
  const thinking = document.createElement('div');
  thinking.className = 'bubble dog';
  thinking.textContent = '…';
  log.appendChild(thinking);
  log.scrollIntoView({ block: 'end' });
  try {
    const { answer } = await api('/api/chat', { method: 'POST', body: { question: q } });
    thinking.innerHTML = md(answer);
  } catch (e) { thinking.textContent = 'Error: ' + e.message; }
};

// ── Tabs ─────────────────────────────────────────────────────────────────
function switchTab(name) {
  document.querySelectorAll('.tab').forEach((t) => t.classList.toggle('active', t.dataset.tab === name));
  document.querySelectorAll('.panel').forEach((p) => p.classList.toggle('active', p.id === name));
  if (name === 'digest') renderDigest();
  if (name === 'chat') renderChat();
}
document.querySelectorAll('.tab').forEach((t) => t.addEventListener('click', () => switchTab(t.dataset.tab)));

// ── Sync button ──────────────────────────────────────────────────────────
$('#sync-btn').addEventListener('click', async () => {
  const btn = $('#sync-btn');
  btn.disabled = true;
  btn.textContent = 'Working…';
  try {
    const r = await api('/api/sync', { method: 'POST' });
    await load();
    const newMail = (r.synced || []).reduce((n, s) => n + s.added, 0);
    toast(`Synced ${newMail} new · triaged ${r.triaged}.`);
  } catch (e) {
    // No mailboxes configured yet — just re-triage demo/local data.
    try { const r = await api('/api/triage', { method: 'POST' }); await load(); toast(`Worked ${r.triaged} message(s).`); }
    catch (e2) { toast('Error: ' + e2.message); }
  } finally {
    btn.disabled = false;
    btn.textContent = 'Sync & work the inbox';
  }
});

// ── Boot ─────────────────────────────────────────────────────────────────
load().catch((e) => toast('Failed to load: ' + e.message));
