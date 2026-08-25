/**
 * LOS DISTRITOS, NORMALIZADOS.
 *
 * `leads.distrito` es lo que la persona escribió, tal cual. En 585 contactos
 * eso dio 108 valores distintos: "Rimac", "Rímac", "RIMAC", "rimac", "ricma",
 * "Rimac/breña", "Smp, Rímac", "sjl, rimac, los olivos, callao". El filtro por
 * distrito comparaba texto contra texto, así que cada variante era su propia
 * entrada del desplegable y ninguna encontraba a las demás.
 *
 * Acá se traduce ese texto a distritos DE VERDAD. Dos cosas importan:
 *
 *   1. Un texto puede nombrar VARIOS distritos, y todos cuentan. Quien escribe
 *      "Rimac/breña" vive cerca de las dos canchas: tiene que aparecer en las
 *      dos listas, no en una tercera llamada "Rimac/breña".
 *   2. Esto es DÓNDE VIVE, no dónde juega. Dónde juega es la zona (una de las
 *      cuatro con cancha nuestra) y se decide aparte: alguien de Surquillo
 *      puede jugar perfectamente en Chorrillos.
 *
 * Lo que no se reconoce no se inventa: queda fuera y el texto original se
 * sigue mostrando en la ficha.
 */

const norm = (t) => String(t || '').toLowerCase().normalize('NFD').replace(/[̀-ͯ]/g, '');

/**
 * Distritos de Lima y Callao con las formas en que la gente los escribe.
 * Los alias salieron de los datos reales, no de una lista teórica.
 */
const CATALOGO = [
  ['Ancón', []],
  ['Ate', ['ate vitarte', 'vitarte']],
  ['Barranco', []],
  ['Breña', ['brena']],
  ['Callao', ['bellavista', 'la perla', 'ventanilla', 'carmen de la legua']],
  ['Carabayllo', []],
  ['Cercado de Lima', ['cercado', 'lima cercado', 'lima centro', 'centro de lima']],
  ['Chaclacayo', []],
  ['Chorrillos', []],
  ['Cieneguilla', []],
  ['Comas', []],
  ['El Agustino', ['agustino']],
  ['Independencia', []],
  ['Jesús María', ['jesus maria']],
  ['La Molina', []],
  ['La Victoria', []],
  ['Lince', []],
  ['Los Olivos', ['olivos']],
  ['Lurigancho-Chosica', ['chosica', 'lurigancho chosica']],
  ['Lurín', []],
  ['Magdalena del Mar', ['magdalena']],
  ['Miraflores', ['larcomar']],
  ['Pachacámac', ['pachacamac']],
  ['Pueblo Libre', []],
  ['Puente Piedra', []],
  ['Punta Hermosa', []],
  ['Rímac', ['rimac', 'ricma']],
  ['San Bartolo', []],
  ['San Borja', []],
  ['San Isidro', []],
  ['San Juan de Lurigancho', ['sjl']],
  ['San Juan de Miraflores', ['sjm']],
  ['San Luis', []],
  ['San Martín de Porres', ['san martin de porres', 'smp']],
  ['San Miguel', []],
  ['Santa Anita', []],
  ['Santiago de Surco', ['surco', 'santiago de surco']],
  ['Surquillo', []],
  ['Villa El Salvador', ['villa el salvador', 'ves']],
  ['Villa María del Triunfo', ['villa maria del triunfo', 'vmt']],
];

// Índice de búsqueda: cada término (nombre o alias) con su canónico. Se ordena
// del término más largo al más corto para que "San Juan de Miraflores" gane
// antes de que "Miraflores" se lo lleve por delante.
const TERMINOS = CATALOGO
  .flatMap(([canon, alias]) => [norm(canon), ...alias].map((t) => ({ t, canon })))
  .sort((a, b) => b.t.length - a.t.length);

/**
 * Los distritos que nombra un texto libre.
 *
 * @param {string} texto lo que escribió la persona
 * @returns {string[]} nombres canónicos, sin repetir, en el orden del catálogo
 */
function distritosDe(texto) {
  const t = ` ${norm(texto).replace(/[^a-z0-9]+/g, ' ')} `;
  if (t.trim().length < 3) return [];
  const encontrados = new Set();
  let restante = t;
  for (const { t: termino, canon } of TERMINOS) {
    // Se busca con bordes de palabra y se TACHA lo encontrado, para que
    // "San Juan de Miraflores" no deje suelto un "Miraflores" fantasma.
    const re = new RegExp(`(^|\\s)${termino.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}(\\s|$)`);
    if (re.test(restante)) {
      encontrados.add(canon);
      restante = restante.replace(new RegExp(re.source, 'g'), ' ');
    }
  }
  return CATALOGO.map(([c]) => c).filter((c) => encontrados.has(c));
}

/** El primero de los que nombra — para cuando hace falta uno solo. */
const distritoPrincipal = (texto) => distritosDe(texto)[0] || null;

/** ¿Este texto libre nombra este distrito? */
const viveEn = (texto, distrito) => distritosDe(texto).includes(distrito);

module.exports = { distritosDe, distritoPrincipal, viveEn, CATALOGO };
