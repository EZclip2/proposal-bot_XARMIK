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

const TOPIC_NEW      = (process.env.TOPIC_NEW || '').trim();
const TOPIC_ANSWERED = (process.env.TOPIC_ANSWERED || '').trim();
const TOPIC_BIZ      = (process.env.TOPIC_BIZ || '').trim();

if (!TOKEN || !MOD_CHAT_ID || !BOT_USERNAME || !APP_NAME) {
  console.error('КРИТИЧЕСКАЯ ОШИБКА: заполните BOT_TOKEN, MODERATION_CHAT_ID, BOT_USERNAME, APP_NAME в .env');
  process.exit(1);
}

// ======================= ИИ-КЛАССИФИКАЦИЯ (батчинг + дебаунс) =======================
// Провайдер задаётся env — сменить без правки кода:
//   OpenRouter: AI_BASE_URL=https://openrouter.ai/api/v1  AI_MODEL=meta-llama/llama-3.3-70b-instruct:free
//   Groq:       AI_BASE_URL=https://api.groq.com/openai/v1 AI_MODEL=openai/gpt-oss-20b
//   DeepSeek:   AI_BASE_URL=https://api.deepseek.com        AI_MODEL=deepseek-chat
const AI_API_KEY  = (process.env.AI_API_KEY || '').trim();
const AI_BASE_URL = (process.env.AI_BASE_URL || 'https://openrouter.ai/api/v1').trim().replace(/\/+$/, '');
const AI_MODEL    = (process.env.AI_MODEL || 'meta-llama/llama-3.3-70b-instruct:free').trim();

const AI_SYSTEM =
  'Classify messages sent to a public feedback/suggestion bot.\n' +
  'Categories:\n' +
  '- "trash": zero actionable substance — cannot be meaningfully responded to.\n' +
  '  IS trash: keyboard mashing (asdf, 123456, ///), random chars, pure profanity with no real complaint behind it, single filler words (test/hi/ok/lol/привет/?/!), emoji-only, "testing 123".\n' +
  '  NOT trash: rude-but-real feedback ("всё говно", "ужасный сервис"), vague negatives ("всё плохо"), very short real questions ("цена?", "когда?", "где?").\n' +
  '- "biz": business proposals, ads, partnerships, commercial offers.\n' +
  '- "reg": everything else — questions, feedback, bugs, suggestions, complaints, even if vague, emotional, or very short.\n' +
  'When unsure between trash and reg → choose reg.\n' +
  'Input: [{"id":1,"text":"..."}]\n' +
  'Output only valid JSON, no markdown:\n' +
  '{"results":[{"id":1,"cat":"trash"|"biz"|"reg","reply":"polite Russian rephrase request (ONLY if trash, else empty string)"}]}';

// Параметры дебаунс-буфера
const DEBOUNCE_FIRST = 15000;
const DEBOUNCE_EXT   =  5000;
const DEBOUNCE_MAX   = 45000;
const BATCH_MAX      =    15;

let batchItems    = [];
let batchStart    = null;
let batchDeadline = null;
let batchTimer    = null;
let batchSeq      = 0;

// хранит msgId сообщения «⏳ Получено» для удаления перед итоговым ответом
const pendingAck = new Map(); // userId → { chatId, msgId }

async function deletePendingAck(userId) {
  const entry = pendingAck.get(String(userId));
  if (!entry) return;
  pendingAck.delete(String(userId));
  try { await bot.deleteMessage(entry.chatId, entry.msgId); } catch {}
}

async function flushBatch() {
  clearTimeout(batchTimer);
  batchTimer = null; batchStart = null; batchDeadline = null; batchSeq = 0;

  const items = batchItems.splice(0);
  if (!items.length) return;

  const aiItems = items
    .filter(it => (it.msg.text || it.msg.caption || '').trim())
    .map(it => ({ id: it.id, text: (it.msg.text || it.msg.caption || '').slice(0, 1000) }));

  const classMap = await classifyBatch(aiItems);

  for (const { id, msg } of items) {
    const { cat, reply } = classMap.get(id) || { cat: 'reg', reply: '' };

    await deletePendingAck(msg.from.id);

    if (cat === 'trash') {
      const text = (reply && reply.trim())
        ? reply
        : '🤔 <b>Не удалось понять суть обращения.</b>\n\nПожалуйста, переформулируйте — опишите предложение, вопрос или отзыв понятнее и по существу.';
      await bot.sendMessage(msg.from.id, text, { parse_mode: 'HTML', reply_markup: HOME_KB }).catch(() => {});
    } else {
      const kind = cat === 'biz' ? 'biz' : 'normal';
      await createSuggestion(msg, kind).catch(e => console.error('createSuggestion:', e.message));
    }
  }
}

function scheduleBatch() {
  const now = Date.now();
  if (!batchStart) { batchStart = now; batchDeadline = now + DEBOUNCE_FIRST; }
  else { batchDeadline = Math.min(batchStart + DEBOUNCE_MAX, batchDeadline + DEBOUNCE_EXT); }
  clearTimeout(batchTimer);
  batchTimer = setTimeout(flushBatch, Math.max(0, batchDeadline - Date.now()));
}

async function classifyBatch(items) {
  const result = new Map(items.map(i => [i.id, { cat: 'reg', reply: '' }]));
  if (!AI_API_KEY || !items.length) return result;
  const ctrl = new AbortController();
  const abortTimer = setTimeout(() => ctrl.abort(), 20000);
  try {
    const resp = await fetch(`${AI_BASE_URL}/chat/completions`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${AI_API_KEY}` },
      body: JSON.stringify({
        model: AI_MODEL, temperature: 0, max_tokens: 80 * items.length + 50,
        messages: [
          { role: 'system', content: AI_SYSTEM },
          { role: 'user', content: JSON.stringify(items) },
        ],
      }),
      signal: ctrl.signal,
    });
    if (!resp.ok) throw new Error(`HTTP ${resp.status}: ${(await resp.text()).slice(0, 300)}`);
    const data = await resp.json();
    const content = data?.choices?.[0]?.message?.content || '';
    const jsonMatch = content.match(/\{[\s\S]*\}/);
    if (!jsonMatch) throw new Error('no JSON in LLM response');
    const parsed = JSON.parse(jsonMatch[0]);
    const VALID = new Set(['trash', 'biz', 'reg']);
    for (const r of (parsed.results || [])) {
      if (result.has(r.id)) result.set(r.id, { cat: VALID.has(r.cat) ? r.cat : 'reg', reply: String(r.reply || '') });
    }
    console.log(`classifyBatch: ${items.length} msg → [${[...result.values()].map(v => v.cat).join(', ')}]`);
  } catch (e) {
    console.error('classifyBatch:', e.message);
  } finally {
    clearTimeout(abortTimer);
  }
  return result;
}

if (AI_API_KEY) console.log(`ИИ-фильтр включён (батчинг): ${AI_MODEL} @ ${AI_BASE_URL}`);
else console.log('AI_API_KEY не задан — ИИ-фильтр выключен (всё принимается как reg).');

// ======================= ХРАНИЛИЩЕ =======================
const DB_FILE = path.join(__dirname, 'data.json');
let db = { items: {}, mutes: {} };
try { db = JSON.parse(fs.readFileSync(DB_FILE, 'utf8')); } catch {}
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

function genTicket(userId) {
  for (let i = 0; i < 8; i++) {
    const mixed = (Date.now() % 1e11) * 131 + (Number(userId) % 100000) * 977 + Math.floor(Math.random() * 1e6);
    const code = mixed.toString(36).toUpperCase().slice(-7).padStart(7, '0');
    if (!store.get(code)) return code;
  }
  return (Date.now().toString(36) + Math.random().toString(36).slice(2, 4)).toUpperCase();
}

const MUTE_MS = 15 * 60 * 1000;
function muteUser(userId) { db.mutes[String(userId)] = Date.now() + MUTE_MS; persist(); }
function mutedFor(userId) {
  const left = (db.mutes[String(userId)] || 0) - Date.now();
  return left > 0 ? left : 0;
}

function purgeExpiredMutes() {
  const now = Date.now();
  let changed = false;
  for (const [uid, exp] of Object.entries(db.mutes)) {
    if (exp < now) { delete db.mutes[uid]; changed = true; }
  }
  if (changed) persist();
}

// ======================= КЕШ МОДЕРАТОРОВ =======================
const modCache = new Map(); // userId → { result, expiry }
const MOD_CACHE_TTL = 5 * 60 * 1000;

async function isModerator(userId) {
  const cached = modCache.get(String(userId));
  if (cached && Date.now() < cached.expiry) return cached.result;
  try {
    const m = await bot.getChatMember(MOD_CHAT_ID, userId);
    const result = ['creator', 'administrator', 'member'].includes(m.status);
    modCache.set(String(userId), { result, expiry: Date.now() + MOD_CACHE_TTL });
    return result;
  } catch (e) { console.error('isModerator:', e.message); return false; }
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
  'Напиши своё предложение, идею, вопрос, отзыв или деловое предложение <b>одним сообщением</b> — ' +
  'я сам определю категорию и передам администрации. Ответ придёт сюда же.';

const HOME_KB  = { inline_keyboard: [[{ text: '🔙 В начало', callback_data: 'home' }]] };
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

// ======================= ОЧЕРЕДЬ =======================
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
    } catch {
      rec.lastShownPos = i;
    }
  }
}

const PROCESSING_TTL = 10 * 60 * 1000;
async function releaseStale() {
  for (const rec of store.all()) {
    if (rec.state === 'processing' && rec.processingAt && Date.now() - rec.processingAt > PROCESSING_TTL) {
      rec.state = 'new';
      rec.moderatorId = null; rec.moderatorName = null; rec.processingAt = null;
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

    let conf;
    if (isBiz) {
      conf = await bot.sendMessage(from.id,
        `💎 <b>Деловое предложение принято</b>\n🆔 <code>${rec.id}</code>\n\nПередано администрации напрямую — с вами свяжутся.`,
        { parse_mode: 'HTML', reply_markup: cancelKb(rec.id) });
    } else {
      const ahead = store.all().filter(r =>
        r.kind !== 'biz' && (r.state === 'new' || r.state === 'processing') && r.createdAt < rec.createdAt).length;
      conf = await bot.sendMessage(from.id, queueText(rec, ahead),
        { parse_mode: 'HTML', reply_markup: cancelKb(rec.id) });
      rec.lastShownPos = ahead;
    }
    rec.userMsgId = conf.message_id;
    store.set(rec);
  } catch (e) {
    console.error('createSuggestion:', e.message);
    await bot.sendMessage(from.id, '❌ Не удалось отправить предложение. Попробуйте позже.',
      { reply_markup: HOME_KB }).catch(() => {});
  }
}

async function rejectSuggestion(sid) {
  const rec = store.get(sid);
  if (!rec) return false;
  try { await bot.deleteMessage(MOD_CHAT_ID, rec.modMessageId); } catch (e) { console.error('reject del:', e.message); }

  const wasAnswered = rec.state === 'answered' || (rec.answers && rec.answers.length > 0);
  if (!wasAnswered) {
    muteUser(rec.userId);
    try {
      await bot.sendMessage(rec.userId,
        '🚫 <b>Обращение отклонено</b>\n\nК сожалению, ваше предложение отклонено администрацией.\n⏳ Отправить новое можно будет через 15 минут.',
        { parse_mode: 'HTML', reply_markup: HOME_KB });
    } catch {}
  }

  store.del(sid);
  updateQueue().catch(() => {});
  return true;
}

async function cancelSuggestion(sid, q) {
  const rec = store.get(sid);
  if (!rec || rec.userId !== q.from.id) {
    await bot.answerCallbackQuery(q.id, { text: 'Обращение недоступно' }); return;
  }
  if (rec.state === 'answered') {
    await bot.answerCallbackQuery(q.id, { text: 'На обращение уже ответили' }); return;
  }

  try { await bot.deleteMessage(MOD_CHAT_ID, rec.modMessageId); } catch {}
  store.del(sid);

  try {
    await bot.editMessageText('🚫 <b>Обращение отменено.</b>',
      { chat_id: rec.userId, message_id: rec.userMsgId, parse_mode: 'HTML', reply_markup: HOME_KB });
  } catch {
    await bot.sendMessage(rec.userId, '🚫 <b>Обращение отменено.</b>',
      { parse_mode: 'HTML', reply_markup: HOME_KB }).catch(() => {});
  }

  updateQueue().catch(() => {});
  await bot.answerCallbackQuery(q.id, { text: 'Обращение отменено' });
}

// ======================= ХЭНДЛЕРЫ =======================
bot.onText(/^\/start/, async (msg) => {
  if (msg.chat.type !== 'private') return;
  await bot.sendMessage(msg.chat.id, GREETING, { parse_mode: 'HTML' });
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
    await bot.sendMessage(msg.from.id,
      `⛔ <b>Вы недавно получили отказ.</b>\nОтправить новое обращение можно через ~${mins} мин.`,
      { parse_mode: 'HTML', reply_markup: HOME_KB }).catch(() => {});
    return;
  }

  // один пользователь — одно активное обращение
  const existing = store.all().find(r => String(r.userId) === String(msg.from.id) && r.state !== 'answered');
  if (existing) {
    await bot.sendMessage(msg.from.id,
      `⏳ <b>У вас уже есть активное обращение</b>\n🆔 <code>${existing.id}</code>\n\nДождитесь ответа или отмените его.`,
      { parse_mode: 'HTML', reply_markup: cancelKb(existing.id) }).catch(() => {});
    return;
  }

  const textForAI = (msg.text || msg.caption || '').trim();

  // Медиа без текста → сразу как обычное, без LLM.
  if (!textForAI) {
    await createSuggestion(msg, 'normal').catch(e => console.error('createSuggestion:', e.message));
    return;
  }

  // Pending-ack только для первого сообщения в буфере от этого пользователя.
  const alreadyWaiting = batchItems.some(it => it.msg.from.id === msg.from.id);
  if (!alreadyWaiting) {
    const ackMsg = await bot.sendMessage(msg.from.id, '⏳ <b>Получено</b> — определяем категорию...',
      { parse_mode: 'HTML' }).catch(() => null);
    if (ackMsg) pendingAck.set(String(msg.from.id), { chatId: msg.chat.id, msgId: ackMsg.message_id });
  }

  batchItems.push({ id: ++batchSeq, msg });

  if (batchItems.length >= BATCH_MAX) { flushBatch().catch(e => console.error('flushBatch:', e.message)); return; }
  scheduleBatch();
});

bot.on('callback_query', async (q) => {
  const data = q.data || '';
  try {
    if (data === 'home') {
      try {
        await bot.editMessageText(GREETING, {
          chat_id: q.message.chat.id, message_id: q.message.message_id, parse_mode: 'HTML',
        });
      } catch (e) {
        if (!String(e.message).includes('message is not modified')) {
          await bot.sendMessage(q.message.chat.id, GREETING, { parse_mode: 'HTML' }).catch(() => {});
        }
      }
      await bot.answerCallbackQuery(q.id);

    } else if (data.startsWith('cancel:')) {
      await cancelSuggestion(data.split(':')[1], q);

    } else if (data.startsWith('reject:')) {
      if (!(await isModerator(q.from.id))) {
        await bot.answerCallbackQuery(q.id, { text: 'Доступно только модераторам' }); return;
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
    isMedia: rec.isMedia, state: rec.state, answersText, moderatorName: rec.moderatorName,
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
    await bot.sendMessage(rec.userId,
      `💬 <b>${isFirst ? 'Ответ администрации' : 'Дополнение к ответу'}</b>\n🆔 <code>${rec.id}</code>\n\n${esc(answer)}`,
      { parse_mode: 'HTML', reply_markup: HOME_KB });
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

// сброс буфера при перезапуске (Render SIGTERM)
process.on('SIGTERM', async () => {
  console.log('SIGTERM: сбрасываю буфер перед завершением...');
  if (batchItems.length) {
    await flushBatch().catch(e => console.error('flushBatch on SIGTERM:', e.message));
  }
  process.exit(0);
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

  const pendingCount = store.all().filter(r => r.state !== 'answered').length;
  if (pendingCount) console.log(`ℹ️ В очереди при старте: ${pendingCount} обращений`);

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
    purgeExpiredMutes();
  }, 60000);
});
