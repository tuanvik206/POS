FROM node:24-alpine
ENV NODE_ENV=production
WORKDIR /app
COPY package.json ./
RUN npm install --omit=dev --no-audit --no-fund \
    && addgroup -S -g 10001 pos \
    && adduser -S -D -H -u 10001 -G pos pos
COPY --chown=10001:10001 src ./src
USER 10001:10001
EXPOSE 3000
CMD ["node", "src/server.js"]
