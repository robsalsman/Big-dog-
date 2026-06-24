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
  if (res.status === 401 && !path.startsWith('/api/auth/')) {
    showLogin();
    throw new Error('Please log in.');
  }
  if (!res.ok) {
    const err = await res.json().catch(() => ({ error: res.statusText }));
    throw new Error(err.error || 'request failed');
  }
  return res.json();
}

function showLogin() {
  $('#login').style.display = 'flex';
  setTimeout(() => $('#login-pw')?.focus(), 50);
}
window.doLogin = async () => {
  try {
    await api('/api/auth/login', { method: 'POST', body: { password: $('#login-pw').value } });
    $('#login').style.display = 'none';
    $('#login-err').textContent = '';
    boot();
  } catch (e) { $('#login-err').textContent = e.message; }
};
window.logout = async () => {
  await api('/api/auth/logout', { method: 'POST' }).catch(() => {});
  location.reload();
};

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
function messageCard(m) {
  const p = m.priority || 'cold';
  const drafted = state.drafts.some((d) => d.inReplyTo && d.inReplyTo === m.messageId);
  return `
    <div class="card ${p}">
      <div class="row">
        <div>
          <strong>${esc(m.fromName)}</strong>
          <span class="muted small">&lt;${esc(m.fromEmail)}&gt;</span>
          ${m.folder === 'SENT' ? '<span class="tag" title="You sent this">↗ sent</span>' : ''}
          ${drafted ? '<span class="tag warm" title="Reply auto-drafted">✍ drafted</span>' : ''}
          <div>${esc(m.subject)}</div>
          ${m.summary ? `<div class="muted small">🐕 ${esc(m.summary)}</div>` : ''}
        </div>
        <div style="text-align:right;white-space:nowrap">
          ${m.category && m.category !== 'reply' ? `<span class="tag" title="Big Dog won't auto-reply to this">${esc(m.category)}</span> ` : ''}
          <span class="tag ${p}">${p}</span>
          <div class="muted small">${fmtDate(m.date)}</div>
        </div>
      </div>
      <div class="msg-body" id="body-${m.id}">${esc(m.body)}</div>
      <div id="intel-${m.id}"></div>
      <div class="actions">
        <button class="btn small ghost" onclick="toggleBody('${m.id}')">Read</button>
        <button class="btn small" onclick="viewThread('${m.threadId}','${m.id}')">🧵 Thread</button>
        <button class="btn small primary" onclick="draftReply('${m.id}')">🐕 Draft my reply</button>
        ${(m.toEmails && m.toEmails.split(/[,;]/).length > 1) ? `<button class="btn small" onclick="draftReply('${m.id}', true)" title="Reply to everyone on the thread">↩↩ Reply all</button>` : ''}
        <button class="btn small" onclick="research('${m.id}','${esc(m.fromName)} ${esc(m.fromEmail)}')">🔎 Research</button>
        <button class="btn small ghost" onclick="remember('${esc(m.fromEmail)}')">📝 Remember</button>
        <button class="btn small ghost" onclick="dismissMessage('${m.id}')" title="Remove this message from the inbox">🗑 Dismiss</button>
        <button class="btn small ghost" onclick="suppressSender('${esc(m.fromEmail)}')" title="Stop auto-drafting replies to this sender">🚫 Don't draft</button>
      </div>
    </div>`;
}

function renderInbox() {
  const el = $('#inbox');
  const list = `
    <div class="chat-input" style="margin-bottom:14px">
      <input id="inbox-search" placeholder="🔎 Search inbox &amp; pipeline…" value="${esc(inboxQuery)}" />
      ${inboxQuery ? '<button class="btn ghost" onclick="clearSearch()">Clear</button>' : ''}
    </div>
    <div id="inbox-list"></div>`;
  el.innerHTML = list;
  $('#inbox-search').addEventListener('input', (e) => {
    inboxQuery = e.target.value;
    clearTimeout(searchTimer);
    searchTimer = setTimeout(runSearch, 220);
  });
  if (inboxQuery.trim()) runSearch();
  else renderInboxList(state.messages.filter((m) => m.folder !== 'SENT'));
}

window.viewThread = async (threadId, msgId) => {
  const slot = $('#intel-' + msgId);
  slot.innerHTML = '<div class="muted small" style="margin-top:8px">🧵 Loading thread…</div>';
  try {
    const { messages: msgs } = await api('/api/threads/' + encodeURIComponent(threadId));
    if (msgs.length <= 1) { slot.innerHTML = '<div class="muted small" style="margin-top:8px">No earlier messages in this thread yet.</div>'; return; }
    const items = msgs.map((t) => {
      const me = t.folder === 'SENT';
      return `<div class="bubble ${me ? 'me' : 'dog'}" style="max-width:100%">
        <div class="small" style="opacity:.7">${me ? 'You' : esc(t.fromName)} · ${fmtDate(t.date)}</div>
        ${esc(t.body).slice(0, 1500)}</div>`;
    }).join('');
    slot.innerHTML = `<div class="card" style="margin-top:8px"><div class="muted small" style="margin-bottom:6px">🧵 ${msgs.length} messages</div><div class="chatlog">${items}</div></div>`;
  } catch (e) { slot.innerHTML = '<div class="muted small">Error: ' + esc(e.message) + '</div>'; }
};

function renderInboxList(msgs) {
  const wrap = $('#inbox-list');
  if (!wrap) return;
  if (!msgs.length) {
    wrap.innerHTML = `<div class="empty">${inboxQuery ? 'No matches.' : 'Inbox empty. Hit “Sync &amp; work the inbox”.'}</div>`;
    return;
  }
  wrap.innerHTML = msgs.map(messageCard).join('');
}

let inboxQuery = '';
let searchTimer = null;

async function runSearch() {
  const q = inboxQuery.trim();
  if (!q) { renderInboxList(state.messages); return; }
  try {
    const r = await api('/api/search?q=' + encodeURIComponent(q));
    const dealHits = r.deals.length
      ? `<div class="muted small" style="margin-bottom:8px">💼 ${r.deals.length} matching deal(s): ${r.deals.map((d) => esc(d.title)).join(', ')}</div>`
      : '';
    $('#inbox-list').innerHTML = dealHits + (r.messages.length ? r.messages.map(messageCard).join('') : '<div class="empty">No matching messages.</div>');
  } catch (e) { toast('Search error: ' + e.message); }
}

window.clearSearch = () => { inboxQuery = ''; renderInbox(); };

window.dismissDraft = async (msgId) => {
  try {
    await api('/api/messages/' + encodeURIComponent(msgId) + '/dismiss-draft', { method: 'POST' });
    await load();
    if (inboxQuery.trim()) runSearch(); else renderInbox();
    toast('Draft dismissed. 🐕');
  } catch (e) { toast('Error: ' + e.message); }
};

window.dismissMessage = async (msgId) => {
  // Optimistically remove the card, then archive on the server.
  const card = document.getElementById('body-' + msgId)?.closest('.card');
  if (card) card.style.display = 'none';
  try {
    await api('/api/messages/' + encodeURIComponent(msgId) + '/archive', { method: 'POST' });
    await load();
    if (inboxQuery.trim()) runSearch(); else renderInbox();
    toast('Dismissed. 🐕');
  } catch (e) { if (card) card.style.display = ''; toast('Error: ' + e.message); }
};

window.suppressSender = async (email) => {
  if (!email) return;
  if (!confirm(`Stop Big Dog from auto-drafting replies to ${email}? (You can undo this in ⚙ Settings.)`)) return;
  try {
    await api('/api/suppressed', { method: 'POST', body: { email } });
    await load();
    if (inboxQuery.trim()) runSearch(); else renderInbox();
    toast(`Won't draft replies to ${email}. 🚫`);
  } catch (e) { toast('Error: ' + e.message); }
};

// ── Compose new email / meeting invite ───────────────────────────────────
async function loadContactsDatalist() {
  try {
    const { contacts } = await api('/api/contacts/suggest');
    const dl = $('#contacts-dl'); if (!dl) return;
    dl.innerHTML = contacts.map((c) => `<option value="${esc(c.email)}">${esc(c.name || '')}${c.company ? ' · ' + esc(c.company) : ''}</option>`).join('');
  } catch { /* ignore */ }
}
window.openCompose = (to = '') => {
  $('#cmp-to').value = to; $('#cmp-cc').value = ''; $('#cmp-subject').value = ''; $('#cmp-body').value = '';
  $('#cmp-instruction').value = ''; $('#cmp-status').textContent = '';
  $('#cmp-meeting').style.display = 'none';
  $('#compose').style.display = 'flex';
  __composeAtt = [];
  loadContactsDatalist();
  loadComposeAttachments();
  setTimeout(() => $('#cmp-to').focus(), 50);
};
window.closeCompose = () => { $('#compose').style.display = 'none'; };
window.toggleMeeting = () => {
  const m = $('#cmp-meeting');
  m.style.display = m.style.display === 'none' ? 'block' : 'none';
  if (m.style.display === 'block' && !$('#cmp-mtitle').value) $('#cmp-mtitle').value = $('#cmp-subject').value || 'Intro call';
};
window.composeAI = async () => {
  const instruction = $('#cmp-instruction').value.trim() || $('#cmp-body').value.trim();
  if (!instruction) { $('#cmp-status').textContent = 'Tell Big Dog what to say first.'; return; }
  $('#cmp-status').textContent = '🐕 Writing…';
  try {
    const r = await api('/api/compose', { method: 'POST', body: { to: $('#cmp-to').value.trim(), subject: $('#cmp-subject').value.trim(), body: $('#cmp-body').value.trim(), instruction } });
    if (r.subject) $('#cmp-subject').value = r.subject;
    if (r.body) $('#cmp-body').value = r.body;
    $('#cmp-status').textContent = '✅ Drafted — edit and send, or queue it.';
  } catch (e) { $('#cmp-status').textContent = 'Error: ' + e.message; }
};
window.composeSend = async (now) => {
  const to = $('#cmp-to').value.trim();
  const body = $('#cmp-body').value.trim();
  if (!to.includes('@') || !body) { $('#cmp-status').textContent = 'Need a recipient and a message.'; return; }
  $('#cmp-status').textContent = now ? 'Sending…' : 'Queuing…';
  try {
    const r = await api('/api/compose/send', { method: 'POST', body: { to, cc: $('#cmp-cc').value.trim(), subject: $('#cmp-subject').value.trim() || '(no subject)', body, queue: !now, attachmentIds: __composeAtt } });
    closeCompose(); await load();
    toast(r.sent ? `Sent to ${to}. 🐕` : 'Queued in Drafts for approval. 🐕');
  } catch (e) { $('#cmp-status').textContent = 'Error: ' + e.message; }
};
window.sendMeetingInvite = async () => {
  const to = $('#cmp-to').value.trim();
  if (!to.includes('@')) { $('#cmp-status').textContent = 'Enter the attendee email in the To field.'; return; }
  $('#cmp-status').textContent = '📅 Creating invite…';
  try {
    await api('/api/meeting/invite', { method: 'POST', body: { to, title: $('#cmp-mtitle').value.trim() || 'Meeting', whenISO: $('#cmp-mwhen').value ? new Date($('#cmp-mwhen').value).toISOString() : undefined, minutes: Number($('#cmp-mmins').value || 30) } });
    closeCompose(); await load();
    toast('Meeting added to calendar + invite queued in Drafts. 🐕');
  } catch (e) { $('#cmp-status').textContent = 'Error: ' + e.message; }
};

// ── Contacts (CRM) ───────────────────────────────────────────────────────
let contactQuery = '';
async function renderContacts() {
  const el = $('#contacts');
  el.innerHTML = `
    <div class="chat-input" style="margin-bottom:14px">
      <input id="contact-search" placeholder="🔎 Search contacts…" value="${esc(contactQuery)}" />
      <button class="btn" onclick="openCompose()">✏️ New email</button>
    </div>
    <div id="contact-list"><div class="muted">Loading…</div></div>`;
  $('#contact-search').addEventListener('input', (e) => { contactQuery = e.target.value; loadContacts(); });
  loadContacts();
}
async function loadContacts() {
  const wrap = $('#contact-list'); if (!wrap) return;
  try {
    const url = contactQuery.trim() ? '/api/contacts/suggest?q=' + encodeURIComponent(contactQuery.trim()) : '/api/contacts';
    const { contacts } = await api(url);
    if (!contacts.length) { wrap.innerHTML = '<div class="empty">No contacts yet. They build up automatically as Big Dog syncs your mail.</div>'; return; }
    wrap.innerHTML = contacts.map((c) => `
      <div class="card" style="cursor:pointer" onclick="openContact('${esc(c.email)}')">
        <div class="row">
          <div><strong>${esc(c.name || c.email)}</strong>
            ${c.company ? `<span class="muted small">· ${esc(c.company)}</span>` : ''}
            <div class="muted small">${esc(c.email)}${c.title ? ' · ' + esc(c.title) : ''}</div></div>
          <div class="muted small" style="white-space:nowrap">${c.lastSeen ? fmtDate(c.lastSeen) : ''}</div>
        </div>
      </div>`).join('');
  } catch (e) { wrap.innerHTML = '<div class="empty">Error: ' + esc(e.message) + '</div>'; }
}
window.openContact = async (email) => {
  const wrap = $('#contact-list');
  wrap.innerHTML = '<div class="muted">Loading contact…</div>';
  try {
    const d = await api('/api/contacts/' + encodeURIComponent(email));
    const c = d.contact;
    const acts = [];
    for (const m of d.messages) acts.push({ t: m.date, kind: m.folder === 'SENT' ? '↗ You wrote' : '↘ They wrote', text: m.subject });
    for (const e of d.events) acts.push({ t: e.start, kind: '📅 Meeting', text: e.title });
    for (const dr of d.drafts) acts.push({ t: dr.createdAt, kind: '✍ Draft pending', text: dr.subject });
    acts.sort((a, b) => (b.t || '').localeCompare(a.t || ''));
    const dealLine = d.deals.length ? d.deals.map((x) => `<span class="tag ${x.stage === 'won' ? 'good' : 'warm'}">${esc(x.title)} — ${esc(x.stage)}</span>`).join(' ') : '<span class="muted small">No deals</span>';
    wrap.innerHTML = `
      <button class="btn small ghost" onclick="renderContacts()">← All contacts</button>
      <div class="card" style="margin-top:10px">
        <div class="row"><div><h2 style="margin:0">${esc(c.name || c.email)}</h2>
          <div class="muted small">${esc(c.email)}</div></div>
          <button class="btn small primary" onclick="openCompose('${esc(c.email)}')">✏️ Email</button></div>
        <div style="display:grid;grid-template-columns:1fr 1fr;gap:8px;margin-top:10px">
          <input class="subj" id="ct-name" placeholder="Name" value="${esc(c.name || '')}" />
          <input class="subj" id="ct-company" placeholder="Company" value="${esc(c.company || '')}" />
          <input class="subj" id="ct-title" placeholder="Title" value="${esc(c.title || '')}" />
          <input class="subj" id="ct-phone" placeholder="Phone" value="${esc(c.phone || '')}" />
        </div>
        <textarea class="edit" id="ct-notes" placeholder="Notes" style="min-height:60px;width:100%">${esc(c.notes || '')}</textarea>
        <div class="actions"><button class="btn small primary" onclick="saveContact('${esc(c.email)}')">Save contact</button>
          <span id="ct-status" class="muted small"></span></div>
        <div style="margin-top:8px">${dealLine}</div>
        ${d.memory ? `<div class="muted small" style="margin-top:8px">🧠 ${esc(d.memory)}</div>` : ''}
      </div>
      <div class="card">
        <strong>Activity (${acts.length})</strong>
        <div style="margin-top:8px">${acts.length ? acts.slice(0, 60).map((a) => `<div class="row" style="padding:3px 0"><span class="small">${a.kind}: ${esc(a.text)}</span><span class="muted small">${a.t ? fmtDate(a.t) : ''}</span></div>`).join('') : '<div class="muted small">No recorded activity yet.</div>'}</div>
      </div>`;
  } catch (e) { wrap.innerHTML = '<div class="empty">Error: ' + esc(e.message) + '</div>'; }
};
window.saveContact = async (email) => {
  $('#ct-status').textContent = 'Saving…';
  try {
    await api('/api/contacts', { method: 'POST', body: { email, name: $('#ct-name').value, company: $('#ct-company').value, title: $('#ct-title').value, phone: $('#ct-phone').value, notes: $('#ct-notes').value } });
    $('#ct-status').textContent = '✅ Saved.';
    toast('Contact saved. 🐕');
  } catch (e) { $('#ct-status').textContent = 'Error: ' + e.message; }
};

// ── Drip campaigns (sequences) ───────────────────────────────────────────
let campData = { sequences: [], enrollments: [], defaultSteps: [] };
async function renderCampaigns() {
  const el = $('#campaigns');
  el.innerHTML = '<div class="muted">Loading campaigns…</div>';
  try {
    campData = await api('/api/sequences');
    const seqs = campData.sequences;
    const stepsToShow = (window.__newSteps && window.__newSteps.length) ? window.__newSteps : campData.defaultSteps;
    const stepRows = stepsToShow.map((s, i) => `
      <div class="row" style="gap:6px;margin:4px 0">
        <input class="subj" id="step-day-${i}" type="number" value="${s.dayOffset}" style="width:70px" title="day" />
        <input class="subj" id="step-subj-${i}" value="${esc(s.subject)}" placeholder="subject" style="flex:1" />
        <input class="subj" id="step-instr-${i}" value="${esc(s.instruction)}" placeholder="what this touch should say" style="flex:2" />
      </div>`).join('');
    el.innerHTML = `
      <div class="row" style="margin-bottom:6px"><h2 style="margin:0">Campaigns — automated drip sequences</h2>
        <button class="btn small" onclick="runDripNow()">▶ Run due touches now</button></div>
      <div class="muted small" style="margin-bottom:12px">Multi-touch follow-ups in your voice (inspired by Dittofeed/Parcelvoy). Each touch is personalized and queued for approval; the sequence auto-stops the moment a contact replies or opts out.</div>

      <div class="card">
        <strong>➕ New sequence</strong>
        <input class="subj" id="seq-name" placeholder="Sequence name (e.g. Cold outreach)" style="width:100%;margin:6px 0" />
        <div class="muted small">Steps — <em>day</em> (after enrollment), subject, and what to say:</div>
        <div id="seq-steps">${stepRows}</div>
        <div class="actions">
          <button class="btn small" onclick="addStep()">+ Step</button>
          <button class="btn small primary" onclick="saveSequence()">Save sequence</button>
          <span id="seq-status" class="muted small"></span>
        </div>
      </div>

      ${seqs.length ? seqs.map((s) => {
        const active = campData.enrollments.filter((e) => e.sequenceId === s.id && e.status === 'active').length;
        const total = campData.enrollments.filter((e) => e.sequenceId === s.id).length;
        return `<div class="card">
          <div class="row"><div><strong>${esc(s.name)}</strong> <span class="muted small">· ${s.steps.length} touches · ${active} active / ${total} enrolled</span></div>
            <button class="btn small ghost" onclick="deleteSequence('${s.id}')">Delete</button></div>
          <textarea class="edit" id="enroll-${s.id}" placeholder="Paste emails to enroll (comma or newline separated)…" style="min-height:54px"></textarea>
          <div class="actions">
            <button class="btn small primary" onclick="enrollSeq('${s.id}')">Enroll contacts</button>
            <span id="enroll-status-${s.id}" class="muted small"></span>
          </div>
        </div>`;
      }).join('') : ''}

      <div class="card">
        <strong>Enrollments</strong>
        <div style="margin-top:8px">${campData.enrollments.length ? campData.enrollments.slice(0, 100).map((e) => {
          const seq = seqs.find((s) => s.id === e.sequenceId);
          const tag = e.status === 'active' ? 'warm' : e.status === 'replied' ? 'good' : '';
          return `<div class="row" style="padding:3px 0">
            <span class="small">${esc(e.email)} <span class="muted">· ${esc(seq ? seq.name : '—')} · touch ${e.step + 1}</span> <span class="tag ${tag}">${e.status}</span></span>
            <span class="muted small">${e.status === 'active' ? 'next ' + fmtDate(e.nextRunAt) : ''} ${e.status === 'active' ? `<button class="btn small ghost" onclick="stopEnrollment('${e.id}')">Stop</button>` : ''}</span>
          </div>`;
        }).join('') : '<div class="muted small">No one enrolled yet.</div>'}</div>
      </div>`;
  } catch (e) { el.innerHTML = '<div class="empty">Error: ' + esc(e.message) + '</div>'; }
}
function collectSteps() {
  const steps = [];
  let i = 0;
  while ($('#step-subj-' + i)) {
    steps.push({ dayOffset: Number($('#step-day-' + i).value || 0), subject: $('#step-subj-' + i).value.trim(), instruction: $('#step-instr-' + i).value.trim() });
    i++;
  }
  return steps.filter((s) => s.subject || s.instruction);
}
window.addStep = () => { window.__newSteps = collectSteps(); window.__newSteps.push({ dayOffset: 21, subject: '', instruction: '' }); renderCampaigns(); };
window.saveSequence = async () => {
  const name = $('#seq-name').value.trim();
  if (!name) { $('#seq-status').textContent = 'Name it first.'; return; }
  const steps = collectSteps();
  if (!steps.length) { $('#seq-status').textContent = 'Add at least one step.'; return; }
  try { await api('/api/sequences', { method: 'POST', body: { name, steps } }); window.__newSteps = null; toast('Sequence saved. 🐕'); renderCampaigns(); }
  catch (e) { $('#seq-status').textContent = 'Error: ' + e.message; }
};
window.deleteSequence = async (id) => { if (!confirm('Delete this sequence and its enrollments?')) return; try { await api('/api/sequences/' + id, { method: 'DELETE' }); renderCampaigns(); } catch (e) { toast('Error: ' + e.message); } };
window.enrollSeq = async (id) => {
  const emails = $('#enroll-' + id).value.trim();
  if (!emails) { $('#enroll-status-' + id).textContent = 'Paste some emails.'; return; }
  try { const r = await api('/api/sequences/' + id + '/enroll', { method: 'POST', body: { emails } }); $('#enroll-status-' + id).textContent = `✅ Enrolled ${r.enrolled}, skipped ${r.skipped}.`; renderCampaigns(); }
  catch (e) { $('#enroll-status-' + id).textContent = 'Error: ' + e.message; }
};
window.stopEnrollment = async (id) => { try { await api('/api/enrollments/' + id + '/stop', { method: 'POST' }); renderCampaigns(); } catch (e) { toast('Error: ' + e.message); } };
window.runDripNow = async () => { try { const r = await api('/api/sequences/run', { method: 'POST' }); toast(`Produced ${r.produced} touch(es). Check Drafts.`); await load(); renderCampaigns(); } catch (e) { toast('Error: ' + e.message); } };

// ── Sales repository ─────────────────────────────────────────────────────
async function renderRepo() {
  const el = $('#repo');
  el.innerHTML = `
    <div class="row" style="margin-bottom:10px"><h2 style="margin:0">📁 Sales repository</h2></div>
    <div class="muted small" style="margin-bottom:12px">Datasheets, one-pagers, case studies — anything Big Dog can attach to emails. Add files here, then pick them when composing or in a draft.</div>
    <div class="card">
      <input type="file" id="repo-file" class="subj" multiple />
      <input class="subj" id="repo-notes" placeholder="Optional note (what this is / when to use it)" style="width:100%" />
      <div class="actions"><button class="btn small primary" onclick="uploadRepo()">⬆ Upload</button><span id="repo-status" class="muted small"></span></div>
    </div>
    <div id="repo-list"><div class="muted">Loading…</div></div>`;
  loadRepo();
}
async function loadRepo() {
  const wrap = $('#repo-list'); if (!wrap) return;
  try {
    const { files } = await api('/api/repo');
    wrap.innerHTML = files.length ? files.map((f) => `
      <div class="card"><div class="row">
        <div><strong>${esc(f.name)}</strong> <span class="muted small">· ${(f.size / 1024).toFixed(0)} KB</span>
          ${f.notes ? `<div class="muted small">${esc(f.notes)}</div>` : ''}</div>
        <div style="white-space:nowrap"><a class="btn small ghost" href="/api/repo/${f.id}/file" target="_blank">Download</a>
          <button class="btn small ghost" onclick="deleteRepo('${f.id}')">Delete</button></div>
      </div></div>`).join('') : '<div class="empty">No files yet. Upload your first datasheet above.</div>';
  } catch (e) { wrap.innerHTML = '<div class="empty">Error: ' + esc(e.message) + '</div>'; }
}
window.uploadRepo = async () => {
  const input = $('#repo-file'); const files = input.files;
  if (!files || !files.length) { $('#repo-status').textContent = 'Pick a file first.'; return; }
  $('#repo-status').textContent = 'Uploading…';
  try {
    for (const file of files) {
      const data = await fileToBase64(file);
      await api('/api/repo', { method: 'POST', body: { name: file.name, mime: file.type, data, notes: $('#repo-notes').value.trim() } });
    }
    $('#repo-status').textContent = '✅ Uploaded.'; $('#repo-notes').value = ''; input.value = '';
    loadRepo(); toast('Added to repository. 🐕');
  } catch (e) { $('#repo-status').textContent = 'Error: ' + e.message; }
};
window.deleteRepo = async (id) => { if (!confirm('Delete this file?')) return; try { await api('/api/repo/' + id, { method: 'DELETE' }); loadRepo(); } catch (e) { toast('Error: ' + e.message); } };
function fileToBase64(file) {
  return new Promise((resolve, reject) => {
    const r = new FileReader();
    r.onload = () => resolve(String(r.result).split(',')[1] || '');
    r.onerror = reject; r.readAsDataURL(file);
  });
}
// Attachment picker used by the compose modal.
let __composeAtt = [];
async function loadComposeAttachments() {
  const box = $('#cmp-attach'); if (!box) return;
  try {
    const { files } = await api('/api/repo');
    if (!files.length) { box.innerHTML = '<span class="muted small">No repository files yet — add some under Repository.</span>'; return; }
    box.innerHTML = '📎 Attach: ' + files.map((f) => `<label class="small" style="margin-right:10px"><input type="checkbox" value="${f.id}" onchange="toggleAtt('${f.id}',this.checked)"> ${esc(f.name)}</label>`).join('');
  } catch { box.innerHTML = ''; }
}
window.toggleAtt = (id, on) => { __composeAtt = __composeAtt.filter((x) => x !== id); if (on) __composeAtt.push(id); };

// ── Sent mailbox ─────────────────────────────────────────────────────────
async function renderSent() {
  const el = $('#sent');
  el.innerHTML = '<div class="muted">Loading sent mail…</div>';
  try {
    const { messages: msgs } = await api('/api/sent');
    if (!msgs.length) { el.innerHTML = '<div class="empty">No sent mail yet. Once your mailbox syncs (or you send from Big Dog), it shows here.</div>'; return; }
    el.innerHTML = `<div class="muted small" style="margin-bottom:10px">${msgs.length} sent message(s). Use the inbox search to search across everything, including sent.</div>` +
      msgs.map((m) => `
      <div class="card">
        <div class="row">
          <div><span class="muted small">To</span> <strong>${esc(m.toEmails)}</strong>
            <div>${esc(m.subject)}</div>
            <div class="muted small">${esc((m.snippet || m.body || '').slice(0, 160))}</div></div>
          <div class="muted small" style="white-space:nowrap">${fmtDate(m.date)}</div>
        </div>
      </div>`).join('');
  } catch (e) { el.innerHTML = '<div class="empty">Error: ' + esc(e.message) + '</div>'; }
}

window.toggleBody = (id) => {
  $('#body-' + id).classList.toggle('open');
  api(`/api/messages/${id}/read`, { method: 'POST' }).catch(() => {});
};

window.research = async (id, who) => {
  const slot = $('#intel-' + id);
  slot.innerHTML = '<div class="muted small" style="margin-top:8px">🔎 Researching…</div>';
  try {
    const { brief } = await api('/api/research', { method: 'POST', body: { query: who } });
    slot.innerHTML = `<div class="card" style="margin-top:8px"><div class="muted small"><strong>🔎 Lead brief</strong></div><div class="markdown">${md(brief)}</div></div>`;
  } catch (e) { slot.innerHTML = '<div class="muted small">Error: ' + esc(e.message) + '</div>'; }
};

window.browsePage = async () => {
  const url = $('#browse-url').value.trim();
  const instruction = $('#browse-q').value.trim();
  const out = $('#browse-out');
  if (!url) { out.innerHTML = '<div class="muted small">Enter a URL.</div>'; return; }
  out.innerHTML = '<div class="muted small">🌐 Opening the page…</div>';
  try {
    const r = await api('/api/browse', { method: 'POST', body: { url, instruction } });
    out.innerHTML = `<div class="card"><div class="muted small"><strong>🌐 ${esc(r.url)}</strong>${r.summarized ? ' — Big Dog\'s read' : ' — page contents'}</div><div class="markdown">${md(r.content)}</div></div>`;
  } catch (e) { out.innerHTML = '<div class="muted small">Error: ' + esc(e.message) + '</div>'; }
};

window.remember = async (email) => {
  const note = prompt(`What should Big Dog remember about ${email}?`);
  if (!note) return;
  try { await api('/api/memory', { method: 'POST', body: { email, note } }); toast('🐕 Got it — noted.'); }
  catch (e) { toast('Error: ' + e.message); }
};

window.draftReply = async (id, replyAll = false) => {
  toast(replyAll ? 'Drafting a reply-all…' : 'Big Dog is drafting…');
  try {
    const { autoSent } = await api(`/api/messages/${id}/draft`, { method: 'POST', body: { replyAll } });
    await load();
    if (autoSent) { toast('Sent it. 🐕'); }
    else { switchTab('drafts'); toast(replyAll ? 'Reply-all draft ready (Cc filled in).' : 'Draft ready — review it.'); }
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
  const open = state.deals.filter((d) => d.stage !== 'won' && d.stage !== 'lost');
  const value = open.reduce((s, d) => s + (Number(d.value) || 0), 0);
  const won = state.deals.filter((d) => d.stage === 'won').length;
  const lost = state.deals.filter((d) => d.stage === 'lost').length;
  const winRate = won + lost ? Math.round((won / (won + lost)) * 100) : null;
  const hot = state.messages.filter((m) => m.priority === 'hot').length;
  const stat = (label, val) => `<div class="card" style="flex:1;min-width:120px;text-align:center;margin:0"><div style="font-size:22px;font-weight:700">${val}</div><div class="muted small">${label}</div></div>`;
  const strip = `<div style="display:flex;gap:10px;flex-wrap:wrap;margin-bottom:14px">
    ${stat('Open pipeline', money(value))}
    ${stat('Open deals', open.length)}
    ${stat('🔥 Hot threads', hot)}
    ${stat('Win rate', winRate == null ? '—' : winRate + '%')}
  </div>`;
  el.innerHTML = `
    <div class="row" style="margin-bottom:14px">
      <h2>Pipeline</h2>
      <button class="btn small primary" onclick="runFollowups()">🐕 Run follow-ups</button>
    </div>
    ${strip}
    <div class="board">${board}</div>`;
}

// ── Activity ─────────────────────────────────────────────────────────────
const ACT_ICON = { sync: '🔄', triage: '🧠', hot: '🔥', draft: '✍', send: '📤', schedule: '⏰', cadence: '🔁', campaign: '🚀', error: '⚠️' };
async function renderActivity() {
  const el = $('#activity');
  el.innerHTML = '<div class="row" style="margin-bottom:12px"><h2>Activity</h2><button class="btn small" onclick="renderActivity()">↻ Refresh</button></div><div id="act-list" class="muted">Loading…</div>';
  try {
    const { activity } = await api('/api/activity');
    const list = $('#act-list');
    if (!list) return;
    list.innerHTML = activity.length ? activity.map((a) => `
      <div class="card" style="padding:10px 14px">
        <div class="row">
          <div><span style="margin-right:6px">${ACT_ICON[a.type] || '•'}</span>${esc(a.message)}</div>
          <div class="muted small" style="white-space:nowrap">${fmtDate(a.ts)}</div>
        </div>
      </div>`).join('') : '<div class="empty">Nothing yet. Hit “Sync &amp; work the inbox”.</div>';
  } catch (e) { $('#act-list') && ($('#act-list').innerHTML = 'Error: ' + esc(e.message)); }
}

window.runFollowups = async () => {
  toast('Big Dog is sweeping for stalled deals…');
  try {
    const { created } = await api('/api/cadence/run', { method: 'POST' });
    await load();
    if (created.length) { switchTab('drafts'); toast(`Queued ${created.length} follow-up(s) for approval.`); }
    else toast('Nothing stalled — pipeline looks healthy. 🐕');
  } catch (e) { toast('Error: ' + e.message); }
};

window.moveDeal = async (id, stage) => {
  try { await api(`/api/deals/${id}`, { method: 'PATCH', body: { stage } }); await load(); toast('Deal moved.'); }
  catch (e) { toast('Error: ' + e.message); }
};

// ── Calendar ─────────────────────────────────────────────────────────────
let calMonth = null; // first day of the displayed month
function ymdLocal(d) { return d.getFullYear() + '-' + String(d.getMonth() + 1).padStart(2, '0') + '-' + String(d.getDate()).padStart(2, '0'); }
function fmtTime(iso) { return new Date(iso).toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' }); }
function renderCalendar() {
  const el = $('#calendar');
  if (!calMonth) { const n = new Date(); calMonth = new Date(n.getFullYear(), n.getMonth(), 1); }
  const year = calMonth.getFullYear(), month = calMonth.getMonth();
  const startDow = new Date(year, month, 1).getDay();
  const gridStart = new Date(year, month, 1 - startDow);

  const byDay = {};
  for (const e of state.events) { const key = ymdLocal(new Date(e.start)); (byDay[key] = byDay[key] || []).push(e); }
  for (const k in byDay) byDay[k].sort((a, b) => a.start.localeCompare(b.start));
  const todayKey = ymdLocal(new Date());
  const monthName = calMonth.toLocaleString('default', { month: 'long', year: 'numeric' });
  const dows = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];

  let cells = '';
  for (let i = 0; i < 42; i++) {
    const d = new Date(gridStart.getFullYear(), gridStart.getMonth(), gridStart.getDate() + i);
    const key = ymdLocal(d);
    const evs = byDay[key] || [];
    const cls = 'cal-cell' + (d.getMonth() === month ? '' : ' cal-out') + (key === todayKey ? ' cal-today' : '');
    cells += `<div class="${cls}" onclick="showDay('${key}')">
      <div class="cal-num">${d.getDate()}</div>
      ${evs.slice(0, 3).map((e) => `<div class="cal-evt" title="${esc(e.title)}">${fmtTime(e.start)} ${esc(e.title)}</div>`).join('')}
      ${evs.length > 3 ? `<div class="cal-more">+${evs.length - 3} more</div>` : ''}
    </div>`;
  }

  const cal = state.calcom || {};
  const calBtns = [
    cal.bookingUrl ? `<a class="btn small primary" href="${esc(cal.bookingUrl)}" target="_blank">📅 Book a call</a>` : '',
    cal.configured ? `<button class="btn small" onclick="syncCalcom()">↻ Sync Cal.com</button>` : '',
    `<a class="btn small" href="/calendar.ics">⬇ Subscribe (.ics)</a>`,
  ].join(' ');

  el.innerHTML = `
    <div class="row" style="margin-bottom:12px;flex-wrap:wrap;gap:8px">
      <div style="display:flex;gap:8px;align-items:center">
        <button class="btn small" onclick="calNav(-1)">‹</button>
        <h2 style="margin:0;min-width:210px;text-align:center">${monthName}</h2>
        <button class="btn small" onclick="calNav(1)">›</button>
        <button class="btn small ghost" onclick="calToday()">Today</button>
      </div>
      <div>${calBtns}</div>
    </div>
    <div class="cal-grid cal-head">${dows.map((d) => `<div class="cal-dow">${d}</div>`).join('')}</div>
    <div class="cal-grid">${cells}</div>
    <div id="cal-day"></div>`;
}
window.calNav = (delta) => { calMonth = new Date(calMonth.getFullYear(), calMonth.getMonth() + delta, 1); renderCalendar(); };
window.calToday = () => { const n = new Date(); calMonth = new Date(n.getFullYear(), n.getMonth(), 1); renderCalendar(); showDay(ymdLocal(n)); };
window.showDay = (key) => {
  const evs = state.events.filter((e) => ymdLocal(new Date(e.start)) === key).sort((a, b) => a.start.localeCompare(b.start));
  const slot = $('#cal-day'); if (!slot) return;
  const dt = new Date(key + 'T00:00:00');
  slot.innerHTML = `<div class="card" style="margin-top:14px">
    <div class="row"><strong>${dt.toLocaleDateString([], { weekday: 'long', month: 'long', day: 'numeric' })}</strong>
      <button class="btn small primary" onclick="openCompose()">📅 New meeting</button></div>
    ${evs.length ? evs.map((e) => `
      <div class="evt" style="margin-top:10px">
        <div class="when">${fmtTime(e.start)}</div>
        <div><strong>${esc(e.title)}</strong>
          <div class="muted small">${esc(e.location || '')} ${e.attendees ? '· ' + esc(e.attendees) : ''}</div>
          ${e.notes ? `<div class="muted small">${esc(e.notes)}</div>` : ''}
          ${e.zoomMeetingId ? `<div style="margin-top:6px"><button class="btn small primary" onclick="meetingFollowup('${e.id}')">🎬 Pull transcript & draft follow-up</button> <span id="fu-${e.id}" class="muted small"></span></div>` : ''}</div>
      </div>`).join('') : '<div class="muted small" style="margin-top:8px">No meetings this day.</div>'}
  </div>`;
};

window.meetingFollowup = async (eventId) => {
  const s = $('#fu-' + eventId); if (s) s.textContent = '🎬 Pulling transcript & drafting…';
  try {
    const r = await api('/api/meeting/' + eventId + '/followup', { method: 'POST' });
    if (s) s.innerHTML = `✅ Follow-up drafted. ${r.actionItems && r.actionItems.length ? '(' + r.actionItems.length + ' action items)' : ''}`;
    await load();
    toast('Follow-up drafted from the transcript. Check Drafts. 🐕');
  } catch (e) { if (s) s.textContent = 'Error: ' + e.message; }
};

window.syncCalcom = async () => {
  try { const r = await api('/api/calcom/sync', { method: 'POST' }); await load(); switchTab('calendar'); toast(`Pulled ${r.bookings} Cal.com booking(s).`); }
  catch (e) { toast('Error: ' + e.message); }
};

// ── Drafts ───────────────────────────────────────────────────────────────
function renderDrafts() {
  const el = $('#drafts');
  loadContactsDatalist();
  if (!state.drafts.length) { el.innerHTML = '<div class="empty">No drafts waiting. Draft a reply from the Inbox.</div>'; return; }
  el.innerHTML = state.drafts
    .map(
      (d) => `
    <div class="card">
      <div class="muted small">To: ${esc(d.toEmails)}</div>
      <input class="subj" id="cc-${d.id}" list="contacts-dl" placeholder="Cc (comma-separated)" value="${esc(d.ccEmails || '')}" />
      <input class="subj" id="subj-${d.id}" value="${esc(d.subject)}" />
      <textarea class="edit" id="draft-${d.id}">${esc(d.body)}</textarea>
      ${d.rationale ? `<div class="muted small" style="margin-top:6px">🐕 ${esc(d.rationale)}</div>` : ''}
      ${d.sendAt ? `<div class="small" style="color:var(--accent);margin-top:6px">⏰ scheduled for ${fmtDate(d.sendAt)}</div>` : ''}
      <div class="actions">
        <button class="btn small good" onclick="sendDraft('${d.id}')">Send as me</button>
        <input type="datetime-local" id="sched-${d.id}" class="subj" style="width:auto;margin:0" />
        <button class="btn small" onclick="scheduleDraft('${d.id}')">⏰ Schedule</button>
        ${d.sendAt ? `<button class="btn small ghost" onclick="unschedule('${d.id}')">Unschedule</button>` : ''}
        <button class="btn small ghost" onclick="discardDraft('${d.id}')">Discard</button>
      </div>
    </div>`,
    )
    .join('');
}

window.scheduleDraft = async (id) => {
  const v = $('#sched-' + id).value;
  if (!v) { toast('Pick a date/time first.'); return; }
  try { await api(`/api/drafts/${id}/schedule`, { method: 'POST', body: { sendAt: v } }); await load(); toast('Scheduled. ⏰'); }
  catch (e) { toast('Error: ' + e.message); }
};
window.unschedule = async (id) => {
  try { await api(`/api/drafts/${id}/schedule`, { method: 'POST', body: { sendAt: null } }); await load(); toast('Schedule cleared.'); }
  catch (e) { toast('Error: ' + e.message); }
};

window.sendDraft = async (id) => {
  const body = $('#draft-' + id).value;
  const subject = $('#subj-' + id).value;
  const cc = $('#cc-' + id) ? $('#cc-' + id).value.trim() : '';
  try {
    const r = await api(`/api/drafts/${id}/send`, { method: 'POST', body: { body, subject, cc } });
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
    <div class="card" style="border-left:3px solid var(--accent)">
      <strong>🐕 Operator mode</strong>
      <div class="muted small" style="margin:4px 0 10px">Tell Big Dog to <em>do</em> something — it'll work the tools and queue anything that needs your sign-off.</div>
      <div class="chat-input">
        <input id="op-goal" placeholder="e.g. follow up with everyone stuck in proposal stage" />
        <button class="btn primary" onclick="operate()">Go do it</button>
      </div>
      <div id="op-out"></div>
    </div>
    <div class="chatlog" id="chatlog">
      <div class="bubble dog">What's up, ${esc(state.owner.name)}! Ask me anything — or use Operator mode above to have me take action.</div>
    </div>
    <div class="chat-input">
      <input id="chat-q" placeholder="e.g. which deals are at risk this week?" />
      <button class="btn primary" onclick="ask()">Ask</button>
    </div>`;
  $('#chat-q').addEventListener('keydown', (e) => { if (e.key === 'Enter') ask(); });
  $('#op-goal').addEventListener('keydown', (e) => { if (e.key === 'Enter') operate(); });
}

window.operate = async () => {
  const input = $('#op-goal');
  const goal = input.value.trim();
  if (!goal) return;
  const out = $('#op-out');
  out.innerHTML = '<div class="muted small" style="margin-top:10px">🐕 On it…</div>';
  try {
    const run = await api('/api/agent', { method: 'POST', body: { goal } });
    const steps = (run.steps || [])
      .map((s) => `<li><strong>${esc(s.tool)}</strong> — ${esc(s.observation).slice(0, 200)}</li>`)
      .join('');
    out.innerHTML =
      `<div class="card" style="margin-top:10px"><div class="markdown">${md(run.final || '')}</div>` +
      (steps ? `<details style="margin-top:8px"><summary class="muted small">how I got there (${run.steps.length} steps)</summary><ul>${steps}</ul></details>` : '') +
      `</div>`;
    await load();
    toast('Big Dog ran the play.');
  } catch (e) { out.innerHTML = '<div class="muted small">Error: ' + esc(e.message) + '</div>'; }
};

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

// ── Prospect (lead gen) ──────────────────────────────────────────────────
function renderProspect() {
  const el = $('#prospect');
  if (el.dataset.init) return;
  el.dataset.init = '1';
  const prov = state.prospect || { name: 'web', ready: true };
  el.innerHTML = `
    <div class="card" style="border:1px solid var(--accent);margin-bottom:18px">
      <strong>🚀 Autopilot — tell Big Dog the outcome you want</strong>
      <div class="muted small" style="margin:4px 0 8px">
        One command runs the whole funnel: source leads → research each → personalized outreach + follow-ups, all in your voice.
        e.g. <em>"Book me 10 meetings next week with security guard company owners"</em>
      </div>
      <textarea class="edit" id="ap-goal" placeholder="What do you want Big Dog to make happen?" style="min-height:54px;width:100%"></textarea>
      <div class="actions" style="align-items:center;flex-wrap:wrap">
        <label class="small muted"><input type="checkbox" id="ap-auto" /> Fully automate (send outreach without approval — meetings still wait for your OK)</label>
        <button class="btn small primary" onclick="launchAutopilot()">🚀 Launch autopilot</button>
        <span id="ap-status" class="muted small"></span>
      </div>
      <div id="ap-out" style="margin-top:10px"></div>
    </div>
    <div class="row" style="margin-bottom:6px">
      <h2>Prospect — find new leads</h2>
      <span class="pill">${prov.name === 'apollo' ? 'Apollo.io' : 'web research'}</span>
    </div>
    <div class="muted small" style="margin-bottom:12px">
      Describe your ideal customer — title, industry, company stage, location, or a domain.
      ${prov.name === 'web' ? 'Big Dog uses Claude\'s live web research to find real prospects from public data (verify before outreach). Give it 20–40s.' : 'Using Apollo.io structured search.'}
    </div>
    <div class="chat-input">
      <input id="prospect-q" placeholder="e.g. Heads of RevOps at Series B SaaS in the US" />
      <button class="btn primary" onclick="findLeads()">🐕 Find leads</button>
    </div>
    <div id="prospect-out" style="margin-top:14px"></div>

    ${(state.browser && state.browser.configured) ? `
    <div class="card" style="margin-top:22px;border-left:3px solid var(--accent)">
      <strong>🌐 Read any web page</strong>
      <span class="pill" style="margin-left:8px">${state.browser.ready ? 'browser ready' : 'install agent-browser'}</span>
      <div class="muted small" style="margin:4px 0 10px">
        Big Dog opens the page in a real headless browser (handles JS-rendered sites search misses) and reads it.
        Add an instruction to have it pull out exactly what you need — names, titles, emails, a summary.
      </div>
      <input id="browse-url" class="subj" placeholder="https://company.com/team" />
      <input id="browse-q" class="subj" placeholder="What should Big Dog extract? (optional) e.g. names + titles of the leadership team" />
      <div class="actions">
        <button class="btn small primary" onclick="browsePage()">🐕 Read it</button>
      </div>
      <div id="browse-out" style="margin-top:12px"></div>
    </div>` : ''}

    <div class="card" style="margin-top:22px">
      <strong>📥 Import a lead list (CSV)</strong>
      <div class="muted small" style="margin:4px 0 10px">
        Paste or upload a CSV with a header row. Recognized columns: <code>name</code> (or <code>first</code>/<code>last</code>),
        <code>company</code>, <code>domain</code> or <code>website</code>, <code>title</code>, <code>email</code>.
        Big Dog learns each company's email format and fills the missing emails. No domain? It resolves it from the company name (Claude backend).
      </div>
      <input type="file" id="csv-file" accept=".csv,text/csv" class="subj" />
      <textarea class="edit" id="csv-text" placeholder="name,company,domain&#10;Jane Smith,Acme,acme.com&#10;Bob Lee,Globex,globex.com"></textarea>
      <div class="actions">
        <label class="small muted"><input type="checkbox" id="csv-verify" /> SMTP-verify each (slower)</label>
        <button class="btn small primary" onclick="enrichCsv(false)">Enrich</button>
        <button class="btn small good" onclick="enrichCsv(true)">Enrich + add all to pipeline</button>
      </div>
      <div id="csv-out" style="margin-top:12px"></div>
    </div>

    <div class="card" style="border-left:3px solid var(--accent)">
      <strong>🚀 Run a campaign</strong>
      <div class="muted small" style="margin:4px 0 10px">
        The one-shot play: take the list above, fill in emails, research the top few, and draft a personalized cold intro to each —
        all queued in <strong>Drafts</strong> for your approval (never sent automatically).
      </div>
      <div class="actions" style="align-items:center">
        <label class="small muted"><input type="checkbox" id="camp-pipeline" checked /> Add all to pipeline</label>
        <label class="small muted"><input type="checkbox" id="camp-draft" checked /> Draft intros</label>
        <label class="small muted">Research top <input type="number" id="camp-research" value="5" min="0" max="15" style="width:54px;background:var(--bg);color:var(--text);border:1px solid var(--line);border-radius:6px;padding:3px" /></label>
        <button class="btn small primary" onclick="runCampaign()">🐕 Run campaign</button>
      </div>
      <div id="camp-out" style="margin-top:12px"></div>
    </div>`;
  $('#prospect-q').addEventListener('keydown', (e) => { if (e.key === 'Enter') findLeads(); });
  $('#ap-goal') && $('#ap-goal').focus && null;
  $('#csv-file').addEventListener('change', (e) => {
    const f = e.target.files[0]; if (!f) return;
    const r = new FileReader(); r.onload = () => { $('#csv-text').value = r.result; }; r.readAsText(f);
  });
}

window.enrichCsv = async (save) => {
  const csv = $('#csv-text').value.trim();
  if (!csv) { toast('Paste or upload a CSV first.'); return; }
  const verify = $('#csv-verify').checked;
  const out = $('#csv-out');
  out.innerHTML = `<div class="muted">🐕 Enriching${verify ? ' + verifying' : ''}… ${verify ? '(SMTP checks take a few seconds each)' : ''}</div>`;
  try {
    const r = await api('/api/prospect/enrich', { method: 'POST', body: { csv, verify, save } });
    const rows = r.rows.map((x) => {
      const tag = x.confidence === 'verified' ? 'warm' : x.confidence === 'skipped' ? 'cold' : 'warm';
      return `<tr>
        <td>${esc(x.name)}</td><td class="muted small">${esc(x.company)}</td>
        <td>${x.email ? esc(x.email) : '<span class="muted">—</span>'}</td>
        <td><span class="tag ${tag}">${esc(x.confidence || '—')}</span></td>
        <td class="muted small">${esc(x.method)}</td></tr>`;
    }).join('');
    const filled = r.rows.filter((x) => x.email && x.confidence !== 'skipped').length;
    const map = r.mapping || {};
    const mapStr = Object.keys(map).length ? Object.entries(map).map(([h, c]) => `${esc(h)}→${esc(c)}`).join(', ') : '';
    out.innerHTML = `
      <div class="small" style="margin-bottom:8px">Enriched <strong>${filled}/${r.count}</strong> rows${save ? ' · added to pipeline' : ''}.
        <button class="btn small" onclick="downloadCsv()">⬇ Download CSV</button></div>
      ${mapStr ? `<div class="muted small" style="margin-bottom:8px">🧠 Columns understood: ${mapStr}</div>` : ''}
      <div style="overflow:auto"><table style="width:100%;border-collapse:collapse" class="small">
        <tr class="muted"><th align="left">Name</th><th align="left">Company</th><th align="left">Email</th><th align="left">Conf.</th><th align="left">How</th></tr>
        ${rows}</table></div>`;
    window.__enriched = r.rows;
    if (save) await load();
  } catch (e) { out.innerHTML = '<div class="empty">Error: ' + esc(e.message) + '</div>'; }
};

window.runCampaign = async () => {
  const csv = $('#csv-text').value.trim();
  if (!csv) { toast('Paste or upload a CSV first.'); return; }
  const body = {
    csv,
    verify: $('#csv-verify').checked,
    addToPipeline: $('#camp-pipeline').checked,
    draft: $('#camp-draft').checked,
    research: Number($('#camp-research').value || 0),
  };
  const out = $('#camp-out');
  out.innerHTML = '<div class="muted">🐕 Running the play — enriching, researching, drafting… this can take a minute.</div>';
  try {
    const r = await api('/api/campaign/run', { method: 'POST', body });
    const s = r.summary;
    out.innerHTML = `
      <div class="card">
        <strong>🐕 Campaign done.</strong>
        <div class="small" style="margin-top:6px">
          ${s.total} contacts · ${s.withEmail} with email · ${s.added} added to pipeline · ${s.researched} researched · <strong>${s.drafted} intros drafted</strong>.
        </div>
        <div class="actions"><button class="btn small primary" onclick="switchTab('drafts')">Review ${s.drafted} drafts →</button></div>
      </div>`;
    await load();
    toast(`Drafted ${s.drafted} intros — review in Drafts. 🐕`);
  } catch (e) { out.innerHTML = '<div class="empty">Error: ' + esc(e.message) + '</div>'; }
};

window.downloadCsv = () => {
  const rows = window.__enriched || [];
  const header = 'name,title,company,domain,email,confidence,method';
  const esc2 = (s) => `"${String(s || '').replace(/"/g, '""')}"`;
  const body = rows.map((r) => [r.name, r.title, r.company, r.domain, r.email, r.confidence, r.method].map(esc2).join(',')).join('\n');
  const blob = new Blob([header + '\n' + body], { type: 'text/csv' });
  const a = document.createElement('a');
  a.href = URL.createObjectURL(blob); a.download = 'big-dog-enriched.csv'; a.click();
};

window.launchAutopilot = async () => {
  const goal = $('#ap-goal').value.trim();
  if (!goal) { $('#ap-status').textContent = 'Tell Big Dog the goal first.'; return; }
  const fullyAutomate = $('#ap-auto').checked;
  $('#ap-status').textContent = '';
  $('#ap-out').innerHTML = '<div class="muted">🚀 Autopilot working — sourcing leads, researching, building outreach… (can take 1–2 min)</div>';
  try {
    const r = await api('/api/autopilot', { method: 'POST', body: { goal, fullyAutomate } });
    $('#ap-out').innerHTML = `
      <div class="card" style="background:var(--bg)">
        <strong>🚀 Autopilot is running: ${esc(r.sequenceName)}</strong>
        <div class="small" style="margin-top:6px">
          Target: <strong>${r.targetMeetings}</strong> meetings · Sourced <strong>${r.found}</strong> leads ·
          <strong>${r.withEmail}</strong> with email · Researched <strong>${r.researched}</strong> ·
          Enrolled <strong>${r.enrolled}</strong> · First touches: <strong>${r.firstTouches}</strong> ·
          Mode: <strong>${r.mode === 'fully-automate' ? 'fully automated' : 'draft & approve'}</strong>
        </div>
        ${r.notes.map((n) => `<div class="muted small" style="margin-top:4px">• ${esc(n)}</div>`).join('')}
        <div class="actions" style="margin-top:8px">
          <button class="btn small" onclick="switchTab('campaigns')">View campaign</button>
          <button class="btn small" onclick="switchTab('drafts')">See drafts</button>
        </div>
      </div>`;
    await load();
  } catch (e) { $('#ap-out').innerHTML = '<div class="empty">Error: ' + esc(e.message) + '</div>'; }
};

window.findLeads = async () => {
  const q = $('#prospect-q').value.trim();
  if (!q) return;
  const out = $('#prospect-out');
  out.innerHTML = '<div class="muted">🐕 Hunting the web with Claude… (this can take 20–40s)</div>';
  try {
    const r = await api('/api/prospect/find', { method: 'POST', body: { criteria: q } });
    const prospects = r.prospects || [];
    if (!prospects.length) {
      let msg;
      if (!r.brainLive) msg = '⚠ Claude isn\'t connected. Add your Anthropic API key in ⚙ Settings → Backend to enable lead-gen.';
      else if (!r.webCapable) msg = `⚠ Lead-gen needs the Claude backend (web access). Current backend: ${esc(r.backend || 'unknown')}. Switch to Claude in ⚙ Settings.`;
      else msg = 'No matches this time — try a broader or differently-worded brief (e.g. add a region or industry).';
      out.innerHTML = `<div class="empty">${msg}</div>`; return;
    }
    out.innerHTML = prospects.map((p, i) => `
      <div class="card">
        <div class="row">
          <div>
            <strong>${esc(p.name)}</strong> ${p.title ? `<span class="muted small">${esc(p.title)}</span>` : ''}
            <div>${esc(p.company)} ${p.location ? `<span class="muted small">· ${esc(p.location)}</span>` : ''}</div>
            <div class="small" id="lead-email-${i}">${p.email ? `✉ ${esc(p.email)}` : '<span class="muted">✉ no email yet</span>'}</div>
            ${p.linkedin ? `<div class="small"><a href="${esc(p.linkedin)}" target="_blank">LinkedIn</a></div>` : ''}
            ${p.notes ? `<div class="muted small">🐕 ${esc(p.notes)}</div>` : ''}
          </div>
          <div style="white-space:nowrap">
            ${!p.email && (p.domain || p.company) ? `<button class="btn small" onclick="findEmail(${i}, '${esc(p.name)}', '${esc(p.domain || '')}')">✉ Find email</button>` : ''}
            <button class="btn small primary" onclick='addLead(${JSON.stringify(JSON.stringify(p))}, ${i})'>+ Pipeline</button>
          </div>
        </div>
      </div>`).join('');
  window.__leads = prospects;
  } catch (e) { out.innerHTML = '<div class="empty">Error: ' + esc(e.message) + '</div>'; }
};

window.findEmail = async (i, name, domain) => {
  if (!domain) { domain = prompt('Company domain? (e.g. acme.com)') || ''; if (!domain) return; }
  const slot = $('#lead-email-' + i);
  slot.innerHTML = '<span class="muted">✉ finding…</span>';
  try {
    const r = await api('/api/prospect/email', { method: 'POST', body: { name, domain } });
    const tag = r.confidence === 'verified' ? 'good' : r.confidence === 'guess' ? 'warm' : 'cold';
    slot.innerHTML = `✉ ${esc(r.email)} <span class="tag ${tag === 'good' ? 'warm' : tag}">${esc(r.confidence)}</span><div class="muted small">${esc(r.method)}</div>`;
    if (window.__leads && window.__leads[i]) { window.__leads[i].email = r.email; window.__leads[i].domain = domain; }
  } catch (e) { slot.innerHTML = '<span class="muted">error: ' + esc(e.message) + '</span>'; }
};

window.addLead = async (pjson, i) => {
  try {
    const prospect = JSON.parse(pjson);
    if (i != null && window.__leads && window.__leads[i]) prospect.email = window.__leads[i].email || prospect.email;
    await api('/api/prospect/save', { method: 'POST', body: { prospect } });
    await load();
    toast(`Added ${prospect.name} to the pipeline. 🐕`);
  } catch (e) { toast('Error: ' + e.message); }
};

// ── Settings (LLM backend) ───────────────────────────────────────────────
async function renderSettings() {
  const el = $('#settings');
  el.innerHTML = '<div class="muted">Loading…</div>';
  let s;
  try { s = await api('/api/settings'); } catch (e) { el.innerHTML = 'Error: ' + esc(e.message); return; }
  const sel = (v) => (s.provider === v ? 'selected' : '');
  el.innerHTML = `
    <h2>Settings — your AI backend</h2>
    <div class="muted small" style="margin-bottom:14px">
      Pick who powers Big Dog and drop in your own key. Stored locally on this machine — keys never leave it except to call the model you choose.
      Current: <strong>${s.live ? esc(s.backend) : 'offline'}</strong>.
    </div>

    <div class="card" style="border-left:3px solid var(--accent)">
      <strong>🧬 Your profile &amp; voice — the clone of you</strong>
      <div class="muted small" style="margin:4px 0 10px">This is what makes Big Dog sound like <em>you</em>. Paste a batch of your real sent emails and Big Dog will learn your style.</div>
      <div style="display:flex;gap:8px;flex-wrap:wrap">
        <input class="subj" id="pf-name" placeholder="Your name" style="flex:1;min-width:140px" />
        <input class="subj" id="pf-title" placeholder="Title" style="flex:1;min-width:120px" />
        <input class="subj" id="pf-company" placeholder="Company" style="flex:1;min-width:120px" />
      </div>
      <textarea class="edit" id="pf-signature" placeholder="Email signature" style="min-height:70px"></textarea>
      <label class="small muted">Voice profile (drives every draft)</label>
      <textarea class="edit" id="pf-voice" placeholder="How you communicate…"></textarea>

      <div class="card" style="background:var(--bg);margin-top:10px">
        <label class="small muted">Learn your voice from the emails you've actually sent — the best baseline for how Big Dog replies:</label>
        <div class="actions" style="margin:6px 0">
          <button class="btn small primary" onclick="learnFromSent()">🧬 Learn from my sent mail</button>
          <span id="pf-sent-status" class="muted small"></span>
        </div>
        <label class="small muted">…or paste samples manually:</label>
        <textarea class="edit" id="pf-samples" placeholder="Paste several emails you've written (greetings, sign-offs and all)…"></textarea>
        <div class="actions">
          <button class="btn small" onclick="learnVoice()">🧬 Learn from pasted samples</button>
          <span id="pf-learn-status" class="muted small"></span>
        </div>
      </div>

      <div class="card" style="background:var(--bg);margin-top:10px">
        <strong>🚫 Don't-draft list</strong>
        <div class="muted small" style="margin:4px 0 8px">Senders Big Dog won't auto-draft replies to. Add from any message's “Don't draft” button.</div>
        <div id="suppressed-list" class="muted small">Loading…</div>
      </div>
      <div class="actions">
        <button class="btn primary" onclick="saveProfile()">Save profile</button>
        <span id="pf-status" class="muted small"></span>
      </div>
    </div>

    <div class="card">
      <label class="small muted">Backend</label>
      <select id="set-provider" class="subj" style="max-width:260px">
        <option value="auto" ${sel('auto')}>Auto (Claude → ChatGPT → Ollama)</option>
        <option value="anthropic" ${sel('anthropic')}>Claude (Anthropic)</option>
        <option value="openai" ${sel('openai')}>ChatGPT (OpenAI)</option>
        <option value="ollama" ${sel('ollama')}>Local (Ollama)</option>
      </select>
    </div>

    <div class="card">
      <strong>Claude (Anthropic)</strong> ${s.anthropicKeySet ? `<span class="tag warm">key set ${esc(s.anthropicKeyHint)}</span>` : ''}
      <div class="muted small" style="margin:4px 0 8px">Get a key at console.anthropic.com. Best quality + powers web research/prospecting.</div>
      <input class="subj" id="set-anthropicKey" type="password" placeholder="${s.anthropicKeySet ? 'leave blank to keep current key' : 'sk-ant-…'}" />
      <input class="subj" id="set-anthropicModel" value="${esc(s.anthropicModel)}" placeholder="claude-opus-4-8" />
    </div>

    <div class="card">
      <strong>ChatGPT (OpenAI)</strong> ${s.openaiKeySet ? `<span class="tag warm">key set ${esc(s.openaiKeyHint)}</span>` : ''}
      <div class="muted small" style="margin:4px 0 8px">Get a key at platform.openai.com. Note: web research/prospecting need the Claude backend.</div>
      <input class="subj" id="set-openaiKey" type="password" placeholder="${s.openaiKeySet ? 'leave blank to keep current key' : 'sk-…'}" />
      <input class="subj" id="set-openaiModel" value="${esc(s.openaiModel)}" placeholder="gpt-4o" />
    </div>

    <div class="card">
      <strong>Local (Ollama)</strong>
      <div class="muted small" style="margin:4px 0 8px">Free, fully offline. Install from ollama.com, then e.g. <code>ollama pull llama3.1</code>.</div>
      <input class="subj" id="set-ollamaHost" value="${esc(s.ollamaHost)}" placeholder="http://localhost:11434" />
      <input class="subj" id="set-ollamaModel" value="${esc(s.ollamaModel)}" placeholder="llama3.1" />
    </div>

    <div class="actions">
      <button class="btn primary" onclick="saveSettings()">💾 Save &amp; connect</button>
      <button class="btn" onclick="testSettings()">Test only</button>
      <span id="set-status" class="muted small"></span>
    </div>
    <div class="muted small" style="margin-top:6px">Paste your key and click <strong>Save &amp; connect</strong> — it stores the key and switches Big Dog to that backend. (“Test only” checks the key without saving.)</div>

    <div class="card" style="margin-top:22px">
      <strong>📹 Video meetings (Zoom)</strong> <span id="zoom-state" class="tag">checking…</span>
      <div class="muted small" style="margin:4px 0 8px">
        When connected, scheduling a meeting creates a real Zoom link and attaches it to the calendar event + invite email.
        In Zoom Marketplace, build a <strong>Server-to-Server OAuth</strong> app, add scopes <code>meeting:write</code> (create meetings) and
        <code>cloud_recording:read</code> (pull transcripts for follow-ups — also enable Cloud Recording + audio transcript in your Zoom settings), then paste the three values.
      </div>
      <input class="subj" id="zoom-accountId" placeholder="Account ID" style="width:100%" />
      <input class="subj" id="zoom-clientId" placeholder="Client ID" style="width:100%" />
      <input class="subj" id="zoom-clientSecret" type="password" placeholder="Client Secret" style="width:100%" />
      <div class="actions">
        <button class="btn primary" onclick="saveZoom()">💾 Save &amp; connect Zoom</button>
        <button class="btn" onclick="testZoom2()">Test</button>
        <span id="zoom-status" class="muted small"></span>
      </div>
    </div>

    <div class="card" style="margin-top:22px">
      <strong>🔒 Security</strong>
      <div class="muted small" id="auth-state" style="margin:4px 0 8px">Checking…</div>
      <input class="subj" id="pw-current" type="password" placeholder="Current password (only when changing)" />
      <input class="subj" id="pw-new" type="password" placeholder="New password (min 6 chars)" />
      <div class="actions">
        <button class="btn primary" onclick="setDashboardPassword()">Set password</button>
        <span id="pw-status" class="muted small"></span>
      </div>
    </div>`;
  el.innerHTML += `
    <div class="card" id="mailboxes-card">
      <strong>📬 Mailboxes</strong>
      <div class="muted small" style="margin:4px 0 8px">Just enter your email + password and hit <strong>Auto-detect</strong> — Big Dog finds the servers for you. (Gmail/Outlook need an App Password.)</div>
      <div id="mailbox-list" class="muted small">Loading…</div>
      <div style="margin-top:12px">
        <input class="subj" id="mb-id" placeholder="short id (e.g. work)" />
        <input class="subj" id="mb-email" placeholder="you@yourdomain.com" />
        <input class="subj" id="mb-pass" type="password" placeholder="password / app password" />
        <div class="actions" style="margin:6px 0">
          <button class="btn small primary" onclick="autodetectMailbox()">🔍 Auto-detect servers</button>
          <span id="mb-detect" class="muted small"></span>
        </div>
        <details id="mb-advanced" style="margin-top:4px">
        <summary class="muted small" style="cursor:pointer">Server details (filled in automatically)</summary>
        <div style="margin-top:8px">
        <label class="small muted">Preset</label>
        <select id="mb-preset" class="subj" style="max-width:220px" onchange="applyPreset()">
          <option value="">Custom…</option>
          <option value="gmail">Gmail / Google Workspace</option>
          <option value="outlook">Outlook / Microsoft 365</option>
          <option value="ionos">IONOS</option>
          <option value="yahoo">Yahoo</option>
        </select>
        <div style="display:flex;gap:8px;flex-wrap:wrap">
          <input class="subj" id="mb-imaphost" placeholder="imap host" style="flex:1" />
          <input class="subj" id="mb-imapport" placeholder="993" style="width:90px" />
        </div>
        <div style="display:flex;gap:8px;flex-wrap:wrap">
          <input class="subj" id="mb-smtphost" placeholder="smtp host" style="flex:1" />
          <input class="subj" id="mb-smtpport" placeholder="465" style="width:90px" />
          <label class="small muted" style="white-space:nowrap"><input type="checkbox" id="mb-smtpsecure" checked /> SSL</label>
        </div>
        </div>
        </details>
        <div class="actions" style="margin-top:8px">
          <button class="btn small primary" onclick="saveMailbox()">Add mailbox</button>
          <button class="btn small" onclick="testMailbox()">Test</button>
          <span id="mb-status" class="muted small"></span>
        </div>
      </div>
    </div>`;

  api('/api/auth/status').then((st) => {
    $('#auth-state') && ($('#auth-state').textContent = st.required
      ? 'A dashboard password is set. Anyone must log in.'
      : '⚠ No password set — the dashboard is open to anyone who can reach it. Set one below.');
  }).catch(() => {});
  loadMailboxes();
  loadProfile();
  loadSuppressed();
  loadZoom();
}

async function loadProfile() {
  try {
    const o = await api('/api/profile');
    $('#pf-name').value = o.name || ''; $('#pf-title').value = o.title || ''; $('#pf-company').value = o.company || '';
    $('#pf-signature').value = o.signature || ''; $('#pf-voice').value = o.voiceNotes || '';
  } catch (e) { /* not authed */ }
}
window.learnVoice = async () => {
  const samples = $('#pf-samples').value.trim();
  if (samples.length < 80) { $('#pf-learn-status').textContent = 'Paste a few real emails first.'; return; }
  $('#pf-learn-status').textContent = '🧬 Studying your writing…';
  try {
    const r = await api('/api/voice/learn', { method: 'POST', body: { samples } });
    $('#pf-voice').value = r.voiceNotes || $('#pf-voice').value;
    $('#pf-learn-status').textContent = r.observations ? '✅ ' + r.observations + ' — review & Save.' : '✅ Review the voice profile above, then Save.';
  } catch (e) { $('#pf-learn-status').textContent = 'Error: ' + e.message; }
};
window.learnFromSent = async () => {
  $('#pf-sent-status').textContent = '🧬 Reading your sent mail…';
  try {
    const r = await api('/api/voice/learn-from-sent', { method: 'POST' });
    await loadProfile();
    $('#pf-sent-status').textContent = `✅ Learned from ${r.samples} sent email(s)${r.observations ? ' — ' + r.observations : ''}. Saved.`;
    toast('Voice updated from your sent mail. 🐕');
  } catch (e) { $('#pf-sent-status').textContent = 'Error: ' + e.message; }
};
async function loadSuppressed() {
  const el = $('#suppressed-list'); if (!el) return;
  try {
    const { emails } = await api('/api/suppressed');
    el.innerHTML = emails.length
      ? emails.map((e) => `<div class="row" style="padding:4px 0"><span>${esc(e)}</span><button class="btn small ghost" onclick="unsuppress('${esc(e)}')">Remove</button></div>`).join('')
      : '<div class="muted small">Empty — Big Dog will draft for everyone worth replying to.</div>';
  } catch { el.innerHTML = '<div class="muted small">—</div>'; }
}
window.unsuppress = async (email) => {
  try { await api('/api/suppressed/' + encodeURIComponent(email), { method: 'DELETE' }); await loadSuppressed(); toast('Removed.'); }
  catch (e) { toast('Error: ' + e.message); }
};
window.saveProfile = async () => {
  $('#pf-status').textContent = 'Saving…';
  try {
    await api('/api/profile', { method: 'POST', body: {
      name: $('#pf-name').value, title: $('#pf-title').value, company: $('#pf-company').value,
      signature: $('#pf-signature').value, voiceNotes: $('#pf-voice').value,
    } });
    $('#pf-status').textContent = '✅ Saved — Big Dog now writes as you.';
    toast('Voice profile saved. 🧬');
  } catch (e) { $('#pf-status').textContent = 'Error: ' + e.message; }
};

const MB_PRESETS = {
  gmail: { imaphost: 'imap.gmail.com', imapport: 993, smtphost: 'smtp.gmail.com', smtpport: 465, smtpsecure: true },
  outlook: { imaphost: 'outlook.office365.com', imapport: 993, smtphost: 'smtp.office365.com', smtpport: 587, smtpsecure: false },
  ionos: { imaphost: 'imap.ionos.com', imapport: 993, smtphost: 'smtp.ionos.com', smtpport: 465, smtpsecure: true },
  yahoo: { imaphost: 'imap.mail.yahoo.com', imapport: 993, smtphost: 'smtp.mail.yahoo.com', smtpport: 465, smtpsecure: true },
};
window.applyPreset = () => {
  const p = MB_PRESETS[$('#mb-preset').value]; if (!p) return;
  $('#mb-imaphost').value = p.imaphost; $('#mb-imapport').value = p.imapport;
  $('#mb-smtphost').value = p.smtphost; $('#mb-smtpport').value = p.smtpport;
  $('#mb-smtpsecure').checked = p.smtpsecure;
};

window.autodetectMailbox = async () => {
  const email = $('#mb-email').value.trim();
  const password = $('#mb-pass').value;
  const out = $('#mb-detect');
  if (!email.includes('@')) { out.textContent = 'Enter your email address first.'; return; }
  out.textContent = password ? '🔍 Detecting + verifying login…' : '🔍 Detecting servers…';
  try {
    const r = await api('/api/accounts/discover', { method: 'POST', body: { email, password } });
    const c = r.config;
    if (c) {
      $('#mb-imaphost').value = c.imap.host; $('#mb-imapport').value = c.imap.port;
      $('#mb-smtphost').value = c.smtp.host; $('#mb-smtpport').value = c.smtp.port;
      $('#mb-smtpsecure').checked = !!c.smtp.secure;
      if (!$('#mb-id').value.trim()) $('#mb-id').value = (email.split('@')[1] || 'mail').split('.')[0];
    }
    if (r.ok && c && c.verified) {
      out.innerHTML = `✅ Found & logged in (${esc(c.source)}). IMAP ${esc(c.imap.host)} · SMTP ${esc(c.smtp.host)}. Click <strong>Add mailbox</strong>.`;
    } else if (c) {
      $('#mb-advanced').open = true;
      out.innerHTML = (r.detail ? esc(r.detail) + ' ' : '') + `Best guess filled in (${esc(c.source)}) — hit <strong>Test</strong> to check.`;
    } else {
      out.textContent = r.detail || "Couldn't detect the servers. Pick a preset or enter them manually below.";
      $('#mb-advanced').open = true;
    }
  } catch (e) { out.textContent = 'Error: ' + e.message; $('#mb-advanced').open = true; }
};

async function loadMailboxes() {
  try {
    const { accounts } = await api('/api/accounts');
    const list = $('#mailbox-list'); if (!list) return;
    list.innerHTML = accounts.length ? accounts.map((a) => `
      <div class="row" style="border-bottom:1px solid var(--line);padding:6px 0">
        <div><strong>${esc(a.label)}</strong> <span class="muted">${esc(a.email)}</span>
          <span class="tag ${a.source === 'file' ? 'cold' : 'warm'}">${a.source}</span>
          <div class="muted small">IMAP ${esc(a.imap.host)}:${a.imap.port} · SMTP ${esc(a.smtp.host)}:${a.smtp.port}</div></div>
        ${a.source === 'app' ? `<button class="btn small ghost" onclick="removeMailbox('${a.id}')">Remove</button>` : '<span class="muted small">in accounts.json</span>'}
      </div>`).join('') : '<div class="muted small">No mailboxes yet.</div>';
  } catch (e) { /* not authed yet */ }
}

function mailboxBody() {
  return {
    id: $('#mb-id').value, label: $('#mb-email').value, email: $('#mb-email').value,
    imap: { host: $('#mb-imaphost').value, port: $('#mb-imapport').value, secure: true, user: $('#mb-email').value, pass: $('#mb-pass').value },
    smtp: { host: $('#mb-smtphost').value, port: $('#mb-smtpport').value, secure: $('#mb-smtpsecure').checked, user: $('#mb-email').value, pass: $('#mb-pass').value },
  };
}
window.saveMailbox = async () => {
  try { await api('/api/accounts', { method: 'POST', body: mailboxBody() }); $('#mb-status').textContent = '✅ Saved.'; await loadMailboxes(); await load(); toast('Mailbox added. 🐕'); }
  catch (e) { $('#mb-status').textContent = 'Error: ' + e.message; }
};
window.testMailbox = async () => {
  $('#mb-status').textContent = 'Testing IMAP + SMTP…';
  try { const r = await api('/api/accounts/test', { method: 'POST', body: mailboxBody() });
    $('#mb-status').textContent = `IMAP ${r.imap.ok ? '✅' : '❌ ' + r.imap.detail} · SMTP ${r.smtp.ok ? '✅' : '❌ ' + r.smtp.detail}`;
  } catch (e) { $('#mb-status').textContent = 'Error: ' + e.message; }
};
window.removeMailbox = async (id) => {
  if (!confirm('Remove this mailbox?')) return;
  try { await api('/api/accounts/' + encodeURIComponent(id), { method: 'DELETE' }); await loadMailboxes(); await load(); toast('Removed.'); }
  catch (e) { toast('Error: ' + e.message); }
};

window.setDashboardPassword = async () => {
  const password = $('#pw-new').value;
  const current = $('#pw-current').value;
  if (!password || password.length < 6) { $('#pw-status').textContent = 'Min 6 characters.'; return; }
  try {
    await api('/api/auth/password', { method: 'POST', body: { password, current } });
    $('#pw-status').textContent = '✅ Password set — you are logged in.';
    $('#pw-new').value = ''; $('#pw-current').value = '';
    $('#logout-btn').style.display = '';
    toast('Dashboard password set. 🔒');
  } catch (e) { $('#pw-status').textContent = 'Error: ' + e.message; }
};

function settingsBody() {
  return {
    provider: $('#set-provider').value,
    anthropicKey: $('#set-anthropicKey').value,
    anthropicModel: $('#set-anthropicModel').value,
    openaiKey: $('#set-openaiKey').value,
    openaiModel: $('#set-openaiModel').value,
    ollamaHost: $('#set-ollamaHost').value,
    ollamaModel: $('#set-ollamaModel').value,
  };
}

window.saveSettings = async () => {
  $('#set-status').textContent = 'Saving & connecting…';
  try {
    const r = await api('/api/settings', { method: 'POST', body: settingsBody() });
    await load();
    await renderSettings();
    const st = $('#set-status');
    if (st) {
      if (r.verified) st.innerHTML = `✅ Saved &amp; connected — <strong>${esc(r.backend)}</strong>.`;
      else if (r.live) st.innerHTML = `⚠ Key saved, but the test call failed: ${esc(r.verifyDetail || 'unknown')}. Check the key is valid and the server can reach the API.`;
      else st.textContent = 'Saved — no backend active (check the key/model).';
    }
    toast(r.verified ? `Connected to ${r.backend}. 🐕` : 'Settings saved.');
  } catch (e) { $('#set-status').textContent = 'Error: ' + e.message; }
};

window.testSettings = async () => {
  $('#set-status').textContent = 'Testing…';
  try {
    const r = await api('/api/settings/test', { method: 'POST', body: settingsBody() });
    $('#set-status').textContent = (r.ok ? '✅ ' : '❌ ') + r.detail;
  } catch (e) { $('#set-status').textContent = 'Error: ' + e.message; }
};

async function loadZoom() {
  try {
    const z = await api('/api/zoom');
    const tag = $('#zoom-state'); if (tag) { tag.textContent = z.configured ? 'connected' : 'not set'; tag.className = 'tag ' + (z.configured ? 'warm' : ''); }
    if ($('#zoom-accountId')) $('#zoom-accountId').value = z.accountId || '';
  } catch { /* not authed */ }
}
function zoomBody() {
  return { accountId: $('#zoom-accountId').value.trim(), clientId: $('#zoom-clientId').value.trim(), clientSecret: $('#zoom-clientSecret').value };
}
window.saveZoom = async () => {
  $('#zoom-status').textContent = 'Saving…';
  try {
    await api('/api/zoom', { method: 'POST', body: zoomBody() });
    const t = await api('/api/zoom/test', { method: 'POST' });
    await loadZoom();
    $('#zoom-status').textContent = (t.ok ? '✅ ' : '⚠ ') + t.detail;
    toast(t.ok ? 'Zoom connected. 🐕' : 'Saved — but: ' + t.detail);
  } catch (e) { $('#zoom-status').textContent = 'Error: ' + e.message; }
};
window.testZoom2 = async () => {
  $('#zoom-status').textContent = 'Testing…';
  try { const t = await api('/api/zoom/test', { method: 'POST' }); $('#zoom-status').textContent = (t.ok ? '✅ ' : '❌ ') + t.detail; }
  catch (e) { $('#zoom-status').textContent = 'Error: ' + e.message; }
};

// ── Tabs ─────────────────────────────────────────────────────────────────
function switchTab(name) {
  document.querySelectorAll('.tab').forEach((t) => t.classList.toggle('active', t.dataset.tab === name));
  document.querySelectorAll('.panel').forEach((p) => p.classList.toggle('active', p.id === name));
  if (name === 'digest') renderDigest();
  if (name === 'chat') renderChat();
  if (name === 'prospect') renderProspect();
  if (name === 'activity') renderActivity();
  if (name === 'sent') renderSent();
  if (name === 'contacts') renderContacts();
  if (name === 'campaigns') renderCampaigns();
  if (name === 'repo') renderRepo();
  if (name === 'settings') renderSettings();
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
$('#login-pw') && $('#login-pw').addEventListener('keydown', (e) => { if (e.key === 'Enter') doLogin(); });

async function boot() {
  let st = { required: false, authed: true };
  try { st = await api('/api/auth/status'); } catch { /* ignore */ }
  $('#logout-btn').style.display = st.required && st.authed ? '' : 'none';
  if (st.required && !st.authed) { showLogin(); return; }
  $('#login').style.display = 'none';
  load().catch((e) => toast('Failed to load: ' + e.message));
}
boot();

// ── Voice dictation: a mic that follows the focused text field ────────────
(function setupDictation() {
  const SR = window.SpeechRecognition || window.webkitSpeechRecognition;
  if (!SR) return; // not supported (use Chrome/Edge)
  const btn = document.createElement('button');
  btn.className = 'float-mic'; btn.type = 'button'; btn.textContent = '🎤'; btn.title = 'Click to dictate';
  document.body.appendChild(btn);
  let field = null, rec = null;

  const isText = (el) => el && (el.tagName === 'TEXTAREA' || (el.tagName === 'INPUT' && /^(text|search|email|url|tel|number|password|)$/i.test(el.getAttribute('type') || 'text')));
  function place() {
    if (!field) return;
    const r = field.getBoundingClientRect();
    if (r.width === 0) { btn.style.display = 'none'; return; }
    btn.style.top = (r.top + 5) + 'px';
    btn.style.left = (r.right - 34) + 'px';
  }
  document.addEventListener('focusin', (e) => { if (isText(e.target)) { field = e.target; place(); btn.style.display = 'flex'; } });
  document.addEventListener('focusout', () => { setTimeout(() => { if (document.activeElement !== btn && !isText(document.activeElement)) { btn.style.display = 'none'; if (rec) { rec.stop(); } } }, 150); });
  window.addEventListener('scroll', place, true);
  window.addEventListener('resize', place);

  btn.addEventListener('mousedown', (e) => e.preventDefault()); // keep field focus
  btn.addEventListener('click', () => {
    if (rec) { rec.stop(); return; }
    if (!field) return;
    const r = new SR(); rec = r; r.lang = 'en-US'; r.interimResults = true; r.continuous = true;
    const base = field.value ? field.value.replace(/\s*$/, '') + ' ' : '';
    btn.classList.add('rec');
    r.onresult = (ev) => {
      let txt = '';
      for (let i = ev.resultIndex; i < ev.results.length; i++) txt += ev.results[i][0].transcript;
      field.value = base + txt;
      field.dispatchEvent(new Event('input', { bubbles: true }));
    };
    r.onerror = () => { btn.classList.remove('rec'); rec = null; };
    r.onend = () => { btn.classList.remove('rec'); rec = null; };
    try { r.start(); } catch { btn.classList.remove('rec'); rec = null; }
  });
})();
