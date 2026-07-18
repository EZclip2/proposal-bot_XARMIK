import asyncio
import logging
import os
import sys
import json
import re
import hashlib
from aiohttp import web
from telegram import (
    Update,
    BotCommand,
    BotCommandScopeChat,
    InlineKeyboardButton,
    InlineKeyboardMarkup,
    ReplyKeyboardMarkup,
    ReplyKeyboardRemove,
    KeyboardButton,
    WebAppInfo,
    InputMediaPhoto,
    InputMediaVideo,
    InputMediaAnimation,
    InputMediaDocument,
    InputMediaAudio,
)
from telegram.ext import (
    Application,
    MessageHandler,
    CommandHandler,
    CallbackQueryHandler,
    ConversationHandler,
    filters,
    ContextTypes,
)
from telegram.constants import ChatType, ParseMode

BOT_TOKEN = os.getenv("TELEGRAM_BOT_TOKEN")
ALLOWED_CHAT_ID_ENV = os.getenv("ALLOWED_CHAT_ID")          # группа, куда репостятся посты из канала
PHOTO_PATH_OR_URL = os.getenv("PHOTO_PATH_OR_URL")
TIKTOK = os.getenv("TIKTOK_WEBSITE")
YOUTUBE = os.getenv("YOUTUBE_WEBSITE")
TWITCH = os.getenv("TWITCH_WEBSITE")
# rstrip("/") — чтобы случайный слэш в конце переменной не сломал вебхук двойным //
RENDER_EXTERNAL_URL = (os.getenv("RENDER_EXTERNAL_URL") or "").rstrip("/") or None

# --- Переменные для функции "красивые посты в канал" ---
ADMIN_USER_ID_ENV = os.getenv("ADMIN_USER_ID")               # ID пользователя, которому разрешено создавать посты
POST_CHANNEL_ID_ENV = os.getenv("POST_CHANNEL_ID")           # ID канала, куда публикуются посты с клавиатурой

STATIC_MESSAGE = "<b>Вот, кстати, его соц-сети! 🤵👇</b>\n\n<code>Подписывайтесь!!! 🤠</code>"

BUTTONS_CONFIG = []
if TIKTOK: BUTTONS_CONFIG.append(("🎵 TikTok", TIKTOK))
if YOUTUBE: BUTTONS_CONFIG.append(("🎥 YouTube", YOUTUBE))
if TWITCH: BUTTONS_CONFIG.append(("📷 Twitch", TWITCH))

logging.basicConfig(
    format='%(asctime)s - %(name)s - %(levelname)s - %(message)s',
    level=logging.INFO,
    handlers=[logging.StreamHandler(sys.stdout)]
)
logger = logging.getLogger(__name__)

application: Application = None  # инициализируется в main()

# Секрет для вебхука: используется и как путь эндпоинта, и как secret_token у Telegram,
# чтобы токен бота не светился в URL и чужие не могли слать боту фейковые апдейты.
# Вычисляется в main() (когда точно известен BOT_TOKEN).
WEBHOOK_SECRET: str = ""

# ============================================================
#  ФУНКЦИЯ 1: авто-репост поста канала в группу
# ============================================================

async def handle_channel_post_in_group(update: Update, context: ContextTypes.DEFAULT_TYPE) -> None:
    if update.edited_message or update.edited_channel_post:
        return

    message = update.effective_message
    if not message:
        return

    if ALLOWED_CHAT_ID_ENV:
        try:
            allowed_chat_id = int(ALLOWED_CHAT_ID_ENV)
            if message.chat.id != allowed_chat_id:
                logger.debug(f"Сообщение проигнорировано: ID чата {message.chat.id} не совпадает.")
                return
        except (TypeError, ValueError):
            logger.error("ОШИБКА: Неверный формат ALLOWED_CHAT_ID!")
            return

    if message.sender_chat and message.sender_chat.type == ChatType.CHANNEL:
        keyboard = []
        row = []
        for text, url in BUTTONS_CONFIG:
            if url:
                row.append(InlineKeyboardButton(text, url=url))
                if len(row) == 2:
                    keyboard.append(row)
                    row = []
        if row:
            keyboard.append(row)

        reply_markup = InlineKeyboardMarkup(keyboard) if keyboard else None

        try:
            if PHOTO_PATH_OR_URL:
                await message.reply_photo(
                    photo=PHOTO_PATH_OR_URL,
                    caption=STATIC_MESSAGE,
                    reply_markup=reply_markup,
                    parse_mode="HTML"
                )
                logger.info(f"Отправлено фото-сообщение в ответ на пост {message.message_id}")
            else:
                await message.reply_text(
                    text=STATIC_MESSAGE,
                    reply_markup=reply_markup,
                    parse_mode="HTML"
                )
                logger.info(f"Отправлено текстовое сообщение в ответ на пост {message.message_id}")
        except Exception as e:
            logger.error(f"Ошибка при отправке ответа: {e}")


# ============================================================
#  ФУНКЦИЯ 2: создание постов с кастомной клавиатурой через
#  Telegram Mini App. Работает только в личке с ботом и только
#  для ADMIN_USER_ID.
#
#  Поддерживаемый контент поста: текст, фото, видео, видео-кружки,
#  GIF-анимации, документы, аудио и голосовые сообщения — с подписью
#  или без, а также альбомы (несколько фото/видео/документов/аудио,
#  отправленных одним "пакетом", как обычный Telegram-альбом).
# ============================================================

WAITING_CONTENT, WAITING_KEYBOARD, WAITING_CONFIRM = range(3)

URL_RE = re.compile(r"^(https?://|tg://)\S+$", re.IGNORECASE)

BASE_DIR = os.path.dirname(os.path.abspath(__file__))
MINIAPP_HTML_PATH = os.path.join(BASE_DIR, "miniapp.html")

# Сколько секунд ждать после очередной части альбома, прежде чем считать,
# что все части пришли, и двигаться дальше по сценарию.
ALBUM_DEBOUNCE_SECONDS = 1.0

# Временное хранилище частей альбомов, которые ещё собираются.
# Ключ: (user_id, media_group_id) -> {"items": [...], "caption_html": str, "generation": int}
pending_albums: dict = {}

# Какой метод бота и какое имя параметра использовать для отправки каждого типа медиа.
MEDIA_SEND_INFO = {
    "photo": ("send_photo", "photo"),
    "video": ("send_video", "video"),
    "video_note": ("send_video_note", "video_note"),
    "animation": ("send_animation", "animation"),
    "document": ("send_document", "document"),
    "audio": ("send_audio", "audio"),
    "voice": ("send_voice", "voice"),
}

# Типы, которые Telegram не даёт снабдить подписью (caption) при отправке.
NO_CAPTION_TYPES = {"video_note", "voice"}


def _load_miniapp_html() -> str:
    try:
        with open(MINIAPP_HTML_PATH, "r", encoding="utf-8") as f:
            return f.read()
    except FileNotFoundError:
        logger.error("Файл miniapp.html не найден рядом с main.py!")
        return "<h1>miniapp.html не найден на сервере</h1>"


MINIAPP_HTML = _load_miniapp_html()


def _get_admin_id():
    try:
        return int(ADMIN_USER_ID_ENV) if ADMIN_USER_ID_ENV else None
    except (TypeError, ValueError):
        logger.error("ОШИБКА: Неверный формат ADMIN_USER_ID!")
        return None


def _get_post_channel_id():
    try:
        return int(POST_CHANNEL_ID_ENV) if POST_CHANNEL_ID_ENV else None
    except (TypeError, ValueError):
        logger.error("ОШИБКА: Неверный формат POST_CHANNEL_ID!")
        return None


def _get_miniapp_url():
    if not RENDER_EXTERNAL_URL:
        return None
    return f"{RENDER_EXTERNAL_URL}/miniapp"


def _miniapp_reply_keyboard():
    """ReplyKeyboard с кнопкой открытия конструктора (или None, если мини-апп недоступен)."""
    miniapp_url = _get_miniapp_url()
    if not miniapp_url:
        return None
    return ReplyKeyboardMarkup(
        [[KeyboardButton("⚙️ Настроить кнопки поста", web_app=WebAppInfo(url=miniapp_url))]],
        resize_keyboard=True,
        one_time_keyboard=True,
    )


def parse_keyboard_text(text: str):
    """
    Запасной текстовый формат (на случай если мини-приложение недоступно):

        Текст кнопки - ссылка | Текст кнопки 2 - ссылка 2
        Текст кнопки 3 - ссылка 3

    Каждая строка = отдельный ряд. Кнопки внутри ряда разделяются "|".
    """
    rows = []
    for raw_line in text.strip().splitlines():
        line = raw_line.strip()
        if not line:
            continue
        row = []
        for raw_btn in line.split("|"):
            btn = raw_btn.strip()
            if not btn:
                continue
            if " - " not in btn:
                raise ValueError(f"Не могу разобрать кнопку: «{btn}». Нужен формат «Текст - Ссылка».")
            label, url = btn.split(" - ", 1)
            label = label.strip()
            url = url.strip()
            if not label or not url:
                raise ValueError(f"Пустой текст или ссылка в кнопке: «{btn}».")
            if not URL_RE.match(url):
                raise ValueError(f"Некорректная ссылка: «{url}». Ссылка должна начинаться с http:// или https://")
            row.append(InlineKeyboardButton(label, url=url))
        if row:
            rows.append(row)
    if not rows:
        raise ValueError("Не найдено ни одной кнопки.")
    return rows


def parse_keyboard_webapp_json(raw: str):
    """Разбирает JSON, присланный мини-приложением через Telegram.WebApp.sendData()."""
    payload = json.loads(raw)
    rows_data = payload.get("rows", [])
    rows = []
    for row_data in rows_data:
        row = []
        for btn in row_data:
            label = (btn.get("text") or "").strip()
            url = (btn.get("url") or "").strip()
            if not label or not url:
                continue
            if not URL_RE.match(url):
                raise ValueError(f"Некорректная ссылка: «{url}»")
            row.append(InlineKeyboardButton(label, url=url))
        if row:
            rows.append(row)
    if not rows:
        raise ValueError("Клавиатура пустая — добавьте хотя бы одну кнопку.")
    return rows


# ------------------------------------------------------------
#  Вспомогательные функции для работы с контентом поста
# ------------------------------------------------------------

def _extract_media(message):
    """Возвращает (тип_медиа, file_id) для поддерживаемых типов, иначе (None, None)."""
    if message.photo:
        return "photo", message.photo[-1].file_id
    if message.video:
        return "video", message.video.file_id
    if message.video_note:
        return "video_note", message.video_note.file_id
    if message.animation:
        return "animation", message.animation.file_id
    if message.document:
        return "document", message.document.file_id
    if message.audio:
        return "audio", message.audio.file_id
    if message.voice:
        return "voice", message.voice.file_id
    return None, None


def _build_input_media(item: dict, caption: str = None):
    """Строит InputMedia* для отправки альбома через send_media_group."""
    media_type = item["type"]
    file_id = item["file_id"]
    extra = {}
    if caption:
        extra["caption"] = caption
        extra["parse_mode"] = ParseMode.HTML

    if media_type == "photo":
        return InputMediaPhoto(media=file_id, **extra)
    if media_type == "video":
        return InputMediaVideo(media=file_id, **extra)
    if media_type == "animation":
        return InputMediaAnimation(media=file_id, **extra)
    if media_type == "document":
        return InputMediaDocument(media=file_id, **extra)
    if media_type == "audio":
        return InputMediaAudio(media=file_id, **extra)
    raise ValueError(
        f"Тип «{media_type}» нельзя объединить в альбом "
        f"(Telegram группирует только фото/видео, только документы или только аудио)."
    )


async def _send_single_media(bot, chat_id, item: dict, text: str, reply_markup=None):
    method_name, param_name = MEDIA_SEND_INFO[item["type"]]
    method = getattr(bot, method_name)

    # Видео-кружки и голосовые Telegram не позволяет снабдить подписью —
    # отправляем медиа с клавиатурой, а текст (если есть) отдельным сообщением.
    if item["type"] in NO_CAPTION_TYPES:
        sent = await method(
            chat_id=chat_id,
            **{param_name: item["file_id"]},
            reply_markup=reply_markup,
        )
        if text:
            await bot.send_message(chat_id=chat_id, text=text, parse_mode=ParseMode.HTML)
        return sent

    return await method(
        chat_id=chat_id,
        **{param_name: item["file_id"]},
        caption=text or None,
        parse_mode=ParseMode.HTML if text else None,
        reply_markup=reply_markup,
    )


async def _send_content(bot, chat_id, content_items: list, text: str, reply_markup=None,
                        followup_label: str = "👇 Кнопки к посту:"):
    """
    Единая точка отправки поста (используется и для превью, и для реальной публикации).

    - Нет медиа -> обычное текстовое сообщение.
    - Одно медиа -> одно сообщение с подписью и клавиатурой.
    - Несколько медиа (альбом) -> send_media_group + (если есть клавиатура)
      отдельное сообщение с кнопками сразу после, т.к. Telegram не позволяет
      прикреплять inline-клавиатуру к альбомам.
    """
    if not content_items:
        return await bot.send_message(
            chat_id=chat_id,
            text=text or "⁣",
            parse_mode=ParseMode.HTML if text else None,
            reply_markup=reply_markup,
        )

    if len(content_items) == 1:
        return await _send_single_media(bot, chat_id, content_items[0], text, reply_markup)

    media_list = [
        _build_input_media(item, text if (idx == 0 and text) else None)
        for idx, item in enumerate(content_items)
    ]
    sent = await bot.send_media_group(chat_id=chat_id, media=media_list)
    if reply_markup is not None:
        await bot.send_message(chat_id=chat_id, text=followup_label, reply_markup=reply_markup)
    return sent


async def _prompt_for_keyboard(update: Update, context: ContextTypes.DEFAULT_TYPE) -> int:
    """Показывает шаг настройки кнопок (после того как контент поста определён)."""
    message = update.effective_message
    keyboard = _miniapp_reply_keyboard()
    if keyboard:
        await message.reply_text(
            "⌨️ Нажмите кнопку ниже, чтобы открыть конструктор — там вы задаёте, сколько "
            "кнопок в каждом ряду, их названия и ссылки.\n\n"
            "Если кнопки не нужны — отправьте /skip",
            reply_markup=keyboard,
        )
    else:
        await message.reply_text(
            "⌨️ Пришлите кнопки в формате:\n\n"
            "<code>Текст кнопки - ссылка | Текст кнопки 2 - ссылка 2\n"
            "Текст кнопки 3 - ссылка 3</code>\n\n"
            "Каждая новая строка — новый ряд. Кнопки в одном ряду разделяйте «|».\n"
            "Если кнопки не нужны — отправьте /skip",
            parse_mode="HTML",
        )
    return WAITING_KEYBOARD


async def _handle_album_part(update: Update, context: ContextTypes.DEFAULT_TYPE, message):
    """
    Собирает части альбома (несколько сообщений с одним media_group_id).
    Каждая часть "ждёт" ALBUM_DEBOUNCE_SECONDS — если за это время не пришла
    ещё одна часть, значит альбом полностью получен, и можно двигаться дальше.
    Требует concurrent_updates=True у Application (см. main()).

    Возвращает WAITING_KEYBOARD только у "последней" части (которая завершает сбор).
    У остальных частей возвращает None — это значит "не менять состояние диалога",
    чтобы промежуточные части не сбрасывали диалог обратно в WAITING_CONTENT.
    """
    media_type, file_id = _extract_media(message)

    key = (update.effective_user.id, message.media_group_id)
    entry = pending_albums.setdefault(key, {"items": [], "caption_html": "", "generation": 0})
    if media_type:
        entry["items"].append({"type": media_type, "file_id": file_id, "message_id": message.message_id})
    if message.caption:
        entry["caption_html"] = message.caption_html
    entry["generation"] += 1
    my_generation = entry["generation"]

    await asyncio.sleep(ALBUM_DEBOUNCE_SECONDS)

    entry = pending_albums.get(key)
    if entry is None or entry["generation"] != my_generation:
        # Пока мы ждали, пришла ещё одна часть альбома — её обработчик и завершит сбор.
        # Возвращаем None, чтобы НЕ сбрасывать состояние диалога.
        return None

    del pending_albums[key]
    items = sorted(entry["items"], key=lambda it: it["message_id"])

    if not items:
        # Весь альбом оказался из неподдерживаемых типов — не молчим, а подсказываем.
        await message.reply_text(
            "🤔 В этом альбоме не оказалось поддерживаемого контента. "
            "Пришлите фото, видео, документы или аудио — или /cancel для отмены."
        )
        return WAITING_CONTENT

    context.user_data["content_items"] = items
    context.user_data["text"] = entry["caption_html"]

    return await _prompt_for_keyboard(update, context)


# ------------------------------------------------------------
#  Шаги сценария /start (создание постов)
# ------------------------------------------------------------

async def newpost_start(update: Update, context: ContextTypes.DEFAULT_TYPE) -> int:
    admin_id = _get_admin_id()
    if not admin_id or update.effective_user.id != admin_id:
        # Молча игнорируем всех, кроме назначенного администратора
        return ConversationHandler.END

    if not _get_post_channel_id():
        await update.message.reply_text(
            "❗️ Переменная POST_CHANNEL_ID не настроена на хостинге. "
            "Добавьте её и перезапустите бота."
        )
        return ConversationHandler.END

    context.user_data.clear()
    await update.message.reply_text(
        "📝 Пришлите содержимое поста: текст, фото, видео, video_note (кружок), GIF, документ, "
        "аудио или голосовое сообщение — с подписью или без.\n\n"
        "Можно прислать и альбом (несколько фото/видео/документов/аудио одним "
        "пакетом, как обычно в Telegram) — бот дождётся всех частей.\n\n"
        "Для отмены в любой момент отправьте /cancel"
    )
    return WAITING_CONTENT


async def newpost_receive_content(update: Update, context: ContextTypes.DEFAULT_TYPE):
    message = update.effective_message

    if message.media_group_id:
        return await _handle_album_part(update, context, message)

    media_type, file_id = _extract_media(message)

    if media_type:
        context.user_data["content_items"] = [{"type": media_type, "file_id": file_id}]
        context.user_data["text"] = message.caption_html if message.caption else ""
    elif message.text:
        context.user_data["content_items"] = []
        context.user_data["text"] = message.text_html or message.text
    else:
        await message.reply_text(
            "Пришлите, пожалуйста, текст, фото, видео, видео-кружок, GIF, документ, аудио или "
            "голосовое сообщение (можно с подписью, можно без)."
        )
        return WAITING_CONTENT

    return await _prompt_for_keyboard(update, context)


async def newpost_receive_webapp_data(update: Update, context: ContextTypes.DEFAULT_TYPE) -> int:
    message = update.effective_message
    raw = message.web_app_data.data
    try:
        rows = parse_keyboard_webapp_json(raw)
    except (json.JSONDecodeError, ValueError) as e:
        await message.reply_text(
            f"⚠️ Не удалось обработать клавиатуру: {e}\nОткройте конструктор ещё раз.",
            reply_markup=ReplyKeyboardRemove(),
        )
        keyboard = _miniapp_reply_keyboard()
        if keyboard:
            await message.reply_text("Попробуйте ещё раз:", reply_markup=keyboard)
        return WAITING_KEYBOARD

    context.user_data["keyboard_rows"] = rows
    await message.reply_text("Клавиатура получена ✅", reply_markup=ReplyKeyboardRemove())
    return await newpost_show_preview(update, context)


async def newpost_receive_keyboard_text(update: Update, context: ContextTypes.DEFAULT_TYPE) -> int:
    """Запасной путь: админ прислал клавиатуру текстом вместо мини-приложения."""
    message = update.effective_message
    try:
        rows = parse_keyboard_text(message.text or "")
    except ValueError as e:
        await message.reply_text(
            f"⚠️ {e}\n\nПопробуйте ещё раз, откройте конструктор кнопкой выше, либо отправьте /skip."
        )
        return WAITING_KEYBOARD

    context.user_data["keyboard_rows"] = rows
    await message.reply_text("Клавиатура получена ✅", reply_markup=ReplyKeyboardRemove())
    return await newpost_show_preview(update, context)


async def newpost_skip_keyboard(update: Update, context: ContextTypes.DEFAULT_TYPE) -> int:
    context.user_data["keyboard_rows"] = None
    await update.message.reply_text("Ок, без кнопок.", reply_markup=ReplyKeyboardRemove())
    return await newpost_show_preview(update, context)


async def newpost_show_preview(update: Update, context: ContextTypes.DEFAULT_TYPE) -> int:
    message = update.effective_message
    rows = context.user_data.get("keyboard_rows")
    preview_rows = [row[:] for row in rows] if rows else []
    # Панель управления превью: помимо публикации/отмены — «переделать кнопки» и «начать заново».
    preview_rows.append([
        InlineKeyboardButton("✅ Опубликовать", callback_data="newpost_confirm"),
    ])
    preview_rows.append([
        InlineKeyboardButton("✏️ Изменить кнопки", callback_data="newpost_editkb"),
        InlineKeyboardButton("🔄 Заново", callback_data="newpost_restart"),
    ])
    preview_rows.append([
        InlineKeyboardButton("❌ Отмена", callback_data="newpost_cancel"),
    ])
    reply_markup = InlineKeyboardMarkup(preview_rows)

    content_items = context.user_data.get("content_items") or []
    text = context.user_data.get("text", "")

    note = "Вот как будет выглядеть пост 👇"
    if len(content_items) > 1:
        note += (
            "\n\nЭто альбом — Telegram не даёт прикрепить кнопки прямо к альбому, поэтому кнопки "
            "«Опубликовать/Отмена» (и ваши кнопки-ссылки, если есть) придут отдельным сообщением "
            "сразу под ним. В канале при публикации будет так же."
        )
    await message.reply_text(note)

    try:
        await _send_content(
            context.bot,
            message.chat.id,
            content_items,
            text,
            reply_markup=reply_markup,
            followup_label="👇 Подтвердите публикацию:",
        )
    except Exception as e:
        logger.error(f"Ошибка при показе превью поста: {e}")
        await message.reply_text(f"❌ Не получилось показать превью: {e}")
        context.user_data.clear()
        return ConversationHandler.END

    return WAITING_CONFIRM


async def newpost_confirm(update: Update, context: ContextTypes.DEFAULT_TYPE) -> int:
    query = update.callback_query
    await query.answer()

    channel_id = _get_post_channel_id()
    content_items = context.user_data.get("content_items") or []
    text = context.user_data.get("text", "")
    rows = context.user_data.get("keyboard_rows")
    reply_markup = InlineKeyboardMarkup(rows) if rows else None

    try:
        await _send_content(
            context.bot,
            channel_id,
            content_items,
            text,
            reply_markup=reply_markup,
            followup_label="👇",
        )
        await query.edit_message_reply_markup(reply_markup=None)
        await query.message.reply_text("✅ Пост опубликован в канал!\n\nЧтобы создать ещё один — /start")
        logger.info(f"Пост опубликован в канал {channel_id} пользователем {update.effective_user.id}")
    except Exception as e:
        logger.error(f"Ошибка при публикации поста: {e}")
        await query.message.reply_text(f"❌ Не удалось опубликовать пост: {e}")

    context.user_data.clear()
    return ConversationHandler.END


async def newpost_editkb(update: Update, context: ContextTypes.DEFAULT_TYPE) -> int:
    """Из превью вернуться к настройке кнопок, сохранив уже введённый контент."""
    query = update.callback_query
    await query.answer("Меняем кнопки")
    try:
        await query.edit_message_reply_markup(reply_markup=None)
    except Exception:
        pass
    return await _prompt_for_keyboard(update, context)


async def newpost_restart(update: Update, context: ContextTypes.DEFAULT_TYPE) -> int:
    """Из превью начать пост заново (заново прислать контент)."""
    query = update.callback_query
    await query.answer("Начинаем заново")
    try:
        await query.edit_message_reply_markup(reply_markup=None)
    except Exception:
        pass
    context.user_data.clear()
    await query.message.reply_text(
        "🔄 Начинаем заново. Пришлите новое содержимое поста "
        "(текст / фото / видео / альбом и т.д.).\n\nДля отмены — /cancel",
        reply_markup=ReplyKeyboardRemove(),
    )
    return WAITING_CONTENT


async def newpost_cancel_callback(update: Update, context: ContextTypes.DEFAULT_TYPE) -> int:
    query = update.callback_query
    await query.answer()
    try:
        await query.edit_message_reply_markup(reply_markup=None)
    except Exception:
        pass
    await query.message.reply_text("❌ Создание поста отменено.")
    context.user_data.clear()
    return ConversationHandler.END


async def newpost_cancel_command(update: Update, context: ContextTypes.DEFAULT_TYPE) -> int:
    context.user_data.clear()
    await update.message.reply_text("❌ Создание поста отменено.", reply_markup=ReplyKeyboardRemove())
    return ConversationHandler.END


async def help_command(update: Update, context: ContextTypes.DEFAULT_TYPE) -> None:
    """Короткая справка. Показывается только назначенному администратору."""
    admin_id = _get_admin_id()
    if not admin_id or update.effective_user.id != admin_id:
        return
    await update.message.reply_text(
        "🤖 <b>Что умеет бот</b>\n\n"
        "• /start — создать красивый пост в канал: пришлите контент "
        "(текст, фото, видео, кружок, GIF, документ, аудио, голосовое или альбом), "
        "затем настройте кнопки-ссылки через конструктор.\n"
        "• На шаге кнопок: /skip — без кнопок.\n"
        "• В превью: ✅ опубликовать, ✏️ изменить кнопки, 🔄 начать заново, ❌ отмена.\n"
        "• /cancel — отменить создание поста в любой момент.\n\n"
        "Отдельно бот автоматически отвечает на посты канала в привязанной группе, "
        "добавляя блок с соц-сетями.",
        parse_mode="HTML",
    )


async def stray_webapp_data(update: Update, context: ContextTypes.DEFAULT_TYPE) -> None:
    """
    Данные из конструктора кнопок, пришедшие ВНЕ создания поста
    (например, пользователь открыл сохранённую reply-клавиатуру позже).
    Не теряем их молча, а подсказываем начать заново.
    """
    admin_id = _get_admin_id()
    if not admin_id or update.effective_user.id != admin_id:
        return
    await update.effective_message.reply_text(
        "ℹ️ Кнопки получены, но сейчас мы не создаём пост. "
        "Отправьте /start и настройте их на нужном шаге.",
        reply_markup=ReplyKeyboardRemove(),
    )


async def on_error(update: object, context: ContextTypes.DEFAULT_TYPE) -> None:
    """Глобальный обработчик ошибок — чтобы исключения в колбэках не пропадали молча."""
    logger.exception("Необработанная ошибка при обработке апдейта", exc_info=context.error)


# Любой из этих типов контента принимается на шаге WAITING_CONTENT.
CONTENT_FILTERS = (
    filters.TEXT
    | filters.PHOTO
    | filters.VIDEO
    | filters.VIDEO_NOTE
    | filters.ANIMATION
    | filters.Document.ALL
    | filters.AUDIO
    | filters.VOICE
)

newpost_conversation = ConversationHandler(
    entry_points=[CommandHandler("start", newpost_start, filters=filters.ChatType.PRIVATE)],
    states={
        WAITING_CONTENT: [
            MessageHandler(
                filters.ChatType.PRIVATE & CONTENT_FILTERS & ~filters.COMMAND,
                newpost_receive_content,
            )
        ],
        WAITING_KEYBOARD: [
            CommandHandler("skip", newpost_skip_keyboard),
            MessageHandler(filters.StatusUpdate.WEB_APP_DATA, newpost_receive_webapp_data),
            MessageHandler(
                filters.ChatType.PRIVATE & filters.TEXT & ~filters.COMMAND,
                newpost_receive_keyboard_text,
            ),
        ],
        WAITING_CONFIRM: [
            CallbackQueryHandler(newpost_confirm, pattern="^newpost_confirm$"),
            CallbackQueryHandler(newpost_editkb, pattern="^newpost_editkb$"),
            CallbackQueryHandler(newpost_restart, pattern="^newpost_restart$"),
            CallbackQueryHandler(newpost_cancel_callback, pattern="^newpost_cancel$"),
        ],
    },
    fallbacks=[CommandHandler("cancel", newpost_cancel_command)],
)


# ============================================================
#  Веб-сервер: принимает вебхук Telegram И отдаёт мини-приложение
# ============================================================

async def handle_telegram_webhook(request: web.Request) -> web.Response:
    # Проверяем секретный заголовок — чтобы обрабатывать только настоящие апдейты Telegram.
    if request.headers.get("X-Telegram-Bot-Api-Secret-Token") != WEBHOOK_SECRET:
        logger.warning("Отклонён запрос на вебхук с неверным secret_token")
        return web.Response(status=403, text="Forbidden")
    try:
        data = await request.json()
    except Exception:
        return web.Response(status=400, text="Bad Request")
    update = Update.de_json(data, application.bot)
    await application.update_queue.put(update)
    return web.Response(text="OK")


async def handle_miniapp(request: web.Request) -> web.Response:
    return web.Response(text=MINIAPP_HTML, content_type="text/html")


async def handle_health(request: web.Request) -> web.Response:
    return web.Response(text="Bot is running")


async def _setup_commands() -> None:
    """Меню команд бота (видно по кнопке ☰ в личке у администратора)."""
    admin_id = _get_admin_id()
    if not admin_id:
        return
    commands = [
        BotCommand("start", "📝 Создать пост в канал"),
        BotCommand("cancel", "❌ Отменить создание поста"),
        BotCommand("help", "ℹ️ Справка"),
    ]
    try:
        await application.bot.set_my_commands(commands, scope=BotCommandScopeChat(chat_id=admin_id))
    except Exception as e:
        logger.warning(f"Не удалось установить меню команд: {e}")


async def on_startup(aio_app: web.Application) -> None:
    await application.initialize()
    await application.start()
    webhook_url = f"{RENDER_EXTERNAL_URL}/{WEBHOOK_SECRET}"
    await application.bot.set_webhook(
        url=webhook_url,
        allowed_updates=Update.ALL_TYPES,
        secret_token=WEBHOOK_SECRET,
        drop_pending_updates=True,
    )
    await _setup_commands()
    logger.info("Вебхук установлен (секретный путь скрыт в логах).")
    logger.info(f"Мини-приложение доступно на: {_get_miniapp_url()}")


async def on_cleanup(aio_app: web.Application) -> None:
    await application.stop()
    await application.shutdown()


def main() -> None:
    global application, WEBHOOK_SECRET

    if not BOT_TOKEN:
        logger.error("КРИТИЧЕСКАЯ ОШИБКА: Переменная TELEGRAM_BOT_TOKEN не настроена!")
        sys.exit(1)

    if not RENDER_EXTERNAL_URL:
        logger.error("КРИТИЧЕСКАЯ ОШИБКА: Переменная RENDER_EXTERNAL_URL не настроена на Render!")
        sys.exit(1)

    # Секрет для вебхука: явный WEBHOOK_SECRET из окружения либо детерминированный
    # хэш от токена (безопасный набор символов, токен в URL не светится).
    WEBHOOK_SECRET = os.getenv("WEBHOOK_SECRET") or hashlib.sha256(BOT_TOKEN.encode()).hexdigest()

    application = (
        Application.builder()
        .token(BOT_TOKEN)
        # concurrent_updates нужен, чтобы бот мог параллельно "собирать" части
        # альбома (несколько сообщений с одним media_group_id), пока ждёт debounce.
        .concurrent_updates(True)
        .build()
    )
    application.add_handler(MessageHandler(filters.ChatType.GROUPS, handle_channel_post_in_group))
    application.add_handler(newpost_conversation)
    application.add_handler(CommandHandler("help", help_command, filters=filters.ChatType.PRIVATE))
    # Данные вебаппа, пришедшие вне диалога (после ConversationHandler, чтобы не перехватывать активный сценарий).
    application.add_handler(MessageHandler(filters.StatusUpdate.WEB_APP_DATA, stray_webapp_data))
    application.add_error_handler(on_error)

    aio_app = web.Application()
    aio_app.router.add_get("/", handle_health)
    aio_app.router.add_get("/miniapp", handle_miniapp)
    aio_app.router.add_post(f"/{WEBHOOK_SECRET}", handle_telegram_webhook)
    aio_app.on_startup.append(on_startup)
    aio_app.on_cleanup.append(on_cleanup)

    port = int(os.getenv("PORT", 10000))
    logger.info("Запуск бота в режиме WEBHOOK (aiohttp)...")
    web.run_app(aio_app, host="0.0.0.0", port=port)


if __name__ == "__main__":
    main()
