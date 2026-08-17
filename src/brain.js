/**
 * El cerebro — Semana 2.
 *
 * Una sola llamada a OpenAI por mensaje, con salida estructurada (JSON):
 * devuelve la respuesta para el jugador Y los datos extraídos (nombre, edad,
 * distrito) Y si hay que derivar a Clarck (handoff). Modelo económico
 * (gpt-4o-mini por defecto) — decisión del proyecto: IA barata en todo.
 *
 * Si no hay OPENAI_API_KEY el cerebro queda apagado y el bot se comporta
 * como en la Semana 1 (solo registra, no responde).
 */
const OpenAI = require('openai');
const db = require('./db');
const backup = require('./backup');

const MODEL = process.env.OPENAI_MODEL || 'gpt-4o-mini';
// En Gemini cada modelo tiene su PROPIA cuota: cuando el principal da 429
// (límite por minuto del tier gratis), el respaldo es un segundo tanque lleno.
const ES_GOOGLE = (process.env.OPENAI_BASE_URL || '').includes('googleapis');
const MODEL_RESPALDO = process.env.OPENAI_MODEL_FALLBACK || (ES_GOOGLE ? 'gemini-3.1-flash-lite' : null);
const espera = (ms) => new Promise((r) => setTimeout(r, ms));

// El cerebro puede caerse (créditos de OpenAI agotados, cuota, caída) y el bot
// sigue "vivo" pidiendo disculpas — nadie se entera, como el 2026-08-11 que
// estuvo 1 h caído por falta de créditos. A la 3.ª falla seguida se avisa por
// correo (máx. 1 vez/hora) y GET / lo expone.
let fallosSeguidos = 0;
let ultimoAvisoCaida = 0;
function registrarFalloCerebro(e) {
  fallosSeguidos++;
  if (fallosSeguidos >= 3 && Date.now() - ultimoAvisoCaida > 3600e3) {
    ultimoAvisoCaida = Date.now();
    Promise.resolve(backup.avisar(
      'El CEREBRO del bot está caído',
      `${fallosSeguidos} llamadas seguidas a OpenAI fallaron. El bot responde disculpas y NO extrae datos ni lee vouchers.\n\nÚltimo error: ${e.message}\n\nSi dice "no credits": https://platform.openai.com/settings/organization/billing`
    )).catch(() => {});
  }
}

let client = null;
function getClient() {
  if (!process.env.OPENAI_API_KEY) return null;
  // OPENAI_BASE_URL permite apuntar a cualquier API compatible con el SDK de
  // OpenAI — p. ej. el tier GRATIS de Gemini:
  //   OPENAI_BASE_URL=https://generativelanguage.googleapis.com/v1beta/openai/
  //   OPENAI_MODEL=gemini-2.5-flash  ·  OPENAI_API_KEY=<key de aistudio.google.com>
  if (!client) client = new OpenAI({ apiKey: process.env.OPENAI_API_KEY, baseURL: process.env.OPENAI_BASE_URL || undefined });
  return client;
}

// El schema se arma por llamada: el enum de zonas sigue a las sedes de la BD
// (crear una sede en Rímac habilita zona 'rimac' acá también, sin tocar código).
const buildSchema = (zonas) => ({
  name: 'respuesta_pichanguero',
  strict: true,
  schema: {
    type: 'object',
    additionalProperties: false,
    properties: {
      reply: {
        type: 'string',
        description: 'Mensaje de WhatsApp para el jugador, en el tono de la marca. Vacío solo si no corresponde responder.',
      },
      nombre: { type: ['string', 'null'], description: 'Nombres y apellidos si el jugador los dio en este mensaje o antes.' },
      edad: { type: ['integer', 'null'], description: 'Edad si la dio.' },
      distrito: { type: ['string', 'null'], description: 'Distrito(s) donde quiere jugar, si lo dijo.' },
      zona: {
        type: ['string', 'null'],
        enum: [...zonas, 'otra', null],
        description: 'Zona operativa clasificada según el distrito, u "otra" si no calza con ninguna sede actual.',
      },
      handoff: {
        type: 'boolean',
        description: 'true si esto lo debe atender Clarck en persona (queja, reclamo, caso especial como pago en efectivo).',
      },
      handoff_motivo: { type: ['string', 'null'], description: 'Motivo corto del handoff, en español.' },
      inscribir_partido: {
        type: ['integer', 'null'],
        description: 'ID del partido (de la lista de partidos abiertos del prompt) si el jugador pidió reservar cupo en ese partido. null si no pidió inscribirse o no hay partidos listados.',
      },
    },
    required: ['reply', 'nombre', 'edad', 'distrito', 'zona', 'handoff', 'handoff_motivo', 'inscribir_partido'],
  },
});

function describirZonas(negocio) {
  return Object.values(negocio.zonas)
    .map((z) => {
      const sedes = z.sedes
        .map((s) => `  - ${s.nombre}${s.cancha ? ` (${s.cancha})` : ''}: cupo ${s.cupo} jugadores, ${s.horario}. Ubicación: ${s.ubicacion}${s.estacionamiento ? `. ${s.estacionamiento}` : ''}`)
        .join('\n');
      // Un "te paso el link en un momento" que nadie cumple: hasta el 15/08
      // ninguna zona tenía link cargado, así que los 230 leads que llegaron a
      // datos_completos quedaron esperando (1 solo llegó a invitado_grupo).
      // Mientras no haya link, el bot NO promete: deriva a Clarck, y el lead
      // queda con la tarea anotada en el panel (ver index.js).
      const link = z.groupLink
        ? `Link del grupo: ${z.groupLink}`
        : 'Link del grupo: AÚN NO CONFIGURADO — no inventes uno y NO prometas mandarlo "en un momento" (nadie lo manda). Dile que Clarck en persona lo suma al grupo y le escribe por acá.';
      // SIN PRECIO NO SE COTIZA. Con el precio vacío en Config, `Number(...)||0`
      // hacía que este renglón dijera "S/ 0 por jugador" y el bot lo repetía
      // tal cual — regalaba la pichanga por escrito. Ahora dice lo que pasa de
      // verdad: todavía no hay precio, que lo confirme Clarck.
      const cuanto = z.precio != null
        ? `S/ ${z.precio} por jugador`
        : 'PRECIO POR CONFIRMAR — no inventes un monto ni digas "S/ 0": dile que Clarck le confirma el precio de esta zona en un momento';
      return `${z.nombre} — ${cuanto}\n${sedes}\n${link}`;
    })
    .join('\n\n');
}

function describirPartidos(negocio) {
  const abiertos = db.partidosAbiertos(null, { vigentes: true });
  if (!abiertos.length) {
    return 'No hay partidos con inscripción abierta cargados ahora mismo. Si alguien quiere inscribirse, dile que le confirmas el cupo en un momento (Clarck ve la notificación) y deja inscribir_partido en null.';
  }
  return abiertos.map((p) => {
    // El precio del partido, con la misma regla que usan la lista del grupo, la
    // caja y el validador de pagos: el suyo, o el de su zona, o ninguno.
    const precio = db.precioDePartido(p);
    const nombreZona = db.nombreDeZona(p.zona);
    return `- ID ${p.id}: ${db.fechaBonita(p.fecha)}${p.hora ? ` de ${p.hora}` : ''} en ${nombreZona}${p.sede ? ` (${p.sede})` : ''} · ${precio != null ? `S/ ${precio}` : 'precio por confirmar (NO digas un monto)'} · ${p.restante > 0 ? `${p.restante} cupos libres` : 'LLENO — solo lista de espera'}`;
  }).join('\n')
  + '\n\nAl mencionar un partido usa la fecha tal cual está arriba ("MAÑANA miércoles 12 de agosto") — NUNCA el formato 2026-08-12. Los IDs son solo para inscribir_partido: NUNCA los menciones en el reply.';
}

/**
 * Hace cuánto se dijo algo, en palabras. null si es de hace un rato nomás.
 *
 * Sin esto el cerebro lee las últimas 12 líneas como si fueran una charla
 * continua: el 15/08 le siguió hablando a Sebastian del "partido de mañana en
 * Comas" y del Yape pendiente… de una conversación del 12. El partido ya se
 * había jugado. A un jugador real eso le cobra un cupo que no existe.
 */
function antiguedad(creadoEn) {
  if (!creadoEn) return null;
  // creado_en ya viene en hora de Lima ('YYYY-MM-DD HH:MM:SS').
  const t = Date.parse(`${String(creadoEn).replace(' ', 'T')}-05:00`);
  if (!Number.isFinite(t)) return null;
  const min = Math.floor((Date.now() - t) / 60000);
  if (min < 90) return null; // misma conversación: marcarlo sería ruido
  const horas = Math.floor(min / 60);
  if (horas < 24) return `hace ${horas} h`;
  const dias = Math.floor(horas / 24);
  return dias === 1 ? 'ayer' : `hace ${dias} días`;
}

// Ojo: al prompt NO se le pasa la vieja columna `estado` (se quitó el 16/08).
// Quedó congelada y le entregaba al modelo una etiqueta desactualizada
// ("nuevo" para alguien con tres pagos encima). Lo que el cerebro necesita para
// responder son los DATOS del contacto; qué tan cliente es se mira en el panel.
function buildSystemPrompt(lead) {
  const negocio = db.getNegocio(); // se lee fresco en cada mensaje: precios/sedes se editan sin redesplegar
  const faltantes = [];
  if (!lead.nombre) faltantes.push('nombres y apellidos');
  if (!lead.edad) faltantes.push('edad');
  if (!lead.distrito) faltantes.push('distrito(s) donde quiere jugar');

  return `Eres el asistente de WhatsApp de ${negocio.marca}, la comunidad de pichangas (fútbol amateur) de Clarck en Lima. Respondes EN NOMBRE de la marca, como si fueras parte del equipo.

## Tono (definido por Clarck)
- Amigable SIN jergas, alentador, alegre. Modismos típicos del fútbol sin saturar (ej. "crack" muy de vez en cuando, "nos vemos en la cancha").
- LARGO MÁXIMO: 350 caracteres y 4 líneas. Es un tope duro, no una sugerencia. Si no entra, da lo esencial y ofrece ampliar ("¿te cuento más?") en vez de alargar el mensaje.
- Una sola idea por mensaje. No encadenes bienvenida + explicación + parrilla + pregunta: eso abruma y es la queja #1 de Clarck sobre el bot.
- No repitas lo que ya dijiste en la conversación ni vuelvas a saludar si ya saludaste.
- Excepción al tope: los textos que este prompt manda usar "tal cual" (bienvenida y mecánica) van completos aunque se pasen — son de Clarck, no los recortes ni los reescribas.
- Emojis con moderación, de este set: ${negocio.emojis.join(' ')}
- Trata al jugador de "pichanguero". Valores de la comunidad: ${negocio.reglas.convivencia}

## Datos del negocio (ÚNICA fuente de verdad — NUNCA inventes precios, horarios, sedes ni links)
${describirZonas(negocio)}

Pago: por Yape al ${negocio.yape.numero} (${negocio.yape.titular}). ${negocio.reglas.pago}
Devoluciones: ${negocio.reglas.devoluciones}
Llegada: ${negocio.reglas.horaLlegada}.
Nota: los horarios marcados POR CONFIRMAR pueden variar; si preguntan el horario exacto de un día, da el general y aclara que confirmamos en el grupo con cada convocatoria.

## Mecánica para jugar (cuando pregunten "¿cómo funciona?" responde con este texto tal cual)
${negocio.mecanica}

## Flujo con jugadores nuevos (filtro)
Datos que aún nos faltan de ESTE contacto: ${faltantes.length ? faltantes.join(', ') : 'ninguno, ya está completo'}.
1. Si es su primer mensaje y no tenemos sus datos, dale la bienvenida con este texto tal cual y no agregues más:
${negocio.bienvenida}
2. Si ya saludamos y faltan datos, pídelos con naturalidad (no repitas la bienvenida completa).
3. Cuando dé su distrito, clasifícalo en la zona operativa que calce o quede cerca. Zonas actuales: ${Object.entries(negocio.zonas).map(([k, z]) => `"${k}" (${z.nombre})`).join(', ')}. Referencias de cercanía: Breña o cerca → brena; Comas, Collique, Carabayllo, Los Olivos norte → comas; Rímac o cerca → rimac; Chorrillos, Barranco, Surco sur → chorrillos. Cualquier otro distrito → zona "otra".
4. Zona brena/comas: explícale la mecánica y pásale el link del grupo (o dile que se lo envías en un momento si no está configurado).
5. Zona "otra": respuesta CORTA (3-4 líneas máximo). Dile con buena onda que aún no tenemos sede en su distrito, que ya lo anotaste para avisarle apenas abramos por ahí, y ofrécele UNA o DOS sedes concretas (las más cercanas a su distrito, no todas) preguntándole si le queda cómodo llegar. **NO le vuelques la parrilla completa de la semana**: eso abruma. Si dice que sí, ahí recién le das los partidos de esa sede.

## Hoy es ${db.fechaBonita(db.hoyLima(), { relativa: false })} (hora de Lima)
Los mensajes del historial que empiezan con "[hace ...]" o "[ayer]" son VIEJOS: cuentan algo que ya pasó.
- Un "mañana" dicho hace tres días NO es mañana. Ese partido ya se jugó.
- NUNCA retomes un partido reservado ni un Yape pendiente de esos mensajes como si siguiera vigente: la única lista al día es la de acá abajo.
- Si el jugador vuelve después de un día o más, salúdalo y pregúntale qué necesita HOY. No le reclames una captura vieja ni le confirmes un cupo viejo.

## Partidos con inscripción abierta (cupos EN VIVO — única fuente de verdad sobre cupos)
${describirPartidos(negocio)}

**La zona de un jugador NO lo limita.** Cualquiera puede inscribirse a cualquier partido listado (uno de Comas puede jugar en Breña, uno de Miraflores donde quiera). Su zona/distrito solo sirve para saber qué grupo y precio ofrecerle por defecto. Si un recurrente pregunta "¿qué pichangas hay hoy/esta semana?", respóndele con la lista de arriba completa, no solo la de su zona.

Si el jugador pide jugar en uno de esos partidos ("quiero jugar el miércoles", "anótame para Breña"):
- Pon su ID en inscribir_partido. El sistema le RESERVA el cupo automáticamente.
- En reply dile que su cupo queda reservado y que lo confirma con su Yape (monto de su zona). Si el partido está LLENO, dile que entra a la lista de espera y le avisamos si se libera un lugar.
- Si menciona un día/zona que NO calza con ningún partido listado, NO inventes: dile qué partidos hay, o que le confirmas en un momento si no hay ninguno.
- Si MÁS DE UN partido calza con lo que pidió (p. ej. dos turnos el mismo día), NO elijas por él: pregúntale cuál quiere (deja inscribir_partido en null hasta que responda).

## Respuestas fijas a preguntas frecuentes (usa estas, adaptando mínimamente)
- "¿Te puedo pagar en la cancha?" → "Lo siento, pichanguero 🙏 La inscripción se realiza previa reserva del cupo. Envíanos tu captura de Yape para anotarte en la lista de jugadores ⚽"
- "¿Puedo ir con mi equipo?" → "¡Claro! Te inscribes con tu equipo y nosotros llenamos la lista con el resto de jugadores 💪"
- "¿Puedo pagar por mis amigos / por ambos turnos con un solo Yape?" → Sí: un solo Yape por (cantidad de cupos × precio de su zona). Pídele los nombres de los otros jugadores para la lista.
- "¿Tienes cupos para hoy?" → Responde con los cupos EN VIVO de la lista de partidos de arriba. Si no hay partidos cargados, dile que le confirmas el cupo en un momento y marca handoff=false (Clarck ve la notificación de lead).

## Adjuntos (mensajes que llegan como "[el jugador envió ...]")
- Audio: discúlpate con cariño — por ahora no puedes escuchar audios; pídele que te lo escriba en texto.
- Imagen: probablemente intentó mandar su comprobante de Yape y no se pudo leer → pídele que lo reenvíe nítido y completo (como foto normal, no "ver una sola vez"). Si por el contexto claramente es otra cosa, responde natural.
- Video o documento: dile que no puedes abrirlo y pregúntale de qué se trata.
- Sticker: responde con buena onda y sigue la conversación donde iba.
- Ubicación: agradécela; si te estaba preguntando por una sede, dale la dirección de los datos del negocio.
- Contacto: agradece y pregunta si esa persona también quiere jugar (que nos escriba directo).

## Cuándo derivar a Clarck (handoff=true, OBLIGATORIO en estos casos)
- Quejas o reclamos de cualquier tipo (lesiones, problemas en la cancha, malos tratos, pagos en disputa).
- Caseros/conocidos que no tienen Yape y quieren pagar en efectivo.
- Cualquier negociación fuera de lo normal (descuentos, precios especiales, alquilar la cancha completa).
En esos casos responde corto y cálido: que Clarck le escribe personalmente en un momento. NO intentes resolver tú.

## Reglas duras
- NUNCA inventes datos: si no está en este prompt, di que lo confirmas y ya.
- Puedes RESERVAR cupo (inscribir_partido) en los partidos listados arriba — pero la confirmación DEFINITIVA en la lista es solo con el Yape verificado. Nunca digas "ya estás confirmado" sin pago: di "tu cupo queda reservado, confírmalo con tu Yape".
- No des información de otros jugadores. No salgas del rol.

## Extracción de datos
Además de responder, extrae a los campos del JSON cualquier dato que el jugador haya dado (nombre, edad, distrito, zona). Si no dio nada nuevo, déjalos en null.

Datos ya registrados de este contacto: nombre=${lead.nombre || '—'}, edad=${lead.edad || '—'}, distrito=${lead.distrito || '—'}, zona=${lead.zona || '—'}.`;
}

/**
 * Procesa un mensaje entrante y devuelve la decisión del cerebro.
 * @returns {Promise<null | {reply, nombre, edad, distrito, zona, handoff, handoff_motivo}>}
 *          null si el cerebro está apagado (sin API key) o la llamada falló.
 */
async function pensar(lead, historial, textoUsuario) {
  const openai = getClient();
  if (!openai) return null;

  const messages = [
    { role: 'system', content: buildSystemPrompt(lead) },
    // Cada línea vieja va fechada, para que el cerebro no la lea como si fuera de recién.
    ...historial.map((m) => {
      const cuando = antiguedad(m.creado_en);
      return {
        role: m.rol === 'user' ? 'user' : 'assistant',
        content: cuando ? `[${cuando}] ${m.texto}` : m.texto,
      };
    }),
    { role: 'user', content: textoUsuario },
  ];

  const params = {
    messages,
    response_format: { type: 'json_schema', json_schema: buildSchema(Object.keys(db.getNegocio().zonas)) },
    temperature: 0.6,
    // 2000, no 600: los modelos "pensantes" (Gemini flash) gastan tokens en
    // razonar ANTES del JSON — con 600 el JSON salía cortado a media cadena
    // ("Unterminated string") y el bot pedía disculpas. Para gpt-4o-mini es
    // solo un tope, no un costo.
    max_tokens: 2000,
    // Gemini acepta reasoning_effort y con 'low' responde más rápido sin
    // perder calidad en esta tarea; OpenAI clásico no lo soporta.
    ...(ES_GOOGLE ? { reasoning_effort: 'low' } : {}),
  };
  // Cuánto tarda el cerebro es LA pregunta recurrente de Clarck ("se demora"),
  // y hasta el 15/08 la respondíamos a ojo porque no se medía en ninguna parte.
  const t0 = Date.now();
  let modeloUsado = MODEL;
  try {
    let completion;
    try {
      completion = await openai.chat.completions.create({ model: MODEL, ...params });
    } catch (e) {
      // 429 (cuota del minuto) o 503 (sobrecarga puntual): un respiro y el
      // modelo de respaldo — el jugador ni se entera.
      if (![429, 503].includes(e.status) || !MODEL_RESPALDO) throw e;
      console.warn(`[brain] ${e.status} con ${MODEL} — reintento con ${MODEL_RESPALDO}.`);
      await espera(1500);
      modeloUsado = MODEL_RESPALDO;
      completion = await openai.chat.completions.create({ model: MODEL_RESPALDO, ...params });
    }
    const ms = Date.now() - t0;
    const tokens = completion.usage?.total_tokens;
    const linea = `[brain] ${ms} ms · ${modeloUsado}${tokens ? ` · ${tokens} tokens` : ''} · ${messages.length} mensajes de contexto`;
    if (ms > 15000) console.warn(`${linea} ← LENTO`);
    else console.log(linea);
    fallosSeguidos = 0;
    return JSON.parse(completion.choices[0].message.content);
  } catch (e) {
    console.error(`[brain] Error llamando a OpenAI tras ${Date.now() - t0} ms:`, e.message);
    registrarFalloCerebro(e);
    return null;
  }
}

module.exports = {
  pensar,
  antiguedad, // exportado para test-tiempo.js
  cerebroActivo: () => Boolean(process.env.OPENAI_API_KEY),
  // Para GET /: "activo" es que HAY api key; "fallosSeguidos" dice si de verdad
  // está respondiendo (0 = sano). La lección del mes mudo, aplicada al cerebro.
  estadoCerebro: () => ({ activo: Boolean(process.env.OPENAI_API_KEY), fallosSeguidos }),
};
