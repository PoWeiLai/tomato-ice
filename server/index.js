import express from 'express';
import multer from 'multer';
import QRCode from 'qrcode';
import os from 'node:os';
import { existsSync, mkdirSync, rmSync } from 'node:fs';
import { dirname, extname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { db, now, getSetting, setSetting, TAKEOUT_TABLE_ID, TABLE_COUNT } from './db.js';
import { DATA_DIR, IMAGES_DIR } from './paths.js';
import { seedMenu } from './seed.js';
import { sseHandler, broadcast } from './events.js';

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = join(__dirname, '..');
const PORT = Number(process.env.PORT || 3001);

// 店員密碼一律純數字：手機登入畫面用的是數字鍵盤，打不出英文。
// 優先順序：後台改過的密碼（存在資料庫）> 環境變數 STAFF_PIN > 1234
const PIN_RULE = /^\d{4,8}$/;
const ENV_PIN = String(process.env.STAFF_PIN || '1234');
if (!PIN_RULE.test(ENV_PIN)) {
  console.warn(`  ⚠ 環境變數 STAFF_PIN「${ENV_PIN}」不是 4～8 位數字，手機無法輸入，已改用 1234`);
}
const staffPin = () => getSetting('staff_pin') || (PIN_RULE.test(ENV_PIN) ? ENV_PIN : '1234');

// 全新部署時資料庫是空的，先把內建菜單灌進去，免得店家打開看到一片空白
if (db.prepare('SELECT COUNT(*) AS n FROM menu_items').get().n === 0) {
  const r = seedMenu();
  console.log(`  首次啟動，已匯入內建菜單：${r.categories} 個分類、${r.items} 道菜`);
}

const app = express();
app.use(express.json({ limit: '1mb' }));

/* ---------- 工具 ---------- */
// WSL / Hyper-V / VirtualBox 之類的虛擬網卡，手機連不到，要排除
const VIRTUAL_ADAPTER = /vEthernet|WSL|Hyper-?V|VirtualBox|VMware|Docker|Loopback|Bluetooth|藍牙/i;

/** 找出客人手機真正連得到的區網 IP（優先家用/店用網段） */
function lanIP() {
  const candidates = [];
  for (const [name, list] of Object.entries(os.networkInterfaces())) {
    if (VIRTUAL_ADAPTER.test(name)) continue;
    for (const net of list || []) {
      if (net.family !== 'IPv4' || net.internal) continue;
      if (net.address.startsWith('169.254.')) continue; // 沒拿到 DHCP 的自動私有位址
      candidates.push({ name, address: net.address });
    }
  }
  const rank = (ip) => (ip.startsWith('192.168.') ? 0 : ip.startsWith('10.') ? 1 : 2);
  candidates.sort((a, b) => rank(a.address) - rank(b.address));
  return candidates[0]?.address || 'localhost';
}
// PUBLIC_URL 手動指定 > 雲端平台自動提供的網址 > 本機區網 IP
const baseURL = () =>
  process.env.PUBLIC_URL || process.env.RENDER_EXTERNAL_URL || `http://${lanIP()}:${PORT}`;

// 店員身分（廚房 / 後台）：內網用共用 PIN 即可
function staffOnly(req, res, next) {
  if (req.get('x-staff-pin') === staffPin()) return next();
  res.status(401).json({ error: '未授權，請輸入正確店員密碼' });
}

const ok = (v) => v !== undefined && v !== null && String(v).trim() !== '';
const bad = (res, msg) => res.status(400).json({ error: msg });

function itemsOf(orderId) {
  return db
    .prepare('SELECT * FROM order_items WHERE order_id = ? ORDER BY id')
    .all(orderId)
    .map((i) => ({ ...i, options: JSON.parse(i.options || '[]') }));
}

/** 某品項掛的選項群組（含選擇項） */
function optionGroupsOf(itemId) {
  const groups = db
    .prepare(
      `SELECT g.* FROM option_groups g
       JOIN item_option_groups m ON m.group_id = g.id
       WHERE m.item_id = ? ORDER BY m.sort, g.id`
    )
    .all(itemId);
  const choices = db.prepare('SELECT * FROM option_choices WHERE group_id = ? ORDER BY sort, id');
  return groups.map((g) => ({ ...g, choices: choices.all(g.id) }));
}
// 訂單一律帶上 session 的內用/外帶與客人稱呼，廚房和帳單才知道這張是誰的
const ORDER_SQL = `SELECT o.*, s.kind, s.customer, s.closed_at
  FROM orders o JOIN sessions s ON s.id = o.session_id`;
const orderById = (id) => db.prepare(`${ORDER_SQL} WHERE o.id = ?`).get(id);
function withItems(orders) {
  return orders.map((o) => {
    const items = itemsOf(o.id);
    return { ...o, items, total: items.reduce((s, i) => s + i.price * i.qty, 0) };
  });
}
// 取得該桌目前未結帳的 session，沒有就開一個
function openSession(tableId) {
  const found = db
    .prepare('SELECT * FROM sessions WHERE table_id = ? AND closed_at IS NULL ORDER BY id DESC LIMIT 1')
    .get(tableId);
  if (found) return found;
  const id = db.prepare('INSERT INTO sessions (table_id, opened_at) VALUES (?, ?)').run(tableId, now())
    .lastInsertRowid;
  return db.prepare('SELECT * FROM sessions WHERE id = ?').get(id);
}
// 外帶：每一張單自己一個 session，結帳互不影響
function openTakeoutSession(customer) {
  const id = db
    .prepare("INSERT INTO sessions (table_id, kind, customer, opened_at) VALUES (?, 'takeout', ?, ?)")
    .run(TAKEOUT_TABLE_ID, customer, now()).lastInsertRowid;
  return db.prepare('SELECT * FROM sessions WHERE id = ?').get(id);
}
/** 一張帳單（session）含訂單明細、原價與折扣後應收 */
function billOf(session) {
  const orders = withItems(
    db.prepare(`${ORDER_SQL} WHERE o.session_id = ? AND o.status <> 'cancelled' ORDER BY o.id`).all(session.id)
  );
  const table = db.prepare('SELECT * FROM tables WHERE id = ?').get(session.table_id);
  const subtotal = orders.reduce((sum, o) => sum + o.total, 0);
  return { ...session, table, orders, subtotal, total: Math.max(0, subtotal - (session.discount || 0)) };
}

/**
 * 依店員選的折扣算出折扣金額與說明。
 * percent：value 是「折數」，例如 9 = 9折、85 = 85折
 * amount ：value 是直接折抵的金額
 * free   ：免單，全額折掉
 */
function computeDiscount(subtotal, body = {}) {
  const type = body.type || 'none';
  const value = Number(body.value);
  const reason = String(body.reason || '').trim();
  const withReason = (label) => (reason ? `${label}：${reason}` : label);
  if (type === 'free') return { discount: subtotal, note: withReason('免單') };
  if (type === 'percent') {
    // 接受 9 / 85 / 0.9 這幾種寫法
    const pct = value > 0 && value < 1 ? value * 100 : value >= 10 ? value : value * 10;
    if (!Number.isFinite(pct) || pct <= 0 || pct >= 100) throw new Error('折數不正確（例：9 = 9折、85 = 85折）');
    const label = Number.isInteger(pct / 10) ? `${pct / 10}折` : `${pct}折`;
    return { discount: Math.min(subtotal, Math.round(subtotal * (1 - pct / 100))), note: withReason(label) };
  }
  if (type === 'amount') {
    if (!Number.isFinite(value) || value <= 0) throw new Error('折抵金額不正確');
    const amt = Math.min(subtotal, Math.round(value));
    return { discount: amt, note: withReason(`折抵 $${amt}`) };
  }
  return { discount: 0, note: '' };
}

/* ---------- 客人端 ---------- */
app.get('/api/events', sseHandler);

app.get('/api/menu', (_req, res) => {
  const cats = db.prepare('SELECT * FROM categories ORDER BY sort, id').all();
  const stmt = db.prepare('SELECT * FROM menu_items WHERE category_id = ? ORDER BY sort, id');
  res.json(
    cats.map((c) => ({
      ...c,
      items: stmt.all(c.id).map((i) => ({ ...i, optionGroups: optionGroupsOf(i.id) })),
    }))
  );
});

app.get('/api/tables', (_req, res) => {
  res.json(db.prepare('SELECT * FROM tables WHERE id BETWEEN 1 AND ? ORDER BY id').all(TABLE_COUNT));
});

// 該桌本次用餐的所有訂單（客人可查自己點了什麼、進度到哪）
app.get('/api/tables/:id/session', (req, res) => {
  const tableId = Number(req.params.id);
  const table = db.prepare('SELECT * FROM tables WHERE id = ? AND id BETWEEN 1 AND ?').get(tableId, TABLE_COUNT);
  if (!table) return res.status(404).json({ error: '查無此桌號' });

  const session = db
    .prepare('SELECT * FROM sessions WHERE table_id = ? AND closed_at IS NULL ORDER BY id DESC LIMIT 1')
    .get(tableId);
  if (!session) return res.json({ table, session: null, orders: [], total: 0 });

  const orders = withItems(
    db.prepare(`${ORDER_SQL} WHERE o.session_id = ? AND o.status <> 'cancelled' ORDER BY o.id`).all(session.id)
  );
  res.json({ table, session, orders, total: orders.reduce((s, o) => s + o.total, 0) });
});

// 外帶客人查自己的單（手機只記得訂單編號，用編號查進度）
app.get('/api/orders/:id', (req, res) => {
  const order = orderById(Number(req.params.id));
  if (!order) return res.status(404).json({ error: '訂單不存在' });
  res.json(withItems([order])[0]);
});

// 送出訂單。外帶請帶 takeout: { name, phone }，不用桌號
app.post('/api/orders', (req, res) => {
  const { tableId, items, note = '', takeout } = req.body || {};
  let table;
  let customer = '';
  if (takeout) {
    const name = String(takeout.name || '').trim();
    // 只收台灣手機號碼（09 開頭 10 碼），去掉客人可能打的空格或連字號
    const phone = String(takeout.phone || '').replace(/[\s-]/g, '');
    if (!name) return bad(res, '外帶請留下稱呼，方便叫餐');
    if (!/^09\d{8}$/.test(phone)) return bad(res, '請輸入正確的手機號碼（09 開頭共 10 碼）');
    customer = `${name} ${phone}`;
    table = db.prepare('SELECT * FROM tables WHERE id = ?').get(TAKEOUT_TABLE_ID);
  } else {
    table = db.prepare('SELECT * FROM tables WHERE id = ? AND id BETWEEN 1 AND ?').get(Number(tableId), TABLE_COUNT);
    if (!table) return bad(res, '桌號不存在');
  }
  if (!Array.isArray(items) || items.length === 0) return bad(res, '購物車是空的');

  const lookup = db.prepare('SELECT * FROM menu_items WHERE id = ?');
  const rows = [];
  for (const line of items) {
    const menuItem = lookup.get(Number(line.itemId));
    if (!menuItem) return bad(res, `品項不存在（id ${line.itemId}）`);
    if (!menuItem.available) return bad(res, `「${menuItem.name}」已售完，請重新選擇`);
    const qty = Math.max(1, Math.min(99, Math.round(Number(line.qty) || 1)));

    // 選項驗證：只接受掛在這道菜底下的選擇，加價由伺服器算，前端傳來的價格一律不採信
    const groups = optionGroupsOf(menuItem.id);
    const picked = Array.isArray(line.choiceIds) ? line.choiceIds.map(Number) : [];
    const chosen = [];
    for (const group of groups) {
      const hits = group.choices.filter((c) => picked.includes(c.id));
      if (group.mode === 'single' && hits.length > 1) {
        return bad(res, `「${menuItem.name}」的「${group.name}」只能選一項`);
      }
      if (group.required && hits.length === 0) {
        return bad(res, `「${menuItem.name}」請選擇「${group.name}」`);
      }
      for (const c of hits) chosen.push({ group: group.name, name: c.name, price_delta: c.price_delta });
    }
    const validIds = new Set(groups.flatMap((g) => g.choices.map((c) => c.id)));
    if (picked.some((id) => !validIds.has(id))) {
      return bad(res, `「${menuItem.name}」有不合法的選項`);
    }

    // 價格與品名當下快照，之後改價不影響已送出的單
    const unitPrice = menuItem.price + chosen.reduce((s, c) => s + c.price_delta, 0);
    rows.push({
      id: menuItem.id,
      name: menuItem.name,
      price: unitPrice,
      qty,
      note: String(line.note || ''),
      options: chosen,
    });
  }

  const session = takeout ? openTakeoutSession(customer) : openSession(table.id);
  const orderId = db
    .prepare('INSERT INTO orders (session_id, table_id, status, note, created_at) VALUES (?, ?, ?, ?, ?)')
    .run(session.id, table.id, 'pending', String(note), now()).lastInsertRowid;

  const insItem = db.prepare(
    'INSERT INTO order_items (order_id, item_id, name, price, qty, note, options) VALUES (?, ?, ?, ?, ?, ?, ?)'
  );
  for (const r of rows) insItem.run(orderId, r.id, r.name, r.price, r.qty, r.note, JSON.stringify(r.options));

  const order = withItems([orderById(orderId)])[0];
  broadcast('order:new', order);
  res.status(201).json(order);
});

/* ---------- 廚房 ---------- */
const STATUSES = ['pending', 'preparing', 'done', 'cancelled'];

app.get('/api/kitchen/orders', staffOnly, (req, res) => {
  const all = req.query.scope === 'all';
  const sql = all
    ? `${ORDER_SQL} WHERE date(o.created_at,'localtime') = date('now','localtime') ORDER BY o.id DESC`
    : `${ORDER_SQL} WHERE o.status IN ('pending','preparing') ORDER BY o.id`;
  res.json(withItems(db.prepare(sql).all()));
});

app.patch('/api/orders/:id/status', staffOnly, (req, res) => {
  const { status } = req.body || {};
  if (!STATUSES.includes(status)) return bad(res, '狀態不合法');
  const order = db.prepare('SELECT * FROM orders WHERE id = ?').get(Number(req.params.id));
  if (!order) return res.status(404).json({ error: '訂單不存在' });

  db.prepare('UPDATE orders SET status = ? WHERE id = ?').run(status, order.id);
  const updated = withItems([orderById(order.id)])[0];
  broadcast('order:update', updated);
  res.json(updated);
});

/* ---------- 店員登入 / 改密碼 ---------- */
app.post('/api/staff/login', (req, res) => {
  if (String(req.body?.pin) === staffPin()) return res.json({ ok: true });
  res.status(401).json({ error: '密碼錯誤' });
});

app.post('/api/admin/pin', staffOnly, (req, res) => {
  const pin = String(req.body?.pin ?? '').trim();
  if (!PIN_RULE.test(pin)) return bad(res, '密碼必須是 4～8 位數字（手機才打得出來）');
  setSetting('staff_pin', pin);
  res.json({ ok: true });
});

/* ---------- 後台：菜單 ---------- */
app.post('/api/admin/categories', staffOnly, (req, res) => {
  const { name, sort = 0 } = req.body || {};
  if (!ok(name)) return bad(res, '請輸入分類名稱');
  try {
    const id = db
      .prepare('INSERT INTO categories (name, sort) VALUES (?, ?)')
      .run(String(name).trim(), Number(sort) || 0).lastInsertRowid;
    broadcast('menu:update');
    res.status(201).json(db.prepare('SELECT * FROM categories WHERE id = ?').get(id));
  } catch {
    bad(res, '分類名稱重複');
  }
});

app.patch('/api/admin/categories/:id', staffOnly, (req, res) => {
  const cat = db.prepare('SELECT * FROM categories WHERE id = ?').get(Number(req.params.id));
  if (!cat) return res.status(404).json({ error: '分類不存在' });
  const name = ok(req.body?.name) ? String(req.body.name).trim() : cat.name;
  const sort = req.body?.sort ?? cat.sort;
  db.prepare('UPDATE categories SET name = ?, sort = ? WHERE id = ?').run(name, Number(sort), cat.id);
  broadcast('menu:update');
  res.json(db.prepare('SELECT * FROM categories WHERE id = ?').get(cat.id));
});

app.delete('/api/admin/categories/:id', staffOnly, (req, res) => {
  db.prepare('DELETE FROM categories WHERE id = ?').run(Number(req.params.id));
  broadcast('menu:update');
  res.json({ ok: true });
});

app.post('/api/admin/menu-items', staffOnly, (req, res) => {
  const { categoryId, name, price, description = '', image = '', sort = 0 } = req.body || {};
  if (!ok(name)) return bad(res, '請輸入品名');
  if (!Number.isFinite(Number(price)) || Number(price) < 0) return bad(res, '價格不正確');
  if (!db.prepare('SELECT 1 FROM categories WHERE id = ?').get(Number(categoryId))) return bad(res, '分類不存在');
  const id = db
    .prepare(
      'INSERT INTO menu_items (category_id, name, description, price, image, available, sort) VALUES (?, ?, ?, ?, ?, 1, ?)'
    )
    .run(
      Number(categoryId),
      String(name).trim(),
      String(description),
      Math.round(Number(price)),
      String(image),
      Number(sort) || 0
    ).lastInsertRowid;
  broadcast('menu:update');
  res.status(201).json(db.prepare('SELECT * FROM menu_items WHERE id = ?').get(id));
});

app.patch('/api/admin/menu-items/:id', staffOnly, (req, res) => {
  const it = db.prepare('SELECT * FROM menu_items WHERE id = ?').get(Number(req.params.id));
  if (!it) return res.status(404).json({ error: '品項不存在' });
  const b = req.body || {};
  const next = {
    category_id: b.categoryId != null ? Number(b.categoryId) : it.category_id,
    name: ok(b.name) ? String(b.name).trim() : it.name,
    description: b.description != null ? String(b.description) : it.description,
    price: b.price != null ? Math.round(Number(b.price)) : it.price,
    image: b.image != null ? String(b.image) : it.image,
    available: b.available != null ? (b.available ? 1 : 0) : it.available,
    sort: b.sort != null ? Number(b.sort) : it.sort,
  };
  if (!Number.isFinite(next.price) || next.price < 0) return bad(res, '價格不正確');
  db.prepare(
    'UPDATE menu_items SET category_id=?, name=?, description=?, price=?, image=?, available=?, sort=? WHERE id=?'
  ).run(
    next.category_id,
    next.name,
    next.description,
    next.price,
    next.image,
    next.available,
    next.sort,
    it.id
  );
  broadcast('menu:update');
  res.json(db.prepare('SELECT * FROM menu_items WHERE id = ?').get(it.id));
});

app.delete('/api/admin/menu-items/:id', staffOnly, (req, res) => {
  db.prepare('DELETE FROM menu_items WHERE id = ?').run(Number(req.params.id));
  broadcast('menu:update');
  res.json({ ok: true });
});

// 批次貼上匯入：每行「分類,品名,價格,描述(可省略)」
app.post('/api/admin/menu/bulk', staffOnly, (req, res) => {
  const { text = '', replace = false } = req.body || {};
  const lines = String(text)
    .split(/\r?\n/)
    .map((l) => l.trim())
    .filter(Boolean);
  if (lines.length === 0) return bad(res, '沒有可匯入的內容');

  const parsed = [];
  for (const [i, line] of lines.entries()) {
    const [cat, name, price, desc = ''] = line.split(/[,，\t]/).map((p) => p.trim());
    if (!cat || !name || !Number.isFinite(Number(price))) {
      return bad(res, `第 ${i + 1} 行格式錯誤：${line}（需為 分類,品名,價格）`);
    }
    parsed.push({ cat, name, price: Math.round(Number(price)), desc });
  }

  if (replace) {
    db.exec('DELETE FROM menu_items');
    db.exec('DELETE FROM categories');
  }
  const findCat = db.prepare('SELECT * FROM categories WHERE name = ?');
  const insCat = db.prepare('INSERT INTO categories (name, sort) VALUES (?, ?)');
  const insItem = db.prepare(
    "INSERT INTO menu_items (category_id, name, description, price, image, available, sort) VALUES (?, ?, ?, ?, '', 1, ?)"
  );
  let count = 0;
  for (const row of parsed) {
    let cat = findCat.get(row.cat);
    if (!cat) {
      const id = insCat.run(row.cat, db.prepare('SELECT COUNT(*) AS n FROM categories').get().n).lastInsertRowid;
      cat = db.prepare('SELECT * FROM categories WHERE id = ?').get(id);
    }
    const sort = db.prepare('SELECT COUNT(*) AS n FROM menu_items WHERE category_id = ?').get(cat.id).n;
    insItem.run(cat.id, row.name, row.desc, row.price, sort);
    count++;
  }
  broadcast('menu:update');
  res.json({ ok: true, count });
});

/* ---------- 後台：菜色照片上傳 ---------- */
const upload = multer({
  storage: multer.diskStorage({
    destination: IMAGES_DIR,
    filename: (_req, file, cb) =>
      cb(
        null,
        `${Date.now()}-${Math.random().toString(36).slice(2, 8)}${extname(file.originalname).toLowerCase()}`
      ),
  }),
  limits: { fileSize: 8 * 1024 * 1024 },
  fileFilter: (_req, file, cb) =>
    /^image\/(png|jpe?g|webp|gif|avif)$/.test(file.mimetype) ? cb(null, true) : cb(new Error('只接受圖片檔')),
});

app.post('/api/admin/upload', staffOnly, (req, res) => {
  upload.single('file')(req, res, (err) => {
    if (err) return bad(res, err.message);
    if (!req.file) return bad(res, '沒有收到檔案');
    res.status(201).json({ url: `/images/${req.file.filename}` });
  });
});

/* ---------- 後台：QRcode ---------- */
app.get('/api/admin/qrcodes', staffOnly, async (_req, res) => {
  const tables = db.prepare('SELECT * FROM tables WHERE id BETWEEN 1 AND ? ORDER BY id').all(TABLE_COUNT);
  const out = [];
  for (const t of tables) {
    const url = `${baseURL()}/t/${t.id}`;
    out.push({ ...t, url, qr: await QRCode.toDataURL(url, { width: 512, margin: 1 }) });
  }
  // 外帶 QRcode 貼櫃檯，客人掃了自己點、留稱呼，做好再叫人
  const takeoutURL = `${baseURL()}/takeout`;
  const takeout = { url: takeoutURL, qr: await QRCode.toDataURL(takeoutURL, { width: 512, margin: 1 }) };
  res.json({ baseURL: baseURL(), tables: out, takeout });
});

/* ---------- 顧客回饋 ---------- */
// 客人拍的照片另外放一個資料夾，跟菜色照片分開
const FEEDBACK_IMAGES_DIR = join(IMAGES_DIR, 'feedback');
mkdirSync(FEEDBACK_IMAGES_DIR, { recursive: true });
const feedbackUpload = multer({
  storage: multer.diskStorage({
    destination: FEEDBACK_IMAGES_DIR,
    filename: (_req, file, cb) =>
      cb(null, `${Date.now()}-${Math.random().toString(36).slice(2, 8)}${extname(file.originalname).toLowerCase() || '.jpg'}`),
  }),
  limits: { fileSize: 8 * 1024 * 1024, files: 3 },
  fileFilter: (_req, file, cb) =>
    /^image\/(png|jpe?g|webp|gif|avif|heic|heif)$/.test(file.mimetype) ? cb(null, true) : cb(new Error('只接受圖片檔')),
});

// 客人送出心得。multipart 欄位：orderId, rating(1~5), comment?, photos[]（最多 3 張）
// 綁在自己的訂單上：同一張訂單只能留一次，避免路人亂灌
app.post('/api/feedback', (req, res) => {
  feedbackUpload.array('photos', 3)(req, res, (err) => {
    const files = req.files || [];
    const fail = (msg) => {
      for (const f of files) rmSync(f.path, { force: true }); // 驗證沒過就把已存的照片清掉
      return bad(res, msg);
    };
    if (err) return fail(err.code === 'LIMIT_FILE_SIZE' ? '照片太大，請小於 8MB' : err.message);
    const order = orderById(Number(req.body?.orderId));
    if (!order) return fail('找不到訂單');
    const rating = Math.round(Number(req.body?.rating));
    if (!(rating >= 1 && rating <= 5)) return fail('請先給個星等');
    const comment = String(req.body?.comment || '').trim().slice(0, 300);
    const dup = db.prepare('SELECT id FROM feedback WHERE session_id = ?').get(order.session_id);
    if (dup) return fail('這筆訂單已經留過回饋，謝謝您');

    const session = db.prepare('SELECT * FROM sessions WHERE id = ?').get(order.session_id);
    const who = session.kind === 'takeout' ? session.customer.split(' ')[0] : `${session.table_id} 號桌`;
    const photos = files.map((f) => `/images/feedback/${f.filename}`);
    db.prepare(
      'INSERT INTO feedback (session_id, kind, who, rating, comment, photos, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)'
    ).run(session.id, session.kind, who, rating, comment, JSON.stringify(photos), now());
    res.json({ ok: true });
  });
});

// 客人查自己這筆消費的回饋（看店家有沒有回覆）。手機只記得訂單編號，用編號找
app.get('/api/feedback/by-order/:orderId', (req, res) => {
  const order = orderById(Number(req.params.orderId));
  if (!order) return res.status(404).json({ error: '找不到訂單' });
  const f = db.prepare('SELECT * FROM feedback WHERE session_id = ?').get(order.session_id);
  res.json(f ? { ...f, photos: JSON.parse(f.photos || '[]') } : null);
});

// 後台：店家回覆客人。body: { reply }；空字串等於撤回回覆
app.post('/api/admin/feedback/:id/reply', staffOnly, (req, res) => {
  const f = db.prepare('SELECT * FROM feedback WHERE id = ?').get(Number(req.params.id));
  if (!f) return res.status(404).json({ error: '回饋不存在' });
  const reply = String(req.body?.reply || '').trim().slice(0, 500);
  const repliedAt = reply ? now() : null;
  db.prepare('UPDATE feedback SET reply = ?, replied_at = ? WHERE id = ?').run(reply, repliedAt, f.id);
  // 客人的手機還開著的話會即時看到
  broadcast('feedback:reply', { feedbackId: f.id, sessionId: f.session_id });
  res.json({ ok: true, reply, replied_at: repliedAt });
});

// 後台：最近的回饋與平均星等
app.get('/api/admin/feedback', staffOnly, (_req, res) => {
  const list = db
    .prepare('SELECT * FROM feedback ORDER BY id DESC LIMIT 200')
    .all()
    .map((f) => ({ ...f, photos: JSON.parse(f.photos || '[]') }));
  const stats = db.prepare('SELECT COUNT(*) AS count, AVG(rating) AS avg FROM feedback').get();
  const pending = list.filter((f) => !f.reply).length; // 還沒回的，後台標出來
  res.json({ count: stats.count, avg: stats.avg ? Math.round(stats.avg * 10) / 10 : 0, pending, list });
});

app.delete('/api/admin/feedback/:id', staffOnly, (req, res) => {
  const row = db.prepare('SELECT photos FROM feedback WHERE id = ?').get(Number(req.params.id));
  if (row) {
    // 照片一起刪，不留在硬碟占空間
    for (const url of JSON.parse(row.photos || '[]')) {
      const name = url.split('/').pop();
      if (name) rmSync(join(FEEDBACK_IMAGES_DIR, name), { force: true });
    }
    db.prepare('DELETE FROM feedback WHERE id = ?').run(Number(req.params.id));
  }
  res.json({ ok: true });
});

/* ---------- 後台：帳單 / 結帳 ---------- */
app.get('/api/admin/bills', staffOnly, (_req, res) => {
  // 內用依桌號排、外帶依送單先後排在後面
  const sessions = db
    .prepare("SELECT * FROM sessions WHERE closed_at IS NULL ORDER BY kind = 'takeout', table_id, id")
    .all();
  res.json(sessions.map(billOf));
});

// 付款方式都是櫃檯實際收款後由店員按的，系統只記錄不串金流
// （LINE Pay 用店家自己的商家 QR、Apple Pay 走店家的感應刷卡機）
const PAYMENTS = ['cash', 'card', 'linepay', 'applepay', 'mobile'];

// 結帳。body: { payment, discount?: { type: 'percent'|'amount'|'free', value, reason } }
app.post('/api/admin/sessions/:id/close', staffOnly, (req, res) => {
  const s = db.prepare('SELECT * FROM sessions WHERE id = ?').get(Number(req.params.id));
  if (!s) return res.status(404).json({ error: '帳單不存在' });
  if (s.closed_at) return bad(res, '此帳單已結清');

  const { subtotal } = billOf(s);
  let disc;
  try {
    disc = computeDiscount(subtotal, req.body?.discount);
  } catch (e) {
    return bad(res, e.message);
  }
  const total = Math.max(0, subtotal - disc.discount);
  const payment =
    req.body?.discount?.type === 'free'
      ? 'free'
      : PAYMENTS.includes(req.body?.payment)
        ? req.body.payment
        : 'cash';

  db.prepare(
    'UPDATE sessions SET closed_at = ?, paid_total = ?, discount = ?, discount_note = ?, payment = ? WHERE id = ?'
  ).run(now(), total, disc.discount, disc.note, payment, s.id);
  broadcast('bill:closed', { sessionId: s.id, tableId: s.table_id, total });
  res.json({ ok: true, subtotal, discount: disc.discount, total, payment });
});

// 營業摘要。?date=YYYY-MM-DD 看某一天，不帶就是今天。
// 訂單資料一直留在資料庫裡不會刪，所以前幾天的報表都翻得到。
app.get('/api/admin/report', staffOnly, (req, res) => {
  const date = /^\d{4}-\d{2}-\d{2}$/.test(req.query.date) ? req.query.date : null;
  const dateExpr = date ? '?' : "date('now','localtime')";
  const dateArgs = date ? [date] : [];
  const closed = db
    .prepare(`SELECT * FROM sessions WHERE closed_at IS NOT NULL AND date(closed_at,'localtime') = ${dateExpr}`)
    .all(...dateArgs);
  const top = db
    .prepare(
      `SELECT oi.name AS name, SUM(oi.qty) AS qty, SUM(oi.qty * oi.price) AS amount
       FROM order_items oi
       JOIN orders o ON o.id = oi.order_id
       WHERE date(o.created_at,'localtime') = ${dateExpr} AND o.status <> 'cancelled'
       GROUP BY oi.name ORDER BY qty DESC LIMIT 10`
    )
    .all(...dateArgs);
  // 每小時結帳筆數，看尖峰時段
  const byHour = db
    .prepare(
      `SELECT CAST(strftime('%H', closed_at, 'localtime') AS INTEGER) AS hour, COUNT(*) AS count, SUM(paid_total) AS amount
       FROM sessions WHERE closed_at IS NOT NULL AND date(closed_at,'localtime') = ${dateExpr}
       GROUP BY hour ORDER BY hour`
    )
    .all(...dateArgs);
  // 最近 30 天每日營業額，當歷史紀錄
  const days = db
    .prepare(
      `SELECT date(closed_at,'localtime') AS date, COUNT(*) AS count, SUM(paid_total) AS revenue,
              SUM(kind = 'takeout') AS takeoutCount
       FROM sessions WHERE closed_at IS NOT NULL
       GROUP BY date ORDER BY date DESC LIMIT 30`
    )
    .all();
  const sum = (rows) => rows.reduce((s, c) => s + (c.paid_total || 0), 0);
  const takeout = closed.filter((c) => c.kind === 'takeout');
  const dine = closed.filter((c) => c.kind !== 'takeout');
  res.json({
    date: date || days[0]?.date || null,
    closedCount: closed.length,
    takeoutCount: takeout.length,
    revenue: sum(closed),
    discountTotal: closed.reduce((s, c) => s + (c.discount || 0), 0),
    freeCount: closed.filter((c) => c.payment === 'free').length,
    // 內用／外帶各自的筆數與金額
    byKind: [
      { kind: 'dine', count: dine.length, amount: sum(dine) },
      { kind: 'takeout', count: takeout.length, amount: sum(takeout) },
    ],
    // 各付款方式的筆數與金額，方便老闆對 LINE Pay／刷卡機的入帳
    byPayment: PAYMENTS.map((payment) => {
      const rows = closed.filter((c) => c.payment === payment);
      return { payment, count: rows.length, amount: sum(rows) };
    }).filter((p) => p.count > 0),
    byHour,
    days,
    topItems: top,
  });
});

/* ---------- 後台：下載備份 ---------- */
// 老闆自己按一下就能把整個資料庫存到他的電腦，不必找工程師。
// VACUUM INTO 會輸出一份乾淨且一致的複本，不受 WAL 尚未寫回影響。
app.get('/api/admin/backup', staffOnly, (_req, res) => {
  const stamp = new Date().toISOString().slice(0, 19).replace(/[:T]/g, '-');
  const tmp = join(DATA_DIR, `backup-${stamp}.db`);
  try {
    rmSync(tmp, { force: true });
    db.exec(`VACUUM INTO '${tmp.split("'").join("''")}'`);
  } catch (e) {
    return res.status(500).json({ error: `備份失敗：${e.message}` });
  }
  res.download(tmp, `restaurant-backup-${stamp}.db`, () => rmSync(tmp, { force: true }));
});

/* ---------- 前端靜態檔（正式模式） ---------- */
const DIST = join(ROOT, 'dist');
app.use('/images', express.static(IMAGES_DIR)); // 店家上傳的照片在永久儲存空間，優先
app.use(express.static(join(ROOT, 'public')));
app.use(express.static(DIST));

// SPA fallback：/kitchen、/admin、/t/3 等前端路由都回 index.html
app.get(/^(?!\/api\/).*/, (_req, res, next) => {
  const index = join(DIST, 'index.html');
  if (!existsSync(index)) return next(); // 尚未 npm run build（開發時走 vite）
  res.sendFile(index);
});

app.get('/api/health', (_req, res) => res.json({ ok: true }));

app.listen(PORT, '0.0.0.0', () => {
  console.log('\n  餐廳點餐系統已啟動');
  console.log(`  店內網址   ${baseURL()}`);
  console.log(`  廚房看板   ${baseURL()}/kitchen`);
  console.log(`  外帶點餐   ${baseURL()}/takeout`);
  console.log(`  後台管理   ${baseURL()}/admin   （店員密碼 ${staffPin()}）\n`);
  keepAwake();
});

// Render 免費方案 15 分鐘沒流量就休眠，客人掃碼要等半分鐘才醒；
// 自己每 10 分鐘打一次自己的網址，讓它一直醒著。
// 注意：免費方案沒有永久硬碟，主機只要重啟（重新部署、Render 維護）訂單資料就會歸零，
// 這招只能減少休眠次數，正式營業還是要用有硬碟的方案（見 README）。
function keepAwake() {
  const url = process.env.RENDER_EXTERNAL_URL;
  if (!url || process.env.KEEP_AWAKE === '0') return;
  setInterval(() => {
    fetch(`${url}/api/health`).catch(() => {});
  }, 10 * 60 * 1000).unref();
  console.log('  已啟用防休眠：每 10 分鐘自動喚醒一次\n');
}
