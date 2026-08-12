/**
 * Capa rápida — el "embudo" (2026-08-11).
 *
 * Responde SIN IA los mensajes inconfundibles (saludo de un nuevo, precios,
 * horarios, parrilla de partidos, ubicación, cómo funciona) con plantillas
 * armadas desde la BD. Todo lo demás devuelve null y sigue al cerebro.
 *
 * Por qué: velocidad (ms en vez de segundos), resiliencia (esto sigue vivo
 * aunque OpenAI se caiga — como el 2026-08-11 por falta de créditos) y de
 * paso ~la mitad de las llamadas de IA.
 *
 * Regla de oro: ANTE LA MENOR DUDA, null (que decida la IA). Un atajo solo
 * dispara con mensajes cortos que calzan exactos — nunca adivina.
 */
const db = require('./db');

const limpiar = (t) => (t || '')
  .toLowerCase()
  .normalize('NFD').replace(/[̀-ͯ]/g, '')
  .replace(/[¿?¡!.,;:()"'*_~]/g, ' ')
  .replace(/\s+/g, ' ')
  .trim();

const nombreZona = (neg, z) =>
  neg.zonas[z]?.nombre || ({ rimac: 'Rímac', chorrillos: 'Chorrillos' })[z] || (z ? z[0].toUpperCase() + z.slice(1) : z);

/** La parrilla de partidos abiertos, armada desde la BD (misma data que ve la IA). */
function textoParrilla() {
  const abiertos = db.partidosAbiertos();
  if (!abiertos.length) return null; // sin partidos cargados → que responda la IA
  const neg = db.getNegocio();
  const lineas = abiertos.map((p) =>
    `⚽ ${db.fechaBonita(p.fecha)}${p.hora ? ` · ${p.hora}` : ''} — ${nombreZona(neg, p.zona)}${p.sede ? ` (${p.sede})` : ''} · S/ ${p.precio ?? neg.zonas[p.zona]?.precio ?? '?'} · ${p.restante > 0 ? `${p.restante} cupos` : 'LLENO ⏳'}`
  );
  return `Estas son las pichangas con inscripción abierta:\n\n${lineas.join('\n')}\n\n¿A cuál te anoto? Dime el día y la zona 🙌`;
}

function textoPrecios() {
  const neg = db.getNegocio();
  const porZona = new Map();
  for (const [z, datos] of Object.entries(neg.zonas)) {
    if (datos.precio) porZona.set(nombreZona(neg, z), datos.precio);
  }
  for (const p of db.partidosAbiertos()) {
    const n = nombreZona(neg, p.zona);
    if (!porZona.has(n) && p.precio) porZona.set(n, p.precio);
  }
  if (!porZona.size) return null;
  const lineas = [...porZona].map(([n, precio]) => `⚽ ${n}: S/ ${precio} por jugador`);
  return `${lineas.join('\n')}\n\nPago por Yape al ${neg.yape.numero} (${neg.yape.titular}). Un solo Yape puede cubrir varios cupos (amigos o dos turnos) 💪`;
}

function textoHorarios() {
  const sedes = db.listSedes();
  const conHorario = sedes.filter((s) => s.horario);
  if (!conHorario.length) return null;
  const neg = db.getNegocio();
  return `Nuestros horarios:\n\n${conHorario.map((s) => `⚽ ${nombreZona(neg, s.zona)} — ${s.nombre}: ${s.horario}`).join('\n')}\n\n¿Te paso las pichangas de esta semana con cupos? Pregúntame "¿qué pichangas hay?" 🙌`;
}

function textoUbicacion() {
  const sedes = db.listSedes();
  if (!sedes.length) return null;
  const neg = db.getNegocio();
  return `Jugamos acá:\n\n${sedes.map((s) => `📍 ${nombreZona(neg, s.zona)} — ${s.nombre}${s.ubicacion ? `\n   ${s.ubicacion}` : ''}`).join('\n')}`;
}

// Cada intención: patrón inconfundible + generador de respuesta.
const INTENCIONES = [
  {
    atajo: 'parrilla',
    prueba: (t) => /\b(que|cuales|hay)\b.*\b(pichangas?|partidos?|cupos?)\b|\b(pichangas?|partidos?|cupos?)\b.*\bhay\b|^(pichangas?|partidos?)( de la semana| esta semana| hoy)?$/.test(t),
    responder: () => textoParrilla(),
  },
  {
    atajo: 'precios',
    prueba: (t) => /^(precios?|costos?|tarifas?)$|^(cuanto (cuesta|es|sale|vale))( jugar| la pichanga| el partido| la entrada)?$/.test(t),
    responder: () => textoPrecios(),
  },
  {
    atajo: 'horarios',
    prueba: (t) => /^(horarios?|a que hora( juegan| es| son)?|que horarios( hay| tienen)?)$/.test(t),
    responder: () => textoHorarios(),
  },
  {
    atajo: 'ubicacion',
    prueba: (t) => /^(donde (queda|quedan|es|juegan|estan)|ubicacion|direccion|donde)( la cancha| las canchas| las sedes)?$/.test(t),
    responder: () => textoUbicacion(),
  },
  {
    atajo: 'mecanica',
    prueba: (t) => /^(como funciona( esto)?|como es( la dinamica| esto)?|como juego|como me inscribo|como participo)$/.test(t),
    responder: () => db.getNegocio().mecanica || null,
  },
];

// Con typos comunes incluidos (aloh, olaa, holq…): un saludo mal tipeado
// sigue siendo inconfundible.
const SALUDO = /^(hola+|holaa+|holq|buenas+|buenos dias|buenas tardes|buenas noches|hey+|alo+h?|ola+|que tal|hi|hello)( hola)?( amigos?| bro| causa| pichangueros?| que tal| buenas)?$/;

/**
 * @returns {null | {respuesta: string, atajo: string}} null → que decida la IA.
 */
function responder(lead, texto) {
  const t = limpiar(texto);
  if (!t || t.length > 60) return null; // largo = contexto = IA

  // Saludo de un contacto SIN datos → la bienvenida fija de Config (es el
  // mismo texto que la IA está instruida a mandar tal cual). Si ya lo
  // conocemos, saluda la IA (personaliza con su nombre e historial).
  if (SALUDO.test(t) && !lead.nombre) {
    const bienvenida = db.getNegocio().bienvenida;
    if (bienvenida) return { respuesta: bienvenida, atajo: 'bienvenida' };
  }

  for (const intent of INTENCIONES) {
    if (intent.prueba(t)) {
      const respuesta = intent.responder();
      if (respuesta) return { respuesta, atajo: intent.atajo };
      return null; // sin data para responder → IA
    }
  }
  return null;
}

module.exports = { responder };
