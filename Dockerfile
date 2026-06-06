# Imagen con Node + Chromium (whatsapp-web.js necesita un navegador real)
FROM node:20-slim

# Dependencias de sistema para que Chromium arranque en Render
RUN apt-get update && apt-get install -y --no-install-recommends \
    chromium \
    fonts-liberation \
    libnss3 libatk1.0-0 libatk-bridge2.0-0 libcups2 libdrm2 libxkbcommon0 \
    libxcomposite1 libxdamage1 libxfixes3 libxrandr2 libgbm1 libasound2 \
    libpangocairo-1.0-0 libpango-1.0-0 libcairo2 libatspi2.0-0 \
    ca-certificates \
  && rm -rf /var/lib/apt/lists/*

# Puppeteer usa el Chromium del sistema (no descarga el suyo)
ENV PUPPETEER_SKIP_DOWNLOAD=true \
    PUPPETEER_EXECUTABLE_PATH=/usr/bin/chromium

WORKDIR /app

COPY package*.json ./
RUN npm install --omit=dev

COPY . .

# La sesión de WhatsApp se guarda acá (montado en disco persistente vía render.yaml)
ENV WWEBJS_AUTH_PATH=/app/.wwebjs_auth

CMD ["node", "index.js"]
