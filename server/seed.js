// 菜單種子匯入。
// 手動重灌：npm run seed:menu
// 雲端第一次啟動時，index.js 也會自動呼叫 seedMenu()，否則店家打開會是空菜單。
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { db } from './db.js';

const __dirname = dirname(fileURLToPath(import.meta.url));

export function seedMenu() {
  const seed = JSON.parse(readFileSync(join(__dirname, 'menu.seed.json'), 'utf8'));

  // 整包放在同一個交易裡：中途出錯就全部回滾，不會留下半套菜單
  return db.transaction(async (tx) => {
    await tx.exec(`
      DELETE FROM item_option_groups;
      DELETE FROM option_choices;
      DELETE FROM option_groups;
      DELETE FROM menu_items;
      DELETE FROM categories;
    `);

    /* 選項群組 */
    const insGroup = tx.prepare('INSERT INTO option_groups (key, name, mode, required, sort) VALUES (?, ?, ?, ?, ?)');
    const insChoice = tx.prepare('INSERT INTO option_choices (group_id, name, price_delta, sort) VALUES (?, ?, ?, ?)');
    const groupIdByKey = new Map();

    for (const [gi, g] of (seed.optionGroups || []).entries()) {
      const { lastInsertRowid: id } = await insGroup.run(g.key, g.name, g.mode || 'single', g.required ? 1 : 0, gi);
      groupIdByKey.set(g.key, id);
      for (const [ci, c] of (g.choices || []).entries()) {
        await insChoice.run(id, c.name, Math.round(c.price_delta || 0), ci);
      }
    }

    /* 分類與品項 */
    const insCat = tx.prepare('INSERT INTO categories (name, sort) VALUES (?, ?)');
    const insItem = tx.prepare(
      'INSERT INTO menu_items (category_id, name, description, price, image, available, sort) VALUES (?, ?, ?, ?, ?, 1, ?)'
    );
    const linkGroup = tx.prepare('INSERT INTO item_option_groups (item_id, group_id, sort) VALUES (?, ?, ?)');

    let itemCount = 0;
    for (const [ci, cat] of seed.categories.entries()) {
      const { lastInsertRowid: catId } = await insCat.run(cat.name, ci);
      for (const [ii, it] of (cat.items || []).entries()) {
        const { lastInsertRowid: itemId } = await insItem.run(
          catId,
          it.name,
          it.description || '',
          Math.round(it.price),
          it.image || '',
          ii
        );
        for (const [oi, key] of (it.options || []).entries()) {
          const groupId = groupIdByKey.get(key);
          if (!groupId) throw new Error(`「${it.name}」引用了不存在的選項群組：${key}`);
          await linkGroup.run(itemId, groupId, oi);
        }
        itemCount++;
      }
    }

    return { categories: seed.categories.length, items: itemCount, groups: groupIdByKey.size };
  });
}

// 直接執行這個檔案時才跑（被 import 時不動作）
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const r = await seedMenu();
  console.log(`✓ 匯入完成：${r.categories} 個分類、${r.items} 道菜、${r.groups} 個選項群組`);
}
