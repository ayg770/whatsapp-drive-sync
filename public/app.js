const LAST_SELECTION_KEY = 'wa-drive-sync:last-selection';

const steps = {
  connecting: document.getElementById('step-connecting'),
  qr: document.getElementById('step-qr'),
  groups: document.getElementById('step-groups'),
  syncing: document.getElementById('step-syncing'),
  error: document.getElementById('step-error'),
};
const qrEl = document.getElementById('qr');
const groupsEl = document.getElementById('groups');
const syncBtn = document.getElementById('syncBtn');
const retryBtn = document.getElementById('retryBtn');
const errorText = document.getElementById('errorText');
const statusEl = document.getElementById('status');

let sessionId = null;
let pollTimer = null;
let currentGroups = [];

function showStep(name) {
  for (const key of Object.keys(steps)) {
    steps[key].classList.toggle('hidden', key !== name);
  }
}

function setStatus(text) {
  statusEl.textContent = text;
  statusEl.classList.toggle('empty', !text);
}

function getLastSelection() {
  try {
    return JSON.parse(localStorage.getItem(LAST_SELECTION_KEY)) || [];
  } catch {
    return [];
  }
}

function saveLastSelection(ids) {
  try {
    localStorage.setItem(LAST_SELECTION_KEY, JSON.stringify(ids));
  } catch {
    // ignore storage failures (private browsing etc.)
  }
}

function renderGroups(groups) {
  currentGroups = groups;
  const lastSelection = getLastSelection();
  groupsEl.innerHTML = '';
  for (const g of groups) {
    const row = document.createElement('label');
    row.className = 'group';
    const checkbox = document.createElement('input');
    checkbox.type = 'checkbox';
    checkbox.value = g.id;
    checkbox.checked = lastSelection.includes(g.id);
    const name = document.createElement('span');
    name.className = 'name';
    name.textContent = g.name;
    row.append(checkbox, name);
    groupsEl.appendChild(row);
  }
}

async function startSession() {
  showStep('connecting');
  setStatus('');
  const res = await fetch('/api/session', { method: 'POST' });
  const data = await res.json();
  sessionId = data.sessionId;
  poll();
}

async function poll() {
  clearTimeout(pollTimer);
  const res = await fetch(`/api/session/${sessionId}`);

  if (!res.ok) {
    showStep('error');
    errorText.textContent = 'החיבור פג. נסה שוב.';
    return;
  }

  const state = await res.json();

  if (state.error) {
    showStep('error');
    errorText.textContent = state.error;
    return;
  }

  if (state.status === 'waiting_qr' && state.qr) {
    showStep('qr');
    qrEl.innerHTML = `<img src="${state.qr}" alt="QR code" />`;
  } else if (state.status === 'connected' && state.groups) {
    showStep('groups');
    renderGroups(state.groups);
  } else if (state.status === 'syncing') {
    showStep('syncing');
  } else if (state.status === 'done') {
    showSummary(state.summary);
    return; // stop polling
  } else {
    showStep('connecting');
  }

  pollTimer = setTimeout(poll, 1500);
}

function showSummary(summary) {
  showStep('groups');
  if (!summary || summary.uploaded === 0) {
    setStatus('אין תמונות חדשות להעלאה מהקבוצות שנבחרו.');
  } else {
    const bySenderText = Object.entries(summary.bySender)
      .map(([name, count]) => `${name}: ${count}`)
      .join('\n');
    setStatus(
      `הועלו ${summary.uploaded} תמונות לתיקייה "${summary.folderName}".\n\n${bySenderText}\n\n${summary.folderUrl}`
    );
  }
  groupsEl.innerHTML = '';
  syncBtn.textContent = 'התחבר שוב ובצע העלאה נוספת';
  syncBtn.onclick = () => startSession();
}

syncBtn.addEventListener('click', async () => {
  const groupIds = Array.from(groupsEl.querySelectorAll('input[type=checkbox]:checked')).map(
    (cb) => cb.value
  );
  if (!groupIds.length) {
    setStatus('בחר לפחות קבוצה אחת.');
    return;
  }
  saveLastSelection(groupIds);
  clearTimeout(pollTimer);
  syncBtn.disabled = true;
  showStep('syncing');
  setStatus('');

  try {
    const res = await fetch(`/api/session/${sessionId}/sync`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ groupIds }),
    });
    const data = await res.json();
    if (!res.ok) {
      showStep('error');
      errorText.textContent = data.error;
      return;
    }
    showSummary(data);
  } catch (err) {
    showStep('error');
    errorText.textContent = err.message;
  } finally {
    syncBtn.disabled = false;
  }
});

retryBtn.addEventListener('click', () => startSession());

startSession();
