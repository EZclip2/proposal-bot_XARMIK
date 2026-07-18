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

// Диагностика тем: если ID не число — перенос/публикация в тему работать не будут.
for (const [name, val] of [['TOPIC_NEW', TOPIC_NEW], ['TOPIC_ANSWERED', TOPIC_ANSWERED], ['TOPIC_BIZ', TOPIC_BIZ]]) {
  if (val && Number.isNaN(Number(val))) {
    console.warn(`⚠️ ${name}="${val}" — не число. Узнайте ID: отправьте /topic внутри нужной темы в чате модерации.`);
  }
}

// Подписчик всегда видит ответ «от Администрации» — личный юзернейм/имя модератора не раскрываем.
const MOD_LABEL = 'Администрация';
// Через сколько после последнего ответа админа можно обработать без ответа пользователя.
const CLOSE_DELAY_MS = 60 * 60 * 1000;

// ======================= ДЕТЕКТОР СПАМА (без ИИ) =======================
const userMsgLog   = new Map();
const userLastText = new Map();

const SPAM_FLOOD_WINDOW = 30  * 1000;
const SPAM_FLOOD_LIMIT  = 5;
const SPAM_DUP_WINDOW   = 2  * 60 * 1000;

function recordAndCheckSpam(userId, text) {
  const uid = String(userId);
  const now = Date.now();

  const log = (userMsgLog.get(uid) || []).filter(t => now - t < SPAM_FLOOD_WINDOW);
  log.push(now);
  userMsgLog.set(uid, log);
  if (log.length > SPAM_FLOOD_LIMIT) return 'flood';

  if (text) {
    const last = userLastText.get(uid);
    if (last && last.text === text && now - last.time < SPAM_DUP_WINDOW) return 'duplicate';
    userLastText.set(uid, { text, time: now });
  }

  return null;
}

// ======================= ИИ-КЛАССИФИКАЦИЯ (батчинг + дебаунс) =======================
const AI_API_KEY  = (process.env.AI_API_KEY || '').trim();
const AI_BASE_URL = (process.env.AI_BASE_URL || 'https://openrouter.ai/api/v1').trim().replace(/\/+$/, '');
const AI_MODEL    = (process.env.AI_MODEL || 'meta-llama/llama-3.3-70b-instruct:free').trim();

const AI_SYSTEM =
  'Classify messages sent to a public feedback/suggestion bot.\n' +
  'Categories:\n' +
  '- "trash": zero actionable substance — cannot be meaningfully responded to.\n' +
  '  IS trash: keyboard mashing (asdf, 123456, ///), random chars, pure profanity with no complaint, single filler words (test/hi/ok/lol/привет/?/!), emoji-only chains.\n' +
  '  NOT trash: rude-but-real feedback ("всё говно", "ужасный сервис"), vague negatives ("всё плохо"), short real questions ("цена?", "когда?", "где?").\n' +
  '- "biz": business proposals, ads, partnerships, commercial offers.\n' +
  '- "reg": everything else — questions, feedback, bugs, suggestions, complaints, even if vague or emotional.\n' +
  'For trash only — set "mute": true if the message shows DELIBERATE malice: targeted insults, hate, threats, intentional spam flooding, or repeated nonsense after a warning.\n' +
  'Set "mute": false if the message is just unclear, meaningless, or unintentional (user likely confused or testing).\n' +
  'When trash+mute=false: fill "reply" with a polite Russian request to rephrase.\n' +
  'When trash+mute=true or cat!=trash: leave "reply" empty.\n' +
  'When unsure between trash and reg → choose reg.\n' +
  'Input: [{"id":1,"text":"..."}]\n' +
  'Output ONLY a raw JSON object, no markdown, no code fences, no commentary, no reasoning:\n' +
  '{"results":[{"id":1,"cat":"trash"|"biz"|"reg","mute":false,"reply":"..."}]}';

const DEBOUNCE_FIRST = 15000;
const DEBOUNCE_EXT   =  5000;
const DEBOUNCE_MAX   = 45000;
const BATCH_MAX      =    15;

let batchItems    = [];
let batchStart    = null;
let batchDeadline = null;
let batchTimer    = null;
let batchSeq      = 0;

const pendingAck = new Map();

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
    const { cat, mute, reply } = classMap.get(id) || { cat: 'reg', mute: false, reply: '' };

    await deletePendingAck(msg.from.id);

    if (cat === 'trash') {
      if (mute) {
        muteUser(msg.from.id);
        await bot.sendMessage(msg.from.id,
          '🚫 <b>Сообщение нарушает правила.</b>\n\nОтправка заблокирована на <b>15 минут</b>.',
          { parse_mode: 'HTML', reply_markup: HOME_KB }).catch(() => {});
      } else {
        const text = (reply && reply.trim())
          ? reply
          : '🤔 <b>Не удалось понять суть обращения.</b>\n\nПереформулируйте, пожалуйста, — по существу.';
        await bot.sendMessage(msg.from.id, text, { parse_mode: 'HTML', reply_markup: HOME_KB }).catch(() => {});
      }
    } else {
      // Дедуп: если у пользователя уже есть активное обращение (в т.ч. созданное
      // в этом же батче предыдущей итерацией) — дописываем в него, а не плодим новое.
      const active = store.all().find(r =>
        String(r.userId) === String(msg.from.id) && r.state !== 'closed');
      const body = msg.text || msg.caption || '';
      if (active) {
        active.messages = active.messages || [];
        if (body) active.messages.push({ from: 'user', by: active.userMention, text: body, time: Date.now() });
        if (active.state === 'answered') active._gateOk = false;
        store.set(active);
        await refreshCard(active).catch(() => {});
      } else {
        const kind = cat === 'biz' ? 'biz' : 'normal';
        await createSuggestion(msg, kind).catch(e => console.error('createSuggestion:', e.message));
      }
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

// Достаём JSON-объект из ответа модели: снимаем reasoning-теги, markdown-фенсы,
// пробуем прямой парс и первый сбалансированный { ... }.
function extractJsonObject(content) {
  if (!content) return null;
  if (Array.isArray(content)) content = content.map(p => (p && (p.text || p.content)) || '').join('');
  let s = String(content).trim();
  s = s.replace(/<think>[\s\S]*?<\/think>/gi, '').trim();
  const fence = s.match(/```(?:json)?\s*([\s\S]*?)```/i);
  if (fence) s = fence[1].trim();
  try { return JSON.parse(s); } catch {}
  const start = s.indexOf('{');
  if (start === -1) return null;
  let depth = 0;
  for (let i = start; i < s.length; i++) {
    const c = s[i];
    if (c === '{') depth++;
    else if (c === '}') { depth--; if (depth === 0) { try { return JSON.parse(s.slice(start, i + 1)); } catch { return null; } } }
  }
  return null;
}

async function classifyBatch(items) {
  const result = new Map(items.map(i => [i.id, { cat: 'reg', mute: false, reply: '' }]));
  if (!AI_API_KEY || !items.length) return result;
  const ctrl = new AbortController();
  const abortTimer = setTimeout(() => ctrl.abort(), 20000);
  try {
    const resp = await fetch(`${AI_BASE_URL}/chat/completions`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${AI_API_KEY}` },
      body: JSON.stringify({
        model: AI_MODEL,
        temperature: 0,
        max_tokens: Math.min(2000, 120 * items.length + 200),
        response_format: { type: 'json_object' },
        messages: [
          { role: 'system', content: AI_SYSTEM },
          { role: 'user', content: JSON.stringify(items) },
        ],
      }),
      signal: ctrl.signal,
    });
    if (!resp.ok) throw new Error(`HTTP ${resp.status}: ${(await resp.text()).slice(0, 300)}`);
    const data = await resp.json();
    const choice = data?.choices?.[0];
    const content = choice?.message?.content ?? choice?.message?.reasoning ?? '';
    const parsed = extractJsonObject(content);
    if (!parsed) {
      const snippet = String(content || '').replace(/\s+/g, ' ').slice(0, 200);
      throw new Error(`no JSON (finish=${choice?.finish_reason}, len=${String(content || '').length}, snippet="${snippet}")`);
    }
    const VALID = new Set(['trash', 'biz', 'reg']);
    for (const r of (parsed.results || [])) {
      if (result.has(r.id)) {
        const cat = VALID.has(r.cat) ? r.cat : 'reg';
        result.set(r.id, {
          cat,
          mute:  cat === 'trash' && r.mute === true,
          reply: String(r.reply || ''),
        });
      }
    }
    console.log(`classifyBatch: ${items.length} msg → [${[...result.values()].map(v => v.cat + (v.mute ? '+mute' : '')).join(', ')}]`);
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

// Автомиграция старых записей при старте:
//  - bodyText + answers[] → messages[]
//  - прежнее состояние 'answered' (авто-закрытие) → 'closed' (обработано вручную/исторически)
(function migrateInline() {
  let changed = false;
  for (const rec of Object.values(db.items)) {
    if (!Array.isArray(rec.messages)) {
      const msgs = [];
      const t0 = rec.createdAt || Date.now();
      if (rec.bodyText && String(rec.bodyText).trim()) {
        msgs.push({ from: 'user', by: rec.userMention || 'Пользователь', text: rec.bodyText, time: t0 });
      }
      (rec.answers || []).forEach((a, i) => {
        msgs.push({ from: 'mod', by: MOD_LABEL, text: a.text || '', time: t0 + (i + 1) });
      });
      rec.messages = msgs;
      if (rec.parentId === undefined) rec.parentId = null;
      delete rec.bodyText;
      delete rec.answers;
      changed = true;
    }
    if (rec.state === 'answered' && !rec._v2) {
      // В старой модели 'answered' означало «закрыто и в просмотренных» → теперь это 'closed'.
      rec.state = 'closed';
      changed = true;
    }
    if (!rec._v2) { rec._v2 = true; changed = true; }
  }
  if (changed) console.log('Автомиграция data.json выполнена.');
})();

let saveTimer = null;
function persist() {
  clearTimeout(saveTimer);
  saveTimer = setTimeout(() => fs.writeFile(DB_FILE, JSON.stringify(db, null, 2), () => {}), 200);
}
// Синхронный сброс БД на диск (используется перед завершением процесса).
function persistNow() {
  try {
    clearTimeout(saveTimer);
    fs.writeFileSync(DB_FILE, JSON.stringify(db, null, 2));
  } catch (e) { console.error('persistNow:', e.message); }
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
const modCache = new Map();
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
  'Напиши предложение, вопрос, отзыв или деловое предложение <b>одним сообщением</b> — ' +
  'я определю категорию и передам администрации. Дальше — в приложении-переписке.';

const HOME_KB  = { inline_keyboard: [[{ text: '🔙 В начало', callback_data: 'home' }]] };
const openAppKb = (sid, label) => ({ inline_keyboard: [[{ text: label || '💬 Открыть переписку', url: webAppUrl(sid) }]] });
const userKb = (sid) => ({ inline_keyboard: [
  [{ text: '💬 Открыть переписку', url: webAppUrl(sid) }],
  [{ text: '❌ Отменить обращение', callback_data: `cancel:${sid}` }],
] });

function hasMedia(msg) {
  return !!(msg.photo || msg.video || msg.document || msg.voice || msg.audio ||
            msg.animation || msg.video_note || msg.sticker);
}

// Реальные (не контекстные) сообщения обращения.
function realMsgs(rec) { return (rec.messages || []).filter(m => !m.ctx); }

// Может ли модератор обработать (закрыть) обращение прямо сейчас.
function canModClose(rec) {
  const real = realMsgs(rec);
  const modMsgs = real.filter(m => m.from === 'mod');
  if (!modMsgs.length) return { ok: false, reason: 'Нельзя обработать: сначала ответьте пользователю.' };
  const lastMod = modMsgs[modMsgs.length - 1];
  const userAfter = real.some(m => m.from === 'user' && m.time > lastMod.time);
  const elapsed = Date.now() - lastMod.time;
  if (userAfter || elapsed >= CLOSE_DELAY_MS) return { ok: true, reason: '' };
  const leftMin = Math.ceil((CLOSE_DELAY_MS - elapsed) / 60000);
  return { ok: false, reason: `Пока нельзя обработать: дождитесь ответа пользователя или подождите ещё ~${leftMin} мин.` };
}

// ======================= КАРТОЧКА В МОДЕРАЦИИ (только уведомление) =======================
function cardKeyboard(sid, state) {
  if (state === 'closed') {
    return { inline_keyboard: [[{ text: '💬 Открыть переписку', url: webAppUrl(sid) }]] };
  }
  if (state === 'answered') {
    return { inline_keyboard: [
      [{ text: '💬 Открыть переписку', url: webAppUrl(sid) }],
      [{ text: '✅ Обработать', callback_data: `close:${sid}` }],
      [{ text: '🚫 Отклонить', callback_data: `reject:${sid}` }],
    ] };
  }
  return { inline_keyboard: [
    [{ text: state === 'processing' ? '💬 Открыть переписку' : '✍️ Ответить', url: webAppUrl(sid) }],
    [{ text: '🚫 Отклонить', callback_data: `reject:${sid}` }],
  ] };
}

// Карточка НЕ содержит текст обращения — только мета, статус и счётчик сообщений.
function cardText(rec) {
  const isBiz = rec.kind === 'biz';
  const noun = isBiz ? 'деловое предложение' : 'обращение';
  const gem  = isBiz ? '💎 ' : '';
  const ctx  = rec.parentId ? `\n🔁 Продолжение <code>${rec.parentId}</code>` : '';
  const head =
    `👤 ${esc(rec.userMention)}  ·  🆔 <code>${rec.id}</code>\n` +
    `<code>[user: ${rec.userId}]</code>${ctx}`;
  const real = realMsgs(rec);
  const fromUser = real.filter(m => m.from === 'user').length;
  const fromMod  = real.filter(m => m.from === 'mod').length;
  const foot = `\n\n💬 <b>${real.length}</b> · 👤 ${fromUser} · 🛡 ${fromMod}`;

  if (rec.state === 'new')        return `${isBiz ? '💎' : '🟡'} <b>Новое ${noun}</b>\n${head}${foot}`;
  if (rec.state === 'processing') return `${gem}🟠 <b>В работе</b> · ${esc(rec.moderatorName)}\n${head}${foot}`;
  if (rec.state === 'answered') {
    const g = canModClose(rec);
    const gateLine = g.ok ? '\n✅ <b>Можно обработать</b>' : '\n⏳ <i>' + esc(g.reason) + '</i>';
    return `${gem}🔵 <b>Отвечено · идёт диалог</b>\n${head}${foot}${gateLine}`;
  }
  const byLine = rec.closedBy === 'user' ? ' · закрыл пользователь'
               : rec.closedBy === 'mod'  ? ' · закрыла администрация' : '';
  return `${gem}🟢 <b>Обработано</b>${byLine}\n${head}${foot}`;
}

async function refreshCard(rec) {
  const opts = {
    chat_id: MOD_CHAT_ID, message_id: rec.modMessageId,
    parse_mode: 'HTML', reply_markup: cardKeyboard(rec.id, rec.state),
  };
  try {
    if (rec.isMedia) await bot.editMessageCaption(clampCaption(cardText(rec)), opts);
    else             await bot.editMessageText(cardText(rec), opts);
  } catch (e) {
    if (!String(e.message).includes('message is not modified')) console.error('refreshCard:', e.message);
  }
}

// Перенос карточки в тему «Обработанные» (при закрытии обращения).
async function relocateToAnswered(rec) {
  const topicId = Number(TOPIC_ANSWERED);
  if (Number.isNaN(topicId)) {
    console.error(`relocateToAnswered(${rec.id}): TOPIC_ANSWERED="${TOPIC_ANSWERED}" не число — карточка осталась на месте.`);
    return refreshCard(rec);
  }
  const kb = cardKeyboard(rec.id, 'closed');
  const text = cardText(rec);
  const thread = { message_thread_id: topicId };
  try {
    let sent;
    if (rec.isMedia) {
      sent = await bot.copyMessage(MOD_CHAT_ID, MOD_CHAT_ID, rec.modMessageId,
        { ...thread, caption: clampCaption(text), parse_mode: 'HTML', reply_markup: kb });
    } else {
      sent = await bot.sendMessage(MOD_CHAT_ID, text,
        { ...thread, parse_mode: 'HTML', reply_markup: kb });
    }
    const oldId = rec.modMessageId;
    rec.modMessageId = sent.message_id;
    store.set(rec);
    try { await bot.deleteMessage(MOD_CHAT_ID, oldId); } catch {}
    console.log(`relocateToAnswered(${rec.id}): перенесено в тему ${topicId}.`);
  } catch (e) {
    // Не удалось перенести (тема не найдена/закрыта/неверный TOPIC_ANSWERED) — логируем причину
    // и хотя бы обновляем статус карточки на месте, чтобы обращение не «зависло».
    console.error(`relocateToAnswered(${rec.id}) → тема ${topicId}:`, e.message);
    await refreshCard(rec);
  }
}

// ======================= ОЧЕРЕДЬ =======================
function queueText(rec, ahead) {
  const head = `✅ <b>Обращение принято</b>\n🆔 <code>${rec.id}</code>`;
  if (ahead <= 0) return `${head}\n\n⏳ Вы <b>первый</b> в очереди.`;
  return `${head}\n\n⏳ Перед вами в очереди: <b>${ahead}</b>`;
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
        { chat_id: rec.userId, message_id: rec.userMsgId, parse_mode: 'HTML', reply_markup: userKb(rec.id) });
      rec.lastShownPos = i;
      persist();
    } catch {
      rec.lastShownPos = i;
      persist();
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

// Периодически обновляем карточки в диалоге, чтобы «⏳ ещё N мин» / «✅ Можно обработать» были актуальны.
async function refreshDialogCards() {
  for (const rec of store.all()) {
    if (rec.state !== 'answered') continue;
    const g = canModClose(rec);
    if (g.ok && rec._gateOk !== true) { rec._gateOk = true; await refreshCard(rec); persist(); }
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
  const body = msg.text || msg.caption || '';
  const rec = {
    id: genTicket(from.id), kind: isBiz ? 'biz' : 'normal',
    userId: from.id, userMention: mention,
    isMedia: !isText,
    messages: body ? [{ from: 'user', by: mention, text: body, time: Date.now() }] : [],
    state: 'new', moderatorId: null, moderatorName: null, processingAt: null,
    modMessageId: null, userMsgId: null, lastShownPos: null,
    createdAt: Date.now(), parentId: null, _v2: true,
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
        `💎 <b>Деловое предложение принято</b>\n🆔 <code>${rec.id}</code>`,
        { parse_mode: 'HTML', reply_markup: userKb(rec.id) });
    } else {
      const ahead = store.all().filter(r =>
        r.kind !== 'biz' && (r.state === 'new' || r.state === 'processing') && r.createdAt < rec.createdAt).length;
      conf = await bot.sendMessage(from.id, queueText(rec, ahead),
        { parse_mode: 'HTML', reply_markup: userKb(rec.id) });
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

// Дополнение уже ОБРАБОТАННОГО (closed) обращения → новый тикет с контекстом.
async function createFollowupTicket(parent, text) {
  const rec = {
    id: genTicket(parent.userId), kind: parent.kind === 'biz' ? 'biz' : 'normal',
    userId: parent.userId, userMention: parent.userMention,
    isMedia: false,
    messages: [
      ...(parent.messages || []).map(m => ({ ...m, ctx: true })),
      { from: 'user', by: parent.userMention, text, time: Date.now() },
    ],
    state: 'new', moderatorId: null, moderatorName: null, processingAt: null,
    modMessageId: null, userMsgId: null, lastShownPos: null,
    createdAt: Date.now(), parentId: parent.id, _v2: true,
  };
  try {
    const kb = cardKeyboard(rec.id, 'new');
    const topic = rec.kind === 'biz' ? TOPIC_BIZ : TOPIC_NEW;
    const thread = topic ? { message_thread_id: Number(topic) } : {};
    const sent = await bot.sendMessage(MOD_CHAT_ID, cardText(rec), { parse_mode: 'HTML', reply_markup: kb, ...thread });
    rec.modMessageId = sent.message_id;
    store.set(rec);

    const conf = await bot.sendMessage(rec.userId,
      `🔁 <b>Обращение отправлено заново</b>\n🆔 <code>${rec.id}</code>\n\nПрошлая переписка сохранена как контекст.`,
      { parse_mode: 'HTML', reply_markup: userKb(rec.id) }).catch(() => null);
    if (conf) { rec.userMsgId = conf.message_id; store.set(rec); }
    return rec;
  } catch (e) { console.error('createFollowupTicket:', e.message); return null; }
}

// Ответ модератора — из мини-аппа И из реплая в группе. Обезличено; обращение НЕ закрывается.
async function applyModAnswer(rec, modUser, text) {
  rec.messages = rec.messages || [];
  rec.messages.push({ from: 'mod', by: MOD_LABEL, text, time: Date.now() });
  rec.moderatorId = modUser.id;
  rec.moderatorName = MOD_LABEL;
  rec.state = 'answered';      // диалог открыт; закрытие — только вручную
  rec.closedBy = null;         // возможное возобновление после закрытия админом
  rec._gateOk = false;
  store.set(rec);

  try {
    await bot.sendMessage(rec.userId,
      `💬 <b>Вам ответили</b>\n🆔 <code>${rec.id}</code>`,
      { parse_mode: 'HTML', reply_markup: openAppKb(rec.id) });
  } catch (e) { console.error('deliver:', e.message); }

  await refreshCard(rec);
  updateQueue().catch(() => {});
}

// Ручное закрытие/обработка обращения. by = 'user' | 'mod'.
async function closeSuggestion(rec, by) {
  rec.state = 'closed';
  rec.closedBy = by;
  rec.processingAt = null;
  store.set(rec);

  if (by === 'mod') {
    await bot.sendMessage(rec.userId,
      `✅ <b>Обращение обработано</b>\n🆔 <code>${rec.id}</code>\n\nСпасибо! Появится вопрос — просто напишите.`,
      { parse_mode: 'HTML', reply_markup: openAppKb(rec.id) }).catch(() => {});
  }

  if (rec.kind !== 'biz' && TOPIC_ANSWERED) {
    await relocateToAnswered(rec);
  } else {
    if (rec.kind !== 'biz' && !TOPIC_ANSWERED) {
      console.warn(`closeSuggestion(${rec.id}): TOPIC_ANSWERED не задан — карточка осталась на месте.`);
    }
    await refreshCard(rec);
  }
  updateQueue().catch(() => {});
}

async function rejectSuggestion(sid) {
  const rec = store.get(sid);
  if (!rec) return false;
  try { await bot.deleteMessage(MOD_CHAT_ID, rec.modMessageId); } catch (e) { console.error('reject del:', e.message); }

  const wasAnswered = realMsgs(rec).some(m => m.from === 'mod');
  // Уведомляем подписчика ВСЕГДА. Блокировку на 15 минут вешаем только если ответа ещё не было.
  if (!wasAnswered) muteUser(rec.userId);
  const note = wasAnswered
    ? `🚫 <b>Обращение отклонено администрацией</b>\n🆔 <code>${rec.id}</code>`
    : '🚫 <b>Обращение отклонено</b>\n\n⏳ Новое можно отправить через 15 минут.';
  try {
    await bot.sendMessage(rec.userId, note, { parse_mode: 'HTML', reply_markup: HOME_KB });
  } catch (e) { console.error('reject notify:', e.message); }

  store.del(sid);
  updateQueue().catch(() => {});
  return true;
}

async function cancelSuggestion(sid, q) {
  const rec = store.get(sid);
  if (!rec || rec.userId !== q.from.id) {
    await bot.answerCallbackQuery(q.id, { text: 'Обращение недоступно' }); return;
  }
  // Отменить (удалить) можно только пока нет ответа админа.
  if (realMsgs(rec).some(m => m.from === 'mod') || rec.state === 'closed') {
    await bot.answerCallbackQuery(q.id, { text: 'Есть ответ — используйте «Завершить» в приложении' }); return;
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

// Ответ модератора реплаем на карточку в группе.
async function handleModGroupReply(msg) {
  const replyTo = msg.reply_to_message;
  if (!replyTo || msg.from.is_bot) return;
  const body = (msg.text || msg.caption || '').trim();
  if (!body || body.startsWith('/')) return;

  const rec = store.all().find(r => r.modMessageId === replyTo.message_id);
  if (!rec) return;                                          // реплай не на карточку — игнор
  // Закрытое пользователем — трогать нельзя. Закрытое админом — можно возобновить реплаем.
  if (rec.state === 'closed' && rec.closedBy === 'user') return;
  if (!(await isModerator(msg.from.id))) return;

  await applyModAnswer(rec, msg.from, body).catch(e => console.error('groupReply:', e.message));
  try { await bot.deleteMessage(MOD_CHAT_ID, msg.message_id); } catch {}
}

// ======================= ХЭНДЛЕРЫ =======================
bot.onText(/^\/start/, async (msg) => {
  if (msg.chat.type !== 'private') return;
  await bot.sendMessage(msg.chat.id, GREETING, { parse_mode: 'HTML' });
});

bot.on('message', async (msg) => {
  // ---- Группа модерации ----
  if (String(msg.chat.id) === MOD_CHAT_ID) {
    if (msg.text && /^\/(id|topic)\b/.test(msg.text)) {
      await bot.sendMessage(MOD_CHAT_ID,
        `chat_id: <code>${msg.chat.id}</code>\nmessage_thread_id: <code>${msg.message_thread_id || '(General / нет темы)'}</code>`,
        { parse_mode: 'HTML', message_thread_id: msg.message_thread_id });
      return;
    }
    await handleModGroupReply(msg).catch(e => console.error('handleModGroupReply:', e.message));
    return;
  }

  if (msg.chat.type !== 'private') return;
  if (msg.text && msg.text.startsWith('/')) return;

  const muteLeft = mutedFor(msg.from.id);
  if (muteLeft > 0) {
    const mins = Math.ceil(muteLeft / 60000);
    await bot.sendMessage(msg.from.id,
      `⛔ <b>Отправка заблокирована.</b>\nПопробуйте через ~${mins} мин.`,
      { parse_mode: 'HTML', reply_markup: HOME_KB }).catch(() => {});
    return;
  }

  // Одно активное обращение (всё, что не 'closed'): продолжать переписку нужно в приложении.
  const existing = store.all().find(r => String(r.userId) === String(msg.from.id) && r.state !== 'closed');
  if (existing) {
    const kb = (existing.state === 'new' || existing.state === 'processing')
      ? userKb(existing.id) : openAppKb(existing.id);
    await bot.sendMessage(msg.from.id,
      `⏳ <b>У вас уже есть активное обращение</b>\n🆔 <code>${existing.id}</code>`,
      { parse_mode: 'HTML', reply_markup: kb }).catch(() => {});
    return;
  }

  const textForAI = (msg.text || msg.caption || '').trim();

  const spamReason = recordAndCheckSpam(msg.from.id, textForAI);
  if (spamReason) {
    muteUser(msg.from.id);
    const spamText = spamReason === 'flood'
      ? '⚠️ <b>Слишком много сообщений подряд.</b>\n\nОтправка заблокирована на <b>15 минут</b>.'
      : '⚠️ <b>Повторяющееся сообщение.</b>\n\nОтправка заблокирована на <b>15 минут</b>.';
    await bot.sendMessage(msg.from.id, spamText, { parse_mode: 'HTML', reply_markup: HOME_KB }).catch(() => {});
    console.log(`spam(${spamReason}): user ${msg.from.id} muted`);
    return;
  }

  if (!textForAI) {
    await createSuggestion(msg, 'normal').catch(e => console.error('createSuggestion:', e.message));
    return;
  }

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
  const sid = data.includes(':') ? data.split(':')[1] : '';
  try {
    if (data === 'home') {
      // Убираем сообщение с кнопкой, чтобы в истории не плодились дубли «Меню».
      try {
        await bot.deleteMessage(q.message.chat.id, q.message.message_id);
      } catch {
        // Старше 48 ч удалить нельзя — тогда просто снимаем клавиатуру, чтобы кнопка не висела.
        try {
          await bot.editMessageReplyMarkup({ inline_keyboard: [] },
            { chat_id: q.message.chat.id, message_id: q.message.message_id });
        } catch {}
      }
      await bot.answerCallbackQuery(q.id);

    } else if (data.startsWith('cancel:')) {
      await cancelSuggestion(sid, q);

    } else if (data.startsWith('reject:')) {
      if (!(await isModerator(q.from.id))) {
        await bot.answerCallbackQuery(q.id, { text: 'Доступно только модераторам' }); return;
      }
      const ok = await rejectSuggestion(sid);
      await bot.answerCallbackQuery(q.id, { text: ok ? 'Отклонено и удалено 🚫' : 'Уже обработано' });

    } else if (data.startsWith('close:')) {
      if (!(await isModerator(q.from.id))) {
        await bot.answerCallbackQuery(q.id, { text: 'Доступно только модераторам' }); return;
      }
      const rec = store.get(sid);
      if (!rec || rec.state === 'closed') { await bot.answerCallbackQuery(q.id, { text: 'Уже обработано' }); return; }
      const gate = canModClose(rec);
      if (!gate.ok) { await bot.answerCallbackQuery(q.id, { text: gate.reason, show_alert: true }); return; }
      await closeSuggestion(rec, 'mod');
      await bot.answerCallbackQuery(q.id, { text: 'Обработано ✅' });

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

function authUser(req, res) {
  const user = checkInitData((req.body && req.body.initData) || '');
  if (!user || !user.id) { res.status(403).json({ error: 'Некорректная подпись' }); return null; }
  return user;
}

async function roleFor(rec, user) {
  if (rec && String(rec.userId) === String(user.id)) return 'user';
  if (await isModerator(user.id)) return 'mod';
  return null;
}

function viewFor(rec, role, user) {
  const modGate = role === 'mod' ? canModClose(rec) : { ok: true, reason: '' };
  const closedByUser = rec.state === 'closed' && rec.closedBy === 'user';
  // Админ может писать всегда, кроме случая, когда обращение закрыл сам пользователь.
  const modCanReply = role === 'mod' && !closedByUser;
  return {
    id: rec.id,
    kind: rec.kind,
    role,
    userMention: rec.userMention,
    userId: rec.userId,
    state: rec.state,
    parentId: rec.parentId || null,
    moderatorName: rec.moderatorName || null,
    messages: realMsgsAndCtx(rec),
    locked: role === 'mod' && rec.moderatorId &&
            String(rec.moderatorId) !== String(user.id) && rec.state !== 'closed' && rec.state !== 'answered',
    closed: rec.state === 'closed',
    closedBy: rec.closedBy || null,
    closable: rec.state === 'answered',          // «Завершить/Обработать» доступно в диалоге
    modCanReply,                                 // мини-апп: показывать ли админу поле ввода
    closeEnabled: role === 'user' ? true : modGate.ok,
    closeHint: role === 'mod' ? modGate.reason : '',
  };
}
function realMsgsAndCtx(rec) {
  return (rec.messages || []).map(m => ({ from: m.from, by: m.by, text: m.text, time: m.time, ctx: !!m.ctx }));
}

// ======================= API МИНИ-ПРИЛОЖЕНИЯ =======================
app.post('/api/open', async (req, res) => {
  const user = authUser(req, res); if (!user) return;
  const rec = store.get(req.body.sid);
  if (!rec) return res.status(404).json({ error: 'Обращение не найдено или уже закрыто' });

  const role = await roleFor(rec, user);
  if (!role) return res.status(403).json({ error: 'Нет доступа к этому обращению' });

  if (role === 'mod') {
    if (rec.state === 'new') {
      rec.state = 'processing';
      rec.moderatorId = user.id;
      rec.moderatorName = MOD_LABEL;
      rec.processingAt = Date.now();
      store.set(rec);
      await refreshCard(rec);
    } else if (rec.state === 'processing' && String(rec.moderatorId) === String(user.id)) {
      rec.processingAt = Date.now();
      store.set(rec);
    }
  }

  res.json(viewFor(rec, role, user));
});

app.post('/api/send', async (req, res) => {
  const user = authUser(req, res); if (!user) return;
  const rec = store.get(req.body.sid);
  if (!rec) return res.status(404).json({ error: 'Обращение не найдено или уже закрыто' });

  const role = await roleFor(rec, user);
  if (!role) return res.status(403).json({ error: 'Нет доступа к этому обращению' });

  const text = String(req.body.text || '').trim();
  if (!text) return res.status(400).json({ error: 'Пустое сообщение' });
  if (text.length > 3500) return res.status(400).json({ error: 'Слишком длинное сообщение' });

  // ---- Модератор ----
  if (role === 'mod') {
    if (rec.state === 'closed') {
      // Закрыл пользователь → админ писать не может. Закрыл админ → можно возобновить диалог.
      if (rec.closedBy === 'user') {
        return res.status(409).json({ error: 'Пользователь завершил обращение — писать больше нельзя.' });
      }
    } else if (rec.moderatorId && String(rec.moderatorId) !== String(user.id) && rec.state !== 'answered') {
      return res.status(409).json({ error: 'Обращение уже обрабатывает другой модератор' });
    }
    await applyModAnswer(rec, user, text);
    return res.json(viewFor(rec, 'mod', user));
  }

  // ---- Подписчик ----
  const muteLeft = mutedFor(user.id);
  if (muteLeft > 0) {
    return res.status(403).json({ error: `Отправка заблокирована. Попробуйте через ~${Math.ceil(muteLeft / 60000)} мин.` });
  }

  // Обработанное (closed) → новое обращение с контекстом.
  if (rec.state === 'closed') {
    const active = store.all().find(r => String(r.userId) === String(user.id) && r.state !== 'closed');
    if (active) {
      active.messages = active.messages || [];
      active.messages.push({ from: 'user', by: active.userMention, text, time: Date.now() });
      store.set(active);
      await refreshCard(active);
      return res.json({ ...viewFor(active, 'user', user), switchTo: active.id });
    }
    const child = await createFollowupTicket(rec, text);
    if (!child) return res.status(500).json({ error: 'Не удалось создать обращение' });
    return res.json({ ...viewFor(child, 'user', user), switchTo: child.id });
  }

  // Живой диалог (new/processing/answered) — дополняем ленту.
  rec.messages = rec.messages || [];
  rec.messages.push({ from: 'user', by: rec.userMention, text, time: Date.now() });
  if (rec.state === 'answered') rec._gateOk = false;
  store.set(rec);
  await refreshCard(rec);
  res.json(viewFor(rec, 'user', user));
});

app.post('/api/close', async (req, res) => {
  const user = authUser(req, res); if (!user) return;
  const rec = store.get(req.body.sid);
  if (!rec) return res.status(404).json({ error: 'Обращение не найдено' });

  const role = await roleFor(rec, user);
  if (!role) return res.status(403).json({ error: 'Нет доступа к этому обращению' });

  if (rec.state === 'closed') return res.json({ ...viewFor(rec, role, user), ok: true });

  if (role === 'mod') {
    const gate = canModClose(rec);
    if (!gate.ok) return res.status(409).json({ error: gate.reason });
    await closeSuggestion(rec, 'mod');
  } else {
    // Подписчик закрывает своё обращение вручную в любой момент.
    await closeSuggestion(rec, 'user');
  }
  res.json({ ...viewFor(rec, role, user), ok: true });
});

app.post('/api/reject', async (req, res) => {
  const user = authUser(req, res); if (!user) return;
  if (!(await isModerator(user.id))) return res.status(403).json({ error: 'Вы не модератор' });
  await rejectSuggestion(req.body.sid);
  res.json({ ok: true });
});

// ======================= WEBHOOK И ЗАПУСК =======================
app.get('/', (req, res) => res.status(200).send('Suggestion bot is running'));

app.post(`/bot${TOKEN}`, (req, res) => {
  try { bot.processUpdate(req.body); } catch (e) { console.error('webhook:', e.message); }
  res.sendStatus(200);
});

// Корректное завершение: досбрасываем буфер классификации и синхронно пишем БД на диск.
// Иначе отложенная на 200 мс запись (persist) теряется при мгновенном process.exit.
async function gracefulShutdown(signal) {
  console.log(`${signal}: сбрасываю буфер перед завершением...`);
  if (batchItems.length) {
    await flushBatch().catch(e => console.error(`flushBatch on ${signal}:`, e.message));
  }
  persistNow();
  process.exit(0);
}
process.on('SIGTERM', () => gracefulShutdown('SIGTERM'));
process.on('SIGINT',  () => gracefulShutdown('SIGINT'));

app.listen(PORT, '0.0.0.0', async () => {
  console.log(`Сервер запущен на порту ${PORT}`);
  try {
    const me = await bot.getMe();
    console.log(`Бот: @${me.username}`);
    if (me.username.toLowerCase() !== BOT_USERNAME.toLowerCase()) {
      console.warn(`⚠️ BOT_USERNAME (${BOT_USERNAME}) не совпадает с реальным (@${me.username})`);
    }
  } catch (e) { console.error('getMe:', e.message); }

  const pendingCount = store.all().filter(r => r.state !== 'closed').length;
  if (pendingCount) console.log(`ℹ️ Активных при старте: ${pendingCount} обращений`);

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
    refreshDialogCards().catch(e => console.error('refreshDialogCards:', e.message));
    purgeExpiredMutes();
  }, 60000);
});
