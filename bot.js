require('dotenv').config();
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const express = require('express');
const TelegramBot = require('node-telegram-bot-api');

// ======================= КОНФИГУРАЦИЯ =======================
const TOKEN        = (process.env.BOT_TOKEN || '').trim();
const MOD_CHAT_ID  = (process.env.MODERATION_CHAT_ID || '').trim();
const BOT_USERNAME = (process.env.BOT_USERNAME || '').trim().replace(/^@/, '');
const APP_NAME     = (process.env.APP_NAME || '').trim();
const PUBLIC_URL   = (process.env.PUBLIC_URL || process.env.RENDER_EXTERNAL_URL || '').trim();
const PORT         = process.env.PORT || 3000;

// Темы форума (необязательно). Узнать ID: отправьте /topic внутри нужной темы.
const TOPIC_NEW      = (process.env.TOPIC_NEW || '').trim();       // тема «Новые предложения»
const TOPIC_ANSWERED = (process.env.TOPIC_ANSWERED || '').trim();  // тема «Обработанные»
const TOPIC_BIZ      = (process.env.TOPIC_BIZ || '').trim();       // тема «💎 Деловые предложения»

if (!TOKEN || !MOD_CHAT_ID || !BOT_USERNAME || !APP_NAME) {
  console.error('КРИТИЧЕСКАЯ ОШИБКА: заполните BOT_TOKEN, MODERATION_CHAT_ID, BOT_USERNAME, APP_NAME в .env');
  process.exit(1);
}

// ======================= ХРАНИЛИЩЕ =======================
const DB_FILE = path.join(__dirname, 'data.json');
let db = { items: {}, mutes: {} };
try { db = JSON.parse(fs.readFileSync(DB_FILE, 'utf8')); } catch { /* первый запуск */ }
if (!db.items) db.items = {};
if (!db.mutes) db.mutes = {};

let saveTimer = null;
function persist() {
  clearTimeout(saveTimer);
  saveTimer = setTimeout(() => fs.writeFile(DB_FILE, JSON.stringify(db, null, 2), () => {}), 200);
}
const store = {
  get(id)  { return db.items[String(id)]; },
  set(rec) { db.items[String(rec.id)] = rec; persist(); },
  del(id)  { delete db.items[String(id)]; persist(); },
  all()    { return Object.values(db.items); },
};

// Уникальный ID обращения: перемешиваем ID пользователя, время и случайную примесь.
// Короткий (6 символов, base36), уникален при каждом обращении, проверяем на коллизии.
function genTicket(userId) {
  for (let i = 0; i < 8; i++) {
    const mixed = ((Date.now() % 1e11) * 131 + (Number(userId) % 100000) * 977 + Math.floor(Math.random() * 1e6)) >>> 0;
    const code = mixed.toString(36).toUpperCase().slice(-6).padStart(6, '0');
    if (!store.get(code)) return code;
  }
  return (Date.now().toString(36) + Math.random().toString(36).slice(2, 4)).toUpperCase();
}

// Временный выбор категории (обычное / деловое) — не персистим.
const userMode = new Map();
// Сообщения бота у подписчика, которые нужно удалить при следующем обращении (чистка чата).
const userCleanup = new Map();
function queueCleanup(userId, msgId) {
  if (!msgId) return;
  const arr = userCleanup.get(userId) || [];
  arr.push(msgId);
  userCleanup.set(userId, arr);
}
async function doCleanup(userId, chatId) {
  const arr = userCleanup.get(userId);
  if (!arr) return;
  userCleanup.delete(userId);
  for (const mid of arr) { try { await bot.deleteMessage(chatId, mid); } catch {} }
}

// Мут на отправку предложений после отклонения (15 минут)
const MUTE_MS = 15 * 60 * 1000;
function muteUser(userId) { db.mutes[String(userId)] = Date.now() + MUTE_MS; persist(); }
function mutedFor(userId) {
  const left = (db.mutes[String(userId)] || 0) - Date.now();
  return left > 0 ? left : 0;
}

// ======================= ИНИЦИАЛИЗАЦИЯ =======================
const bot = new TelegramBot(TOKEN, { polling: false });
const app = express();
app.use(express.json());
app.get('/webapp.html', (req, res) => res.sendFile(path.join(__dirname, 'webapp.html')));

const esc = (s) => (s || '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
const clampCaption = (t) => (t.length > 1024 ? t.slice(0, 1015) + '…' : t);
const webAppUrl = (sid) => `https://t.me/${BOT_USERNAME}/${APP_NAME}?startapp=${sid}`;

const GREETING =
  '👋 <b>Привет!</b>\n\n' +
  'Напиши своё предложение, вопрос или отзыв одним сообщением — я передам его администрации, и тебе ответят прямо здесь.\n\n' +
  '💎 Есть <b>деловое предложение</b> (реклама, сотрудничество)? Выбери кнопку ниже — оно уйдёт напрямую.';

const START_KB = { inline_keyboard: [[
  { text: '✍️ Обычное', callback_data: 'kind:normal' },
  { text: '💎 Деловое',  callback_data: 'kind:biz' },
]] };
const HOME_KB = { inline_keyboard: [[{ text: '🔙 В начало', callback_data: 'home' }]] };
const cancelKb = (sid) => ({ inline_keyboard: [[{ text: '❌ Отменить обращение', callback_data: `cancel:${sid}` }]] });

function hasMedia(msg) {
  return !!(msg.photo || msg.video || msg.document || msg.voice || msg.audio ||
            msg.animation || msg.video_note || msg.sticker);
}

// ======================= КАРТОЧКА В МОДЕРАЦИИ =======================
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
  return { inline_keyboard: [[{ text: '➕ Дополнить ответ', url: webAppUrl(sid) }]] };
}

function cardText(rec) {
  const isBiz = rec.kind === 'biz';
  const noun = isBiz ? 'деловое предложение' : 'предложение';
  const gem  = isBiz ? '💎 ' : '';
  const head = `👤 ${esc(rec.userMention)}  ·  🆔 <code>${rec.id}</code>\n<code>[user: ${rec.userId}]</code>`;
  const body = esc(rec.bodyText) || '<i>(медиа без текста)</i>';
  if (rec.state === 'new') {
    return `${isBiz ? '💎' : '🟡'} <b>Новое ${noun}</b>\n${head}\n\n${body}`;
  }
  if (rec.state === 'processing') {
    return `${gem}🟠 <b>Обрабатывается</b>\n${head}\n🖊 В работе: ${esc(rec.moderatorName)}\n\n${body}`;
  }
  let out = `${gem}🟢 <b>Обработано</b>\n${head}\n\n${body}`;
  (rec.answers || []).forEach((a, i) => {
    out += `\n\n💬 <b>${i === 0 ? 'Ответ' : 'Дополнение'} · ${esc(a.by)}</b>\n${esc(a.text)}`;
  });
  return out;
}

async function refreshCard(rec) {
  const opts = {
    chat_id: MOD_CHAT_ID, message_id: rec.modMessageId,
    parse_mode: 'HTML', reply_markup: cardKeyboard(rec.id, rec.state),
  };
  try {
    if (rec.isMedia) await bot.editMessageCaption(clampCaption(cardText(rec)), opts);
    else             await bot.editMessageText(cardText(rec), opts);
  } catch (e) { console.error('refreshCard:', e.message); }
}

// Перенос обработанной карточки в тему «Обработанные» (только обычные).
async function relocateAnswered(rec) {
  const kb = cardKeyboard(rec.id, 'answered');
  const text = cardText(rec);
  try {
    let sent;
    if (rec.isMedia) {
      sent = await bot.copyMessage(MOD_CHAT_ID, MOD_CHAT_ID, rec.modMessageId,
        { message_thread_id: Number(TOPIC_ANSWERED), caption: clampCaption(text), parse_mode: 'HTML', reply_markup: kb });
    } else {
      sent = await bot.sendMessage(MOD_CHAT_ID, text,
        { message_thread_id: Number(TOPIC_ANSWERED), parse_mode: 'HTML', reply_markup: kb });
    }
    const oldId = rec.modMessageId;
    rec.modMessageId = sent.message_id;
    store.set(rec);
    try { await bot.deleteMessage(MOD_CHAT_ID, oldId); } catch {}
  } catch (e) {
    console.error('relocateAnswered:', e.message);
    await refreshCard(rec);
  }
}

async function isModerator(userId) {
  try {
    const m = await bot.getChatMember(MOD_CHAT_ID, userId);
    return ['creator', 'administrator', 'member'].includes(m.status);
  } catch (e) { console.error('isModerator:', e.message); return false; }
}

// ======================= ОЧЕРЕДЬ (только обычные предложения) =======================
function queueText(rec, ahead) {
  const head = `✅ <b>Обращение принято</b>\n🆔 <code>${rec.id}</code>`;
  if (ahead <= 0) return `${head}\n\n⏳ Вы <b>первый</b> в очереди — скоро ответим 💜`;
  return `${head}\n\n⏳ Перед вами в очереди: <b>${ahead}</b>\n<i>Статус обновляется автоматически.</i>`;
}

async function updateQueue() {
  const pending = store.all()
    .filter(r => r.kind !== 'biz' && (r.state === 'new' || r.state === 'processing'))
    .sort((a, b) => a.createdAt - b.createdAt);

  for (let i = 0; i < pending.length; i++) {
    const rec = pending[i];
    if (!rec.userMsgId) continue;
    if (rec.lastShownPos === i) continue;
    try {
      await bot.editMessageText(queueText(rec, i),
        { chat_id: rec.userId, message_id: rec.userMsgId, parse_mode: 'HTML', reply_markup: cancelKb(rec.id) });
      rec.lastShownPos = i;
      persist();
    } catch (e) {
      rec.lastShownPos = i;
    }
  }
}

// Авто-освобождение карточек, зависших в «Обрабатывается» без ответа (10 минут).
const PROCESSING_TTL = 10 * 60 * 1000;
async function releaseStale() {
  for (const rec of store.all()) {
    if (rec.state === 'processing' && rec.processingAt && Date.now() - rec.processingAt > PROCESSING_TTL) {
      rec.state = 'new';
      rec.moderatorId = null;
      rec.moderatorName = null;
      rec.processingAt = null;
      store.set(rec);
      await refreshCard(rec);
    }
  }
}

// ======================= ПРИЁМ ПРЕДЛОЖЕНИЯ =======================
async function createSuggestion(msg, kind) {
  const from = msg.from;
  const mention = from.username
    ? `@${from.username}`
    : (`${from.first_name || ''} ${from.last_name || ''}`.trim() || 'Пользователь');

  await doCleanup(from.id, msg.chat.id);

  const isText = !!msg.text && !hasMedia(msg);
  const isBiz = kind === 'biz';
  const rec = {
    id: genTicket(from.id), kind: isBiz ? 'biz' : 'normal',
    userId: from.id, userMention: mention,
    isMedia: !isText, bodyText: msg.text || msg.caption || '',
    state: 'new', moderatorId: null, moderatorName: null, processingAt: null,
    answers: [], modMessageId: null, userMsgId: null,
    lastShownPos: null, createdAt: Date.now(),
  };

  try {
    const kb = cardKeyboard(rec.id, 'new');
    const topic = isBiz ? TOPIC_BIZ : TOPIC_NEW;
    const thread = topic ? { message_thread_id: Number(topic) } : {};
    let sent;
    if (isText) {
      sent = await bot.sendMessage(MOD_CHAT_ID, cardText(rec), { parse_mode: 'HTML', reply_markup: kb, ...thread });
    } else {
      sent = await bot.copyMessage(MOD_CHAT_ID, msg.chat.id, msg.message_id,
        { caption: clampCaption(cardText(rec)), parse_mode: 'HTML', reply_markup: kb, ...thread });
    }
    rec.modMessageId = sent.message_id;
    store.set(rec);

    // Живой статус подписчику (с кнопкой отмены)
    if (isBiz) {
      const conf = await bot.sendMessage(msg.chat.id,
        `💎 <b>Деловое предложение принято</b>\n🆔 <code>${rec.id}</code>\n\nПередано администрации напрямую — с вами свяжутся.`,
        { parse_mode: 'HTML', reply_markup: cancelKb(rec.id) });
      rec.userMsgId = conf.message_id;
    } else {
      const ahead = store.all().filter(r =>
        r.kind !== 'biz' && (r.state === 'new' || r.state === 'processing') && r.createdAt < rec.createdAt).length;
      const conf = await bot.sendMessage(msg.chat.id, queueText(rec, ahead),
        { parse_mode: 'HTML', reply_markup: cancelKb(rec.id) });
      rec.userMsgId = conf.message_id;
      rec.lastShownPos = ahead;
    }
    store.set(rec);
  } catch (e) {
    console.error('createSuggestion:', e.message);
    const m = await bot.sendMessage(msg.chat.id, '❌ Не удалось отправить предложение. Попробуйте позже.', { reply_markup: HOME_KB });
    queueCleanup(from.id, m.message_id);
  }
}

// Отклонение модератором (мут + уведомление)
async function rejectSuggestion(sid) {
  const rec = store.get(sid);
  if (!rec) return false;
  try { await bot.deleteMessage(MOD_CHAT_ID, rec.modMessageId); } catch (e) { console.error('reject del:', e.message); }

  const wasAnswered = rec.state === 'answered' || (rec.answers && rec.answers.length > 0);
  if (!wasAnswered) {
    muteUser(rec.userId);
    if (rec.userMsgId) { try { await bot.deleteMessage(rec.userId, rec.userMsgId); } catch {} }
    try {
      const n = await bot.sendMessage(rec.userId,
        '🚫 <b>Обращение отклонено</b>\n\nК сожалению, ваше предложение отклонено администрацией.\n⏳ Отправить новое можно будет через 15 минут.',
        { parse_mode: 'HTML', reply_markup: HOME_KB });
      queueCleanup(rec.userId, n.message_id);
    } catch {}
  }

  store.del(sid);
  updateQueue().catch(() => {});
  return true;
}

// Отмена обращения самим подписчиком (без мута)
async function cancelSuggestion(sid, q) {
  const rec = store.get(sid);
  if (!rec || rec.userId !== q.from.id) { await bot.answerCallbackQuery(q.id, { text: 'Обращение недоступно' }); return; }
  if (rec.state === 'answered') { await bot.answerCallbackQuery(q.id, { text: 'На обращение уже ответили' }); return; }

  try { await bot.deleteMessage(MOD_CHAT_ID, rec.modMessageId); } catch {}
  store.del(sid);
  try {
    await bot.editMessageText('🚫 <b>Обращение отменено.</b>',
      { chat_id: rec.userId, message_id: rec.userMsgId, parse_mode: 'HTML', reply_markup: HOME_KB });
    queueCleanup(rec.userId, rec.userMsgId);
  } catch {}
  updateQueue().catch(() => {});
  await bot.answerCallbackQuery(q.id, { text: 'Обращение отменено' });
}

// ======================= ХЭНДЛЕРЫ =======================
bot.onText(/^\/start/, async (msg) => {
  await doCleanup(msg.from.id, msg.chat.id);
  const sent = await bot.sendMessage(msg.chat.id, GREETING, { parse_mode: 'HTML', reply_markup: START_KB });
  queueCleanup(msg.from.id, sent.message_id);
});

bot.on('message', async (msg) => {
  if (String(msg.chat.id) === MOD_CHAT_ID && msg.text && /^\/(id|topic)\b/.test(msg.text)) {
    await bot.sendMessage(MOD_CHAT_ID,
      `chat_id: <code>${msg.chat.id}</code>\nmessage_thread_id: <code>${msg.message_thread_id || '(General / нет темы)'}</code>`,
      { parse_mode: 'HTML', message_thread_id: msg.message_thread_id });
    return;
  }
  if (msg.chat.type !== 'private') return;
  if (msg.text && msg.text.startsWith('/')) return;

  const muteLeft = mutedFor(msg.from.id);
  if (muteLeft > 0) {
    const mins = Math.ceil(muteLeft / 60000);
    const m = await bot.sendMessage(msg.chat.id,
      `⛔ <b>Вы недавно получили отказ.</b>\nОтправить новое обращение можно через ~${mins} мин.`,
      { parse_mode: 'HTML', reply_markup: HOME_KB });
    queueCleanup(msg.from.id, m.message_id);
    return;
  }

  const kind = userMode.get(msg.from.id) === 'biz' ? 'biz' : 'normal';
  userMode.delete(msg.from.id);
  await createSuggestion(msg, kind);
});

bot.on('callback_query', async (q) => {
  const data = q.data || '';
  try {
    if (data.startsWith('kind:')) {
      const kind = data.split(':')[1] === 'biz' ? 'biz' : 'normal';
      userMode.set(q.from.id, kind);
      const txt = kind === 'biz'
        ? '💎 <b>Деловое предложение</b>\n\nОпишите его одним сообщением (можно с файлами) — оно уйдёт администрации напрямую.'
        : '✍️ <b>Новое предложение</b>\n\nНапишите ваше предложение, вопрос или отзыв одним сообщением.';
      try {
        await bot.editMessageText(txt, { chat_id: q.message.chat.id, message_id: q.message.message_id, parse_mode: 'HTML', reply_markup: HOME_KB });
        queueCleanup(q.from.id, q.message.message_id);
      } catch {
        const p = await bot.sendMessage(q.message.chat.id, txt, { parse_mode: 'HTML', reply_markup: HOME_KB });
        queueCleanup(q.from.id, p.message_id);
      }
      await bot.answerCallbackQuery(q.id);
    } else if (data === 'home') {
      try {
        await bot.editMessageText(GREETING,
          { chat_id: q.message.chat.id, message_id: q.message.message_id, parse_mode: 'HTML', reply_markup: START_KB });
        queueCleanup(q.from.id, q.message.message_id);
      } catch {}
      await bot.answerCallbackQuery(q.id);
    } else if (data.startsWith('cancel:')) {
      await cancelSuggestion(data.split(':')[1], q);
    } else if (data.startsWith('reject:')) {
      if (!(await isModerator(q.from.id))) {
        await bot.answerCallbackQuery(q.id, { text: 'Доступно только модераторам' });
        return;
      }
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

// ======================= ВАЛИДАЦИЯ initData =======================
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
  } catch { return null; }
}

async function authMiniApp(req, res) {
  const user = checkInitData((req.body && req.body.initData) || '');
  if (!user || !user.id) { res.status(403).json({ error: 'Некорректная подпись' }); return null; }
  if (!(await isModerator(user.id))) { res.status(403).json({ error: 'Вы не модератор' }); return null; }
  return user;
}
const modName = (u) => (u.username ? '@' + u.username : (u.first_name || 'модератор'));

// ======================= API МИНИ-ПРИЛОЖЕНИЯ =======================
app.post('/api/open', async (req, res) => {
  const user = await authMiniApp(req, res); if (!user) return;
  const rec = store.get(req.body.sid);
  if (!rec) return res.status(404).json({ error: 'Предложение уже обработано или удалено' });

  if (rec.state === 'new') {
    rec.state = 'processing';
    rec.moderatorId = user.id;
    rec.moderatorName = modName(user);
    rec.processingAt = Date.now();
    store.set(rec);
    await refreshCard(rec);
  }
  const answersText = (rec.answers || [])
    .map((a, i) => `${i === 0 ? 'Ответ' : 'Дополнение'} (${a.by}): ${a.text}`).join('\n\n');
  res.json({
    id: rec.id, kind: rec.kind, userMention: rec.userMention, bodyText: rec.bodyText,
    isMedia: rec.isMedia, state: rec.state, answersText,
    moderatorName: rec.moderatorName,
    busy: rec.state === 'answered' || (rec.moderatorId && rec.moderatorId !== user.id),
  });
});

app.post('/api/answer', async (req, res) => {
  const user = await authMiniApp(req, res); if (!user) return;
  const rec = store.get(req.body.sid);
  if (!rec) return res.status(404).json({ error: 'Предложение уже обработано или удалено' });
  const answer = String(req.body.text || '').trim();
  if (!answer) return res.status(400).json({ error: 'Пустой ответ' });
  if (answer.length > 3500) return res.status(400).json({ error: 'Слишком длинный ответ' });

  const isFirst = rec.state !== 'answered';

  try {
    const ans = await bot.sendMessage(rec.userId,
      `💬 <b>${isFirst ? 'Ответ администрации' : 'Дополнение к ответу'}</b>\n🆔 <code>${rec.id}</code>\n\n${esc(answer)}`,
      { parse_mode: 'HTML', reply_markup: HOME_KB });
    queueCleanup(rec.userId, ans.message_id);
  } catch (e) {
    console.error('deliver:', e.message);
    return res.status(502).json({ error: 'Не удалось доставить — возможно, пользователь заблокировал бота' });
  }

  rec.answers = rec.answers || [];
  rec.answers.push({ text: answer, by: modName(user) });
  rec.moderatorName = modName(user);
  if (isFirst) rec.state = 'answered';
  store.set(rec);

  if (isFirst) {
    if (rec.kind !== 'biz' && TOPIC_ANSWERED) await relocateAnswered(rec);
    else await refreshCard(rec);
    if (rec.userMsgId) { try { await bot.deleteMessage(rec.userId, rec.userMsgId); } catch {} }
  } else {
    await refreshCard(rec);
  }

  res.json({ ok: true });
  updateQueue().catch(() => {});
});

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
      console.warn(`⚠️ BOT_USERNAME (${BOT_USERNAME}) не совпадает с реальным (@${me.username})`);
    }
  } catch (e) { console.error('getMe:', e.message); }

  if (PUBLIC_URL) {
    try {
      await bot.setWebHook(`${PUBLIC_URL}/bot${TOKEN}`);
      console.log(`Вебхук установлен: ${PUBLIC_URL}/bot${TOKEN}`);
    } catch (e) { console.error('setWebHook:', e.message); }
  } else {
    console.log('PUBLIC_URL не задан — локальный режим, включаю polling');
    try { await bot.deleteWebHook(); } catch (e) { console.error('deleteWebHook:', e.message); }
    bot.startPolling();
  }

  setInterval(() => {
    updateQueue().catch(e => console.error('updateQueue:', e.message));
    releaseStale().catch(e => console.error('releaseStale:', e.message));
  }, 60000);
});
