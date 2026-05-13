FROM node:20-alpine

# /app/data — рантайм-volume (stats.json). Создаём заранее и отдаём node-user'у,
# чтобы можно было писать без root. Остальное приложение тоже принадлежит node.
RUN mkdir -p /app/data && chown -R node:node /app

WORKDIR /app

COPY --chown=node:node package.json package-lock.json* ./
RUN npm ci --omit=dev && npm cache clean --force

COPY --chown=node:node server.js ./
COPY --chown=node:node lib ./lib
COPY --chown=node:node public ./public

USER node

ENV NODE_ENV=production
ENV PORT=3000

EXPOSE 3000

# Лёгкая HTTP-проверка живости. Контейнер healthy если корень отвечает 200.
HEALTHCHECK --interval=30s --timeout=3s --start-period=5s --retries=3 \
    CMD wget -qO- http://127.0.0.1:3000/ > /dev/null || exit 1

CMD ["node", "server.js"]
