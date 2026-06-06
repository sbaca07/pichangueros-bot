# Pichangueros Bot

Bot de WhatsApp para Pichangueros (KIPI). Ruta **no oficial** (`whatsapp-web.js`) como dispositivo vinculado, always-on en Render.

## Estado: Semana 1 (cimientos + conexión)

- Se conecta a WhatsApp por QR (escaneado **una sola vez**, sesión persistida en disco).
- Página `/qr` para escanear desde el navegador.
- **MODO SEGURO** (`SAFE_MODE=true`): NO le escribe a nadie. Solo responde al comando de prueba `ping kipi`. La conversación real se activa en la Semana 2.

## Desplegar en Render (1 vez)

1. Subir este código a un repo de GitHub.
2. Render Dashboard → **Blueprints** → **New Blueprint Instance** → apuntar al repo. Render lee `render.yaml` y crea el servicio Docker (plan starter, disco persistente para la sesión).
3. Abrir `https://<servicio>.onrender.com/qr` y escanear el QR desde el WhatsApp de Clarck (Ajustes → Dispositivos vinculados → Vincular dispositivo).
4. Checkpoint: escribir `ping kipi` al número → el bot responde "✅ conectado".

## Correr local (opcional, para probar)

```bash
npm install
cp .env.example .env   # ajustar PUPPETEER_EXECUTABLE_PATH si hace falta
npm start
# abrir http://localhost:10000/qr
```

## Siguientes semanas

- S2: cerebro IA, clasificación por distrito, captura de leads, handoff.
- S3: panel admin + landing.
- S4: OCR de vouchers de Yape.
- S5: listas automáticas en el grupo.
- S6: inscripción por chat + recordatorios.
