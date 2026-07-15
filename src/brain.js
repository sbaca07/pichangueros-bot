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

const MODEL = process.env.OPENAI_MODEL || 'gpt-4o-mini';

let client = null;
function getClient() {
  if (!process.env.OPENAI_API_KEY) return null;
  if (!client) client = new OpenAI({ apiKey: process.env.OPENAI_API_KEY });
  return client;
}

const RESPONSE_SCHEMA = {
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
        enum: ['brena', 'comas', 'otra', null],
        description: 'Zona clasificada según el distrito: brena, comas, u otra si no calza con las sedes actuales.',
      },
      handoff: {
        type: 'boolean',
        description: 'true si esto lo debe atender Clarck en persona (queja, reclamo, caso especial como pago en efectivo).',
      },
      handoff_motivo: { type: ['string', 'null'], description: 'Motivo corto del handoff, en español.' },
    },
    required: ['reply', 'nombre', 'edad', 'distrito', 'zona', 'handoff', 'handoff_motivo'],
  },
};

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
3. Cuando dé su distrito: si es Breña o cerca → zona "brena"; si es Comas o cerca (Collique, Carabayllo, Los Olivos norte) → zona "comas"; cualquier otro → zona "otra".
4. Zona brena/comas: explícale la mecánica y pásale el link del grupo (o dile que se lo envías en un momento si no está configurado).
5. Zona "otra": dile que por ahora estamos en Breña y Comas, que lo anotamos en la lista para avisarle cuando abramos su zona, y pregúntale si igual quiere unirse a uno de los dos grupos actuales.

## Respuestas fijas a preguntas frecuentes (usa estas, adaptando mínimamente)
- "¿Te puedo pagar en la cancha?" → "Lo siento, pichanguero 🙏 La inscripción se realiza previa reserva del cupo. Envíanos tu captura de Yape para anotarte en la lista de jugadores ⚽"
- "¿Puedo ir con mi equipo?" → "¡Claro! Te inscribes con tu equipo y nosotros llenamos la lista con el resto de jugadores 💪"
- "¿Tienes cupos para hoy?" → No tienes acceso a la lista en vivo todavía: dile que le confirmas el cupo en un momento y marca handoff=false (Clarck ve la notificación de lead).

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
- NUNCA confirmes una reserva ni digas "ya estás en la lista" — eso requiere Yape verificado (aún no disponible por el bot).
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
      response_format: { type: 'json_schema', json_schema: RESPONSE_SCHEMA },
      temperature: 0.6,
      max_tokens: 600,
    });
    return JSON.parse(completion.choices[0].message.content);
  } catch (e) {
    console.error('[brain] Error llamando a OpenAI:', e.message);
    return null;
  }
}

module.exports = { pensar, cerebroActivo: () => Boolean(process.env.OPENAI_API_KEY) };
