FROM node:20-slim

# Install curl for Cloudflare-protected sites (AA, NA)
RUN apt-get update && apt-get install -y curl --no-install-recommends && rm -rf /var/lib/apt/lists/*

WORKDIR /app

COPY package*.json ./
RUN npm ci

COPY . .

ENV PORT=8080

EXPOSE 8080

CMD ["node", "server.js"]
