/**
 * Export a Excel — "bonito y acorde a Pichangueros" (vs. el CSV plano).
 * Mismos datos que /admin/leads.csv, pero con la identidad de marca: colores
 * verde/navy del logo, isotipo, encabezado congelado, autofiltro y columnas
 * con formato (zona coloreada, handoff resaltado, WhatsApp como link).
 */
const path = require('path');
const ExcelJS = require('exceljs');

const VERDE = 'FF34C759';
const VERDE_OSCURO = 'FF27A64A';
const NAVY = 'FF142847';
const ROJO_SUAVE = 'FFFDE7E5';
const GRIS_CLARO = 'FFF4F6F5';

const ZONAS = {
  brena: { nombre: 'Breña', color: 'FF34C759' },
  comas: { nombre: 'Comas', color: 'FF007AFF' },
  otra: { nombre: 'Otra zona', color: 'FF64748B' },
};

const ESTADOS = {
  nuevo: 'Nuevo',
  datos_completos: 'Completo',
  invitado_grupo: 'En grupo',
  activo: 'Jugador',
  lista_espera: 'En espera',
  inactivo: 'Inactivo',
};

const COLUMNAS = [
  { titulo: 'Número', ancho: 14 },
  { titulo: 'Nombre', ancho: 26 },
  { titulo: 'Edad', ancho: 7 },
  { titulo: 'Distrito', ancho: 18 },
  { titulo: 'Zona', ancho: 12 },
  { titulo: 'Etapa', ancho: 14 },
  { titulo: 'Derivado', ancho: 10 },
  { titulo: 'Motivo derivación', ancho: 26 },
  { titulo: 'Etiquetas', ancho: 20 },
  { titulo: 'Próxima acción', ancho: 14 },
  { titulo: 'Creado (hora Lima)', ancho: 18 },
  { titulo: 'WhatsApp', ancho: 14 },
];

/** @returns {Promise<Buffer>} */
async function buildLeadsWorkbook(db) {
  const leads = db.listLeads();
  const wb = new ExcelJS.Workbook();
  wb.creator = 'Pichangueros CRM';
  wb.created = new Date();

  const ws = wb.addWorksheet('Leads', {
    properties: { defaultRowHeight: 20 },
    views: [{ state: 'frozen', ySplit: 4 }],
  });

  ws.columns = COLUMNAS.map((c) => ({ width: c.ancho }));

  // --- Título de marca -----------------------------------------------------
  ws.mergeCells(1, 1, 1, COLUMNAS.length);
  const titulo = ws.getCell(1, 1);
  titulo.value = '⚽  Pichangueros — CRM';
  titulo.font = { bold: true, size: 18, color: { argb: 'FFFFFFFF' } };
  titulo.alignment = { vertical: 'middle', horizontal: 'left', indent: 2 };
  ws.getRow(1).height = 34;
  for (let c = 1; c <= COLUMNAS.length; c++) ws.getCell(1, c).fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: NAVY } };

  try {
    const imgId = wb.addImage({ filename: path.join(__dirname, '../assets/isotipo.png'), extension: 'png' });
    ws.addImage(imgId, { tl: { col: COLUMNAS.length - 1.6, row: 0.05 }, ext: { width: 28, height: 28 } });
  } catch (_) { /* si falta el asset, no rompe el export */ }

  // --- Subtítulo -------------------------------------------------------------
  ws.mergeCells(2, 1, 2, COLUMNAS.length);
  const sub = ws.getCell(2, 1);
  const ahoraLima = new Date(Date.now() - 5 * 3600e3).toISOString().replace('T', ' ').slice(0, 16);
  sub.value = `Exportado ${ahoraLima} (hora Lima) · ${leads.length} contactos`;
  sub.font = { italic: true, size: 10.5, color: { argb: 'FF6B7C72' } };
  sub.alignment = { vertical: 'middle', indent: 2 };
  ws.getRow(2).height = 20;
  ws.getRow(3).height = 6; // separador

  // --- Encabezado de columnas --------------------------------------------
  const HEADER_ROW = 4;
  const header = ws.getRow(HEADER_ROW);
  COLUMNAS.forEach((c, i) => {
    const cell = header.getCell(i + 1);
    cell.value = c.titulo;
    cell.font = { bold: true, color: { argb: 'FFFFFFFF' }, size: 11 };
    cell.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: VERDE_OSCURO } };
    cell.alignment = { vertical: 'middle', horizontal: 'left' };
  });
  header.height = 22;

  // --- Filas de datos ------------------------------------------------------
  leads.forEach((l, i) => {
    const fila = HEADER_ROW + 1 + i;
    const z = ZONAS[l.zona];
    const valores = [
      `+${l.numero}`,
      l.nombre || '',
      l.edad || '',
      l.distrito || '',
      z ? z.nombre : (l.zona || ''),
      ESTADOS[l.estado] || l.estado || '',
      l.handoff ? 'Sí' : '',
      l.handoff_motivo || '',
      l.etiquetas || '',
      l.proxima_accion || '',
      (l.creado_en || '').slice(0, 16),
      '',
    ];
    const row = ws.getRow(fila);
    valores.forEach((v, ci) => { row.getCell(ci + 1).value = v; });

    // WhatsApp como link clicable.
    const waCell = row.getCell(COLUMNAS.length);
    waCell.value = { text: 'Abrir chat', hyperlink: `https://wa.me/${l.numero}` };
    waCell.font = { color: { argb: 'FF007AFF' }, underline: true };

    // Banda alterna para lectura.
    if (i % 2 === 1) {
      for (let c = 1; c <= COLUMNAS.length; c++) {
        if (c === 5) continue; // la zona ya lleva su propio color
        row.getCell(c).fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: GRIS_CLARO } };
      }
    }
    // Zona con el color de marca.
    if (z) {
      const zc = row.getCell(5);
      zc.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: z.color } };
      zc.font = { color: { argb: 'FFFFFFFF' }, bold: true };
    }
    // Handoff resaltado (necesita atención de Clarck).
    if (l.handoff) {
      for (let c = 1; c <= COLUMNAS.length; c++) {
        if (c === 5) continue;
        row.getCell(c).fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: ROJO_SUAVE } };
      }
    }
    row.eachCell((cell) => { cell.border = { bottom: { style: 'hair', color: { argb: 'FFE7EAE8' } } }; });
  });

  ws.autoFilter = { from: { row: HEADER_ROW, column: 1 }, to: { row: HEADER_ROW + leads.length, column: COLUMNAS.length } };

  return wb.xlsx.writeBuffer();
}

module.exports = { buildLeadsWorkbook };
