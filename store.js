// タスクの保存と同期
//
// 端末の localStorage を正とし (オフラインでも使える)、GitHub の非公開 Gist と
// タスク単位で「更新日時が新しい方を採用」してマージする。
// 削除は tombstone (deleted: true) として残し、他の端末にも削除を伝える。
//
// Task = {
//   id, title, notes, due: 'YYYY-MM-DD' | null, time: 'HH:MM' | null,
//   remind: 期限の何分前に通知するか | null, priority: 0(なし)〜3(高),
//   subtasks: [{ id, title, done }], done, doneAt, createdAt, updatedAt, deleted?
// }

const TASKS_STORAGE = 'yarukoto.tasks';
const SYNC_STORAGE = 'yarukoto.sync'; // { token, gistId }
const GIST_FILENAME = 'yarukoto-tasks.json';
const GIST_DESCRIPTION = 'やること アプリの同期データ (自動生成・削除しないでください)';
const TOMBSTONE_TTL_MS = 30 * 24 * 60 * 60 * 1000;
const SYNC_DEBOUNCE_MS = 1500;

function readJson(key, fallback) {
  try { return JSON.parse(localStorage.getItem(key)) ?? fallback; } catch { return fallback; }
}

function writeJson(key, value) {
  try { localStorage.setItem(key, JSON.stringify(value)); } catch { /* 容量超過・プライベートモード */ }
}

function newId() {
  return crypto.randomUUID ? crypto.randomUUID() : `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 10)}`;
}

const Store = {
  tasks: readJson(TASKS_STORAGE, []),
  sync: readJson(SYNC_STORAGE, {}),
  syncState: { status: 'off', message: '', at: null }, // off | syncing | ok | error
  listeners: new Set(),

  onChange(fn) { this.listeners.add(fn); },
  emit() { this.listeners.forEach((fn) => fn()); },

  visible() { return this.tasks.filter((t) => !t.deleted); },
  get(id) { return this.tasks.find((t) => t.id === id && !t.deleted); },

  create(fields) {
    const now = Date.now();
    const task = {
      id: newId(), title: '', notes: '', due: null, time: null, remind: null, priority: 0,
      subtasks: [], done: false, doneAt: null, createdAt: now, ...fields, updatedAt: now,
    };
    this.tasks.push(task);
    this.commit();
    return task;
  },

  update(id, changes) {
    const task = this.tasks.find((t) => t.id === id);
    if (!task) return null;
    Object.assign(task, changes, { updatedAt: Date.now() });
    this.commit();
    return task;
  },

  remove(id) {
    const task = this.tasks.find((t) => t.id === id);
    if (!task) return;
    // 他の端末に削除を伝えるため、中身を消して印だけ残す
    Object.keys(task).forEach((k) => { if (!['id', 'createdAt'].includes(k)) delete task[k]; });
    Object.assign(task, { deleted: true, updatedAt: Date.now() });
    this.commit();
  },

  replaceAll(tasks) {
    this.tasks = tasks;
    this.commit();
  },

  commit() {
    writeJson(TASKS_STORAGE, this.tasks);
    this.emit();
    scheduleSync();
  },

  // ---------- 同期設定 ----------

  get syncEnabled() { return Boolean(this.sync.token); },

  setToken(token) {
    this.sync = { token: token.trim() };
    writeJson(SYNC_STORAGE, this.sync);
    syncNow();
  },

  disableSync() {
    this.sync = {};
    writeJson(SYNC_STORAGE, this.sync);
    setSyncState('off');
  },
};

// ---------- マージ ----------

function mergeTasks(local, remote) {
  const byId = new Map();
  for (const t of [...remote, ...local]) {
    const cur = byId.get(t.id);
    if (!cur || (t.updatedAt || 0) > (cur.updatedAt || 0)) byId.set(t.id, t);
  }
  const cutoff = Date.now() - TOMBSTONE_TTL_MS;
  return [...byId.values()].filter((t) => !(t.deleted && t.updatedAt < cutoff));
}

function sameTasks(a, b) {
  const key = (list) => JSON.stringify([...list].sort((x, y) => (x.id < y.id ? -1 : 1)));
  return key(a) === key(b);
}

// ---------- GitHub Gist API ----------

async function gh(path, options = {}) {
  const res = await fetch(`https://api.github.com${path}`, {
    ...options,
    cache: 'no-store',
    headers: {
      Accept: 'application/vnd.github+json',
      Authorization: `Bearer ${Store.sync.token}`,
      'X-GitHub-Api-Version': '2022-11-28',
      ...(options.body ? { 'Content-Type': 'application/json' } : {}),
    },
  });
  if (res.status === 401) throw new Error('トークンが無効か、期限が切れています');
  if (res.status === 403 || res.status === 404) {
    throw new Error(res.headers.get('x-ratelimit-remaining') === '0'
      ? 'GitHub の利用回数の上限に達しました。しばらく待ってください'
      : 'Gist にアクセスできません。トークンに gist の権限があるか確認してください');
  }
  if (!res.ok) throw new Error(`GitHub エラー (${res.status})`);
  return res.status === 204 ? null : res.json();
}

async function findOrCreateGist() {
  for (let page = 1; page <= 5; page++) {
    const gists = await gh(`/gists?per_page=100&page=${page}`);
    const found = gists.find((g) => g.files[GIST_FILENAME]);
    if (found) return found.id;
    if (gists.length < 100) break;
  }
  const created = await gh('/gists', {
    method: 'POST',
    body: JSON.stringify({
      description: GIST_DESCRIPTION,
      public: false,
      files: { [GIST_FILENAME]: { content: JSON.stringify({ version: 1, tasks: [] }) } },
    }),
  });
  return created.id;
}

async function readGistTasks(gistId) {
  const gist = await gh(`/gists/${gistId}`);
  const file = gist.files[GIST_FILENAME];
  if (!file) return [];
  // 1MB を超えると content が途中で切れるので raw_url から取り直す
  const text = file.truncated
    ? await (await fetch(file.raw_url, { cache: 'no-store' })).text()
    : file.content;
  try { return JSON.parse(text).tasks || []; } catch { return []; }
}

async function writeGistTasks(gistId, tasks) {
  await gh(`/gists/${gistId}`, {
    method: 'PATCH',
    body: JSON.stringify({
      files: { [GIST_FILENAME]: { content: JSON.stringify({ version: 1, updatedAt: Date.now(), tasks }) } },
    }),
  });
}

// ---------- 同期の実行 ----------

let syncTimer = null;
let syncing = false;
let syncAgain = false;

function setSyncState(status, message = '') {
  Store.syncState = { status, message, at: status === 'ok' ? new Date() : Store.syncState.at };
  Store.emit();
}

function scheduleSync() {
  if (!Store.syncEnabled) return;
  clearTimeout(syncTimer);
  syncTimer = setTimeout(syncNow, SYNC_DEBOUNCE_MS);
}

async function syncNow() {
  if (!Store.syncEnabled) return;
  if (!navigator.onLine) { setSyncState('error', 'オフライン（つながったら同期します）'); return; }
  if (syncing) { syncAgain = true; return; }
  syncing = true;
  clearTimeout(syncTimer);
  setSyncState('syncing');
  try {
    if (!Store.sync.gistId) {
      Store.sync.gistId = await findOrCreateGist();
      writeJson(SYNC_STORAGE, Store.sync);
    }
    const remote = await readGistTasks(Store.sync.gistId);
    const merged = mergeTasks(Store.tasks, remote);
    if (!sameTasks(merged, Store.tasks)) {
      Store.tasks = merged;
      writeJson(TASKS_STORAGE, Store.tasks);
    }
    if (!sameTasks(merged, remote)) await writeGistTasks(Store.sync.gistId, merged);
    setSyncState('ok');
  } catch (err) {
    // Gist が消された場合は次回作り直す
    if (/アクセスできません/.test(err.message)) { delete Store.sync.gistId; writeJson(SYNC_STORAGE, Store.sync); }
    setSyncState('error', err.message);
  } finally {
    syncing = false;
    if (syncAgain) { syncAgain = false; syncNow(); }
  }
}

// アプリに戻ってきたとき・オンラインになったとき・1分ごとに同期
document.addEventListener('visibilitychange', () => { if (document.visibilityState === 'visible') syncNow(); });
window.addEventListener('online', syncNow);
setInterval(() => { if (document.visibilityState === 'visible') syncNow(); }, 60 * 1000);
