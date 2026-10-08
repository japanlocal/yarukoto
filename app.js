// 画面の制御

const $ = (sel) => document.querySelector(sel);
const $$ = (sel) => [...document.querySelectorAll(sel)];

const ui = {
  view: 'today',
  editingId: null,
};

function escapeHtml(s) {
  return String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}

// ---------- 一覧の組み立て ----------

function byPriorityThenDue(a, b) {
  return (b.priority - a.priority)
    || (a.due || '9999').localeCompare(b.due || '9999')
    || (a.time || '99').localeCompare(b.time || '99')
    || a.createdAt - b.createdAt;
}

function bucketOf(task) {
  if (!task.due) return 'none';
  const diff = daysUntil(task.due);
  if (diff < 0) return 'overdue';
  if (diff === 0) return 'today';
  if (diff === 1) return 'tomorrow';
  if (diff < 7) return 'week';
  return 'later';
}

const BUCKET_LABELS = {
  overdue: '⚠️ 期限切れ', today: '今日', tomorrow: '明日', week: '7日以内', later: 'それ以降', none: '期限なし',
};

const VIEWS = {
  today: { buckets: ['overdue', 'today'], empty: '🎉 今日やることはありません' },
  upcoming: { buckets: ['tomorrow', 'week', 'later'], empty: '予定されているタスクはありません' },
  all: { buckets: ['overdue', 'today', 'tomorrow', 'week', 'later', 'none'], empty: 'タスクはありません。下の欄から追加しましょう' },
};

function groupsForView(view) {
  const tasks = Store.visible();
  if (view === 'done') {
    const done = tasks.filter((t) => t.done).sort((a, b) => (b.doneAt || 0) - (a.doneAt || 0));
    return { groups: done.length ? [{ label: '完了済み', tasks: done }] : [], empty: 'まだ完了したタスクはありません' };
  }
  const { buckets, empty } = VIEWS[view];
  const open = tasks.filter((t) => !t.done);
  const groups = buckets
    .map((b) => ({ key: b, label: BUCKET_LABELS[b], tasks: open.filter((t) => bucketOf(t) === b).sort(byPriorityThenDue) }))
    .filter((g) => g.tasks.length);
  return { groups, empty };
}

function counts() {
  const open = Store.visible().filter((t) => !t.done);
  return {
    today: open.filter((t) => ['overdue', 'today'].includes(bucketOf(t))).length,
    upcoming: open.filter((t) => ['tomorrow', 'week', 'later'].includes(bucketOf(t))).length,
    all: open.length,
  };
}

function taskHtml(task) {
  const subDone = task.subtasks.filter((s) => s.done).length;
  const meta = [];
  if (task.due) meta.push(`<span class="${isOverdue(task) ? 'overdue' : ''}">📅 ${escapeHtml(formatDue(task))}</span>`);
  if (task.remind != null && task.due) meta.push('<span>🔔</span>');
  if (task.subtasks.length) meta.push(`<span>☑️ ${subDone}/${task.subtasks.length}</span>`);
  if (task.notes) meta.push('<span>📝</span>');
  return `
    <li class="task p${task.priority}${task.done ? ' done' : ''}" data-id="${escapeHtml(task.id)}">
      <button type="button" class="check" data-check aria-label="${task.done ? '未完了に戻す' : '完了にする'}"></button>
      <div class="task-body" data-open>
        <div class="task-title">${escapeHtml(task.title)}</div>
        ${meta.length ? `<div class="task-meta">${meta.join('')}</div>` : ''}
      </div>
    </li>`;
}

function render() {
  const c = counts();
  $$('[data-count]').forEach((el) => { el.textContent = c[el.dataset.count] || ''; });
  $$('[data-view]').forEach((el) => el.setAttribute('aria-selected', el.dataset.view === ui.view));

  const { groups, empty } = groupsForView(ui.view);
  $('#task-groups').innerHTML = groups.length
    ? groups.map((g) => `
        <section class="group ${g.key || ''}">
          <h2>${g.label}<span>${g.tasks.length}</span></h2>
          <ul class="tasks">${g.tasks.map(taskHtml).join('')}</ul>
        </section>`).join('')
    : `<p class="empty">${empty}</p>`;

  renderSyncIndicator();
  updateBadge(c.today);
  if (ui.editingId) refreshEditor();
}

Store.onChange(render);

$$('[data-view]').forEach((btn) => btn.addEventListener('click', () => {
  ui.view = btn.dataset.view;
  render();
  window.scrollTo(0, 0);
}));

// ---------- 完了・未完了 ----------

function toggleDone(id) {
  const task = Store.get(id);
  if (!task) return;
  const done = !task.done;
  Store.update(id, { done, doneAt: done ? Date.now() : null });
  if (done) {
    showToast(`✅「${task.title}」を完了しました`, '元に戻す', () => Store.update(id, { done: false, doneAt: null }));
  }
}

$('#task-groups').addEventListener('click', (e) => {
  const item = e.target.closest('.task');
  if (!item) return;
  if (e.target.closest('[data-check]')) {
    item.classList.add('checking');
    setTimeout(() => toggleDone(item.dataset.id), 180); // チェックの動きを見せてから並び替える
  } else if (e.target.closest('[data-open]')) {
    openEditor(item.dataset.id);
  }
});

// ---------- クイック追加 ----------

const PRIORITY_LABELS = ['', '低', '中', '高'];

$('#quick-input').addEventListener('input', () => {
  const value = $('#quick-input').value;
  const parsed = parseQuickAdd(value);
  const chips = [];
  if (parsed.due) chips.push(`📅 ${formatDue(parsed)}`);
  if (parsed.priority) chips.push(`優先度 ${PRIORITY_LABELS[parsed.priority]}`);
  $('#quick-preview').hidden = chips.length === 0 || !value.trim();
  $('#quick-preview').innerHTML = chips.map((c) => `<span>${escapeHtml(c)}</span>`).join('');
});

$('#quick-add').addEventListener('submit', (e) => {
  e.preventDefault();
  const parsed = parseQuickAdd($('#quick-input').value);
  if (!parsed.title) return;
  // 「今日」タブで日付なしに追加したら今日のタスクにする
  if (!parsed.due && ui.view === 'today') parsed.due = todayStr();
  const task = Store.create(parsed);
  $('#quick-input').value = '';
  $('#quick-preview').hidden = true;

  const visibleHere = ui.view === 'all' || groupsForView(ui.view).groups.some((g) => g.tasks.includes(task));
  if (!visibleHere) {
    const dest = ['overdue', 'today'].includes(bucketOf(task)) ? '今日' : task.due ? '予定' : 'すべて';
    showToast(`「${dest}」に追加しました`);
  }
});

// ---------- 編集シート ----------

const dialog = $('#task-dialog');

function openEditor(id) {
  ui.editingId = id;
  refreshEditor({ full: true });
  dialog.showModal();
  autosize($('#edit-title')); // 表示されてからでないと高さを測れない
}

function editing() { return Store.get(ui.editingId); }

// full: テキスト欄も上書きする (入力中のカーソルが飛ばないよう、通常はそれ以外だけ更新)
function refreshEditor({ full = false } = {}) {
  const task = editing();
  if (!task) { if (dialog.open) dialog.close(); return; }
  if (full) {
    $('#edit-title').value = task.title;
    $('#edit-notes').value = task.notes;
    autosize($('#edit-title'));
  }
  $('#edit-done').className = `check big p${task.priority}${task.done ? ' on' : ''}`;
  $$('#edit-priority [data-priority]').forEach((b) => b.setAttribute('aria-pressed', Number(b.dataset.priority) === task.priority));
  $('#edit-due').value = task.due || '';
  $('#edit-time').value = task.time || '';
  $('#edit-time').disabled = !task.due;
  $('#edit-remind').value = task.remind == null ? '' : String(task.remind);
  $('#edit-remind').disabled = !task.due;
  $$('[data-due]').forEach((b) => {
    const target = b.dataset.due === 'clear' ? null : addDays(todayStr(), Number(b.dataset.due));
    b.setAttribute('aria-pressed', task.due === target);
  });
  renderSubtasks(task);
}

function renderSubtasks(task) {
  const done = task.subtasks.filter((s) => s.done).length;
  $('#sub-progress').textContent = task.subtasks.length ? `${done}/${task.subtasks.length}` : '';
  const list = $('#subtask-list');
  // 入力中のサブタスクは作り直さない
  if (list.contains(document.activeElement) && list.children.length === task.subtasks.length) {
    task.subtasks.forEach((s, i) => list.children[i].querySelector('[data-sub-check]').classList.toggle('on', s.done));
    return;
  }
  list.innerHTML = task.subtasks.map((s) => `
    <li data-sub="${escapeHtml(s.id)}" class="${s.done ? 'done' : ''}">
      <button type="button" class="check small${s.done ? ' on' : ''}" data-sub-check aria-label="完了"></button>
      <input type="text" value="${escapeHtml(s.title)}" data-sub-title aria-label="サブタスク名">
      <button type="button" class="icon-btn" data-sub-delete aria-label="削除">✕</button>
    </li>`).join('');
}

function autosize(el) {
  el.style.height = 'auto';
  el.style.height = `${el.scrollHeight}px`;
}

let textTimer = null;
function saveTextSoon(field, value) {
  clearTimeout(textTimer);
  textTimer = setTimeout(() => Store.update(ui.editingId, { [field]: value }), 400);
}

$('#edit-title').addEventListener('input', (e) => {
  autosize(e.target);
  if (e.target.value.trim()) saveTextSoon('title', e.target.value.trim());
});
$('#edit-title').addEventListener('keydown', (e) => { if (e.key === 'Enter' && !e.isComposing) { e.preventDefault(); e.target.blur(); } });
$('#edit-notes').addEventListener('input', (e) => saveTextSoon('notes', e.target.value));

$('#edit-done').addEventListener('click', () => {
  const task = editing();
  const completing = !task.done;
  toggleDone(task.id);
  if (completing) dialog.close(); // 完了にしたら閉じる
});

$('#edit-priority').addEventListener('click', (e) => {
  const btn = e.target.closest('[data-priority]');
  if (btn) Store.update(ui.editingId, { priority: Number(btn.dataset.priority) });
});

$$('[data-due]').forEach((btn) => btn.addEventListener('click', () => {
  if (btn.dataset.due === 'clear') Store.update(ui.editingId, { due: null, time: null, remind: null });
  else Store.update(ui.editingId, { due: addDays(todayStr(), Number(btn.dataset.due)) });
}));

$('#edit-due').addEventListener('change', (e) => {
  Store.update(ui.editingId, e.target.value ? { due: e.target.value } : { due: null, time: null, remind: null });
});
$('#edit-time').addEventListener('change', (e) => Store.update(ui.editingId, { time: e.target.value || null }));
$('#edit-remind').addEventListener('change', (e) => {
  const remind = e.target.value === '' ? null : Number(e.target.value);
  Store.update(ui.editingId, { remind });
  if (remind != null) askNotificationPermission();
});

// サブタスク
function updateSubtasks(fn) {
  const task = editing();
  Store.update(task.id, { subtasks: fn(task.subtasks.map((s) => ({ ...s }))) });
}

function addSubtask() {
  const input = $('#subtask-input');
  const title = input.value.trim();
  if (!title) return;
  updateSubtasks((subs) => [...subs, { id: newId(), title, done: false }]);
  input.value = '';
  input.focus();
}

$('#subtask-add').addEventListener('click', addSubtask);
$('#subtask-input').addEventListener('keydown', (e) => {
  if (e.key === 'Enter' && !e.isComposing) { e.preventDefault(); addSubtask(); }
});

$('#subtask-list').addEventListener('click', (e) => {
  const li = e.target.closest('[data-sub]');
  if (!li) return;
  const id = li.dataset.sub;
  if (e.target.closest('[data-sub-check]')) {
    updateSubtasks((subs) => subs.map((s) => (s.id === id ? { ...s, done: !s.done } : s)));
  } else if (e.target.closest('[data-sub-delete]')) {
    updateSubtasks((subs) => subs.filter((s) => s.id !== id));
    $('#subtask-list').innerHTML = ''; // 作り直させる
    renderSubtasks(editing());
  }
});

$('#subtask-list').addEventListener('change', (e) => {
  if (!e.target.matches('[data-sub-title]')) return;
  const id = e.target.closest('[data-sub]').dataset.sub;
  const title = e.target.value.trim();
  updateSubtasks((subs) => (title ? subs.map((s) => (s.id === id ? { ...s, title } : s)) : subs.filter((s) => s.id !== id)));
});

$('#edit-delete').addEventListener('click', () => {
  const task = editing();
  const snapshot = JSON.parse(JSON.stringify(task));
  dialog.close();
  Store.remove(task.id);
  showToast(`🗑️「${snapshot.title}」を削除しました`, '元に戻す', () => {
    Store.replaceAll([...Store.tasks.filter((t) => t.id !== snapshot.id), { ...snapshot, updatedAt: Date.now() }]);
  });
});

$('#edit-calendar').addEventListener('click', () => {
  flushText();
  const task = editing();
  if (!task.due) { showToast('先に期限を設定してください'); return; }
  downloadIcs(task);
});

// 入力途中の文字を確実に保存
function flushText() {
  clearTimeout(textTimer);
  const task = editing();
  if (!task) return;
  const title = $('#edit-title').value.trim();
  const changes = {};
  if (title && title !== task.title) changes.title = title;
  if ($('#edit-notes').value !== task.notes) changes.notes = $('#edit-notes').value;
  if (Object.keys(changes).length) Store.update(task.id, changes);
}

dialog.addEventListener('close', () => {
  flushText();
  ui.editingId = null;
  $('#subtask-list').innerHTML = '';
});

// 背景タップで閉じる
[dialog, $('#settings-dialog')].forEach((d) => d.addEventListener('click', (e) => { if (e.target === d) d.close(); }));

// ---------- カレンダー (.ics) ----------
// アプリを閉じていても確実に通知させたいときは、端末のカレンダーに登録してもらう

function icsText(s) {
  return String(s).replace(/\\/g, '\\\\').replace(/;/g, '\\;').replace(/,/g, '\\,').replace(/\r?\n/g, '\\n');
}

function icsDate(d) {
  return `${d.getFullYear()}${pad(d.getMonth() + 1)}${pad(d.getDate())}T${pad(d.getHours())}${pad(d.getMinutes())}00`;
}

function downloadIcs(task) {
  const lines = ['BEGIN:VCALENDAR', 'VERSION:2.0', 'PRODID:-//yarukoto//JA', 'BEGIN:VEVENT',
    `UID:${task.id}@yarukoto`, `DTSTAMP:${icsDate(new Date())}`, `SUMMARY:${icsText(task.title)}`];
  if (task.time) {
    const start = dueDateTime(task);
    lines.push(`DTSTART:${icsDate(start)}`, `DTEND:${icsDate(new Date(start.getTime() + 30 * 60000))}`);
  } else {
    lines.push(`DTSTART;VALUE=DATE:${task.due.replace(/-/g, '')}`, `DTEND;VALUE=DATE:${addDays(task.due, 1).replace(/-/g, '')}`);
  }
  const desc = [task.notes, ...task.subtasks.map((s) => `${s.done ? '☑' : '☐'} ${s.title}`)].filter(Boolean).join('\n');
  if (desc) lines.push(`DESCRIPTION:${icsText(desc)}`);
  if (task.remind != null) {
    // 終日の予定は 0:00 起点なので、朝9時からの差に直す
    const minutes = task.time ? -task.remind : DEFAULT_REMIND_HOUR * 60 - task.remind;
    lines.push('BEGIN:VALARM', 'ACTION:DISPLAY', `DESCRIPTION:${icsText(task.title)}`,
      `TRIGGER:${minutes < 0 ? '-' : ''}PT${Math.abs(minutes)}M`, 'END:VALARM');
  }
  lines.push('END:VEVENT', 'END:VCALENDAR');

  const blob = new Blob([lines.join('\r\n')], { type: 'text/calendar' });
  const a = document.createElement('a');
  a.href = URL.createObjectURL(blob);
  a.download = `${task.title.slice(0, 40) || 'task'}.ics`;
  a.click();
  setTimeout(() => URL.revokeObjectURL(a.href), 10000);
}

// ---------- リマインド通知 ----------
// サーバーを持たないため、通知はアプリを開いている (またはバックグラウンドで生きている) 間に出す

const NOTIFIED_STORAGE = 'yarukoto.notified';
let notified = readJson(NOTIFIED_STORAGE, {});

function askNotificationPermission() {
  if (!('Notification' in window) || Notification.permission !== 'default') return Promise.resolve();
  return Notification.requestPermission().then(renderNotifyDetail);
}

async function notify(task) {
  const body = task.due ? `📅 ${formatDue(task)}` : '';
  if ('Notification' in window && Notification.permission === 'granted') {
    const reg = await navigator.serviceWorker?.getRegistration();
    if (reg) { reg.showNotification(task.title, { body, tag: task.id, icon: 'icons/icon-192.png', badge: 'icons/icon-192.png' }); return; }
    new Notification(task.title, { body, tag: task.id });
    return;
  }
  showToast(`🔔 ${task.title}${body ? `（${body}）` : ''}`);
}

function checkReminders() {
  const now = Date.now();
  let changed = false;
  for (const task of Store.visible()) {
    const at = remindAt(task);
    if (!at) continue;
    const key = at.toISOString();
    // 1日以上前に過ぎた通知は出さない (久しぶりに開いたときの大量通知を防ぐ)
    if (at.getTime() <= now && at.getTime() > now - 86400000 && notified[task.id] !== key) {
      notified[task.id] = key;
      changed = true;
      notify(task);
    }
  }
  if (changed) writeJson(NOTIFIED_STORAGE, notified);
}

function updateBadge(count) {
  if (!('setAppBadge' in navigator)) return;
  (count ? navigator.setAppBadge(count) : navigator.clearAppBadge()).catch(() => {});
}

setInterval(checkReminders, 30 * 1000);
document.addEventListener('visibilitychange', () => { if (document.visibilityState === 'visible') { checkReminders(); render(); } });

// ---------- 同期の表示 ----------

function renderSyncIndicator() {
  const { status, message, at } = Store.syncState;
  const btn = $('#sync-btn');
  btn.dataset.status = Store.syncEnabled ? status : 'off';
  btn.textContent = { off: '☁️ 未同期', syncing: '🔄 同期中', ok: '☁️ 同期済み', error: '⚠️ 同期エラー' }[btn.dataset.status];

  const time = at ? `${pad(at.getHours())}:${pad(at.getMinutes())}` : '';
  $('#sync-detail').textContent = !Store.syncEnabled
    ? 'いまはこの端末だけに保存されています。同期すると、スマホとPCで同じタスクを見られます。'
    : status === 'error' ? `⚠️ ${message}`
      : status === 'syncing' ? '同期しています…'
        : `✅ 同期しています${time ? `（最終 ${time}）` : ''}`;
  $('#sync-setup').hidden = Store.syncEnabled;
  $('#sync-connected').hidden = !Store.syncEnabled;
}

$('#sync-btn').addEventListener('click', openSettings);

// ---------- 設定 ----------

const settings = $('#settings-dialog');

function openSettings() {
  renderSyncIndicator();
  renderNotifyDetail();
  $('#link-panel').hidden = true;
  settings.showModal();
}

$('#settings-btn').addEventListener('click', openSettings);

$('#token-save').addEventListener('click', () => {
  const token = $('#token-input').value.trim();
  if (!/^(ghp_|github_pat_|gho_)/.test(token)) { showToast('GitHub のトークン（ghp_ で始まる文字列）を入力してください'); return; }
  Store.setToken(token);
  $('#token-input').value = '';
});

$('#sync-now').addEventListener('click', syncNow);

$('#sync-off').addEventListener('click', () => {
  if (!confirm('この端末の同期を解除しますか？（タスクはこの端末に残ります）')) return;
  Store.disableSync();
});

function linkUrl() {
  return `${location.origin}${location.pathname}#token=${encodeURIComponent(Store.sync.token)}`;
}

$('#link-device').addEventListener('click', () => {
  const panel = $('#link-panel');
  panel.hidden = !panel.hidden;
  if (panel.hidden) return;
  $('#qr').innerHTML = '';
  if (window.QRCode) new QRCode($('#qr'), { text: linkUrl(), width: 200, height: 200, correctLevel: QRCode.CorrectLevel.M });
  else $('#qr').textContent = 'QRコードを表示できません。「リンクをコピー」を使ってください';
});

$('#copy-link').addEventListener('click', async () => {
  try {
    await navigator.clipboard.writeText(linkUrl());
    showToast('📋 連携用リンクをコピーしました（他人に送らないでください）');
  } catch {
    showToast('コピーできませんでした');
  }
});

function renderNotifyDetail() {
  const supported = 'Notification' in window;
  const perm = supported ? Notification.permission : 'unsupported';
  const isIos = /iphone|ipad|ipod/i.test(navigator.userAgent);
  const standalone = matchMedia('(display-mode: standalone)').matches || navigator.standalone;
  $('#notify-detail').textContent = {
    granted: '✅ 通知は許可されています。アプリを開いている間（またはバックグラウンドで動いている間）にリマインドします。閉じていても確実に知らせたいタスクは「📅 カレンダーに登録」を使ってください。',
    denied: '通知がブロックされています。端末の設定からこのアプリの通知を許可してください。',
    default: 'リマインドを通知で受け取るには、通知を許可してください。',
    unsupported: isIos && !standalone
      ? 'iPhone では、ホーム画面に追加したアプリからのみ通知を使えます（Safari の共有ボタン →「ホーム画面に追加」）。'
      : 'このブラウザは通知に対応していません。アプリ内の表示でお知らせします。',
  }[perm];
  $('#notify-enable').hidden = perm !== 'default';
}

$('#notify-enable').addEventListener('click', askNotificationPermission);

// 書き出し・読み込み
$('#export-btn').addEventListener('click', () => {
  const blob = new Blob([JSON.stringify({ version: 1, exportedAt: new Date().toISOString(), tasks: Store.tasks }, null, 2)], { type: 'application/json' });
  const a = document.createElement('a');
  a.href = URL.createObjectURL(blob);
  a.download = `yarukoto-${todayStr()}.json`;
  a.click();
  setTimeout(() => URL.revokeObjectURL(a.href), 10000);
});

$('#import-input').addEventListener('change', async (e) => {
  const file = e.target.files[0];
  e.target.value = '';
  if (!file) return;
  try {
    const data = JSON.parse(await file.text());
    const tasks = Array.isArray(data) ? data : data.tasks;
    const valid = Array.isArray(tasks) && tasks.every((t) => t && t.id && (t.deleted || typeof t.title === 'string'));
    if (!valid) throw new Error('invalid');
    Store.replaceAll(mergeTasks(Store.tasks, tasks));
    showToast(`📥 ${tasks.filter((t) => !t.deleted).length}件を読み込みました`);
  } catch {
    showToast('読み込めませんでした（やること で書き出したファイルを選んでください）');
  }
});

$('#clear-done').addEventListener('click', () => {
  const done = Store.visible().filter((t) => t.done);
  if (!done.length) { showToast('完了済みのタスクはありません'); return; }
  if (!confirm(`完了済みの ${done.length} 件を削除しますか？`)) return;
  done.forEach((t) => Store.remove(t.id));
  showToast(`🗑️ ${done.length}件を削除しました`);
});

// ---------- トースト ----------

let toastTimer = null;

function showToast(message, actionLabel, onAction) {
  const toast = $('#toast');
  const action = $('#toast-action');
  // 開いているシートより手前に出すため、シートの中に移す
  const host = document.querySelector('dialog[open]') || document.body;
  if (toast.parentElement !== host) host.appendChild(toast);
  $('#toast-text').textContent = message;
  action.hidden = !actionLabel;
  action.textContent = actionLabel || '';
  action.onclick = () => { toast.classList.remove('show'); onAction?.(); };
  toast.classList.add('show');
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => toast.classList.remove('show'), actionLabel ? 5000 : 2500);
}

// ---------- 初期化 ----------

// QRコード・リンクから開かれたときは、同期のトークンを受け取る
function acceptTokenFromUrl() {
  if (!location.hash.startsWith('#token=')) return;
  const token = decodeURIComponent(location.hash.slice('#token='.length));
  history.replaceState(null, '', location.pathname + location.search); // URL からトークンを消す
  if (token) {
    Store.setToken(token);
    showToast('☁️ 同期の設定が完了しました');
  }
}
acceptTokenFromUrl();
window.addEventListener('hashchange', acceptTokenFromUrl); // アプリを開いたままリンクを開いた場合

if ('serviceWorker' in navigator) {
  navigator.serviceWorker.register('sw.js').catch((e) => console.warn('Service Worker の登録に失敗:', e));
}

render();
checkReminders();
syncNow();
