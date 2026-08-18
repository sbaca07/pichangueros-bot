# Estado del sistema — 18 de agosto de 2026

Foto del proyecto al cierre de la sesión del 13 al 18 de agosto. Para retomar
sin tener que releer 20 commits.

## Producción ahora mismo

| | |
|---|---|
| Servicio | `pichangueros-bot` en Render (`srv-d8i7jfvlk1mc73fscnpg`) |
| Panel | `https://pichangueros-bot.onrender.com/admin/leads?key=<ADMIN_KEY>` |
| Número oficial | +51 967 870 413 (Cloud API en coexistencia vía Dualhook) |
| Contactos | 953 · 410 con datos completos · 127 derivados a Clarck |
| **El bot está APAGADO** | responde solo a los números de prueba; al resto lo registra en silencio |
| Cerebro | Gemini 3.1 flash-lite vía SDK de OpenAI · 0 fallos seguidos |
| Suite | 877 checks en 17 archivos `test-*.js` |

**El interruptor del bot ya no vive en Render**: está en el panel (Ajustes →
"Encender el bot"). La variable `SAFE_MODE` es solo el valor inicial; en cuanto
alguien toca el panel, manda la base. Encender pide escribir `ENCENDER` y tildar
el ensayo previo; apagar es un botón, también en el Resumen. Queda registrado
quién (IP) y cuándo — el 17/08 a las 21:04 alguien lo encendió desde
`38.25.18.130`, le respondió a un jugador y lo apagó 14 minutos después.

## Lo que falta, y de quién depende

**De Clarck (no es código):**
1. **Los cuatro links de grupo.** Ninguna zona los tiene. Es el paso donde un
   interesado se vuelve jugador y hoy convierte 1 de cada 230. El panel se los
   pide en la primera pantalla, con link al campo exacto.
2. **El costo de alquiler de 4 canchas.** Sin eso la caja no puede decir cuánto
   queda, solo cuánto entró.
3. **Encender el bot.** El interruptor ya es suyo.

**Decisiones abiertas:**
- El umbral de "Casero" está en 6 visitas y el jugador que más vino tiene 5, así
  que ese filtro muestra cero. Se baja desde Ajustes.
- `META_APP_SECRET` sin setear: el webhook no valida firma. Hoy lo protege una
  ruta secreta, que no es lo mismo.
- El CRM renderiza los 953 leads de una (≈650 KB por carga).

## Decisiones de diseño que conviene NO revertir

- **La fase del partido se calcula, no se guarda.** `estado` quedó congelada y se
  escribe en paralelo solo como red de rollback. Cuando la transición esté
  confirmada, se puede dejar de escribir.
- **La relación con el jugador se deriva** de pagos y partidos. No hay botones de
  etapa a propósito: todo lo que dependa de que alguien apriete algo quince veces
  por semana, no pasa. `activo`/`inactivo` llevaban meses sin que nadie los tocara.
- **El bot no crea partidos solo.** Crear un partido compromete a Clarck a pagar
  una cancha real. Los turnos fijos sí generan, porque esos los escribió él.
- **Convocar genera una lista con links `wa.me`; no manda mensajes.** Un envío
  masivo desde una cuenta que ya disparó alertas de salud es pedir un ban.
- **No se autocierran ni autoliquidan partidos.** Liquidar es una afirmación que
  solo puede hacer un humano. La ventana de gracia de 24 h existe para que un
  Yape tardío se siga enganchando.
- **Lo que es para el jugador se calla; lo que es para Clarck sale siempre**,
  aunque el bot esté apagado. Así se juntaron 105 handoffs que nadie vio.

## Trampas conocidas

- **Los avisos por WhatsApp pueden no llegar.** Cloud API rechaza texto libre
  fuera de la ventana de 24 h (error `131047`) y el rechazo llega tarde, por
  webhook: desde el código, un aviso perdido se ve igual que uno entregado. Por
  eso lo crítico sale también por correo.
- **El correo de avisos cae en `kipienterprise@gmail.com`** (decisión del
  cliente). Se cambia desde Ajustes → Correos, que ahora está separado del correo
  del respaldo — ese adjunto lleva la conversación de 953 personas.
- **La hora de un partido es `inicio_min` (número); el texto `'8-9pm'` es solo
  presentación.** Ese texto ya causó dos bugs: `'20:00'` leído como 8am y
  `'11am-12pm'` como las 23. Si hay que tocar horarios, tocar el número.
- **El punto de arranque (`corte_operativo`) filtra las colas de trabajo, no los
  datos.** Está en 17/08. Si un contador no cuadra con su lista, casi siempre es
  que uno respeta el corte y el otro no.

## Cómo mirar producción

```bash
# Salud
curl -s https://pichangueros-bot.onrender.com/ | head -c 400

# Logs (RENDER_KEY en la nota de Sebas)
curl -s -H "Authorization: Bearer $RENDER_KEY" \
  "https://api.render.com/v1/logs?ownerId=tea-d52jrl15pdvs73fhqe50&resource=srv-d8i7jfvlk1mc73fscnpg&limit=50"

# Copia de la BD para probar migraciones sin tocar producción
curl -s "https://pichangueros-bot.onrender.com/admin/backup-db?key=$ADMIN_KEY" -o /tmp/p/data/pichangueros.db
WWEBJS_AUTH_PATH=/tmp/p node -e "const db=require('./src/db'); console.log(db.stats())"
```

**Regla que se ganó a los golpes:** antes de desplegar un cambio de esquema o de
migración, correrlo contra una copia de la base real. Los tests corren sobre
datos de juguete y ahí no aparecen los casos que sí importan — así se encontró
que 6 partidos con gente adentro quedaban fuera de toda cola, con 877 checks en
verde.

## Qué se hizo del 13 al 18 de agosto

Ordenado por lo que más cambió el negocio, no cronológicamente.

1. **Las dos quejas de Clarck**, medidas y resueltas: el bot respondía uno por
   uno a cada mensaje de una ráfaga (3 respuestas, 848 caracteres en 20 s) y
   tenía una pausa artificial de 1.5–3.5 s que le regalábamos a cada respuesta.
2. **El emparejador de pagos lee la conversación** cuando la aritmética no
   alcanza, y avisa cuando alguien pagó por un partido que nadie cargó.
3. **El CRM dejó de mentir**: la relación con el jugador se deriva de la plata,
   las visitas se cuentan por días con pago (antes solo por inscripciones, y la
   tabla `partidos` nació el 10/08 mientras los pagos vienen de julio, así que
   el filtro "Recurrentes" estaba vacío para todos).
4. **El partido dejó de tener un estado que mentía** y aparecieron los turnos
   fijos, que es lo único que evita vender lo que no está cargado.
5. **Clarck puede autogestionarse**: encender el bot, los avisos, los correos.
6. **El panel dejó de perderlo**: confirma cuando guarda y vuelve a donde estaba.
   Esa era la causa más probable de que las cuatro zonas siguieran sin link.
7. **Higiene**: contadores que cuadran, zonas sin precio que ya no confirman
   cualquier Yape, y el espejo a Sheets que avisa si se muere.

Ver el historial de `git log` — cada commit explica el problema que resolvió y
por qué, no solo qué tocó.
