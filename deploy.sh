#!/bin/bash

echo "🚀 Starting deployment to maxconv.ru..."

# Проверка переменных
if [ ! -f .env ]; then
    echo "❌ .env file not found!"
    exit 1
fi

# Загрузка переменных
source .env

if [ -z "$DOMAIN" ] || [ -z "$ACME_EMAIL" ]; then
    echo "❌ DOMAIN and ACME_EMAIL must be set in .env"
    exit 1
fi

echo "📦 Building and starting containers..."
docker-compose down
docker-compose build --no-cache
docker-compose up -d

echo "⏳ Waiting for services to start..."
sleep 10

echo "📊 Checking container status..."
docker-compose ps

echo "📝 Recent logs:"
docker-compose logs --tail=20

echo "✅ Deployment complete!"
echo "🌐 Visit: https://$DOMAIN"