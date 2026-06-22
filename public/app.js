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
function messageCard(m) {
  const p = m.priority || 'cold';
  const drafted = state.drafts.some((d) => d.inReplyTo && d.inReplyTo === m.messageId);
  return `
    <div class="card ${p}">
      <div class="row">
        <div>
          <strong>${esc(m.fromName)}</strong>
          <span class="muted small">&lt;${esc(m.fromEmail)}&gt;</span>
          ${drafted ? '<span class="tag warm" title="Reply auto-drafted">✍ drafted</span>' : ''}
          <div>${esc(m.subject)}</div>
          ${m.summary ? `<div class="muted small">🐕 ${esc(m.summary)}</div>` : ''}
        </div>
        <div style="text-align:right;white-space:nowrap">
          <span class="tag ${p}">${p}</span>
          <div class="muted small">${fmtDate(m.date)}</div>
        </div>
      </div>
      <div class="msg-body" id="body-${m.id}">${esc(m.body)}</div>
      <div id="intel-${m.id}"></div>
      <div class="actions">
        <button class="btn small ghost" onclick="toggleBody('${m.id}')">Read</button>
        <button class="btn small primary" onclick="draftReply('${m.id}')">🐕 Draft my reply</button>
        <button class="btn small" onclick="research('${m.id}','${esc(m.fromName)} ${esc(m.fromEmail)}')">🔎 Research</button>
        <button class="btn small ghost" onclick="remember('${esc(m.fromEmail)}')">📝 Remember</button>
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
  else renderInboxList(state.messages);
}

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

window.remember = async (email) => {
  const note = prompt(`What should Big Dog remember about ${email}?`);
  if (!note) return;
  try { await api('/api/memory', { method: 'POST', body: { email, note } }); toast('🐕 Got it — noted.'); }
  catch (e) { toast('Error: ' + e.message); }
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
  el.innerHTML = `
    <div class="row" style="margin-bottom:14px">
      <h2>Pipeline</h2>
      <button class="btn small primary" onclick="runFollowups()">🐕 Run follow-ups</button>
    </div>
    <div class="board">${board}</div>`;
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
    <div class="row" style="margin-bottom:6px">
      <h2>Prospect — find new leads</h2>
      <span class="pill">${prov.name === 'apollo' ? 'Apollo.io' : 'web research'}</span>
    </div>
    <div class="muted small" style="margin-bottom:12px">
      Describe your ideal customer — title, industry, company stage, location, or a domain.
      ${prov.name === 'web' ? 'Using free web research (public data — verify before outreach). Add an APOLLO_API_KEY for structured B2B search.' : 'Using Apollo.io structured search.'}
    </div>
    <div class="chat-input">
      <input id="prospect-q" placeholder="e.g. Heads of RevOps at Series B SaaS in the US" />
      <button class="btn primary" onclick="findLeads()">🐕 Find leads</button>
    </div>
    <div id="prospect-out" style="margin-top:14px"></div>`;
  $('#prospect-q').addEventListener('keydown', (e) => { if (e.key === 'Enter') findLeads(); });
}

window.findLeads = async () => {
  const q = $('#prospect-q').value.trim();
  if (!q) return;
  const out = $('#prospect-out');
  out.innerHTML = '<div class="muted">🐕 Hunting…</div>';
  try {
    const { prospects } = await api('/api/prospect/find', { method: 'POST', body: { criteria: q } });
    if (!prospects.length) { out.innerHTML = '<div class="empty">No leads found. Try a broader brief, or add an APOLLO_API_KEY.</div>'; return; }
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
      <button class="btn primary" onclick="saveSettings()">Save</button>
      <button class="btn" onclick="testSettings()">Test connection</button>
      <span id="set-status" class="muted small"></span>
    </div>`;
}

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
  $('#set-status').textContent = 'Saving…';
  try {
    const r = await api('/api/settings', { method: 'POST', body: settingsBody() });
    await load();
    await renderSettings();
    $('#set-status') && ($('#set-status').textContent = r.live ? `Saved — now on ${r.backend}.` : 'Saved — backend offline (check key/model).');
    toast('Settings saved. 🐕');
  } catch (e) { $('#set-status').textContent = 'Error: ' + e.message; }
};

window.testSettings = async () => {
  $('#set-status').textContent = 'Testing…';
  try {
    const r = await api('/api/settings/test', { method: 'POST', body: settingsBody() });
    $('#set-status').textContent = (r.ok ? '✅ ' : '❌ ') + r.detail;
  } catch (e) { $('#set-status').textContent = 'Error: ' + e.message; }
};

// ── Tabs ─────────────────────────────────────────────────────────────────
function switchTab(name) {
  document.querySelectorAll('.tab').forEach((t) => t.classList.toggle('active', t.dataset.tab === name));
  document.querySelectorAll('.panel').forEach((p) => p.classList.toggle('active', p.id === name));
  if (name === 'digest') renderDigest();
  if (name === 'chat') renderChat();
  if (name === 'prospect') renderProspect();
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
load().catch((e) => toast('Failed to load: ' + e.message));
