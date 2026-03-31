FROM lwthiker/curl-impersonate:0.6-chrome AS curl-impersonate

FROM node:20-slim

# Copy curl-impersonate-chrome binary and its libraries from the builder
COPY --from=curl-impersonate /usr/local/bin/curl-impersonate-chrome /usr/local/bin/curl-impersonate-chrome
COPY --from=curl-impersonate /usr/local/bin/curl_chrome116 /usr/local/bin/curl_chrome116
COPY --from=curl-impersonate /usr/local/lib/libcurl-impersonate-chrome* /usr/local/lib/

# Install runtime dependencies for curl-impersonate
RUN apt-get update && apt-get install -y \
    ca-certificates \
    libnss3 \
    libnspr4 \
    --no-install-recommends \
    && rm -rf /var/lib/apt/lists/* \
    && ldconfig

WORKDIR /app

COPY package*.json ./
RUN npm ci

COPY . .

ENV PORT=8080
ENV CURL_CHROME=curl_chrome116

EXPOSE 8080

CMD ["node", "server.js"]
