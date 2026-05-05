FROM node:20-alpine

WORKDIR /app

# Копируем package файлы
COPY package*.json ./

# Устанавливаем зависимости
RUN npm ci --only=production && \
    npm cache clean --force

# Копируем исходники
COPY src ./src

# Создаем пользователя для безопасности
RUN addgroup -g 1001 -S nodejs && \
    adduser -S nodejs -u 1001 && \
    chown -R nodejs:nodejs /app

# Переключаемся на пользователя
USER nodejs

ENV NODE_ENV=production

EXPOSE 3000

CMD ["node", "src/server.js"]