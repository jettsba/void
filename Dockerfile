FROM node:20-alpine

# su-exec — минималистичный setuid helper (аналог gosu). Entrypoint чинит права
# на bind-mount'овой папке данных и делает drop-privileges до USER node.
RUN apk add --no-cache su-exec

# /app/data — рантайм-volume (stats.json). Создаём заранее; права чинит entrypoint
# при старте, потому что bind-mount хоста может затереть владельца.
RUN mkdir -p /app/data && chown -R node:node /app

WORKDIR /app

COPY --chown=node:node package.json package-lock.json* ./
RUN npm ci --omit=dev && npm cache clean --force

COPY --chown=node:node server.js ./
COPY --chown=node:node lib ./lib
COPY --chown=node:node public ./public
COPY docker-entrypoint.sh /usr/local/bin/docker-entrypoint.sh
RUN chmod +x /usr/local/bin/docker-entrypoint.sh

ENV NODE_ENV=production
ENV PORT=3000

EXPOSE 3000

# Лёгкая HTTP-проверка живости. Контейнер healthy если корень отвечает 200.
HEALTHCHECK --interval=30s --timeout=3s --start-period=5s --retries=3 \
    CMD wget -qO- http://127.0.0.1:3000/ > /dev/null || exit 1

ENTRYPOINT ["docker-entrypoint.sh"]
CMD ["node", "server.js"]
