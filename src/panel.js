/**
 * Panel CRM (Semana 3 · rediseño iOS 2026-06-29) — "del marcador a la cancha".
 *
 * Tres vistas, estética iOS (claro, Inter + Barlow Condensed, acento verde
 * #A3C614 = verde de sistema y de cancha):
 *   Resumen → dashboard de data (marcador-estadio, métricas, crecimiento, zonas)
 *   CRM     → lista de leads con la cola "sin responder" al frente
 *   Ficha   → perfil + pipeline + etiquetas + seguimiento + notas + chat
 *
 * Rutas (todas con ?key=ADMIN_KEY; sin key → 404):
 *   GET  /admin/leads                  → Resumen (dashboard)
 *   GET  /admin/leads?vista=crm        → lista CRM (con filtros/búsqueda)
 *   GET  /admin/leads?numero=N         → ficha de contacto
 *   GET  /admin/leads.csv              → export CSV
 *   GET  /admin/leads.xlsx             → export Excel (con marca, colores, autofiltro)
 *   GET  /admin/backup-db              → descarga el .db completo (backup manual)
 *   POST /admin/lead/estado            → cambia etapa del pipeline (1 toque)
 *   POST /admin/lead/reactivar         → saca del handoff (el bot vuelve a atender)
 *   POST /admin/lead/etiquetas         → guarda etiquetas (separadas por coma)
 *   POST /admin/lead/seguimiento       → fecha + nota de próxima acción
 *   POST /admin/lead/nota              → agrega una nota al historial
 */
const sheetsync = require('./sheetsync');
const backup = require('./backup');
const { buildLeadsWorkbook } = require('./excel');

const esc = (v) =>
  String(v ?? '—').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

// Colores de zona. Todos llevan texto BLANCO encima (badges, puntos, barras),
// así que todos tienen que pasar 4.5:1 contra blanco. El lima del logo (#A3C614)
// daba 1.97:1 — "Breña" en blanco sobre lima era ilegible a contraluz; acá va la
// versión oscura del mismo verde, que sigue leyéndose como la marca.
const ZONAS = {
  brena: { nombre: 'Breña', color: '#5F7A0A' },      // 4.91:1
  comas: { nombre: 'Comas', color: '#16385F' },      // 11.90:1
  rimac: { nombre: 'Rímac', color: '#0A6570' },      // 6.76:1
  chorrillos: { nombre: 'Chorrillos', color: '#7A3A99' }, // 7.26:1
  otra: { nombre: 'Otra zona', color: '#4F5B6B' },   // 6.91:1
};
// Color para zonas creadas después de este mapa (nuevos distritos).
const colorZona = (z) => ZONAS[z]?.color || '#4A6B2E'; // 6.12:1
// Slug de zona a partir del nombre que escribe Clarck ("San Miguel" → sanmiguel).
const slugZona = (nombre) => (nombre || '')
  .toLowerCase().normalize('NFD').replace(/[̀-ͯ]/g, '')
  .replace(/[^a-z]/g, '').slice(0, 24);

// Pipeline (etapas) — orden y etiquetas pensadas para el flujo de Clarck.
const ESTADOS = {
  nuevo: 'Nuevo',
  datos_completos: 'Completo',
  invitado_grupo: 'En grupo',
  activo: 'Jugador ⭐',
  lista_espera: 'En espera',
  inactivo: 'Inactivo 💤',
};

// Colores de avatar (monograma) — se elige de forma estable por número.
const AVATARES = [
  'linear-gradient(135deg,#A3C614,#7FA30F)', 'linear-gradient(135deg,#5ac8fa,#16385F)',
  'linear-gradient(135deg,#ff9f0a,#ff7a00)', 'linear-gradient(135deg,#bf5af2,#8944ab)',
  'linear-gradient(135deg,#ff453a,#cc2f26)', 'linear-gradient(135deg,#64748b,#475569)',
  'linear-gradient(135deg,#30b0c7,#0a7e8c)', 'linear-gradient(135deg,#ffcc00,#e0a000)',
];
const avatarColor = (numero) => AVATARES[[...String(numero)].reduce((a, c) => a + c.charCodeAt(0), 0) % AVATARES.length];
const iniciales = (nombre, numero) => {
  if (!nombre) return String(numero).slice(-2);
  const p = nombre.trim().split(/\s+/);
  return ((p[0]?.[0] || '') + (p[1]?.[0] || '')).toUpperCase() || String(numero).slice(-2);
};

const MS_DIA = 86400e3;
// Normaliza texto libre para agrupar/filtrar: minúsculas y sin tildes.
const normTexto = (t) => (t || '').trim().toLowerCase().normalize('NFD').replace(/[̀-ͯ]/g, '');
const fechaLima = (offsetDias = 0) => new Date(Date.now() - 5 * 3600e3 + offsetDias * MS_DIA).toISOString().slice(0, 10);
const hoyLima = () => fechaLima(0);
// Timestamp Lima de hace N horas (mismo formato 'YYYY-MM-DD HH:MM:SS' de la BD).
const limaHace = (horas) => new Date(Date.now() - 5 * 3600e3 - horas * 3600e3).toISOString().slice(0, 19).replace('T', ' ');
// "Sin responder" REAL: el último mensaje es del contacto Y es reciente (48 h).
// Y en MODO SEGURO el bot calla a propósito con todos menos los testers: esos
// silenciados NO "necesitan respuesta" — están siendo capturados por diseño.
// Mostrarlos como deuda pintaba 124 pendientes falsos en el CRM.
const modoSeguroOn = () => (process.env.SAFE_MODE || 'true') !== 'false';
const testersPanel = () => (process.env.ALLOWED_TESTERS || '').split(',').map((n) => n.replace(/\D/g, '')).filter(Boolean);
const sinResponder = (roles, l) => {
  const u = roles[l.numero];
  if (!(u && u.rol === 'user' && !l.handoff && u.en >= limaHace(48))) return false;
  return !modoSeguroOn() || testersPanel().includes(l.numero);
};
/** Capturados en silencio por el modo seguro (últimas 48 h) — para el banner. */
const silenciados48h = (roles, todos) =>
  todos.filter((l) => { const u = roles[l.numero]; return u && u.rol === 'user' && !l.handoff && u.en >= limaHace(48); }).length;
const horaCorta = (ts) => esc((ts || '').slice(5, 16)); // MM-DD HH:MM

function registrarPanel(app, db, conexion = null) {
  const express = require('express');
  app.use(express.urlencoded({ extended: false }));

  /**
   * Isotipo de Pichangueros para la pestaña del navegador y la pantalla de
   * inicio del celular. Servido por NOSOTROS, no por un CDN: el panel no
   * depende de terceros para pintarse.
   *
   * Va SIN key a propósito — el navegador pide el favicon por su cuenta y no
   * arrastra la query. Es un logo público, no hay nada que proteger. Se cachea
   * un año: son 7 KB que Clarck baja una sola vez, no en cada vista.
   */
  const fsIconos = require('fs');
  const rutaIconos = require('path').join(__dirname, '..', 'assets');
  for (const tam of [64, 180]) {
    app.get(`/icono-${tam}.png`, (_req, res) => {
      const archivo = require('path').join(rutaIconos, `icono-${tam}.png`);
      if (!fsIconos.existsSync(archivo)) return res.status(404).end();
      res.type('png').set('Cache-Control', 'public, max-age=31536000, immutable');
      res.send(fsIconos.readFileSync(archivo));
    });
  }
  // Los navegadores lo piden solo, aunque no esté declarado.
  app.get('/favicon.ico', (_req, res) => res.redirect(301, '/icono-64.png'));

  const ADMIN_KEY = process.env.ADMIN_KEY || '';
  const autorizado = (req, res) => {
    const key = req.method === 'POST' ? req.body.key : req.query.key;
    if (!ADMIN_KEY || key !== ADMIN_KEY) {
      res.status(404).send('Not found');
      return false;
    }
    return true;
  };
  /**
   * Vuelta de un POST: mensaje concreto de QUÉ pasó + ancla al bloque donde
   * estaba el usuario.
   *
   * Antes casi todos los POST redirigían a la vista pelada: sin decir qué se
   * guardó y aterrizando arriba de todo. En Ajustes —que es un scroll largo—
   * eso significaba pegar el link del grupo de Chorrillos, tocar "Guardar" y
   * aparecer en el bloque del canal de WhatsApp, sin ninguna señal de éxito.
   * Es la explicación más probable de por qué las cuatro zonas siguen sin link:
   * Clarck lo intentó, no vio confirmación y asumió que no funcionaba.
   */
  const volver = (res, { key, vista, numero, partido, ancla, aviso, err } = {}) => {
    const p = [`key=${encodeURIComponent(key || '')}`];
    if (vista) p.push(`vista=${encodeURIComponent(vista)}`);
    if (numero) p.push(`numero=${encodeURIComponent(numero)}`);
    if (partido) p.push(`partido=${encodeURIComponent(partido)}`);
    if (aviso) p.push(`aviso=${encodeURIComponent(String(aviso).slice(0, 300))}`);
    if (err) p.push('err=1');
    res.redirect(`/admin/leads?${p.join('&')}${ancla ? `#${ancla}` : ''}`);
  };

  const numeroDe = (req) => (req.body.numero || '').replace(/\D/g, '');
  // Cómo nombrar a alguien en un aviso: su nombre si lo tenemos, si no el número.
  const nombreLead = (numero) => {
    const l = db.getLead(numero);
    return (l && l.nombre) || `+${numero}`;
  };

  // --- Acciones CRM (1 toque desde la ficha) -----------------------------------
  const volverAFicha = (req, res, aviso, ancla, err) =>
    volver(res, { key: req.body.key, numero: numeroDe(req), aviso, ancla, err });

  app.post('/admin/lead/estado', (req, res) => {
    if (!autorizado(req, res)) return;
    const numero = numeroDe(req);
    const estado = ESTADOS[req.body.estado] ? req.body.estado : null;
    if (!estado) return volverAFicha(req, res, 'Esa etapa no existe.', 'etapa', true);
    db.setEstado(numero, estado);
    volverAFicha(req, res, `${nombreLead(numero)} ahora está en "${ESTADOS[estado]}".`, 'etapa');
  });

  app.post('/admin/lead/reactivar', (req, res) => {
    if (!autorizado(req, res)) return;
    const numero = numeroDe(req);
    const quien = nombreLead(numero);
    db.clearHandoff(numero);
    volverAFicha(req, res, `El bot vuelve a atender a ${quien}.`);
  });

  app.post('/admin/lead/etiquetas', (req, res) => {
    if (!autorizado(req, res)) return;
    const limpio = (req.body.etiquetas || '').split(',').map((t) => t.trim()).filter(Boolean).slice(0, 10).join(',');
    db.setEtiquetas(numeroDe(req), limpio);
    volverAFicha(req, res, limpio ? `Etiquetas guardadas: ${limpio.split(',').join(', ')}.` : 'Etiquetas borradas.', 'etiquetas');
  });

  app.post('/admin/lead/seguimiento', (req, res) => {
    if (!autorizado(req, res)) return;
    const fecha = /^\d{4}-\d{2}-\d{2}$/.test(req.body.fecha || '') ? req.body.fecha : null;
    const nota = (req.body.nota || '').slice(0, 200);
    db.setSeguimiento(numeroDe(req), fecha, nota);
    volverAFicha(req, res, fecha
      ? `Te lo recordamos el ${fechaCompacta(fecha)}${nota ? `: "${nota}"` : ''}.`
      : 'Recordatorio quitado (no pusiste fecha).', 'seguimiento');
  });

  app.post('/admin/lead/nota', (req, res) => {
    if (!autorizado(req, res)) return;
    const texto = (req.body.texto || '').trim().slice(0, 500);
    // Antes una nota vacía se descartaba en silencio y la pantalla volvía igual.
    if (!texto) return volverAFicha(req, res, 'Escribe algo en la nota para poder guardarla.', 'notas', true);
    db.addNota(numeroDe(req), texto);
    volverAFicha(req, res, 'Nota agregada.', 'notas');
  });

  // Borra un contacto completo (pruebas internas, spam) — no vuelve a la ficha
  // (quedaría vacía) sino a la lista del CRM.
  app.post('/admin/lead/eliminar', (req, res) => {
    if (!autorizado(req, res)) return;
    const numero = numeroDe(req);
    const quien = nombreLead(numero);
    db.deleteLead(numero);
    volver(res, { key: req.body.key, vista: 'crm', aviso: `${quien} eliminado con todo su historial.` });
  });

  // --- Export CSV ----------------------------------------------------------------
  app.get('/admin/leads.csv', (req, res) => {
    if (!autorizado(req, res)) return;
    const filas = db.listLeads().map((l) =>
      [l.numero, l.nombre, l.edad, l.distrito, l.zona, l.estado, l.handoff, l.handoff_motivo, l.etiquetas, l.proxima_accion, l.creado_en]
        .map((v) => `"${String(v ?? '').replace(/"/g, '""')}"`)
        .join(',')
    );
    res.set('Content-Type', 'text/csv; charset=utf-8');
    res.set('Content-Disposition', 'attachment; filename="pichangueros-leads.csv"');
    res.send(['numero,nombre,edad,distrito,zona,estado,handoff,handoff_motivo,etiquetas,proxima_accion,creado_en', ...filas].join('\n'));
  });

  // Export Excel — bonito y de marca (vs. el CSV plano), mismos datos.
  app.get('/admin/leads.xlsx', async (req, res) => {
    if (!autorizado(req, res)) return;
    const buffer = await buildLeadsWorkbook(db);
    res.set('Content-Type', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet');
    res.set('Content-Disposition', `attachment; filename="pichangueros-leads-${hoyLima()}.xlsx"`);
    res.send(Buffer.from(buffer));
  });

  // Backup manual: descarga el .db completo (checkpoint del WAL primero para
  // que el archivo tenga todo lo escrito hasta este momento).
  app.get('/admin/backup-db', (req, res) => {
    if (!autorizado(req, res)) return;
    db.checkpoint();
    res.download(db.dbPath, `pichangueros-${hoyLima()}.db`);
  });

  // Respaldar a Google Sheet ahora (backup manual desde el panel).
  // Usa el mismo aviso que todo lo demás: antes volvía con ?sync=N y la única
  // pantalla que sabía leerlo era el Resumen.
  app.get('/admin/sync-sheet', async (req, res) => {
    if (!autorizado(req, res)) return;
    const r = await sheetsync.syncToSheet(db);
    volver(res, {
      key: req.query.key,
      aviso: r.ok ? `Respaldado al Google Sheet: ${r.n} contactos.` : 'No se pudo respaldar al Sheet — revisá SHEET_WEBHOOK_URL/SHEET_SECRET.',
      err: !r.ok,
    });
  });

  // Mandar el respaldo completo por correo ahora mismo (no espera las 24 h).
  app.get('/admin/backup-email', async (req, res) => {
    if (!autorizado(req, res)) return;
    const r = await backup.enviarBackup(db, { motivo: 'manual desde el panel' });
    volver(res, {
      key: req.query.key,
      aviso: r.ok ? 'Respaldo enviado por correo.' : 'No se pudo enviar el respaldo por correo.',
      err: !r.ok,
    });
  });

  // --- Configuración del negocio (sedes, precios, textos) — sin tocar código ------
  const volverAConfig = (req, res, aviso, ancla, err) =>
    volver(res, { key: req.body.key, vista: 'config', aviso, ancla, err });

  app.post('/admin/config/general', (req, res) => {
    if (!autorizado(req, res)) return;
    db.setConfig(req.body);
    volverAConfig(req, res, 'Datos del negocio guardados. El bot ya responde con estos textos.', 'general');
  });

  app.post('/admin/config/sede', (req, res) => {
    if (!autorizado(req, res)) return;
    const campos = {
      zona: db.zonasOperativas().includes(req.body.zona) ? req.body.zona : 'brena',
      nombre: (req.body.nombre || '').trim(),
      cancha: (req.body.cancha || '').trim(),
      cupo: req.body.cupo ? Number(req.body.cupo) : null,
      ubicacion: (req.body.ubicacion || '').trim(),
      horario: (req.body.horario || '').trim(),
      estacionamiento: (req.body.estacionamiento || '').trim(),
      // Lo que cuesta alquilar esta cancha por turno: sin este dato el panel
      // muestra lo que ENTRA pero no lo que queda.
      costo: req.body.costo === '' || req.body.costo == null ? null : Number(req.body.costo),
    };
    const ancla = `zona-${campos.zona}`;
    const donde = db.nombreDeZona(campos.zona);
    // Sin nombre no se guardaba nada y la pantalla volvía igual, como si hubiera
    // funcionado: ahora se dice por qué no entró.
    if (!campos.nombre) return volverAConfig(req, res, 'Ponle un nombre a la cancha para poder guardarla.', ancla, true);
    if (req.body.id) {
      db.updateSede(Number(req.body.id), campos);
      return volverAConfig(req, res, `Cancha "${campos.nombre}" guardada en ${donde}.`, ancla);
    }
    db.addSede(campos);
    volverAConfig(req, res, `Cancha "${campos.nombre}" agregada a ${donde}.`, ancla);
  });

  app.post('/admin/config/sede/eliminar', (req, res) => {
    if (!autorizado(req, res)) return;
    const id = Number(req.body.id);
    const sede = db.listSedes().find((s) => s.id === id);
    if (!sede) return volverAConfig(req, res, 'Esa cancha ya no existe.', null, true);
    const donde = db.nombreDeZona(sede.zona);
    // BLOQUEO DEL LADO DEL SERVIDOR (no alcanza un confirm en el cliente):
    // las zonas del sistema NO son una tabla, se derivan de las sedes
    // (db.zonasOperativas). Borrar la última cancha de un distrito lo borra
    // ENTERO y en silencio: sale del guion del bot, de los filtros del CRM y
    // del formulario de partidos, sus leads quedan huérfanos y su precio y su
    // link de grupo dejan de poder guardarse (setConfig ya no acepta esas
    // claves). No hay forma de deshacerlo desde el panel.
    if (db.listSedes(sede.zona).length <= 1) {
      return volverAConfig(req, res,
        `"${sede.nombre}" es la única cancha de ${donde}: si la borras desaparece el distrito entero y se pierden su precio y su link de grupo. Agrega otra cancha primero.`,
        `zona-${sede.zona}`, true);
    }
    db.deleteSede(id);
    volverAConfig(req, res, `Cancha "${sede.nombre}" eliminada de ${donde}.`, `zona-${sede.zona}`);
  });

  // Punto de arranque: deja atrás la historia previa al sistema SIN borrarla.
  app.post('/admin/config/corte', (req, res) => {
    if (!autorizado(req, res)) return;
    const f = db.setCorte(req.body.fecha);
    volverAConfig(req, res, `Punto de arranque: ${fechaCompacta(f)}. Lo anterior queda como historial, no se borró nada.`, 'corte');
  });

  // Precio, link de grupo y nombre para mostrar de UNA zona (tarjeta por distrito).
  app.post('/admin/config/zona', (req, res) => {
    if (!autorizado(req, res)) return;
    const zona = db.zonasOperativas().includes(req.body.zona) ? req.body.zona : null;
    if (!zona) return volverAConfig(req, res, 'Ese distrito ya no existe.', null, true);
    const c = db.getConfigMap();
    const antes = { precio: c[`precio_${zona}`] || '', link: c[`grouplink_${zona}`] || '', nombre: db.nombreDeZona(zona) };
    const ahora = {
      precio: (req.body.precio || '').trim(),
      link: (req.body.grouplink || '').trim(),
      // Vaciar el nombre para mostrar dejaría al distrito sin cómo llamarse.
      nombre: (req.body.nombre_mostrar || '').trim() || antes.nombre,
    };
    db.setConfig({
      [`precio_${zona}`]: ahora.precio,
      [`grouplink_${zona}`]: ahora.link,
      [`zonanombre_${zona}`]: ahora.nombre,
    });
    // Mensaje concreto: "Guardado" a secas no le dice a Clarck si el link que
    // acaba de pegar entró o no — que es justo lo que viene a verificar.
    const cambios = [];
    if (ahora.link !== antes.link) cambios.push(ahora.link ? 'link del grupo guardado' : 'link del grupo quitado');
    if (ahora.precio !== antes.precio) cambios.push(`precio S/ ${ahora.precio || '—'}`);
    if (ahora.nombre !== antes.nombre) cambios.push(`ahora se llama "${ahora.nombre}"`);
    volverAConfig(req, res,
      cambios.length ? `${ahora.nombre}: ${cambios.join(' · ')}.` : `${ahora.nombre}: no cambiaste nada.`,
      `zona-${zona}`);
  });

  // Crear un DISTRITO nuevo: nace con su primera sede (la fuente de verdad de
  // las zonas) y desde ese momento existe en todo el sistema — guion del bot,
  // partidos, clasificación de leads, esta página.
  app.post('/admin/config/zona/nueva', (req, res) => {
    if (!autorizado(req, res)) return;
    const nombre = (req.body.nombre || '').trim().slice(0, 40);
    const zona = slugZona(nombre);
    // Los dos rechazos posibles volvían mudos: la página recargaba igual y el
    // distrito simplemente no estaba.
    if (zona.length < 3) return volverAConfig(req, res, 'Escribe el nombre del distrito (al menos 3 letras).', 'nuevo-distrito', true);
    if (db.zonasOperativas().includes(zona)) {
      return volverAConfig(req, res, `${db.nombreDeZona(zona)} ya existe — está más arriba en esta misma página.`, `zona-${zona}`, true);
    }
    db.addSede({
      zona,
      nombre: (req.body.sede || '').trim().slice(0, 120) || 'Sede por definir',
      cupo: Math.max(2, Math.min(60, Number(req.body.cupo) || 14)),
    });
    db.setConfig({
      [`zonanombre_${zona}`]: nombre,
      [`precio_${zona}`]: (req.body.precio || '').trim() || '15',
    });
    volverAConfig(req, res, `${nombre} creado. Ya aparece en el bot, en Partidos y en los filtros. Falta cargarle el link del grupo.`, `zona-${zona}`);
  });

  // --- Partidos: convocatorias, inscripciones, asistencia ----------------------
  const volverAPartidos = (req, res, partidoId = null, aviso = '', ancla = null, err = false) =>
    volver(res, { key: req.body.key, vista: 'partidos', partido: partidoId, aviso, ancla, err });

  app.post('/admin/partido', (req, res) => {
    if (!autorizado(req, res)) return;
    const zona = db.zonasOperativas().includes(req.body.zona) ? req.body.zona : 'brena';
    const fecha = /^\d{4}-\d{2}-\d{2}$/.test(req.body.fecha || '') ? req.body.fecha : null;
    // Sin fecha volvía a la lista sin partido y sin decir por qué: el usuario
    // no técnico concluye "esto está roto" y se vuelve a WhatsApp.
    if (!fecha) return volverAPartidos(req, res, null, 'Elige el día del partido para poder abrirlo.', null, true);
    const id = db.crearPartido({
      zona, fecha,
      hora: (req.body.hora || '').trim().slice(0, 40),
      sede: (req.body.sede || '').trim().slice(0, 120),
      cupo: Math.max(2, Math.min(60, Number(req.body.cupo) || 14)),
      precio: req.body.precio ? Number(req.body.precio) : null,
    });
    const p = id ? db.getPartido(id) : null;
    // crearPartido rechaza zonas que no son operativas. Acá no debería pasar
    // (la zona ya se sanea arriba), pero si pasa vale más decirlo que romper.
    if (!p) return volverAPartidos(req, res, null, 'No se pudo abrir el partido: revisa el distrito.', null, true);
    volverAPartidos(req, res, id,
      `Partido abierto: ${db.fechaBonita(p.fecha)}${p.hora ? ` · ${p.hora}` : ''}. El bot ya lo ofrece a quien pida jugar.`);
  });

  // Corregir un partido ya creado. Si db lo rechaza (bajar el cupo por debajo
  // de los que ya están adentro), el motivo vuelve en la URL: un fallo mudo
  // hace que Clarck crea que guardó y siga con el dato viejo.
  app.post('/admin/partido/editar', (req, res) => {
    if (!autorizado(req, res)) return;
    const id = Number(req.body.id);
    const r = db.actualizarPartido(id, {
      zona: req.body.zona,
      fecha: req.body.fecha,
      hora: (req.body.hora || '').slice(0, 40),
      sede: (req.body.sede || '').slice(0, 120),
      cupo: req.body.cupo,
      precio: req.body.precio,
    });
    const aviso = r.ok ? 'Partido actualizado. Los inscritos siguen adentro.' : r.motivo;
    volverAPartidos(req, res, id, aviso, r.ok ? null : 'editor', !r.ok);
  });

  app.post('/admin/partido/estado', (req, res) => {
    if (!autorizado(req, res)) return;
    const id = Number(req.body.id);
    const estado = req.body.estado;
    if (!ESTADOS_PARTIDO[estado]) return volverAPartidos(req, res, id, 'Ese estado no existe.', null, true);
    db.setEstadoPartido(id, estado);
    // Cada estado tiene una consecuencia distinta y ninguna era visible.
    const avisos = {
      cerrado: 'Inscripción cerrada: el bot deja de ofrecer este partido.',
      abierto: 'Inscripción reabierta: el bot vuelve a ofrecerlo.',
      jugado: 'Partido marcado como jugado. Ya cuenta para los recurrentes.',
      cancelado: 'Partido cancelado. Nadie recibe aviso automático: escríbeles tú.',
    };
    volverAPartidos(req, res, id, avisos[estado]);
  });

  // Eliminar un partido vacío (duplicado o cargado por error). Con gente
  // adentro db lo rechaza — ahí corresponde "cancelar", no borrar.
  app.post('/admin/partido/eliminar', (req, res) => {
    if (!autorizado(req, res)) return;
    const id = Number(req.body.id);
    if (!db.eliminarPartido(id)) {
      return volverAPartidos(req, res, id, 'Este partido tiene gente inscrita: no se borra. Usa "✖ Cancelar".', null, true);
    }
    volverAPartidos(req, res, null, 'Partido eliminado (estaba vacío).');
  });

  // Inscripción manual desde el panel (jugador con número, o invitado a nombre).
  app.post('/admin/partido/inscribir', (req, res) => {
    if (!autorizado(req, res)) return;
    const partidoId = Number(req.body.partido_id);
    const numero = (req.body.numero || '').replace(/\D/g, '') || null;
    const nombre = (req.body.nombre || '').trim().slice(0, 80) || null;
    const fin = (aviso, err) => volverAPartidos(req, res, partidoId, aviso, 'inscritos', err);
    if (!numero && !nombre) return fin('Escribe el número de WhatsApp o el nombre del invitado.', true);
    const p = db.getPartido(partidoId);
    if (!p) return fin('Ese partido ya no existe.', true);
    // El caso real: cierra la inscripción, llega un amigo a la cancha y el
    // botón no hacía absolutamente nada, sin explicación.
    if (p.estado !== 'abierto') {
      return fin(`El partido está ${(ESTADOS_PARTIDO[p.estado] || p.estado).toLowerCase()}: tócale "🔓 Reabrir" y vuelve a anotarlo.`, true);
    }
    const { resultado, motivo } = db.inscribir(partidoId, numero, { nombre });
    const quien = nombre || `+${numero}`;
    if (resultado === 'espera') return fin(`${quien} entró a la LISTA DE ESPERA: el partido ya está lleno.`);
    if (resultado === 'ya_inscrito') return fin(`${quien} ya estaba en la lista.`, true);
    if (!resultado) {
      return fin(motivo === 'no_existe'
        ? 'Ese partido ya no existe.'
        : `No se pudo anotar a ${quien}: el partido está ${(ESTADOS_PARTIDO[motivo] || motivo || '?').toLowerCase()}.`, true);
    }
    fin(`${quien} anotado. Falta que pague.`);
  });

  app.post('/admin/inscripcion/estado', (req, res) => {
    if (!autorizado(req, res)) return;
    const id = Number(req.body.id);
    const partidoId = Number(req.body.partido_id);
    const previa = db.inscripcionesDe(partidoId).find((i) => i.id === id);
    const nombreInsc = (i) => (i ? (i.nombre || i.lead_nombre || (i.numero ? `+${i.numero}` : 'el jugador')) : 'el jugador');
    const quien = nombreInsc(previa);
    if (req.body.estado === 'baja') {
      const promovido = db.darDeBaja(id);
      // El que sube de la espera NO se entera solo: el bot no puede iniciarle
      // conversación (131047 fuera de la ventana de 24 h). Se le avisa al
      // número de control para que Clarck le escriba y le pida el Yape.
      const control = (process.env.NOTIFY_NUMBER || '').replace(/\D/g, '');
      let subio = '';
      if (promovido) {
        const lead = promovido.numero ? db.getLead(promovido.numero) : null;
        const quienProm = promovido.nombre || (lead && lead.nombre) || (promovido.numero ? `+${promovido.numero}` : 'alguien');
        subio = ` Subió ${quienProm} de la lista de espera: escríbele y pídele su Yape.`;
        if (control && conexion && conexion.enviar) {
          const p = db.getPartido(promovido.partido_id);
          Promise.resolve(conexion.enviar(control,
            `⬆ ${quienProm} subió de la lista de espera al partido del ${p ? db.fechaBonita(p.fecha) : '?'}${p && p.hora ? ` ${p.hora}` : ''}. Avísale y pídele su Yape${promovido.numero ? `: wa.me/${promovido.numero}` : ''}.`
          )).catch((e) => console.error('[partido] Aviso de promoción falló:', e.message));
        }
      }
      // Tras la baja la fila desaparece de la lista: el ancla va al bloque.
      return volverAPartidos(req, res, partidoId, `${quien} dado de baja.${subio}`, 'inscritos');
    }
    const cambio = db.setEstadoInscripcion(id, req.body.estado);
    if (cambio.motivo === 'lleno') {
      // Antes esto sobrevendía la cancha en silencio: el UPDATE pasaba igual y
      // quedaban 15 jugadores en un cupo de 14.
      return volverAPartidos(req, res, partidoId,
        `La cancha está llena: ${quien} se queda en la lista de espera. Da de baja a alguien primero, o sube el cupo.`,
        `insc-${id}`, true);
    }
    if (!cambio.inscripcion) {
      return volverAPartidos(req, res, partidoId, 'Ese cambio no existe.', 'inscritos', true);
    }
    const avisos = { pagado: `${quien}: pago marcado ✔`, reservado: `${quien} subió de la espera a la cancha.`, espera: `${quien} pasó a la lista de espera.` };
    volverAPartidos(req, res, partidoId, avisos[req.body.estado] || 'Listo.', `insc-${id}`);
  });

  app.post('/admin/inscripcion/asistencia', (req, res) => {
    if (!autorizado(req, res)) return;
    const id = Number(req.body.id);
    const partidoId = Number(req.body.partido_id);
    const insc = db.inscripcionesDe(partidoId).find((i) => i.id === id);
    const quien = insc ? (insc.nombre || insc.lead_nombre || (insc.numero ? `+${insc.numero}` : 'el jugador')) : 'el jugador';
    const valor = req.body.valor;
    db.setAsistencia(id, valor);
    // ANCLA a la fila: pasar lista son 14 toques seguidos, parado en la cancha.
    // Sin esto cada toque recargaba y devolvía arriba de todo, y había que
    // volver a bajar hasta donde ibas.
    volverAPartidos(req, res, partidoId,
      `${quien}: ${valor === 'si' ? 'vino ✔' : valor === 'no' ? 'faltó ✘' : 'sin marcar'}`, `insc-${id}`);
  });

  // Asignar a un partido un pago confirmado que quedó sin vincular.
  app.post('/admin/pago/asignar', (req, res) => {
    if (!autorizado(req, res)) return;
    const partidoId = Number(req.body.partido_id);
    const pago = db.listPagosTodos().find((p) => p.id === Number(req.body.pago_id));
    const fin = (aviso, err) => volverAPartidos(req, res, partidoId, aviso, 'pagos-sueltos', err);
    if (!pago) return fin('Ese pago ya no está disponible.', true);
    const partido = db.getPartido(partidoId);
    if (!partido) return fin('Ese partido ya no existe.', true);
    // Si el pagador YA tiene inscripción activa en este partido, se le
    // vincula el pago (inscribir devolvería 'ya_inscrito' sin hacer nada y
    // el botón quedaba muerto — hallazgo del code review 2026-08-11).
    const activa = pago.numero ? db.inscripcionActiva(partidoId, pago.numero) : null;
    if (activa) db.pagarInscripcion(activa.id, pago.id);
    else {
      // Sobre un partido cerrado, inscribir() devuelve null y el pago se
      // quedaba suelto sin que nadie lo dijera.
      if (partido.estado !== 'abierto') {
        return fin(`El partido está ${(ESTADOS_PARTIDO[partido.estado] || partido.estado).toLowerCase()}: reábrelo para poder asignarle este pago.`, true);
      }
      db.inscribir(partidoId, pago.numero, { estado: 'pagado', pagoId: pago.id });
    }
    for (let i = 1; i < (pago.cupos || 1); i++) db.inscribir(partidoId, null, { nombre: `Invitado de +${pago.numero}`, estado: 'pagado', pagoId: pago.id });
    fin(`Pago de ${pago.nombre || `+${pago.numero}`} (S/ ${pago.monto}) asignado a este partido.`);
  });

  // --- Conexión (WhatsApp): desconectar / cambiar de número --------------------
  // Mensaje suelto desde el panel (prueba de conexión o aviso manual).
  app.post('/admin/enviar', async (req, res) => {
    if (!autorizado(req, res)) return;
    const numero = (req.body.numero || '').replace(/\D/g, '');
    const texto = (req.body.texto || '').trim().slice(0, 1000);
    if (!numero || !texto) return res.status(400).json({ ok: false, error: 'faltan numero/texto' });
    if (!conexion || !conexion.enviar) return res.status(500).json({ ok: false, error: 'conexión no disponible' });
    res.json(await conexion.enviar(numero, texto));
  });

  app.post('/admin/conexion/desconectar', async (req, res) => {
    if (!autorizado(req, res)) return;
    if (conexion) await conexion.desconectar();
    volverAConfig(req, res, 'Canal desconectado.', 'canal');
  });

  // --- Vistas ----------------------------------------------------------------------
  app.get('/admin/leads', (req, res) => {
    if (!autorizado(req, res)) return;
    const key = encodeURIComponent(req.query.key);
    const numero = (req.query.numero || '').replace(/\D/g, '');
    // Ficha y Ajustes también reciben la query: ahí viven los avisos de
    // "guardado" que antes no tenían dónde mostrarse.
    if (numero) return res.send(paginaFicha(db, key, numero, req.query));
    if (req.query.vista === 'crm') return res.send(paginaCRM(db, key, req.query));
    if (req.query.vista === 'pagos') return res.send(paginaPagos(db, key, req.query));
    if (req.query.vista === 'partidos') return res.send(paginaPartidos(db, key, req.query));
    if (req.query.vista === 'config') return res.send(paginaConfig(db, key, conexion, req.query));
    // La vista de conexión dejó de existir (era el QR de Baileys, que con el
    // canal oficial no llega nunca). Se redirige en vez de 404: hay links
    // viejos en el historial de Clarck y en mensajes que ya le mandamos.
    if (req.query.vista === 'conexion') return res.redirect(`/admin/leads?key=${key}&vista=config`);
    res.send(paginaResumen(db, key, req.query));
  });
}

// ==============================================================================
//  Base HTML + sistema de diseño iOS
// ==============================================================================
/**
 * Hoja de estilos del panel.
 *
 * Vive en una constante y no dentro del template de baseHtml por dos razones:
 * se arma UNA vez al arrancar en vez de en cada request, y se sirve SIN los
 * comentarios. Los comentarios de acá abajo explican por qué cada decisión es
 * como es —valen para quien toque el archivo— pero son ~13 KB que el celular de
 * Clarck no necesita bajar parado en una cancha con 4G malo, y el servidor no
 * tiene compresión, así que cada KB se paga entero.
 */
const ESTILOS = `
  /* Sistema de diseño Pichangueros v3 (2026-08-15).
     Sigue la propuesta v2 —hairline, sombra difusa, lima del logo, marcador
     navy, cifras en display itálico— y le pone abajo un sistema de tokens.
     Los tres cambios de fondo, todos por la misma razón (Clarck lo abre en el
     celular, parado en una cancha, de noche, con una mano):

     1. CONTRASTE. Todo par texto/fondo llega a 4.5:1 y todo borde o barra que
        comunica algo llega a 3:1. Los ratios están anotados al lado de cada
        token; están calculados, no estimados.
     2. UN SOLO SISTEMA. Antes había tres rojos (#D14538, #cc2f26, #FF3B30), dos
        ámbares, seis nombres para tres colores y 26 tamaños de fuente. Ahora hay
        escalas: espaciado de 4, radios, tipos, y un color por ESTADO.
     3. EL COLOR ES ESTADO, NO DECORACIÓN. pagado / debe / alerta / lleno /
        cancelado, cada uno con su glifo — el color solo no sirve con
        daltonismo ni con la pantalla a contraluz. */
  :root{
    /* ---------- SUPERFICIES ---------- */
    --bg:#F2F5F8; --surface:#FFFFFF; --surface-2:#F5F8FB; --surface-3:#E9EEF4;
    --line:#DFE6EE;              /* hairline separador (decorativo) */
    --line-strong:#8494A8;       /* borde de control — 3.10:1 sobre blanco */
    --desk:#E9EEF4;              /* el "escritorio" detrás del panel en pantalla grande */

    /* ---------- TINTA ---------- */
    --ink:#0F1B2A;               /* 17.35:1 — el dato, el título, el valor */
    --ink-2:#4C5C6E;             /*  6.86:1 — etiqueta, subtítulo, ayuda */
    --ink-3:#5E6E82;             /*  5.21:1 sobre blanco · 4.76:1 sobre --bg.
                                    Lo más tenue permitido. Reemplaza al viejo
                                    --faint #8B98A8, que era 2.94:1 y cargaba el
                                    estado de cada inscripción y toda .shdr. */
    --on-lime:#16385F;           /*  6.03:1 — SOBRE LIMA LA TINTA ES NAVY, NUNCA
                                    BLANCO: blanco sobre lima da 1.97:1 y era lo
                                    que tenían "Copiar lista" y el botón WhatsApp. */
    --on-navy:#FFFFFF;           /* 11.90:1 */
    --on-navy-2:#C4D1DF;         /*  9.94:1 — secundario dentro del marcador */
    --on-navy-3:#A8BEDC;         /*  5.23:1 — el más tenue del marcador */
    /* Acentos DENTRO del marcador: el navy es oscuro en los dos modos, así que
       estos tres no cambian con el modo oscuro. */
    --on-navy-ok:#C6E34E;        /* 10.65:1 sobre el navy profundo */
    --on-navy-debe:#F0B857;      /*  8.59:1 */
    --on-navy-rec:#8FB3E0;       /*  7.12:1 — la serie "recurrentes" del gráfico */

    /* ---------- MARCA ---------- */
    --lime:#A3C614;              /* relleno de marca; solo con --on-lime encima */
    --lime-fill:#7E9C0D;         /* 3.16:1 — barras y puntos lima sobre blanco */
    --lime-ink:#55770B;          /* 5.21:1 — texto verde sobre claro */
    --lime-tint:#EDF5D3;         /* con --lime-ink = 4.62:1 */
    /* --navy es el navy COMO TEXTO sobre claro; en modo oscuro se aclara para
       seguir leyéndose. --navy-fill es el navy COMO RELLENO (chip activo, tarjeta
       seleccionada): ese tiene que seguir siendo oscuro en los dos modos, porque
       encima siempre lleva blanco. Confundirlos deja texto blanco sobre celeste. */
    --navy:#16385F; --navy-2:#1E4470; --navy-9:#0E2542;
    --navy-fill:#16385F;
    --grad-marcador:linear-gradient(160deg,var(--navy-2),var(--navy-9));

    /* ---------- ESTADO (color + glifo, nunca color solo) ---------- */
    --st-ok-ink:#55770B;     --st-ok-bg:#EDF5D3;     --st-ok-solid:#55770B;
    --st-debe-ink:#8A5200;   --st-debe-bg:#FCEFD8;   --st-debe-solid:#9A5B00;
    --st-alerta-ink:#B3261E; --st-alerta-bg:#FBE7E5; --st-alerta-solid:#C4362B;
    --st-lleno-ink:#16385F;  --st-lleno-bg:#E4EAF2;  --st-lleno-solid:#16385F;
    --st-off-ink:#4C5C6E;    --st-off-bg:#ECF0F5;    --st-off-solid:#4F5B6B;
    /* Escalón medio de la rampa del embudo (navy → teal → ámbar → lima). */
    --ramp-mid:#0A6570;          /* 6.76:1 con blanco encima */

    /* ---------- ESPACIADO, RADIOS, TÁCTIL ---------- */
    --s1:4px; --s2:8px; --s3:12px; --s4:16px; --s5:20px; --s6:24px; --s7:32px;
    --r1:8px; --r2:12px; --r3:16px; --r4:20px; --rp:999px;
    --tap:44px;                  /* mínimo de cualquier cosa tocable */
    --tap-lg:52px;               /* la acción principal de la pantalla */
    --gap-peligro:var(--s6);     /* aire mínimo entre lo común y lo destructivo */

    /* ---------- TIPOGRAFÍA ----------
       Sin fuentes remotas: el panel corre en Render y tiene que funcionar solo.
       Antes cargaba Inter y Big Shoulders desde el servicio de fuentes de Google
       con un <link rel=stylesheet>, que BLOQUEA el render: con 4G malo en la
       cancha la página se quedaba en blanco esperando esa respuesta, y si la
       fuente no llegaba el marcador pasaba de condensada a normal y se salía de
       su caja. Ahora el panel no le pide NADA a nadie. */
    --font-ui:-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,'Helvetica Neue',Arial,sans-serif;
    --font-num:var(--font-ui);
    --font-mono:ui-monospace,SFMono-Regular,'SF Mono',Consolas,'Liberation Mono',monospace;
    --t-eyebrow:11px;            /* SOLO mayúsculas + 700 + tracking */
    --t-xs:12px; --t-s:13px; --t-m:15px; --t-l:17px; --t-xl:20px; --t-2xl:26px;
    --t-input:16px;              /* INTOCABLE: por debajo, iOS hace zoom al
                                    enfocar y deja la página ampliada con scroll
                                    horizontal, que es lo peor con una mano */
    --n-s:30px; --n-m:42px; --n-l:58px;
    --track-num:-.02em;          /* compensa la pérdida de la condensada */

    /* ---------- SOMBRAS ---------- */
    --sombra:0 1px 2px rgba(15,27,42,.05), 0 6px 16px rgba(15,27,42,.06);
    --sombra-alta:0 2px 4px rgba(15,27,42,.06), 0 12px 28px rgba(15,27,42,.10);
    --sh-marcador:0 4px 10px rgba(14,37,66,.18), 0 16px 32px rgba(14,37,66,.15);
    --focus:0 0 0 3px rgba(22,56,95,.18), 0 0 0 1.5px var(--navy);
  }

  /* MODO OSCURO — solo se redefinen tokens, ninguna regla de componente cambia.
     Clarck usa esto de noche: una pantalla casi blanca a brillo alto encandila
     y después no se ve ni la cancha ni el celular. */
  @media (prefers-color-scheme:dark){
    :root{
      --bg:#0D131C; --surface:#161E2A; --surface-2:#1D2733; --surface-3:#25313F;
      --line:#2F3C4C;            /* 1.49:1 — hairline visible sin brillar */
      --line-strong:#5F7793;     /* 3.63:1 */
      --desk:#070B11;
      --ink:#EAF0F7;             /* 14.61:1 */
      --ink-2:#A8B7C8;           /*  8.20:1 */
      --ink-3:#8B9BAD;           /*  5.90:1 */
      --on-lime:#0F1B2A;         /*  8.79:1 — el lima sigue claro, la tinta oscura */
      /* --on-navy-* NO se redefinen a propósito: el marcador es oscuro en los
         dos modos, así que su tinta es la misma. Redefinirla más oscura bajaba
         el rótulo del marcador a 3.98:1 justo en el modo nocturno. */
      --lime-fill:#A3C614;       /* sobre superficie oscura el lima ya destaca */
      --lime-ink:#C3E24E;        /* 11.42:1 — el #55770B sería ilegible acá */
      --lime-tint:#24310C;       /* con --lime-ink = 9.42:1 */
      --navy:#8FB6E8;            /*  8.00:1 como TEXTO */
      --navy-fill:#1E4470;       /* como RELLENO sigue oscuro: lleva blanco encima */
      --navy-9:#0B1B2E; --navy-2:#1B3A5C;
      --grad-marcador:linear-gradient(160deg,var(--navy-2),var(--navy-9));
      --st-ok-ink:#9BD24B;     --st-ok-bg:#22300C;     --st-ok-solid:#4C7A12;
      --st-debe-ink:#F0B857;   --st-debe-bg:#37260A;   --st-debe-solid:#8A5200;
      --st-alerta-ink:#FF9A8F; --st-alerta-bg:#3A1A17; --st-alerta-solid:#B3352A;
      --st-lleno-ink:#8FB6E8;  --st-lleno-bg:#17273A;  --st-lleno-solid:#1E4470;
      --st-off-ink:#A8B7C8;    --st-off-bg:#212B38;    --st-off-solid:#3C4A5C;
      /* En oscuro la sombra no despega la tarjeta del fondo: el relieve lo da
         el borde. Sombras suaves solo para que no se vea plano. */
      --sombra:0 1px 2px rgba(0,0,0,.35);
      --sombra-alta:0 4px 16px rgba(0,0,0,.45);
      --sh-marcador:0 4px 18px rgba(0,0,0,.5);
      --focus:0 0 0 3px rgba(143,182,232,.28), 0 0 0 1.5px #8FB6E8;
    }
    /* La barra translúcida blanca sería una linterna en la cara. */
    .tabbar{background:rgba(22,30,42,.94)}
  }
  @media (prefers-reduced-motion:reduce){
    *,*::before,*::after{animation-duration:.001ms!important;animation-iteration-count:1!important;
      transition-duration:.001ms!important}
  }

  *{box-sizing:border-box;margin:0;padding:0;-webkit-font-smoothing:antialiased;-webkit-tap-highlight-color:transparent}
  body{font-family:var(--font-ui);color:var(--ink);background:var(--bg);
    min-height:100vh;line-height:1.45;overflow-x:hidden}
  a{color:inherit;text-decoration:none}
  /* Se quitó el resaltado nativo del toque (arriba) y hay outline:none suelto en
     varios inputs: sin esto no quedaba NINGUNA señal de foco en toda la app. */
  a:focus-visible,button:focus-visible,input:focus-visible,select:focus-visible,
  textarea:focus-visible,summary:focus-visible{outline:none;box-shadow:var(--focus);border-radius:var(--r1)}

  /* Cifras: el carácter del marcador sin fuente remota. Peso 800 + itálica del
     sistema (SF Pro y Segoe UI tienen itálica real) + tracking cerrado que
     compensa la condensada que se perdió + tabular para que no bailen al
     refrescar cada 90 s. */
  .num{font-family:var(--font-num);font-weight:800;font-style:italic;
    letter-spacing:var(--track-num);font-variant-numeric:tabular-nums;line-height:1}

  .app{max-width:480px;margin:0 auto;min-height:100vh;background:var(--bg);
    padding:calc(env(safe-area-inset-top) + 8px) 0 96px;position:relative}
  .px{padding-left:16px;padding-right:16px}

  /* large title */
  .ltitle{padding:6px 18px 10px;display:flex;align-items:flex-end;justify-content:space-between;gap:10px}
  .ltitle .eyebrow{font-size:var(--t-eyebrow);font-weight:700;letter-spacing:.16em;text-transform:uppercase;color:var(--lime-ink);margin-bottom:2px}
  .ltitle h2{font-size:29px;font-weight:800;letter-spacing:-.02em;line-height:1.1;color:var(--ink)}
  .live{display:inline-flex;align-items:center;gap:6px;font-size:var(--t-xs);font-weight:600;color:var(--lime-ink);
    background:var(--lime-tint);padding:5px 11px;border-radius:var(--rp);white-space:nowrap}
  .live i{width:7px;height:7px;border-radius:50%;background:var(--lime);animation:pulse 2s infinite}
  @keyframes pulse{0%{box-shadow:0 0 0 0 rgba(163,198,20,.5)}70%{box-shadow:0 0 0 7px rgba(163,198,20,0)}100%{box-shadow:0 0 0 0 rgba(163,198,20,0)}}
  .csv{display:inline-flex;align-items:center;min-height:var(--tap);font-size:var(--t-s);color:var(--ink-2);
    border:1.5px solid var(--line-strong);background:var(--surface);padding:0 14px;border-radius:var(--rp);white-space:nowrap}

  /* scoreboard hero */
  .marcador{background:var(--grad-marcador);border:none;border-radius:var(--r4);padding:19px 20px 17px;
    color:var(--on-navy);position:relative;overflow:hidden;box-shadow:var(--sh-marcador);margin:2px 0 0}
  .marcador::before{content:"";position:absolute;inset:0;
    background:repeating-linear-gradient(90deg,transparent 0 30px,rgba(255,255,255,.025) 30px 60px)}
  .marcador>*{position:relative}
  .mtop{display:flex;justify-content:space-between;align-items:center}
  .mlabel{font-size:var(--t-eyebrow);font-weight:700;letter-spacing:.16em;text-transform:uppercase;color:var(--on-navy-3)}
  .mdelta{font-size:var(--t-xs);font-weight:700;color:var(--on-navy-ok);background:rgba(163,198,20,.16);padding:4px 10px;border-radius:var(--rp)}
  /* 58px y no 62: sin la condensada el número ocupa más ancho, y a 62 se salía
     de la caja del marcador en 360px. */
  .mnum{font-family:var(--font-num);font-style:italic;font-weight:800;font-size:var(--n-l);
    letter-spacing:var(--track-num);line-height:.95;color:var(--on-navy);margin-top:2px;font-variant-numeric:tabular-nums}
  /* El gráfico de 14 días tenía las etiquetas de día a 8px y los números a 9px,
     en un azul de 4.33:1 sobre el navy. A 8px, de noche y a contraluz, eso no se
     lee: es tinta gastada. Ahora 11px mínimo y --on-navy-2 (9.94:1). Como 14
     etiquetas de 11px no entran en 360px, en móvil se muestra una de cada dos
     (la de hoy siempre) y desde 520px vuelven todas. */
  .bars{display:flex;align-items:flex-end;gap:3px;height:74px;margin-top:10px}
  .bar{flex:1;display:flex;flex-direction:column;align-items:center;gap:3px;height:100%;min-width:0}
  .bar .bn{font-size:var(--t-eyebrow);font-weight:700;color:var(--on-navy-2);line-height:1;min-height:12px}
  .bar .track{flex:1;width:100%;display:flex;flex-direction:column;justify-content:flex-end;gap:1px}
  .bar .track i{width:100%;background:linear-gradient(180deg,var(--on-navy-ok),var(--lime));border-radius:2px;min-height:3px;display:block;opacity:.95}
  .bar .track i.brec{background:linear-gradient(180deg,var(--on-navy-rec),#5A7FB5);opacity:.9}
  .bar.hot .track i.bnue{background:linear-gradient(180deg,#DFF29A,var(--on-navy-ok))}
  .bar.hot .bn{color:var(--on-navy-ok)}
  .bar .bd{font-size:var(--t-eyebrow);color:var(--on-navy-2);line-height:1;white-space:nowrap;margin-top:2px}
  .bar .bd.bhoy{color:var(--on-navy-ok);font-weight:800}
  @media (max-width:519px){
    .bar:nth-child(even) .bd:not(.bhoy){visibility:hidden}
  }
  .mfoot{font-size:var(--t-xs);color:var(--on-navy-2);margin-top:8px;line-height:1.4}

  /* banner — casi todos son enlaces: 44px de alto para que sean tocables. */
  .banner{display:flex;gap:var(--s3);align-items:center;min-height:var(--tap);
    background:var(--st-debe-bg);border:1px solid var(--st-debe-ink);border-left-width:4px;
    border-radius:var(--r3);padding:13px 15px;margin-top:14px;box-shadow:var(--sombra)}
  .banner.ok{background:var(--st-ok-bg);border-color:var(--st-ok-ink)}
  .bic{flex:0 0 auto;width:34px;height:34px;border-radius:var(--r1);background:var(--st-debe-solid);
    color:#fff;display:grid;place-items:center;font-size:18px}
  .banner.ok .bic{background:var(--st-ok-solid)}
  .btxt{font-size:var(--t-s);line-height:1.4;color:var(--st-debe-ink)}
  .banner.ok .btxt{color:var(--st-ok-ink)}
  .btxt b{font-weight:700}

  /* stat grid */
  .grid2{display:grid;grid-template-columns:1fr 1fr;gap:11px;margin-top:14px}
  .stat{background:var(--surface);border:1px solid var(--line);border-radius:var(--r3);padding:14px 15px;box-shadow:var(--sombra);display:block}
  /* overflow-wrap: un "S/ 12,345" a 30px no entra en una tarjeta de 163px
     (360px de pantalla, dos columnas) — que corte antes de desbordar. */
  .stat .sn{font-family:var(--font-num);font-style:italic;font-weight:800;font-size:var(--n-s);
    letter-spacing:var(--track-num);line-height:1.05;font-variant-numeric:tabular-nums;overflow-wrap:anywhere}
  .stat .sl{font-size:var(--t-s);color:var(--ink-2);font-weight:500;margin-top:4px}
  .stat.amber .sn{color:var(--st-debe-ink)} .stat.green .sn{color:var(--lime-ink)} .stat.navy .sn{color:var(--navy)} .stat.red .sn{color:var(--st-alerta-ink)}
  /* Tarjeta-filtro activa: se ve que ESA es la que está aplicada. */
  .stat.sel{background:var(--navy-fill);box-shadow:var(--sombra)}
  .stat.sel .sn,.stat.sel .sl{color:#fff}
  a.stat:hover{transform:translateY(-1px);box-shadow:var(--sombra-alta)}
  .stat .chip{float:right;font-size:var(--t-xs);font-weight:700;padding:3px 9px;border-radius:var(--rp)}
  .chip.up{background:var(--st-ok-bg);color:var(--st-ok-ink)}
  .chip.wait{background:var(--st-debe-bg);color:var(--st-debe-ink)}

  /* section header — era 11.5px en el gris más tenue (2.94:1) siendo el título
     de CADA sección de CADA vista. */
  .shdr{font-size:var(--t-xs);font-weight:800;letter-spacing:.09em;text-transform:uppercase;color:var(--ink-2);padding:22px 6px 9px;display:flex;align-items:center;gap:8px;flex-wrap:wrap}
  .shdr small{text-transform:none;letter-spacing:0;font-weight:400;font-size:var(--t-s);color:var(--ink-2)}

  /* zona rows */
  .zlist{background:var(--surface);border:1px solid var(--line);border-radius:var(--r3);overflow:hidden;box-shadow:var(--sombra)}
  /* Rejilla en vez de flex: el nombre tenía flex 0 0 96px con nowrap, así que
     "Sin sede cerca", "Escribieron al número" o "Dejaron sus datos · nombre ·
     edad · distrito" se desbordaban ENCIMA de la barra. Ahora el nombre ocupa
     la fila entera y la barra va debajo, que además es donde se compara mejor. */
  .zrow{display:grid;grid-template-columns:11px minmax(0,1fr) auto;align-items:center;
    gap:6px 12px;min-height:var(--tap);padding:12px 15px;border-bottom:1px solid var(--line)}
  .zrow:last-child{border-bottom:none}
  .zrow:active{background:var(--surface-3)}
  .zdot{width:11px;height:11px;border-radius:3px;flex:0 0 auto;grid-row:1}
  .zname{font-size:var(--t-m);font-weight:600;min-width:0;grid-row:1;
    overflow:hidden;text-overflow:ellipsis}
  .zval{font-size:var(--t-s);font-weight:700;color:var(--ink-2);grid-row:1;text-align:right;
    white-space:nowrap;font-variant-numeric:tabular-nums}
  .ztrack{grid-row:2;grid-column:2/-1;height:8px;background:var(--surface-3);border-radius:var(--rp);overflow:hidden}
  .ztrack i{display:block;height:100%;border-radius:var(--rp)}
  @media (min-width:520px){
    /* Con ancho de sobra vuelve a la línea única, pero con el nombre elástico. */
    .zrow{grid-template-columns:11px minmax(90px,auto) minmax(0,1fr) auto}
    .ztrack{grid-row:1;grid-column:3}
  }

  /* search + chips */
  .search{display:flex;align-items:center;gap:var(--s2);background:var(--surface-2);border:1px solid var(--line-strong);
    border-radius:var(--r2);padding:0 13px;margin:2px 0 4px;min-height:var(--tap)}
  .search svg{flex:0 0 auto;color:var(--ink-3)}
  /* 16px: era 15 y con eso iOS ya amplía al enfocar. */
  .search input{flex:1;min-width:0;border:none;background:transparent;outline:none;font:inherit;
    font-size:var(--t-input);padding:11px 0;color:var(--ink)}
  .search input::placeholder{color:var(--ink-3)}
  .search button{min-height:36px;border:1px solid var(--lime);background:var(--lime);color:var(--on-lime);
    font:inherit;font-weight:800;font-size:var(--t-s);padding:0 14px;border-radius:var(--r1);cursor:pointer}

  /* Chips de filtro: 44px. Eran 32 y hay CATORCE en el CRM — el objetivo más
     repetido de la app era también el más chico. */
  .chips{display:flex;gap:var(--s2);padding:var(--s2) 2px var(--s1);flex-wrap:wrap}
  .fchip{display:inline-flex;align-items:center;justify-content:center;min-height:var(--tap);
    font-size:var(--t-s);font-weight:600;color:var(--ink-2);background:var(--surface);
    border:1.5px solid var(--line-strong);padding:0 14px;border-radius:var(--rp);white-space:nowrap}
  /* El filtro puesto lleva ✓ además del relleno: en escala de grises un chip
     navy y uno blanco se parecen más de lo que uno cree. */
  .fchip.on{background:var(--navy-fill);color:#fff;border-color:var(--navy-fill);font-weight:700}
  .fchip.on::before{content:"✓ ";font-weight:800}
  .fchip.amber.on{background:var(--st-debe-solid);border-color:var(--st-debe-solid);color:#fff}
  .fchip.red.on{background:var(--st-alerta-solid);border-color:var(--st-alerta-solid);color:#fff}

  /* barra de filtros (selects estilo slicer) */
  .fbar{display:flex;gap:var(--s2);flex-wrap:wrap;margin:var(--s3) 0 2px}
  .fbar select,.fbar input[type=date]{flex:1;min-width:130px;min-height:var(--tap);background:var(--surface);
    border:1.5px solid var(--line-strong);border-radius:var(--r2);padding:0 11px;font:inherit;
    font-size:var(--t-input);font-weight:600;color:var(--ink);outline:none;
    -webkit-appearance:none;appearance:none}
  .fbar select{background-image:url("data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' width='12' height='7'%3E%3Cpath d='M1 1l5 5 5-5' stroke='%235E6E82' stroke-width='1.8' fill='none' stroke-linecap='round'/%3E%3C/svg%3E");
    background-repeat:no-repeat;background-position:right 11px center;padding-right:30px}

  /* lead list */
  .llist{background:var(--surface);border:1px solid var(--line);border-radius:var(--r3);overflow:hidden;box-shadow:var(--sombra)}
  .lrow{display:flex;align-items:center;gap:13px;min-height:var(--tap);padding:12px 14px;border-bottom:1px solid var(--line);position:relative}
  .lrow:last-child{border-bottom:none}
  .lrow:active{background:var(--surface-3)}
  .ava{width:44px;height:44px;border-radius:50%;flex:0 0 auto;display:grid;place-items:center;font-weight:700;font-size:15px;color:#fff}
  .lbody{flex:1;min-width:0;overflow:hidden;display:flex;flex-direction:column}
  .lname{font-size:var(--t-m);font-weight:600;letter-spacing:-.01em;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
  .lsub{font-size:var(--t-s);color:var(--ink-2);margin-top:2px;white-space:nowrap;overflow:hidden;text-overflow:ellipsis;max-width:100%}
  .lmeta{display:flex;flex-direction:column;align-items:flex-end;gap:5px;flex:0 0 auto;margin-left:10px}
  .ltime{font-size:var(--t-xs);color:var(--ink-3);white-space:nowrap}

  /* Badges de estado. 12px (eran 10, ilegibles de noche) y con BORDE del color
     de su tinta: el borde da una segunda señal además del relleno, para que se
     distingan en escala de grises y con daltonismo. */
  .badge{font-size:var(--t-xs);font-weight:700;padding:3px 9px;border-radius:var(--rp);
    white-space:nowrap;border:1px solid transparent}
  .b-wait{background:var(--st-debe-bg);color:var(--st-debe-ink);border-color:var(--st-debe-ink)}
  .b-hand{background:var(--st-alerta-bg);color:var(--st-alerta-ink);border-color:var(--st-alerta-ink)}
  .b-done{background:var(--st-ok-bg);color:var(--st-ok-ink);border-color:var(--st-ok-ink)}
  .b-new{background:var(--st-off-bg);color:var(--st-off-ink);border-color:var(--st-off-ink)}
  .b-zona{color:#fff;border-color:transparent}

  /* Chip de estado con glifo puesto por CSS: para los estados que hoy se
     comunicaban SOLO con color (el "12/14" que se pintaba de ámbar al llenarse
     era indistinguible del verde con deuteranopia). El glifo no se puede
     olvidar porque no se escribe en el markup. */
  .est{display:inline-flex;align-items:center;gap:5px;font-size:var(--t-xs);font-weight:700;
    padding:4px 10px;border-radius:var(--rp);border:1px solid transparent;white-space:nowrap}
  .est::before{font-size:11px;line-height:1}
  .est-ok{background:var(--st-ok-bg);color:var(--st-ok-ink);border-color:var(--st-ok-ink)}
  .est-ok::before{content:"✓"}
  .est-debe{background:var(--st-debe-bg);color:var(--st-debe-ink);border-color:var(--st-debe-ink)}
  .est-debe::before{content:"⏳"}
  .est-alerta{background:var(--st-alerta-bg);color:var(--st-alerta-ink);border-color:var(--st-alerta-ink)}
  .est-alerta::before{content:"!"}
  .est-lleno{background:var(--st-lleno-bg);color:var(--st-lleno-ink);border-color:var(--st-lleno-ink)}
  .est-lleno::before{content:"●"}
  .est-off{background:var(--st-off-bg);color:var(--st-off-ink);border-color:var(--st-off-ink)}
  .est-off::before{content:"–"}

  /* Era #c7d0cb = 1.58:1. Es la ÚNICA señal de "esto se toca" en cada fila. */
  .chev{color:var(--ink-3);flex:0 0 auto}
  .pico{width:40px;height:40px;border-radius:var(--r2);flex:0 0 auto;display:grid;place-items:center;font-weight:800;font-size:12px;color:#fff;letter-spacing:.04em}
  /* El punto de 7px pegado al borde era casi invisible; una barra lateral se ve
     de reojo mientras se baja por la lista. */
  .dotnew{position:absolute;left:0;top:0;bottom:0;width:4px;border-radius:0 3px 3px 0;background:var(--st-debe-solid)}
  .vacio{color:var(--ink-2);text-align:center;padding:48px 16px;font-size:var(--t-m)}

  /* ficha */
  .navbar{display:flex;align-items:center;justify-content:space-between;padding:2px 4px 6px}
  .navback{display:inline-flex;align-items:center;gap:4px;min-height:var(--tap);color:var(--lime-ink);font-size:var(--t-l);font-weight:600}
  /* Tinta navy, no blanca: blanco sobre lima daba 1.97:1 en el botón que más se
     toca de la ficha. Y 44px de alto — antes eran 29. */
  .wabtn{display:inline-flex;align-items:center;justify-content:center;gap:6px;min-height:var(--tap);
    background:var(--lime);color:var(--on-lime);font-size:var(--t-m);font-weight:700;
    padding:0 var(--s4);border-radius:var(--rp);box-shadow:var(--sombra)}
  .fhead{display:flex;flex-direction:column;align-items:center;text-align:center;padding:4px 0 12px}
  .fava{width:74px;height:74px;border-radius:50%;display:grid;place-items:center;font-weight:700;font-size:26px;color:#fff;margin-bottom:10px}
  .fhead h2{font-size:21px;font-weight:700;letter-spacing:-.01em}
  .fnum{font-size:var(--t-m);color:var(--ink-2);margin-top:2px}
  .fpills{display:flex;gap:7px;margin-top:10px;flex-wrap:wrap;justify-content:center}
  .pz{display:inline-flex;align-items:center;font-size:var(--t-xs);font-weight:700;padding:6px 12px;border-radius:var(--rp);color:#fff}

  .group{background:var(--surface);border:1px solid var(--line);border-radius:var(--r3);overflow:hidden;box-shadow:var(--sombra)}
  .grow{display:flex;align-items:center;justify-content:space-between;gap:10px;min-height:var(--tap);padding:12px 15px;border-bottom:1px solid var(--line);font-size:var(--t-m)}
  .grow:last-child{border-bottom:none}
  .grow .k{color:var(--ink-2)} .grow .v{font-weight:600;text-align:right}
  /* Las 6 etapas del pipeline eran botones de 31px pegados con 6px de gap: un
     toque de más y cambiabas la etapa equivocada. 44px y 8px de separación. */
  .pipe{display:flex;gap:var(--s2);flex-wrap:wrap;padding:13px 14px}
  .pstep{display:inline-flex;align-items:center;justify-content:center;min-height:var(--tap);
    font-family:inherit;font-size:var(--t-s);font-weight:600;padding:0 14px;border-radius:var(--rp);
    background:var(--surface-2);color:var(--ink-2);border:1.5px solid var(--line-strong);cursor:pointer}
  .pstep.on{background:var(--navy-fill);color:#fff;border-color:var(--navy-fill);font-weight:700}
  .pstep.on::before{content:"✓ ";font-weight:800}

  /* 16px y 44px de alto en todos los campos: por debajo de 16px iOS amplía la
     página al enfocar y la deja ampliada, con scroll horizontal — lo peor que
     puede pasar cuando estás con una mano. Eran 14px. */
  form.inline{display:flex;gap:var(--s2);flex-wrap:wrap;padding:var(--s3) 14px}
  form.inline input{flex:1;min-width:130px;min-height:var(--tap);background:var(--surface-2);border:1px solid var(--line-strong);
    border-radius:var(--r2);padding:0 13px;color:var(--ink);font:inherit;font-size:var(--t-input);outline:none}
  form.inline textarea{flex-basis:100%;background:var(--surface-2);border:1px solid var(--line-strong);border-radius:var(--r2);
    padding:11px 13px;color:var(--ink);font:inherit;font-size:var(--t-input);outline:none;resize:vertical;min-height:80px;line-height:1.45}
  form.inline button{min-height:var(--tap);background:var(--lime);color:var(--on-lime);border:1px solid var(--lime);
    border-radius:var(--r2);padding:0 var(--s4);font:inherit;font-size:var(--t-m);font-weight:800;box-shadow:var(--sombra);cursor:pointer}
  form.inline button:active{transform:scale(.985)}
  form.inline label{flex-basis:100%;font-size:var(--t-s);font-weight:700;color:var(--ink-2);margin-bottom:-4px}
  form.inline input::placeholder,form.inline textarea::placeholder{color:var(--ink-3)}

  /* --- Partidos: fila de la lista -------------------------------------------
     En 360px no entran fecha + zona + sede + ratio + estado + chevron en una
     línea. Los estados bajan a su propia fila de chips debajo del subtítulo, que
     además es donde se leen mejor. */
  .pfecha{flex:0 0 44px;text-align:center}
  .pfecha b{display:block;font-family:var(--font-num);font-style:italic;font-weight:800;
    font-size:var(--t-xl);line-height:1;letter-spacing:var(--track-num)}
  .pfecha small{display:block;font-size:var(--t-xs);color:var(--ink-2);margin-top:2px}
  .pchips{display:flex;gap:6px;flex-wrap:wrap;margin-top:7px}

  /* Acción destructiva: fuera de la fila de acciones comunes, separada por aire
     y una línea. Nunca a menos de 24px de un botón de uso frecuente. */
  .acc-peligro{margin-top:var(--gap-peligro);padding-top:var(--s3);border-top:1px solid var(--line);
    display:flex;justify-content:flex-end;gap:var(--s2);flex-wrap:wrap}

  .config-row{display:flex;gap:8px;flex-wrap:wrap;align-items:center;padding:12px 14px;border-bottom:1px solid var(--line)}
  .config-row:last-child{border-bottom:none}
  .config-row input{flex:1;min-width:90px}
  .btn-rojo{background:var(--st-alerta-solid)!important;color:#fff!important}
  .notas-list{padding:0 14px 12px}
  .notas-list p{font-size:var(--t-m);border-left:3px solid var(--line-strong);padding:4px 10px;margin-bottom:8px}
  .notas-list time{display:block;font-size:var(--t-xs);color:var(--ink-3)}
  .chat{padding:8px 4px 2px;display:flex;flex-direction:column;gap:6px}
  .bub{max-width:82%;padding:9px 13px;border-radius:18px;font-size:var(--t-m);line-height:1.45;white-space:pre-wrap;word-break:break-word}
  .bub.in{align-self:flex-start;background:var(--surface-3);color:var(--ink);border-bottom-left-radius:5px}
  .bub.out{align-self:flex-end;background:var(--navy-9);color:var(--on-navy);border-bottom-right-radius:5px}
  /* La hora del mensaje era 10px al 55% de opacidad: eso es ~2:1 real. */
  .bub time{display:block;font-size:var(--t-xs);margin-top:3px;opacity:.75;text-align:right}
  .noreply{align-self:center;display:inline-flex;align-items:center;gap:7px;font-size:var(--t-xs);font-weight:600;
    color:var(--st-debe-ink);background:var(--st-debe-bg);border:1px dashed var(--st-debe-ink);
    padding:5px 12px;border-radius:var(--rp);margin:6px 0}

  .stack>*+*{margin-top:6px}
  .foot{color:var(--ink-2);font-size:var(--t-s);text-align:center;padding:22px 16px 6px}

  /* --- Avisos de resultado (guardado / error) --------------------------------
     Sticky arriba: tras guardar volvemos con #ancla al bloque donde estaba el
     usuario, y un aviso en el flujo normal quedaría fuera de pantalla. */
  .aviso{position:sticky;top:0;z-index:80;display:flex;gap:9px;align-items:flex-start;
    padding:13px 16px;margin:0 0 12px;font-size:var(--t-m);font-weight:600;line-height:1.4;
    box-shadow:var(--sombra)}
  .aviso-ok{background:var(--st-ok-bg);color:var(--st-ok-ink);border-bottom:2px solid var(--st-ok-ink)}
  .aviso-err{background:var(--st-alerta-bg);color:var(--st-alerta-ink);border-bottom:2px solid var(--st-alerta-ink)}
  .aviso-ic{flex:0 0 auto}
  .aviso-tx{flex:1;min-width:0}
  /* Los destinos de ancla se paran DEBAJO del aviso pegado, no atrás. */
  .ancla{scroll-margin-top:92px}

  /* --- Campos de formulario con etiqueta visible ----------------------------
     Los formularios de Ajustes eran <input> con solo placeholder: al abrir una
     sede YA cargada el placeholder desaparece (el campo tiene valor) y quedan
     cajas mudas — "14" y "150" pegadas sin decir cuál es el cupo y cuál el
     costo. La ayuda va en <small>, no en title=: en celular el title no existe,
     y el celular es donde Clarck usa esto. */
  .campos{display:grid;grid-template-columns:repeat(auto-fit,minmax(150px,1fr));gap:13px;padding:0 14px 14px}
  .campo{display:flex;flex-direction:column;gap:5px;min-width:0}
  .campo-ancho{grid-column:1/-1}
  .campo label{font-size:var(--t-s);font-weight:700;color:var(--ink-2)}
  /* 16px a propósito: por debajo de eso iOS hace zoom solo al enfocar. */
  .campo input,.campo textarea,.campo select{width:100%;background:var(--surface-2);border:1.5px solid var(--line-strong);
    border-radius:var(--r2);padding:11px 13px;color:var(--ink);font:inherit;font-size:var(--t-input);outline:none;min-height:var(--tap)}
  .campo textarea{min-height:100px;resize:vertical;line-height:1.45}
  .campo small{font-size:var(--t-xs);color:var(--ink-2);line-height:1.35}
  .campo .falta{color:var(--st-debe-ink);font-weight:600}
  .campos-tit{font-size:var(--t-eyebrow);font-weight:800;letter-spacing:.1em;text-transform:uppercase;
    color:var(--ink-2);padding:13px 14px 2px}

  /* Botones tocables: mínimo 44px de alto (dedo, una mano, de noche). */
  .btn-toque{min-height:44px;display:inline-flex;align-items:center;justify-content:center;gap:6px;
    border:none;border-radius:var(--r2);padding:0 16px;font:inherit;font-weight:700;font-size:var(--t-m);cursor:pointer}
  .btn-guardar{background:var(--lime);color:var(--on-lime);border:1px solid var(--lime)}
  .btn-peligro{background:var(--st-alerta-bg);border:1.5px solid var(--st-alerta-ink);color:var(--st-alerta-ink);font-weight:700;font-size:var(--t-s)}
  .pie-form{padding:0 14px 14px;display:flex;gap:10px;align-items:center;flex-wrap:wrap}

  /* Bloque de una sede dentro de la tarjeta del distrito. */
  .sede{border-top:1px solid var(--line)}
  .sede-tit{font-size:var(--t-m);font-weight:700;padding:14px 14px 0}

  /* "Para que el bot trabaje solo": qué falta cargar, con el link al campo. */
  .prow{display:flex;align-items:center;gap:12px;min-height:var(--tap);padding:13px 15px;border-bottom:1px solid var(--line)}
  .prow:last-child{border-bottom:none}
  .pico2{flex:0 0 auto;font-size:19px}
  .ptxt{flex:1;min-width:0;display:flex;flex-direction:column;gap:2px}
  .ptxt b{font-size:var(--t-m);font-weight:600}
  .ptxt small{font-size:var(--t-s);color:var(--ink-2);line-height:1.35}
  .pcta{flex:0 0 auto;font-size:var(--t-s);font-weight:700;color:var(--lime-ink);white-space:nowrap}

  /* Fila de inscrito: acciones comunes a la izquierda, la destructiva aparte. */
  .finsc{display:flex;align-items:center;gap:9px;padding:11px 14px;border-bottom:1px solid var(--line);flex-wrap:wrap}
  .finsc:last-of-type{border-bottom:none}
  .finsc-acc{display:flex;gap:7px;flex-wrap:wrap;align-items:center}
  .finsc-peligro{margin-left:auto;padding-left:10px;border-left:1px solid var(--line)}
  /* En 360px la fila envuelve y el margin-left:auto deja de separar nada: "Baja"
     puede caer justo debajo del dedo que buscaba "Pagó". Ahí pasa a ocupar su
     propia línea, alineada a la derecha y con una separación de verdad. */
  @media (max-width:479px){
    .finsc-peligro{flex-basis:100%;margin:var(--s2) 0 0;padding:var(--s2) 0 0;
      border-left:none;border-top:1px solid var(--line);display:flex;justify-content:flex-end}
  }
  .btn-fila{min-height:44px;min-width:44px;border:none;border-radius:10px;padding:0 12px;
    font:inherit;font-size:var(--t-s);font-weight:700;cursor:pointer;display:inline-flex;align-items:center;justify-content:center}

  /* tab bar */
  /* Barra clara como la propuesta v2: la navegación no compite con el
     contenido. Estaba en navy con borde negro de 3px — pesaba más que la
     pantalla que uno viene a mirar. */
  .tabbar{position:fixed;bottom:0;left:50%;transform:translateX(-50%);width:100%;max-width:480px;
    height:calc(62px + env(safe-area-inset-bottom));background:rgba(255,255,255,.92);
    backdrop-filter:saturate(180%) blur(12px);-webkit-backdrop-filter:saturate(180%) blur(12px);
    border-top:1px solid var(--line);display:flex;padding:7px 0 env(safe-area-inset-bottom);z-index:50}
  .tab{flex:1;display:flex;flex-direction:column;align-items:center;justify-content:center;gap:3px;color:var(--ink-2);
    font-size:var(--t-xs);font-weight:600;letter-spacing:.01em}
  .tab svg{width:23px;height:23px}
  .tab.on{color:var(--navy);font-weight:700}

  /* sidebar (solo escritorio) */
  .shell{min-height:100vh}
  .sidebar{display:none}
  .sidebar .brand{display:flex;align-items:center;gap:11px;font-family:var(--font-num);font-style:italic;text-transform:uppercase;font-weight:800;font-size:22px;color:var(--navy);letter-spacing:.02em;margin-bottom:26px}
  /* La mascota real, no el emoji ⚽ sobre un cuadrado lima que había antes: el
     logo ya trae su color y su forma, taparlo con un fondo lo ensuciaba. */
  .sidebar .brand .iso{width:38px;height:38px;object-fit:contain;flex:0 0 auto}
  .snav{display:flex;flex-direction:column;gap:4px}
  .snav a{display:flex;align-items:center;gap:12px;min-height:var(--tap);padding:11px 13px;border-radius:var(--r2);font-weight:600;font-size:15px;color:var(--ink-2)}
  .snav a svg{width:22px;height:22px}
  .snav a.on{background:var(--lime-tint);color:var(--lime-ink)}
  .snav a:hover{background:var(--surface-2)}
  .sbottom{margin-top:22px;padding-top:16px;border-top:1px solid var(--line);display:flex;flex-direction:column;gap:2px}
  .sbottom::before{content:'Herramientas';font-size:var(--t-eyebrow);font-weight:800;letter-spacing:.12em;text-transform:uppercase;color:var(--ink-2);padding:0 13px 8px}
  .scsv{display:inline-flex;align-items:center;gap:7px;min-height:var(--tap);font-size:var(--t-s);color:var(--ink-2);padding:0 13px;border-radius:var(--r2)}
  .scsv:hover{background:var(--surface-2)}
  .fcol-right .group{margin-bottom:0}

  /* RESPONSIVE: a partir de 980px, layout de escritorio */
  @media (min-width:980px){
    body{background:var(--desk)}
    .shell{display:flex;max-width:1180px;margin:0 auto;background:var(--bg);min-height:100vh;box-shadow:0 0 90px -50px rgba(16,39,68,.45)}
    .sidebar{display:flex;flex-direction:column;flex:0 0 250px;background:var(--surface);border-right:1px solid var(--line);padding:28px 20px;position:sticky;top:0;height:100vh}
    .app{flex:1;min-width:0;max-width:none;margin:0;padding:24px 36px 56px}
    .px{padding-left:0;padding-right:0}
    .tabbar{display:none}
    .ltitle{padding-left:2px;padding-right:2px}
    .grid2{grid-template-columns:repeat(4,1fr)}
    .marcador{padding:24px 28px 22px}
    .mnum{font-size:72px}

    /* El marcador con gráfico usaba el ancho como relleno: la cifra chica a la
       izquierda y las barras apretadas contra el borde derecho. En escritorio
       se reparte en dos columnas — el número manda, la actividad respira. */
    .marcador:has(.bars){display:grid;grid-template-columns:minmax(0,290px) 1fr;column-gap:34px;align-items:center}
    .marcador:has(.bars) > .mtop{grid-column:1 / -1}
    .marcador:has(.bars) > .mnum{grid-column:1;grid-row:2;align-self:end}
    .marcador:has(.bars) > .bars{grid-column:2;grid-row:2 / span 2;margin-top:0;height:132px}
    .marcador:has(.bars) > .mfoot{grid-column:1;grid-row:3}
    .bars .bd{font-size:var(--t-xs)}
    .bars .bn{font-size:var(--t-xs)}

    /* Dos columnas: a la izquierda lo accionable (la pichanga de hoy, los
       avisos, los pendientes), a la derecha lo analítico (la comunidad, el
       embudo, las zonas). Antes era UNA columna de cajas letterbox que usaba
       el ancho como relleno. */
    .dash{display:grid;grid-template-columns:minmax(0,1fr) minmax(0,1fr);gap:0 30px;align-items:start}
    .dash .dcol{min-width:0}
    .dash .dcol > .shdr:first-child{padding-top:4px}
    .grid2{grid-template-columns:1fr 1fr}
    .marcador:has(.bars){display:block}
    .marcador:has(.bars) > .bars{height:96px;margin-top:12px}
    /* ficha en 2 columnas */
    .ficha-grid{display:grid;grid-template-columns:minmax(0,360px) 1fr;gap:26px;align-items:start}
    .fcol-right{position:sticky;top:24px}
    .fcol-left .fhead{align-items:flex-start;text-align:left}
    .fcol-left .fhead .fpills{justify-content:flex-start}
    /* listas con ancho de lectura cómodo */
    .llist,.zlist{max-width:none}
  }
  @media (min-width:1280px){
    .app{padding:28px 56px 56px}
  }
`;
// Lo que se sirve: mismo CSS, sin comentarios ni sangría.
const ESTILOS_MIN = ESTILOS
  .replace(/\/\*[\s\S]*?\*\//g, '')
  .replace(/^[ \t]+/gm, '')
  .replace(/\n{2,}/g, '\n')
  .trim();

/**
 * Aviso de resultado de una acción ("guardado", "no se pudo", "X dado de baja").
 *
 * Va arriba de la página y PEGADO al viewport (sticky): después de guardar se
 * vuelve con #ancla al bloque donde estaba el usuario, así que un banner metido
 * en el flujo del documento quedaría fuera de pantalla justo cuando hace falta.
 * Sticky y no fixed para que ocupe su lugar y no tape el título de la vista.
 */
function bannerAviso(query = {}) {
  const texto = (query.aviso || '').toString().slice(0, 300);
  if (!texto) return '';
  const err = query.err === '1';
  return `<div class="aviso ${err ? 'aviso-err' : 'aviso-ok'}" role="status">
    <span class="aviso-ic">${err ? '⚠️' : '✅'}</span><span class="aviso-tx">${esc(texto)}</span>
  </div>`;
}

function baseHtml(titulo, cuerpo, { refresh = false, activo = '', key = '', tabbarMobile = true, aviso = null } = {}) {
  return `<!doctype html><html lang="es"><head>
<meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1,viewport-fit=cover">
<title>${esc(titulo)}</title>
<link rel="icon" type="image/png" sizes="64x64" href="/icono-64.png">
<link rel="apple-touch-icon" href="/icono-180.png">
<meta name="theme-color" content="#16385F">
${refresh ? `<meta http-equiv="refresh" content="${typeof refresh === 'number' ? refresh : 90}">` : ''}
<style>${ESTILOS_MIN}</style></head><body>
<div class="shell">${key ? sidebar(key, activo) : ''}<div class="app">${bannerAviso(aviso || {})}${cuerpo}</div></div>
${tabbarMobile && activo ? tabbar(key, activo) : ''}</body></html>`;
}

// SVGs reutilizables ----------------------------------------------------------
const SVG = {
  chev: '<svg class="chev" width="8" height="14" viewBox="0 0 8 14"><path d="m1 1 6 6-6 6" stroke="currentColor" stroke-width="2" fill="none" stroke-linecap="round"/></svg>',
  lupa: '<svg width="16" height="16" viewBox="0 0 16 16" fill="none"><circle cx="7" cy="7" r="5" stroke="currentColor" stroke-width="1.6"/><path d="m11 11 3 3" stroke="currentColor" stroke-width="1.6" stroke-linecap="round"/></svg>',
  back: '<svg width="9" height="16" viewBox="0 0 9 16"><path d="M8 1 1 8l7 7" stroke="currentColor" stroke-width="2" fill="none" stroke-linecap="round"/></svg>',
  wa: '<svg width="15" height="15" viewBox="0 0 24 24" fill="#fff"><path d="M12 2a10 10 0 0 0-8.6 15l-1.3 4.7 4.8-1.3A10 10 0 1 0 12 2Zm5.3 14.1c-.2.6-1.3 1.2-1.8 1.2-.5.1-1 .1-1.7-.1-.4-.1-1-.3-1.6-.6-2.9-1.3-4.8-4.2-4.9-4.4-.2-.2-1.2-1.6-1.2-3 0-1.5.7-2.2 1-2.5.2-.3.6-.4.8-.4h.6c.2 0 .4 0 .6.5l.8 2c.1.2.1.4 0 .5l-.4.6-.3.3c-.2.2-.3.4-.2.6.2.4.8 1.3 1.6 2 .9.8 1.7 1.1 2.1 1.3.3.1.5.1.7-.1l.7-.9c.2-.3.4-.2.6-.1l1.9.9c.2.1.4.2.4.3.1.2.1.7-.1 1.2Z"/></svg>',
  iResumen: '<svg viewBox="0 0 24 24" fill="none"><path d="M4 13h6v7H4zM14 4h6v16h-6zM4 4h6v6H4z" fill="currentColor"/></svg>',
  iCrm: '<svg viewBox="0 0 24 24" fill="none"><circle cx="9" cy="8" r="3.4" stroke="currentColor" stroke-width="1.8"/><path d="M3.5 19c.6-3.2 3-5 5.5-5s4.9 1.8 5.5 5" stroke="currentColor" stroke-width="1.8" stroke-linecap="round"/><path d="M16.5 7.5c1.7 0 3 1.3 3 3s-1.3 3-3 3M18 19c-.2-1.6-.8-3-2-4" stroke="currentColor" stroke-width="1.8" stroke-linecap="round"/></svg>',
  iConfig: '<svg viewBox="0 0 24 24" fill="none"><circle cx="12" cy="12" r="3" stroke="currentColor" stroke-width="1.8"/><path d="M19.4 13.5a1.7 1.7 0 0 0 .34 1.87l.06.06a2 2 0 1 1-2.83 2.83l-.06-.06a1.7 1.7 0 0 0-1.87-.34 1.7 1.7 0 0 0-1.04 1.56V20a2 2 0 1 1-4 0v-.1a1.7 1.7 0 0 0-1.04-1.56 1.7 1.7 0 0 0-1.87.34l-.06.06a2 2 0 1 1-2.83-2.83l.06-.06a1.7 1.7 0 0 0 .34-1.87 1.7 1.7 0 0 0-1.56-1.04H4a2 2 0 1 1 0-4h.1a1.7 1.7 0 0 0 1.56-1.04 1.7 1.7 0 0 0-.34-1.87l-.06-.06a2 2 0 1 1 2.83-2.83l.06.06a1.7 1.7 0 0 0 1.87.34H10a1.7 1.7 0 0 0 1.04-1.56V4a2 2 0 1 1 4 0v.1a1.7 1.7 0 0 0 1.04 1.56 1.7 1.7 0 0 0 1.87-.34l.06-.06a2 2 0 1 1 2.83 2.83l-.06.06a1.7 1.7 0 0 0-.34 1.87V10a1.7 1.7 0 0 0 1.56 1.04H20a2 2 0 1 1 0 4h-.1a1.7 1.7 0 0 0-1.56 1.04Z" stroke="currentColor" stroke-width="1.6" stroke-linejoin="round"/></svg>',
  iConexion: '<svg viewBox="0 0 24 24" fill="none"><path d="M9 15l6-6M10.5 6.5l.9-.9a4 4 0 0 1 5.66 5.66l-.9.9M13.5 17.5l-.9.9a4 4 0 0 1-5.66-5.66l.9-.9" stroke="currentColor" stroke-width="1.8" stroke-linecap="round"/></svg>',
  iPagos: '<svg viewBox="0 0 24 24" fill="none"><rect x="2.5" y="6" width="19" height="12.5" rx="2.5" stroke="currentColor" stroke-width="1.8"/><circle cx="12" cy="12.2" r="2.8" stroke="currentColor" stroke-width="1.8"/><path d="M6 9.2h.01M18 15.2h.01" stroke="currentColor" stroke-width="2.2" stroke-linecap="round"/></svg>',
  iPartidos: '<svg viewBox="0 0 24 24" fill="none"><rect x="3" y="5" width="18" height="16" rx="2.5" stroke="currentColor" stroke-width="1.8"/><path d="M3 9.5h18M8 3v4M16 3v4" stroke="currentColor" stroke-width="1.8" stroke-linecap="round"/><circle cx="12" cy="15.2" r="2.6" stroke="currentColor" stroke-width="1.6"/></svg>',
};

// Cinco pestañas, como la propuesta v2. Eran seis: "Conexión" mostraba un QR
// que con el canal oficial NO llega nunca (index.js: qr() devuelve null), y se
// autorefrescaba cada 6 s esperándolo — una pestaña muerta desde la migración.
// Su contenido vivo (qué número está enlazado) es una línea dentro de Ajustes.
const tabbar = (key, activo) => `<nav class="tabbar">
  <a class="tab ${activo === 'resumen' ? 'on' : ''}" href="/admin/leads?key=${key}">${SVG.iResumen}Resumen</a>
  <a class="tab ${activo === 'partidos' ? 'on' : ''}" href="/admin/leads?key=${key}&vista=partidos">${SVG.iPartidos}Partidos</a>
  <a class="tab ${activo === 'crm' ? 'on' : ''}" href="/admin/leads?key=${key}&vista=crm">${SVG.iCrm}Jugadores</a>
  <a class="tab ${activo === 'pagos' ? 'on' : ''}" href="/admin/leads?key=${key}&vista=pagos">${SVG.iPagos}Pagos</a>
  <a class="tab ${activo === 'config' || activo === 'conexion' ? 'on' : ''}" href="/admin/leads?key=${key}&vista=config">${SVG.iConfig}Ajustes</a>
</nav>`;

const sidebar = (key, activo) => `<aside class="sidebar">
  <div class="brand"><img class="iso" src="/icono-64.png" alt="" width="38" height="38"> Pichangueros</div>
  <nav class="snav">
    <a class="${activo === 'resumen' ? 'on' : ''}" href="/admin/leads?key=${key}">${SVG.iResumen} Resumen</a>
    <a class="${activo === 'partidos' ? 'on' : ''}" href="/admin/leads?key=${key}&vista=partidos">${SVG.iPartidos} Partidos</a>
    <a class="${activo === 'crm' ? 'on' : ''}" href="/admin/leads?key=${key}&vista=crm">${SVG.iCrm} Jugadores</a>
    <a class="${activo === 'pagos' ? 'on' : ''}" href="/admin/leads?key=${key}&vista=pagos">${SVG.iPagos} Pagos</a>
    <a class="${activo === 'config' || activo === 'conexion' ? 'on' : ''}" href="/admin/leads?key=${key}&vista=config">${SVG.iConfig} Ajustes</a>
  </nav>
  <div class="sbottom">
    ${sheetsync.activo() ? `<a class="scsv" href="/admin/sync-sheet?key=${key}">☁ Respaldar a Sheet</a>` : ''}
    <a class="scsv" href="/admin/leads.csv?key=${key}">⬇ Exportar CSV</a>
    <a class="scsv" href="/admin/leads.xlsx?key=${key}">📊 Exportar Excel</a>
    <a class="scsv" href="/admin/backup-db?key=${key}">💾 Descargar backup BD</a>
    ${backup.activo() ? `<a class="scsv" href="/admin/backup-email?key=${key}">✉ Enviar backup por correo</a>` : ''}
  </div>
</aside>`;

function badges(l, sinResponder) {
  const z = ZONAS[l.zona];
  const vencido = l.proxima_accion && l.proxima_accion <= hoyLima();
  const tags = (l.etiquetas || '').split(',').filter(Boolean);
  return `
    ${l.handoff ? `<span class="badge b-hand">🔔 ${esc(l.handoff_motivo || 'derivado')}</span>` : ''}
    ${sinResponder ? '<span class="badge b-wait">📥 sin responder</span>' : ''}
    ${vencido ? `<span class="badge b-wait">⏰ ${esc(l.proxima_nota || 'seguimiento')}</span>` : ''}
    ${z ? `<span class="badge b-zona" style="background:${z.color}">${z.nombre}</span>` : ''}
    <span class="badge b-new">${esc(ESTADOS[l.estado] || l.estado)}</span>
    ${tags.map((t) => `<span class="badge b-new">${esc(t)}</span>`).join('')}`;
}

// ==============================================================================
//  Vista 1 · RESUMEN (dashboard)
// ==============================================================================
/**
 * Un campo = etiqueta visible + control + ayuda debajo.
 *
 * Antes eran <input> con solo placeholder. El placeholder desaparece en cuanto
 * el campo tiene valor, que es SIEMPRE al editar algo ya cargado: la pantalla
 * quedaba en cajas mudas. Y la poca ayuda que había vivía en title=, que en
 * celular no se puede ver. Vive a nivel de módulo porque lo usan tanto Ajustes
 * como el alta de partido.
 */
const campo = (id, etiqueta, control, ayuda = '', ancho = false) => `
  <div class="campo${ancho ? ' campo-ancho' : ''}">
    <label for="${id}">${etiqueta}</label>
    ${control}
    ${ayuda ? `<small>${ayuda}</small>` : ''}
  </div>`;

function paginaResumen(db, key, query = {}) {
  const todos = db.listLeads();
  const roles = db.ultimosRoles();
  const sinResp = (l) => sinResponder(roles, l);
  const hoy = hoyLima();

  // Altas por día (últimos 14, terminando hoy Lima).
  const porDia = {};
  for (const l of todos) {
    const d = (l.creado_en || '').slice(0, 10);
    if (d) porDia[d] = (porDia[d] || 0) + 1;
  }
  // Actividad por día: quiénes escribieron — separados en NUEVOS (su primer
  // día) vs RECURRENTES (ya estaban registrados y volvieron a escribir).
  const creadoDe = {};
  for (const l of todos) creadoDe[l.numero] = (l.creado_en || '').slice(0, 10);
  const actividad = {};
  for (const r of db.actividadPorDia(fechaLima(-13))) {
    const a = actividad[r.d] || (actividad[r.d] = { nuevos: 0, rec: 0 });
    if (creadoDe[r.numero] === r.d) a.nuevos++; else a.rec++;
  }
  const dias = [];
  for (let i = 13; i >= 0; i--) {
    const d = fechaLima(-i);
    const a = actividad[d] || { nuevos: 0, rec: 0 };
    // Respaldo: si el historial no cubre ese día, al menos los leads creados.
    const nuevos = Math.max(a.nuevos, porDia[d] || 0);
    dias.push({ d, nuevos, rec: a.rec, n: nuevos + a.rec });
  }
  const maxN = Math.max(1, ...dias.map((x) => x.n));
  // "Esta semana" cuenta solo NUEVOS (captación), no la actividad total.
  const semana = dias.slice(-7).reduce((a, x) => a + x.nuevos, 0);
  const previa = dias.slice(0, 7).reduce((a, x) => a + x.nuevos, 0);
  const delta = previa ? Math.round(((semana - previa) / previa) * 100) : (semana ? 100 : 0);
  const hoyN = porDia[hoy] || 0;

  const colaResp = todos.filter(sinResp).length;
  const enHandoff = todos.filter((l) => l.handoff).length;
  const paraHoy = todos.filter((l) => l.proxima_accion && l.proxima_accion <= hoy).length;
  const pagosRevisar = db.pagosPorRevisar();

  // Por zona (las clasificadas + las que faltan).
  // Las zonas salen de la config en vivo, no de una lista escrita a mano.
  // Rímac y Chorrillos ya tenían leads, sedes y partidos, y aun así no
  // aparecían acá: contaban como "clasificadas" y después nadie las dibujaba,
  // así que 21 contactos se evaporaban del desglose sin dejar rastro.
  const zc = {};
  let clasificadas = 0;
  for (const l of todos) if (l.zona) { zc[l.zona] = (zc[l.zona] || 0) + 1; clasificadas++; }
  const sinClasificar = todos.length - clasificadas;
  const maxZ = Math.max(1, ...Object.values(zc), sinClasificar);
  // Con sede primero (donde se juega), después las de demanda sin cancha.
  const zonasConSede = db.zonasOperativas();
  const ordenZonas = Object.keys(zc).sort((a, b) => {
    const sedeA = zonasConSede.includes(a) ? 0 : 1;
    const sedeB = zonasConSede.includes(b) ? 0 : 1;
    return sedeA - sedeB || zc[b] - zc[a];
  });
  // Cada fila es un link al CRM ya filtrado (todo el Resumen es navegable).
  const zrow = (nombre, n, color, filtroUrl) => {
    const inner = `<span class="zdot" style="background:${color}"></span><span class="zname">${nombre}</span>
      <span class="ztrack"><i style="width:${Math.max(3, Math.round((n / maxZ) * 100))}%;background:${color}"></i></span>
      <span class="zval">${n}</span>`;
    return filtroUrl
      ? `<a class="zrow" href="/admin/leads?key=${key}&vista=crm${filtroUrl}">${inner}</a>`
      : `<div class="zrow">${inner}</div>`;
  };

  // Demanda por distrito (zona 'otra' = lista de espera): ¿dónde conviene abrir?
  // Agrupa el distrito de texto libre normalizado (minúsculas, sin tildes).
  const UMBRAL_PILOTO = 28; // ~2 pichangas llenas (14 c/u) → distrito candidato a piloto
  const desde30 = fechaLima(-29);
  const dd = {};
  for (const l of todos) {
    if (l.zona !== 'otra' || !(l.distrito || '').trim()) continue;
    const k = normTexto(l.distrito);
    if (!dd[k]) dd[k] = { k, nombre: l.distrito.trim().toLowerCase().replace(/(^|\s)\p{L}/gu, (c) => c.toUpperCase()), n: 0, mes: 0 };
    dd[k].n++;
    if ((l.creado_en || '').slice(0, 10) >= desde30) dd[k].mes++;
  }
  const distritos = Object.values(dd).sort((a, b) => b.n - a.n).slice(0, 8);
  const maxD = Math.max(1, ...distritos.map((d) => d.n));
  const drow = (d) => {
    const listo = d.n >= UMBRAL_PILOTO;
    // El lima puro sobre blanco da 1.97:1: como relleno de un punto de 11px y de
    // una barra de 8px, prácticamente no se ve. Va la versión --lime-fill (3.16:1),
    // que es el mismo verde con el peso justo para leerse.
    const color = listo ? 'var(--lime-fill)' : 'var(--st-off-solid)';
    return `<a class="zrow" href="/admin/leads?key=${key}&vista=crm&distrito=${encodeURIComponent(d.k)}"><span class="zdot" style="background:${color}"></span>
      <span class="zname">${esc(d.nombre)}${listo ? ' 🔥' : ''}</span>
      <span class="ztrack"><i style="width:${Math.max(3, Math.round((d.n / maxD) * 100))}%;background:${color}"></i></span>
      <span class="zval">${d.n}${d.mes ? ` <small style="color:var(--ink-3);font-weight:400">+${d.mes} este mes</small>` : ''}</span></a>`;
  };

  // Cada barra es un link: toca un día → CRM filtrado a los contactos de ese día.
  // Barra APILADA: verde = nuevos (escribieron por 1.ª vez), azul = recurrentes.
  const barras = dias.map((x, i) => {
    const hNue = x.nuevos ? Math.max(6, Math.round((x.nuevos / maxN) * 100)) : 0;
    const hRec = x.rec ? Math.max(6, Math.round((x.rec / maxN) * 100)) : 0;
    const hot = x.nuevos >= maxN * 0.5 && x.nuevos > 0;
    const esHoy = x.d === hoy;
    const nDia = Number(x.d.slice(8));
    const etiqueta = esHoy ? 'hoy' : (i === 0 || nDia === 1 ? `${nDia}${mesCorto(x.d)}` : String(nDia));
    return `<a class="bar ${hot ? 'hot' : ''}" href="/admin/leads?key=${key}&vista=crm&dia=${x.d}" title="${x.d}: ${x.nuevos} nuevos + ${x.rec} recurrentes — toca para verlos">
      <span class="bn">${x.n || ''}</span>
      <div class="track">${x.rec ? `<i class="brec" style="height:${hRec}%"></i>` : ''}${x.nuevos ? `<i class="bnue" style="height:${hNue}%"></i>` : ''}</div>
      <span class="bd${esHoy ? ' bhoy' : ''}">${etiqueta}</span></a>`;
  }).join('');

  // Embudo: en qué paso del camino está cada contacto (primer mensaje → pago).
  const conDatos = todos.filter((l) => l.estado && l.estado !== 'nuevo').length;
  const invitados = todos.filter((l) => l.estado === 'invitado_grupo').length;
  const enEspera = todos.filter((l) => l.estado === 'lista_espera').length;
  const nPagadores = db.pagadores ? db.pagadores() : 0;
  const pct = (n) => (todos.length ? Math.round((n / todos.length) * 100) : 0);
  // Cada escalón del embudo lleva al CRM con ESA gente filtrada.
  const frow = (nombre, n, color, detalle, filtroUrl) =>
    `<a class="zrow" href="/admin/leads?key=${key}&vista=crm${filtroUrl || ''}"><span class="zdot" style="background:${color}"></span>
      <span class="zname">${nombre}${detalle ? ` <small style="color:var(--ink-2);font-weight:400">${detalle}</small>` : ''}</span>
      <span class="ztrack"><i style="width:${Math.max(3, pct(n))}%;background:${color}"></i></span>
      <span class="zval">${n} <small style="color:var(--ink-2);font-weight:400">${pct(n)}%</small></span></a>`;

  // El banner refleja el modo real del bot (misma lectura de env que index.js).
  const modoSeguro = (process.env.SAFE_MODE || 'true') !== 'false';
  const capturados = silenciados48h(roles, todos);
  const bannerSeguro = modoSeguro
    ? `<a class="banner px" href="/admin/leads?key=${key}&vista=crm" style="text-decoration:none">
    <div class="bic">🔒</div>
    <div class="btxt"><b>Modo seguro activo.</b> El bot captura en silencio (por diseño):
      <b>${capturados} conversacion${capturados === 1 ? '' : 'es'}</b> registradas en las últimas 48 h, listas para cuando se encienda.</div></a>`
    : `<div class="banner ok px"><div class="bic">🤖</div>
    <div class="btxt"><b>Bot activo.</b> Responde a todos los que escriban al número.</div></div>`;

  // Acción primero: la pichanga más próxima como marcador, antes que cualquier
  // métrica. Si no hay partido abierto, invita a abrir uno.
  // Los pagos por revisar son plata parada: iban al final de la página y ahora
  // van arriba, con el link a la lista ya filtrada en vez de "entra a la ficha".
  const alertaPagos = pagosRevisar
    ? `<a class="banner px" href="/admin/leads?key=${key}&vista=pagos&estado=rev" style="margin:0 0 14px;text-decoration:none">
        <div class="bic">💸</div>
        <div class="btxt"><b>${pagosRevisar} pago${pagosRevisar === 1 ? '' : 's'} por revisar.</b>
          Monto que no calza, comprobante repetido o ilegible — tócalo para verlos.</div></a>`
    : '';

  /**
   * "Para que el bot trabaje solo" — la deuda de configuración, a la vista.
   *
   * El panel nunca decía que faltaba algo: las cuatro zonas están sin link de
   * grupo desde el primer día y en ninguna pantalla aparecía esa deuda, así que
   * no había manera de enterarse salvo bajar por Ajustes campo por campo.
   * Cada fila lleva al campo EXACTO que la resuelve (?vista=config#zona-X) y
   * dice qué se desbloquea, no qué se hizo mal.
   */
  const cfg = db.getConfigMap();
  const pendientes = [];
  const aConfig = (ancla) => `/admin/leads?key=${key}&vista=config#${ancla}`;
  for (const z of db.zonasOperativas()) {
    const nombre = esc(db.nombreDeZona(z));
    if (!(cfg[`grouplink_${z}`] || '').trim()) {
      pendientes.push({
        ico: '🔗', que: `${nombre} no tiene link de grupo`,
        para: 'El bot no puede meter a nadie al grupo de este distrito.',
        href: aConfig(`zona-${z}`), cta: 'Cargarlo',
      });
    }
    if (!(Number(cfg[`precio_${z}`]) > 0)) {
      pendientes.push({
        ico: '💰', que: `${nombre} no tiene precio`,
        para: 'El bot no sabe cuánto cobrar cuando preguntan por esta zona.',
        href: aConfig(`zona-${z}`), cta: 'Ponerlo',
      });
    }
  }
  const sinCosto = db.listSedes().filter((s) => s.costo == null);
  if (sinCosto.length) {
    pendientes.push({
      ico: '🏟', que: `${sinCosto.length} cancha${sinCosto.length === 1 ? '' : 's'} sin costo de alquiler`,
      para: 'Sin ese dato la caja del partido muestra lo que entra, no lo que queda.',
      href: aConfig(`zona-${sinCosto[0].zona}`), cta: 'Completar',
    });
  }
  // Partidos que ya se jugaron y siguen en 'abierto'. Nada los cierra solo (a
  // propósito: cerrarlos dejaría huérfano el Yape que entra tarde), así que la
  // única forma de que no se apilen es recordárselo acá.
  const horaAhora = Number(new Date(Date.now() - 5 * 3600e3).toISOString().slice(11, 13));
  const sinCerrar = db.listPartidos().filter((p) => p.estado === 'abierto'
    && (p.fecha < hoyLima() || (p.fecha === hoyLima() && db.ordenHora(p.hora) <= horaAhora)));
  if (sinCerrar.length) {
    pendientes.push({
      ico: '🔒', que: `${sinCerrar.length} partido${sinCerrar.length === 1 ? '' : 's'} ya jugado${sinCerrar.length === 1 ? '' : 's'} sin cerrar`,
      para: 'Al cerrarlos cuadra la caja y dejan de figurar como si aún se pudiera entrar.',
      href: `/admin/leads?key=${key}&vista=partidos`, cta: 'Cerrarlos',
    });
  }
  if (!(cfg.yape_numero || '').trim()) {
    pendientes.push({
      ico: '📲', que: 'Falta el número de Yape',
      para: 'Es el número que el bot le pasa a cada jugador para cobrarle.',
      href: aConfig('general'), cta: 'Ponerlo',
    });
  }
  const bloquePendientes = pendientes.length ? `
      <div class="shdr">Para que el bot trabaje solo <small>· ${pendientes.length} dato${pendientes.length === 1 ? '' : 's'} por cargar</small></div>
      <div class="zlist">
        ${pendientes.slice(0, 6).map((p) => `<a class="prow" href="${p.href}">
          <span class="pico2">${p.ico}</span>
          <span class="ptxt"><b>${p.que}</b><small>${p.para}</small></span>
          <span class="pcta">${p.cta} ›</span></a>`).join('')}
      </div>` : '';

  const abiertos = db.partidosAbiertos();
  const prox = abiertos[0] || null;
  const heroPartido = prox
    ? `<a class="marcador" style="display:block;margin-bottom:14px" href="/admin/leads?key=${key}&vista=partidos&partido=${prox.id}">
        <div class="mtop"><span class="mlabel">⚽ Próxima pichanga · ${ZONAS[prox.zona]?.nombre || esc(prox.zona)}</span>
          <span class="mdelta">${prox.restante > 0 ? `${prox.restante} cupos libres` : '⏳ LLENO — hay espera'}</span></div>
        <div class="mnum">${prox.ocupados}<span style="font-size:32px;color:var(--on-navy-3)">/${prox.cupo}</span></div>
        <div class="mfoot">${esc(db.fechaBonita(prox.fecha))}${prox.hora ? ` · ${esc(prox.hora)}` : ''}${prox.sede ? ` · ${esc(prox.sede)}` : ''} — toca para ver la lista y copiarla al grupo</div>
      </a>`
    : `<a class="banner px" href="/admin/leads?key=${key}&vista=partidos" style="margin:0 0 14px;text-decoration:none"><div class="bic">⚽</div>
        <div class="btxt"><b>No hay partidos con inscripción abierta.</b> Abre uno y el bot empieza a llenar la lista solo.</div></a>`;

  return baseHtml('Pichangueros — Resumen', `
    <div class="ltitle">
      <div><div class="eyebrow">Pichangueros · Tu equipo está aquí</div><h2>Resumen</h2></div>
      <span class="live"><i></i> En vivo</span>
    </div>
    <div class="px">
      ${heroPartido}
      ${alertaPagos}
      ${bannerSeguro}
      ${bloquePendientes}

      <div class="dash">
      <div class="dcol">
      <div class="shdr">Pendientes <small>· toca para actuar</small></div>
      <div class="grid2" style="margin-top:2px">
        <a class="stat green" href="/admin/leads?key=${key}&vista=crm">${delta ? `<span class="chip ${delta > 0 ? 'up' : 'wait'}">${delta > 0 ? '▲' : '▼'} ${Math.abs(delta)}%</span>` : ''}<div class="sn">${semana}</div><div class="sl">Esta semana</div></a>
        <a class="stat navy" href="/admin/leads?key=${key}&vista=crm&dia=${hoy}&tipo=nuevos" title="Ver a los que escribieron por primera vez hoy"><div class="sn">${hoyN}</div><div class="sl">Nuevos hoy ›</div></a>
        <a class="stat amber" href="/admin/leads?key=${key}&vista=crm&filtro=responder">${colaResp ? '<span class="chip wait">pendiente</span>' : ''}<div class="sn">${colaResp}</div><div class="sl">${modoSeguro ? 'Testers sin responder' : 'Sin responder (48 h)'}</div></a>
        <a class="stat ${enHandoff ? 'red' : ''}" href="/admin/leads?key=${key}&vista=crm&filtro=handoff"><div class="sn">${enHandoff}</div><div class="sl">Para Clarck</div></a>
      </div>

      <div class="shdr">Por zona <small>· toca para ver quiénes son</small></div>
      <div class="zlist">
        ${ordenZonas.map((z) => zrow(
          z === 'otra' ? 'Sin sede cerca' : esc(db.nombreDeZona(z)),
          zc[z],
          ZONAS[z]?.color || '#64748b',
          `&zona=${encodeURIComponent(z)}`
        )).join('')}
        ${sinClasificar ? zrow('Por clasificar', sinClasificar, 'var(--ink-3)', null) : ''}
      </div>

      ${distritos.length ? `
      <div class="shdr">¿Dónde abrir? · demanda por distrito</div>
      <div class="zlist">${distritos.map(drow).join('')}</div>
      <div class="foot" style="padding:8px 2px 0">Referencia: ${UMBRAL_PILOTO}+ interesados ≈ 2 pichangas llenas → 🔥 candidato a piloto.</div>` : ''}

      </div>
      <div class="dcol">
      <div class="shdr">La comunidad <small>· ${todos.length} contactos</small></div>
      <div class="marcador">
        <div class="mtop"><span class="mlabel">Contactos captados</span>
          <span class="mdelta">▲ +${semana} esta semana</span></div>
        <div class="mnum">${todos.length}</div>
        <div style="font-size:13px;font-weight:700;margin-top:4px">
          <span style="color:var(--on-navy-ok)">Hoy: ${dias[dias.length - 1].nuevos} nuevo${dias[dias.length - 1].nuevos === 1 ? '' : 's'}</span>
          <span style="color:var(--on-navy-rec)"> · ${dias[dias.length - 1].rec} recurrente${dias[dias.length - 1].rec === 1 ? '' : 's'} (ya registrados, volvieron a escribir)</span>
        </div>
        <div class="bars">${barras}</div>
        <div class="mfoot"><span style="color:var(--on-navy-ok)">■ Nuevos</span> · <span style="color:var(--on-navy-rec)">■ Recurrentes</span> — toca una barra para ver ese día. Solo chats directos.</div>
      </div>

      <div class="shdr">Pipeline · del primer mensaje al pago <small>· toca para ver quiénes</small></div>
      <div class="zlist">
        ${/* El embudo usaba el azul y el violeta de iOS (#0a84ff, #5e5ce6) en un
              panel lima/navy: cinco colores de tres sistemas distintos para una
              sola escalera. Ahora es UNA rampa de marca, de navy (todos los que
              escriben) a lima (los que pagan), y el ámbar marca el único escalón
              que es una espera, no un avance. */ ''}
        ${frow('Escribieron al número', todos.length, 'var(--navy-fill)', '', '')}
        ${frow('Dejaron sus datos', conDatos, 'var(--navy-2)', 'nombre · edad · distrito', '&estado=con_datos')}
        ${frow('Invitados al grupo', invitados, 'var(--ramp-mid)', 'Breña / Comas', '&estado=invitado_grupo')}
        ${frow('Lista de espera', enEspera, 'var(--st-debe-solid)', 'otras zonas', '&estado=lista_espera')}
        ${frow('Pagaron por Yape', nPagadores, 'var(--lime-fill)', '', '&estado=pago')}
      </div>
      <div class="foot" style="padding:8px 2px 0">"Escribieron" cuenta a <b>todos</b> los que chatean al número (también conocidos y jugadores antiguos), no solo interesados nuevos.</div>

      ${paraHoy ? `<a class="banner px" href="/admin/leads?key=${key}&vista=crm&filtro=hoy" style="margin-top:12px;text-decoration:none"><div class="bic">⏰</div><div class="btxt"><b>${paraHoy} seguimiento${paraHoy === 1 ? '' : 's'} para hoy.</b> Toca para verlos.</div></a>` : ''}


      </div>
      </div>
      <div class="foot">Se actualiza solo cada 90 s · <a href="/admin/leads.csv?key=${key}" style="color:var(--lime-ink)">⬇ exportar CSV</a></div>
    </div>
  `, { refresh: true, activo: 'resumen', key, aviso: query });
}

const MESES = ['ene', 'feb', 'mar', 'abr', 'may', 'jun', 'jul', 'ago', 'sep', 'oct', 'nov', 'dic'];
const mesCorto = (yyyymmdd) => MESES[Number((yyyymmdd || '').slice(5, 7)) - 1] || '';

// "2026-08-13" → "13 ago 2026". fechaBonita() escribe para el chat ("MAÑANA
// jueves 13 de agosto"), que en una celda de tabla se parte en dos líneas y
// empuja el dato fuera de la vista.
const DIAS_CORTOS = ['Dom', 'Lun', 'Mar', 'Mié', 'Jue', 'Vie', 'Sáb'];
const fechaCompacta = (f, conDia = false, conAnio = true) => {
  if (!/^\d{4}-\d{2}-\d{2}/.test(f || '')) return f || '—';
  const [y, , d] = f.slice(0, 10).split('-');
  const dia = conDia ? `${DIAS_CORTOS[new Date(`${f.slice(0, 10)}T12:00:00`).getDay()]} ` : '';
  return `${dia}${Number(d)} ${mesCorto(f)}${conAnio ? ` ${y}` : ''}`;
};

// ==============================================================================
//  Vista · PAGOS (finanzas: todos los cobros, medio, operación, estado)
// ==============================================================================
// Mismo criterio que ZONAS: el cuadrito del medio de pago lleva sus iniciales en
// blanco. Plin (#0aa5a8 → 3.02:1) e Interbank (#12a14b → 3.37:1) no llegaban;
// van oscurecidos lo justo para conservar el color de cada app.
const MEDIOS = {
  yape: { nombre: 'Yape', color: '#6B2A7C' },        // 9.34:1
  plin: { nombre: 'Plin', color: '#067074' },        // 5.87:1
  bcp: { nombre: 'BCP', color: '#003B7A' },          // 11.01:1
  interbank: { nombre: 'Interbank', color: '#0C7A38' }, // 5.45:1
  otro: { nombre: 'Otro', color: '#4F5B6B' },        // 6.91:1
};

function paginaPagos(db, key, query = {}) {
  const todosPagos = db.listPagosTodos();
  const hoy = hoyLima();
  const soles = (n) => `S/ ${Number(n || 0) % 1 === 0 ? Number(n || 0) : Number(n || 0).toFixed(2)}`;
  const fechaHora = (ts) => (ts ? `${Number(ts.slice(8, 10))} ${mesCorto(ts)} · ${ts.slice(11, 16)}` : '—');

  // Filtros (combinables): estado, medio, período o día exacto.
  const fEstado = ['conf', 'rev'].includes(query.estado) ? query.estado : '';
  const fMedio = MEDIOS[query.medio] ? query.medio : '';
  // Por defecto la vista abre en los ÚLTIMOS 7 DÍAS: la operación es "de hoy
  // en adelante" — abrir con S/ 4,500 históricos y pagos de julio "por revisar"
  // confundía (parecía que todo estaba pendiente de nuevo). "Todo" sigue
  // disponible en el selector para auditar la historia.
  const fPeriodo = ['hoy', '7d', '30d', 'todo'].includes(query.periodo) ? query.periodo : '7d';
  const fDia = /^\d{4}-\d{2}-\d{2}$/.test(query.dia || '') ? query.dia : '';

  // "Alcance": medio + período/día (sin el filtro de estado). Las tarjetas de
  // arriba se calculan sobre el alcance — estilo Power BI: tocas un filtro y
  // TODO (tarjetas y listas) se recalcula sobre ese corte.
  let alcance = todosPagos;
  if (fMedio) alcance = alcance.filter((p) => (p.medio || 'yape') === fMedio);
  if (fDia) {
    // Un día puntual se revisa contra la app de Yape: orden cronológico (como Yape).
    alcance = alcance.filter((p) => (p.creado_en || '').slice(0, 10) === fDia)
      .sort((a, b) => (a.creado_en || '').localeCompare(b.creado_en || '') || a.id - b.id);
  } else if (fPeriodo && fPeriodo !== 'todo') {
    const desde = fPeriodo === 'hoy' ? hoy : fechaLima(fPeriodo === '7d' ? -6 : -29);
    alcance = alcance.filter((p) => (p.creado_en || '').slice(0, 10) >= desde);
  }
  const pagos = fEstado
    ? alcance.filter((p) => (fEstado === 'conf' ? p.estado === 'confirmado' : p.estado === 'revisar'))
    : alcance;
  const hayFiltro = Boolean(fEstado || fMedio || fPeriodo || fDia);

  const qs = (over) => {
    const p = { estado: fEstado, medio: fMedio, periodo: fPeriodo, dia: fDia, ...over };
    return Object.entries(p).filter(([, v]) => v).map(([k, v]) => `&${k}=${encodeURIComponent(v)}`).join('');
  };

  const conf = pagos.filter((p) => p.estado === 'confirmado');
  // "Por revisar" es una COLA DE TRABAJO: solo lo posterior al punto de
  // arranque. Los de julio siguen en la data (y en el filtro de estado), pero
  // no son tareas de hoy.
  const rev = pagos.filter((p) => p.estado === 'revisar' && (fEstado === 'rev' || db.despuesDelCorte(p.creado_en)));
  // Tarjetas: siempre sobre el ALCANCE (reaccionan a medio/período/día).
  const confAlcance = alcance.filter((p) => p.estado === 'confirmado');
  const revAlcance = alcance.filter((p) => p.estado === 'revisar');
  const totalAlcance = confAlcance.reduce((a, p) => a + (p.monto || 0), 0);
  const cuposAlcance = confAlcance.reduce((a, p) => a + (p.cupos || 1), 0);

  // Para los reenvíos: mapa nº de operación → el pago confirmado original,
  // para mostrar la EVIDENCIA (quién/cuándo/cuánto) en vez de un "posible".
  const confirmadoPorOp = {};
  for (const p of todosPagos) {
    if (p.estado === 'confirmado' && p.numero_operacion && !confirmadoPorOp[p.numero_operacion]) {
      confirmadoPorOp[p.numero_operacion] = p;
    }
  }

  const fila = (p) => {
    const m = MEDIOS[p.medio] || MEDIOS.otro;
    const ok = p.estado === 'confirmado';
    const quien = p.nombre || p.titular || `+${p.numero}`;
    const original = !ok && p.numero_operacion ? confirmadoPorOp[p.numero_operacion] : null;
    const evidencia = original && original.id !== p.id
      ? `↩ mismo nº de operación que el pago CONFIRMADO de ${esc(original.nombre || original.titular || `+${original.numero}`)} · ${fechaHora(original.creado_en)} · S/${original.monto}`
      : '';
    const detalles = [
      p.cupos > 1 ? `${p.cupos} cupos` : '',
      p.numero_operacion ? `op. ${esc(p.numero_operacion)}` : 'sin nº de operación',
      fechaHora(p.creado_en),
      ok && p.pagos_contacto > 1 ? `pago #${p.pagos_contacto} del contacto` : '',
    ].filter(Boolean).join(' · ');
    return `<a class="lrow" href="/admin/leads?key=${key}&numero=${p.numero}">
      <div class="pico" style="background:${m.color}">${esc(m.nombre.slice(0, 2).toUpperCase())}</div>
      <div class="lbody">
        <div class="lname">${soles(p.monto)} · ${esc(quien)}</div>
        <div class="lsub">${detalles}</div>
        ${!ok && p.motivo ? `<div class="lsub" style="color:var(--st-debe-ink)">⚠ ${esc(p.motivo)}</div>` : ''}
        ${evidencia ? `<div class="lsub" style="color:var(--st-debe-ink);white-space:normal">${evidencia}</div>` : ''}
      </div>
      <div class="lmeta">
        <span class="badge ${ok ? 'b-done' : 'b-wait'}">${ok ? 'confirmado' : 'por revisar'}</span>
        <span class="ltime">${esc(m.nombre)}</span>
      </div>
    </a>`;
  };

  return baseHtml('Pichangueros — Pagos', `
    <div class="ltitle">
      <div><div class="eyebrow">Pichangueros</div><h2>Pagos</h2></div>
      <span class="live"><i></i> En vivo</span>
    </div>
    <div class="px">
      <div class="grid2">
        <a class="stat green ${fEstado === 'conf' ? 'sel' : ''}" href="/admin/leads?key=${key}&vista=pagos${qs({ estado: 'conf' })}" title="Ver los pagos que suman este monto"><div class="sn">${soles(totalAlcance)}</div><div class="sl">Cobrado${hayFiltro ? ' (filtro)' : ' (confirmado)'} ›</div></a>
        <a class="stat navy" href="/admin/leads?key=${key}&vista=partidos" title="Ver los partidos donde están estos cupos"><div class="sn">${cuposAlcance}</div><div class="sl">Cupos pagados ›</div></a>
        <a class="stat ${fEstado === 'conf' ? 'sel' : ''}" href="/admin/leads?key=${key}&vista=pagos${qs({ estado: fEstado === 'conf' ? '' : 'conf' })}" title="${fEstado === 'conf' ? 'Quitar el filtro' : 'Ver solo los confirmados'}"><div class="sn">${confAlcance.length}</div><div class="sl">Pagos confirmados ${fEstado === 'conf' ? '✕' : '›'}</div></a>
        <a class="stat ${revAlcance.length ? 'amber' : ''} ${fEstado === 'rev' ? 'sel' : ''}" href="/admin/leads?key=${key}&vista=pagos${qs({ estado: fEstado === 'rev' ? '' : 'rev' })}" title="${fEstado === 'rev' ? 'Quitar el filtro' : 'Ver solo los que hay que revisar'}"><div class="sn">${revAlcance.length}</div><div class="sl">Por revisar ${fEstado === 'rev' ? '✕' : '›'}</div></a>
      </div>

      <form class="fbar" method="get" action="/admin/leads">
        <input type="hidden" name="key" value="${key}"><input type="hidden" name="vista" value="pagos">
        <select name="estado" onchange="this.form.submit()">
          <option value="">Estado: todos</option>
          <option value="conf"${fEstado === 'conf' ? ' selected' : ''}>✅ Confirmados</option>
          <option value="rev"${fEstado === 'rev' ? ' selected' : ''}>⚠ Por revisar</option>
        </select>
        <select name="medio" onchange="this.form.submit()">
          <option value="">Medio: todos</option>
          ${Object.entries(MEDIOS).map(([k, m]) => `<option value="${k}"${fMedio === k ? ' selected' : ''}>${m.nombre}</option>`).join('')}
        </select>
        <select name="periodo" onchange="this.form.submit()">
          <option value="hoy"${fPeriodo === 'hoy' ? ' selected' : ''}>Hoy</option>
          <option value="7d"${fPeriodo === '7d' ? ' selected' : ''}>Últimos 7 días</option>
          <option value="30d"${fPeriodo === '30d' ? ' selected' : ''}>Últimos 30 días</option>
          <option value="todo"${fPeriodo === 'todo' ? ' selected' : ''}>Todo el histórico</option>
        </select>
        <input type="date" name="dia" value="${fDia}" max="${hoy}" onchange="this.form.submit()">
      </form>
      ${hayFiltro ? `<div style="padding:6px 2px 0"><a class="fchip" href="/admin/leads?key=${key}&vista=pagos">✕ Limpiar filtros</a></div>` : ''}
      ${rev.length ? `
      <div class="shdr">Por revisar <small>· monto no coincide, comprobante repetido o ilegible — toca para ir a la ficha</small></div>
      <div class="llist">${rev.map(fila).join('')}</div>` : ''}

      <div class="shdr">Confirmados <small>· ${conf.length} pago${conf.length === 1 ? '' : 's'}</small></div>
      ${conf.length ? `<div class="llist">${conf.map(fila).join('')}</div>` : `<div class="vacio">${hayFiltro ? 'Sin pagos confirmados con este filtro.' : 'Todavía no hay pagos confirmados.<br>Cuando un jugador mande su captura de Yape, aparece acá.'}</div>`}

      <div class="foot">La IA lee cada comprobante (monto, remitente, nº de operación y app/banco).<br>Se actualiza solo cada 90 s.</div>
    </div>
  `, { refresh: true, activo: 'pagos', key, aviso: query });
}

// ==============================================================================
//  Vista 2 · CRM (lista de leads)
// ==============================================================================
function paginaCRM(db, key, query) {
  const todos = db.listLeads();
  const roles = db.ultimosRoles();
  const sinResp = (l) => sinResponder(roles, l);
  const hoy = hoyLima();

  const jugadosPor = db.partidosJugadosPorNumero();
  const q = (query.q || '').trim().toLowerCase();
  // Las zonas se crean desde Ajustes: si el filtro solo aceptara las cinco
  // escritas a mano, un distrito nuevo (San Borja) se ignoraría en silencio y
  // la lista mostraría a todos como si el filtro no existiera.
  const zonasVivas = [...db.zonasOperativas(), 'otra'];
  const zona = zonasVivas.includes(query.zona) ? query.zona : '';
  const filtro = query.filtro || '';
  const estadoF = Object.keys(ESTADOS).includes(query.estado) || ['pago', 'con_datos'].includes(query.estado) ? query.estado : '';
  const dia = /^\d{4}-\d{2}-\d{2}$/.test(query.dia || '') ? query.dia : '';
  const distritoF = normTexto(query.distrito || '');
  let leads = todos;
  if (q) leads = leads.filter((l) => [l.nombre, l.numero, l.distrito, l.etiquetas].join(' ').toLowerCase().includes(q));
  if (zona) leads = leads.filter((l) => l.zona === zona);
  if (filtro === 'handoff') leads = leads.filter((l) => l.handoff);
  if (filtro === 'responder') leads = leads.filter(sinResp);
  if (filtro === 'hoy') leads = leads.filter((l) => l.proxima_accion && l.proxima_accion <= hoy);
  // Recurrente = más de 5 partidos jugados (definición de Clarck). Nuevo = llegó
  // esta semana, la misma ventana que usa "Esta semana" en el Resumen.
  if (filtro === 'recurrentes') leads = leads.filter((l) => (jugadosPor[l.numero] || 0) >= db.RECURRENTE_DESDE);
  if (filtro === 'nuevos') leads = leads.filter((l) => (l.creado_en || '').slice(0, 10) >= fechaLima(-6));
  // Filtro por día: TODOS los que escribieron ese día (no solo los nuevos),
  // distinguibles entre nuevos (se registraron ese día) y recurrentes.
  const tipo = dia && ['nuevos', 'recurrentes'].includes(query.tipo) ? query.tipo : '';
  const esNuevoEse = (l) => (l.creado_en || '').slice(0, 10) === dia;
  if (dia) {
    const activos = new Set(db.actividadPorDia(dia).filter((r) => r.d === dia).map((r) => r.numero));
    leads = leads.filter((l) => activos.has(l.numero) || esNuevoEse(l));
    if (tipo === 'nuevos') leads = leads.filter(esNuevoEse);
    if (tipo === 'recurrentes') leads = leads.filter((l) => !esNuevoEse(l));
  }
  if (distritoF) leads = leads.filter((l) => normTexto(l.distrito) === distritoF);
  if (estadoF === 'pago') {
    const pagaron = new Set(db.numerosPagadores());
    leads = leads.filter((l) => pagaron.has(l.numero));
  } else if (estadoF === 'con_datos') {
    leads = leads.filter((l) => l.estado && l.estado !== 'nuevo');
  } else if (estadoF) {
    leads = leads.filter((l) => l.estado === estadoF);
  }
  const hayFiltro = Boolean(q || zona || filtro || estadoF || dia || distritoF);

  // Distritos existentes (texto libre normalizado) para el selector.
  const ddCrm = {};
  for (const l of todos) {
    const d = (l.distrito || '').trim();
    if (!d) continue;
    const k = normTexto(d);
    if (!ddCrm[k]) ddCrm[k] = { label: d, n: 0 };
    ddCrm[k].n++;
  }
  const distritosCrm = Object.entries(ddCrm).sort((a, b) => b[1].n - a[1].n);

  // Dos grupos: necesitan respuesta (handoff o sin responder) y el resto.
  // Un handoff solo es URGENTE si el contacto sigue activo (habló en 72 h).
  // Los derivados de julio que Clarck ya atendió a mano no son cola de hoy:
  // siguen filtrables con el chip "Clarck" y el bot sigue callado con ellos,
  // pero no infla "Necesitan respuesta" con historia muerta.
  const handoffActivo = (l) => {
    const u = roles[l.numero];
    return Boolean(l.handoff && u && u.en >= limaHace(72) && db.despuesDelCorte(u.en));
  };
  const urgentes = leads.filter((l) => handoffActivo(l) || sinResp(l));
  const resto = leads.filter((l) => !(handoffActivo(l) || sinResp(l)));

  // Los chips COMBINAN filtros (no se pisan); tocar uno activo lo quita.
  const qsCrm = (over) => {
    const p = { q: query.q || '', zona, filtro, estado: estadoF, dia, tipo, distrito: distritoF, ...over };
    return Object.entries(p).filter(([, v]) => v).map(([k, v]) => `&${k}=${encodeURIComponent(v)}`).join('');
  };
  const chip = (campo, valor, label, cls = '') => {
    const actual = { zona, filtro, estado: estadoF }[campo];
    const on = actual === valor;
    return `<a class="fchip ${cls}${on ? ' on' : ''}" href="/admin/leads?key=${key}&vista=crm${qsCrm({ [campo]: on ? '' : valor })}">${label}</a>`;
  };

  const fila = (l) => {
    const sr = sinResp(l);
    const z = ZONAS[l.zona];
    const ultima = db.getHistory(l.numero, 1)[0];
    const sub = l.handoff ? esc(l.handoff_motivo || 'derivado a Clarck')
      : ultima && ultima.rol === 'user' ? `"${esc((ultima.texto || '').slice(0, 40))}"`
      : [l.distrito ? esc(l.distrito) : null, l.edad ? `${l.edad} años` : null].filter(Boolean).join(' · ') || 'sin datos aún';
    const nJug = jugadosPor[l.numero] || 0;
    const badge = l.handoff ? '<span class="badge b-hand">🔔 Clarck</span>'
      : sr ? '<span class="badge b-wait">sin responder</span>'
      : nJug >= db.RECURRENTE_DESDE ? `<span class="badge b-done">⭐ ${nJug} partidos</span>`
      : l.estado === 'lista_espera' ? '<span class="badge b-new">en espera</span>'
      : l.estado && l.estado !== 'nuevo' ? `<span class="badge b-done">${esc(ESTADOS[l.estado] || l.estado)}</span>`
      : z ? `<span class="badge b-zona" style="background:${z.color}">${z.nombre}</span>` : '';
    return `<a class="lrow" href="/admin/leads?key=${key}&numero=${esc(l.numero)}">
      ${(l.handoff || sr) ? '<span class="dotnew" style="background:' + (l.handoff ? 'var(--st-alerta-solid)' : 'var(--st-debe-solid)') + '"></span>' : ''}
      <span class="ava" style="background:${avatarColor(l.numero)}">${esc(iniciales(l.nombre, l.numero))}</span>
      <span class="lbody"><span class="lname">${esc(l.nombre || 'Sin nombre')}</span><span class="lsub">${sub}</span></span>
      <span class="lmeta"><span class="ltime">${horaCorta(l.actualizado_en)}</span>${badge}</span>
      ${SVG.chev}</a>`;
  };

  const grupo = (titulo, arr) => arr.length
    ? `<div class="shdr">${titulo} · ${arr.length}</div><div class="llist">${arr.map(fila).join('')}</div>` : '';

  // Seguimientos vencidos o de hoy, arriba de todo (propuesta v2). Estaban solo
  // detrás de un chip: si nadie lo tocaba, la promesa de "llamar a este el
  // jueves" se perdía. Es lo único de la pantalla con fecha de vencimiento.
  const paraHoyCrm = todos.filter((l) => l.proxima_accion && l.proxima_accion <= hoy);
  const seguimientos = (!dia && !filtro && paraHoyCrm.length)
    ? `<div class="shdr">📌 Seguimientos para hoy <small>· lo que prometiste hacer</small></div>
       <div class="llist">${paraHoyCrm.map((l) => `
         <a class="lrow" href="/admin/leads?key=${key}&numero=${esc(l.numero)}">
           <span class="ava" style="background:${avatarColor(l.numero)}">${esc(iniciales(l.nombre, l.numero))}</span>
           <span class="lbody"><span class="lname">${esc(l.nombre || 'Sin nombre')}</span>
             <span class="lsub">${esc(l.proxima_nota || 'sin nota')}</span></span>
           <span class="lmeta"><span class="badge ${l.proxima_accion < hoy ? 'b-hand' : 'b-wait'}">${l.proxima_accion < hoy ? 'vencido' : 'hoy'}</span></span>
           ${SVG.chev}</a>`).join('')}</div>`
    : '';

  // Con filtro de día, la agrupación útil es nuevos vs recurrentes de ese día.
  const lista = dia
    ? (leads.length
      ? grupo('🟢 Nuevos ese día', leads.filter(esNuevoEse)) + grupo('🔵 Recurrentes · ya estaban registrados', leads.filter((l) => !esNuevoEse(l)))
      : '<p class="vacio">Nadie escribió ese día ⚽</p>')
    : ((urgentes.length || resto.length)
      ? seguimientos + grupo('Necesitan tu atención ahora', urgentes) + grupo('Todos los contactos', resto)
      : `<p class="vacio">${Object.keys(query).some((k) => ['filtro', 'zona', 'estado', 'distrito', 'q'].includes(k))
          ? 'Ningún pichanguero calza con este filtro ⚽<br><a style="color:var(--lime-ink);font-weight:600" href="/admin/leads?key=' + key + '&vista=crm">Ver todos</a>'
          : 'Todavía no hay pichangueros registrados ⚽<br>Cuando alguien escriba al número, aparece acá.'}</p>`);

  return baseHtml('Pichangueros — CRM', `
    <div class="ltitle"><div><div class="eyebrow">${hayFiltro ? `${leads.length} de ${todos.length}` : todos.length} contactos</div><h2>Jugadores</h2></div>
      <div style="display:flex;gap:8px">
        <a class="csv" href="/admin/leads.csv?key=${key}">⬇ CSV</a>
        <a class="csv" href="/admin/leads.xlsx?key=${key}">📊 Excel</a>
      </div></div>
    <div class="px">
      <form class="search" method="get" action="/admin/leads">
        ${SVG.lupa}
        <input type="hidden" name="key" value="${key}"><input type="hidden" name="vista" value="crm">
        <input name="q" value="${esc(query.q || '')}" placeholder="Buscar nombre, número, distrito…">
        ${q ? '<button>Buscar</button>' : ''}
      </form>
      <div class="chips">
        <a class="fchip${!hayFiltro ? ' on' : ''}" href="/admin/leads?key=${key}&vista=crm">Todos</a>
        ${chip('filtro', 'nuevos', '🌱 Nuevos')}
        ${chip('filtro', 'recurrentes', '⭐ Recurrentes')}
        ${chip('filtro', 'responder', '📥 Sin responder', 'amber')}
        ${chip('filtro', 'handoff', '🔔 Clarck', 'red')}
        ${chip('filtro', 'hoy', '⏰ Para hoy', 'amber')}
        ${chip('zona', 'brena', 'Breña')}
        ${chip('zona', 'comas', 'Comas')}
        ${chip('zona', 'otra', 'Otras')}
      </div>
      <div class="chips" style="padding-top:0">
        ${chip('estado', 'nuevo', 'Sin datos aún')}
        ${chip('estado', 'datos_completos', 'Con datos')}
        ${chip('estado', 'invitado_grupo', 'En grupo')}
        ${chip('estado', 'lista_espera', 'En espera')}
        ${chip('estado', 'pago', '💰 Pagaron')}
        ${dia ? `<a class="fchip on" href="/admin/leads?key=${key}&vista=crm${qsCrm({ dia: '', tipo: '' })}">📅 ${Number(dia.slice(8))} ${mesCorto(dia)} ✕</a>
        <a class="fchip${tipo === 'nuevos' ? ' on' : ''}" href="/admin/leads?key=${key}&vista=crm${qsCrm({ tipo: tipo === 'nuevos' ? '' : 'nuevos' })}">🟢 Nuevos</a>
        <a class="fchip${tipo === 'recurrentes' ? ' on' : ''}" href="/admin/leads?key=${key}&vista=crm${qsCrm({ tipo: tipo === 'recurrentes' ? '' : 'recurrentes' })}">🔵 Recurrentes</a>` : ''}
        ${distritoF ? `<a class="fchip on" href="/admin/leads?key=${key}&vista=crm${qsCrm({ distrito: '' })}">📍 ${esc(ddCrm[distritoF]?.label || distritoF)} ✕</a>` : ''}
      </div>
      ${distritosCrm.length ? `
      <form class="search" method="get" action="/admin/leads" style="margin-top:4px">
        <input type="hidden" name="key" value="${key}"><input type="hidden" name="vista" value="crm">
        ${zona ? `<input type="hidden" name="zona" value="${zona}">` : ''}
        ${filtro ? `<input type="hidden" name="filtro" value="${filtro}">` : ''}
        ${estadoF ? `<input type="hidden" name="estado" value="${estadoF}">` : ''}
        <select name="distrito" onchange="this.form.submit()" style="flex:1;min-width:0;min-height:var(--tap);border:none;background:transparent;outline:none;font:inherit;font-size:var(--t-input);color:var(--ink)">
          <option value="">📍 Filtrar por distrito…</option>
          ${distritosCrm.map(([k, d]) => `<option value="${esc(k)}"${k === distritoF ? ' selected' : ''}>${esc(d.label)} (${d.n})</option>`).join('')}
        </select>
        <input type="date" name="dia" value="${dia}" max="${hoy}" style="flex:0 0 auto">
        <button>Filtrar</button>
      </form>` : ''}
      ${lista}
      <div class="foot">Se actualiza solo cada 90 s · toca un lead para abrir su ficha</div>
    </div>
  `, { refresh: true, activo: 'crm', key, aviso: query });
}

// ==============================================================================
//  Vista 3 · FICHA (contacto)
// ==============================================================================
function paginaFicha(db, key, numero, query = {}) {
  const lead = db.getOrCreateLead(numero);
  const msgs = db.getHistory(numero, 200);
  const notas = db.getNotas(numero);
  const pagosLead = db.listPagos(numero);
  // Evidencia de reenvíos: contra qué pago confirmado choca el nº de operación.
  const opsRevisar = pagosLead.filter((p) => p.estado === 'revisar' && p.numero_operacion);
  const originalDe = {};
  for (const p of opsRevisar) {
    const o = db.buscarPagoConfirmado(p.numero_operacion);
    if (o && o.id !== p.id) originalDe[p.id] = o;
  }
  const roles = db.ultimosRoles();
  const keyRaw = decodeURIComponent(key);
  const sinResp = sinResponder(roles, lead);
  const z = ZONAS[lead.zona];

  const botonesEtapa = Object.entries(ESTADOS).map(([v, label]) => `
    <form method="post" action="/admin/lead/estado" style="display:inline">
      <input type="hidden" name="key" value="${esc(keyRaw)}"><input type="hidden" name="numero" value="${esc(numero)}">
      <input type="hidden" name="estado" value="${v}">
      <button class="pstep ${lead.estado === v ? 'on' : ''}">${label}</button>
    </form>`).join('');

  const hayBot = msgs.some((m) => m.rol !== 'user');
  const burbujas = msgs.map((m) => `
    <div class="bub ${m.rol === 'user' ? 'in' : 'out'}">${esc(m.texto)}<time>${horaCorta(m.creado_en)}</time></div>`).join('');
  const chat = msgs.length
    ? burbujas + (!hayBot ? '<div class="noreply">🔒 El bot no respondió · modo seguro</div>' : '')
    : '<p class="vacio">Sin mensajes.</p>';

  const dato = (k, v, color) => `<div class="grow"><span class="k">${k}</span><span class="v"${color ? ` style="color:${color}"` : ''}>${esc(v)}</span></div>`;

  /**
   * La historia del jugador (propuesta v2). La ficha mostraba quién es, no qué
   * ha hecho: para saber si alguien es un habitual o si tiene partido el
   * miércoles había que cruzar tres pantallas a ojo.
   */
  const hoyF = hoyLima();
  const inscripciones = db.asistenciasDe(numero) || [];
  const jugados = inscripciones.filter((i) => i.fecha < hoyF).length;
  const proximaInsc = inscripciones.filter((i) => i.fecha >= hoyF).sort((a, b) => a.fecha.localeCompare(b.fecha))[0];
  const confirmados = pagosLead.filter((p) => p.estado === 'confirmado');
  const montoPagado = confirmados.reduce((a, p) => a + (Number(p.monto) || 0), 0);
  const historia = {
    primer: lead.creado_en ? `${fechaCompacta(lead.creado_en)} · lo captó el bot` : '—',
    partidos: jugados
      ? `${jugados} jugado${jugados === 1 ? '' : 's'}${jugados >= db.RECURRENTE_DESDE ? ' · ⭐ recurrente' : ''}`
      : 'Ninguno todavía',
    hayProximo: Boolean(proximaInsc),
    proximo: proximaInsc
      ? `${fechaCompacta(proximaInsc.fecha, true)}${proximaInsc.hora ? ` · ${proximaInsc.hora}` : ''} · ${proximaInsc.estado === 'pagado' ? 'pagado' : proximaInsc.estado}`
      : 'Sin reserva',
    montoPagado,
    pagado: montoPagado > 0
      ? `S/ ${montoPagado} · ${confirmados.length} pago${confirmados.length === 1 ? '' : 's'} verificado${confirmados.length === 1 ? '' : 's'}`
      : 'Nunca pagó por acá',
  };

  return baseHtml(`Ficha · ${lead.nombre || numero}`, `
    <div class="px">
      <div class="navbar">
        <a class="navback" href="/admin/leads?key=${key}&vista=crm">${SVG.back} Jugadores</a>
        <a class="wabtn" href="https://wa.me/${esc(numero)}" target="_blank" rel="noopener">${SVG.wa} WhatsApp</a>
      </div>
      <div class="ficha-grid">
        <div class="fcol-left stack">
      <div class="fhead">
        <div class="fava" style="background:${avatarColor(numero)}">${esc(iniciales(lead.nombre, numero))}</div>
        <h2>${esc(lead.nombre || 'Sin nombre')}</h2>
        <div class="fnum">+${esc(numero)}</div>
        <div class="fpills">
          ${z ? `<span class="pz" style="background:${z.color}">${z.nombre}</span>` : ''}
          ${lead.handoff ? `<span class="pz" style="background:var(--st-alerta-solid)">🔔 ${esc(lead.handoff_motivo || 'derivado')}</span>` : ''}
          ${sinResp ? '<span class="pz" style="background:var(--st-debe-solid)">📥 Sin responder</span>' : ''}
        </div>
      </div>

        <div>
          <div class="shdr">Perfil</div>
          <div class="group">
            ${dato('Edad', lead.edad)}
            ${dato('Distrito', lead.distrito)}
            ${dato('Zona', (z && z.nombre) || lead.zona, z && z.color)}
            ${dato('Etapa', ESTADOS[lead.estado] || lead.estado)}
          </div>
        </div>

        <div>
          <div class="shdr">Historia <small>· lo que el sistema sabe de él</small></div>
          <div class="group">
            ${dato('Primer contacto', historia.primer)}
            ${dato('Partidos', historia.partidos)}
            ${dato('Próximo partido', historia.proximo, historia.hayProximo ? 'var(--lime-ink)' : null)}
            ${dato('Total pagado', historia.pagado, historia.montoPagado > 0 ? 'var(--lime-ink)' : null)}
          </div>
        </div>

        ${lead.handoff ? `<form method="post" action="/admin/lead/reactivar">
          <input type="hidden" name="key" value="${esc(keyRaw)}"><input type="hidden" name="numero" value="${esc(numero)}">
          <button class="btn-toque btn-guardar" style="width:100%;min-height:var(--tap-lg);font-size:var(--t-l)">🔓 Reactivar el bot para este contacto</button>
        </form>` : ''}

        <div class="ancla" id="etapa">
          <div class="shdr">Etapa</div>
          <div class="group"><div class="pipe">${botonesEtapa}</div></div>
        </div>

        <div class="ancla" id="etiquetas">
          <div class="shdr">Etiquetas <small>(separadas por coma)</small></div>
          <div class="group"><form class="inline" method="post" action="/admin/lead/etiquetas">
            <input type="hidden" name="key" value="${esc(keyRaw)}"><input type="hidden" name="numero" value="${esc(numero)}">
            <input name="etiquetas" value="${esc(lead.etiquetas || '')}" placeholder="casero, paga efectivo, VIP…">
            <button>Guardar</button>
          </form></div>
        </div>

        <div class="ancla" id="seguimiento">
          <div class="shdr">Próxima acción</div>
          <div class="group"><form class="inline" method="post" action="/admin/lead/seguimiento">
            <input type="hidden" name="key" value="${esc(keyRaw)}"><input type="hidden" name="numero" value="${esc(numero)}">
            <input type="date" name="fecha" value="${esc(lead.proxima_accion || '')}">
            <input name="nota" value="${esc(lead.proxima_nota || '')}" placeholder="ej. avisarle del cupo del viernes">
            <button>Guardar</button>
          </form></div>
        </div>

        ${pagosLead.length ? `<div>
          <div class="shdr">Pagos (Yape)</div>
          <div class="group">
            ${pagosLead.map((p) => `
              <div class="grow" style="align-items:flex-start">
                <span class="k">${p.monto != null ? `S/ ${esc(p.monto)}` : 'Monto ilegible'}${p.titular ? ` · ${esc(p.titular)}` : ''}<br>
                  <small style="color:var(--ink-3)">${esc((p.creado_en || '').slice(0, 16))}${p.numero_operacion ? ` · op. ${esc(p.numero_operacion)}` : ''}</small>
                  ${p.estado === 'revisar' && p.motivo ? `<br><small style="color:var(--st-alerta-ink)">⚠ ${esc(p.motivo)}</small>` : ''}
                  ${originalDe[p.id] ? `<br><small style="color:var(--st-alerta-ink)">↩ mismo nº de operación que el pago CONFIRMADO de <a href="/admin/leads?key=${key}&numero=${esc(originalDe[p.id].numero)}" style="text-decoration:underline">+${esc(originalDe[p.id].numero)}</a> · ${esc((originalDe[p.id].creado_en || '').slice(0, 16))} · S/${esc(originalDe[p.id].monto)}</small>` : ''}
                </span>
                <span class="v" style="color:${p.estado === 'confirmado' ? 'var(--lime-ink)' : 'var(--st-alerta-ink)'}">${p.estado === 'confirmado' ? '✅ Confirmado' : '⚠ Revisar'}</span>
              </div>`).join('')}
          </div>
        </div>` : ''}

        <div class="ancla" id="notas">
          <div class="shdr">Notas</div>
          <div class="group">
            <form class="inline" method="post" action="/admin/lead/nota">
              <input type="hidden" name="key" value="${esc(keyRaw)}"><input type="hidden" name="numero" value="${esc(numero)}">
              <input name="texto" placeholder="ej. vino con 3 amigos, buen arquero…">
              <button>+ Nota</button>
            </form>
            <div class="notas-list">${notas.map((n) => `<p>${esc(n.texto)}<time>${esc((n.creado_en || '').slice(0, 16))}</time></p>`).join('') || '<p style="border:none;color:var(--ink-3)">Sin notas.</p>'}</div>
          </div>
        </div>

        ${/* Borrar el contacto y todo su historial quedaba pegado justo debajo
              del "+ Nota": dos botones a 6px de distancia, uno de uso diario y
              el otro irreversible. Va apartado, con línea y 24px de aire. */ ''}
        <div class="acc-peligro">
          <form method="post" action="/admin/lead/eliminar" onsubmit="return confirm('¿Eliminar este contacto y todo su historial? No se puede deshacer.')">
            <input type="hidden" name="key" value="${esc(keyRaw)}"><input type="hidden" name="numero" value="${esc(numero)}">
            <button class="btn-toque btn-peligro">🗑 Eliminar contacto (prueba/spam)</button>
          </form>
        </div>

        </div>
        <div class="fcol-right">
          <div class="shdr">Conversación</div>
          <div class="chat">${chat}</div>
        </div>
      </div>
      <div class="foot">⚽ Pichangueros CRM</div>
    </div>
  `, { refresh: false, activo: 'crm', key, tabbarMobile: false, aviso: query });
}

// ==============================================================================
//  Config — sedes, precios y textos del negocio (editable, sin tocar código)
// ==============================================================================
function paginaConfig(db, key, conexion = null, query = {}) {
  const keyRaw = decodeURIComponent(key);
  const c = db.getConfigMap();
  // Zonas dinámicas: las mismas que ve el bot (siguen a las sedes).
  const zonasOp = db.zonasOperativas();
  const sedesPorZona = Object.fromEntries(zonasOp.map((z) => [z, db.listSedes(z)]));

  const filaSede = (zona, s) => {
    const uid = s ? `s${s.id}` : `nueva-${esc(zona)}`;
    const v = (campoNombre) => esc(s?.[campoNombre] ?? '');
    return `
    <div class="sede">
      <div class="sede-tit">${s ? `🏟 ${esc(s.nombre)}` : '➕ Agregar otra cancha a este distrito'}</div>
      <form method="post" action="/admin/config/sede">
        <input type="hidden" name="key" value="${esc(keyRaw)}">
        <input type="hidden" name="zona" value="${esc(zona)}">
        ${s ? `<input type="hidden" name="id" value="${s.id}">` : ''}

        <div class="campos-tit">Identidad</div>
        <div class="campos">
          ${campo(`${uid}-nombre`, 'Nombre de la cancha',
            `<input id="${uid}-nombre" name="nombre" value="${v('nombre')}" placeholder="Ej. Complejo Melgar" required>`,
            'Así la nombra el bot en el chat y en la lista del grupo.')}
          ${campo(`${uid}-cancha`, 'Campo o número de cancha',
            `<input id="${uid}-cancha" name="cancha" value="${v('cancha')}" placeholder="Ej. Cancha 2">`,
            'Opcional, si el local tiene varias.')}
          ${campo(`${uid}-ubicacion`, 'Link de ubicación',
            `<input id="${uid}-ubicacion" name="ubicacion" value="${v('ubicacion')}" placeholder="https://maps.app.goo.gl/…" inputmode="url">`,
            'El bot lo manda cuando preguntan dónde queda.', true)}
        </div>

        <div class="campos-tit">Operación</div>
        <div class="campos">
          ${campo(`${uid}-cupo`, 'Cupo',
            `<input id="${uid}-cupo" name="cupo" type="number" min="1" max="60" inputmode="numeric" value="${v('cupo')}" placeholder="14">`,
            'Cuántos jugadores entran por turno.')}
          ${campo(`${uid}-costo`, 'Costo de la cancha (S/)',
            `<input id="${uid}-costo" name="costo" type="number" min="0" step="0.5" inputmode="decimal" value="${v('costo')}" placeholder="150">`,
            s && s.costo == null
              ? '<span class="falta">Falta cargarlo.</span> Es lo que te cuesta alquilarla por turno: sin esto el panel muestra lo que entra, no lo que queda.'
              : 'Lo que te cuesta alquilarla por turno. Con esto el partido te dice cuánto queda.')}
          ${campo(`${uid}-horario`, 'Horario',
            `<input id="${uid}-horario" name="horario" value="${v('horario')}" placeholder="Ej. Lun a Vie 7-11pm">`,
            'El bot responde con esto cuando preguntan a qué hora se juega.')}
          ${campo(`${uid}-estacionamiento`, 'Estacionamiento',
            `<input id="${uid}-estacionamiento" name="estacionamiento" value="${v('estacionamiento')}" placeholder="Ej. Sí, gratis">`,
            'Opcional.')}
        </div>

        <div class="pie-form">
          <button class="btn-toque btn-guardar">${s ? 'Guardar cancha' : '➕ Agregar cancha'}</button>
        </div>
      </form>
      ${s ? `<form method="post" action="/admin/config/sede/eliminar" class="pie-form"
        onsubmit="return confirm('¿Eliminar esta cancha? Los partidos ya creados no se tocan.')">
        <input type="hidden" name="key" value="${esc(keyRaw)}"><input type="hidden" name="id" value="${s.id}">
        <button class="btn-toque btn-peligro">🗑 Eliminar esta cancha</button>
      </form>` : ''}
    </div>`;
  };

  // Una TARJETA por distrito: precio + grupo + nombre + sus canchas, todo junto.
  // El id="zona-<slug>" es el destino al que vuelven los guardados y al que
  // apunta el bloque "Para que el bot trabaje solo" del Resumen.
  const bloqueZona = (zona) => {
    const nombre = db.nombreDeZona(zona);
    const link = c[`grouplink_${zona}`] || '';
    return `
    <div class="ancla" id="zona-${esc(zona)}">
      <div class="shdr">📍 ${esc(nombre)} <small>· precio, grupo y canchas de este distrito</small></div>
      <div class="group" style="border-left:6px solid ${colorZona(zona)}">
        <form method="post" action="/admin/config/zona">
          <input type="hidden" name="key" value="${esc(keyRaw)}"><input type="hidden" name="zona" value="${esc(zona)}">
          <div class="campos">
            ${campo(`z-${esc(zona)}-precio`, 'Precio por jugador (S/)',
              `<input id="z-${esc(zona)}-precio" name="precio" type="number" step="0.5" inputmode="decimal" value="${esc(c[`precio_${zona}`] || '')}" placeholder="15">`,
              'Lo que el bot cobra por cupo en este distrito.')}
            ${campo(`z-${esc(zona)}-nombre`, 'Nombre para mostrar',
              `<input id="z-${esc(zona)}-nombre" name="nombre_mostrar" value="${esc(nombre)}">`,
              'Como lo ve el jugador en el chat.')}
            ${campo(`z-${esc(zona)}-link`, 'Link del grupo de WhatsApp',
              `<input id="z-${esc(zona)}-link" name="grouplink" value="${esc(link)}" placeholder="https://chat.whatsapp.com/…" inputmode="url">`,
              link
                ? 'El bot se lo entrega a los que se suman a este distrito.'
                : '<span class="falta">Todavía sin cargar: el bot no puede meter a nadie al grupo.</span> Para copiarlo: abre el grupo en WhatsApp → toca el nombre del grupo → Invitar por enlace → Copiar enlace.',
              true)}
          </div>
          <div class="pie-form">
            <button class="btn-toque btn-guardar">Guardar ${esc(nombre)}</button>
          </div>
        </form>
        <div class="campos-tit">Canchas de ${esc(nombre)}</div>
        ${sedesPorZona[zona].map((s) => filaSede(zona, s)).join('')
          || '<p style="padding:0 14px 12px;color:var(--ink-3);font-size:14px">Sin canchas todavía.</p>'}
        ${filaSede(zona, null)}
      </div>
    </div>`;
  };

  const corteActual = db.getCorte();
  const bloqueCorte = `
    <div class="ancla" id="corte">
      <div class="shdr">🚦 Punto de arranque <small>· desde cuándo cuentan las colas de trabajo</small></div>
      <div class="group">
        <form method="post" action="/admin/config/corte">
          <input type="hidden" name="key" value="${esc(keyRaw)}">
          <p style="padding:13px 14px 0;font-size:13.5px;color:var(--ink-2);line-height:1.45">
            Los pagos y las derivaciones <b>anteriores</b> a esta fecha quedan como historial: la plata se sigue
            sumando y las conversaciones siguen ahí, pero <b>no aparecen como pendientes</b> (esos partidos ya se
            jugaron y esas derivaciones ya las atendiste). <b>No se borra nada.</b>
          </p>
          <div class="campos">
            ${campo('corte-fecha', 'Cuenta desde',
              `<input id="corte-fecha" name="fecha" type="date" value="${esc(corteActual || hoyLima())}" max="${hoyLima()}">`,
              corteActual
                ? `Ahora el sistema cuenta desde el ${esc(fechaCompacta(corteActual))}.`
                : 'Todavía no hay punto de arranque: las colas incluyen toda la historia.')}
          </div>
          <div class="pie-form">
            <button class="btn-toque btn-guardar">🚦 Empezar en limpio desde esta fecha</button>
          </div>
        </form>
      </div>
    </div>`;

  const nuevoDistrito = `
    <div class="ancla" id="nuevo-distrito">
      <div class="shdr">➕ Nuevo distrito <small>· al crearlo aparece en el bot, los partidos y esta página</small></div>
      <div class="group" style="border:1.5px dashed var(--line-strong);box-shadow:none">
        <form method="post" action="/admin/config/zona/nueva">
          <input type="hidden" name="key" value="${esc(keyRaw)}">
          <div class="campos">
            ${campo('nd-nombre', 'Nombre del distrito',
              '<input id="nd-nombre" name="nombre" placeholder="Ej. Miraflores" required>',
              'Así lo van a ver los jugadores.')}
            ${campo('nd-precio', 'Precio por jugador (S/)',
              '<input id="nd-precio" name="precio" type="number" step="0.5" inputmode="decimal" value="15">')}
            ${campo('nd-sede', 'Primera cancha',
              '<input id="nd-sede" name="sede" placeholder="Nombre de la cancha">',
              'Puedes cambiarla después.')}
            ${campo('nd-cupo', 'Cupo',
              '<input id="nd-cupo" name="cupo" type="number" min="2" max="60" inputmode="numeric" value="14">',
              'Cuántos jugadores entran por turno.')}
          </div>
          <div class="pie-form">
            <button class="btn-toque btn-guardar">➕ Crear distrito</button>
          </div>
        </form>
      </div>
    </div>`;

  // Lo único vivo que quedaba en la pestaña "Conexión": qué número está
  // atendiendo. Ya no merece una pestaña propia — con el canal oficial no hay
  // QR que escanear ni sesión que reenlazar, así que es una línea de estado.
  const estadoCanal = conexion ? conexion.estado() : 'desconocido';
  const numeroCanal = conexion ? conexion.numero() : null;
  const enLinea = estadoCanal === 'ready';
  const bloqueCanal = `
    <div class="shdr ancla" id="canal">Canal de WhatsApp</div>
    <div class="group" style="display:flex;align-items:center;gap:13px;padding:15px">
      <span style="flex:0 0 auto;width:11px;height:11px;border-radius:50%;background:${enLinea ? 'var(--lime)' : 'var(--st-debe-solid)'}"></span>
      <div style="flex:1;min-width:0">
        <div style="font-weight:700;font-size:15px">${enLinea ? 'Bot en línea' : `Canal ${esc(estadoCanal)}`}</div>
        <div style="font-size:13px;color:var(--ink-2)">
          ${numeroCanal ? `Atendiendo desde +${esc(numeroCanal)}` : 'Sin número enlazado'} · canal oficial de Meta
        </div>
      </div>
    </div>
    <p style="font-size:12.5px;color:var(--ink-3);margin:8px 2px 20px;line-height:1.5">
      Con el canal oficial el número no se enlaza por QR: se administra desde la cuenta de Meta.
      Clarck sigue usando su WhatsApp normal en el celular sobre el mismo número.
    </p>`;

  return baseHtml('Ajustes · Pichangueros', `
    <div class="px">
      <div class="ltitle"><div><div class="eyebrow">Ajustes</div><h2>Configuración</h2></div></div>

      ${bloqueCanal}

      <div class="ancla" id="general">
        <div class="shdr">El negocio <small>· lo que el bot dice y cómo cobra</small></div>
        <div class="group">
          <form method="post" action="/admin/config/general">
            <input type="hidden" name="key" value="${esc(keyRaw)}">

            <div class="campos-tit">Cómo cobras</div>
            <div class="campos">
              ${campo('g-yape-numero', 'Yape — número',
                `<input id="g-yape-numero" name="yape_numero" value="${esc(c.yape_numero)}" inputmode="tel">`,
                'El bot le pasa este número a cada jugador para cobrarle.')}
              ${campo('g-yape-titular', 'Yape — titular',
                `<input id="g-yape-titular" name="yape_titular" value="${esc(c.yape_titular)}">`,
                'El nombre que le aparece al jugador al yapear.')}
            </div>

            <div class="campos-tit">Identidad</div>
            <div class="campos">
              ${campo('g-marca', 'Marca',
                `<input id="g-marca" name="marca" value="${esc(c.marca)}">`,
                'Cómo se presenta el bot.')}
              ${campo('g-emojis', 'Emojis de la casa',
                `<input id="g-emojis" name="emojis" value="${esc(c.emojis)}">`,
                'Separados por coma. El bot los usa al escribir.')}
              ${campo('g-llegada', 'Regla de llegada',
                `<input id="g-llegada" name="hora_llegada" value="${esc(c.hora_llegada)}">`,
                'Relativa, vale para todo horario y cancha — ej. "15 minutos antes del inicio de tu turno". Si una cancha necesita algo especial, ponlo en el horario de esa cancha.',
                true)}
            </div>

            <div class="campos-tit">Textos que el bot manda tal cual</div>
            <div class="campos">
              ${campo('g-bienvenida', 'Mensaje de bienvenida',
                `<textarea id="g-bienvenida" name="bienvenida">${esc(c.bienvenida)}</textarea>`,
                'Lo primero que recibe alguien que escribe por primera vez.', true)}
              ${campo('g-mecanica', 'Mecánica para jugar',
                `<textarea id="g-mecanica" name="mecanica">${esc(c.mecanica)}</textarea>`,
                'La respuesta a "¿cómo funciona?".', true)}
              ${campo('g-pago', 'Política de pago',
                `<textarea id="g-pago" name="pago">${esc(c.pago)}</textarea>`, '', true)}
              ${campo('g-devoluciones', 'Política de devoluciones',
                `<textarea id="g-devoluciones" name="devoluciones">${esc(c.devoluciones)}</textarea>`, '', true)}
              ${campo('g-convivencia', 'Reglas de convivencia',
                `<textarea id="g-convivencia" name="convivencia">${esc(c.convivencia)}</textarea>`, '', true)}
            </div>

            <div class="pie-form">
              <button class="btn-toque btn-guardar">Guardar los datos del negocio</button>
            </div>
          </form>
        </div>
      </div>

      ${bloqueCorte}
      ${zonasOp.map((z) => bloqueZona(z)).join('')}
      ${nuevoDistrito}

      <div class="foot">⚽ Pichangueros · Config</div>
    </div>
  `, { refresh: false, activo: 'config', key, aviso: query });
}

// ==============================================================================
//  Vista PARTIDOS — convocatorias, inscripciones, lista de espera, asistencia
// ==============================================================================
const ESTADOS_PARTIDO = { abierto: 'Abierto', cerrado: 'Cerrado', jugado: 'Jugado ✅', cancelado: 'Cancelado' };
const ESTADOS_INSC = { pagado: 'Pagado ✅', reservado: 'Reservado', espera: 'En espera ⏳', baja: 'Baja' };

function paginaPartidos(db, key, query = {}) {
  const keyRaw = decodeURIComponent(key);
  const partidoId = Number(query.partido) || null;
  if (partidoId) return paginaPartidoDetalle(db, key, keyRaw, partidoId, query);

  const todosPartidos = db.listPartidos();
  const verCancelados = query.cancelados === '1';
  // Los cancelados sin nadie adentro son ruido (duplicados, cargas erradas):
  // se ocultan salvo que se pidan explícitamente.
  const ocultos = todosPartidos.filter((p) => p.estado === 'cancelado' && !p.ocupados && !p.en_espera).length;
  const partidos = verCancelados ? todosPartidos : todosPartidos.filter((p) => !(p.estado === 'cancelado' && !p.ocupados && !p.en_espera));
  const neg = db.getNegocio();
  const hoy = hoyLima();

  // Hora de Lima, para saber qué turno de HOY ya arrancó.
  const horaAhora = Number(new Date(Date.now() - 5 * 3600e3).toISOString().slice(11, 13));
  const yaEmpezo = (p) => p.fecha < hoy || (p.fecha === hoy && db.ordenHora(p.hora) <= horaAhora);

  const fila = (p) => {
    const z = ZONAS[p.zona];
    const pasado = yaEmpezo(p);
    const lleno = p.ocupados >= p.cupo;
    // "Lleno" se decía SOLO pintando el "12/14" de ámbar en vez de verde: con
    // daltonismo rojo-verde los dos son el mismo marrón, y a contraluz tampoco
    // se distinguen. Ahora la palabra está escrita y el chip trae su glifo.
    const chipCupos = lleno
      ? `<span class="est est-lleno">${p.ocupados}/${p.cupo} lleno</span>`
      : `<span class="est est-ok">${p.ocupados}/${p.cupo} · ${p.cupo - p.ocupados} libre${p.cupo - p.ocupados === 1 ? '' : 's'}</span>`;
    const abierto = p.estado === 'abierto' && !pasado;
    // Un partido cuya hora ya pasó seguía diciendo "Abierto" — nada lo cierra
    // solo, y el estado se imprimía crudo. A las 12pm la lista mostraba tres
    // turnos de la mañana como si todavía se pudiera entrar. El bot ya no los
    // ofrece (partidosAbiertos con vigentes), así que lo que faltaba era que
    // el panel lo dijera y diera el atajo para cerrarlo.
    const sinCerrar = p.estado === 'abierto' && pasado;
    const etiquetaEstado = sinCerrar ? 'Terminó — ciérralo' : (ESTADOS_PARTIDO[p.estado] || p.estado);
    return `<a class="lrow" href="/admin/leads?key=${key}&vista=partidos&partido=${p.id}">
      <span class="pfecha"><b>${esc(p.fecha.slice(8, 10))}</b><small>${esc(mesCorto(p.fecha))}</small></span>
      <span class="lbody">
        <span class="lname">${z ? z.nombre : esc(p.zona)}${p.hora ? ` · ${esc(p.hora)}` : ''}</span>
        <span class="lsub">${esc(p.sede || 'Sede por definir')} · S/ ${esc(p.precio ?? neg.zonas[p.zona]?.precio ?? '?')}</span>
        <span class="pchips">
          ${chipCupos}
          <span class="est ${abierto ? 'est-ok' : sinCerrar ? 'est-debe' : 'est-off'}">${esc(etiquetaEstado)}</span>
          ${p.pagados ? `<span class="est est-ok">${p.pagados} pagados</span>` : ''}
          ${p.en_espera ? `<span class="est est-debe">${p.en_espera} en espera</span>` : ''}
        </span>
      </span>
      ${SVG.chev}
    </a>`;
  };

  return baseHtml('Partidos · Pichangueros', `
    <div class="px">
      <div class="ltitle"><div><div class="eyebrow">Convocatorias</div><h2>Partidos</h2></div></div>

      <div class="shdr">Abrir partido nuevo <small>· 3 toques: zona, día y listo</small></div>
      <style>
        /* 44px de alto: son los tres primeros toques para abrir un partido. */
        .zbtn{flex:1;min-height:var(--tap);display:inline-flex;align-items:center;justify-content:center;
          text-align:center;padding:0 var(--s3);border:1.5px solid var(--line-strong);border-radius:var(--r2);
          background:var(--surface);font-family:var(--font-num);font-style:italic;font-weight:800;
          font-size:var(--t-l);letter-spacing:.04em;text-transform:uppercase;color:var(--ink-2);cursor:pointer}
        .zbtn:has(input:checked){background:var(--navy-fill);color:#fff;border-color:var(--navy-fill);box-shadow:var(--sombra)}
        .zbtn input{display:none}
        .qd{min-height:var(--tap);padding:0 var(--s4);border:1.5px solid var(--line-strong);border-radius:var(--r2);
          background:var(--surface);font:inherit;font-weight:700;font-size:var(--t-m);color:var(--ink);cursor:pointer}
        .qd.on{background:var(--lime);color:var(--on-lime);border-color:var(--lime)}
        /* El selector de cancha es un campo más: mismo tamaño que el resto. */
        #selSede{flex-basis:100%;min-height:var(--tap);font:inherit;font-size:var(--t-input);padding:0 var(--s3);
          border-radius:var(--r2);border:1px solid var(--line-strong);background:var(--surface-2);color:var(--ink)}
      </style>
      <div class="group">
        <form class="inline" method="post" action="/admin/partido">
          <input type="hidden" name="key" value="${esc(keyRaw)}">
          <label>¿Dónde?</label>
          <div style="display:flex;gap:8px;flex-basis:100%;flex-wrap:wrap">
            ${db.zonasOperativas().map((z, i) => `<label class="zbtn"><input type="radio" name="zona" value="${esc(z)}" ${i === 0 ? 'checked' : ''} onchange="pintaSedes('${esc(z)}')">${esc(db.nombreDeZona(z))}</label>`).join('')}
          </div>
          <select name="sede" id="selSede" onchange="cupoDeSede()"></select>
          <label>¿Cuándo?</label>
          <div style="display:flex;gap:8px;flex-basis:100%;align-items:center">
            <button type="button" class="qd on" onclick="setDia(this,'${hoy}')">Hoy</button>
            <button type="button" class="qd" onclick="setDia(this,'${fechaLima(1)}')">Mañana</button>
            <input name="fecha" id="fFecha" type="date" required min="${hoy}" value="${hoy}" style="flex:1;min-width:130px">
          </div>
          <div class="campos" style="flex-basis:100%">
            ${campo('fHora', 'Hora de inicio',
              '<input id="fHora" name="hora" type="time" step="1800" required>',
              'El turno dura una hora: si pones 8:00 pm, los jugadores ven "8-9pm".')}
            ${campo('fCupo', 'Cupo',
              '<input id="fCupo" name="cupo" type="number" min="2" max="60" inputmode="numeric" value="14">',
              'Se llena solo al elegir la cancha.')}
            ${campo('fPrecio', 'Precio por jugador',
              '<input id="fPrecio" name="precio" type="number" step="0.5" inputmode="decimal" placeholder="S/ auto">',
              'Vacío = el precio de la zona.')}
          </div>
          <button style="flex-basis:100%">⚽ Abrir partido — el bot empieza a llenarlo</button>
        </form>
      </div>
      <script>
        const SEDES = ${JSON.stringify(Object.fromEntries(
          db.zonasOperativas().map((z) => [z, db.listSedes(z).map((s) => ({ n: s.nombre, c: s.cupo || 14 }))])
        )).replace(/</g, '\\u003c')};
        function pintaSedes(z){
          const sel = document.getElementById('selSede');
          sel.innerHTML = (SEDES[z] || []).map(s => '<option value="' + s.n.replace(/"/g,'&quot;') + '" data-cupo="' + s.c + '">🏟 ' + s.n + ' (cupo ' + s.c + ')</option>').join('')
            + '<option value="" data-cupo="14">Otra cancha / por definir</option>';
          cupoDeSede();
        }
        function cupoDeSede(){
          const sel = document.getElementById('selSede');
          const c = sel.selectedOptions[0] && sel.selectedOptions[0].dataset.cupo;
          if (c) document.getElementById('fCupo').value = c;
        }
        function setDia(btn, d){
          document.getElementById('fFecha').value = d;
          document.querySelectorAll('.qd').forEach(b => b.classList.toggle('on', b === btn));
        }
        document.getElementById('fFecha').addEventListener('input', () =>
          document.querySelectorAll('.qd').forEach(b => b.classList.remove('on')));
        pintaSedes('brena');
      </script>

      <div class="shdr">Todos los partidos ${ocultos ? `<small>· <a style="color:var(--lime-ink)" href="/admin/leads?key=${key}&vista=partidos${verCancelados ? '' : '&cancelados=1'}">${verCancelados ? 'ocultar' : `ver ${ocultos}`} cancelado${ocultos === 1 ? '' : 's'} vacío${ocultos === 1 ? '' : 's'}</a></small>` : ''}</div>
      <div class="group">
        ${partidos.map(fila).join('') || '<p style="padding:14px;color:var(--ink-3);font-size:14px">Sin partidos todavía. Abre el primero arriba — el bot lo ofrece automáticamente a quien pida jugar.</p>'}
      </div>

      <div class="foot">⚽ Pichangueros · Partidos</div>
    </div>
  `, { refresh: false, activo: 'partidos', key, aviso: query });
}

function paginaPartidoDetalle(db, key, keyRaw, partidoId, query = {}) {
  const p = db.getPartido(partidoId);
  if (!p) return baseHtml('Partido · Pichangueros', `<div class="px"><p style="padding:20px">Partido no encontrado. <a href="/admin/leads?key=${key}&vista=partidos">Volver</a></p></div>`, { activo: 'partidos', key });

  const neg = db.getNegocio();
  const z = ZONAS[p.zona];
  const inscripciones = db.inscripcionesDe(partidoId);
  const activas = inscripciones.filter((i) => i.estado !== 'baja');
  const ocupados = inscripciones.filter((i) => ['pagado', 'reservado'].includes(i.estado)).length;
  const lista = db.textoLista(partidoId);
  const pagosSueltos = db.pagosSinPartido();

  // Texto seguro para meter dentro de un confirm('…') que vive en un atributo
  // HTML: primero se escapan las comillas simples para JS, después esc() para
  // el atributo (el &#39; resultante se decodifica a \' antes de evaluarse).
  const jsTxt = (t) => esc(String(t ?? '').replace(/\\/g, '\\\\').replace(/'/g, "\\'"));

  const accion = (i, estado, etiqueta, estilo = '', confirmar = '') => `
    <form method="post" action="/admin/inscripcion/estado" style="display:inline"${confirmar ? ` onsubmit="return confirm('${jsTxt(confirmar)}')"` : ''}>
      <input type="hidden" name="key" value="${esc(keyRaw)}"><input type="hidden" name="id" value="${i.id}"><input type="hidden" name="partido_id" value="${partidoId}"><input type="hidden" name="estado" value="${estado}">
      <button class="btn-fila" style="${estilo}">${etiqueta}</button>
    </form>`;
  // Marcado "Vino": lima con tinta NAVY (6.03:1). Con texto blanco daba 1.97:1 —
  // el botón que dice si alguien vino se leía peor que el que no lo dice.
  const btnAsist = (i, valor, etiqueta, on) => `
    <form method="post" action="/admin/inscripcion/asistencia" style="display:inline">
      <input type="hidden" name="key" value="${esc(keyRaw)}"><input type="hidden" name="id" value="${i.id}"><input type="hidden" name="partido_id" value="${partidoId}"><input type="hidden" name="valor" value="${i.asistencia === valor ? '' : valor}">
      <button class="btn-fila" style="${on
        ? (valor === 'si' ? 'background:var(--lime);color:var(--on-lime)' : 'background:var(--st-alerta-solid);color:#fff')
        : 'background:var(--surface-2);color:var(--ink-2);border:1.5px solid var(--line-strong)'}">${etiqueta}</button>
    </form>`;

  /**
   * Fila de inscrito.
   *
   * Dos cambios de seguridad: la fila lleva id (el POST de asistencia vuelve
   * con #insc-N, porque pasar lista son 14 toques seguidos parado en la cancha
   * y cada uno devolvía arriba de todo), y "Baja" —que libera el cupo, promueve
   * al primero de la espera y dispara un WhatsApp, sin deshacer— sale del
   * amontonamiento de botones: va apartada a la derecha y pregunta antes.
   */
  // El estado de cada inscrito (Pagado / Reservado / En espera) estaba en 12px
  // gris tenue (2.94:1) — siendo el dato principal de esta pantalla. Ahora es un
  // badge con relleno, borde y tinta que pasan 4.5:1.
  const chipInsc = { pagado: 'b-done', reservado: 'b-new', espera: 'b-wait', baja: 'b-new' };
  const filaInsc = (i) => {
    const nombre = i.nombre || i.lead_nombre || (i.numero ? `+${i.numero}` : '¿?');
    const puedeMarcar = p.estado === 'jugado' || p.fecha <= hoyLima();
    return `<div class="finsc ancla" id="insc-${i.id}">
      <div style="flex:1;min-width:140px">
        <div style="font-weight:700;font-size:var(--t-m)">${i.numero ? `<a href="/admin/leads?key=${key}&numero=${i.numero}">${esc(nombre)}</a>` : esc(nombre)}</div>
        <div style="margin-top:5px">
          <span class="badge ${chipInsc[i.estado] || 'b-new'}">${esc(ESTADOS_INSC[i.estado] || i.estado)}</span>
          ${i.pago_id ? `<span class="badge b-new">pago #${i.pago_id}</span>` : ''}
        </div>
      </div>
      ${i.estado !== 'baja' ? `
      <div class="finsc-acc">
        ${i.estado !== 'pagado' ? accion(i, 'pagado', '💰 Pagó', 'background:var(--st-ok-bg);color:var(--st-ok-ink);border:1.5px solid var(--st-ok-ink)') : ''}
        ${i.estado === 'espera' ? accion(i, 'reservado', '⬆ Subir', 'background:var(--surface-2);color:var(--ink-2);border:1.5px solid var(--line-strong)') : ''}
        ${puedeMarcar ? `${btnAsist(i, 'si', '✔ Vino', i.asistencia === 'si')}${btnAsist(i, 'no', '✘ Faltó', i.asistencia === 'no')}` : ''}
      </div>
      <div class="finsc-peligro">
        ${accion(i, 'baja', '🗑 Baja', 'background:var(--st-alerta-bg);color:var(--st-alerta-ink);border:1.5px solid var(--st-alerta-ink)',
          `¿Dar de baja a ${nombre}? Libera su cupo y sube al primero de la lista de espera. No se puede deshacer con un botón.`)}
      </div>` : ''}
    </div>`;
  };

  const cambioEstado = (estado, etiqueta, clase, confirmar = '') => `
    <form method="post" action="/admin/partido/estado" style="display:inline"${confirmar ? ` onsubmit="return confirm('${jsTxt(confirmar)}')"` : ''}>
      <input type="hidden" name="key" value="${esc(keyRaw)}"><input type="hidden" name="id" value="${partidoId}"><input type="hidden" name="estado" value="${estado}">
      <button class="btn-toque" style="font-size:13px;${clase}">${etiqueta}</button>
    </form>`;

  // La caja del partido (propuesta v2): la pantalla mostraba cuánta gente hay,
  // no si el partido deja algo. La cuenta que Clarck hace de memoria antes de
  // cada pichanga —cobrado, lo que falta, la cancha— ahora está a la vista.
  const k = db.cajaPartido(partidoId) || { cobrado: 0, porCobrar: 0, porPagar: 0, costoCancha: null, precio: 0 };
  const soles = (n) => `S/ ${Number(n || 0).toLocaleString('es-PE', { maximumFractionDigits: 2 })}`;
  const pct = p.cupo ? Math.min(100, Math.round((ocupados / p.cupo) * 100)) : 0;
  const queda = k.costoCancha != null ? k.cobrado - k.costoCancha : null;

  // Rótulos a 12px (eran 10.5) y en --on-navy-2 (8.36:1 sobre el navy): esta
  // caja es lo que Clarck mira de noche, en la cancha, antes de cobrar.
  const dato = (rot, val, color = 'var(--on-navy)') => `
    <div style="flex:1;min-width:104px;padding:11px 12px;background:rgba(255,255,255,.09);border-radius:var(--r2)">
      <div style="font-size:var(--t-xs);letter-spacing:.11em;text-transform:uppercase;color:var(--on-navy-2);font-weight:700">${rot}</div>
      <div class="num" style="font-size:var(--t-2xl);line-height:1.15;color:${color};margin-top:3px;overflow-wrap:anywhere">${val}</div>
    </div>`;

  // El "amarillo = lleno" de la barra era la única señal de que ya no entra
  // nadie. Ahora el porcentaje va escrito al lado de la barra.
  const lleno = pct >= 100;
  const caja = `
    <div class="marcador" style="margin:-2px 0 14px">
      <div style="font-size:var(--t-s);color:var(--on-navy-2);font-weight:600">
        ${esc(p.sede || 'Sede por definir')} · ${esc(p.hora || 'hora por definir')} · ${soles(k.precio)} por jugador
      </div>
      <div style="display:flex;align-items:baseline;gap:10px;margin-top:8px;flex-wrap:wrap">
        <div class="num" style="font-size:var(--n-m);color:var(--on-navy)">${ocupados}/${p.cupo}</div>
        <div style="font-size:var(--t-s);color:var(--on-navy-2);font-weight:600">cupos ocupados${activas.length - ocupados > 0 ? ` · ${activas.length - ocupados} en espera` : ''}</div>
      </div>
      <div style="display:flex;align-items:center;gap:11px;margin:10px 0 14px">
        <div style="flex:1;height:10px;border-radius:var(--rp);background:rgba(255,255,255,.20);overflow:hidden">
          <div style="height:100%;width:${pct}%;border-radius:var(--rp);background:${lleno ? 'var(--st-debe-ink)' : 'var(--lime)'}"></div>
        </div>
        <div style="flex:0 0 auto;font-size:var(--t-s);font-weight:700;color:${lleno ? 'var(--on-navy-debe)' : 'var(--on-navy-2)'};font-variant-numeric:tabular-nums">${lleno ? 'LLENO' : `${pct}%`}</div>
      </div>
      <div style="display:flex;gap:9px;flex-wrap:wrap">
        ${dato('Cobrado', soles(k.cobrado), 'var(--on-navy-ok)')}
        ${dato('Por cobrar', soles(k.porCobrar), k.porCobrar > 0 ? 'var(--on-navy-debe)' : 'var(--on-navy)')}
        ${k.costoCancha != null
          ? dato('Cancha', soles(k.costoCancha))
          : `<a href="/admin/leads?key=${key}&vista=config" style="flex:1;min-width:104px;min-height:var(--tap);padding:11px 12px;background:rgba(255,255,255,.09);border-radius:var(--r2);text-decoration:none;display:block">
              <div style="font-size:var(--t-xs);letter-spacing:.11em;text-transform:uppercase;color:var(--on-navy-2);font-weight:700">Cancha</div>
              <div style="font-size:var(--t-s);color:var(--on-navy);font-weight:700;margin-top:5px">Poner costo ›</div>
            </a>`}
      </div>
      ${queda != null ? `<div style="margin-top:11px;font-size:var(--t-m);font-weight:700;color:${queda >= 0 ? 'var(--on-navy-ok)' : 'var(--on-navy-debe)'}">
        ${queda >= 0 ? `Queda ${soles(queda)} después de pagar la cancha` : `Faltan ${soles(-queda)} para cubrir la cancha`}
      </div>` : ''}
    </div>`;

  // El aviso de resultado ahora lo pinta baseHtml (mismo banner en todas las
  // vistas). Acá solo interesa si hubo error, para dejar el editor ABIERTO:
  // un rechazo con el editor plegado esconde justo el campo que hay que
  // corregir.
  const esError = query.err === '1';

  // Editor plegado. <details> nativo: se expande al tocar "Editar", no necesita
  // JS y el navegador ya sabe hacerlo accesible con teclado.
  const sedesDeZona = db.listSedes(p.zona);
  const editor = `
    <details class="editor ancla" id="editor" ${esError ? 'open' : ''} style="margin-bottom:14px">
      <summary style="list-style:none;cursor:pointer;display:flex;align-items:center;gap:10px;padding:14px;
        min-height:var(--tap);border:1px solid var(--line);border-radius:var(--r3);background:var(--surface);
        font-weight:700;font-size:var(--t-m)">
        <span style="font-size:18px">✏️</span>
        <span style="flex:1">Editar este partido</span>
        <span style="font-size:var(--t-xs);color:var(--ink-2);font-weight:600">hora · sede · cupo · precio · fecha</span>
      </summary>
      <div class="group" style="margin-top:10px;padding:4px 0">
        <form method="post" action="/admin/partido/editar">
          <input type="hidden" name="key" value="${esc(keyRaw)}"><input type="hidden" name="id" value="${partidoId}">

          ${/* Los campos del editor usan .campos/.campo (16px, 44px, label
                visible) como el resto del panel: eran cajas de 15px con la
                etiqueta en MAYÚSCULAS a 12.5px y gris tenue. */ ''}
          <div class="campos" style="padding-top:14px">
            <div class="campo campo-ancho">
              <label for="ed-sede">Cancha</label>
              <select id="ed-sede" name="sede">
                ${sedesDeZona.map((s) => `<option value="${esc(s.nombre)}" ${s.nombre === p.sede ? 'selected' : ''}>🏟 ${esc(s.nombre)}</option>`).join('')}
                <option value="" ${!p.sede || !sedesDeZona.some((s) => s.nombre === p.sede) ? 'selected' : ''}>Otra cancha / por definir</option>
              </select>
            </div>
            <div class="campo">
              <label for="ed-fecha">Día</label>
              <input id="ed-fecha" name="fecha" type="date" value="${esc(p.fecha)}">
            </div>
            <div class="campo">
              <label for="ed-hora">Hora</label>
              <input id="ed-hora" name="hora" type="time" step="1800" value="${esc(db.horaInput(p.hora))}">
            </div>
            <div class="campo">
              <label for="ed-cupo">Cupo</label>
              <input id="ed-cupo" name="cupo" type="number" min="${Math.max(2, ocupados)}" max="60" value="${p.cupo}">
              <small>${ocupados ? `No puede bajar de ${ocupados} (los que ya están)` : 'Nadie inscrito todavía'}</small>
            </div>
            <div class="campo">
              <label for="ed-precio">Precio</label>
              <input id="ed-precio" name="precio" type="number" step="0.5" value="${p.precio ?? ''}" placeholder="S/ ${esc(neg.zonas[p.zona]?.precio ?? '')}">
              <small>Vacío = el de ${esc(z ? z.nombre : p.zona)}</small>
            </div>
          </div>

          <div style="padding:0 14px 14px">
            <button class="btn-toque btn-guardar" style="width:100%;min-height:var(--tap-lg);font-size:var(--t-l)">
              Guardar cambios
            </button>
            <div style="font-size:var(--t-s);color:var(--ink-2);margin-top:9px;text-align:center">
              Los ${activas.length} inscritos se mantienen. El bot usa estos datos al responder.
            </div>
          </div>
        </form>
      </div>
    </details>
    <style>
      .editor summary::-webkit-details-marker{display:none}
      .editor[open] summary{border-bottom-left-radius:0;border-bottom-right-radius:0;background:var(--surface-2)}
      .editor summary:hover{background:var(--surface-2)}
    </style>`;

  return baseHtml(`Partido ${p.fecha} · Pichangueros`, `
    <div class="px">
      <div class="ltitle">
        <div>
          <div class="eyebrow"><a href="/admin/leads?key=${key}&vista=partidos" style="color:inherit">← Partidos</a> · ${z ? z.nombre : esc(p.zona)}</div>
          <h2>${esc(fechaCompacta(p.fecha, true, false))}</h2>
        </div>
        <span style="display:flex;gap:6px;align-items:center;flex-wrap:wrap;justify-content:flex-end">
          ${/* "HOY" iba en blanco sobre el ámbar claro (2.44:1). Ahora los tres
                badges son relleno oscuro con blanco encima, todos sobre 5:1. */ ''}
          ${p.fecha === hoyLima() ? '<span class="badge b-zona" style="background:var(--st-debe-solid)">HOY</span>'
            : p.fecha === fechaLima(1) ? '<span class="badge b-zona" style="background:var(--navy-9)">MAÑANA</span>' : ''}
          <span class="badge b-zona" style="background:${p.estado === 'abierto' ? 'var(--st-ok-solid)' : 'var(--st-off-solid)'}">${esc(ESTADOS_PARTIDO[p.estado] || p.estado)}</span>
        </span>
      </div>
      ${caja}

      ${editor}

      <div style="display:flex;gap:var(--s2);flex-wrap:wrap;align-items:center;margin-bottom:var(--s3)">
        ${p.estado === 'abierto' ? cambioEstado('cerrado', '🔒 Cerrar inscripción', 'background:var(--surface-2);color:var(--ink);border:1.5px solid var(--line-strong)') : cambioEstado('abierto', '🔓 Reabrir', 'background:var(--st-ok-bg);color:var(--st-ok-ink);border:1.5px solid var(--st-ok-ink)')}
        ${p.estado !== 'jugado' ? cambioEstado('jugado', '✅ Marcar jugado', 'background:var(--st-ok-bg);color:var(--st-ok-ink);border:1.5px solid var(--st-ok-ink)') : ''}
      </div>

      ${/* Lo destructivo va en su propia fila, separado por 24px y una línea:
           antes "✖ Cancelar" y "🗑 Eliminar" compartían fila con "Cerrar" y
           "Marcar jugado", y en 360px eso envuelve — el botón que saca el
           partido de la parrilla del bot terminaba justo debajo del dedo. */ ''}
      ${(p.estado !== 'cancelado' || !inscripciones.length) ? `
      <div class="acc-peligro" style="margin-bottom:16px">
        ${p.estado !== 'cancelado' ? cambioEstado('cancelado', '✖ Cancelar', 'background:var(--st-alerta-bg);color:var(--st-alerta-ink);border:1.5px solid var(--st-alerta-ink)',
          `¿CANCELAR el partido del ${db.fechaBonita(p.fecha, { relativa: false })}? ${activas.length ? `Hay ${activas.length} inscritos y nadie recibe aviso automático: tienes que avisarles tú.` : 'No hay nadie inscrito.'}`) : ''}
        ${!inscripciones.length ? `
        <form method="post" action="/admin/partido/eliminar" style="display:inline" onsubmit="return confirm('¿Eliminar este partido? Solo se puede porque no tiene a nadie inscrito.')">
          <input type="hidden" name="key" value="${esc(keyRaw)}"><input type="hidden" name="id" value="${partidoId}">
          <button class="btn-toque" style="font-size:var(--t-s);background:var(--st-alerta-bg);color:var(--st-alerta-ink);border:1.5px solid var(--st-alerta-ink)">🗑 Eliminar (está vacío)</button>
        </form>` : ''}
      </div>` : ''}

      <div class="shdr ancla" id="inscritos">Inscritos (${activas.length})</div>
      <div class="group">
        ${activas.map(filaInsc).join('') || '<p style="padding:14px;color:var(--ink-3);font-size:14px">Nadie inscrito aún.</p>'}
        <form class="inline" method="post" action="/admin/partido/inscribir" style="padding-top:10px">
          <input type="hidden" name="key" value="${esc(keyRaw)}"><input type="hidden" name="partido_id" value="${partidoId}">
          <input name="numero" placeholder="Número WhatsApp (o vacío)" style="max-width:200px">
          <input name="nombre" placeholder="Nombre (para invitados)" style="max-width:200px">
          <button>+ Inscribir a mano</button>
        </form>
      </div>

      ${pagosSueltos.length ? `
      <div class="shdr ancla" id="pagos-sueltos">Pagos confirmados sin partido <small>(asignar a este partido)</small></div>
      <div class="group">
        ${pagosSueltos.map((pg) => `
          <form method="post" action="/admin/pago/asignar" style="display:flex;align-items:center;gap:10px;padding:10px 14px;border-bottom:1px solid var(--line)">
            <input type="hidden" name="key" value="${esc(keyRaw)}"><input type="hidden" name="pago_id" value="${pg.id}"><input type="hidden" name="partido_id" value="${partidoId}">
            <div style="flex:1;min-width:0;font-size:var(--t-m)"><b>${esc(pg.nombre || `+${pg.numero}`)}</b> · S/ ${esc(pg.monto)} ${pg.cupos > 1 ? `(${pg.cupos} cupos)` : ''} · ${horaCorta(pg.creado_en)}</div>
            <button class="btn-fila" style="background:var(--st-ok-bg);color:var(--st-ok-ink);border:1.5px solid var(--st-ok-ink)">Asignar acá</button>
          </form>`).join('')}
      </div>` : ''}

      <div class="shdr">Lista para el grupo <small>(el bot la arma, tú la pegas)</small></div>
      <div class="group" style="padding:14px">
        ${/* 16px: al enfocar el textarea (aunque sea readonly) iOS ampliaba la
              página. La altura sube en proporción para que sigan entrando las
              mismas líneas. */ ''}
        <textarea id="lista" readonly style="width:100%;min-height:${Math.min(480, 100 + (p.cupo + 4) * 26)}px;font:var(--t-input)/1.6 var(--font-mono,ui-monospace,monospace);border:1px solid var(--line-strong);border-radius:var(--r2);padding:12px;background:var(--surface-2);color:var(--ink);resize:vertical">${esc(lista)}</textarea>
        ${/* Tinta navy sobre lima (6.03:1). En blanco daba 1.97:1 — y este es EL
              botón de la pantalla: el que Clarck toca antes de cada pichanga. */ ''}
        <button class="btn-toque btn-guardar" onclick="navigator.clipboard.writeText(document.getElementById('lista').value).then(()=>{this.textContent='✅ Copiada'; setTimeout(()=>this.textContent='📋 Copiar lista',1500)})"
          style="margin-top:10px;width:100%;min-height:var(--tap-lg);font-size:var(--t-l)">📋 Copiar lista</button>
      </div>

      <div class="foot">⚽ Pichangueros · Partido #${partidoId}</div>
    </div>
  `, { refresh: false, activo: 'partidos', key, aviso: query });
}

// ==============================================================================
//  Conexión — estado de WhatsApp, número enlazado, QR en vivo, desconectar
// ==============================================================================
function paginaConexion(key, conexion) {
  const keyRaw = decodeURIComponent(key);
  const estado = conexion ? conexion.estado() : 'desconocido';
  const numero = conexion ? conexion.numero() : null;
  const qr = conexion ? conexion.qr() : null;
  const conectado = estado === 'ready';

  // Refresco automático: rápido mientras se muestra el QR (cambia cada ~20s),
  // lento cuando ya está conectado (solo para reflejar cambios de estado).
  const refresh = conectado ? 30 : 6;

  const cuerpo = conectado
    ? `<div class="group" style="text-align:center;padding:26px 20px">
         <div style="font-size:40px;line-height:1">✅</div>
         <div style="font-size:19px;font-weight:800;margin-top:8px">Conectado a WhatsApp</div>
         <div style="font-size:15px;color:var(--ink-2);margin-top:4px">Número enlazado</div>
         <div style="font-size:26px;font-weight:800;font-family:var(--font-num);letter-spacing:.02em;margin-top:2px">
           ${numero ? `+${esc(numero)}` : 'no disponible'}</div>
       </div>
       <div class="shdr">Cambiar de número / desconectar</div>
       <div class="group" style="padding:16px">
         <p style="font-size:13.5px;color:var(--ink-2);line-height:1.45;margin-bottom:14px">
           Al desconectar, el bot cierra la sesión actual y muestra un código QR nuevo acá mismo.
           Para enlazar OTRO número, desconecta y escanea el nuevo QR desde ese WhatsApp
           (Ajustes → Dispositivos vinculados → Vincular dispositivo). Mientras tanto el bot no
           responde a nadie.</p>
         <form method="post" action="/admin/conexion/desconectar"
               onsubmit="return confirm('¿Desconectar el bot de WhatsApp? Dejará de responder hasta que escanees un QR nuevo.')">
           <input type="hidden" name="key" value="${esc(keyRaw)}">
           <button class="btn-rojo" style="width:100%;border:none;border-radius:12px;color:#fff;padding:13px;font:inherit;font-weight:700;font-size:14px">
             🔌 Desconectar / cambiar número</button>
         </form>
       </div>`
    : `<div class="banner px" style="margin:0 0 14px"><div class="bic">📴</div>
         <div class="btxt"><b>El bot no está conectado.</b> ${estado === 'qr' || qr ? 'Escanea el código de abajo para enlazar un número.' : 'Reconectando… en unos segundos aparecerá el código QR.'}</div></div>
       <div class="group" style="text-align:center;padding:22px 20px">
         ${qr
           ? `<img src="${qr}" alt="Código QR de WhatsApp" style="width:280px;max-width:82vw;height:auto;border-radius:12px"/>
              <div style="font-size:13.5px;color:var(--ink-2);margin-top:12px;line-height:1.45">
                Desde el WhatsApp que quieres enlazar:<br><b>Ajustes → Dispositivos vinculados → Vincular dispositivo</b><br>
                y apunta la cámara a este código.</div>`
           : `<div style="font-size:34px">⏳</div>
              <div style="font-size:15px;color:var(--ink-2);margin-top:8px">Generando código QR… esta página se actualiza sola.</div>`}
       </div>`;

  return baseHtml('Conexión · Pichangueros', `
    <div class="px">
      <div class="ltitle"><div><div class="eyebrow">WhatsApp</div><h2>Conexión</h2></div>
        <span class="live" style="${conectado ? '' : 'background:var(--st-debe-bg);color:var(--st-debe-ink)'}">
          <i style="${conectado ? '' : 'background:var(--st-debe-solid)'}"></i> ${conectado ? 'En vivo' : esc(estado)}</span></div>
      ${cuerpo}
      <div class="foot">⚽ Pichangueros · Conexión${conexion ? '' : ' (no disponible)'}</div>
    </div>
  `, { refresh, activo: 'conexion', key });
}

module.exports = { registrarPanel, paginaResumen, paginaCRM, paginaFicha, paginaConfig, paginaConexion };
