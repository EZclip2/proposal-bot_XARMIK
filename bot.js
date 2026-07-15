require('dotenv').config();
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const express = require('express');
const TelegramBot = require('node-telegram-bot-api');

// ======================= КОНФИГУРАЦИЯ =======================
const TOKEN        = (process.env.BOT_TOKEN || '').trim();
const MOD_CHAT_ID  = (process.env.MODERATION_CHAT_ID || '').trim();   // -100xxxxxxxxxx
const BOT_USERNAME = (process.env.BOT_USERNAME || '').trim().replace(/^@/, '');
const APP_NAME     = (process.env.APP_NAME || '').trim();             // short name из BotFather /newapp
const PUBLIC_URL   = (process.env.PUBLIC_URL || process.env.RENDER_EXTERNAL_URL || '').trim();
const PORT         = process.env.PORT || 3000;

if (!TOKEN || !MOD_CHAT_ID || !BOT_USERNAME || !APP_NAME) {
  console.error('КРИТИЧЕСКАЯ ОШИБКА: заполните BOT_TOKEN, MODERATION_CHAT_ID, BOT_USERNAME, APP_NAME в .env');
  process.exit(1);
}

// Ссылки для кнопки «Информация» — поменяйте под свой канал
const INFO_TEXT = 'Привет! Это официальный бот канала Lucky Death. Здесь ты можешь найти всю актуальную информацию о нас и наших проектах 💜';
const INFO_LINKS = [
  [{ text: 'Твич',   url: 'https://www.twitch.tv/luckydeath_' }, { text: 'Ютуб', url: 'https://youtube.com/@LuckyDeath0' }],
  [{ text: 'ТГК',    url: 'https://t.me/luckydeath' },           { text: 'Discord', url: 'https://discord.com/invite/wawtcMXG' }],
  [{ text: 'Донаты', url: 'https://www.donationalerts.com/r/lucky_death' }],
];

// ======================= ХРАНИЛИЩЕ (JSON, переживает рестарт) =======================
const DB_FILE = path.join(__dirname, 'data.json');
let db = { counter: 100, items: {} };
try { db = JSON.parse(fs.readFileSync(DB_FILE, 'utf8')); } catch { /* первый запуск */ }

let saveTimer = null;
function persist() {
  clearTimeout(saveTimer);
  saveTimer = setTimeout(() => fs.writeFile(DB_FILE, JSON.stringify(db, null, 2), () => {}), 200);
}
const store = {
  nextId() { db.counter += 1; persist(); return db.counter; },
  get(id)  { return db.items[String(id)]; },
  set(rec) { db.items[String(rec.id)] = rec; persist(); },
  del(id)  { delete db.items[String(id)]; persist(); },
};

// ======================= ИНИЦИАЛИЗАЦИЯ =======================
const bot = new TelegramBot(TOKEN, { polling: false });
const app = express();
app.use(express.json());
app.use(express.static(path.join(__dirname, 'public')));

const esc = (s) => (s || '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
const clampCaption = (t) => (t.length > 1024 ? t.slice(0, 1015) + '…' : t);
const webAppUrl = (sid) => `https://t.me/${BOT_USERNAME}/${APP_NAME}?startapp=${sid}`;
const MENU = { inline_keyboard: [[
  { text: 'ℹ️ Информация', callback_data: 'info' },
  { text: '✍️ Предложка',  callback_data: 'feedback' },
]] };

function hasMedia(msg) {
  return !!(msg.photo || msg.video || msg.document || msg.voice || msg.audio ||
            msg.animation || msg.video_note || msg.sticker);
}

// ======================= КАРТОЧКА: ТЕКСТ И КНОПКИ ПО СОСТОЯНИЮ =======================
function cardKeyboard(sid, state) {
  if (state === 'new') {
    return { inline_keyboard: [
      [{ text: '✍️ Ответить', url: webAppUrl(sid) }],
      [{ text: '🚫 Отклонить', callback_data: `reject:${sid}` }],
    ] };
  }
  if (state === 'processing') {
    return { inline_keyboard: [
      [{ text: '✍️ Открыть ответ', url: webAppUrl(sid) }],
      [{ text: '🚫 Отклонить', callback_data: `reject:${sid}` }],
    ] };
  }
  return { inline_keyboard: [[{ text: '✅ Доставлено подписчику', callback_data: 'noop' }]] };
}

function cardText(rec) {
  // userMention и moderatorName хранятся сырыми — экранируем здесь при вставке в HTML
  const head = `👤 ${esc(rec.userMention)}  <code>[ID: ${rec.userId}]</code>`;
  const body = esc(rec.bodyText) || '<i>(медиа без текста)</i>';
  if (rec.state === 'new') {
    return `🟡 <b>Новое предложение №${rec.id}</b>\n${head}\n\n${body}`;
  }
  if (rec.state === 'processing') {
    return `🟠 <b>Обрабатывается · №${rec.id}</b>\n${head}\n🖊 В работе: ${esc(rec.moderatorName)}\n\n${body}`;
  }
  // answered
  return `🟢 <b>Обработано · №${rec.id}</b>\n${head}\n\n${body}` +
         `\n\n💬 <b>Ответ · ${esc(rec.moderatorName)}</b>\n${esc(rec.answerText)}`;
}

async function refreshCard(rec) {
  const opts = {
    chat_id: MOD_CHAT_ID,
    message_id: rec.modMessageId,
    parse_mode: 'HTML',
    reply_markup: cardKeyboard(rec.id, rec.state),
  };
  try {
    if (rec.isMedia) await bot.editMessageCaption(clampCaption(cardText(rec)), opts);
    else             await bot.editMessageText(cardText(rec), opts);
  } catch (e) {
    console.error('refreshCard:', e.message);
  }
}

// ======================= ПРОВЕРКА, ЧТО ЮЗЕР — МОДЕРАТОР =======================
async function isModerator(userId) {
  try {
    const m = await bot.getChatMember(MOD_CHAT_ID, userId);
    return ['creator', 'administrator', 'member'].includes(m.status);
  } catch (e) {
    console.error('isModerator:', e.message);
    return false;
  }
}

// ======================= ПРИЁМ ПРЕДЛОЖЕНИЯ ОТ ПОДПИСЧИКА =======================
async function createSuggestion(msg) {
  const from = msg.from;
  // Храним сырое значение — экранирование выполняется в cardText при вставке в HTML
  const mention = from.username
    ? `@${from.username}`
    : (`${from.first_name || ''} ${from.last_name || ''}`.trim() || 'Пользователь');

  const isText = !!msg.text && !hasMedia(msg);
  const rec = {
    id: store.nextId(),
    userId: from.id,
    userMention: mention,
    isMedia: !isText,
    bodyText: msg.text || msg.caption || '',
    state: 'new',
    moderatorId: null,
    moderatorName: null,
    answerText: null,
    modMessageId: null,
    createdAt: Date.now(),
  };

  try {
    const kb = cardKeyboard(rec.id, 'new');
    let sent;
    if (isText) {
      sent = await bot.sendMessage(MOD_CHAT_ID, cardText(rec), { parse_mode: 'HTML', reply_markup: kb });
    } else {
      sent = await bot.copyMessage(MOD_CHAT_ID, msg.chat.id, msg.message_id,
        { caption: clampCaption(cardText(rec)), parse_mode: 'HTML', reply_markup: kb });
    }
    rec.modMessageId = sent.message_id;
    store.set(rec);
    await bot.sendMessage(msg.chat.id,
      `✅ Спасибо! Ваше предложение №${rec.id} отправлено администрации. Ответ придёт сюда же.`);
  } catch (e) {
    console.error('createSuggestion:', e.message);
    await bot.sendMessage(msg.chat.id, '❌ Не удалось отправить предложение. Попробуйте позже.');
  }
}

async function rejectSuggestion(sid) {
  const rec = store.get(sid);
  if (!rec) return false;
  try { await bot.deleteMessage(MOD_CHAT_ID, rec.modMessageId); } catch (e) { console.error('reject del:', e.message); }
  store.del(sid);
  return true;
}

// ======================= ХЭНДЛЕРЫ БОТА =======================
bot.onText(/^\/start/, (msg) => {
  bot.sendMessage(msg.chat.id,
    '👋 Привет! Выбери действие или сразу напиши своё предложение, вопрос или отзыв — я передам его администрации.',
    { reply_markup: MENU });
});

bot.on('message', async (msg) => {
  if (msg.chat.type !== 'private') return;            // только личка
  if (msg.text && msg.text.startsWith('/')) return;   // команды не пересылаем
  await createSuggestion(msg);
});

bot.on('callback_query', async (q) => {
  const data = q.data || '';
  try {
    if (data === 'info') {
      await bot.sendMessage(q.message.chat.id, INFO_TEXT, { reply_markup: { inline_keyboard: INFO_LINKS } });
      await bot.answerCallbackQuery(q.id);
    } else if (data === 'feedback') {
      await bot.sendMessage(q.message.chat.id,
        '📝 Напишите предложение или отправьте фото / видео / документ — я передам администрации.');
      await bot.answerCallbackQuery(q.id);
    } else if (data.startsWith('reject:')) {
      const ok = await rejectSuggestion(data.split(':')[1]);
      await bot.answerCallbackQuery(q.id, { text: ok ? 'Отклонено и удалено 🚫' : 'Уже обработано' });
    } else {
      await bot.answerCallbackQuery(q.id);
    }
  } catch (e) {
    console.error('callback_query:', e.message);
    try { await bot.answerCallbackQuery(q.id); } catch {}
  }
});

// ======================= ВАЛИДАЦИЯ initData МИНИ-ПРИЛОЖЕНИЯ =======================
function checkInitData(initData) {
  try {
    const params = new URLSearchParams(initData);
    const hash = params.get('hash');
    if (!hash) return null;
    params.delete('hash');
    const dcs = [...params.entries()].map(([k, v]) => `${k}=${v}`).sort().join('\n');
    const secret = crypto.createHmac('sha256', 'WebAppData').update(TOKEN).digest();
    const calc = crypto.createHmac('sha256', secret).update(dcs).digest('hex');
    if (calc !== hash) return null;
    if (Date.now() - Number(params.get('auth_date')) * 1000 > 24 * 3600 * 1000) return null;
    return JSON.parse(params.get('user') || '{}');
  } catch {
    return null;
  }
}

async function authMiniApp(req, res) {
  const user = checkInitData((req.body && req.body.initData) || '');
  if (!user || !user.id) { res.status(403).json({ error: 'Некорректная подпись' }); return null; }
  if (!(await isModerator(user.id))) { res.status(403).json({ error: 'Вы не модератор' }); return null; }
  return user;
}
const modName = (u) => (u.username ? '@' + u.username : (u.first_name || 'модератор'));

// ======================= API МИНИ-ПРИЛОЖЕНИЯ =======================
// Открытие мини-приложения → карточка переходит в «Обрабатывается»
app.post('/api/open', async (req, res) => {
  const user = await authMiniApp(req, res); if (!user) return;
  const rec = store.get(req.body.sid);
  if (!rec) return res.status(404).json({ error: 'Предложение уже обработано или удалено' });

  if (rec.state === 'new') {
    rec.state = 'processing';
    rec.moderatorId = user.id;
    rec.moderatorName = modName(user);
    store.set(rec);
    await refreshCard(rec);
  }
  res.json({
    id: rec.id, userMention: rec.userMention, bodyText: rec.bodyText,
    isMedia: rec.isMedia, state: rec.state, answerText: rec.answerText,
    moderatorName: rec.moderatorName,
    busy: rec.state === 'answered' || (rec.moderatorId && rec.moderatorId !== user.id),
  });
});

// Отправка ответа подписчику → карточка переходит в «Обработано»
app.post('/api/answer', async (req, res) => {
  const user = await authMiniApp(req, res); if (!user) return;
  const rec = store.get(req.body.sid);
  if (!rec) return res.status(404).json({ error: 'Предложение уже обработано или удалено' });
  const answer = String(req.body.text || '').trim();
  if (!answer) return res.status(400).json({ error: 'Пустой ответ' });
  if (answer.length > 3500) return res.status(400).json({ error: 'Слишком длинный ответ' });

  try {
    await bot.sendMessage(rec.userId,
      `💬 <b>Ответ администрации:</b>\n\n${esc(answer)}`, { parse_mode: 'HTML' });
  } catch (e) {
    console.error('deliver:', e.message);
    return res.status(502).json({ error: 'Не удалось доставить — возможно, пользователь заблокировал бота' });
  }

  rec.state = 'answered';
  rec.answerText = answer;
  rec.moderatorName = modName(user);
  store.set(rec);
  await refreshCard(rec);
  res.json({ ok: true });
});

// Отклонение из мини-приложения → карточка удаляется
app.post('/api/reject', async (req, res) => {
  const user = await authMiniApp(req, res); if (!user) return;
  await rejectSuggestion(req.body.sid);
  res.json({ ok: true });
});

// ======================= WEBHOOK И ЗАПУСК =======================
app.get('/', (req, res) => res.status(200).send('Suggestion bot is running'));

app.post(`/bot${TOKEN}`, (req, res) => {
  try { bot.processUpdate(req.body); } catch (e) { console.error('webhook:', e.message); }
  res.sendStatus(200);
});

app.listen(PORT, '0.0.0.0', async () => {
  console.log(`Сервер запущен на порту ${PORT}`);
  try {
    const me = await bot.getMe();
    console.log(`Бот: @${me.username}`);
    if (me.username.toLowerCase() !== BOT_USERNAME.toLowerCase()) {
      console.warn(`⚠️ BOT_USERNAME (${BOT_USERNAME}) не совпадает с реальным (@${me.username}) — ссылка на мини-приложение не откроется`);
    }
  } catch (e) { console.error('getMe:', e.message); }

  if (PUBLIC_URL) {
    try {
      await bot.setWebHook(`${PUBLIC_URL}/bot${TOKEN}`);
      console.log(`Вебхук установлен: ${PUBLIC_URL}/bot${TOKEN}`);
    } catch (e) { console.error('setWebHook:', e.message); }
  } else {
    // Локальная разработка: снимаем webhook (если был) и запускаем polling
    console.log('PUBLIC_URL не задан — локальный режим, включаю polling');
    try { await bot.deleteWebHook(); } catch (e) { console.error('deleteWebHook:', e.message); }
    bot.startPolling();
  }
});
