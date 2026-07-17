// Разовая миграция data.json: bodyText + answers[] → messages[]
// Запуск: node migrate.js   (делает бэкап data.json.bak)
// ВНИМАНИЕ: в bot.js уже есть автомиграция при старте — этот скрипт нужен,
// только если хотите мигрировать базу заранее / отдельно от запуска бота.
const fs = require('fs');
const path = require('path');

const DB_FILE = path.join(__dirname, 'data.json');

let db;
try { db = JSON.parse(fs.readFileSync(DB_FILE, 'utf8')); }
catch { console.log('data.json не найден или пуст — миграция не нужна.'); process.exit(0); }

if (!db.items) db.items = {};
fs.writeFileSync(DB_FILE + '.bak', JSON.stringify(db, null, 2));
console.log('Бэкап сохранён: data.json.bak');

let migrated = 0;
for (const rec of Object.values(db.items)) {
  if (Array.isArray(rec.messages)) continue; // уже новый формат

  const msgs = [];
  const t0 = rec.createdAt || Date.now();

  if (rec.bodyText && rec.bodyText.trim()) {
    msgs.push({ from: 'user', by: rec.userMention || 'Пользователь', text: rec.bodyText, time: t0 });
  }
  (rec.answers || []).forEach((a, i) => {
    msgs.push({ from: 'mod', by: a.by || 'Модерация', text: a.text || '', time: t0 + (i + 1) });
  });

  rec.messages = msgs;
  if (rec.parentId === undefined) rec.parentId = null;
  delete rec.bodyText;
  delete rec.answers;
  migrated++;
}

fs.writeFileSync(DB_FILE, JSON.stringify(db, null, 2));
console.log(`Готово. Мигрировано записей: ${migrated}. Всего в базе: ${Object.keys(db.items).length}.`);
