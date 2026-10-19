FROM node:22-alpine
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci --omit=dev
COPY server.js ./
COPY lib ./lib
COPY marketplaces ./marketplaces
COPY public ./public
COPY THIRD_PARTY_NOTICES.md ./
ENV NODE_ENV=production
EXPOSE 3002
CMD ["node", "server.js"]
