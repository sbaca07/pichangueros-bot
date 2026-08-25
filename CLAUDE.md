# CLAUDE.md — pichangueros-bot

Bot de WhatsApp + CRM para Pichangueros (Clarck Valentín, Lima). Organiza
pichangas de fútbol amateur: capta jugadores por WhatsApp, cobra por Yape,
arma las listas y lleva la caja de cada partido.

Repo propio: `sbaca07/pichangueros-bot`. Vive dentro de `proyecto-pichangueros/`
pero está gitignoreado por el repo `kipi` — son dos repos distintos, y cada
cambio se commitea en el suyo.

## Cómo mirar producción

```bash
# Salud (público, sin key)
curl -s https://pichangueros-bot.onrender.com/ | head -c 400
```

Para mirar los datos: bajar una COPIA de la base y leerla en local. Nunca se
consulta la base de producción en vivo ni se escribe SQL contra ella.

```bash
# La ADMIN_KEY sale de las env vars de Render (la API key está en ~/.render-key)
curl -s "https://pichangueros-bot.onrender.com/admin/backup-db?key=$ADMIN_KEY" -o copia.db
node -e "const {DatabaseSync}=require('node:sqlite'); const db=new DatabaseSync('copia.db'); …"
```

**Borrar la copia al terminar**: son las conversaciones de 1,100 personas.

Para ESCRIBIR en producción se usan las rutas del panel (`POST /admin/…`) con
la ADMIN_KEY, nunca UPDATE directo: así pasa por las validaciones que ya
existen y queda el mismo rastro que si lo hubiera hecho Clarck.

## Servicio

| | |
|---|---|
| Render | `srv-d8i7jfvlk1mc73fscnpg` · owner `tea-d52jrl15pdvs73fhqe50` |
| Panel | `/admin/leads?key=<ADMIN_KEY>` |
| Número | +51 967 870 413 (Cloud API en coexistencia vía **Dualhook**) |
| Deploy | push a `main` → autodeploy. Esperar `status: live` ANTES de decir que está hecho. |

## Las reglas que NO se revierten

Cada una costó un incidente. Si algo parece más simple sin ellas, es que se
está por repetir el incidente.

1. **La caja no miente.** "Pagado" significa que hay un Yape identificado. Una
   lista del grupo con el emoji 💰 NO alcanza: eso dice que le pagaron a
   Clarck, no que el sistema lo pueda probar. Marcar pagado sin Yape inventa
   plata en la caja del partido.
2. **El bot no crea partidos solo.** Crear un partido compromete a Clarck a
   pagar una cancha real. Los turnos fijos sí generan — porque esos los
   encendió él, y nacen APAGADOS a propósito.
3. **La fase del partido se calcula, no se guarda** (`db.fasePartido`). La
   columna `estado` quedó congelada. El panel no puede deducirla por su cuenta:
   si lo hace, cuenta una historia distinta a la del bot.
4. **La relación con el jugador se deriva** de pagos y partidos. No hay botones
   de etapa: todo lo que dependa de que alguien apriete algo quince veces por
   semana, no pasa.
5. **No se autocierran ni autoliquidan partidos.** Liquidar es una afirmación
   que solo puede hacer un humano.
6. **Convocar arma una lista con links `wa.me`; no manda mensajes.** Un envío
   masivo desde una cuenta que ya disparó alertas de salud es pedir un ban.
7. **Lo que es para el jugador se calla con el bot apagado; lo que es para
   Clarck sale siempre.**
8. **El corte operativo filtra las COLAS de trabajo, no los datos.** Nada se
   borra nunca: lo viejo deja de reclamar atención, y sigue consultable.
9. **Sin precio no se cotiza.** `precioDeZona` devuelve `null`, no `0`. Con
   cero, el bot regalaba la pichanga por escrito y validaba cualquier Yape.

## Trampas conocidas

- **Los grupos de WhatsApp NO llegan.** Cloud API no entrega mensajes de grupo
  (verificado: de las listas del 25 y 26 de agosto no llegó ninguna). Las
  listas se traen con el importador (`src/listas.js`), pegando el texto.
- **Identidades sin teléfono (BSUID).** Desde abril 2026 Meta manda
  `PE.187019082` en vez del número para quien tiene nombre de usuario y no está
  en la agenda. Se conserva CON las letras: pelado queda en un número de otra
  persona. Para responderles va `recipient`, no `to`.
- **No hay App Secret.** Dualhook no lo entrega (es compartido entre clientes,
  ticket 2026-08-11). En su lugar: ruta de webhook con token secreto +
  validación de identidad del payload. No es una tarea pendiente, es una
  decisión tomada.
- **Los avisos por WhatsApp pueden no llegar.** Cloud API rechaza texto libre
  fuera de la ventana de 24 h (error `131047`) y avisa tarde, por webhook. Por
  eso lo crítico sale también por correo.
- **La hora de un partido es `inicio_min` (número).** El texto `'8-9pm'` es
  presentación. Ese texto ya causó dos bugs: `'20:00'` leído como 8am.
- **Dónde VIVE ≠ dónde JUEGA.** `distrito` es texto libre (108 formas de
  escribir 40 distritos — ver `src/distritos.js`); `zona` es la cancha donde
  juega. Alguien de Surquillo puede jugar en Chorrillos.

## El mapa

| Archivo | Qué es |
|---|---|
| `index.js` | El cable: recibe, decide si contestar, orquesta. Los relojes (turnos, reservas vencidas). |
| `src/db.js` | **La fuente de verdad.** Esquema, migraciones, y toda la lógica de negocio. |
| `src/panel.js` | Todas las pantallas. Un archivo grande a propósito: es una sola app. |
| `src/brain.js` | El guion del bot (prompt). Los datos salen de la BD, nunca hardcodeados. |
| `src/pagos.js` | Lee el voucher y decide: confirmado, a revisar, o de otro. |
| `src/meta.js` | Cloud API: webhook de entrada, envío de salida. |
| `src/listas.js` | Importar la lista pegada del grupo. |
| `src/distritos.js` | Normalizar el texto libre del distrito. |
| `config/negocio.js` | **Referencia histórica del brief.** NO es la fuente viva. |

## Tests

18 archivos `test-*.js`, ~1,055 checks. Se corren sin red y con BD temporal.

```bash
for f in test-*.js; do node "$f"; done
```

**Antes de cualquier push**: la suite completa en verde. No hay excepción — un
test rojo es un rollback esperando ocurrir, y este sistema maneja plata ajena.

Los tests describen el comportamiento **en castellano y desde el negocio**
("el cupo se acaba de llenar, se va a espera"), no desde la implementación.
Cuando arreglás un bug, el test nuevo cuenta el bug: así el día que alguien lo
rompa de nuevo, el mensaje de fallo explica por qué existía.

## Estilo

- **Comentarios que explican el PORQUÉ**, no el qué. Si algo parece raro, el
  comentario dice qué pasó cuando no era raro.
- **Castellano** en comentarios, mensajes de commit y textos de pantalla.
- **Mensajes de commit**: qué problema resuelve y por qué esa solución. El
  título en minúsculas, sin punto, empezando por `pichangueros:`.
- **Nada de dependencias nuevas** sin una razón fuerte: el bot corre en un
  contenedor chico y `node:sqlite` nativo fue una decisión, no un accidente.
