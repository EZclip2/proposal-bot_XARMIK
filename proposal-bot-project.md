---
name: proposal-bot-project
description: "Проект «бот-предложка» — стек, деплой и конфиг, которые не хранятся в коде"
metadata: 
  node_type: memory
  type: project
  originSessionId: d9275411-3e38-4253-a254-99989bd15ac5
---

Пользователь строит Telegram-бота «предложка» (приём предложений от подписчиков → модерация → ответ). Разрабатываем итеративно; готовые файлы бот присылает пользователю через тул Write (см. [[bot-write-hook-only]]), рабочая копия — в подпапке `ideal-bot/`, отправляемая копия — в корне пользовательской папки (`bot.js`, `webapp.html`, `package.json`, `env.example.txt`, `gitignore.txt`).

**Стек:** Node.js + Express + node-telegram-bot-api (webhook), мини-приложение (Direct Link Mini App, кнопка-ссылка `t.me/bot/app?startapp=<id>` — обычные web_app-кнопки в группах не работают). Ответы модераторов через мини-апп с валидацией initData. Хранилище — JSON-файл `data.json` (сбрасывается при редеплое Render).

**Деплой:** Render (Web Service, free), автодеплой из GitHub, anti-sleep через cron-job.org каждые 12 мин. URL сервиса: `https://proposal-bot-xarmik.onrender.com`. Вебхук ставится сам из `RENDER_EXTERNAL_URL`.

**Конфиг (env, задаётся на Render, не в коде):** BOT_TOKEN, MODERATION_CHAT_ID = `-1004318475756`, BOT_USERNAME, APP_NAME, GEMINI_API_KEY, GEMINI_MODEL. Темы форума модерационной группы: TOPIC_NEW=`11`, TOPIC_ANSWERED=`12`, TOPIC_BIZ=`13`.

**Ключевые фичи:** ID обращения — 7-символьный base36 из userId+время+random (`genTicket`); категории обычное/💎деловое определяются ИИ (Gemini, `classify()` — фильтр мусора + классификация); очередь у подписчика с автообновлением; чистка лишних сообщений; мут 15 мин при отклонении; авто-возврат «зависших» карточек из processing через 10 мин.
