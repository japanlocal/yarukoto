// 日付まわりと、クイック追加の入力解析
// 日付は端末のタイムゾーンの 'YYYY-MM-DD' 文字列で扱う

const WEEKDAYS = ['日', '月', '火', '水', '木', '金', '土'];
const DEFAULT_REMIND_HOUR = 9; // 時刻なしの期限は朝9時を基準に通知する

function pad(n) { return String(n).padStart(2, '0'); }

function toDateStr(d) { return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`; }

function parseDateStr(s) {
  const [y, m, d] = s.split('-').map(Number);
  return new Date(y, m - 1, d);
}

function todayStr() { return toDateStr(new Date()); }

function addDays(dateStr, n) {
  const d = parseDateStr(dateStr);
  d.setDate(d.getDate() + n);
  return toDateStr(d);
}

function daysUntil(dateStr) {
  return Math.round((parseDateStr(dateStr) - parseDateStr(todayStr())) / 86400000);
}

// 「今日」「明日」「10/12(日)」「来週月曜」のような表示用ラベル
function formatDue(task) {
  if (!task.due) return '';
  const diff = daysUntil(task.due);
  const d = parseDateStr(task.due);
  let label;
  if (diff === 0) label = '今日';
  else if (diff === 1) label = '明日';
  else if (diff === 2) label = '明後日';
  else if (diff === -1) label = '昨日';
  else if (diff > 0 && diff < 7) label = `${WEEKDAYS[d.getDay()]}曜`;
  else {
    const year = d.getFullYear() !== new Date().getFullYear() ? `${d.getFullYear()}/` : '';
    label = `${year}${d.getMonth() + 1}/${d.getDate()}(${WEEKDAYS[d.getDay()]})`;
  }
  return task.time ? `${label} ${task.time}` : label;
}

function isOverdue(task) {
  if (!task.due || task.done) return false;
  const diff = daysUntil(task.due);
  if (diff < 0) return true;
  if (diff === 0 && task.time) return dueDateTime(task) < new Date();
  return false;
}

function dueDateTime(task) {
  const d = parseDateStr(task.due);
  if (task.time) {
    const [h, m] = task.time.split(':').map(Number);
    d.setHours(h, m, 0, 0);
  } else {
    d.setHours(DEFAULT_REMIND_HOUR, 0, 0, 0);
  }
  return d;
}

function remindAt(task) {
  if (!task.due || task.remind == null || task.done) return null;
  return new Date(dueDateTime(task).getTime() - task.remind * 60000);
}

// ---------- クイック追加の解析 ----------
// 例: 「明日 15:00 レポート提出 !高」→ { title: 'レポート提出', due: 明日, time: '15:00', priority: 3 }

const PRIORITY_WORDS = { 高: 3, 中: 2, 低: 1 };

function nextWeekday(target, { nextWeek = false } = {}) {
  const today = parseDateStr(todayStr());
  let diff = (target - today.getDay() + 7) % 7;
  if (nextWeek) {
    // 来週の◯曜 = 次の月曜から始まる週の◯曜
    const toNextMonday = ((1 - today.getDay() + 7) % 7) || 7;
    diff = toNextMonday + ((target + 6) % 7);
  }
  return addDays(todayStr(), diff);
}

function parseQuickAdd(input) {
  let text = ` ${input} `;
  const result = { due: null, time: null, priority: 0 };
  const take = (re, fn) => {
    const m = text.match(re);
    if (!m) return;
    if (fn(m) !== false) text = text.replace(m[0], ' ');
  };

  // 優先度: !高 / !中 / !低 / !!! / !!
  take(/\s[!！]([高中低])(?=\s)/, (m) => { result.priority = PRIORITY_WORDS[m[1]]; });
  take(/\s([!！]{2,3})(?=\s)/, (m) => { result.priority = m[1].length === 3 ? 3 : 2; });

  // 日付
  take(/\s(今日|きょう)(?=\s)/, () => { result.due = todayStr(); });
  take(/\s(明日|あした)(?=\s)/, () => { result.due = addDays(todayStr(), 1); });
  take(/\s(明後日|あさって)(?=\s)/, () => { result.due = addDays(todayStr(), 2); });
  take(/\s(来週)(?=\s)/, () => { result.due = nextWeekday(1, { nextWeek: true }); });
  take(/\s(来週)?([月火水木金土日])曜日?(?=\s)/, (m) => {
    result.due = nextWeekday(WEEKDAYS.indexOf(m[2]), { nextWeek: Boolean(m[1]) });
  });
  take(/\s(\d{1,2})[/月](\d{1,2})日?(?=\s)/, (m) => {
    const month = Number(m[1]); const day = Number(m[2]);
    if (month < 1 || month > 12 || day < 1 || day > 31) return false;
    const now = new Date();
    let d = new Date(now.getFullYear(), month - 1, day);
    if (toDateStr(d) < todayStr()) d = new Date(now.getFullYear() + 1, month - 1, day); // 過ぎた日付は来年
    result.due = toDateStr(d);
  });

  // 時刻: 15:00 / 15時 / 15時半
  take(/\s(\d{1,2})[:：](\d{2})(?=\s)/, (m) => {
    if (Number(m[1]) > 23 || Number(m[2]) > 59) return false;
    result.time = `${pad(m[1])}:${m[2]}`;
  });
  take(/\s(\d{1,2})時(半)?(?=\s)/, (m) => {
    if (Number(m[1]) > 23) return false;
    result.time = `${pad(m[1])}:${m[2] ? '30' : '00'}`;
  });
  if (result.time && !result.due) result.due = todayStr();

  result.title = text.replace(/\s+/g, ' ').trim();
  return result;
}
