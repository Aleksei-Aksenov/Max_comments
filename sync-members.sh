#!/bin/bash
# Скрипт синхронизации подписчиков каналов MAX Comments
# Запуск: bash sync-members.sh

set -e

# --- Читаем .env ---
ENV_FILE="$(dirname "$0")/.env"
if [ ! -f "$ENV_FILE" ]; then
  echo "Ошибка: файл .env не найден (ожидается рядом со скриптом)"
  exit 1
fi

BOT_TOKEN=$(grep -E '^MAX_BOT_TOKEN=' "$ENV_FILE" | cut -d'=' -f2- | tr -d '"' | tr -d "'")
DOMAIN=$(grep -E '^DOMAIN=' "$ENV_FILE" | cut -d'=' -f2- | tr -d '"' | tr -d "'")
MAX_API="https://platform-api.max.ru"

if [ -z "$BOT_TOKEN" ] || [ "$BOT_TOKEN" = "replace_me" ]; then
  echo "Ошибка: MAX_BOT_TOKEN не задан в .env"
  exit 1
fi
if [ -z "$DOMAIN" ] || [ "$DOMAIN" = "your-domain.com" ]; then
  echo "Ошибка: DOMAIN не задан в .env"
  exit 1
fi

echo ""
echo "=== Синхронизация подписчиков MAX Comments ==="
echo ""
echo "Получаю список каналов бота..."

# --- Получаем список чатов ---
TMPFILE=$(mktemp)
HTTP_CODE=$(curl -s -o "$TMPFILE" -w "%{http_code}" -H "Authorization: $BOT_TOKEN" "$MAX_API/chats?count=100")

if [ -z "$(cat "$TMPFILE")" ]; then
  echo "Ошибка: не удалось получить список чатов. Проверь токен и доступ к интернету."
  rm -f "$TMPFILE"
  exit 1
fi

if [ "$HTTP_CODE" != "200" ]; then
  echo "Ошибка API (HTTP $HTTP_CODE): $(cat "$TMPFILE")"
  rm -f "$TMPFILE"
  exit 1
fi

# Парсим JSON через python3 (есть на любом Ubuntu)
CHATS=$(python3 -c "
import json, sys
with open('$TMPFILE') as f:
    data = json.load(f)
chats = data.get('chats', [])
if not chats:
    print('EMPTY')
    sys.exit(0)
for i, c in enumerate(chats):
    chat_id = c.get('chat_id') or c.get('id', '')
    title = c.get('title', '(без названия)').replace('|', ' ')
    ctype = c.get('type', '')
    print(f'{i+1}|{chat_id}|{title}|{ctype}')
")
rm -f "$TMPFILE"

if [ "$CHATS" = "EMPTY" ] || [ -z "$CHATS" ]; then
  echo "Бот не состоит ни в одном канале/чате."
  echo "Добавьте бота в канал и повторите попытку."
  exit 0
fi

# --- Выводим список ---
echo "Найдены следующие каналы/чаты:"
echo ""
IFS=$'\n'
declare -a CHAT_IDS
declare -a CHAT_NAMES
i=0
for line in $CHATS; do
  NUM=$(echo "$line" | cut -d'|' -f1)
  ID=$(echo "$line" | cut -d'|' -f2)
  TITLE=$(echo "$line" | cut -d'|' -f3)
  TYPE=$(echo "$line" | cut -d'|' -f4)
  CHAT_IDS[$i]="$ID"
  CHAT_NAMES[$i]="$TITLE"
  printf "  [%s] %s  (id: %s, тип: %s)\n" "$NUM" "$TITLE" "$ID" "$TYPE"
  i=$((i+1))
done
echo ""

# --- Выбор пользователя ---
TOTAL=$i
echo "Введите номера каналов для синхронизации через запятую (например: 1,2,3)"
echo "Или нажмите Enter чтобы синхронизировать ВСЕ каналы:"
read -r SELECTION

if [ -z "$SELECTION" ]; then
  INDICES=""
  for j in $(seq 0 $((TOTAL-1))); do
    INDICES="$INDICES $j"
  done
else
  INDICES=""
  IFS=',' read -ra NUMS <<< "$SELECTION"
  for NUM in "${NUMS[@]}"; do
    NUM=$(echo "$NUM" | tr -d ' ')
    if [[ "$NUM" =~ ^[0-9]+$ ]] && [ "$NUM" -ge 1 ] && [ "$NUM" -le "$TOTAL" ]; then
      INDICES="$INDICES $((NUM-1))"
    else
      echo "Пропускаю некорректный номер: $NUM"
    fi
  done
fi

if [ -z "$INDICES" ]; then
  echo "Не выбрано ни одного канала."
  exit 0
fi

# --- Синхронизация ---
echo ""
echo "Начинаю синхронизацию..."
echo ""

SUCCESS=0
FAIL=0
for idx in $INDICES; do
  CHAT_ID="${CHAT_IDS[$idx]}"
  CHAT_NAME="${CHAT_NAMES[$idx]}"
  printf "  %-40s ... " "$CHAT_NAME"

  RESULT=$(curl -s "https://$DOMAIN/api/admin/sync/$CHAT_ID?token=$BOT_TOKEN")
  OK=$(echo "$RESULT" | python3 -c "import json,sys; d=json.load(sys.stdin); print(d.get('ok',''))" 2>/dev/null)
  SYNCED=$(echo "$RESULT" | python3 -c "import json,sys; d=json.load(sys.stdin); print(d.get('synced',0))" 2>/dev/null)

  if [ "$OK" = "True" ] || [ "$OK" = "true" ]; then
    echo "OK (синхронизировано: $SYNCED)"
    SUCCESS=$((SUCCESS+1))
  else
    echo "ОШИБКА: $RESULT"
    FAIL=$((FAIL+1))
  fi
done

echo ""
echo "=== Готово: успешно $SUCCESS, ошибок $FAIL ==="
echo ""
