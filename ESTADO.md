# Estado del sistema — 18 de agosto de 2026

Foto del proyecto al cierre de la sesión del 13 al 18 de agosto. Para retomar
sin tener que releer 20 commits.

> **24/08**: entraron los datos que faltaban de Clarck — los cuatro links de
> grupo y el costo de las cuatro canchas — cargados en producción desde el
> panel (Config), no en código. Ver "Lo que falta" acá abajo. Ese mismo día el
> cupo guardado sin pagar dejó de ser eterno: ver "El cupo se guarda, no se
> regala".

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
1. ~~Los cuatro links de grupo.~~ **Cargados el 24/08** (Clarck los pasó por
   WhatsApp el 20/08). Los cuatro se verificaron uno por uno contra
   `chat.whatsapp.com` antes de guardarlos: los cuatro responden 200 y el
   título del grupo coincide con su zona. Desde ahora el guion del bot los
   dicta y la ficha del lead muestra el botón de mandar el link.
2. ~~El costo de alquiler de 4 canchas.~~ **Cargado el 24/08**: Breña 150,
   Rímac 120, Chorrillos 100, Comas 70 por partido. La caja ya dice cuánto
   queda, no solo cuánto entró.
3. **Encender el bot.** El interruptor ya es suyo. Es lo único que falta.

Con eso, el margen por partido a cupo lleno queda así: Chorrillos S/ 110,
Rímac S/ 104, Breña S/ 60, Comas S/ 50. Comas es la zona que menos deja y la
única con 12 cupos en vez de 14.

**Decisiones abiertas:**
- El umbral de "Casero" está en 6 visitas y el jugador que más vino tiene 5, así
  que ese filtro muestra cero. Se baja desde Ajustes.
- `META_APP_SECRET` sin setear: el webhook no valida firma. Hoy lo protege una
  ruta secreta, que no es lo mismo.
- El CRM renderiza los 953 leads de una (≈650 KB por carga).

## El cupo se guarda, no se regala (24/08)

Cuando alguien le dice "anótame" al bot, el lugar queda **guardado 60 minutos**
(editable en Ajustes → Cupos guardados; con 0 vuelve a ser eterno). Si no llega
el Yape, un reloj cada 5 minutos lo libera y sube al primero de la lista de
espera.

Lo que motivó el cambio: la regla que escribió Clarck es "la inscripción es
previa reserva por Yape", pero el bot reservaba sin plata y ese lugar no
caducaba nunca. En agosto quedaron 4 reservas sin pago ocupando cancha. Para el
sistema la lista estaba llena; en la cancha faltaba gente, y al que sí iba a
pagar el bot le decía que no había cupo.

Detalles que conviene no perder:

- **Lo que anota Clarck a mano no vence** (`inscribir(..., { vence: false })`).
  Atrás hay una persona mirando la lista, no una promesa de chat.
- **Un Yape en "revisar" protege el cupo.** El comprobante llegó; lo que falta
  es que alguien lo mire. Vencerle la reserva a quien ya pagó es el peor de los
  dos errores posibles.
- **Un partido que ya empezó no se toca.** A esa altura el lugar no se revende
  y quien decide es Clarck en la cancha.
- **Al que sube de la espera sin haber pagado le arranca su propio plazo**; si
  no, un lugar liberado se vuelve a bloquear para siempre.
- **Liberar el cupo pasa aunque el bot esté apagado** (es un cambio en la base:
  si no, la lista miente igual). Los mensajes al jugador NO salen con el bot
  apagado; el aviso a Clarck sí, como todo lo suyo.

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
