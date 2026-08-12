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
      const link = z.groupLink
        ? `Link del grupo: ${z.groupLink}`
        : 'Link del grupo: AÚN NO CONFIGURADO — no inventes un link; dile que le envías el link del grupo en un momento.';
      return `${z.nombre} — S/ ${z.precio} por jugador\n${sedes}\n${link}`;
    })
    .join('\n\n');
}

function describirPartidos(negocio) {
  const abiertos = db.partidosAbiertos();
  if (!abiertos.length) {
    return 'No hay partidos con inscripción abierta cargados ahora mismo. Si alguien quiere inscribirse, dile que le confirmas el cupo en un momento (Clarck ve la notificación) y deja inscribir_partido en null.';
  }
  return abiertos.map((p) => {
    const precio = p.precio ?? negocio.zonas[p.zona]?.precio;
    const nombreZona = negocio.zonas[p.zona]?.nombre
      || ({ rimac: 'Rímac', chorrillos: 'Chorrillos' })[p.zona]
      || p.zona.charAt(0).toUpperCase() + p.zona.slice(1);
    return `- ID ${p.id}: ${db.fechaBonita(p.fecha)}${p.hora ? ` de ${p.hora}` : ''} en ${nombreZona}${p.sede ? ` (${p.sede})` : ''} · S/ ${precio ?? '?'} · ${p.restante > 0 ? `${p.restante} cupos libres` : 'LLENO — solo lista de espera'}`;
  }).join('\n')
  + '\n\nAl mencionar un partido usa la fecha tal cual está arriba ("MAÑANA miércoles 12 de agosto") — NUNCA el formato 2026-08-12. Los IDs son solo para inscribir_partido: NUNCA los menciones en el reply.';
}

function buildSystemPrompt(lead) {
  const negocio = db.getNegocio(); // se lee fresco en cada mensaje: precios/sedes se editan sin redesplegar
  const faltantes = [];
  if (!lead.nombre) faltantes.push('nombres y apellidos');
  if (!lead.edad) faltantes.push('edad');
  if (!lead.distrito) faltantes.push('distrito(s) donde quiere jugar');

  return `Eres el asistente de WhatsApp de ${negocio.marca}, la comunidad de pichangas (fútbol amateur) de Clarck en Lima. Respondes EN NOMBRE de la marca, como si fueras parte del equipo.

## Tono (definido por Clarck)
- Amigable SIN jergas, alentador, alegre. Modismos típicos del fútbol sin saturar (ej. "crack" muy de vez en cuando, "nos vemos en la cancha").
- Mensajes cortos, estilo WhatsApp. Emojis con moderación, de este set: ${negocio.emojis.join(' ')}
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
5. Zona "otra": dile que por ahora estamos en ${Object.values(negocio.zonas).map((z) => z.nombre).join(', ')}, que lo anotamos en la lista para avisarle cuando abramos su zona, y pregúntale si igual quiere unirse a alguno de los grupos actuales.

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

Datos ya registrados de este contacto: nombre=${lead.nombre || '—'}, edad=${lead.edad || '—'}, distrito=${lead.distrito || '—'}, zona=${lead.zona || '—'}, estado=${lead.estado}.`;
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
    ...historial.map((m) => ({ role: m.rol === 'user' ? 'user' : 'assistant', content: m.texto })),
    { role: 'user', content: textoUsuario },
  ];

  try {
    const completion = await openai.chat.completions.create({
      model: MODEL,
      messages,
      response_format: { type: 'json_schema', json_schema: buildSchema(Object.keys(db.getNegocio().zonas)) },
      temperature: 0.6,
      // 2000, no 600: los modelos "pensantes" (Gemini flash) gastan tokens en
      // razonar ANTES del JSON — con 600 el JSON salía cortado a media cadena
      // ("Unterminated string") y el bot pedía disculpas. Para gpt-4o-mini es
      // solo un tope, no un costo.
      max_tokens: 2000,
      // Gemini acepta reasoning_effort y con 'low' responde más rápido sin
      // perder calidad en esta tarea; OpenAI clásico no lo soporta — solo se
      // manda cuando el proveedor es Google.
      ...((process.env.OPENAI_BASE_URL || '').includes('googleapis') ? { reasoning_effort: 'low' } : {}),
    });
    fallosSeguidos = 0;
    return JSON.parse(completion.choices[0].message.content);
  } catch (e) {
    console.error('[brain] Error llamando a OpenAI:', e.message);
    registrarFalloCerebro(e);
    return null;
  }
}

module.exports = {
  pensar,
  cerebroActivo: () => Boolean(process.env.OPENAI_API_KEY),
  // Para GET /: "activo" es que HAY api key; "fallosSeguidos" dice si de verdad
  // está respondiendo (0 = sano). La lección del mes mudo, aplicada al cerebro.
  estadoCerebro: () => ({ activo: Boolean(process.env.OPENAI_API_KEY), fallosSeguidos }),
};
