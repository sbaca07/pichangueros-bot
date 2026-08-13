/**
 * Pichangueros — espejo del bot a Google Sheets (backup + visibilidad).
 *
 * Escribe cuatro pestañas: Resumen, Leads, Pagos y Partidos. El bot manda las
 * hojas ya armadas ({nombre, header, filas, fechas, moneda}), así que agregar
 * una vista nueva mañana no obliga a volver a pegar este archivo: se toca solo
 * el bot.
 *
 * La hoja la usa gente que no es técnica, así que cada pestaña queda con:
 *   - filtros de flecha en los encabezados (clic → filtrar por lo que sea)
 *   - fechas de VERDAD, no texto: sin esto Sheets no ofrece "esta semana" ni
 *     "antes de tal día", que es justo lo que uno quiere preguntarle a la data
 *   - montos con formato S/ (suman y se ordenan bien)
 *   - filas alternadas, encabezado congelado y columnas al ancho del contenido
 *
 * SETUP (una sola vez):
 *  1. Crea un Google Sheet nuevo (hoja de cálculo vacía).
 *  2. Extensiones → Apps Script. Borra lo que haya y pega TODO este archivo.
 *  3. Reemplaza el valor de SECRET por el mismo que pondrás en Render
 *     (variable SHEET_SECRET). Guarda (Ctrl+S).
 *  4. Implementar → Nueva implementación → tipo "Aplicación web".
 *       - Ejecutar como: Yo
 *       - Quién tiene acceso: Cualquier persona
 *     Implementar → autoriza con tu cuenta → copia la "URL de la app web".
 *  5. En Render (servicio pichangueros-bot → Environment) agrega:
 *       SHEET_WEBHOOK_URL = la URL de la app web
 *       SHEET_SECRET      = el mismo SECRET de abajo
 *     Guardar → redeploy. Listo: el bot sincroniza al arrancar y cada 6 h,
 *     y el botón "Respaldar a Sheet" del panel fuerza una sincronización.
 *
 * Cada sync reescribe las hojas completas (idempotente). El secreto evita que
 * cualquiera con la URL escriba en tu hoja.
 */
var SECRET = 'PEGA_AQUI_EL_MISMO_SECRET_QUE_EN_RENDER';

/**
 * "2026-08-12 21:45:02" o "2026-08-12" → Date real.
 *
 * Se parsea a mano en vez de con new Date(texto): el parseo de cadenas depende
 * del motor y una fecha mal leída es peor que una en texto — se ve bien y
 * filtra mal. Los timestamps del bot ya vienen en hora de Lima, así que se
 * construye la fecha en la zona de la hoja sin correrla.
 */
function aFecha(v) {
  if (!v) return '';
  var m = String(v).match(/^(\d{4})-(\d{2})-(\d{2})(?:[ T](\d{2}):(\d{2})(?::(\d{2}))?)?$/);
  if (!m) return v; // no tiene forma de fecha: se deja tal cual
  return new Date(+m[1], +m[2] - 1, +m[3], +(m[4] || 0), +(m[5] || 0), +(m[6] || 0));
}

function doPost(e) {
  var body;
  try { body = JSON.parse(e.postData.contents); } catch (err) {
    return out({ ok: false, error: 'json invalido' });
  }
  if (!body || body.secret !== SECRET) return out({ ok: false, error: 'forbidden' });

  var hojas = body.hojas || [];
  if (!hojas.length) return out({ ok: false, error: 'sin hojas' });

  var ss = SpreadsheetApp.getActiveSpreadsheet();
  var escritas = [];

  for (var i = 0; i < hojas.length; i++) {
    var h = hojas[i];
    if (!h || !h.nombre || !h.header) continue;
    var sh = ss.getSheetByName(h.nombre) || ss.insertSheet(h.nombre);

    // El filtro y las bandas sobreviven a clear() y hacen fallar al que sigue:
    // se quitan antes de reescribir y se vuelven a poner al final.
    var filtroViejo = sh.getFilter();
    if (filtroViejo) filtroViejo.remove();
    var bandas = sh.getBandings();
    for (var b = 0; b < bandas.length; b++) bandas[b].remove();
    sh.clear();

    var ancho = h.header.length;
    sh.getRange(1, 1, 1, ancho).setValues([h.header])
      .setFontWeight('bold').setBackground('#e8f0fe').setFontColor('#1a3b6e');

    var filas = h.filas || [];
    if (filas.length) {
      var fechas = h.fechas || [];
      // setValues exige una matriz rectangular: si una fila viene corta, tira
      // error y no escribe NADA.
      var rect = filas.map(function (f) {
        var fila = f.slice(0, ancho);
        while (fila.length < ancho) fila.push('');
        for (var c = 0; c < fechas.length; c++) fila[fechas[c]] = aFecha(fila[fechas[c]]);
        return fila;
      });
      var cuerpo = sh.getRange(2, 1, rect.length, ancho);
      cuerpo.setValues(rect);

      // Fechas: formato legible Y ordenables/filtrables como fecha.
      for (var d = 0; d < (h.fechas || []).length; d++) {
        sh.getRange(2, h.fechas[d] + 1, rect.length, 1).setNumberFormat('dd/MM/yyyy HH:mm');
      }
      for (var mo = 0; mo < (h.moneda || []).length; mo++) {
        sh.getRange(2, h.moneda[mo] + 1, rect.length, 1).setNumberFormat('"S/ "#,##0.00');
      }
      cuerpo.applyRowBanding(SpreadsheetApp.BandingTheme.LIGHT_GREY, false, false);
    }

    sh.setFrozenRows(1);
    // Los filtros de flecha: es lo que hace que alguien no técnico pueda
    // preguntarle cosas a la hoja sin escribir una sola fórmula.
    if (filas.length) sh.getRange(1, 1, filas.length + 1, ancho).createFilter();
    sh.autoResizeColumns(1, ancho);

    escritas.push(h.nombre + ':' + filas.length);
  }

  // Las pestañas quedan en el orden en que el bot las manda (Resumen primero).
  for (var j = 0; j < hojas.length; j++) {
    var s = ss.getSheetByName(hojas[j].nombre);
    if (s) { ss.setActiveSheet(s); ss.moveActiveSheet(j + 1); }
  }
  ss.setActiveSheet(ss.getSheetByName(hojas[0].nombre));

  // La "Hoja 1" que trae toda hoja nueva quedaría colgando al final. Se borra
  // solo si está vacía y no es ninguna de las nuestras: si el usuario escribió
  // algo ahí, es suyo y no se toca.
  var nuestras = hojas.map(function (h) { return h.nombre; });
  var todas = ss.getSheets();
  for (var k = 0; k < todas.length; k++) {
    var hoja = todas[k];
    if (nuestras.indexOf(hoja.getName()) !== -1) continue;
    if (ss.getSheets().length <= 1) break;             // siempre debe quedar una
    if (hoja.getLastRow() === 0 && hoja.getLastColumn() === 0) ss.deleteSheet(hoja);
  }

  return out({ ok: true, hojas: escritas });
}

function out(obj) {
  return ContentService.createTextOutput(JSON.stringify(obj))
    .setMimeType(ContentService.MimeType.JSON);
}
