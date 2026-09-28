const groupsEl = document.getElementById('groups');
const statusEl = document.getElementById('status');
const syncBtn = document.getElementById('syncBtn');
const refreshBtn = document.getElementById('refreshBtn');
const reselectBtn = document.getElementById('reselectBtn');

let currentGroups = [];
let lastSelection = [];

function setStatus(text) {
  statusEl.textContent = text;
  statusEl.classList.toggle('empty', !text);
}

function render(selectedIds) {
  groupsEl.innerHTML = '';
  for (const g of currentGroups) {
    const row = document.createElement('label');
    row.className = 'group';

    const checkbox = document.createElement('input');
    checkbox.type = 'checkbox';
    checkbox.value = g.id;
    checkbox.checked = selectedIds.includes(g.id);

    const name = document.createElement('span');
    name.className = 'name';
    name.textContent = g.name;

    const count = document.createElement('span');
    count.className = 'count';
    count.textContent = `${g.pendingCount} ממתינות`;

    row.append(checkbox, name, count);
    groupsEl.appendChild(row);
  }
}

async function loadGroups() {
  setStatus('טוען קבוצות...');
  const res = await fetch('/api/groups');
  const data = await res.json();
  currentGroups = data.groups;
  lastSelection = data.lastSelection || [];
  render(lastSelection);
  setStatus('');
}

refreshBtn.addEventListener('click', async () => {
  setStatus('מרענן רשימת קבוצות מוואטסאפ...');
  await fetch('/api/groups/refresh', { method: 'POST' });
  await loadGroups();
});

reselectBtn.addEventListener('click', () => {
  render(lastSelection);
});

syncBtn.addEventListener('click', async () => {
  const groupIds = Array.from(groupsEl.querySelectorAll('input[type=checkbox]:checked')).map(
    (cb) => cb.value
  );

  if (!groupIds.length) {
    setStatus('בחר לפחות קבוצה אחת.');
    return;
  }

  setStatus('מסנכרן, אנא המתן...');
  syncBtn.disabled = true;

  try {
    const res = await fetch('/api/sync', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ groupIds }),
    });
    const data = await res.json();

    if (!res.ok) {
      setStatus(`שגיאה: ${data.error}`);
      return;
    }

    if (data.uploaded === 0) {
      setStatus('אין תמונות חדשות לסנכרון מהקבוצות שנבחרו.');
    } else {
      const bySenderText = Object.entries(data.bySender)
        .map(([name, count]) => `${name}: ${count}`)
        .join('\n');
      setStatus(
        `הועלו ${data.uploaded} תמונות לתיקייה "${data.folderName}".\n\n${bySenderText}\n\n${data.folderUrl}`
      );
    }

    await loadGroups();
  } catch (err) {
    setStatus(`שגיאה: ${err.message}`);
  } finally {
    syncBtn.disabled = false;
  }
});

loadGroups();
