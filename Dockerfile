# Baileys NO necesita navegador → imagen Node simple y liviana.
FROM node:20-slim

WORKDIR /app

COPY package*.json ./
RUN npm install --omit=dev

COPY . .

# La sesión de WhatsApp se guarda acá (disco persistente vía render.yaml)
ENV WWEBJS_AUTH_PATH=/app/.wwebjs_auth

CMD ["node", "index.js"]
