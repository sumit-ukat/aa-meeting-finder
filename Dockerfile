FROM lwthiker/curl-impersonate:0.6-chrome AS curl-impersonate

FROM node:20-slim

# Copy curl-impersonate binaries and all required libraries
COPY --from=curl-impersonate /usr/local/bin/curl-impersonate-chrome /usr/local/bin/
COPY --from=curl-impersonate /usr/local/bin/curl_chrome116 /usr/local/bin/
COPY --from=curl-impersonate /usr/local/lib/ /usr/local/lib/

# Install runtime dependencies
RUN apt-get update && apt-get install -y \
    ca-certificates \
    libnss3 \
    libnspr4 \
    libbrotli1 \
    libnghttp2-14 \
    --no-install-recommends \
    && rm -rf /var/lib/apt/lists/* \
    && ldconfig

# Set library path for curl-impersonate
ENV LD_LIBRARY_PATH=/usr/local/lib
ENV CURL_CHROME=curl_chrome116

WORKDIR /app

COPY package*.json ./
RUN npm ci

COPY . .

ENV PORT=8080

EXPOSE 8080

CMD ["node", "server.js"]
