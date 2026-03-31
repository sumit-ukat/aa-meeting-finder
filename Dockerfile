FROM node:20-slim

# Install curl-impersonate (glibc/GNU build) to bypass Cloudflare TLS fingerprinting
RUN apt-get update && apt-get install -y \
    ca-certificates \
    wget \
    libnss3 \
    libnspr4 \
    libbrotli1 \
    libnghttp2-14 \
    --no-install-recommends \
    && wget -q https://github.com/lwthiker/curl-impersonate/releases/download/v0.6.1/curl-impersonate-v0.6.1.x86_64-linux-gnu.tar.gz \
    && mkdir -p /usr/local/lib/curl-impersonate \
    && tar -xzf curl-impersonate-v0.6.1.x86_64-linux-gnu.tar.gz -C /usr/local/lib/curl-impersonate/ \
    && ln -s /usr/local/lib/curl-impersonate/curl-impersonate-chrome /usr/local/bin/curl-impersonate-chrome \
    && ln -s /usr/local/lib/curl-impersonate/curl_chrome116 /usr/local/bin/curl_chrome116 \
    && rm curl-impersonate-v0.6.1.x86_64-linux-gnu.tar.gz \
    && apt-get remove -y wget && apt-get autoremove -y \
    && rm -rf /var/lib/apt/lists/*

ENV CURL_CHROME=curl_chrome116

WORKDIR /app

COPY package*.json ./
RUN npm ci

COPY . .

ENV PORT=8080

EXPOSE 8080

CMD ["node", "server.js"]
