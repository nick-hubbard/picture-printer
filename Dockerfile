FROM node:22-bookworm-slim

RUN apt-get update \
  && apt-get install -y --no-install-recommends cups-client \
  && rm -rf /var/lib/apt/lists/*

WORKDIR /app

COPY package*.json ./
RUN npm ci --omit=dev

COPY public ./public
COPY server.js ./

RUN mkdir -p uploads prints google-photos \
  && chown -R node:node /app

USER node

EXPOSE 3000

CMD ["npm", "start"]
