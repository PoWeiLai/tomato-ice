// 資料庫連線。
// 雲端：設 TURSO_DATABASE_URL + TURSO_AUTH_TOKEN，資料存在 Turso（永久保存，主機重啟不會消失）。
// 本機：沒設的話就用 data/restaurant.db 這個檔案，開發測試不必連網。
import { createClient } from '@libsql/client';
import { DB_PATH } from './paths.js';

const TURSO_URL = process.env.TURSO_DATABASE_URL;

/** Turso 設定有問題時的說明，空字串代表正常。/api/health 會一併回傳，線上一看就知道 */
export let DB_WARNING = '';
export let IS_REMOTE = Boolean(TURSO_URL);

// 設定填錯時給人看得懂的提示，然後退回本機檔案繼續開店，不要直接結束。
// 直接結束的話 Render 會判定「新版起不來」而一直掛著舊版，問題反而更難發現。
function warn(msg) {
  DB_WARNING = `Turso 設定有誤：${msg}。目前暫時存在主機本機，主機重啟會掉資料！請到主機的環境變數頁檢查 TURSO_DATABASE_URL 與 TURSO_AUTH_TOKEN（見 README「部署到雲端」）`;
  console.error(`\n  ✗ ${DB_WARNING}\n`);
  IS_REMOTE = false;
}
if (IS_REMOTE) {
  const token = process.env.TURSO_AUTH_TOKEN || '';
  if (!/^libsql:\/\/[\w.-]+\.turso\.io$/.test(TURSO_URL) && !/^https?:\/\//.test(TURSO_URL)) {
    warn(`TURSO_DATABASE_URL 格式不對，應該是 libsql://xxx-你的帳號.turso.io，現在是「${TURSO_URL}」`);
  } else if (!token) warn('TURSO_AUTH_TOKEN 沒填');
  else if (!/^[\x21-\x7e]+$/.test(token)) warn('TURSO_AUTH_TOKEN 裡有中文或空白，請貼 Turso 後台 Generate Token 產生的那一整串英數字');
}

const localClient = () => createClient({ url: `file:${DB_PATH}` });
let client = IS_REMOTE
  ? createClient({ url: TURSO_URL, authToken: process.env.TURSO_AUTH_TOKEN })
  : localClient();

if (IS_REMOTE) {
  try {
    await client.execute('SELECT 1');
  } catch (e) {
    const m = String(e.message || e);
    if (/401|unauthorized|jwt|token/i.test(m)) warn('Turso 拒絕這個 token（401），請確認是這個資料庫產生的 token，且沒有過期');
    else if (/ENOTFOUND|getaddrinfo|404/.test(m)) warn(`找不到這個資料庫網址：${TURSO_URL}`);
    else warn(m);
    client = localClient();
  }
}

// 報表要用店家當地的日期分天。Turso 主機在國外，SQLite 的 'localtime' 會變成 UTC，
// 所以一律用固定時差換算，預設台灣 +8。
const TZ_OFFSET_HOURS = Number(process.env.TZ_OFFSET_HOURS ?? 8);
export const LOCAL = `'${TZ_OFFSET_HOURS >= 0 ? '+' : '-'}${Math.abs(TZ_OFFSET_HOURS)} hours'`;

/**
 * 仿 better-sqlite3 的極簡包裝，差別只在每個呼叫都要 await：
 *   await db.prepare(sql).get(...args)   → 一列或 undefined
 *   await db.prepare(sql).all(...args)   → 陣列
 *   await db.prepare(sql).run(...args)   → { lastInsertRowid, changes }
 *   await db.exec(sql)                   → 可一次跑多句
 *   await db.transaction(async (tx) => …) → tx 同樣有 prepare，中途丟錯就整包回滾
 */
function wrap(executor) {
  const execute = (sql, args) => executor.execute({ sql, args });
  return {
    prepare(sql) {
      return {
        get: async (...args) => (await execute(sql, args)).rows[0],
        all: async (...args) => (await execute(sql, args)).rows,
        run: async (...args) => {
          const r = await execute(sql, args);
          return { lastInsertRowid: Number(r.lastInsertRowid), changes: r.rowsAffected };
        },
      };
    },
    exec: (sql) => executor.executeMultiple(sql),
  };
}

export const db = {
  ...wrap(client),
  async transaction(fn) {
    const tx = await client.transaction('write');
    try {
      const result = await fn(wrap(tx));
      await tx.commit();
      return result;
    } catch (e) {
      await tx.rollback().catch(() => {});
      throw e;
    } finally {
      tx.close();
    }
  },
};

if (!IS_REMOTE) {
  await db.exec('PRAGMA journal_mode = WAL');
  await db.exec('PRAGMA foreign_keys = ON');
}

await db.exec(`
CREATE TABLE IF NOT EXISTS categories (
  id       INTEGER PRIMARY KEY AUTOINCREMENT,
  name     TEXT NOT NULL UNIQUE,
  sort     INTEGER NOT NULL DEFAULT 0
);

CREATE TABLE IF NOT EXISTS menu_items (
  id           INTEGER PRIMARY KEY AUTOINCREMENT,
  category_id  INTEGER NOT NULL REFERENCES categories(id) ON DELETE CASCADE,
  name         TEXT NOT NULL,
  description  TEXT NOT NULL DEFAULT '',
  price        INTEGER NOT NULL,
  image        TEXT NOT NULL DEFAULT '',
  available    INTEGER NOT NULL DEFAULT 1,
  sort         INTEGER NOT NULL DEFAULT 0
);

-- 選項群組：例如「湯/乾」「換麵」「加麵」，可掛在多個品項上共用
CREATE TABLE IF NOT EXISTS option_groups (
  id       INTEGER PRIMARY KEY AUTOINCREMENT,
  key      TEXT NOT NULL UNIQUE,            -- 程式用代號，例如「湯乾」
  name     TEXT NOT NULL,                   -- 顯示給客人看的標題
  mode     TEXT NOT NULL DEFAULT 'single',  -- single=擇一 | multi=可複選
  required INTEGER NOT NULL DEFAULT 0,
  sort     INTEGER NOT NULL DEFAULT 0
);

CREATE TABLE IF NOT EXISTS option_choices (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  group_id    INTEGER NOT NULL REFERENCES option_groups(id) ON DELETE CASCADE,
  name        TEXT NOT NULL,
  price_delta INTEGER NOT NULL DEFAULT 0,
  sort        INTEGER NOT NULL DEFAULT 0
);

CREATE TABLE IF NOT EXISTS item_option_groups (
  item_id  INTEGER NOT NULL REFERENCES menu_items(id) ON DELETE CASCADE,
  group_id INTEGER NOT NULL REFERENCES option_groups(id) ON DELETE CASCADE,
  sort     INTEGER NOT NULL DEFAULT 0,
  PRIMARY KEY (item_id, group_id)
);

CREATE TABLE IF NOT EXISTS tables (
  id     INTEGER PRIMARY KEY,
  name   TEXT NOT NULL,
  seats  INTEGER NOT NULL DEFAULT 4
);

-- 一次「入座到結帳」為一個 session，帳單以 session 結算
-- 外帶：table_id 固定為 0（保留桌），每一張外帶單各自一個 session
CREATE TABLE IF NOT EXISTS sessions (
  id            INTEGER PRIMARY KEY AUTOINCREMENT,
  table_id      INTEGER NOT NULL REFERENCES tables(id),
  kind          TEXT NOT NULL DEFAULT 'dine',   -- dine=內用 | takeout=外帶
  customer      TEXT NOT NULL DEFAULT '',       -- 外帶客人稱呼／電話
  opened_at     TEXT NOT NULL,
  closed_at     TEXT,
  paid_total    INTEGER,                        -- 實收（已扣折扣）
  discount      INTEGER NOT NULL DEFAULT 0,     -- 折扣金額
  discount_note TEXT NOT NULL DEFAULT '',       -- 例：9折、免單：老闆招待
  payment       TEXT
);

-- 店家設定（目前只有店員密碼）
CREATE TABLE IF NOT EXISTS settings (
  key   TEXT PRIMARY KEY,
  value TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS orders (
  id         INTEGER PRIMARY KEY AUTOINCREMENT,
  session_id INTEGER NOT NULL REFERENCES sessions(id) ON DELETE CASCADE,
  table_id   INTEGER NOT NULL REFERENCES tables(id),
  status     TEXT NOT NULL DEFAULT 'pending',  -- pending | preparing | done | cancelled
  note       TEXT NOT NULL DEFAULT '',
  created_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS order_items (
  id       INTEGER PRIMARY KEY AUTOINCREMENT,
  order_id INTEGER NOT NULL REFERENCES orders(id) ON DELETE CASCADE,
  item_id  INTEGER,
  name     TEXT NOT NULL,
  price    INTEGER NOT NULL,          -- 單價（已含選項加價）
  qty      INTEGER NOT NULL,
  note     TEXT NOT NULL DEFAULT '',
  options  TEXT NOT NULL DEFAULT '[]' -- 選項快照 [{group,name,price_delta}]
);

-- 客人用餐後留的星等與心得，老闆在後台看
CREATE TABLE IF NOT EXISTS feedback (
  id         INTEGER PRIMARY KEY AUTOINCREMENT,
  session_id INTEGER REFERENCES sessions(id) ON DELETE SET NULL,
  kind       TEXT NOT NULL DEFAULT 'dine',   -- dine | takeout
  who        TEXT NOT NULL DEFAULT '',       -- 桌號或外帶稱呼
  rating     INTEGER NOT NULL,               -- 1～5 顆星
  comment    TEXT NOT NULL DEFAULT '',
  photos     TEXT NOT NULL DEFAULT '[]',     -- 客人拍的照片網址 ["/images/feedback/xxx.jpg"]
  reply      TEXT NOT NULL DEFAULT '',       -- 店家回覆
  replied_at TEXT,
  created_at TEXT NOT NULL
);

-- 店家上傳的菜色照片與客人拍的回饋照片，直接存進資料庫，
-- 這樣主機沒有永久硬碟（Render 免費版）也不會弄丟
CREATE TABLE IF NOT EXISTS images (
  name       TEXT PRIMARY KEY,               -- 檔名，網址是 /images/<name>
  mime       TEXT NOT NULL,
  data       BLOB NOT NULL,
  created_at TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_orders_session ON orders(session_id);
CREATE INDEX IF NOT EXISTS idx_orders_status  ON orders(status);
CREATE INDEX IF NOT EXISTS idx_items_order    ON order_items(order_id);
CREATE INDEX IF NOT EXISTS idx_menu_category  ON menu_items(category_id);
`);

// 舊資料庫補欄位。用 pragma_table_info() 這種查法遠端資料庫也能用
const columnsOf = async (table) =>
  (await db.prepare(`SELECT name FROM pragma_table_info(?)`).all(table)).map((c) => c.name);

// 新版加了選項功能
if (!(await columnsOf('order_items')).includes('options')) {
  await db.exec("ALTER TABLE order_items ADD COLUMN options TEXT NOT NULL DEFAULT '[]'");
}

// 回饋加了照片、店家回覆
const feedbackCols = await columnsOf('feedback');
if (!feedbackCols.includes('photos')) {
  await db.exec("ALTER TABLE feedback ADD COLUMN photos TEXT NOT NULL DEFAULT '[]'");
}
if (!feedbackCols.includes('reply')) {
  await db.exec(`
    ALTER TABLE feedback ADD COLUMN reply TEXT NOT NULL DEFAULT '';
    ALTER TABLE feedback ADD COLUMN replied_at TEXT;
  `);
}

// 新版加了外帶與折扣
if (!(await columnsOf('sessions')).includes('kind')) {
  await db.exec(`
    ALTER TABLE sessions ADD COLUMN kind TEXT NOT NULL DEFAULT 'dine';
    ALTER TABLE sessions ADD COLUMN customer TEXT NOT NULL DEFAULT '';
    ALTER TABLE sessions ADD COLUMN discount INTEGER NOT NULL DEFAULT 0;
    ALTER TABLE sessions ADD COLUMN discount_note TEXT NOT NULL DEFAULT '';
  `);
}

// 內用桌數：預設 6 桌，可用環境變數 TABLE_COUNT 調整。
// 每次啟動都同步：少的補上、多的刪掉（有歷史帳單掛在上面的桌子保留，不動舊資料）
export const TABLE_COUNT = Math.max(1, Number(process.env.TABLE_COUNT) || 6);
{
  const ins = db.prepare('INSERT OR IGNORE INTO tables (id, name, seats) VALUES (?, ?, ?)');
  for (let i = 1; i <= TABLE_COUNT; i++) await ins.run(i, `${i} 號桌`, 4);
  await db
    .prepare('DELETE FROM tables WHERE id > ? AND id NOT IN (SELECT DISTINCT table_id FROM sessions)')
    .run(TABLE_COUNT);
}

/** 外帶用的保留桌號：所有外帶單都掛在這一桌底下，列桌子時要排除 */
export const TAKEOUT_TABLE_ID = 0;
await db.prepare('INSERT OR IGNORE INTO tables (id, name, seats) VALUES (?, ?, 0)').run(TAKEOUT_TABLE_ID, '外帶');

export const getSetting = async (key) =>
  (await db.prepare('SELECT value FROM settings WHERE key = ?').get(key))?.value;
export const setSetting = (key, value) =>
  db
    .prepare('INSERT INTO settings (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value')
    .run(key, String(value));

export function now() {
  return new Date().toISOString();
}
