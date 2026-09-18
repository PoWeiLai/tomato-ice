import { DatabaseSync } from 'node:sqlite';
import { DB_PATH } from './paths.js';

export const db = new DatabaseSync(DB_PATH);
db.exec('PRAGMA journal_mode = WAL');
db.exec('PRAGMA foreign_keys = ON');

db.exec(`
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

CREATE INDEX IF NOT EXISTS idx_orders_session ON orders(session_id);
CREATE INDEX IF NOT EXISTS idx_orders_status  ON orders(status);
CREATE INDEX IF NOT EXISTS idx_items_order    ON order_items(order_id);
CREATE INDEX IF NOT EXISTS idx_menu_category  ON menu_items(category_id);
`);

// 舊資料庫補欄位（新版加了選項功能）
const orderItemCols = db.prepare('PRAGMA table_info(order_items)').all().map((c) => c.name);
if (!orderItemCols.includes('options')) {
  db.exec("ALTER TABLE order_items ADD COLUMN options TEXT NOT NULL DEFAULT '[]'");
}

// 舊資料庫補欄位（回饋加了照片）
const feedbackCols = db.prepare('PRAGMA table_info(feedback)').all().map((c) => c.name);
if (!feedbackCols.includes('photos')) {
  db.exec("ALTER TABLE feedback ADD COLUMN photos TEXT NOT NULL DEFAULT '[]'");
}
// 舊資料庫補欄位（回饋加了店家回覆）
if (!feedbackCols.includes('reply')) {
  db.exec(`
    ALTER TABLE feedback ADD COLUMN reply TEXT NOT NULL DEFAULT '';
    ALTER TABLE feedback ADD COLUMN replied_at TEXT;
  `);
}

// 舊資料庫補欄位（新版加了外帶與折扣）
const sessionCols = db.prepare('PRAGMA table_info(sessions)').all().map((c) => c.name);
if (!sessionCols.includes('kind')) {
  db.exec(`
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
  for (let i = 1; i <= TABLE_COUNT; i++) ins.run(i, `${i} 號桌`, 4);
  db.prepare(
    'DELETE FROM tables WHERE id > ? AND id NOT IN (SELECT DISTINCT table_id FROM sessions)'
  ).run(TABLE_COUNT);
}

/** 外帶用的保留桌號：所有外帶單都掛在這一桌底下，列桌子時要排除 */
export const TAKEOUT_TABLE_ID = 0;
db.prepare('INSERT OR IGNORE INTO tables (id, name, seats) VALUES (?, ?, 0)').run(TAKEOUT_TABLE_ID, '外帶');

export const getSetting = (key) => db.prepare('SELECT value FROM settings WHERE key = ?').get(key)?.value;
export const setSetting = (key, value) =>
  db
    .prepare('INSERT INTO settings (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value')
    .run(key, String(value));

export function now() {
  return new Date().toISOString();
}
