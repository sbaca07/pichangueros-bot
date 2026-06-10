# Baileys NO necesita navegador → imagen Node simple y liviana.
# Node >=24: usamos su SQLite nativo (node:sqlite) para la BD de leads.
FROM node:24-slim

# git y herramientas de build: algunas dependencias de Baileys se instalan
# desde git o compilan módulos nativos, y node:20-slim no las trae.
RUN apt-get update && apt-get install -y --no-install-recommends \
    git ca-certificates python3 make g++ \
  && rm -rf /var/lib/apt/lists/*

WORKDIR /app

COPY package*.json ./
RUN npm install --omit=dev

COPY . .

# La sesión de WhatsApp se guarda acá (disco persistente vía render.yaml)
ENV WWEBJS_AUTH_PATH=/app/.wwebjs_auth

CMD ["node", "index.js"]
