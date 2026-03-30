FROM node:20-slim

# Install dependencies for Chrome + FlareSolverr
RUN apt-get update && apt-get install -y \
    wget \
    gnupg \
    ca-certificates \
    fonts-liberation \
    fonts-noto-color-emoji \
    libasound2 \
    libatk-bridge2.0-0 \
    libatk1.0-0 \
    libcups2 \
    libdbus-1-3 \
    libdrm2 \
    libgbm1 \
    libgtk-3-0 \
    libnspr4 \
    libnss3 \
    libx11-xcb1 \
    libxcomposite1 \
    libxdamage1 \
    libxrandr2 \
    libxshmfence1 \
    xdg-utils \
    xvfb \
    curl \
    python3 \
    python3-pip \
    python3-venv \
    --no-install-recommends \
    && wget -q -O - https://dl-ssl.google.com/linux/linux_signing_key.pub | gpg --dearmor -o /usr/share/keyrings/google-archive-keyring.gpg \
    && echo "deb [signed-by=/usr/share/keyrings/google-archive-keyring.gpg] http://dl.google.com/linux/chrome/deb/ stable main" > /etc/apt/sources.list.d/google-chrome.list \
    && apt-get update \
    && apt-get install -y google-chrome-stable --no-install-recommends \
    && rm -rf /var/lib/apt/lists/*

# Install FlareSolverr via pip
RUN python3 -m venv /opt/flaresolverr-venv \
    && /opt/flaresolverr-venv/bin/pip install --no-cache-dir flaresolverr || true

# Clone and set up FlareSolverr from source as fallback
RUN apt-get update && apt-get install -y git --no-install-recommends && rm -rf /var/lib/apt/lists/* \
    && git clone --depth 1 https://github.com/FlareSolverr/FlareSolverr.git /opt/flaresolverr \
    && cd /opt/flaresolverr \
    && python3 -m venv /opt/flaresolverr/venv \
    && /opt/flaresolverr/venv/bin/pip install --no-cache-dir -r requirements.txt

WORKDIR /app

# Skip Puppeteer chromium download - we don't need it anymore
ENV PUPPETEER_SKIP_CHROMIUM_DOWNLOAD=true

COPY package*.json ./
RUN npm ci

COPY . .

ENV PORT=8080
ENV FLARESOLVERR_URL=http://localhost:8191/v1
ENV CHROME_PATH=/usr/bin/google-chrome-stable

EXPOSE 8080

# Start FlareSolverr in background, then start Node app
COPY start.sh ./
RUN chmod +x start.sh

CMD ["./start.sh"]
