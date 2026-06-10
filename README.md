# Pichangueros Bot

Bot de WhatsApp para Pichangueros (KIPI). Ruta **no oficial** (Baileys, sin navegador) como dispositivo vinculado, always-on en Render.

## Estado: Semana 2 (el cerebro: IA + captura de leads)

- Se conecta a WhatsApp por QR (escaneado **una sola vez**, sesión persistida en disco). Página `/qr` para escanear desde el navegador. (Semana 1 ✅)
- **Cerebro IA** (`src/brain.js`): responde con el tono de Clarck (del brief), contesta FAQs con datos reales y guía el filtro de nuevos (nombre, edad, distrito → grupo de su zona o lista de espera).
- **Captura de leads** (`src/db.js`): SQLite en el disco persistente. Todo contacto queda registrado con sus datos y el historial de conversación — incluso si el bot no le responde.
- **Handoff a Clarck**: quejas, pagos en efectivo y casos especiales → el bot se calla para ese contacto y avisa al número de control.
- **MODO SEGURO** (`SAFE_MODE=true`): el cerebro solo atiende a `ALLOWED_TESTERS`; al resto lo registra en silencio. Cuando Clarck apruebe el guion → `SAFE_MODE=false`.

## Dónde se edita qué

| Cambio | Archivo |
|---|---|
| Precios, sedes, horarios, links de grupos, Yape | `config/negocio.js` (solo datos, sin código) |
| Tono, flujo del filtro, reglas del asistente | `src/brain.js` (system prompt) |
| Leads y conversaciones | SQLite en `<disco>/data/pichangueros.db` |

## Variables de entorno

Ver `.env.example`. Las nuevas de la Semana 2: `OPENAI_API_KEY` (sin ella el cerebro queda apagado y el bot solo registra), `OPENAI_MODEL` (default `gpt-4o-mini`), `ALLOWED_TESTERS`, `NOTIFY_NUMBER`.

## Comandos del número de control (por DM al bot)

- `kipi estado` — conexión, modo, leads por zona, handoffs activos.
- `kipi reactivar <numero>` — el bot vuelve a atender a un contacto derivado.
- `ping kipi` — chequeo rápido de conexión (cualquier número).

## Desplegar en Render (1 vez)

1. Subir este código a un repo de GitHub.
2. Render Dashboard → **Blueprints** → **New Blueprint Instance** → apuntar al repo. Render lee `render.yaml` y crea el servicio Docker (plan starter, disco persistente para la sesión).
3. Setear en el dashboard: `OPENAI_API_KEY`, `ALLOWED_TESTERS`, `NOTIFY_NUMBER`.
4. Abrir `https://<servicio>.onrender.com/qr` y escanear el QR desde el WhatsApp de Clarck (Ajustes → Dispositivos vinculados → Vincular dispositivo).
5. Checkpoint: escribir `ping kipi` al número → el bot responde "✅ conectado".

## Correr local (opcional, para probar)

```bash
npm install
cp .env.example .env   # poner OPENAI_API_KEY y tu número en ALLOWED_TESTERS
npm start
# abrir http://localhost:10000/qr
```

## Siguientes semanas

- S3: panel admin + landing.
- S4: OCR de vouchers de Yape.
- S5: listas automáticas en el grupo.
- S6: inscripción por chat + recordatorios.
