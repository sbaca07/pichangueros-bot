/**
 * IMPORTAR LA LISTA DEL GRUPO.
 *
 * Las listas viven en los grupos de WhatsApp, y a los grupos el bot no entra:
 * Cloud API no entrega mensajes de grupo (está verificado — de las listas del
 * 25 y 26 de agosto no llegó ni una al sistema). Mientras la lista se arme
 * allá, alguien tiene que traerla. Esto hace que traerla cueste un pegado.
 *
 * El texto que manda Clarck tiene forma fija desde julio:
 *
 *   🔴 *PICHANGA MARTES 25/08/26*🔴 *SEGUNDO TURNO*
 *   📍 Sede: Estadio colegio Politécnico Estados Unidos
 *   🕗 Horario: 9pm a 10 pm
 *   💵 Inversión: S/ 10
 *   ✏️ Escribirme al PV para apuntarse.
 *   ESTADO DE LA LISTA:
 *   [💰] 1. Renzo Infante
 *   [💰] 2. Yhonatan Chinchay
 *   [💰] 3.
 *
 * `parsearLista` es una función pura: no toca la BD y por eso se puede probar
 * con las listas reales. `importarLista` es la que escribe, y siempre en dos
 * tiempos — primero se ve qué va a pasar, después se confirma.
 */

const norm = (t) => String(t || '').toLowerCase().normalize('NFD').replace(/[̀-ͯ]/g, '');
const soloLetras = (t) => norm(t).replace(/[^a-z ]/g, ' ').replace(/\s+/g, ' ').trim();

/** "9pm a 10 pm" → {inicio:21, fin:22, texto:'9-10pm'}. null si no se entiende. */
function parsearHorario(linea) {
  const m = norm(linea).match(/(\d{1,2})(?::(\d{2}))?\s*(am|pm)?\s*(?:a|-|hasta)\s*(\d{1,2})(?::(\d{2}))?\s*(am|pm)/);
  if (!m) return null;
  const sufFin = m[6];
  const sufIni = m[3] || sufFin; // "8 a 9pm": el primero hereda el del segundo
  const a24 = (h, suf) => {
    const n = Number(h) % 12;
    return suf === 'pm' ? n + 12 : n;
  };
  const inicio = a24(m[1], sufIni);
  const fin = a24(m[4], sufFin);
  const et = (h, suf) => `${Number(h) % 12 === 0 ? 12 : Number(h) % 12}${suf === sufIni && suf === sufFin ? '' : suf}`;
  const texto = sufIni === sufFin
    ? `${Number(m[1]) % 12 === 0 ? 12 : Number(m[1]) % 12}-${Number(m[4]) % 12 === 0 ? 12 : Number(m[4]) % 12}${sufFin}`
    : `${et(m[1], sufIni)}${sufIni}-${et(m[4], sufFin)}${sufFin}`;
  return { inicio, fin, texto };
}

/**
 * Lee el texto de una convocatoria.
 * @returns {{ok:boolean, error?:string, fecha?:string, hora?:string, inicioMin?:number,
 *   sede?:string, precio?:number|null, turno?:string|null, jugadores?:string[], cupos?:number}}
 */
function parsearLista(texto) {
  const t = String(texto || '');
  if (!t.trim()) return { ok: false, error: 'Pega la lista del grupo acá arriba.' };

  // Fecha: 25/08/26 o 25/08/2026.
  const f = t.match(/(\d{1,2})\/(\d{1,2})\/(\d{2,4})/);
  if (!f) return { ok: false, error: 'No encontré la fecha (algo como 25/08/26) en el texto.' };
  const anio = f[3].length === 2 ? `20${f[3]}` : f[3];
  const fecha = `${anio}-${String(f[2]).padStart(2, '0')}-${String(f[1]).padStart(2, '0')}`;

  const lineaHorario = (t.match(/horario\s*:?\s*([^\n]*)/i) || [])[1] || '';
  const h = parsearHorario(lineaHorario) || parsearHorario(t);
  if (!h) return { ok: false, error: 'No encontré el horario (algo como "8pm a 9pm").' };

  const sede = ((t.match(/sede\s*:?\s*([^\n]*)/i) || [])[1] || '').trim();
  const pr = t.match(/(?:inversi[oó]n|costo|precio)\s*:?\s*S?\/?\s*(\d+(?:\.\d+)?)/i);
  const precio = pr ? Number(pr[1]) : null;
  const turno = /segundo\s*turno|2do\s*turno/i.test(t) ? 'segundo'
    : /primer\s*turno|1er\s*turno/i.test(t) ? 'primero' : null;

  // Las filas de la lista: "[💰] 1. Nombre" — el corchete puede traer lo que
  // sea (o nada), y el nombre puede estar vacío si el cupo está libre.
  const filas = [...t.matchAll(/^[^\S\n]*\[[^\]\n]*\][^\S\n]*(\d{1,2})[.)]?[^\S\n]*([^\n]*)$/gm)];
  if (!filas.length) return { ok: false, error: 'No encontré la lista de jugadores ("[💰] 1. Nombre").' };
  const cupos = filas.length;
  const jugadores = filas
    .map((m) => m[2].trim())
    // Un cupo vacío en la lista es un cupo libre, no un jugador sin nombre.
    // Y hay que descartar la basura de un corchete mal cerrado: si lo que
    // quedó no tiene ni tres letras seguidas, no es el nombre de nadie.
    .filter((n) => soloLetras(n).replace(/ /g, '').length >= 3);

  return { ok: true, fecha, hora: h.texto, inicioMin: h.inicio * 60, sede, precio, turno, jugadores, cupos };
}

/** ¿Estos dos nombres son la misma persona? Dos palabras en común, o una si solo hay una. */
function mismoNombre(a, b) {
  const ta = soloLetras(a).split(' ').filter((x) => x.length >= 3);
  const tb = soloLetras(b).split(' ').filter((x) => x.length >= 3);
  if (!ta.length || !tb.length) return false;
  const iguales = ta.filter((x) => tb.some((y) => y === x || y.startsWith(x) || x.startsWith(y))).length;
  return iguales >= Math.min(2, ta.length, tb.length);
}

/**
 * Prepara la importación: dice qué partido es y a quién reconoce, SIN escribir.
 *
 * @returns {{ok:boolean, error?:string, lista?:object, partido?:object|null,
 *   zona?:string|null, filas?:Array<{nombre:string, numero:string|null, lead:object|null,
 *   ambiguo:boolean, yaEsta:boolean, pago:object|null}>}}
 */
function prepararImportacion(db, texto) {
  const lista = parsearLista(texto);
  if (!lista.ok) return lista;

  // La zona sale de la SEDE: se compara contra las canchas cargadas. Sin eso
  // no se sabe a qué distrito pertenece la lista y no se puede buscar (ni
  // crear) el partido correcto.
  const sedes = db.listSedes();
  const calza = sedes.find((s) => mismoNombre(s.nombre, lista.sede))
    || sedes.find((s) => soloLetras(lista.sede).includes(soloLetras(s.nombre).split(' ').slice(-1)[0]));
  const zona = calza ? calza.zona : null;
  if (!zona) {
    return { ok: false, error: `No reconozco la sede "${lista.sede || '(vacía)'}". Revisa que esa cancha esté cargada en Ajustes.` };
  }

  const partido = db.partidosAbiertos(zona, {})
    .find((p) => p.fecha === lista.fecha && (p.inicio_min === lista.inicioMin || p.hora === lista.hora)) || null;

  const leads = db.listLeads().filter((l) => l.nombre);
  const inscritos = partido ? db.inscripcionesDe(partido.id).filter((i) => i.estado !== 'baja') : [];

  const filas = lista.jugadores.map((nombre) => {
    const cand = leads.filter((l) => mismoNombre(l.nombre, nombre));
    const lead = cand.length === 1 ? cand[0] : null;
    const yaEsta = inscritos.some((i) => (lead && i.numero === lead.numero) || mismoNombre(i.nombre || '', nombre));
    // Su Yape suelto, si tiene: lo que convierte "anotado" en "pagado".
    const pago = lead ? (db.pagosSinPartido(200).find((p) => p.numero === lead.numero) || null) : null;
    return { nombre, numero: lead ? lead.numero : null, lead, ambiguo: cand.length > 1, yaEsta, pago };
  });

  return { ok: true, lista, partido, zona, sede: calza, filas };
}

/**
 * Escribe: abre el partido si hace falta, anota a los que faltan y engancha
 * los Yapes que estaban sueltos.
 *
 * Nadie entra como "pagado" porque la lista traiga el 💰: pagado significa que
 * hay un Yape identificado. Marcarlo sin eso sería inventar plata en la caja.
 */
function importarLista(db, texto) {
  const prev = prepararImportacion(db, texto);
  if (!prev.ok) return prev;
  const { lista, filas, zona, sede } = prev;

  let partido = prev.partido;
  let creado = false;
  if (!partido) {
    const r = db.abrirPartido({
      zona,
      fecha: lista.fecha,
      hora: lista.hora,
      sede: sede ? sede.nombre : lista.sede,
      cupo: lista.cupos || (sede && sede.cupo) || 14,
      precio: lista.precio,
    });
    if (!r.id) return { ok: false, error: 'No se pudo abrir el partido de esa lista.' };
    partido = db.getPartido(r.id);
    creado = true;
  }

  const hecho = { anotados: [], yaEstaban: [], pagosEnganchados: [], noEntraron: [] };
  for (const f of filas) {
    if (f.yaEsta) { hecho.yaEstaban.push(f.nombre); continue; }
    // `vence: false`: esto lo trajo una persona con la lista en la mano, no es
    // una promesa de chat que haya que cronometrar.
    const r = db.inscribir(partido.id, f.numero, { nombre: f.nombre, vence: false });
    if (!r.inscripcion) { hecho.noEntraron.push(f.nombre); continue; }
    hecho.anotados.push(f.nombre + (r.resultado === 'espera' ? ' (lista de espera)' : ''));
    if (f.pago) {
      const p = db.pagarInscripcion(r.inscripcion.id, f.pago.id);
      if (p && p.ok) hecho.pagosEnganchados.push(`${f.nombre} · S/ ${f.pago.monto}`);
    }
  }
  return { ok: true, partido, creado, lista, ...hecho };
}

module.exports = { parsearLista, parsearHorario, prepararImportacion, importarLista, mismoNombre };
