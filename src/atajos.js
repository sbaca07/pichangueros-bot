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

/**
 * La parrilla de partidos abiertos, agrupada por día — 17 líneas de golpe son
 * un menú de restaurante, no un chat. Por defecto solo los 2 días más
 * próximos; con completa=true, la semana entera (intención "semana").
 */
function textoParrilla({ completa = false } = {}) {
  const abiertos = db.partidosAbiertos(null, { vigentes: true });
  if (!abiertos.length) return null; // sin partidos cargados → que responda la IA
  const neg = db.getNegocio();

  const porDia = new Map();
  for (const p of abiertos) {
    if (!porDia.has(p.fecha)) porDia.set(p.fecha, []);
    porDia.get(p.fecha).push(p);
  }
  const fechas = [...porDia.keys()];
  const mostrar = completa ? fechas : fechas.slice(0, 2);
  const resto = abiertos.length - mostrar.reduce((n, f) => n + porDia.get(f).length, 0);

  const bloque = (fecha) => `⚽ *${db.fechaBonita(fecha)}*\n` + porDia.get(fecha).map((p) => {
    // Mismo precio que ve el bot, la lista del grupo y el validador de pagos.
    // Sin precio cargado NO se escribe "S/ 0": se dice que está por confirmar.
    const precio = db.precioDePartido(p);
    return `· ${p.hora ? `${p.hora} — ` : ''}${nombreZona(neg, p.zona)}${p.sede ? ` (${p.sede})` : ''} · ${precio != null ? `S/ ${precio}` : 'precio por confirmar'} · ${p.restante > 0 ? `${p.restante} cupos` : 'LLENO ⏳'}`;
  }).join('\n');

  return `${completa ? 'Todas las pichangas de la semana:' : 'Las pichangas más próximas:'}\n\n${mostrar.map(bloque).join('\n\n')}`
    + (resto > 0 ? `\n\n📅 Hay ${resto} pichangas más en la semana — escribe *semana* para verlas todas.` : '')
    + '\n\n¿A cuál te anoto? Dime el día y la zona 🙌';
}

function textoPrecios() {
  const neg = db.getNegocio();
  const porZona = new Map();
  for (const [z, datos] of Object.entries(neg.zonas)) {
    if (datos.precio) porZona.set(nombreZona(neg, z), datos.precio);
  }
  for (const p of db.partidosAbiertos(null, { vigentes: true })) {
    const n = nombreZona(neg, p.zona);
    const precio = db.precioDePartido(p);
    if (!porZona.has(n) && precio != null) porZona.set(n, precio);
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
    atajo: 'semana',
    prueba: (t) => /^((ver |toda |todas? )?la semana|semana( completa)?|todas las pichangas|todos los partidos)$/.test(t),
    responder: () => textoParrilla({ completa: true }),
  },
  {
    atajo: 'parrilla',
    // ANCLADO de punta a punta: sin ^$ , "que pasa si no llego al partido" o
    // "ya pague mi cupo hay algun problema" disparaban la parrilla y la IA
    // nunca veía la pregunta real (hallazgo del code review 2026-08-11).
    prueba: (t) =>
      /^(q|que|cuales|cuantas?|cuantos?) (pichangas?|partidos?|cupos?)( hay| tienes| tienen| quedan| disponibles)?( hoy| manana| esta semana| de la semana)?$/.test(t)
      || /^hay (pichangas?|partidos?|cupos?)( hoy| manana| esta semana| disponibles)?$/.test(t)
      || /^(pichangas?|partidos?)( de la semana| esta semana| hoy| disponibles)?$/.test(t),
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

/* ─────────────────────────────────────────────────────────────────────────
 * PEDIR CUPO SIN IA — la red de seguridad del 2026-09-08.
 *
 * Ese día el cerebro estuvo caído toda la mañana y el bot mandó 14 mensajes:
 * 11 disculpas y 3 "no pude leer esa imagen". Cero útiles. Los atajos de
 * arriba no amortiguaron nada porque están escritos para las preguntas del
 * que RECIÉN llega (precios, horarios, dónde queda) y el tráfico real es del
 * que YA juega: "para anotarme para las 21 hoy", "me apunto a la de hoy".
 *
 * Anotarse no necesita un modelo cuando no hay nada que interpretar: si el
 * jugador tiene zona y queda UN solo partido posible, es una regla. Es el
 * mismo criterio que ya usa `vincularPago` para no adivinar — con un único
 * candidato no hace falta pensar; con dos, no se elige.
 *
 * Esto NO reemplaza al cerebro: se usa cuando el cerebro no contestó, en vez
 * de la disculpa. Ante la menor duda devuelve null y sale la disculpa, que es
 * exactamente lo que pasaba antes.
 * ───────────────────────────────────────────────────────────────────────── */

// Pedir cupo, dicho de las formas en que la gente lo dice de verdad (sacadas
// de los mensajes del 1 al 8 de septiembre).
const PIDE_CUPO = /\b(anotam|anotame|anota|anotar|anotarme|apuntam|apuntame|apunta|apuntar|apuntarme|separam|separame|separa|separar|reservam|reservame|reservar|inscribeme|inscribirme|me sumo|me apunto|me anoto|ponme|pongame|un cupo|1 cupo)\b/;

// Todo lo que hace que el pedido DEJE de ser inconfundible. Cada grupo es un
// caso que necesita leer la conversación, no una regla:
//   - acompañantes: cuántos cupos son se decide con la plata, no con el texto
//   - cambios y bajas: mover un cupo toca uno que ya existe
//   - pagos: ese camino es el del voucher, no éste
const NO_ES_SIMPLE = /\b(amig|pata|patas|hermano|brother|invitad|acompan|somos|con un|con dos|con mi|para dos|para tres|dos cupos|2 cupos|tres cupos|3 cupos|cambi|mover|mueve|muevo|pasame|pasar|bajar|bajo|cancel|anular|devol|ya pague|ya yapee|ya te yapee|transferi|espera|lista de espera)\b/;

/** Los minutos desde medianoche que puede querer decir una hora suelta. */
function minutosPosibles(hora, marca) {
  const h = Number(hora);
  if (!Number.isFinite(h) || h < 1 || h > 23) return [];
  if (h >= 13) return [h * 60];              // "21" no es ambiguo
  if (marca === 'am') return [h * 60];
  if (marca === 'pm') return [(h % 12 + 12) * 60];
  // "a las 9" sin marca: puede ser 9am o 9pm. Se devuelven las dos y que
  // decida el filtro — si calzan DOS partidos, no se elige ninguno.
  return [h * 60, (h % 12 + 12) * 60];
}

/**
 * La hora que pidió, en minutos desde medianoche. null = no dijo ninguna.
 *
 * Se trabaja SIEMPRE contra `inicio_min`, nunca contra el texto de la hora:
 * el string '8-9pm' es presentación y ya causó dos bugs ('20:00' leído como
 * las 8 de la mañana).
 */
function horasPedidas(t) {
  // "a las 9", "las 9pm", "9 pm", "de 8 a 9", "8-9", "turno de 9"
  const m = t.match(/(?:a las|las|de|turno de|turno)\s*(\d{1,2})\s*(?:a|-|\/)\s*(\d{1,2})\s*(am|pm)?/)
    || t.match(/(?:a las|las|turno de|para las)\s*(\d{1,2})\s*(am|pm)?/)
    || t.match(/\b(\d{1,2})\s*(pm|am)\b/);
  if (!m) return null;
  // En el formato "8 a 9" la hora que vale es la de INICIO (la primera).
  const marca = m[3] || (m[2] === 'am' || m[2] === 'pm' ? m[2] : null);
  const posibles = minutosPosibles(m[1], marca);
  return posibles.length ? posibles : null;
}

const DIAS = ['domingo', 'lunes', 'martes', 'miercoles', 'jueves', 'viernes', 'sabado'];

/** El día que pidió, como filtro sobre un partido. null = no dijo ninguno. */
function filtroDeDia(t, hoy) {
  if (/\bhoy\b|\besta noche\b/.test(t)) return (p) => p.fecha === hoy;
  if (/\bmanana\b/.test(t)) {
    // Mediodía UTC para que sumar un día no se cruce con husos ni horarios de verano.
    const manana = new Date(`${hoy}T12:00:00Z`);
    manana.setUTCDate(manana.getUTCDate() + 1);
    const fecha = manana.toISOString().slice(0, 10);
    return (p) => p.fecha === fecha;
  }
  const dia = DIAS.findIndex((d) => new RegExp(`\\b(el |este |para el )?${d}\\b`).test(t));
  if (dia >= 0) return (p) => new Date(`${p.fecha}T12:00:00Z`).getUTCDay() === dia;
  return null;
}

/**
 * ¿Este mensaje es un pedido de cupo que se puede resolver sin leer nada más?
 *
 * @returns {null | {partidoId: number, respuesta: string, atajo: string}}
 *          null → no está claro; que lo resuelva la IA (o Clarck).
 */
function pedidoDeCupo(lead, texto) {
  const t = limpiar(texto);
  if (!t || t.length > 80) return null;      // largo = contexto = IA
  if (!PIDE_CUPO.test(t) || NO_ES_SIMPLE.test(t)) return null;

  // SIN ZONA NO HAY NADA QUE HACER: no sabemos ni en qué cancha juega ni
  // cuánto le sale. Es el mismo agujero que deja a 488 fichas sin precio.
  if (!lead?.zona || lead.zona === 'otra') return null;

  let candidatos = db.partidosAbiertos(lead.zona, { vigentes: true }).filter((p) => p.restante > 0);
  if (!candidatos.length) return null;       // ni "no hay": que lo diga la IA con contexto

  const hoy = db.hoyLima();
  const porDia = filtroDeDia(t, hoy);
  if (porDia) candidatos = candidatos.filter(porDia);
  const horas = horasPedidas(t);
  if (horas) candidatos = candidatos.filter((p) => horas.includes(p.inicio_min));

  // LA REGLA ENTERA: uno solo, o ninguno. Con dos candidatos el bot elegiría
  // por el orden de la lista, y meter a alguien en el partido de otro día es
  // el error que ya costó plata el 15/08.
  if (candidatos.length !== 1) return null;

  const p = candidatos[0];
  const precio = db.precioDePartido(p);
  if (precio == null) return null;           // sin precio no se cotiza

  const neg = db.getNegocio();
  const min = db.reservaMinutos();
  const respuesta = `¡Listo! Te guardo un cupo ⚽\n\n`
    + `📅 ${db.fechaBonita(p.fecha)}${p.hora ? ` · ${p.hora}` : ''}\n`
    + `📍 ${nombreZona(neg, p.zona)}${p.sede ? ` (${p.sede})` : ''}\n`
    + `💰 S/ ${precio} por jugador\n\n`
    // El cupo guardado NO es una confirmación, y eso el jugador lo tiene que
    // saber ANTES, no cuando se lo sacaron: sin Yape identificado no hay
    // "pagado" en ninguna lista.
    + `Yapea al ${neg.yape.numero} (${neg.yape.titular}) y quedas confirmado en la lista`
    + (min > 0 ? ` 🙏 Te lo guardo ${min} min.` : ' 🙏');
  return { partidoId: p.id, respuesta, atajo: 'cupo' };
}

module.exports = { responder, pedidoDeCupo };
