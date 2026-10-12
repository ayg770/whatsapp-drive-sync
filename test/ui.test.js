import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';

function browser() {
  const elements = new Map();
  const storage = new Map();
  function element() {
    return {
      value: '7',
      textContent: '',
      children: [],
      listeners: {},
      disabled: false,
      classList: {
        hidden: false,
        toggle(name, on) {
          this[name] = on;
        }
      },
      addEventListener(name, fn) {
        this.listeners[name] = fn;
      },
      append(...children) {
        this.children.push(...children);
      },
      appendChild(child) {
        this.children.push(child);
      },
      replaceChildren(...children) {
        this.children = children;
      },
      set innerHTML(value) {
        this.children = [];
      },
      get innerHTML() {
        return '';
      }
    };
  }
  const context = vm.createContext({
    document: {
      getElementById: (id) => {
        if (!elements.has(id)) elements.set(id, element());
        return elements.get(id);
      },
      createElement: element
    },
    localStorage: {
      getItem: (key) => storage.get(key),
      setItem: (key, value) => storage.set(key, value)
    },
    setTimeout: () => 1,
    clearTimeout: () => {},
    console,
    fetch: async () => {
      throw Error('network unavailable');
    }
  });
  vm.runInContext(fs.readFileSync(new URL('../public/app.js', import.meta.url), 'utf8'), context);
  return { context, elements, storage, run: (code) => vm.runInContext(code, context) };
}
test('initial page shows method choice and remembered groups are isolated by WhatsApp identity', () => {
  const b = browser();
  assert.equal(b.elements.get('step-choose').classList.hidden, false);
  assert.equal(b.elements.get('step-connecting').classList.hidden, true);
  b.run(
    `accountKey='account-a';allGroups=[{id:'a',name:'A'},{id:'b',name:'B'}];saveLastSelection(['a']);showGroupPickers();`
  );
  assert.deepEqual(Array.from(b.run('[...selectedIds]')), ['a']);
  b.run(`accountKey='account-b';showGroupPickers();`);
  assert.equal(b.run('selectedIds.size'), 0);
  b.run(`saveLastSelection(['b']);accountKey='account-a';showGroupPickers();`);
  assert.deepEqual(Array.from(b.run('[...selectedIds]')), ['a']);
});
test('late group activity preserves checkbox choices and search while polling', async () => {
  const b = browser();
  let state = {
    status: 'connected',
    accountKey: 'a',
    groups: [
      { id: 'a', name: 'A' },
      { id: 'b', name: 'B' }
    ],
    availableImages: 0
  };
  b.context.fetch = async () => ({ ok: true, json: async () => state });
  b.run(`sessionId='session';`);
  await b.run('poll()');
  b.run(`selectedIds.add('b');searchQuery='B';searchInput.value='B';`);
  state = {
    ...state,
    groups: [
      { id: 'b', name: 'B', lastActivity: 10 },
      { id: 'a', name: 'A', lastActivity: 1 }
    ]
  };
  await b.run('poll()');
  assert.deepEqual(Array.from(b.run('[...selectedIds]')), ['b']);
  assert.equal(b.run('searchQuery'), 'B');
  assert.equal(b.elements.get('groups').children[0].children[0].checked, true);
});
test('lost start response resumes status polling instead of restarting upload', async () => {
  const b = browser();
  let posts = 0;
  b.context.fetch = async (url, opts) => {
    if (opts?.method === 'POST') {
      posts++;
      throw Error('response lost');
    }
    return {
      ok: true,
      json: async () => ({
        status: 'syncing',
        jobId: 'existing',
        progress: { found: 4, uploaded: 1, failed: 1, skipped: 0, remaining: 2 }
      })
    };
  };
  b.run(`sessionId='session';accountKey='a';`);
  await b.run(`performSync(['group'])`);
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(posts, 1);
  assert.equal(b.run('activeJobId'), 'existing');
  assert.match(b.elements.get('syncingHint').textContent, /נמצאו 4/);
  assert.match(b.elements.get('syncingHint').textContent, /נכשלו 1/);
});
