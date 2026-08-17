# Pichangueros Bot

Bot de WhatsApp para Pichangueros (KIPI). Ruta **no oficial** (Baileys, sin navegador) como dispositivo vinculado, always-on en Render.

## Estado: Semana 4 (Yape + IA)

- Se conecta a WhatsApp por QR (escaneado **una sola vez**, sesión persistida en disco). Página `/qr` para escanear desde el navegador. (Semana 1 ✅)
- **Cerebro IA** (`src/brain.js`): responde con el tono de Clarck (del brief), contesta FAQs con datos reales y guía el filtro de nuevos (nombre, edad, distrito → grupo de su zona o lista de espera).
- **Captura de leads** (`src/db.js`): SQLite en el disco persistente. Todo contacto queda registrado con sus datos y el historial de conversación — incluso si el bot no le responde.
- **Handoff a Clarck**: quejas, pagos en efectivo y casos especiales → el bot se calla para ese contacto y avisa al número de control.
- **MODO SEGURO**: el cerebro solo atiende a los números de prueba; al resto lo registra en silencio. Se enciende y se apaga **desde el panel** (Ajustes → "Encender el bot"): encender pide escribir la palabra `ENCENDER` y tildar el ensayo previo; apagar es un botón, también visible en el Resumen. `SAFE_MODE` en el entorno es solo el valor inicial, hasta que alguien toque el interruptor. Regla del silencio: lo que es para el jugador se calla, **lo que es para Clarck sale siempre** (handoffs, pagos por revisar, pedidos de cupo).
- **Pagos por Yape** (`src/pagos.js`): si llega una imagen, se intenta leer como voucher (OpenAI visión) antes de pasarla al cerebro conversacional. Verifica el monto contra el precio de la zona y detecta reenvíos del mismo comprobante (anti-fraude); lo que no calza queda "por revisar" — visible en la ficha del contacto y en un banner del Resumen. Todavía no hay concepto de "partido/fecha" (eso es Semana 5): el pago se registra contra el contacto, no contra una convocatoria puntual.

## Dónde se edita qué

| Cambio | Dónde |
|---|---|
| Precios, sedes, horarios, links de grupos, Yape, textos fijos | Panel admin → `/admin/leads?vista=config` (sin tocar código ni redesplegar) |
| Encender/apagar el bot, número de avisos, números de prueba, correos (avisos y respaldo por separado), cuántas visitas hacen a un "Casero" | Panel admin → Ajustes. Vivían en variables de Render; ahora la env var es solo el valor inicial y la BD manda en cuanto se guarda |
| Tono, flujo del filtro, reglas del asistente | `src/brain.js` (system prompt) |
| Leads y conversaciones | SQLite en `<disco>/data/pichangueros.db` |

`config/negocio.js` ya NO se usa en producción — solo sirvió para sembrar la tabla `config`/`sedes` la primera vez que corrió esta versión. Los valores en vivo están en la BD; edítalos desde el panel.

Export de leads: **CSV** (plano, para pegar en cualquier lado) o **Excel** (`src/excel.js` — con colores e identidad de Pichangueros, zona coloreada, handoff resaltado, WhatsApp como link, autofiltro). Botones en el sidebar del panel y arriba del CRM.

Conexión de WhatsApp: pestaña **Conexión** en el panel (`/admin/leads?vista=conexion`) — muestra el estado, el número al que está enlazado, y si no está conectado, el **QR en vivo** (se refresca solo) para (re)vincular. Botón **Desconectar / cambiar número** que cierra la sesión y genera un QR nuevo para enlazar otro número. El número enlazado también sale en el health endpoint (`GET /` → `linkedNumber`).

Estabilidad de la conexión: `markOnlineOnConnect:false` (el bot es dispositivo secundario, no marca la cuenta "en línea" ni le roba notificaciones al celular), `keepAliveIntervalMs:20000` (ping para evitar timeouts 408), y un candado `arrancando` que impide que se creen dos sockets en paralelo — dos sockets sobre la misma sesión de disco corrompen el cifrado y producen errores **"Bad MAC"** (mensajes que no se pueden descifrar ni enviar). Nota: un brote corto de "Bad MAC" es esperable justo después de **re-enlazar a otro número** (los contactos tienen cacheadas las claves viejas del bot); se auto-resuelve en ~1-2 min.

## Variables de entorno

Ver `.env.example`. Las nuevas de la Semana 2: `OPENAI_API_KEY` (sin ella el cerebro queda apagado y el bot solo registra), `OPENAI_MODEL` (default `gpt-4o-mini`), `ALLOWED_TESTERS`, `NOTIFY_NUMBER`.

Avisos críticos: handoffs y pagos por revisar salen por WhatsApp **y por correo** (Ajustes → Correos; `AVISO_EMAIL_TO` como valor inicial, default la casilla que envía). El **respaldo de la base** va por un correo distinto (`BACKUP_EMAIL_TO`): ese adjunto lleva las conversaciones de todos. Cloud API rechaza los mensajes libres fuera de la ventana de 24 h (`131047`) y el rechazo llega tarde por webhook, así que WhatsApp solo no alcanza. Ver `test-avisos.js`.

Ritmo de respuesta (tras las observaciones de Clarck del 13/08): `DEBOUNCE_MS` (default 2500 — cuánto se espera a que el contacto termine de escribir antes de responder **una sola vez**) y `RESPUESTA_DELAY_MS` (default 0 — la vieja pausa "anti-spam" de Baileys, innecesaria por el canal oficial). Ver `test-rafagas.js`.

## Comandos del número de control (por DM al bot)

- `kipi estado` — conexión, modo, leads por zona, handoffs activos.
- `kipi reactivar <numero>` — el bot vuelve a atender a un contacto derivado.
- `ping kipi` — chequeo rápido de conexión (cualquier número).

## Desplegar en Render (1 vez)

1. Subir este código a un repo de GitHub.
2. Render Dashboard → **Blueprints** → **New Blueprint Instance** → apuntar al repo. Render lee `render.yaml` y crea el servicio Docker (plan starter, disco persistente para la sesión).
3. Setear en el dashboard: `OPENAI_API_KEY` y —como valor inicial— `ALLOWED_TESTERS` y `NOTIFY_NUMBER` (después se editan desde Ajustes, sin volver a entrar acá).
4. Abrir `https://<servicio>.onrender.com/qr` y escanear el QR desde el WhatsApp de Clarck (Ajustes → Dispositivos vinculados → Vincular dispositivo).
5. Checkpoint: escribir `ping kipi` al número → el bot responde "✅ conectado".

## Correr local (opcional, para probar)

```bash
npm install
cp .env.example .env   # poner OPENAI_API_KEY y tu número en ALLOWED_TESTERS
npm start
# abrir http://localhost:10000/qr
```

## Pruebas

Sin red y con BD temporal: `node test-<lo-que-sea>.js`. Las dos de la tanda del 17/08:

- `test-autogestion.js` — los interruptores que dejaron de vivir en Render: encender/apagar el bot (palabra escrita + ensayo previo para encender, un toque para apagar), número de avisos con prueba de envío real, números de prueba, los dos correos y el umbral de "Casero".
- `test-cuadre.js` — que ningún número cuente distinto que la lista a la que lleva (banner, tiles, embudo, Sheet), que sin precio no se cotice ni se confirme un Yape, que el monto se valide contra el partido que va a jugar y que el espejo a Sheets avise cuando muere o cuando corre una versión vieja del Apps Script.

## Siguientes semanas

- S3: panel admin + landing.
- S4: OCR de vouchers de Yape.
- S5: listas automáticas en el grupo.
- S6: inscripción por chat + recordatorios.
