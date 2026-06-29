/**
 * Pichangueros — espejo de leads a Google Sheets (backup + visibilidad).
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
 * El bot manda TODOS los leads en cada sync; la hoja "Leads" se reescribe
 * completa (idempotente). El secreto evita que cualquiera escriba en tu hoja.
 */
var SECRET = 'PEGA_AQUI_EL_MISMO_SECRET_QUE_EN_RENDER';

var COLS = ['numero', 'nombre', 'edad', 'distrito', 'zona', 'estado', 'handoff',
  'motivo', 'etiquetas', 'proxima_accion', 'proxima_nota', 'creado_en', 'actualizado_en', 'wa'];
var HEADER = ['Número', 'Nombre', 'Edad', 'Distrito', 'Zona', 'Etapa', 'Handoff',
  'Motivo', 'Etiquetas', 'Próxima acción', 'Nota seguimiento', 'Creado', 'Actualizado', 'WhatsApp'];

function doPost(e) {
  var body;
  try { body = JSON.parse(e.postData.contents); } catch (err) {
    return out({ ok: false, error: 'json invalido' });
  }
  if (!body || body.secret !== SECRET) return out({ ok: false, error: 'forbidden' });

  var ss = SpreadsheetApp.getActiveSpreadsheet();
  var sh = ss.getSheetByName('Leads') || ss.insertSheet('Leads');
  sh.clearContents();
  sh.getRange(1, 1, 1, HEADER.length).setValues([HEADER]).setFontWeight('bold');

  var leads = body.leads || [];
  if (leads.length) {
    var rows = leads.map(function (l) {
      return COLS.map(function (c) { return l[c] != null ? l[c] : ''; });
    });
    sh.getRange(2, 1, rows.length, COLS.length).setValues(rows);
  }
  sh.setFrozenRows(1);
  return out({ ok: true, n: leads.length });
}

function out(obj) {
  return ContentService.createTextOutput(JSON.stringify(obj))
    .setMimeType(ContentService.MimeType.JSON);
}
