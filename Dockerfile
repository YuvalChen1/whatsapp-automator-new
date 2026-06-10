FROM node:20-slim

# Install system dependencies for Chromium + procps (for pkill in start.sh)
RUN apt-get update && apt-get install -y --no-install-recommends \
    chromium \
    procps \
    fonts-liberation \
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
    xdg-utils \
    && apt-get clean \
    && rm -rf /var/lib/apt/lists/*

# Tell Puppeteer to use the system-installed Chromium
ENV PUPPETEER_EXECUTABLE_PATH=/usr/bin/chromium
ENV PUPPETEER_SKIP_CHROMIUM_DOWNLOAD=true

WORKDIR /app

COPY package*.json ./
RUN npm install

COPY . .

# Make startup script executable
RUN chmod +x start.sh

# Create the data directory (Render persistent disk will be mounted here)
RUN mkdir -p /app/data

# Default port and environment directory
ENV DATA_DIR=/app/data
ENV PORT=3000

EXPOSE 3000

# Use the startup script which cleans locks before starting Node
CMD ["./start.sh"]
