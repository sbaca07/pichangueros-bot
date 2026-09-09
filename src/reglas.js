/**
 * La IA, de última instancia — responder por ESTADO (2026-09-08).
 *
 * Se leyeron los 12.719 mensajes que entraron en 30 días (906 personas) y la
 * conclusión fue incómoda: casi todo iba a la IA, y casi nada lo necesitaba.
 *
 *     38.7%  conversación libre            ← esto sí es IA
 *     12.9%  corto suelto (necesita contexto)
 *     12.5%  "gracias" / "ok" / "listo"
 *     11.6%  una foto (voucher)            ← esto sí es IA de visión
 *      7.8%  saludo pelado
 *      4.4%  audio / sticker / video
 *      3.9%  "anótame"
 *      2.3%  "ahí te yapeo"
 *
 * Lo revelador fue mirar QUÉ CONTESTA CLARCK a esos mensajes. Al mismo "ok" le
 * responde tres cosas distintas:
 *
 *     "Me pasas foto del yape porfa"   → al que tiene el cupo sin pagar
 *     "Anotado. Gracias!"              → al que ya está en la lista
 *     "Si se baja alguien te aviso"    → al que quedó en espera
 *
 * O sea que la respuesta no depende del TEXTO —"ok" no dice nada— sino del
 * ESTADO del jugador, que está en la base. Eso es una regla, no un modelo. Y
 * una regla no se cae, no cuesta tokens, contesta en milisegundos y sigue
 * viva el día que la IA se caiga (como el 8-sep a la mañana).
 *
 * Los textos de acá son los de Clarck, no inventados: se sacaron de sus
 * respuestas reales de esos 30 días.
 *
 * REGLA DE ORO, la misma que `atajos.js`: ante la menor duda, null. Un mensaje
 * que no calza exacto va a la IA. Este archivo no adivina nunca.
 */
const db = require('./db');

const limpiar = (t) => (t || '')
  .toLowerCase()
  .normalize('NFD').replace(/[̀-ͯ]/g, '')
  .replace(/[¿?¡!.,;:()"'*_~]/g, ' ')
  .replace(/\s+/g, ' ')
  .trim();

const primerNombre = (n) => (n || '').trim().split(/\s+/)[0] || '';

/** Los nombres de zona lindos, con la misma regla que usa el resto. */
const nombreZona = (z) => db.nombreDeZona(z) || z;

/** "el jueves 11 a las 9-10pm en Comas" — como lo diría Clarck. */
function cuandoYDonde(insc) {
  const cuando = db.fechaBonita(insc.fecha);
  return `${cuando}${insc.hora ? ` ${insc.hora}` : ''} en ${nombreZona(insc.zona)}`;
}

/**
 * Cómo está el jugador AHORA: su próxima pichanga y en qué situación.
 * Es lo único que hace falta para contestar la mayoría de los mensajes.
 */
function situacion(numero) {
  const vigentes = db.inscripcionesVigentesDe(numero);
  const pagada = vigentes.find((i) => i.estado === 'pagado');
  const reservada = vigentes.find((i) => i.estado === 'reservado');
  const espera = vigentes.find((i) => i.estado === 'espera');
  if (pagada) return { que: 'pagado', insc: pagada };
  if (reservada) return { que: 'reservado', insc: reservada };
  if (espera) return { que: 'espera', insc: espera };
  return { que: 'nada', insc: null };
}

// ── Los intents, todos ANCLADOS de punta a punta ──────────────────────────
// Sin ^$ , "ya pagué mi cupo hay algún problema" dispararía el acuse y la IA
// nunca vería la pregunta real. Es el mismo error que costó el code review
// del 11-ago en atajos.js.

const ACUSE = /^(gracias|muchas gracias|ok|oka|okey|okay|listo|dale|ya|si|sip|claro|perfecto|esta bien|de acuerdo|bacan|excelente|ahi esta|ya esta|entendido|correcto|vale|va|chevere|genial|buenisimo)( (gracias|amigo|profe|bro|hermano|causa|manito|mano|crack|master|maestro|pues|papa|jefe))*$/;

// Con las abreviaturas que usa la gente de verdad. "bnas" llegó el 2026-09-09
// y se fue entera a la IA: las reglas solo cubrían el saludo bien escrito, que
// es justo el que casi nadie escribe. Sale del corpus de 30 días.
const SALUDO = /^(hola+|holaa+|hla|ola+|buenas+|bnas|bns|wenas|buenos dias|bnos dias|buenas tardes|buenas noches|buenas noxes|buen dia|hey+|alo+h?|que tal|q tal|k tal|ke tal|qtal|oe|hi|hello|saludos)( (amigo|amigos|amigazo|bro|causa|pata|profe|doc|jefe|maestro|crack|papi|compadre|mano|manito|hermano|pichangueros?|que tal|buenas|clarck))*$/;

// "¿hay para hoy?" es LA pregunta del negocio y hasta el 2026-09-09 se iba
// entera a la IA: el embudo viejo pedía frases exactas ("¿qué pichangas hay?")
// y agarraba 25 mensajes de 12.719. Esto agarra cómo se pregunta de verdad.
// Anclado de punta a punta: "hay algún problema con mi pago" no puede caer acá.
const PREGUNTA_CUPOS = /^((q|que|k|ke) )?(hay|habra|queda|quedan|tienes|tiene|tienen)( (algo|cupo|cupos|sitio|sitios|vacante|vacantes|espacio|pichanga|pichangas|partido|partidos|lugar|lugares))?( (pa|para|el|este|esta))?( (hoy|hoy dia|manana|noche|esta noche|semana|esta semana|lunes|martes|miercoles|jueves|viernes|sabado|domingo))?( (profe|amigo|causa|bro|jefe|maestro|crack|manito|hermano|pata|doc|compadre|amigazo))?$|^(pa|para) (hoy|hoy dia|manana|esta noche)$|^(q|que|k|ke) (hay|pichangas hay|partidos hay)( (pa|para))?( (hoy|manana))?$/;

const AVISA_QUE_PAGO = /^(ya |ahi |ahora |en un toque |ya te |ahi te |ahora te )?(te )?(yapeo|yapee|yapie|yapeare|mando el yape|paso el yape|transfiero|deposito)( (amigo|profe|bro|hermano|en un momento|en unos minutos|ahorita|ya|pues|manito))*$/;

/**
 * En qué cajón cae UNA línea. null = tiene contenido, esto es de la IA.
 *
 * El corte por largo va acá, sobre la línea suelta, no sobre la ráfaga entera:
 * tres "ok" seguidos suman más de 45 caracteres y seguían siendo tres "ok".
 */
function intentDe(t) {
  if (!t || t.length > 45) return null;
  if (AVISA_QUE_PAGO.test(t)) return 'yapeo';
  if (PREGUNTA_CUPOS.test(t)) return 'parrilla';
  if (SALUDO.test(t)) return 'saludo';
  if (ACUSE.test(t)) return 'acuse';
  return null;
}

/**
 * La parrilla, sin IA: qué hay y con cuántos cupos.
 *
 * Se arma de la BD, así que los cupos son los de VERDAD en este segundo —
 * ventaja sobre el modelo, que ve la foto del prompt. Si el jugador tiene zona
 * se le muestra la suya: mandarle las cuatro sedes a alguien de Comas es el
 * menú de restaurante que ya se había decidido no mandar.
 */
function textoParrilla(zona, cuando) {
  let abiertos = db.partidosAbiertos(zona || null, { vigentes: true }).filter((p) => p.restante > 0);
  if (cuando) abiertos = abiertos.filter((p) => p.fecha === cuando);
  if (!abiertos.length) return null;   // sin nada que ofrecer, que hable la IA

  // SOLO LOS DOS DÍAS MÁS PRÓXIMOS. Seis líneas de golpe son un menú de
  // restaurante, no un chat — la misma lección que ya estaba en atajos.js y
  // que esta función se saltó: el 2026-09-09, a un "hay" le contestó con seis
  // partidos hasta el lunes siguiente. Quien quiera ver todo pregunta.
  const dias = [...new Set(abiertos.map((p) => p.fecha))].slice(0, 2);
  const muestro = abiertos.filter((p) => dias.includes(p.fecha));
  const resto = abiertos.length - muestro.length;

  const lineas = muestro.map((p) => {
    const precio = db.precioDePartido(p);
    return `· ${db.fechaBonita(p.fecha)}${p.hora ? ` ${p.hora}` : ''} — ${nombreZona(p.zona)}`
      + `${precio != null ? ` (S/ ${precio})` : ''} · ${p.restante} ${p.restante === 1 ? 'cupo libre' : 'cupos libres'}`;
  });
  return `Estas son las que hay ⚽\n\n${lineas.join('\n')}`
    + (resto > 0 ? `\n\n📅 Y hay ${resto} más en la semana — dime qué día te sirve.` : '')
    + '\n\n¿A cuál te anoto? Dime el día y la hora 🙌';
}

/**
 * ¿Se puede contestar esto sin IA?
 *
 * @param {object} lead      la ficha del contacto
 * @param {string} texto     lo que escribió (vacío si mandó un adjunto)
 * @param {string} [adjunto] 'audio' | 'sticker' | 'video' | 'documento' | 'contacto'
 * @returns {null | {respuesta: string|null, regla: string}}
 *          null → que lo resuelva la IA.
 *          respuesta null → se entendió, y lo correcto es NO contestar.
 */
function responder(lead, texto, adjunto) {
  // Los adjuntos que no se pueden leer tienen respuesta fija: la IA no los ve
  // igual, así que preguntarle es gastar una llamada para que improvise.
  // La FOTO no está acá a propósito: puede ser un Yape y eso sí necesita ojos.
  if (adjunto === 'audio') {
    return { respuesta: 'Uy, todavía no puedo escuchar audios 🙈 ¿Me lo escribes porfa?', regla: 'audio' };
  }
  if (adjunto === 'video' || adjunto === 'documento') {
    return { respuesta: 'No puedo abrir eso por acá 🙈 ¿Me cuentas de qué se trata?', regla: 'adjunto' };
  }
  // Un sticker es un sticker: contestarlo con un texto es más raro que dejarlo
  // pasar. Clarck tampoco los contesta la mitad de las veces.
  if (adjunto === 'sticker') return { respuesta: null, regla: 'sticker' };

  // LAS RÁFAGAS. Cuando alguien escribe "hola" + "gracias" en el mismo minuto,
  // index.js las junta con \n y responde una sola vez. Medido con 100
  // pichangueros reales: las 100 llegaron agrupadas, y como esta capa cortaba
  // por largo total, no disparó NI UNA vez — todo se fue a la IA.
  //
  // Se mira línea por línea y se exige que TODAS sean acuse o saludo. Si una
  // sola trae contenido ("gracias, ¿a qué hora llego?"), va a la IA entera:
  // contestar el "gracias" e ignorar la pregunta es peor que no contestar.
  const lineas = String(texto || '').split('\n').map(limpiar).filter(Boolean);
  if (!lineas.length) return null;
  const intents = lineas.map(intentDe);
  if (intents.some((i) => i === null)) return null;

  // Manda el más "fuerte": preguntar por cupos pesa más que saludar, una
  // promesa de pago más que un "ok".
  const intent = intents.includes('yapeo') ? 'yapeo'
    : intents.includes('parrilla') ? 'parrilla'
    : intents.includes('saludo') ? 'saludo'
    : 'acuse';

  const yo = situacion(lead?.numero);

  // "¿hay para hoy?" — la pregunta más común del negocio, contestada con los
  // cupos de la BD en vez de con una llamada a la IA.
  if (intent === 'parrilla') {
    const hoy = db.hoyLima();
    const pideHoy = lineas.some((l) => /\b(hoy|esta noche)\b/.test(l));
    const parrilla = textoParrilla(lead?.zona && lead.zona !== 'otra' ? lead.zona : null, pideHoy ? hoy : null);
    // Sin partidos que ofrecer no se inventa nada: que conteste la IA, que
    // sabe decir "no hay, pero te aviso" con la conversación en la mano.
    if (!parrilla) return null;
    return { respuesta: parrilla, regla: 'parrilla' };
  }

  // "gracias" / "ok" / "listo". El texto no dice nada; el estado sí.
  if (intent === 'acuse') {
    if (yo.que === 'reservado') {
      const precio = db.precioDePartido({ zona: yo.insc.zona, precio: yo.insc.precio_partido });
      return {
        respuesta: `Me pasas la foto del Yape porfa 🙏${precio != null ? ` Son S/${precio}` : ''} al ${db.getNegocio().yape.numero} (${db.getNegocio().yape.titular}) — así te dejo confirmado en la lista del ${cuandoYDonde(yo.insc)} ⚽`,
        regla: 'acuse/falta-pagar',
      };
    }
    if (yo.que === 'pagado') {
      return { respuesta: `Ya estás en la lista del ${cuandoYDonde(yo.insc)} ⚽ Nos vemos allá 💪`, regla: 'acuse/ya-esta' };
    }
    if (yo.que === 'espera') {
      return { respuesta: `Estás en la lista de espera del ${cuandoYDonde(yo.insc)} 🙏 Si se baja alguien te aviso al toque.`, regla: 'acuse/espera' };
    }
    // Sin nada pendiente, un "gracias" no pide respuesta. Contestar por
    // contestar es lo que hacía que Clarck dijera "el bot habla mucho".
    return { respuesta: null, regla: 'acuse/nada' };
  }

  // Saludo pelado. Al que no conocemos le va la bienvenida de Config (eso ya lo
  // hace atajos.js); acá se atiende al CONOCIDO, que hasta ahora iba a la IA
  // para que dijera "hola" — 7.8% de los mensajes del mes.
  if (intent === 'saludo' && lead?.nombre) {
    const hola = `¡Hola ${primerNombre(lead.nombre)}!`;
    if (yo.que === 'reservado') {
      return { respuesta: `${hola} Te tengo el cupo del ${cuandoYDonde(yo.insc)} — mándame la foto del Yape y quedas confirmado 🙏`, regla: 'saludo/falta-pagar' };
    }
    if (yo.que === 'pagado') {
      return { respuesta: `${hola} Ya estás confirmado para el ${cuandoYDonde(yo.insc)} ⚽`, regla: 'saludo/ya-esta' };
    }
    if (yo.que === 'espera') {
      return { respuesta: `${hola} Estás en la lista de espera del ${cuandoYDonde(yo.insc)} — si se libera un lugar te aviso 🙏`, regla: 'saludo/espera' };
    }
    return { respuesta: `${hola} ¿Te anoto para alguna pichanga? Dime el día y la zona y te digo los cupos ⚽`, regla: 'saludo/conocido' };
  }

  // "ahí te yapeo". No es un pago: es una promesa. Lo único correcto es pedir
  // la captura — sin decir en ningún caso que ya quedó, porque no quedó.
  if (intent === 'yapeo') {
    if (yo.que === 'pagado') {
      return { respuesta: `Ojo que ya te tengo pagado el ${cuandoYDonde(yo.insc)} ⚽ Si es por otra fecha, dime cuál 🙌`, regla: 'yapeo/ya-pago' };
    }
    return {
      respuesta: `Dale 🙏 Mándame la captura cuando lo hagas y te dejo confirmado en la lista${yo.que === 'reservado' ? ` del ${cuandoYDonde(yo.insc)}` : ''} ⚽`,
      regla: 'yapeo/pendiente',
    };
  }

  return null;   // que decida la IA
}

/**
 * QUÉ DECIR CUANDO LA IA NO CONTESTÓ.
 *
 * La disculpa —"se me cruzaron los cables, ¿me lo repites?"— es un callejón
 * sin salida: el jugador repite lo mismo, la IA vuelve a fallar, y otra
 * disculpa. El 2026-09-09 alguien recibió esa respuesta a un "para hoy / hay"
 * que el propio bot sabía contestar de memoria.
 *
 * Así que en vez de disculparse y frenar, se manda lo que se puede armar sin
 * IA: la parrilla con los cupos de la BD. Le sirve al jugador ahora Y encarrila
 * lo que va a escribir después ("el jueves 9pm") hacia lo que las reglas sí
 * resuelven solas.
 *
 * @returns {string|null} null = no hay nada que ofrecer; ahí sí va la disculpa.
 */
function siLaIaFalla(lead) {
  const parrilla = textoParrilla(lead?.zona && lead.zona !== 'otra' ? lead.zona : null, null);
  if (!parrilla) return null;
  return `Uy, me colgué un segundo 🙈 Pero te paso lo que hay ahora mismo:\n\n${parrilla.replace(/^Estas son las que hay ⚽\n\n/, '')}`;
}

module.exports = { responder, situacion, siLaIaFalla };
