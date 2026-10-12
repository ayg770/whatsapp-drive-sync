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
  error: document.getElementById('step-error')
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
let accountKey = null;
let activeJobId = null;
let finishedJobId = null;
let initializedAccount = null;
let groupsSignature = null;
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
    return JSON.parse(localStorage.getItem(`${LAST_SELECTION_KEY}:${accountKey}`)) || [];
  } catch {
    return [];
  }
}

function saveLastSelection(ids) {
  try {
    localStorage.setItem(`${LAST_SELECTION_KEY}:${accountKey}`, JSON.stringify(ids));
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
      saveLastSelection([...selectedIds]);
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
  clearTimeout(pollTimer);
  showStep('connecting');
  setStatus('');
  try {
    const res = await fetch('/api/session', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ phoneNumber })
    });
    const data = await res.json();
    if (!res.ok) throw new Error(data.error || 'יצירת החיבור נכשלה.');
    sessionId = data.sessionId;
    accountKey = null;
    initializedAccount = null;
    activeJobId = null;
    finishedJobId = null;
    poll();
  } catch {
    showStep('error');
    errorText.textContent = 'לא ניתן ליצור חיבור. נסה שוב.';
  }
}

async function poll() {
  clearTimeout(pollTimer);
  if (!sessionId) return;
  try {
    const res = await fetch(`/api/session/${sessionId}`);
    if (!res.ok) {
      sessionId = null;
      throw new Error('החיבור פג. התחבר שוב.');
    }
    const state = await res.json();
    accountKey = state.accountKey;
    if (state.error && !['connected', 'syncing'].includes(state.status)) {
      showStep('error');
      errorText.textContent = state.error;
    } else if (state.status === 'waiting_qr' && state.qr) {
      showStep('qr');
      const image = document.createElement('img');
      image.src = state.qr;
      image.alt = 'QR';
      qrEl.replaceChildren(image);
    } else if (state.status === 'waiting_pairing_code') {
      showStep('pairing');
      pairingCodeEl.textContent = state.pairingCode;
    } else if (state.status === 'loading_groups') showStep('loadingGroups');
    else if (state.status === 'syncing') {
      activeJobId = state.jobId;
      showStep('syncing');
      const p = state.progress;
      if (p)
        syncingHint.textContent = `נמצאו ${p.found} | הועלו ${p.uploaded} | כבר בדרייב ${p.skipped} | נכשלו ${p.failed} | נותרו ${p.remaining}`;
    } else if (state.status === 'connected' && state.groups) {
      if (state.error) setStatus(state.error);
      const nextSignature = JSON.stringify(state.groups);
      allGroups = state.groups;
      if (initializedAccount !== accountKey) {
        showGroupPickers();
        initializedAccount = accountKey;
      } else if (nextSignature !== groupsSignature) renderGroups();
      groupsSignature = nextSignature;
      showStep('groups');
      const history = document.getElementById('historyHint');
      history.textContent = `זמינות כעת ${state.availableImages} תמונות בהיסטוריה שהתקבלה. ${state.historyComplete ? 'WhatsApp דיווח על סיום העברת ההיסטוריה הזמינה.' : 'ההיסטוריה עדיין מתקבלת; אפשר להמתין או לסנכרן שוב בהמשך.'} אין הבטחה שכל התמונות בתקופה יתקבלו.`;
      if (state.summary && state.jobId !== finishedJobId) {
        finishedJobId = state.jobId;
        showSummary(state.summary);
      }
      activeJobId = null;
      syncBtn.disabled = false;
    } else showStep('connecting');
  } catch (err) {
    if (!sessionId) {
      showStep('error');
      errorText.textContent = err.message;
      return;
    }
    setStatus('הקשר לשרת הופרע. מנסה לבדוק שוב; אין צורך להתחיל העלאה נוספת.');
  }
  pollTimer = setTimeout(poll, 1500);
}

function showSummary(summary) {
  const counts = `נמצאו ${summary.found} | הועלו ${summary.uploaded} | כבר בדרייב ${summary.skipped} | נכשלו ${summary.failed} | נותרו ${summary.remaining}`;
  const folder = summary.folderName ? `\nתיקייה: ${summary.folderName}\n${summary.folderUrl}` : '';
  const retry = summary.failed ? '\nאפשר ללחוץ שוב על העלאה כדי לנסות את התמונות שנכשלו.' : '';
  setStatus(counts + folder + retry);
  showStep('groups');
}

disconnectBtn.addEventListener('click', async () => {
  if (!sessionId) return;
  const idToClose = sessionId;
  sessionId = null;
  clearTimeout(pollTimer);
  disconnectBtn.disabled = true;
  setStatus('מתנתק...');
  try {
    // Wait for the server to actually confirm the WhatsApp logout completed,
    // rather than fire-and-forget — otherwise the phone can keep showing the
    // device as linked even though the page has moved on.
    const response = await fetch(`/api/session/${idToClose}/close`, {
      method: 'POST'
    });
    const result = await response.json();
    if (!response.ok || result.loggedOut === false) throw new Error('Logout not confirmed');
    setStatus('החיבור נותק.');
  } catch {
    setStatus(
      'לא התקבל אישור ניתוק. בדוק בוואטסאפ ← מכשירים מקושרים והסר את החיבור אם הוא עדיין מופיע.'
    );
  }
  disconnectBtn.disabled = false;
  showStep('choose');
});

async function performSync(groupIds) {
  if (activeJobId) return;
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

  try {
    const res = await fetch(`/api/session/${sessionId}/sync`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ groupIds, lookbackDays: lookbackSelect.value })
    });
    const data = await res.json();
    if (!res.ok) {
      showStep('error');
      errorText.textContent = data.error;
      return;
    }
    activeJobId = data.jobId;
    poll();
  } catch (err) {
    // The POST may have succeeded despite a lost response: poll before retrying.
    setStatus('בודק את מצב ההעלאה לאחר הפרעה בחיבור...');
    poll();
  } finally {
    if (!activeJobId) syncBtn.disabled = false;
  }
}

syncBtn.addEventListener('click', () => performSync(Array.from(selectedIds)));

retryBtn.addEventListener('click', async () => {
  if (sessionId) {
    try {
      const state = await (await fetch(`/api/session/${sessionId}`)).json();
      if (['connected', 'syncing'].includes(state.status)) {
        poll();
        return;
      }
      await fetch(`/api/session/${sessionId}/close`, { method: 'POST' });
    } catch {}
  }
  sessionId = null;
  clearTimeout(pollTimer);
  showStep('choose');
});
showStep('choose');
