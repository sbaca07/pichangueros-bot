/**
 * Pichangueros — espejo del bot a Google Sheets (backup + visibilidad).
 *
 * Escribe cuatro pestañas: Resumen, Leads, Pagos y Partidos. El bot manda las
 * hojas ya armadas ({nombre, header, filas}), así que agregar una vista nueva
 * mañana no obliga a volver a pegar este archivo: se toca solo el bot.
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
    sh.clear();
    sh.getRange(1, 1, 1, h.header.length).setValues([h.header])
      .setFontWeight('bold').setBackground('#f1f3f4');

    var filas = h.filas || [];
    if (filas.length) {
      // Las filas llegan con el mismo ancho que el header; setValues exige que
      // la matriz sea rectangular o tira error y no escribe NADA.
      var ancho = h.header.length;
      var rect = filas.map(function (f) {
        var fila = f.slice(0, ancho);
        while (fila.length < ancho) fila.push('');
        return fila;
      });
      sh.getRange(2, 1, rect.length, ancho).setValues(rect);
    }
    sh.setFrozenRows(1);
    ss.setActiveSheet(sh);
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
