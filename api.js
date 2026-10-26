// =====================================================================
// ToDo API 層：畫面（index.html）只透過這裡讀寫資料，不直接碰資料庫。
//   畫面 index.html  →  api.js（本檔）  →  Supabase（登入 /auth/v1、資料 /rest/v1）
// 換 Supabase 專案：改 config.js。
// 換成別種後端：只要改寫本檔，維持下面「對外提供的函式」名稱與資料格式即可，畫面不用動。
//
// 畫面使用的資料格式（JS 物件）與資料表欄位的對照：
//   task : id, title, due(due_date), note, done(is_done), doneAt(done_at), trashed(is_trashed),
//          trashedAt(trashed_at), archivedAt(archived_at), created(created_at), subs[]
//   sub  : id, title, due(due_date), note, done(is_done), doneAt(done_at), sortOrder(sort_order)
//   tier : id, name, max(max_days), color, hideDone(hide_done)
//   settings : groupBy(group_by), ui(ui_theme)
// 時間在畫面端一律用毫秒數字（Date.now()），日期用 'YYYY-MM-DD' 字串。
// =====================================================================
(() => {
  const C = window.TODO_CONFIG;
  const BASE = C.projectUrl.replace(/\/+$/, '').replace(/\/rest\/v1$/, '');
  const REST = BASE + '/rest/v1';
  const AUTH = BASE + '/auth/v1';
  const SESSION_KEY = 'todo-session';

  class ApiError extends Error {
    constructor(message, status, code) { super(message); this.status = status; this.code = code; }
    get needsLogin() { return this.status === 401 || this.code === 'no_session'; }
  }

  /* ---------------- 登入狀態（只存登入憑證，不存任何待辦資料） ---------------- */
  let session = null;
  try { session = JSON.parse(localStorage.getItem(SESSION_KEY)); } catch (e) { session = null; }
  function setSession(s) {
    session = s;
    try { s ? localStorage.setItem(SESSION_KEY, JSON.stringify(s)) : localStorage.removeItem(SESSION_KEY); } catch (e) {}
  }
  function keepSession(j) {
    setSession({
      access_token: j.access_token,
      refresh_token: j.refresh_token,
      expires_at: j.expires_at || Math.floor(Date.now() / 1000) + (j.expires_in || 3600),
      email: j.user?.email || session?.email || '',
    });
  }

  async function authPost(path, body) {
    let r;
    try {
      r = await fetch(AUTH + path, { method: 'POST', headers: { apikey: C.publishableKey, 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
    } catch (e) { throw new ApiError('連不上伺服器，請檢查網路。', 0, 'network'); }
    const j = await r.json().catch(() => ({}));
    if (!r.ok) {
      const raw = j.error_description || j.msg || j.message || '';
      const msg = /invalid login credentials/i.test(raw) ? '帳號或密碼不正確。' : (raw || `登入失敗（${r.status}）`);
      throw new ApiError(msg, r.status, j.error_code || j.error || 'auth');
    }
    return j;
  }

  let refreshing = null;
  function refresh() {
    if (!session?.refresh_token) return Promise.reject(new ApiError('請重新登入。', 401, 'no_session'));
    refreshing ??= authPost('/token?grant_type=refresh_token', { refresh_token: session.refresh_token })
      .then(keepSession)
      .catch(e => { if (e.status >= 400 && e.status < 500) setSession(null); throw new ApiError('登入已過期，請重新登入。', 401, 'no_session'); })
      .finally(() => { refreshing = null; });
    return refreshing;
  }
  async function accessToken() {
    if (!session) throw new ApiError('請先登入。', 401, 'no_session');
    if (session.expires_at - 60 < Date.now() / 1000) await refresh();
    return session.access_token;
  }

  /* ---------------- 共用的資料請求 ---------------- */
  async function rest(method, path, { body, prefer } = {}, retry = true) {
    const headers = {
      apikey: C.publishableKey,
      Authorization: 'Bearer ' + await accessToken(),
      'Accept-Profile': C.schema,
      'Content-Profile': C.schema,
    };
    if (body !== undefined) headers['Content-Type'] = 'application/json';
    if (prefer) headers.Prefer = prefer;
    let r;
    try {
      r = await fetch(REST + path, { method, headers, body: body === undefined ? undefined : JSON.stringify(body) });
    } catch (e) { throw new ApiError('連不上伺服器，請檢查網路。', 0, 'network'); }
    if (r.status === 401 && retry) { await refresh(); return rest(method, path, { body, prefer }, false); }
    const text = await r.text();
    let j = null;
    try { j = text ? JSON.parse(text) : null; } catch (e) { j = null; }
    if (!r.ok) {
      let msg = (j && (j.message || j.hint)) || `伺服器錯誤（${r.status}）`;
      if (j?.code === '23505') msg = '有重複的資料（例如兩個層級的天數上限相同）。';
      if (j?.code === '42501') msg = '沒有權限存取資料表，請確認 schema.sql 已執行，且 todo schema 已加入 Exposed schemas。';
      if (j?.code === 'PGRST106') msg = 'todo schema 尚未開放給 API，請到 Supabase 的 API 設定加入 Exposed schemas。';
      if (j?.code === 'PGRST205' || j?.code === '42P01') msg = '找不到資料表，請先在 Supabase 執行 schema.sql。';
      if ((j?.code === 'PGRST204' || j?.code === '42703') && /archived_at/.test(j?.message || '')) msg = '資料表還沒有「封存」欄位，請先在 Supabase 執行 supabase/003_tasks_archived_at.sql。';
      throw new ApiError(msg, r.status, j?.code);
    }
    return j;
  }
  const inList = ids => 'in.(' + ids.map(encodeURIComponent).join(',') + ')';
  const iso = ms => (ms == null ? null : new Date(ms).toISOString());
  const ms = s => (s == null ? null : Date.parse(s));

  /* ---------------- 欄位對照（畫面格式 ⇄ 資料表） ---------------- */
  const fromSub = r => ({ id: r.id, title: r.title, due: r.due_date, note: r.note ?? '', done: r.is_done, doneAt: ms(r.done_at), sortOrder: r.sort_order });
  const fromTask = r => ({
    id: r.id, title: r.title, due: r.due_date, note: r.note ?? '', done: r.is_done, doneAt: ms(r.done_at),
    trashed: r.is_trashed, trashedAt: ms(r.trashed_at), archivedAt: ms(r.archived_at), created: ms(r.created_at),
    subs: (r.subtasks || []).map(fromSub).sort((a, b) => a.sortOrder - b.sortOrder),
  });
  const fromTier = r => ({ id: r.id, name: r.name, max: r.max_days, color: r.color, hideDone: r.hide_done });

  const TASK_COLS = { title: 'title', due: 'due_date', note: 'note', done: 'is_done', doneAt: 'done_at', trashed: 'is_trashed', trashedAt: 'trashed_at', archivedAt: 'archived_at', created: 'created_at' };
  const SUB_COLS = { title: 'title', due: 'due_date', note: 'note', done: 'is_done', doneAt: 'done_at', sortOrder: 'sort_order' };
  const TIER_COLS = { name: 'name', max: 'max_days', color: 'color', hideDone: 'hide_done' };
  const SET_COLS = { groupBy: 'group_by', ui: 'ui_theme' };
  const TIME_KEYS = new Set(['doneAt', 'trashedAt', 'archivedAt', 'created']);
  function toRow(obj, cols) {
    const row = {};
    for (const [k, col] of Object.entries(cols)) if (k in obj) row[col] = TIME_KEYS.has(k) ? iso(obj[k]) : obj[k];
    return row;
  }
  // archived_at 沒有值時不送出，避免還沒執行 003 SQL 時，連一般的新增都失敗
  const taskRow = t => { const r = { id: t.id, ...toRow(t, TASK_COLS) }; if (r.archived_at == null) delete r.archived_at; return r; };
  const subRow = (taskId, s) => ({ id: s.id, task_id: taskId, ...toRow(s, SUB_COLS) });
  const tierRow = t => ({ id: t.id, name: t.name, max_days: t.max, color: t.color, hide_done: !!t.hideDone });

  /* ---------------- 新使用者的預設資料 ---------------- */
  const newId = () => (crypto.randomUUID ? crypto.randomUUID()
    : '10000000-1000-4000-8000-100000000000'.replace(/[018]/g, c => (c ^ crypto.getRandomValues(new Uint8Array(1))[0] & 15 >> c / 4).toString(16)));
  const defaultTiers = () => [
    { id: newId(), name: '已逾期', max: -1, color: '#D64545', hideDone: false },
    { id: newId(), name: '今天到期', max: 0, color: '#E8642E', hideDone: false },
    { id: newId(), name: '三天內', max: 3, color: '#EE9A2A', hideDone: false },
    { id: newId(), name: '本週內', max: 7, color: '#CFAE1F', hideDone: false },
    { id: newId(), name: '還早', max: null, color: '#4E9A78', hideDone: false },
  ];

  /* ---------------- 對外提供的函式 ---------------- */
  window.TodoAPI = {
    ApiError, newId, defaultTiers,

    get isLoggedIn() { return !!session; },
    get email() { return session?.email || ''; },
    async signIn(email, password) { keepSession(await authPost('/token?grant_type=password', { email, password })); },
    async signOut() {
      const s = session; setSession(null);
      if (s) { try { await fetch(AUTH + '/logout', { method: 'POST', headers: { apikey: C.publishableKey, Authorization: 'Bearer ' + s.access_token } }); } catch (e) {} }
    },

    /** 讀取全部資料；新使用者第一次登入時，建立預設層級與個人設定 */
    async loadAll() {
      const [taskRows, tierRows, setRows] = await Promise.all([
        rest('GET', '/tasks?select=*,subtasks(*)&order=created_at.asc'),
        rest('GET', '/tiers?select=*'),
        rest('GET', '/user_settings?select=*'),
      ]);
      let tiers = tierRows.map(fromTier);
      if (!tiers.length) {
        tiers = defaultTiers();
        await rest('POST', '/tiers', { body: tiers.map(tierRow), prefer: 'return=minimal' });
      }
      let s = setRows[0];
      if (!s) {
        let ui = 'tech-light';
        try { ui = localStorage.getItem('todo-ui') || ui; } catch (e) {}
        const made = await rest('POST', '/user_settings', { body: { group_by: 'earliest', ui_theme: ui }, prefer: 'return=representation' });
        s = made[0];
      }
      return {
        tasks: taskRows.map(fromTask),
        settings: { tiers, groupBy: s.group_by, ui: s.ui_theme, userId: s.user_id },
      };
    },

    /** 新增母任務（可連同子任務一起新增，用於復原永久刪除與匯入） */
    async createTask(t) {
      await rest('POST', '/tasks', { body: taskRow(t), prefer: 'return=minimal' });
      if (t.subs?.length) await rest('POST', '/subtasks', { body: t.subs.map(s => subRow(t.id, s)), prefer: 'return=minimal' });
    },
    updateTask: (id, patch) => rest('PATCH', '/tasks?id=eq.' + encodeURIComponent(id), { body: toRow(patch, TASK_COLS), prefer: 'return=minimal' }),
    /** 一次修改多筆母任務（全部封存用） */
    updateTasks: (ids, patch) => (ids.length ? rest('PATCH', '/tasks?id=' + inList(ids), { body: toRow(patch, TASK_COLS), prefer: 'return=minimal' }) : Promise.resolve()),
    deleteTasks: ids => (ids.length ? rest('DELETE', '/tasks?id=' + inList(ids), { prefer: 'return=minimal' }) : Promise.resolve()),

    createSub: (taskId, s) => rest('POST', '/subtasks', { body: subRow(taskId, s), prefer: 'return=minimal' }),
    updateSub: (id, patch) => rest('PATCH', '/subtasks?id=eq.' + encodeURIComponent(id), { body: toRow(patch, SUB_COLS), prefer: 'return=minimal' }),
    deleteSub: id => rest('DELETE', '/subtasks?id=eq.' + encodeURIComponent(id), { prefer: 'return=minimal' }),

    updateTier: (id, patch) => rest('PATCH', '/tiers?id=eq.' + encodeURIComponent(id), { body: toRow(patch, TIER_COLS), prefer: 'return=minimal' }),
    /** 儲存整組層級：先刪除被移除的，再一次新增／更新其餘的 */
    async saveTiers(tiers, previous) {
      const keep = new Set(tiers.map(t => t.id));
      const removed = previous.filter(t => !keep.has(t.id)).map(t => t.id);
      if (removed.length) await rest('DELETE', '/tiers?id=' + inList(removed), { prefer: 'return=minimal' });
      await rest('POST', '/tiers?on_conflict=id', { body: tiers.map(tierRow), prefer: 'resolution=merge-duplicates,return=minimal' });
    },

    updateSettings: (userId, patch) => rest('PATCH', '/user_settings?user_id=eq.' + encodeURIComponent(userId), { body: toRow(patch, SET_COLS), prefer: 'return=minimal' }),
  };
})();
