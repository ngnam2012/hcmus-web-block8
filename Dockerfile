FROM node:22-alpine
WORKDIR /app
COPY package*.json ./
RUN npm ci --omit=dev
COPY src ./src
COPY public ./public
COPY db ./db
COPY scripts ./scripts
COPY test ./test
CMD ["node", "src/sender-api.js"]
