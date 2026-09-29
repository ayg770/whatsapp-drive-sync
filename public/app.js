const LAST_SELECTION_KEY = 'wa-drive-sync:last-selection';
const LOOKBACK_KEY = 'wa-drive-sync:lookback-days';
const PAGE_SIZE = 20;

const steps = {
  choose: document.getElementById('step-choose'),
  phone: document.getElementById('step-phone'),
  connecting: document.getElementById('step-connecting'),
  qr: document.getElementById('step-qr'),
  pairing: document.getElementById('step-pairing'),
  loadingGroups: document.getElementById('step-loading-groups'),
  groups: document.getElementById('step-groups'),
  syncing: document.getElementById('step-syncing'),
  error: document.getElementById('step-error'),
};
const qrEl = document.getElementById('qr');
const pairingCodeEl = document.getElementById('pairingCode');
const lookbackSelect = document.getElementById('lookbackSelect');
const groupsEl = document.getElementById('groups');
const searchInput = document.getElementById('searchInput');
const moreBtn = document.getElementById('moreBtn');
const syncBtn = document.getElementById('syncBtn');
const disconnectBtn = document.getElementById('disconnectBtn');
const retryBtn = document.getElementById('retryBtn');
const errorText = document.getElementById('errorText');
const statusEl = document.getElementById('status');
const syncingHint = document.getElementById('syncingHint');
const chooseQrBtn = document.getElementById('chooseQr');
const choosePhoneBtn = document.getElementById('choosePhone');
const backFromPhoneBtn = document.getElementById('backFromPhone');
const submitPhoneBtn = document.getElementById('submitPhone');
const phoneInput = document.getElementById('phoneInput');

let sessionId = null;
let pollTimer = null;
let allGroups = [];
let selectedIds = new Set();
let searchQuery = '';
let visibleCount = PAGE_SIZE;

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

try {
  const savedLookback = localStorage.getItem(LOOKBACK_KEY);
  if (savedLookback) lookbackSelect.value = savedLookback;
} catch {
  // ignore
}
lookbackSelect.addEventListener('change', () => {
  try {
    localStorage.setItem(LOOKBACK_KEY, lookbackSelect.value);
  } catch {
    // ignore
  }
});

function renderGroups() {
  const filtered = searchQuery
    ? allGroups.filter((g) => g.name.toLowerCase().includes(searchQuery.toLowerCase()))
    : allGroups;
  const visible = filtered.slice(0, visibleCount);

  groupsEl.innerHTML = '';
  for (const g of visible) {
    const row = document.createElement('label');
    row.className = 'group';

    const checkbox = document.createElement('input');
    checkbox.type = 'checkbox';
    checkbox.value = g.id;
    checkbox.checked = selectedIds.has(g.id);
    checkbox.addEventListener('change', () => {
      if (checkbox.checked) selectedIds.add(g.id);
      else selectedIds.delete(g.id);
    });

    const name = document.createElement('span');
    name.className = 'name';
    name.textContent = g.name;

    row.append(checkbox, name);
    groupsEl.appendChild(row);
  }

  moreBtn.classList.toggle('hidden', filtered.length <= visibleCount);
}

// Always show the full list, with the previous selection already checked —
// review and confirm, or change it, before uploading.
function showGroupPickers() {
  const lastSelection = getLastSelection().filter((id) => allGroups.some((g) => g.id === id));
  selectedIds = new Set(lastSelection);
  searchQuery = '';
  visibleCount = PAGE_SIZE;
  searchInput.value = '';
  renderGroups();
}

searchInput.addEventListener('input', () => {
  searchQuery = searchInput.value;
  visibleCount = PAGE_SIZE;
  renderGroups();
});

moreBtn.addEventListener('click', () => {
  visibleCount += PAGE_SIZE;
  renderGroups();
});

chooseQrBtn.addEventListener('click', () => startSession());
choosePhoneBtn.addEventListener('click', () => showStep('phone'));
backFromPhoneBtn.addEventListener('click', () => showStep('choose'));
submitPhoneBtn.addEventListener('click', () => {
  const phoneNumber = phoneInput.value.replace(/\D/g, '');
  if (!phoneNumber) {
    setStatus('הזן מספר טלפון תקין.');
    return;
  }
  startSession(phoneNumber);
});

async function startSession(phoneNumber) {
  showStep('connecting');
  setStatus('');
  const res = await fetch('/api/session', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ phoneNumber }),
  });
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
  } else if (state.status === 'waiting_pairing_code' && state.pairingCode) {
    showStep('pairing');
    pairingCodeEl.textContent = state.pairingCode;
  } else if (state.status === 'loading_groups') {
    showStep('loadingGroups');
  } else if (state.status === 'connected' && state.groups) {
    // Groups only change once (right after connecting), so stop polling here
    // instead of re-rendering (and wiping the user's in-progress selection)
    // every couple of seconds.
    allGroups = state.groups;
    showStep('groups');
    showGroupPickers();
    return; // stop polling
  } else if (state.status === 'syncing') {
    showStep('syncing');
  } else {
    showStep('connecting');
  }

  pollTimer = setTimeout(poll, 1500);
}

function showSummary(summary) {
  // The link stays open after this — the visitor can pick another set of
  // groups and sync again without reconnecting, until they close the tab.
  if (!summary || summary.uploaded === 0) {
    setStatus('אין תמונות חדשות להעלאה מהקבוצות שנבחרו. אפשר לנסות שוב בעוד כמה שניות אם ההיסטוריה עוד נטענת.');
  } else {
    const byGroupText = Object.entries(summary.byGroup)
      .map(([name, count]) => `הועלו ${count} תמונות מקבוצת '${name}'`)
      .join('\n');
    setStatus(`${byGroupText}\n\nתיקייה: "${summary.folderName}"\n${summary.folderUrl}`);
  }
  showStep('groups');
  showGroupPickers();
}

disconnectBtn.addEventListener('click', async () => {
  if (!sessionId) return;
  const idToClose = sessionId;
  sessionId = null;
  disconnectBtn.disabled = true;
  setStatus('מתנתק...');
  try {
    // Wait for the server to actually confirm the WhatsApp logout completed,
    // rather than fire-and-forget — otherwise the phone can keep showing the
    // device as linked even though the page has moved on.
    await fetch(`/api/session/${idToClose}/close`, { method: 'POST' });
  } catch {
    // best-effort — the server-side idle timeout will clean it up eventually
  }
  disconnectBtn.disabled = false;
  setStatus('');
  showStep('choose');
});

async function pollSyncProgress() {
  try {
    const res = await fetch(`/api/session/${sessionId}`);
    if (res.ok) {
      const state = await res.json();
      if (state.progress?.total) {
        syncingHint.textContent = `מוריד ומעלה תמונה ${state.progress.current} מתוך ${state.progress.total}...`;
      }
    }
  } catch {
    // best-effort only; the main sync request is the source of truth
  }
}

async function performSync(groupIds) {
  if (!groupIds.length) {
    setStatus('בחר לפחות קבוצה אחת.');
    return;
  }
  saveLastSelection(groupIds);
  clearTimeout(pollTimer);
  syncBtn.disabled = true;
  showStep('syncing');
  syncingHint.textContent = 'מעלה תמונות, אנא המתן...';
  setStatus('');

  const progressTimer = setInterval(pollSyncProgress, 1500);

  try {
    const res = await fetch(`/api/session/${sessionId}/sync`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ groupIds, lookbackDays: lookbackSelect.value }),
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
    clearInterval(progressTimer);
    syncBtn.disabled = false;
  }
}

syncBtn.addEventListener('click', () => performSync(Array.from(selectedIds)));

retryBtn.addEventListener('click', () => showStep('choose'));
