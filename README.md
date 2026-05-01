# Max Comments

[![Status: Work in Progress](https://img.shields.io/badge/status-active_development-yellow)]()
[![Based on](https://img.shields.io/badge/based%20on-konstantin--er/max__comments-blue)](https://github.com/konstantin-er/max_comments)

## ⚠️ Статус проекта

> Проект находится в **активной разработке**.
> 
> Я использую GitHub для синхронизации кода между своими компьютерами, 
> поэтому на данный момент проект **может не собираться, не запускаться или содержать нестабильный код**.
> 
> **Не рекомендуется клонировать и запускать** до выхода версии v1.0.0.

## Основа

Проект основан на [max_comments от konstantin-er](https://github.com/konstantin-er/max_comments).  
Благодарность автору за отличную основу!



# MAX Comments

Комментарии для каналов MAX через мини-приложение.

Бот добавляет inline-кнопку под каждый пост канала. Кнопка открывает mini-app с чатом комментариев. Доступ только подписчикам канала.

## Как это работает

1. Бот слушает события канала через long-polling
2. На каждый новый пост добавляет кнопку «Комментарии»
3. Кнопка открывает mini-app с чатом
4. Mini-app валидирует пользователя через initData (HMAC-SHA256)
5. Комментарии обновляются в реальном времени через SSE

## Стек

- Node.js + Fastify
- SQLite (better-sqlite3)
- SSE + polling fallback для realtime
- Docker + Traefik

## Быстрый старт (локально)

```bash
cp .env.example .env
# Заполни .env своими значениями

npm install
npm run dev          # в одном терминале
npm run bot:worker   # в другом терминале
```

## ENV переменные

| Переменная | Описание | Пример |
|---|---|---|
| `MAX_BOT_TOKEN` | Токен бота | `your_token_here` |
| `MAX_BOT_NAME` | Имя бота (для deep-link) | `mybot` |
| `DOMAIN` | Домен сервиса | `comments.example.com` |
| `ACME_EMAIL` | Email для Let's Encrypt (standalone) | `you@example.com` |
| `PORT` | Порт сервера | `3000` |
| `DB_PATH` | Путь к SQLite файлу | `./data.sqlite` |
| `BUTTON_TEXT` | Текст кнопки под постом | `💬 Комментарии` |
| `EXTERNAL_NETWORK` | Имя внешней Docker-сети (только для external-network варианта) | `n8n_default` |

## Деплой на сервер (Docker + Traefik)

Есть два варианта деплоя — выбери подходящий.

---

### Вариант 1: Standalone (с нуля, Traefik внутри)

Подходит если на сервере нет никакого Traefik. Всё поднимается одной командой: и сам бот, и Traefik с автоматическим SSL.

**1. Добавь DNS A-запись** `comments.example.com` → IP сервера

**2. Залей код на сервер:**
```bash
rsync -av --exclude node_modules --exclude .git --exclude '*.sqlite*' \
  ./ user@SERVER_IP:/opt/max-comments/
```

**3. Создай `.env`:**
```bash
cp /opt/max-comments/.env.example /opt/max-comments/.env
nano /opt/max-comments/.env
# Обязательно заполни: MAX_BOT_TOKEN, MAX_BOT_NAME, DOMAIN, ACME_EMAIL
```

**4. Запусти:**
```bash
cd /opt/max-comments
docker compose up -d --build
```

Traefik автоматически выпустит SSL сертификат через Let's Encrypt.

---

### Вариант 2: Подключение к существующему Traefik (например через n8n)

Подходит если на сервере уже запущен Traefik в какой-то Docker-сети (например `n8n_default`). В этом случае поднимать второй Traefik не нужно — бот просто подключается к существующей сети.

**1.** Узнай имя сети где живёт Traefik:
```bash
docker network ls
```

**2.** Добавь в `.env`:
```
EXTERNAL_NETWORK=n8n_default   # или другое имя сети
```

**3.** Запусти с override-файлом:
```bash
cd /opt/max-comments
docker compose -f docker-compose.yml -f docker-compose.external-network.yml up -d --build
```

## Первичная синхронизация подписчиков

После запуска нужно один раз синхронизировать существующих участников канала — бот не получает события о подписчиках, которые вступили до его запуска.

### Интерактивный скрипт (рекомендуется)

Скрипт сам получит список каналов, предложит выбрать нужные и запустит синхронизацию:

```bash
bash sync-members.sh
```

Скрипт автоматически читает `MAX_BOT_TOKEN` и `DOMAIN` из `.env`. Потребуется только выбрать номера каналов из списка (или нажать Enter для синхронизации всех).

### Вручную через API

Если нужно синхронизировать конкретный канал:

```bash
curl "https://your-domain.com/api/admin/sync/<CHANNEL_ID>?token=<MAX_BOT_TOKEN>"
```

Вернёт `{"ok":true,"synced":N}` — количество синхронизированных участников.

### Проверка результата

Посмотреть статистику по всем каналам в базе:

```bash
curl "https://your-domain.com/api/admin/stats?token=<MAX_BOT_TOKEN>"
```

Вернёт количество подписчиков по каждому каналу:
```json
{
  "ok": true,
  "channels": [
    { "channel_id": "123456", "members_count": 542 }
  ]
}
```

## API

| Метод | URL | Описание |
|---|---|---|
| `GET` | `/health` | Проверка работоспособности |
| `GET/POST` | `/api/session` | Создание сессии (валидация initData) |
| `GET` | `/api/threads/:channelId/:mid/comments` | Получить комментарии |
| `POST` | `/api/threads/:channelId/:mid/comments` | Добавить комментарий |
| `GET` | `/api/threads/:channelId/:mid/stream` | SSE поток новых комментариев |
| `POST` | `/api/webhook` | Webhook от MAX (long-polling) |
| `GET` | `/api/admin/sync/:channelId` | Синхронизация подписчиков канала |
| `GET` | `/api/admin/stats` | Статистика подписчиков по каналам |

## Структура проекта

```
src/
  server.js          — HTTP сервер, mini-app HTML, все API endpoints
  bot_worker.js      — long-polling воркер
  webhook_handlers.js — обработка событий MAX
  max_api.js         — обращения к MAX API
  db.js              — SQLite схема и запросы
  validation.js      — валидация initData
  payload.js         — encode/decode токена
  realtime.js        — SSE pub/sub
  config.js          — конфигурация из ENV
docs/
  CONTEXT.md         — технический контекст и ключевые решения
  TECHNICAL_SPEC.md  — исходное ТЗ
```
