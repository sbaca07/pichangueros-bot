/**
 * Panel CRM (Semana 3 · rediseño iOS 2026-06-29) — "del marcador a la cancha".
 *
 * Tres vistas, estética iOS (claro, Inter + Barlow Condensed, acento verde
 * #A3C614 = verde de sistema y de cancha):
 *   Resumen → dashboard de data (marcador-estadio, métricas, crecimiento, zonas)
 *   CRM     → lista de leads con la cola "sin responder" al frente
 *   Ficha   → perfil + línea de valor + etiquetas + notas + chat
 *
 * Desde el 16/08 no hay "pipeline": la relación (Nuevo/Probó/Vuelve/Casero) y
 * la frescura (Al día/Enfriándose/Perdido) se DERIVAN de los pagos, los
 * partidos y los mensajes en cada carga. No hay botones de etapa que apretar.
 *
 * Rutas (todas con ?key=ADMIN_KEY; sin key → 404):
 *   GET  /admin/leads                  → Resumen (dashboard)
 *   GET  /admin/leads?vista=crm        → lista CRM (con filtros/búsqueda)
 *   GET  /admin/leads?numero=N         → ficha de contacto
 *   GET  /admin/leads.csv              → export CSV
 *   GET  /admin/leads.xlsx             → export Excel (con marca, colores, autofiltro)
 *   GET  /admin/backup-db              → descarga el .db completo (backup manual)
 *   POST /admin/lead/grupo             → anota que ya se le mandó el link del grupo
 *   POST /admin/lead/reactivar         → saca del handoff (el bot vuelve a atender)
 *   POST /admin/lead/etiquetas         → guarda etiquetas (separadas por coma)
 *   POST /admin/lead/nota              → agrega una nota al historial
 */
const sheetsync = require('./sheetsync');
const backup = require('./backup');
const { buildLeadsWorkbook } = require('./excel');

const esc = (v) =>
  String(v ?? '—').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

/**
 * COLORES de zona. SOLO colores.
 *
 * Este mapa también tenía los NOMBRES escritos a mano, y eran los que pintaba
 * el panel — mientras el bot y el Sheet usan db.nombreDeZona(), que los lee de
 * Config. Renombrar "Breña" desde Ajustes cambiaba lo que decía el bot y no lo
 * que decía el panel, y un distrito nuevo salía con su slug crudo ("sanborja").
 * El nombre pasa SIEMPRE por nombreDeZona; acá queda lo único que no vive en la
 * BD: el color.
 *
 * Todos llevan texto BLANCO encima (badges, puntos, barras), así que todos
 * tienen que pasar 4.5:1 contra blanco. El lima del logo (#A3C614) daba 1.97:1
 * — "Breña" en blanco sobre lima era ilegible a contraluz; acá va la versión
 * oscura del mismo verde, que sigue leyéndose como la marca.
 */
const ZONAS = {
  brena: { color: '#5F7A0A' },      // 4.91:1
  comas: { color: '#16385F' },      // 11.90:1
  rimac: { color: '#0A6570' },      // 6.76:1
  chorrillos: { color: '#7A3A99' }, // 7.26:1
  otra: { color: '#4F5B6B' },       // 6.91:1
};
// Color para zonas creadas después de este mapa (nuevos distritos).
const colorZona = (z) => ZONAS[z]?.color || '#4A6B2E'; // 6.12:1
// Slug de zona a partir del nombre que escribe Clarck ("San Miguel" → sanmiguel).
const slugZona = (nombre) => (nombre || '')
  .toLowerCase().normalize('NFD').replace(/[̀-ͯ]/g, '')
  .replace(/[^a-z]/g, '').slice(0, 24);

/**
 * RELACIÓN y FRESCURA — los dos ejes que reemplazaron a la escalera de etapas
 * (16/08). Acá vive solo cómo se PINTAN; qué son y cómo se calculan está en
 * db.js (metricasPorNumero / relacionDe / frescuraDe).
 *
 * La escalera anterior (nuevo → datos_completos → invitado_grupo → activo →
 * lista_espera → inactivo) mezclaba "cuánto sabemos de alguien" con "qué tan
 * cliente es" en una sola columna, y por eso mentía: quien pagaba tres veces
 * sin registrarse figuraba "Nuevo", y 510 contactos que dejaron sus datos y
 * nunca pagaron figuraban por encima de él. Además había que mantenerla a
 * mano. Estos dos ejes se derivan de los hechos en cada carga: no hay botón
 * que apretar y no se pueden desactualizar.
 */
const COLOR_RELACION = { nuevo: 'b-new', probo: 'b-new', vuelve: 'b-mid', casero: 'b-done' };
/** Badge de relación: SIEMPRE presente y siempre en la misma posición, con el
 *  número de visitas al lado — dos filas del CRM se pueden comparar de reojo. */
const badgeRelacion = (db, m) => {
  const clave = db.relacionDe(m.visitas);
  const etiqueta = db.RELACIONES[clave].label;
  return `<span class="badge ${COLOR_RELACION[clave]}">${clave === 'casero' ? '⭐ ' : ''}${etiqueta}${m.visitas ? ` · ${m.visitas}` : ''}</span>`;
};
// El que se está enfriando es el que TODAVÍA se recupera → ámbar (hay algo que
// hacer). El perdido ya se fue → gris: es información, no una tarea de hoy.
const COLOR_FRESCURA = { al_dia: 'b-done', enfriando: 'b-wait', perdido: 'b-new' };

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
// El reloj de Lima vive en db.js (ahoraLima): acá solo se le pone nombre local.
// Antes había una copia con su propio .slice() en cada archivo, y la de la hora
// se quedaba solo con las horas ENTERAS — por eso un turno de 8:30 se dejaba de
// ofrecer a las 8:00.
// modoSeguro/numerosDePrueba salen de la MISMA fuente que usa el bot (BD, con
// la env var como valor inicial): si el panel leyera el entorno y el bot la BD,
// apagar el bot desde Ajustes dejaría al panel diciendo que sigue encendido.
const { ahoraLima, fechaLima, modoSeguro: modoSeguroOn, numerosDePrueba: testersPanel } = require('./db');
const hoyLima = () => ahoraLima().fecha;
// Timestamp Lima de hace N horas (mismo formato 'YYYY-MM-DD HH:MM:SS' de la BD).
const limaHace = (horas) => new Date(Date.now() - 5 * 3600e3 - horas * 3600e3).toISOString().slice(0, 19).replace('T', ' ');
// "Sin responder" REAL: el último mensaje es del contacto Y es reciente (48 h).
// Y en MODO SEGURO el bot calla a propósito con todos menos los testers: esos
// silenciados NO "necesitan respuesta" — están siendo capturados por diseño.
// Mostrarlos como deuda pintaba 124 pendientes falsos en el CRM.
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

  /**
   * "Le mandé el link del grupo" — el ÚNICO botón de mantenimiento que quedó.
   *
   * Reemplaza a los seis botones de etapa. Sobrevivió porque es el único hecho
   * que ningún dato de la BD puede reconstruir: cuando Clarck suma a alguien al
   * grupo desde su celular, en el sistema no queda rastro. Todo lo demás
   * (relación, frescura, si tiene datos) sale de los pagos, los partidos y las
   * columnas del contacto, y por eso ya no se toca a mano.
   */
  app.post('/admin/lead/grupo', (req, res) => {
    if (!autorizado(req, res)) return;
    const numero = numeroDe(req);
    const marcado = db.marcarGrupoEnviado(numero);
    volverAFicha(req, res, marcado
      ? `Anotado: a ${nombreLead(numero)} ya se le mandó el link del grupo.`
      : `A ${nombreLead(numero)} ya estaba anotado como que recibió el link.`, 'grupo');
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
  // La columna "estado" salió del export: quedó congelada el 16/08 y exportarla
  // sería repartir un dato que ya no se escribe. En su lugar van los tres que
  // sí se leen hoy: relación, visitas y cuándo vino por última vez.
  app.get('/admin/leads.csv', (req, res) => {
    if (!autorizado(req, res)) return;
    const met = db.metricasPorNumero();
    const filas = db.listLeads().map((l) => {
      const m = met[l.numero] || { visitas: 0, ultima: null, pagos: 0, soles: 0 };
      return [
        l.numero, l.nombre, l.edad, l.distrito, l.zona,
        db.RELACIONES[db.relacionDe(m.visitas)].label, m.visitas, m.ultima, m.soles,
        l.grupo_enviado_en, l.handoff, l.handoff_motivo, l.etiquetas, l.creado_en,
      ].map((v) => `"${String(v ?? '').replace(/"/g, '""')}"`).join(',');
    });
    res.set('Content-Type', 'text/csv; charset=utf-8');
    res.set('Content-Disposition', 'attachment; filename="pichangueros-leads.csv"');
    res.send(['numero,nombre,edad,distrito,zona,relacion,visitas,ultima_vez,soles,grupo_enviado_en,handoff,handoff_motivo,etiquetas,creado_en', ...filas].join('\n'));
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

  // ==========================================================================
  //  AUTOGESTIÓN — los interruptores que vivían en Render
  // ==========================================================================
  /** Quién tocó el interruptor. No hay login: lo más honesto que tenemos es
   *  "desde el panel" + la IP desde la que se apretó. */
  const quienEs = (req) => `panel (${(req.headers['x-forwarded-for'] || req.ip || '?').toString().split(',')[0].trim()})`;

  /**
   * ENCENDER / APAGAR EL BOT.
   *
   * La asimetría está en el diseño, no en el texto: apagar es un botón y listo
   * (es la salida de emergencia, tiene que costar cero); encender pide escribir
   * la palabra ENCENDER y tildar el ensayo previo. Escribir cuesta intención;
   * un checkbox o un confirm() se despachan con el pulgar sin leer.
   *
   * Se valida en el SERVIDOR, no en el navegador: sin JS un confirm() no corre,
   * y este es el POST que le habla a 900 personas.
   */
  app.post('/admin/config/bot', (req, res) => {
    if (!autorizado(req, res)) return;
    const contactos = db.stats().leads;
    if (req.body.accion === 'apagar') {
      db.setBotEncendido(false, quienEs(req));
      return volverAConfig(req, res, 'Bot APAGADO. Sigue registrando todo lo que llegue, pero no le responde a nadie (salvo a los números de prueba).', 'bot');
    }
    const escrito = String(req.body.confirmacion || '').trim().toUpperCase();
    if (escrito !== 'ENCENDER') {
      return volverAConfig(req, res,
        `Para encender el bot escribe la palabra ENCENDER en el campo. No es un trámite: a partir de ese momento les responde solo a los ${contactos} contactos registrados.`,
        'bot', true);
    }
    // El ensayo previo no es burocracia: es lo único que separa "probé y anda"
    // de "que salga y vemos". Los tres tildes van al servidor.
    const faltan = [
      req.body.ensayo_prueba ? null : 'probar el bot con tu propio número',
      req.body.ensayo_bienvenida ? null : 'leer el mensaje de bienvenida',
      req.body.ensayo_mecanica ? null : 'leer la mecánica que explica el bot',
    ].filter(Boolean);
    if (faltan.length) {
      return volverAConfig(req, res, `Antes de encenderlo falta: ${faltan.join(' · ')}. Tíldalos cuando lo hayas hecho.`, 'bot', true);
    }
    db.setBotEncendido(true, quienEs(req));
    volverAConfig(req, res, `Bot ENCENDIDO. Desde ahora responde a cualquiera de los ${contactos} contactos que escriba. Si algo sale mal, lo apagas de un toque desde el Resumen.`, 'bot');
  });

  // Apagar desde el Resumen: un toque, sin fricción y sin salir de la pantalla
  // donde uno se dio cuenta de que algo anda mal.
  app.post('/admin/bot/apagar', (req, res) => {
    if (!autorizado(req, res)) return;
    db.setBotEncendido(false, quienEs(req));
    volver(res, { key: req.body.key, aviso: 'Bot APAGADO. Deja de responderle a todos; lo que llegue se sigue registrando.' });
  });

  /** A qué número van los avisos + qué números son de prueba. */
  app.post('/admin/config/avisos', (req, res) => {
    if (!autorizado(req, res)) return;
    const cambios = [];
    if (req.body.notify_numero !== undefined) {
      const antes = db.numeroAvisos();
      const ahora = db.setNumeroAvisos(req.body.notify_numero);
      if (ahora !== antes) cambios.push(ahora ? `los avisos van al +${ahora} (probalo con el botón de abajo)` : 'sin número de avisos: solo llegan por correo');
    }
    if (req.body.testers !== undefined) {
      const lista = db.setNumerosDePrueba(req.body.testers);
      cambios.push(lista.length ? `${lista.length} número${lista.length === 1 ? '' : 's'} de prueba` : 'sin números de prueba');
    }
    volverAConfig(req, res, cambios.length ? `Guardado: ${cambios.join(' · ')}.` : 'No cambiaste nada.', 'avisos');
  });

  /**
   * PROBAR el número de avisos — mandarle un mensaje de verdad.
   *
   * Un número mal tipeado no falla: simplemente nunca llega nada, y eso no se
   * nota hasta que se pierde un handoff con plata adentro. Acá sale un mensaje
   * real y se guarda si funcionó; mientras no haya una prueba exitosa, Ajustes
   * y el Resumen lo dicen.
   */
  app.post('/admin/config/avisos/probar', async (req, res) => {
    if (!autorizado(req, res)) return;
    const numero = db.numeroAvisos();
    if (!numero) return volverAConfig(req, res, 'Primero guarda el número al que quieres que lleguen los avisos.', 'avisos', true);
    if (!conexion || !conexion.enviar) return volverAConfig(req, res, 'El canal de WhatsApp no está disponible ahora mismo.', 'avisos', true);
    const r = await conexion.enviar(numero,
      '🔔 Prueba de Pichangueros: si estás leyendo esto, los avisos del bot (derivados, pagos por revisar, listas de espera) te van a llegar acá.');
    if (r && r.ok) {
      db.marcarAvisosProbado();
      return volverAConfig(req, res, `Mensaje enviado al +${numero}. Revísalo en tu WhatsApp: si no llegó, el número está mal.`, 'avisos');
    }
    volverAConfig(req, res, `No se pudo enviar al +${numero}${r && r.error ? `: ${r.error}` : ''}. Revisa el número y que el canal esté en línea.`, 'avisos', true);
  });

  /** Los DOS correos: avisos y respaldo de la BD. */
  app.post('/admin/config/correos', (req, res) => {
    if (!autorizado(req, res)) return;
    const avisos = db.setCorreo('avisos', req.body.aviso_email);
    const respaldo = db.setCorreo('respaldo', req.body.backup_email);
    if (!avisos.ok || !respaldo.ok) {
      return volverAConfig(req, res, 'Ese correo no parece válido — revísalo (déjalo vacío para volver a la casilla de KIPI).', 'correos', true);
    }
    volverAConfig(req, res,
      `Avisos → ${avisos.valor || 'casilla de KIPI'} · Respaldo de la base → ${respaldo.valor || 'casilla de KIPI'}.`, 'correos');
  });

  /** Cuántas visitas hacen a un "Casero" — regla de Clarck, no del código. */
  app.post('/admin/config/casero', (req, res) => {
    if (!autorizado(req, res)) return;
    const v = db.setRecurrenteDesde(req.body.recurrente_desde);
    const cuantos = Object.values(db.metricasPorNumero()).filter((m) => m.visitas >= v).length;
    volverAConfig(req, res,
      `Casero = ${v}+ visitas. Con eso hoy tienes ${cuantos} casero${cuantos === 1 ? '' : 's'}.`, 'casero');
  });

  // Precio, link de grupo y nombre para mostrar de UNA zona (tarjeta por distrito).
  app.post('/admin/config/zona', (req, res) => {
    if (!autorizado(req, res)) return;
    const zona = db.zonasOperativas().includes(req.body.zona) ? req.body.zona : null;
    if (!zona) return volverAConfig(req, res, 'Ese distrito ya no existe.', null, true);
    const c = db.getConfigMap();
    const antes = { precio: c[`precio_${zona}`] || '', link: c[`grouplink_${zona}`] || '', nombre: db.nombreDeZona(zona) };
    /**
     * SIN PRECIO NO SE GUARDA LA ZONA.
     *
     * Guardar la tarjeta con el precio vacío dejaba la zona cotizando "S/ 0" en
     * el guion del bot y —peor— apagaba la validación del monto en los
     * vouchers: sin precio, cualquier Yape salía confirmado. Es un campo del
     * que cuelga la plata, así que se rechaza acá y se dice por qué.
     */
    if (!(Number((req.body.precio || '').trim()) > 0)) {
      return volverAConfig(req, res,
        `Ponle un precio por jugador a ${antes.nombre} (mayor que 0): sin precio el bot cotiza mal y no puede verificar los Yapes de esta zona.`,
        `zona-${zona}`, true);
    }
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
    // Mismo motivo que al editar una zona: un distrito sin precio nace mudo
    // para cotizar y ciego para validar pagos.
    if (!(Number((req.body.precio || '').trim()) > 0)) {
      return volverAConfig(req, res, `Ponle el precio por jugador de ${nombre} (mayor que 0) para poder crearlo.`, 'nuevo-distrito', true);
    }
    db.addSede({
      zona,
      nombre: (req.body.sede || '').trim().slice(0, 120) || 'Sede por definir',
      cupo: Math.max(2, Math.min(60, Number(req.body.cupo) || 14)),
    });
    db.setConfig({
      [`zonanombre_${zona}`]: nombre,
      [`precio_${zona}`]: (req.body.precio || '').trim(),
    });
    volverAConfig(req, res, `${nombre} creado. Ya aparece en el bot, en Partidos y en los filtros. Falta cargarle el link del grupo.`, `zona-${zona}`);
  });

  // --- Partidos: convocatorias, inscripciones, asistencia ----------------------
  const volverAPartidos = (req, res, partidoId = null, aviso = '', ancla = null, err = false) =>
    volver(res, { key: req.body.key, vista: 'partidos', partido: partidoId, aviso, ancla, err });

  /**
   * Por qué no entró nadie, en castellano y con la salida al lado.
   *
   * `inscribir` ya no devuelve un estado del enum sino el motivo real; cada uno
   * tiene una acción distinta y ninguna era visible antes ("no se pudo anotar"
   * a secas es indistinguible de "está roto").
   */
  const MOTIVO_NO_ENTRA = (motivo, quien) => ({
    no_existe: 'Ese partido ya no existe.',
    cancelado: `El partido está CANCELADO: si se va a jugar, tócale "🔓 Reabrir" y vuelve a anotar a ${quien}.`,
    liquidado: `Este partido ya está LIQUIDADO (la plata está contada). Para agregar a ${quien} hay que reabrirlo.`,
    cerrado: `La inscripción está cerrada: tócale "🔓 Reabrir" y vuelve a anotar a ${quien}.`,
    muy_viejo: `Este partido terminó hace más de ${db.graciaHoras()} h. Si igual hay que anotar a ${quien}, tócale "🔓 Reabrir".`,
  }[motivo] || `No se pudo anotar a ${quien}.`);

  app.post('/admin/partido', (req, res) => {
    if (!autorizado(req, res)) return;
    const zona = db.zonasOperativas().includes(req.body.zona) ? req.body.zona : 'brena';
    const fecha = /^\d{4}-\d{2}-\d{2}$/.test(req.body.fecha || '') ? req.body.fecha : null;
    // Sin fecha volvía a la lista sin partido y sin decir por qué: el usuario
    // no técnico concluye "esto está roto" y se vuelve a WhatsApp.
    if (!fecha) return volverAPartidos(req, res, null, 'Elige el día del partido para poder abrirlo.', null, true);
    const r = db.abrirPartido({
      zona, fecha,
      hora: (req.body.hora || '').trim().slice(0, 40),
      sede: (req.body.sede || '').trim().slice(0, 120),
      cupo: Math.max(2, Math.min(60, Number(req.body.cupo) || 14)),
      precio: req.body.precio ? Number(req.body.precio) : null,
    });
    // abrirPartido rechaza zonas que no son operativas. Acá no debería pasar
    // (la zona ya se sanea arriba), pero si pasa vale más decirlo que romper.
    if (!r.id) return volverAPartidos(req, res, null, 'No se pudo abrir el partido: revisa el distrito.', null, true);
    const p = db.getPartido(r.id);
    // Cargar dos veces el mismo domingo 6pm partía la lista en dos: el bot
    // ofrecía cupos de una y cobraba en la otra. Ahora te lleva a la que existe.
    if (!r.creado) {
      return volverAPartidos(req, res, r.id,
        `Ese partido YA existe: ${db.fechaBonita(p.fecha)}${p.hora ? ` · ${p.hora}` : ''} en ${p.sede || 'la misma cancha'}. Esta es su lista.`);
    }
    volverAPartidos(req, res, r.id,
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
    // Guardar con la hora en blanco dejaba hora=NULL, y un partido sin hora se
    // ofrece TODO EL DÍA (y a las 11 de la noche sigue ofreciéndose). Un campo
    // vacío no es una orden de borrar: db lo ignora y acá se dice que quedó la
    // de antes, para que no parezca que se guardó algo que no se guardó.
    const aviso = r.ok
      ? `Partido actualizado. Los inscritos siguen adentro.${r.horaIgnorada ? ' Ojo: dejaste la hora en blanco, así que quedó la que ya tenía (sin hora el bot lo ofrecería todo el día).' : ''}`
      : r.motivo;
    volverAPartidos(req, res, id, aviso, r.ok ? null : 'editor', !r.ok);
  });

  /**
   * Las CUATRO decisiones humanas sobre un partido. Ya no son "estados": son
   * fechas. Lo demás (si empezó, si terminó, si todavía entra un Yape) lo
   * calcula el sistema y nadie tiene que mantenerlo.
   */
  app.post('/admin/partido/estado', (req, res) => {
    if (!autorizado(req, res)) return;
    const id = Number(req.body.id);
    const estado = req.body.estado;
    const acciones = {
      cerrado: () => (db.cerrarInscripcion(id), 'Inscripción cerrada: el bot deja de ofrecer este partido. Los pagos que lleguen tarde los asignas tú.'),
      abierto: () => (db.reabrirPartido(id), `Partido reabierto${db.yaPaso(db.getPartido(id)) ? `: tienes ${db.graciaHoras()} h más para completar la lista y cobrar` : ': el bot vuelve a ofrecerlo'}.`),
      cancelado: () => (db.cancelarPartido(id), 'Partido cancelado. Nadie recibe aviso automático: escríbeles tú.'),
    };
    if (!acciones[estado]) return volverAPartidos(req, res, id, 'Esa acción no existe.', null, true);
    volverAPartidos(req, res, id, acciones[estado]());
  });

  /**
   * LIQUIDAR — lo que antes se llamaba "cerrar" y no compraba nada.
   *
   * "Marcar jugado" no servía para nada (los recurrentes se cuentan por FECHA,
   * no por estado) y por eso nadie lo tocaba: quedaron 16 partidos jugados
   * figurando como abiertos. Liquidar sí dice algo: la plata de este partido ya
   * está contada. Es una afirmación, y solo la puede hacer un humano — nada la
   * dispara sola.
   */
  app.post('/admin/partido/liquidar', (req, res) => {
    if (!autorizado(req, res)) return;
    const id = Number(req.body.id);
    const k = db.cajaPartido(id);
    const r = db.liquidarPartido(id);
    if (!r.ok) {
      return volverAPartidos(req, res, id, r.motivo === 'ya_liquidado' ? 'Este partido ya estaba liquidado.' : 'Ese partido ya no existe.', null, true);
    }
    const soles = (n) => `S/ ${Number(n || 0).toLocaleString('es-PE', { maximumFractionDigits: 2 })}`;
    const queda = k && k.costoCancha != null ? ` · quedan ${soles(k.cobrado - k.costoCancha)} después de la cancha` : '';
    volverAPartidos(req, res, null,
      `Partido liquidado: ${soles(k ? k.cobrado : 0)} cobrados${k && k.porCobrar > 0 ? ` y ${soles(k.porCobrar)} sin cobrar` : ''}${queda}.`);
  });

  /**
   * Archivar en lote los partidos terminados y VACÍOS.
   *
   * Son cargas erradas y duplicados: cero inscritos, cero plata. Pedirle a
   * Clarck que entre uno por uno a cerrarlos es el ritual que hizo que nadie
   * cerrara ninguno. Los que movieron dinero nunca pasan por acá.
   */
  app.post('/admin/partidos/archivar-vacios', (req, res) => {
    if (!autorizado(req, res)) return;
    const n = db.archivarPartidosVacios();
    volverAPartidos(req, res, null, n
      ? `${n} partido${n === 1 ? '' : 's'} vacío${n === 1 ? '' : 's'} archivado${n === 1 ? '' : 's'}. No tenían a nadie inscrito ni plata adentro.`
      : 'No quedaba ningún partido vacío por archivar.');
  });

  // Eliminar un partido vacío (duplicado o cargado por error). Con gente
  // adentro db lo rechaza — ahí corresponde "cancelar", no borrar.
  app.post('/admin/partido/eliminar', (req, res) => {
    if (!autorizado(req, res)) return;
    const id = Number(req.body.id);
    const p = db.getPartido(id);
    if (!db.eliminarPartido(id)) {
      return volverAPartidos(req, res, id, 'Este partido tiene gente inscrita: no se borra. Usa "✖ Cancelar".', null, true);
    }
    // Si lo había puesto un turno fijo, borrarlo sin más lo hace reaparecer en
    // el próximo tick: para el que mira la grilla, un fantasma. Se anota la
    // excepción de esa fecha — el turno sigue vivo para las demás semanas.
    if (p && p.turno_id) db.agregarExcepcion(p.turno_id, p.fecha, 'borrado desde la grilla');
    volverAPartidos(req, res, null, p && p.turno_id
      ? 'Partido eliminado (estaba vacío). Esa fecha queda excluida del turno fijo; las demás semanas siguen igual.'
      : 'Partido eliminado (estaba vacío).');
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
    // `vence: false`: lo que anota Clarck a mano NO caduca. El plazo de la
    // reserva existe para las promesas de chat ("ya te yapeo"), no para el
    // casero que él mismo metió en la lista mirando la cancha.
    const { resultado, motivo } = db.inscribir(partidoId, numero, { nombre, vence: false });
    const quien = nombre || `+${numero}`;
    if (resultado === 'espera') return fin(`${quien} entró a la LISTA DE ESPERA: el partido ya está lleno.`);
    if (resultado === 'ya_inscrito') return fin(`${quien} ya estaba en la lista.`, true);
    if (!resultado) {
      // El caso real: llega un amigo a la cancha y el botón no hacía
      // absolutamente nada, sin explicación. Cada motivo tiene su salida.
      return fin(MOTIVO_NO_ENTRA(motivo, quien), true);
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
      const control = db.numeroAvisos();
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
      // Sobre un partido que ya no admite gente, inscribir() devuelve null y el
      // pago se quedaba suelto sin que nadie lo dijera. Ojo: el partido de
      // anoche SÍ admite (la gracia de 24 h existe justo para este Yape).
      const cerrado = db.motivoCierre(partido);
      if (cerrado) return fin(MOTIVO_NO_ENTRA(cerrado, pago.nombre || `+${pago.numero}`), true);
      db.inscribir(partidoId, pago.numero, { estado: 'pagado', pagoId: pago.id });
    }
    for (let i = 1; i < (pago.cupos || 1); i++) db.inscribir(partidoId, null, { nombre: `Invitado de +${pago.numero}`, estado: 'pagado', pagoId: pago.id });
    fin(`Pago de ${pago.nombre || `+${pago.numero}`} (S/ ${pago.monto}) asignado a este partido.`);
  });

  // --- Turnos fijos: la plantilla semanal --------------------------------------
  const volverATurnos = (req, res, aviso, err = false) =>
    volver(res, { key: req.body.key, vista: 'partidos', aviso, ancla: 'turnos', err });

  app.post('/admin/turno', (req, res) => {
    if (!autorizado(req, res)) return;
    const id = db.crearTurno({
      zona: req.body.zona,
      sede_id: req.body.sede_id || null,
      dia_semana: req.body.dia_semana,
      hora: (req.body.hora || '').trim().slice(0, 40),
      cupo: req.body.cupo,
      precio: req.body.precio,
      // NACE APAGADO aunque se pida encendido en el mismo formulario: encender
      // un turno es comprometerse a pagar canchas reales, y esa decisión se
      // toma mirando la grilla, no llenando un campo.
      activo: 0,
    });
    if (!id) return volverATurnos(req, res, 'Faltan datos del turno: distrito, día de la semana y hora.', true);
    const t = db.getTurno(id);
    volverATurnos(req, res, `Turno guardado: ${db.diaPlural(t.dia_nombre)} ${t.hora} en ${db.nombreDeZona(t.zona)}. Está APAGADO — enciéndelo cuando quieras que se carguen solos.`);
  });

  app.post('/admin/turno/activo', (req, res) => {
    if (!autorizado(req, res)) return;
    const id = Number(req.body.id);
    const encender = req.body.activo === '1';
    db.setTurnoActivo(id, encender);
    const t = db.getTurno(id);
    if (!t) return volverATurnos(req, res, 'Ese turno ya no existe.', true);
    if (!encender) return volverATurnos(req, res, `Turno pausado: ${db.diaPlural(t.dia_nombre)} ${t.hora}. Los partidos ya cargados siguen ahí.`);
    // Al encenderlo se materializa al toque: si no, Clarck lo enciende, no ve
    // nada nuevo en la grilla y asume que no funcionó.
    const { creados } = db.generarPartidosDeTurnos();
    volverATurnos(req, res, `Turno encendido: ${db.diaPlural(t.dia_nombre)} ${t.hora} en ${db.nombreDeZona(t.zona)}${creados ? ` · ${creados} partido${creados === 1 ? '' : 's'} cargado${creados === 1 ? '' : 's'} en los próximos ${db.HORIZONTE_DIAS} días` : ''}.`);
  });

  app.post('/admin/turno/eliminar', (req, res) => {
    if (!autorizado(req, res)) return;
    const t = db.getTurno(Number(req.body.id));
    if (!t) return volverATurnos(req, res, 'Ese turno ya no existe.', true);
    db.eliminarTurno(t.id);
    volverATurnos(req, res, `Turno borrado: ${db.diaPlural(t.dia_nombre)} ${t.hora}. Los partidos que ya estaban cargados no se tocaron.`);
  });

  /**
   * "Esta semana no se juega": se cancela LA INSTANCIA, no el turno.
   *
   * Y si había gente adentro NO se le avisa a nadie automáticamente: se le
   * muestra la lista con sus wa.me para que escriba él. Un mensaje masivo desde
   * el bot para decir "no hay pichanga" es exactamente lo que no queremos que
   * salga solo.
   */
  app.post('/admin/partido/cancelar-fecha', (req, res) => {
    if (!autorizado(req, res)) return;
    const id = Number(req.body.id);
    const p = db.getPartido(id);
    if (!p) return volverAPartidos(req, res, null, 'Ese partido ya no existe.', null, true);
    db.cancelarPartido(id);
    // Sin la excepción, el generador volvería a materializar esa fecha en el
    // próximo tick y el domingo cancelado reaparecería solo.
    if (p.turno_id) db.agregarExcepcion(p.turno_id, p.fecha, 'cancelado desde la grilla');
    const dentro = db.inscripcionesDe(id).filter((i) => i.estado !== 'baja');
    volverAPartidos(req, res, dentro.length ? id : null,
      dentro.length
        ? `${db.fechaBonita(p.fecha, { relativa: false })} cancelado. Hay ${dentro.length} inscrito${dentro.length === 1 ? '' : 's'}: nadie recibe aviso automático, escríbeles desde la lista de abajo.`
        : `${db.fechaBonita(p.fecha, { relativa: false })} cancelado. El turno fijo sigue activo para las demás semanas.`);
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
  /* Vistas rápidas del CRM: las seis listas que se abren de verdad, con su
     cuenta al lado. Dos columnas en celular — seis chips en fila se convierten
     en un scroll horizontal que nadie descubre. */
  /* minmax(0,1fr) y no 1fr: con 1fr el ancho mínimo de cada celda es su
     contenido, así que "Falta meterlos al grupo" empujaba la grilla más ancha
     que la pantalla y la columna derecha quedaba cortada. */
  .vistas{display:grid;grid-template-columns:repeat(2,minmax(0,1fr));gap:7px;padding:var(--s2) 2px var(--s1)}
  .vista{display:flex;align-items:center;justify-content:space-between;gap:8px;min-height:var(--tap);min-width:0;
    padding:0 12px;border-radius:var(--r2);background:var(--surface);border:1.5px solid var(--line-strong);
    color:var(--ink);font-size:var(--t-s);font-weight:600;text-decoration:none}
  .vista .vt{overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
  .vista .vn{flex:0 0 auto;font-weight:800;font-variant-numeric:tabular-nums;color:var(--ink-2)}
  .vista.on{background:var(--navy-fill);border-color:var(--navy-fill);color:#fff;font-weight:700}
  .vista.on .vn{color:#fff}
  /* En cero no se apaga ni se esconde: se atenúa. Que la vista exista y diga 0
     es la información — esconderla haría pensar que el filtro no está. */
  .vista.cero{opacity:.55}
  @media (min-width:760px){ .vistas{grid-template-columns:repeat(3,minmax(0,1fr))} }
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
  /* Los dos badges de la fila van SIEMPRE en el mismo orden (relación, después
     atención): antes era un if-else de seis ramas donde ganaba el que pegaba
     primero, así que dos filas no se podían comparar de un vistazo. Envuelven
     en 360px en vez de estirar la fila: el nombre no se puede comer. */
  .lbadges{display:flex;gap:5px;flex-wrap:wrap;justify-content:flex-end}

  /* Badges de estado. 12px (eran 10, ilegibles de noche) y con BORDE del color
     de su tinta: el borde da una segunda señal además del relleno, para que se
     distingan en escala de grises y con daltonismo. */
  .badge{font-size:var(--t-xs);font-weight:700;padding:3px 9px;border-radius:var(--rp);
    white-space:nowrap;border:1px solid transparent}
  .b-wait{background:var(--st-debe-bg);color:var(--st-debe-ink);border-color:var(--st-debe-ink)}
  .b-hand{background:var(--st-alerta-bg);color:var(--st-alerta-ink);border-color:var(--st-alerta-ink)}
  .b-done{background:var(--st-ok-bg);color:var(--st-ok-ink);border-color:var(--st-ok-ink)}
  .b-new{background:var(--st-off-bg);color:var(--st-off-ink);border-color:var(--st-off-ink)}
  /* Escalón del medio de la relación (Vuelve): entre el gris del que recién
     probó y el verde del casero, para que la rampa se lea como rampa. */
  .b-mid{background:var(--st-lleno-bg);color:var(--st-lleno-ink);border-color:var(--st-lleno-ink)}
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
  /* Línea de valor de la ficha: quién es este tipo para el negocio, en una
     línea. Ocupa el lugar de los seis botones de etapa. */
  .valor{display:flex;gap:8px;align-items:center;justify-content:center;flex-wrap:wrap;margin-top:10px;
    padding:10px 12px;background:var(--surface-2);border:1px solid var(--line);border-radius:var(--r2)}
  .valor .vtxt{font-size:var(--t-s);color:var(--ink-2);font-weight:600}
  /* Los cuatro números que uno viene a buscar cuando abre una ficha, fijos
     arriba: cuántas veces vino, cuánto dejó, hace cuánto y si tiene reserva.
     Antes iban como texto corrido dentro de la línea de valor y repetidos como
     filas de "Historia" más abajo — dos lugares, ninguno mirable de un vistazo
     en un celular. */
  .hl{display:grid;grid-template-columns:repeat(4,1fr);gap:7px;width:100%;margin-top:11px}
  .hl .hlc{background:var(--surface-2);border:1px solid var(--line);border-radius:var(--r2);
    padding:9px 8px;text-align:center;min-width:0}
  .hl .hlk{font-size:var(--t-xs);letter-spacing:.07em;text-transform:uppercase;color:var(--ink-2);font-weight:700}
  .hl .hlv{font-size:var(--t-l);font-weight:800;letter-spacing:-.02em;margin-top:3px;
    overflow-wrap:anywhere;line-height:1.15;font-variant-numeric:tabular-nums}
  .hl .hls{font-size:var(--t-xs);color:var(--ink-2);font-weight:600;margin-top:1px;line-height:1.25}
  @media (max-width:400px){ .hl{grid-template-columns:repeat(2,1fr)} }
  /* El recorrido del partido: en qué escalón está esta pichanga. Los pasos que
     ya pasaron van llenos, el actual marcado, los que faltan en gris. Es la
     misma fase que ya calcula db.fasePartido — acá solo se dibuja. */
  .via{display:flex;gap:3px;margin:2px 0 13px}
  .via .vp{flex:1;min-width:0;text-align:center;padding:7px 3px 6px;border-radius:var(--r2);
    background:var(--surface-2);border:1px solid var(--line);
    font-size:var(--t-xs);font-weight:700;color:var(--ink-3);overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
  .via .vp.hecho{background:var(--st-ok-bg);border-color:var(--st-ok-ink);color:var(--st-ok-ink)}
  .via .vp.aqui{background:var(--navy-fill);border-color:var(--navy-fill);color:#fff}
  .via .vp.corte{background:var(--st-alerta-bg);border-color:var(--st-alerta-ink);color:var(--st-alerta-ink)}
  .pz{display:inline-flex;align-items:center;font-size:var(--t-xs);font-weight:700;padding:6px 12px;border-radius:var(--rp);color:#fff}

  .group{background:var(--surface);border:1px solid var(--line);border-radius:var(--r3);overflow:hidden;box-shadow:var(--sombra)}
  .grow{display:flex;align-items:center;justify-content:space-between;gap:10px;min-height:var(--tap);padding:12px 15px;border-bottom:1px solid var(--line);font-size:var(--t-m)}
  .grow:last-child{border-bottom:none}
  .grow .k{color:var(--ink-2)} .grow .v{font-weight:600;text-align:right}
  /* Acá vivían .pipe/.pstep, los seis botones de etapa de la ficha. Se fueron
     con la escalera (16/08): mantener el CRM a mano —quince toques por semana,
     uno por contacto— no iba a pasar, y por eso la etapa mentía. */

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
  // Las mismas dos consultas que usa el CRM: relación y frescura de todos.
  const met = db.metricasPorNumero();
  const um = db.umbralesFrescura();
  const mDe = (l) => met[l.numero] || { visitas: 0, ultima: null, pagos: 0, soles: 0 };

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
  // "Para Clarck" contaba los 105 handoff de TODA la historia y llevaba a una
  // lista que respeta corte + 72 h: el tile decía 105 y la lista mostraba 4.
  // Los dos números salen ahora de la misma función (db.handoffsActivos) y el
  // tile lleva al filtro que muestra exactamente ese conjunto.
  const esperandoAhora = db.handoffsActivos().length;
  const enHandoff = todos.filter((l) => l.handoff).length;
  // Idem con los pagos: el banner contaba una cosa y la lista mostraba otra
  // (contaba todo el histórico posterior al corte y linkeaba a una vista que
  // abre en 7 días). Ahora es LA MISMA lista, y el link lleva a verla entera.
  const pagosRevisar = db.pagosPorRevisar().length;

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

  /**
   * ¿Dónde abrir? — demanda por distrito SIN sede, medida en PAGADORES.
   *
   * Antes contaba contactos: los 510 que dejaron sus datos y nunca pagaron le
   * metían ruido a la única señal que importa acá. Un interesado dice "me
   * gustaría"; alguien que ya viajó a otro distrito y yapeó dice "voy a ir".
   * Un distrito con 6 que pagaron pesa más que uno con 60 que preguntaron.
   *
   * El interés se sigue mostrando al costado —es lo que da volumen a futuro—
   * pero ordena y decide la plata.
   */
  const UMBRAL_PILOTO = 7; // media pichanga (14 cupos) de gente que YA pagó viajando
  const desde30 = fechaLima(-29);
  const dd = {};
  for (const l of todos) {
    if (l.zona !== 'otra' || !(l.distrito || '').trim()) continue;
    const k = normTexto(l.distrito);
    if (!dd[k]) dd[k] = { k, nombre: l.distrito.trim().toLowerCase().replace(/(^|\s)\p{L}/gu, (c) => c.toUpperCase()), n: 0, pagadores: 0, mes: 0 };
    dd[k].n++;
    if (mDe(l).pagos > 0) dd[k].pagadores++;
    if ((l.creado_en || '').slice(0, 10) >= desde30) dd[k].mes++;
  }
  // Solo distritos con al menos un pagador: una lista de nombres con cero plata
  // adentro no ayuda a decidir dónde alquilar una cancha.
  const distritos = Object.values(dd).filter((d) => d.pagadores > 0)
    .sort((a, b) => b.pagadores - a.pagadores || b.n - a.n).slice(0, 8);
  const maxD = Math.max(1, ...distritos.map((d) => d.pagadores));
  const drow = (d) => {
    const listo = d.pagadores >= UMBRAL_PILOTO;
    // El lima puro sobre blanco da 1.97:1: como relleno de un punto de 11px y de
    // una barra de 8px, prácticamente no se ve. Va la versión --lime-fill (3.16:1),
    // que es el mismo verde con el peso justo para leerse.
    const color = listo ? 'var(--lime-fill)' : 'var(--st-off-solid)';
    // El número que ordena la fila son los PAGADORES, así que el link abre a
    // los pagadores de ese distrito — no a todos los interesados, que son otro
    // número (el que va al lado, en chico).
    return `<a class="zrow" href="/admin/leads?key=${key}&vista=crm&distrito=${encodeURIComponent(d.k)}&rel=pagaron"><span class="zdot" style="background:${color}"></span>
      <span class="zname">${esc(d.nombre)}${listo ? ' 🔥' : ''}</span>
      <span class="ztrack"><i style="width:${Math.max(3, Math.round((d.pagadores / maxD) * 100))}%;background:${color}"></i></span>
      <span class="zval">${d.pagadores} <small style="color:var(--ink-3);font-weight:400">pagaron · ${d.n} interesados</small></span></a>`;
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

  /**
   * EMBUDO COMERCIAL — cuatro escalones, cada uno SUBCONJUNTO del anterior.
   *
   * El de antes no era un embudo: "dejaron sus datos" y "pagaron por Yape" se
   * cruzan (hay quien paga sin registrarse y quien se registra sin pagar), así
   * que las barras no se podían leer como una escalera — un escalón podía ser
   * más ancho que el de arriba. Estos cuatro se miden todos con la MISMA
   * métrica (visitas), y por construcción cada uno está adentro del anterior.
   *
   * "Cuánto sabemos de alguien" no va acá: es el otro eje. Vive en la ficha y
   * en la columna Datos del Sheet.
   */
  const visitasDe = (l) => mDe(l).visitas;
  const vinieron = todos.filter((l) => visitasDe(l) >= 1).length;
  const volvieron = todos.filter((l) => visitasDe(l) >= 2).length;
  const caseros = todos.filter((l) => visitasDe(l) >= db.RECURRENTE_DESDE).length;

  // SALUD DE LA BASE — sobre los que ya vinieron alguna vez: son los únicos que
  // se pueden perder. Meter acá a los 510 que nunca pagaron taparía la señal
  // con gente que nunca fue cliente.
  const clientes = todos.filter((l) => visitasDe(l) >= 1);
  const salud = { al_dia: 0, enfriando: 0, perdido: 0 };
  for (const l of clientes) {
    const f = db.frescuraDe(db.diasDesde(mDe(l).ultima), um);
    if (f) salud[f]++;
  }
  const pct = (n) => (todos.length ? Math.round((n / todos.length) * 100) : 0);
  const pctCli = (n) => (clientes.length ? Math.round((n / clientes.length) * 100) : 0);
  // Cada escalón del embudo lleva al CRM con ESA gente filtrada. El porcentaje
  // es sobre el total del bloque (contactos en el embudo, clientes en salud):
  // mezclar bases haría que dos barras del mismo largo signifiquen cosas
  // distintas.
  const frow = (nombre, n, color, detalle, filtroUrl, base = pct) =>
    `<a class="zrow" href="/admin/leads?key=${key}&vista=crm${filtroUrl || ''}"><span class="zdot" style="background:${color}"></span>
      <span class="zname">${nombre}${detalle ? ` <small style="color:var(--ink-2);font-weight:400">${detalle}</small>` : ''}</span>
      <span class="ztrack"><i style="width:${Math.max(3, base(n))}%;background:${color}"></i></span>
      <span class="zval">${n} <small style="color:var(--ink-2);font-weight:400">${base(n)}%</small></span></a>`;

  /**
   * EL INTERRUPTOR, DESDE EL RESUMEN.
   *
   * Apagar tiene que ser un toque y estar donde uno se entera de que algo va
   * mal — que es esta pantalla, no el fondo de Ajustes. Encender no: eso vive
   * en Ajustes, detrás del ensayo y de escribir la palabra.
   */
  const bot = db.estadoBot();
  const modoSeguro = !bot.encendido;
  const capturados = silenciados48h(roles, todos);
  const desdeCuando = bot.encendidoEn
    ? ` Encendido desde el ${fechaCompacta(bot.encendidoEn, true, false)} ${esc(String(bot.encendidoEn).slice(11, 16))}${bot.por ? ` (${esc(bot.por)})` : ''}.`
    : '';
  const bannerSeguro = modoSeguro
    ? `<a class="banner px" href="/admin/leads?key=${key}&vista=config#bot" style="text-decoration:none">
    <div class="bic">🔒</div>
    <div class="btxt"><b>El bot está apagado.</b> Registra todo lo que llega pero no le responde a nadie:
      <b>${capturados} conversacion${capturados === 1 ? '' : 'es'}</b> en las últimas 48 h esperando.
      Toca para encenderlo cuando estés listo.</div></a>`
    : `<div class="banner ok px" style="align-items:center">
    <div class="bic">🤖</div>
    <div class="btxt"><b>Bot encendido.</b> Le responde a cualquiera de los ${todos.length} contactos que escriba.${desdeCuando}</div>
    <form method="post" action="/admin/bot/apagar" style="flex:0 0 auto;margin-left:auto">
      <input type="hidden" name="key" value="${esc(decodeURIComponent(key))}">
      <button class="btn-toque" style="min-height:var(--tap);font-size:var(--t-s);background:var(--surface);color:var(--st-alerta-ink);border:1.5px solid var(--st-alerta-ink);white-space:nowrap">⏸ Apagar</button>
    </form></div>`;

  // Acción primero: la pichanga más próxima como marcador, antes que cualquier
  // métrica. Si no hay partido abierto, invita a abrir uno.
  // Los pagos por revisar son plata parada: iban al final de la página y ahora
  // van arriba, con el link a la lista ya filtrada en vez de "entra a la ficha".
  // `periodo=todo` NO es un adorno: sin él la vista Pagos abre en los últimos 7
  // días y el banner decía "12 pagos por revisar" para después mostrar 3.
  const alertaPagos = pagosRevisar
    ? `<a class="banner px" href="/admin/leads?key=${key}&vista=pagos&estado=rev&periodo=todo" style="margin:0 0 14px;text-decoration:none">
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
  /**
   * Acá vivía "N partidos ya jugados sin cerrar", que le pedía a Clarck que
   * rompiera la única red que atrapaba los Yapes tardíos. Ya no: los partidos
   * que terminaron se apagan solos (fin + gracia) y lo único que queda pendiente
   * es CONTAR la plata de los que la movieron.
   */
  const porLiquidar = db.partidosPorLiquidar();
  if (porLiquidar.length) {
    const plata = porLiquidar.reduce((s, p) => s + (p.caja ? p.caja.cobrado + p.caja.porCobrar : 0), 0);
    pendientes.push({
      ico: '🧾', que: `${porLiquidar.length} partido${porLiquidar.length === 1 ? '' : 's'} por liquidar`,
      para: `S/ ${plata.toLocaleString('es-PE', { maximumFractionDigits: 0 })} entre cobrado y por cobrar. Liquidar es decir "esta plata ya está contada".`,
      href: `/admin/leads?key=${key}&vista=partidos#liquidar`, cta: 'Contarla',
    });
  }
  const vacios = db.partidosArchivables();
  const soloVacios = db.partidosVacios().length;
  if (vacios.length) {
    pendientes.push({
      ico: '🧹', que: `${vacios.length} partido${vacios.length === 1 ? '' : 's'} terminado${vacios.length === 1 ? '' : 's'} para archivar`,
      para: vacios.length > soloVacios
        ? `${soloVacios} sin nadie inscrito y ${vacios.length - soloVacios} anteriores al punto de arranque. Se van todos de un toque.`
        : 'Terminaron sin nadie inscrito: son cargas erradas y duplicados. Se van todos de un toque.',
      href: `/admin/leads?key=${key}&vista=partidos#liquidar`, cta: 'Archivar',
    });
  }
  // Duplicados con gente en las DOS listas: nadie los fusiona por su cuenta.
  const conflictos = db.conflictosDePartidos();
  if (conflictos.length) {
    pendientes.push({
      ico: '⚠️', que: `${conflictos.length} partido${conflictos.length === 1 ? '' : 's'} duplicado${conflictos.length === 1 ? '' : 's'} con gente en los dos`,
      para: `${conflictos[0]}. Nadie los junta solo: decide cuál es la lista buena y da de baja la otra.`,
      href: `/admin/leads?key=${key}&vista=partidos`, cta: 'Ver',
    });
  }
  // Días que históricamente se juegan y no tienen nada cargado: es el caso del
  // 15/08 (domingo prometido por WhatsApp, S/20 cobrados, partido inexistente).
  const huecos = db.diasSinCargar();
  if (huecos.length) {
    const h = huecos[0];
    pendientes.push({
      // "en los próximos N días" y no a secas: la vista Partidos abre en LA
      // SEMANA, así que un hueco a 10 días se cuenta acá y se ve al pasar de
      // semana. Sin el plazo escrito, el número parecía no cuadrar con la grilla.
      ico: '📅', que: `${huecos.length} día${huecos.length === 1 ? '' : 's'} con turno de siempre y nada cargado (próximos ${db.HORIZONTE_DIAS} días)`,
      para: `Los últimos ${h.veces} ${db.diaPlural(h.dia_nombre)} jugaste ${h.hora} en ${esc(db.nombreDeZona(h.zona))} y el ${fechaCompacta(h.fecha, false, false)} no hay nada. Si lo vendes por WhatsApp, no habrá dónde anotarlo.`,
      href: `/admin/leads?key=${key}&vista=partidos`, cta: 'Cargarlo',
    });
  }
  if (!(cfg.yape_numero || '').trim()) {
    pendientes.push({
      ico: '📲', que: 'Falta el número de Yape',
      para: 'Es el número que el bot le pasa a cada jugador para cobrarle.',
      href: aConfig('general'), cta: 'Ponerlo',
    });
  }
  // Un número de avisos sin probar es indistinguible de uno bien puesto: no
  // falla, simplemente nunca llega nada. Y por ahí salen los handoffs y los
  // pagos por revisar.
  if (!db.numeroAvisos()) {
    pendientes.push({
      ico: '🔔', que: 'No hay número para los avisos',
      para: 'Los derivados, los pagos por revisar y las listas de espera solo te llegarían por correo.',
      href: aConfig('avisos'), cta: 'Ponerlo',
    });
  } else if (!db.avisosProbadoEn()) {
    pendientes.push({
      ico: '🔔', que: 'El número de avisos nunca se probó',
      para: 'Un número mal tipeado no da error: los avisos simplemente no llegan. Manda una prueba de un toque.',
      href: aConfig('avisos'), cta: 'Probar',
    });
  }
  const bloquePendientes = pendientes.length ? `
      <div class="shdr">Para que el bot trabaje solo <small>· ${pendientes.length} dato${pendientes.length === 1 ? '' : 's'} por cargar</small></div>
      <div class="zlist">
        ${pendientes.slice(0, 8).map((p) => `<a class="prow" href="${p.href}">
          <span class="pico2">${p.ico}</span>
          <span class="ptxt"><b>${p.que}</b><small>${p.para}</small></span>
          <span class="pcta">${p.cta} ›</span></a>`).join('')}
      </div>` : '';

  // La próxima pichanga es la próxima que SE PUEDE OFRECER, no la primera de la
  // lista: sin `vigentes` el hero se quedaba pegado al partido de esta mañana
  // que ya se jugó.
  const abiertos = db.partidosAbiertos(null, { vigentes: true });
  const prox = abiertos[0] || null;
  const heroPartido = prox
    ? `<a class="marcador" style="display:block;margin-bottom:14px" href="/admin/leads?key=${key}&vista=partidos&partido=${prox.id}">
        <div class="mtop"><span class="mlabel">⚽ Próxima pichanga · ${esc(db.nombreDeZona(prox.zona))}</span>
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
        <a class="stat ${esperandoAhora ? 'red' : ''}" href="/admin/leads?key=${key}&vista=crm&filtro=esperando" title="Derivados que escribieron en las últimas 72 h · ${enHandoff} derivados en total"><div class="sn">${esperandoAhora}</div><div class="sl">Para Clarck ahora</div></a>
      </div>

      <div class="shdr">Por zona <small>· toca para ver quiénes son</small></div>
      <div class="zlist">
        ${ordenZonas.map((z) => zrow(
          z === 'otra' ? 'Sin sede cerca' : esc(db.nombreDeZona(z)),
          zc[z],
          colorZona(z),
          `&zona=${encodeURIComponent(z)}`
        )).join('')}
        ${sinClasificar ? zrow('Por clasificar', sinClasificar, 'var(--ink-3)', null) : ''}
      </div>

      ${distritos.length ? `
      <div class="shdr">¿Dónde abrir? · distritos sin sede, por gente que YA pagó</div>
      <div class="zlist">${distritos.map(drow).join('')}</div>
      <div class="foot" style="padding:8px 2px 0">Ordena la plata, no el interés: son personas de ese distrito que viajaron a otra zona y yaparon.
        ${UMBRAL_PILOTO}+ (media cancha) → 🔥 candidato a piloto.</div>` : ''}

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

      <div class="shdr">Del primer mensaje al casero <small>· toca para ver quiénes</small></div>
      <div class="zlist">
        ${/* Una rampa de marca: de navy (todos los que escriben) a lima (los
              caseros). Cada escalón está ADENTRO del anterior — se puede leer
              como una escalera porque los cuatro se miden con lo mismo. */ ''}
        ${/* Cada escalón lleva a SU MISMO conjunto: los acumulados (1+, 2+, N+),
              no al tramo suelto. Antes "Vinieron alguna vez: 120" abría la
              lista de los que vinieron UNA sola vez y mostraba 80. */ ''}
        ${frow('Escribieron al número', todos.length, 'var(--navy-fill)', '', '')}
        ${frow('Vinieron alguna vez', vinieron, 'var(--navy-2)', '1+ visita', '&rel=vinieron')}
        ${frow('Volvieron', volvieron, 'var(--ramp-mid)', '2+ visitas', '&rel=volvieron')}
        ${frow('Caseros', caseros, 'var(--lime-fill)', `${db.RECURRENTE_DESDE}+ visitas`, '&rel=casero')}
      </div>
      <div class="foot" style="padding:8px 2px 0">Una <b>visita</b> = un día con Yape confirmado o con partido jugado. Un Yape de S/30 por dos cupos es una visita con un amigo, no dos.
        Cada escalón abre exactamente la gente que cuenta.</div>

      ${clientes.length ? `
      <div class="shdr">Salud de la base <small>· de los ${clientes.length} que ya vinieron</small></div>
      <div class="zlist">
        ${frow('Al día', salud.al_dia, 'var(--lime-fill)', `vinieron hace ${um.frio} días o menos`, '&rel=al_dia', pctCli)}
        ${frow('Enfriándose', salud.enfriando, 'var(--st-debe-solid)', `entre ${um.frio + 1} y ${um.perdido} días`, '&rel=enfriando', pctCli)}
        ${frow('Perdidos', salud.perdido, 'var(--st-off-solid)', `más de ${um.perdido} días sin venir`, '&rel=perdido', pctCli)}
      </div>
      <div class="foot" style="padding:8px 2px 0">Los cortes se cambian en <a href="/admin/leads?key=${key}&vista=config#frescura" style="color:var(--lime-ink)">Ajustes</a>. El que se está enfriando todavía vuelve con un mensaje; el perdido ya se fue a otra pichanga.</div>` : ''}


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

  /**
   * "Por revisar" es UNA cola, y se define en un solo lugar (db.pagosPorRevisar).
   *
   * Antes el tile contaba los 'revisar' del período ignorando el punto de
   * arranque y la sección de abajo sí lo respetaba: dos números distintos, uno
   * encima del otro, en la misma pantalla. Ahora los dos miran esta misma
   * lista, así que no pueden separarse. Lo anterior al corte queda como
   * historial (sigue en el CSV, en el Sheet y en la ficha de cada contacto).
   */
  const enCola = new Set(db.pagosPorRevisar().map((p) => p.id));
  const esCola = (p) => p.estado === 'revisar' && enCola.has(p.id);
  const ocultosPorCorte = todosPagos.filter((p) => p.estado === 'revisar' && !enCola.has(p.id)).length;

  // "Alcance": medio + período/día (sin el filtro de estado). Las tarjetas de
  // arriba se calculan sobre el alcance — estilo Power BI: tocas un filtro y
  // TODO (tarjetas y listas) se recalcula sobre ese corte.
  let alcance = todosPagos.filter((p) => p.estado !== 'revisar' || esCola(p));
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
  // "Hay filtro" = hay algo DISTINTO del estado por defecto. `fPeriodo` siempre
  // vale algo (arranca en '7d'), así que incluirlo tal cual daba `true` siempre:
  // el botón "✕ Limpiar filtros" estaba permanentemente encendido y al tocarlo
  // no cambiaba nada —volvía al mismo 7d—, y la tarjeta decía "Cobrado (filtro)"
  // aun sin ningún filtro puesto.
  const PERIODO_DEFECTO = '7d';
  const hayFiltro = Boolean(fEstado || fMedio || fDia || fPeriodo !== PERIODO_DEFECTO);

  const qs = (over) => {
    const p = { estado: fEstado, medio: fMedio, periodo: fPeriodo, dia: fDia, ...over };
    return Object.entries(p).filter(([, v]) => v).map(([k, v]) => `&${k}=${encodeURIComponent(v)}`).join('');
  };

  const conf = pagos.filter((p) => p.estado === 'confirmado');
  const rev = pagos.filter(esCola);
  // Tarjetas: siempre sobre el ALCANCE (reaccionan a medio/período/día) y con
  // la MISMA definición que la lista de abajo.
  const confAlcance = alcance.filter((p) => p.estado === 'confirmado');
  const revAlcance = alcance.filter(esCola);
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
          ${/* "Medio: Yape" y no "Yape" a secas: cerrado, el texto del elegido
               es lo único visible y tiene que decir de qué filtro se trata. */ ''}
          ${Object.entries(MEDIOS).map(([k, m]) => `<option value="${k}"${fMedio === k ? ' selected' : ''}>Medio: ${m.nombre}</option>`).join('')}
        </select>
        <select name="periodo" onchange="this.form.submit()">
          <option value="hoy"${fPeriodo === 'hoy' ? ' selected' : ''}>Solo hoy</option>
          <option value="7d"${fPeriodo === '7d' ? ' selected' : ''}>Últimos 7 días</option>
          <option value="30d"${fPeriodo === '30d' ? ' selected' : ''}>Últimos 30 días</option>
          <option value="todo"${fPeriodo === 'todo' ? ' selected' : ''}>Todo el histórico</option>
        </select>
        <input type="date" name="dia" value="${fDia}" max="${hoy}" onchange="this.form.submit()" aria-label="Filtrar por día">
        ${/* Sin JS, el onchange no corre y no había forma de aplicar nada:
             la barra de Pagos no tenía botón de envío. */ ''}
        <button class="btn-toque btn-guardar">Filtrar</button>
      </form>
      ${hayFiltro ? `<div style="padding:6px 2px 0"><a class="fchip" href="/admin/leads?key=${key}&vista=pagos">✕ Limpiar filtros</a></div>` : ''}
      ${rev.length ? `
      <div class="shdr">Por revisar <small>· monto no coincide, comprobante repetido o ilegible — toca para ir a la ficha</small></div>
      <div class="llist">${rev.map(fila).join('')}</div>` : ''}

      <div class="shdr">Confirmados <small>· ${conf.length} pago${conf.length === 1 ? '' : 's'}</small></div>
      ${conf.length ? `<div class="llist">${conf.map(fila).join('')}</div>` : `<div class="vacio">${hayFiltro ? 'Sin pagos confirmados con este filtro.' : 'Todavía no hay pagos confirmados.<br>Cuando un jugador mande su captura de Yape, aparece acá.'}</div>`}

      <div class="foot">La IA lee cada comprobante (monto, remitente, nº de operación y app/banco).<br>
        ${ocultosPorCorte ? `${ocultosPorCorte} comprobante${ocultosPorCorte === 1 ? '' : 's'} por revisar anterior${ocultosPorCorte === 1 ? '' : 'es'} al punto de arranque quedaron como historial (siguen en el CSV y en la ficha de cada contacto).<br>` : ''}
        Se actualiza solo cada 90 s.</div>
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

  // UNA sola lectura de las métricas para toda la lista (dos consultas), no una
  // por fila: acá se pintan cientos de contactos.
  const met = db.metricasPorNumero();
  const um = db.umbralesFrescura();
  const mDe = (l) => met[l.numero] || { visitas: 0, ultima: null, pagos: 0, soles: 0 };
  // Frescura: días desde la última visita; si nunca vino, desde su último
  // mensaje (para un lead que nunca pagó, "hace cuánto no se sabe de él" es lo
  // único que se puede medir). Sin ninguna de las dos, su alta.
  const refDe = (l) => mDe(l).ultima || (roles[l.numero] || {}).en || l.actualizado_en || l.creado_en;
  const diasDe = (l) => db.diasDesde(refDe(l));
  const frescuraLead = (l) => db.frescuraDe(diasDe(l), um);

  const q = (query.q || '').trim().toLowerCase();
  // Las zonas se crean desde Ajustes: si el filtro solo aceptara las cinco
  // escritas a mano, un distrito nuevo (San Borja) se ignoraría en silencio y
  // la lista mostraría a todos como si el filtro no existiera.
  const zonasVivas = [...db.zonasOperativas(), 'otra'];
  const zona = zonasVivas.includes(query.zona) ? query.zona : '';
  const filtro = query.filtro || '';
  // El filtro de ETAPA (8 opciones, la mitad en cero por definición) pasó a ser
  // el de RELACIÓN. Parámetro nuevo (`rel`) y no reciclado: `estado=activo` de
  // un link viejo querría decir otra cosa, y es mejor ignorarlo que mentir.
  // `vinieron` y `volvieron` son ACUMULADOS (1+ y 2+ visitas), no tramos: son
  // los conjuntos que cuenta el embudo del Resumen. Sin ellos, "Vinieron alguna
  // vez: 120" abría una lista de 80 (solo los de UNA visita) — el número y su
  // lista contando cosas distintas, que es justo lo que se vino a arreglar.
  // `pagaron` es el conjunto que ordena "¿Dónde abrir?" (dejó plata alguna vez).
  const RELACION_FILTROS = ['nunca', 'probo', 'vuelve', 'casero', 'vinieron', 'volvieron', 'pagaron',
    'al_dia', 'enfriando', 'perdido', 'en_grupo', 'sin_grupo', 'listo_grupo'];
  const relF = RELACION_FILTROS.includes(query.rel) ? query.rel : '';
  const dia = /^\d{4}-\d{2}-\d{2}$/.test(query.dia || '') ? query.dia : '';
  const distritoF = normTexto(query.distrito || '');
  // "Derivado" (toda la historia) y "esperando ahora" (habló en 72 h, después
  // del corte) son dos conjuntos distintos y cada uno tiene su filtro: el
  // Resumen cuenta los que esperan AHORA y tiene que poder abrir exactamente
  // esos, ni más ni menos. La definición vive en db.handoffsActivos.
  const numerosEsperando = new Set(db.handoffsActivos().map((l) => l.numero));
  let leads = todos;
  if (q) leads = leads.filter((l) => [l.nombre, l.numero, l.distrito, l.etiquetas].join(' ').toLowerCase().includes(q));
  if (zona) leads = leads.filter((l) => l.zona === zona);
  if (filtro === 'handoff') leads = leads.filter((l) => l.handoff);
  if (filtro === 'esperando') leads = leads.filter((l) => numerosEsperando.has(l.numero));
  if (filtro === 'responder') leads = leads.filter(sinResp);
  // Casero = 6+ visitas (el "más de 5 partidos" de Clarck, ahora medido con la
  // métrica que sí tiene historia). Nuevo = llegó esta semana, la misma ventana
  // que usa "Esta semana" en el Resumen.
  if (filtro === 'recurrentes') leads = leads.filter((l) => db.relacionDe(mDe(l).visitas) === 'casero');
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
  /**
   * Las nueve opciones de RELACIÓN, que son EXACTAMENTE los dos bloques del
   * Resumen: los cuatro escalones del embudo y los tres de salud de la base,
   * más el hecho del grupo. Espejo a propósito: cada fila del Resumen lleva a
   * su conjunto y a nada más — si "Perdidos: 120" abriera una lista de 200
   * porque el filtro incluye a los que recién se enfrían, sería el mismo tipo
   * de mentira que se vino a sacar de encima.
   *
   * Los tres de frescura son sobre CLIENTES (visitas ≥ 1): al que nunca vino
   * no se lo puede perder.
   */
  const PRED_REL = {
    nunca: (l) => mDe(l).visitas === 0,
    probo: (l) => db.relacionDe(mDe(l).visitas) === 'probo',
    vuelve: (l) => db.relacionDe(mDe(l).visitas) === 'vuelve',
    casero: (l) => db.relacionDe(mDe(l).visitas) === 'casero',
    // Los tres acumulados que cuentan el Resumen y el bloque "¿Dónde abrir?".
    vinieron: (l) => mDe(l).visitas >= 1,
    volvieron: (l) => mDe(l).visitas >= 2,
    pagaron: (l) => mDe(l).pagos > 0,
    al_dia: (l) => mDe(l).visitas >= 1 && db.frescuraDe(db.diasDesde(mDe(l).ultima), um) === 'al_dia',
    enfriando: (l) => mDe(l).visitas >= 1 && db.frescuraDe(db.diasDesde(mDe(l).ultima), um) === 'enfriando',
    perdido: (l) => mDe(l).visitas >= 1 && db.frescuraDe(db.diasDesde(mDe(l).ultima), um) === 'perdido',
    en_grupo: (l) => Boolean(l.grupo_enviado_en),
    sin_grupo: (l) => !l.grupo_enviado_en,
    /**
     * LISTOS PARA ENTRAR AL GRUPO — el único paso del embudo que sigue siendo
     * a mano.
     *
     * "Sin grupo" a secas son 1048 de 1049: incluye a todo el que escribió una
     * vez y nunca dijo ni su nombre. Como lista de trabajo no sirve. Estos son
     * los que YA se pueden meter: dieron su nombre, tienen una zona con cancha
     * nuestra, y nadie les mandó el link todavía.
     */
    listo_grupo: (l) => !l.grupo_enviado_en && l.nombre && l.zona && l.zona !== 'otra',
  };
  if (relF) leads = leads.filter(PRED_REL[relF]);
  const hayFiltro = Boolean(q || zona || filtro || relF || dia || distritoF);

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
  // Misma definición que el tile del Resumen y que el Sheet: una sola función
  // en db.js, tres superficies que la llaman.
  const handoffActivo = (l) => numerosEsperando.has(l.numero);
  const urgentes = leads.filter((l) => handoffActivo(l) || sinResp(l));
  const resto = leads.filter((l) => !(handoffActivo(l) || sinResp(l)));

  // Los filtros COMBINAN (no se pisan): esto reconstruye la URL cambiando uno.
  const qsCrm = (over) => {
    const p = { q: query.q || '', zona, filtro, rel: relF, dia, tipo, distrito: distritoF, ...over };
    return Object.entries(p).filter(([, v]) => v).map(([k, v]) => `&${k}=${encodeURIComponent(v)}`).join('');
  };

  /**
   * Los 14 chips en tres filas se volvieron tres desplegables.
   *
   * Ocupaban media pantalla antes del primer contacto (peor en 360px), y como
   * cada familia es EXCLUYENTE —el código ya guardaba un solo valor por
   * `filtro`, `zona` y `estado`— la fila de chips prometía una combinatoria
   * que no existía. Un <select> dice la verdad: elegís uno.
   *
   * Cada <option> se lee solo ("Zona: Breña", no "Breña"): cerrado, el texto
   * del elegido es lo ÚNICO visible, así que tiene que decir de qué familia es.
   * El número entre paréntesis evita tener que abrirlo para saber si vale la
   * pena: "Sin responder (0)" se descarta sin tocar nada.
   */
  const nPor = (pred) => todos.filter(pred).length;
  const selectorFiltro = (campo, actual, todosLabel, opciones) => `
    <select name="${campo}" aria-label="${esc(todosLabel)}" onchange="this.form.submit()">
      <option value="">${esc(todosLabel)}</option>
      ${opciones.map(([v, label, n]) =>
        `<option value="${esc(v)}"${actual === v ? ' selected' : ''}>${esc(label)}${n == null ? '' : ` (${n})`}</option>`).join('')}
    </select>`;

  // 1 · ATENCIÓN — por qué mirarías a alguien HOY. Es la familia más usada, va primera.
  const opcAtencion = [
    ['nuevos', '🌱 Solo nuevos (esta semana)', nPor((l) => (l.creado_en || '').slice(0, 10) >= fechaLima(-6))],
    ['recurrentes', '⭐ Solo caseros', nPor((l) => db.relacionDe(mDe(l).visitas) === 'casero')],
    ['responder', '📥 Sin responder', nPor(sinResp)],
    ['esperando', '🔔 Esperando a Clarck ahora', numerosEsperando.size],
    ['handoff', '🔔 Derivados a Clarck (todos)', nPor((l) => l.handoff)],
  ];

  // 2 · ZONA — dinámica. Las zonas se crean desde Ajustes: escribirlas a mano
  // acá dejaría afuera a cualquier distrito nuevo, que es el bug que ya se
  // arregló una vez en el filtrado y volvería a aparecer en el formulario.
  const cZona = {};
  for (const l of todos) if (l.zona) cZona[l.zona] = (cZona[l.zona] || 0) + 1;
  const opcZona = zonasVivas.map((z) => [
    z, `Zona: ${z === 'otra' ? 'sin sede cerca' : db.nombreDeZona(z)}`, cZona[z] || 0,
  ]);

  // 3 · RELACIÓN — reemplaza al desplegable de ETAPA, que ofrecía ocho opciones
  // de las cuales la mitad daba cero por construcción ("lista_espera" e
  // "inactivo" no los escribía ningún código). Estas salen de hechos, no de una
  // columna que alguien tenía que mantener, y son las mismas que el Resumen.
  const opcRelacion = [
    ['nunca', 'Relación: nunca pagó', nPor(PRED_REL.nunca)],
    ['probo', 'Relación: probó (1 visita)', nPor(PRED_REL.probo)],
    ['vuelve', `Relación: vuelve (2 a ${db.RECURRENTE_DESDE - 1})`, nPor(PRED_REL.vuelve)],
    ['casero', `Relación: casero (${db.RECURRENTE_DESDE}+)`, nPor(PRED_REL.casero)],
    // Los acumulados del embudo del Resumen: cada fila de allá abre su conjunto.
    ['vinieron', 'Vinieron alguna vez (1+)', nPor(PRED_REL.vinieron)],
    ['volvieron', 'Volvieron (2+)', nPor(PRED_REL.volvieron)],
    ['pagaron', '💸 Ya pagó alguna vez', nPor(PRED_REL.pagaron)],
    ['al_dia', `✓ Al día (vinieron hace ≤${um.frio} d)`, nPor(PRED_REL.al_dia)],
    ['enfriando', `❄ Se enfrió (${um.frio + 1} a ${um.perdido} d sin venir)`, nPor(PRED_REL.enfriando)],
    ['perdido', `💤 Perdidos (+${um.perdido} d sin venir)`, nPor(PRED_REL.perdido)],
    ['en_grupo', '👥 En el grupo', nPor(PRED_REL.en_grupo)],
    ['listo_grupo', '👉 Listos para el grupo', nPor(PRED_REL.listo_grupo)],
    ['sin_grupo', 'Sin grupo todavía', nPor(PRED_REL.sin_grupo)],
  ];

  const opcDistrito = distritosCrm.map(([k, d]) => [k, `📍 ${d.label}`, d.n]);

  /**
   * VISTAS RÁPIDAS — las seis listas que Clarck abre de verdad.
   *
   * No agregan lógica: cada una es una combinación de los filtros que ya
   * existen, puesta a un toque. Se pintan con su cuenta al lado porque una
   * vista en cero no hay que abrirla — y esa es justo la información que uno
   * quiere antes de tocar, no después.
   *
   * `pred` es el mismo predicado con el que se cuenta, para que el número del
   * chip y la lista que se abre no puedan discrepar (el error clásico: el
   * contador dice 120 y la lista muestra 80).
   */
  // Etiquetas cortas a propósito: en un celular de 360 px, "Esperando
  // respuesta" ya se corta con puntos suspensivos y el chip deja de decir qué
  // abre. Las largas viven en el desplegable de Relación, que tiene el ancho.
  const VISTAS = [
    { id: 'esperando', etiqueta: '📥 Sin responder', qs: { filtro: 'esperando' },
      pred: (l) => numerosEsperando.has(l.numero) },
    { id: 'handoff', etiqueta: '🔔 Para Clarck', qs: { filtro: 'handoff' },
      pred: (l) => Boolean(l.handoff) },
    { id: 'listo_grupo', etiqueta: '👉 Mandar el link', qs: { rel: 'listo_grupo' },
      pred: PRED_REL.listo_grupo },
    { id: 'enfriando', etiqueta: '❄ Enfriándose', qs: { rel: 'enfriando' },
      pred: PRED_REL.enfriando },
    { id: 'casero', etiqueta: '⭐ Caseros', qs: { rel: 'casero' },
      pred: PRED_REL.casero },
    { id: 'nuevos', etiqueta: '🟢 Nuevos', qs: { filtro: 'nuevos' },
      pred: (l) => (l.creado_en || '').slice(0, 10) >= fechaLima(-6) },
  ];
  // Encendida solo si lo que está puesto es EXACTAMENTE la vista: sus dos
  // filtros y nada más. Con un "incluye" alcanzaba agregarle una zona para que
  // el chip siguiera encendido mostrando un subconjunto — el chip diría
  // "Caseros" y la lista serían los caseros de Comas.
  const sinOtrosFiltros = !zona && !distritoF && !dia && !q;
  const vistaActiva = (v) => sinOtrosFiltros && (v.qs.filtro || '') === filtro && (v.qs.rel || '') === relF;
  const vistasRapidas = VISTAS.map((v) => {
    const n = todos.filter(v.pred).length;
    const on = vistaActiva(v);
    const destino = on
      ? `/admin/leads?key=${key}&vista=crm`
      : `/admin/leads?key=${key}&vista=crm${v.qs.filtro ? `&filtro=${v.qs.filtro}` : ''}${v.qs.rel ? `&rel=${v.qs.rel}` : ''}`;
    return `<a class="vista${on ? ' on' : ''}${n === 0 ? ' cero' : ''}" href="${destino}">
      <span class="vt">${v.etiqueta}</span><span class="vn">${n}</span></a>`;
  }).join('');

  /**
   * Fila del CRM: DOS badges de posición fija.
   *
   * 1. RELACIÓN, siempre ("Casero · 9"). Está en todas las filas, así que dos
   *    filas se pueden comparar: eso es lo que hace útil una lista.
   * 2. ATENCIÓN, solo si aplica (Clarck / Sin responder / Frío · 47 d).
   *
   * Antes era un if-else de seis ramas —handoff, sin responder, recurrente, en
   * espera, etapa, zona— donde ganaba el que pegaba primero: una fila mostraba
   * su etapa, la de al lado su zona, y nada se podía comparar con nada. La
   * atención sigue siendo excluyente entre sí (si está derivado a Clarck, eso
   * es lo que hay que saber), pero ya no compite con la relación.
   */
  const fila = (l) => {
    const sr = sinResp(l);
    const m = mDe(l);
    const ultimo = db.getHistory(l.numero, 1)[0];
    const sub = l.handoff ? esc(l.handoff_motivo || 'derivado a Clarck')
      : ultimo && ultimo.rol === 'user' ? `"${esc((ultimo.texto || '').slice(0, 40))}"`
      : [l.distrito ? esc(l.distrito) : null, l.edad ? `${l.edad} años` : null].filter(Boolean).join(' · ') || 'sin datos aún';
    const fresc = frescuraLead(l);
    const dias = diasDe(l);
    const atencion = l.handoff ? '<span class="badge b-hand">🔔 Clarck</span>'
      : sr ? '<span class="badge b-wait">Sin responder</span>'
      : fresc && fresc !== 'al_dia'
        ? `<span class="badge ${COLOR_FRESCURA[fresc]}">${db.FRESCURAS[fresc].corto} · ${dias} d</span>`
        : '';
    return `<a class="lrow" href="/admin/leads?key=${key}&numero=${esc(l.numero)}">
      ${(l.handoff || sr) ? '<span class="dotnew" style="background:' + (l.handoff ? 'var(--st-alerta-solid)' : 'var(--st-debe-solid)') + '"></span>' : ''}
      <span class="ava" style="background:${avatarColor(l.numero)}">${esc(iniciales(l.nombre, l.numero))}</span>
      <span class="lbody"><span class="lname">${esc(l.nombre || 'Sin nombre')}</span><span class="lsub">${sub}</span></span>
      <span class="lmeta"><span class="ltime">${horaCorta(l.actualizado_en)}</span>
        <span class="lbadges">${badgeRelacion(db, m)}${atencion}</span></span>
      ${SVG.chev}</a>`;
  };

  const grupo = (titulo, arr) => arr.length
    ? `<div class="shdr">${titulo} · ${arr.length}</div><div class="llist">${arr.map(fila).join('')}</div>` : '';

  // Con filtro de día, la agrupación útil es quién escribió por primera vez ese
  // día y quién ya estaba. Ojo con la palabra: acá "ya estaban registrados" es
  // sobre MENSAJES, no sobre visitas — el que vuelve a jugar es "Vuelve"/
  // "Casero" y eso es el otro eje. Por eso el rótulo dice registrados y no
  // recurrentes, aunque el parámetro de la URL siga llamándose así.
  const lista = dia
    ? (leads.length
      ? grupo('🟢 Nuevos ese día', leads.filter(esNuevoEse)) + grupo('🔵 Ya estaban registrados', leads.filter((l) => !esNuevoEse(l)))
      : '<p class="vacio">Nadie escribió ese día ⚽</p>')
    : ((urgentes.length || resto.length)
      ? grupo('Necesitan tu atención ahora', urgentes) + grupo('Todos los contactos', resto)
      : `<p class="vacio">${Object.keys(query).some((k) => ['filtro', 'zona', 'rel', 'distrito', 'q'].includes(k))
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
        ${/* Buscar ya no borra los filtros puestos: antes la búsqueda mandaba
             solo `q` y la zona/etapa elegidas se perdían en silencio. */ ''}
        ${filtro ? `<input type="hidden" name="filtro" value="${esc(filtro)}">` : ''}
        ${zona ? `<input type="hidden" name="zona" value="${esc(zona)}">` : ''}
        ${relF ? `<input type="hidden" name="rel" value="${esc(relF)}">` : ''}
        ${distritoF ? `<input type="hidden" name="distrito" value="${esc(distritoF)}">` : ''}
        ${dia ? `<input type="hidden" name="dia" value="${esc(dia)}">` : ''}
        <input name="q" value="${esc(query.q || '')}" placeholder="Buscar nombre, número, distrito…">
        ${q ? '<button>Buscar</button>' : ''}
      </form>

      ${/* LAS SEIS LISTAS QUE SE ABREN DE VERDAD.
           Los filtros de abajo tienen 30 combinaciones posibles; en el día a
           día se usan seis, y armarlas cuesta dos desplegables cada vez. Acá
           van de un toque, con su cuenta al lado: si dice 0 no hace falta ni
           entrar. El orden es el de urgencia, no el alfabético — lo primero es
           gente esperando respuesta, lo último la foto de la base. */ ''}
      <div class="vistas">${vistasRapidas}</div>

      ${/* UNA barra con todo. El botón Filtrar va SIEMPRE visible: el
           onchange de cada select es mejora progresiva, y sin JS este botón
           es la única forma de aplicar lo elegido. */ ''}
      <form class="fbar" method="get" action="/admin/leads">
        <input type="hidden" name="key" value="${key}"><input type="hidden" name="vista" value="crm">
        ${query.q ? `<input type="hidden" name="q" value="${esc(query.q)}">` : ''}
        ${dia && tipo ? `<input type="hidden" name="tipo" value="${esc(tipo)}">` : ''}
        ${selectorFiltro('filtro', filtro, 'Todos los contactos', opcAtencion)}
        ${selectorFiltro('zona', zona, 'Todas las zonas', opcZona)}
        ${selectorFiltro('rel', relF, 'Toda relación', opcRelacion)}
        ${distritosCrm.length ? selectorFiltro('distrito', distritoF, 'Todos los distritos', opcDistrito) : ''}
        <input type="date" name="dia" value="${dia}" max="${hoy}" aria-label="Filtrar por día">
        <button class="btn-toque btn-guardar">Filtrar</button>
      </form>

      ${/* "Limpiar" aparece solo cuando hay algo que limpiar. El chip "Todos"
           que estaba siempre encendido no distinguía "sin filtro" de "con
           filtro puesto", que es justo lo que uno viene a mirar. */ ''}
      ${hayFiltro || dia ? `<div class="chips">
        <a class="fchip" href="/admin/leads?key=${key}&vista=crm">✕ Limpiar filtros</a>
        ${dia ? `<a class="fchip${tipo === 'nuevos' ? ' on' : ''}" href="/admin/leads?key=${key}&vista=crm${qsCrm({ tipo: tipo === 'nuevos' ? '' : 'nuevos' })}">🟢 Nuevos ese día</a>
        <a class="fchip${tipo === 'recurrentes' ? ' on' : ''}" href="/admin/leads?key=${key}&vista=crm${qsCrm({ tipo: tipo === 'recurrentes' ? '' : 'recurrentes' })}">🔵 Ya registrados</a>` : ''}
      </div>` : ''}
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
  const z = lead.zona ? { color: colorZona(lead.zona), nombre: db.nombreDeZona(lead.zona) } : null;

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
  const proximaInsc = inscripciones.filter((i) => i.fecha >= hoyF).sort((a, b) => a.fecha.localeCompare(b.fecha))[0];

  /**
   * LA LÍNEA DE VALOR: "Casero · 9 visitas · S/ 135 · última: 3 ago (hace 13 d)".
   *
   * Es lo que reemplaza a los seis botones de etapa. Antes la ficha te pedía
   * que declararas en qué escalón estaba el contacto; ahora te dice quién es
   * este tipo para el negocio, que es la pregunta que uno trae al abrirla.
   */
  const m = db.metricasDe(numero);
  const um = db.umbralesFrescura();
  const relClave = db.relacionDe(m.visitas);
  const refFrescura = m.ultima || (roles[numero] || {}).en || lead.actualizado_en || lead.creado_en;
  const diasSin = db.diasDesde(refFrescura);
  const frescClave = db.frescuraDe(diasSin, um);
  /**
   * LOS CUATRO NÚMEROS, FIJOS ARRIBA.
   *
   * Antes esto era una línea de texto corrido ("9 visitas · S/135 · última: 3
   * ago (hace 13 d)") y además se repetía como filas de "Historia" 300 px más
   * abajo. Dos lugares para el mismo dato, y ninguno de los dos se lee de un
   * vistazo con el pulgar. Ahora son cuatro cuadros de tamaño fijo: la fila se
   * puede comparar entre una ficha y otra, que es lo que uno hace de verdad.
   *
   * La relación y la frescura NO están acá: van como badges arriba, con su
   * color. Escribirlas dos veces le roba espacio a lo que sí falta saber.
   */
  const tile = (k, v, sub = '', color = '') => `
    <div class="hlc"><div class="hlk">${k}</div>
      <div class="hlv"${color ? ` style="color:${color}"` : ''}>${v}</div>
      ${sub ? `<div class="hls">${sub}</div>` : ''}</div>`;
  const destacados = `<div class="hl">
    ${tile('Visitas', m.visitas, m.visitas === 1 ? 'vino 1 vez' : 'veces que vino')}
    ${tile('Pagado', m.soles > 0 ? `S/ ${m.soles}` : '—',
      m.pagos > 0 ? `${m.pagos} Yape${m.pagos === 1 ? '' : 's'}` : 'nunca pagó',
      m.soles > 0 ? 'var(--lime-ink)' : '')}
    ${tile('Última', m.ultima ? esc(fechaCompacta(m.ultima, false, false)) : '—',
      m.ultima ? `hace ${diasSin} d` : (diasSin != null ? `escribió hace ${diasSin} d` : 'sin registro'),
      frescClave && frescClave !== 'al_dia' ? 'var(--st-alerta-ink)' : '')}
    ${tile('Próxima', proximaInsc ? esc(fechaCompacta(proximaInsc.fecha, true, false)) : '—',
      proximaInsc
        ? `${esc(proximaInsc.hora || '')}${proximaInsc.estado === 'pagado' ? ' · pagado' : ` · ${esc(proximaInsc.estado)}`}`
        : 'sin reserva',
      proximaInsc ? 'var(--lime-ink)' : '')}
  </div>`;

  // "Próximo partido" y "Total pagado" ya no viven acá: subieron a los cuatro
  // cuadros de arriba. Lo que queda es lo que ellos no dicen — desde cuándo
  // existe este contacto y si ya está en el grupo.
  const historia = {
    primer: lead.creado_en ? `${fechaCompacta(lead.creado_en)} · lo captó el bot` : '—',
  };

  // "En el grupo": el único hecho que el sistema no puede deducir solo. El
  // botón aparece SOLO si la zona tiene link cargado — sin link nadie pudo
  // haber mandado nada, y un botón que no corresponde es una invitación a
  // ensuciar el dato.
  const linkZona = lead.zona ? (db.getConfigMap()[`grouplink_${lead.zona}`] || '').trim() : '';
  const filaGrupo = lead.grupo_enviado_en
    ? `<div class="grow"><span class="k">En el grupo</span><span class="v" style="color:var(--lime-ink)">Sí · ${esc(fechaCompacta(lead.grupo_enviado_en, false, false))}</span></div>`
    : `<div class="grow"><span class="k">En el grupo</span><span class="v">No${linkZona ? '' : ' · su zona no tiene link cargado'}</span></div>
       ${linkZona ? `<form method="post" action="/admin/lead/grupo" class="inline">
          <input type="hidden" name="key" value="${esc(keyRaw)}"><input type="hidden" name="numero" value="${esc(numero)}">
          <button class="btn-toque" style="width:100%;background:var(--surface-2);color:var(--ink);border:1.5px solid var(--line-strong)">👥 Le mandé el link</button>
        </form>` : ''}`;

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
          ${z ? `<span class="pz" style="background:${z.color}">${esc(z.nombre)}</span>` : ''}
          ${lead.handoff ? `<span class="pz" style="background:var(--st-alerta-solid)">🔔 ${esc(lead.handoff_motivo || 'derivado')}</span>` : ''}
          ${sinResp ? '<span class="pz" style="background:var(--st-debe-solid)">📥 Sin responder</span>' : ''}
        </div>
        ${/* Una línea, no seis botones. Todo lo de acá está calculado: no hay
              nada que apretar ni que mantener al día. */ ''}
        <div class="valor">
          <span class="badge ${COLOR_RELACION[relClave]}">${relClave === 'casero' ? '⭐ ' : ''}${db.RELACIONES[relClave].label}</span>
          ${frescClave && frescClave !== 'al_dia' ? `<span class="badge ${COLOR_FRESCURA[frescClave]}">${db.FRESCURAS[frescClave].label}</span>` : ''}
        </div>
        ${destacados}
      </div>

        <div>
          <div class="shdr">Perfil</div>
          <div class="group">
            ${dato('Edad', lead.edad)}
            ${dato('Distrito', lead.distrito)}
            ${dato('Zona', (z && z.nombre) || lead.zona, z && z.color)}
          </div>
        </div>

        <div class="ancla" id="grupo">
          <div class="shdr">Historia <small>· lo que el sistema sabe de él</small></div>
          <div class="group">
            ${dato('Primer contacto', historia.primer)}
            ${filaGrupo}
          </div>
        </div>

        ${lead.handoff ? `<form method="post" action="/admin/lead/reactivar">
          <input type="hidden" name="key" value="${esc(keyRaw)}"><input type="hidden" name="numero" value="${esc(numero)}">
          <button class="btn-toque btn-guardar" style="width:100%;min-height:var(--tap-lg);font-size:var(--t-l)">🔓 Reactivar el bot para este contacto</button>
        </form>` : ''}

        <div class="ancla" id="etiquetas">
          <div class="shdr">Etiquetas <small>(separadas por coma)</small></div>
          <div class="group"><form class="inline" method="post" action="/admin/lead/etiquetas">
            <input type="hidden" name="key" value="${esc(keyRaw)}"><input type="hidden" name="numero" value="${esc(numero)}">
            <input name="etiquetas" value="${esc(lead.etiquetas || '')}" placeholder="casero, paga efectivo, VIP…">
            <button>Guardar</button>
          </form></div>
        </div>

${/* "Próxima acción" (fecha + nota) se retiró el 16/08: era un recordatorio que
      no recordaba nada — no mandaba WhatsApp ni correo, solo pintaba una
      etiqueta y alimentaba un filtro que había que ir a mirar. Para lo
      accionable están los avisos y el resumen de derivados; para el resto, las
      Notas. Va como comentario de JS y no de HTML: un <!-- --> se lo lleva el
      navegador en cada carga. */ ''}
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

  /**
   * EL INTERRUPTOR DEL BOT — el control más consecuente del producto.
   *
   * Apagar y encender NO son simétricos y la pantalla lo dice:
   *   · apagar → un botón, sin preguntas (es la salida de emergencia).
   *   · encender → escribir la palabra ENCENDER + tildar el ensayo previo, con
   *     la consecuencia contada en el número REAL de contactos ("934"), no en
   *     un "todos los usuarios" que no se siente.
   * Escribir una palabra cuesta intención; un checkbox o un confirm() se
   * despachan con el pulgar sin leer. Y todo se valida en el servidor porque
   * sin JS un confirm no existe.
   */
  const estadoDelBot = db.estadoBot();
  const totalContactos = db.stats().leads;
  const cuandoBot = estadoDelBot.encendido ? estadoDelBot.encendidoEn : estadoDelBot.apagadoEn;
  const bloqueBot = `
    <div class="ancla" id="bot">
      <div class="shdr">${estadoDelBot.encendido ? '🤖 El bot está ENCENDIDO' : '🔒 El bot está APAGADO'} <small>· quién recibe respuestas automáticas</small></div>
      <div class="group" style="border-left:6px solid ${estadoDelBot.encendido ? 'var(--lime)' : 'var(--st-debe-solid)'}">
        <p style="padding:14px 14px 0;font-size:13.5px;color:var(--ink-2);line-height:1.5">
          ${estadoDelBot.encendido
            ? `El bot le responde a <b>cualquiera</b> de los ${totalContactos} contactos que escriba al número.`
            : `Ahora mismo el bot <b>registra todo</b> lo que llega (nombre, distrito, comprobantes) pero <b>no le responde a nadie</b>, salvo a los números de prueba de abajo. Es el estado seguro.`}
          ${cuandoBot ? `<br><small style="color:var(--ink-3)">${estadoDelBot.encendido ? 'Encendido' : 'Apagado'} el ${esc(fechaCompacta(cuandoBot, true, false))} a las ${esc(String(cuandoBot).slice(11, 16))}${estadoDelBot.por ? ` desde ${esc(estadoDelBot.por)}` : ''}.</small>` : ''}
          ${estadoDelBot.fuente === 'entorno' ? '<br><small style="color:var(--ink-3)">Todavía manda la configuración del servidor; en cuanto toques este interruptor pasa a mandar lo que decidas acá.</small>' : ''}
        </p>
        ${estadoDelBot.encendido ? `
        <form method="post" action="/admin/config/bot" style="padding:14px">
          <input type="hidden" name="key" value="${esc(keyRaw)}"><input type="hidden" name="accion" value="apagar">
          <button class="btn-toque" style="width:100%;min-height:var(--tap-lg);font-size:var(--t-l);background:var(--st-alerta-bg);color:var(--st-alerta-ink);border:1.5px solid var(--st-alerta-ink)">⏸ Apagar el bot</button>
          <div style="font-size:var(--t-s);color:var(--ink-2);margin-top:9px;text-align:center">
            Deja de responder al instante. No se pierde nada: todo lo que llegue se sigue registrando.
          </div>
        </form>` : `
        <form method="post" action="/admin/config/bot" style="padding:0 14px 14px">
          <input type="hidden" name="key" value="${esc(keyRaw)}"><input type="hidden" name="accion" value="encender">
          <div style="background:var(--surface-2);border:1px solid var(--line-strong);border-radius:var(--r2);padding:12px 13px;margin:6px 0 13px">
            <div style="font-weight:700;font-size:var(--t-m);margin-bottom:8px">Antes de encenderlo</div>
            <label style="display:flex;gap:10px;align-items:flex-start;padding:7px 0;font-size:var(--t-m);line-height:1.4">
              <input type="checkbox" name="ensayo_prueba" value="1" style="width:20px;height:20px;flex:0 0 auto;margin-top:1px">
              <span>Le escribí al bot desde <b>mi propio número</b> y me contestó como esperaba
                <small style="display:block;color:var(--ink-2)">Tu número tiene que estar en "Números de prueba", abajo.</small></span>
            </label>
            <label style="display:flex;gap:10px;align-items:flex-start;padding:7px 0;font-size:var(--t-m);line-height:1.4">
              <input type="checkbox" name="ensayo_bienvenida" value="1" style="width:20px;height:20px;flex:0 0 auto;margin-top:1px">
              <span>Leí el <b>mensaje de bienvenida</b> que reciben los nuevos
                <small style="display:block;color:var(--ink-2)">Está más abajo, en "El negocio".</small></span>
            </label>
            <label style="display:flex;gap:10px;align-items:flex-start;padding:7px 0;font-size:var(--t-m);line-height:1.4">
              <input type="checkbox" name="ensayo_mecanica" value="1" style="width:20px;height:20px;flex:0 0 auto;margin-top:1px">
              <span>Leí <b>la mecánica</b> que el bot explica cuando preguntan cómo funciona</span>
            </label>
          </div>
          <div style="background:var(--st-debe-bg);border-radius:var(--r2);padding:12px 13px;font-size:var(--t-m);line-height:1.5;color:var(--st-debe-ink);margin-bottom:13px">
            Al encenderlo, el bot empieza a responderles solo a los <b>${totalContactos} contactos registrados</b>.
            Los mensajes que salgan no se pueden deshacer.
          </div>
          ${campo('bot-confirmar', 'Escribe ENCENDER para confirmar',
            '<input id="bot-confirmar" name="confirmacion" placeholder="ENCENDER" autocomplete="off" autocapitalize="characters" spellcheck="false">',
            'A propósito se escribe con el teclado: es la única acción del panel que le habla a todo el mundo.', true)}
          <button class="btn-toque btn-guardar" style="width:100%;min-height:var(--tap-lg);font-size:var(--t-l);margin-top:4px">🤖 Encender el bot para todos</button>
        </form>`}
      </div>
    </div>`;

  /** A qué número van los avisos + el botón que prueba que de verdad llegan. */
  const numeroAvisos = db.numeroAvisos();
  const probadoEn = db.avisosProbadoEn();
  const testers = db.numerosDePrueba();
  const bloqueAvisos = `
    <div class="ancla" id="avisos">
      <div class="shdr">🔔 Avisos y números de prueba <small>· a quién le escribe el bot cuando algo necesita a Clarck</small></div>
      <div class="group">
        <form method="post" action="/admin/config/avisos">
          <input type="hidden" name="key" value="${esc(keyRaw)}">
          <div class="campos">
            ${campo('av-numero', 'Número que recibe los avisos',
              `<input id="av-numero" name="notify_numero" value="${esc(numeroAvisos)}" inputmode="tel" placeholder="51999888777">`,
              `Con código de país y sin espacios. Por acá salen los derivados, los pagos por revisar y las listas de espera. ${
                numeroAvisos
                  ? (probadoEn
                    ? `<b style="color:var(--lime-ink)">Probado el ${esc(fechaCompacta(probadoEn, true, false))}: los avisos llegan.</b>`
                    : '<span class="falta">Todavía sin probar: si el número está mal, los avisos no llegan y no da ningún error.</span>')
                  : '<span class="falta">Sin número, los avisos solo salen por correo.</span>'
              }`, true)}
            ${campo('av-testers', 'Números de prueba',
              `<input id="av-testers" name="testers" value="${esc(testers.join(','))}" inputmode="tel" placeholder="51999888777,51988777666">`,
              'Separados por coma. Con el bot apagado, estos son los ÚNICOS a los que sí les responde: es el ensayo antes de encenderlo.', true)}
          </div>
          <div class="pie-form">
            <button class="btn-toque btn-guardar">Guardar</button>
          </div>
        </form>
        ${numeroAvisos ? `
        <form method="post" action="/admin/config/avisos/probar" style="padding:0 14px 14px">
          <input type="hidden" name="key" value="${esc(keyRaw)}">
          <button class="btn-toque" style="width:100%;min-height:var(--tap);background:var(--surface-2);color:var(--ink);border:1.5px solid var(--line-strong)">📲 Mandarme un aviso de prueba ahora</button>
          <div style="font-size:var(--t-s);color:var(--ink-2);margin-top:9px;text-align:center">
            Manda un WhatsApp de verdad al +${esc(numeroAvisos)}. Si no lo recibes, el número está mal.
          </div>
        </form>` : ''}
      </div>
    </div>`;

  /**
   * LOS DOS CORREOS, SEPARADOS.
   *
   * Compartían una sola variable, y por ese correo sale el respaldo COMPLETO de
   * la base: la conversación de 900+ personas. Un aviso puede ir a cualquier
   * casilla; el .db no. El default de los dos sigue siendo la casilla de KIPI
   * (decisión del cliente); lo que cambia es que ahora está a la vista.
   */
  const bloqueCorreos = `
    <div class="ancla" id="correos">
      <div class="shdr">📧 Correos <small>· los avisos y el respaldo de la base van por separado</small></div>
      <div class="group">
        <form method="post" action="/admin/config/correos">
          <input type="hidden" name="key" value="${esc(keyRaw)}">
          <div class="campos">
            ${campo('mail-avisos', 'Correo para los AVISOS',
              `<input id="mail-avisos" name="aviso_email" type="email" value="${esc(c.aviso_email || '')}" placeholder="${esc(backup.paraAvisos() || 'sin configurar')}" inputmode="email">`,
              `Derivados, pagos por revisar, cerebro caído, salud de la cuenta. Vacío = la casilla de KIPI (<b>${esc(backup.paraAvisos() || 'sin configurar')}</b>).`, true)}
            ${campo('mail-backup', 'Correo para el RESPALDO de la base',
              `<input id="mail-backup" name="backup_email" type="email" value="${esc(c.backup_email || '')}" placeholder="${esc(backup.paraRespaldo() || 'sin configurar')}" inputmode="email">`,
              `Acá llega el archivo con <b>toda</b> la base: los ${totalContactos} contactos y sus conversaciones completas. Trátalo como lo que es. Vacío = la casilla de KIPI (<b>${esc(backup.paraRespaldo() || 'sin configurar')}</b>).`, true)}
          </div>
          <div class="pie-form">
            <button class="btn-toque btn-guardar">Guardar los correos</button>
          </div>
        </form>
      </div>
    </div>`;

  /** Cuántas visitas hacen a un Casero: regla del negocio, no del código. */
  const umbralCasero = db.recurrenteDesde();
  const metCasero = Object.values(db.metricasPorNumero());
  const topeVisitas = metCasero.reduce((m, x) => Math.max(m, x.visitas || 0), 0);
  const caserosHoy = metCasero.filter((m) => m.visitas >= umbralCasero).length;
  const bloqueCasero = `
    <div class="ancla" id="casero">
      <div class="shdr">⭐ Cuándo alguien es "Casero" <small>· cuántas visitas hacen a un habitual</small></div>
      <div class="group">
        <form method="post" action="/admin/config/casero">
          <input type="hidden" name="key" value="${esc(keyRaw)}">
          <p style="padding:13px 14px 0;font-size:13.5px;color:var(--ink-2);line-height:1.45">
            Una <b>visita</b> es un día que vino (Yape confirmado o partido jugado).
            ${topeVisitas < umbralCasero
              ? `<b>Hoy nadie llega:</b> el que más vino tiene ${topeVisitas} visita${topeVisitas === 1 ? '' : 's'} y el corte está en ${umbralCasero}, así que el filtro "Caseros" te muestra <b>cero</b>. Bájalo para ver a tu gente.`
              : `Con el corte en ${umbralCasero} tienes <b>${caserosHoy} casero${caserosHoy === 1 ? '' : 's'}</b> (el que más vino tiene ${topeVisitas} visitas).`}
          </p>
          <div class="campos">
            ${campo('cfg-casero', 'Es casero desde (visitas)',
              `<input id="cfg-casero" name="recurrente_desde" type="number" min="2" max="50" inputmode="numeric" value="${umbralCasero}">`,
              'Cambia el filtro "Caseros", el embudo del Resumen y la hoja de Google. No se borra ni se avisa nada.')}
          </div>
          <div class="pie-form">
            <button class="btn-toque btn-guardar">Guardar</button>
          </div>
        </form>
      </div>
    </div>`;

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

  /**
   * Cuándo se enfría un jugador. Los dos cortes que definen la frescura de toda
   * la base viven acá y no en el código: el ritmo de una pichanga semanal no es
   * el de una quincenal, y eso lo sabe Clarck. Se guardan por el mismo camino
   * que los precios y los links (setConfig con lista blanca).
   */
  const umCfg = db.umbralesFrescura();
  const bloqueFrescura = `
    <div class="ancla" id="frescura">
      <div class="shdr">❄ Cuándo se enfría un jugador <small>· los cortes de "Salud de la base"</small></div>
      <div class="group">
        <form method="post" action="/admin/config/general">
          <input type="hidden" name="key" value="${esc(keyRaw)}">
          <p style="padding:13px 14px 0;font-size:13.5px;color:var(--ink-2);line-height:1.45">
            Se cuentan los días <b>desde la última vez que vino</b> (Yape confirmado o partido jugado).
            Hasta el primer corte está <b>al día</b>; entre los dos, <b>enfriándose</b>; pasado el segundo,
            <b>perdido</b>. Nada se borra ni se avisa solo: cambia cómo se agrupa en el Resumen y en Jugadores.
          </p>
          <div class="campos">
            ${campo('cfg-frio', 'Se está enfriando a los (días)',
              `<input id="cfg-frio" name="dias_frio" type="number" min="1" max="365" inputmode="numeric" value="${umCfg.frio}">`,
              'Vino hace más de esto y todavía se recupera con un mensaje.')}
            ${campo('cfg-perdido', 'Se da por perdido a los (días)',
              `<input id="cfg-perdido" name="dias_perdido" type="number" min="2" max="730" inputmode="numeric" value="${umCfg.perdido}">`,
              'Tiene que ser mayor que el anterior; si no, se ajusta solo.')}
          </div>
          <div class="pie-form">
            <button class="btn-toque btn-guardar">Guardar cortes</button>
          </div>
        </form>
      </div>
    </div>`;

  /**
   * LA GRACIA: cuánto tiempo después del partido se siguen aceptando Yapes.
   *
   * Es el dato que reemplaza a "no cerramos nunca". Antes la única forma de no
   * perder el Yape que llega a las 11 de la noche era dejar el partido abierto
   * para siempre — y así quedaron 16 partidos jugados figurando como si
   * todavía se pudiera entrar. Ahora es un número, y lo pone el que conoce a
   * su gente.
   */
  const bloqueGracia = `
    <div class="ancla" id="gracia">
      <div class="shdr">⏱ Yapes tardíos <small>· hasta cuándo un partido sigue aceptando pagos</small></div>
      <div class="group">
        <form method="post" action="/admin/config/general">
          <input type="hidden" name="key" value="${esc(keyRaw)}">
          <p style="padding:13px 14px 0;font-size:13.5px;color:var(--ink-2);line-height:1.45">
            Pasado el partido, la inscripción y los pagos siguen entrando durante estas horas: es el rato en que
            llegan los Yapes de los que jugaron y pagaron después. Cumplido el plazo, el partido pasa a
            <b>"por liquidar"</b> — no se borra nada y siempre lo puedes reabrir.
          </p>
          <div class="campos">
            ${campo('cfg-gracia', 'Horas después del partido',
              `<input id="cfg-gracia" name="gracia_horas" type="number" min="1" max="336" inputmode="numeric" value="${db.graciaHoras()}">`,
              'Por defecto 24 h: el Yape del domingo de noche entra el lunes.')}
          </div>
          <div class="pie-form">
            <button class="btn-toque btn-guardar">Guardar</button>
          </div>
        </form>
      </div>
    </div>`;

  /**
   * El plazo de la reserva sin pagar. Va pegado al bloque de Yapes tardíos
   * porque son las dos mitades de la misma pregunta: cuánto esperamos la plata
   * antes, y cuánto después.
   */
  const bloqueReserva = `
    <div class="ancla" id="reserva">
      <div class="shdr">🔒 Cupos guardados <small>· cuánto se guarda un cupo sin Yape</small></div>
      <div class="group">
        <form method="post" action="/admin/config/general">
          <input type="hidden" name="key" value="${esc(keyRaw)}">
          <p style="padding:13px 14px 0;font-size:13.5px;color:var(--ink-2);line-height:1.45">
            Cuando alguien le dice al bot "anótame", el cupo le queda <b>guardado</b> estos minutos.
            Si no llega el Yape, el lugar se libera solo y entra el primero de la lista de espera.
            Lo que anotas <b>tú</b> desde el panel no vence nunca. Con <b>0</b> los cupos se guardan
            para siempre, como antes.
          </p>
          <div class="campos">
            ${campo('cfg-reserva', 'Minutos que se guarda el cupo',
              `<input id="cfg-reserva" name="reserva_minutos" type="number" min="0" max="10080" inputmode="numeric" value="${db.reservaMinutos()}">`,
              'Por defecto 60 min. Es el rato que tarda alguien en abrir el Yape y mandar la captura.')}
          </div>
          <div class="pie-form">
            <button class="btn-toque btn-guardar">Guardar</button>
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

      ${/* El interruptor primero: es lo más consecuente de esta pantalla y lo
             que Clarck viene a buscar el día que quiere encender o apagar. */ ''}
      ${bloqueBot}
      ${bloqueAvisos}
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
              ${campo('g-yape-otros', 'Tus otros Yapes',
                `<input id="g-yape-otros" name="yape_otros" value="${esc(c.yape_otros || '')}" inputmode="tel" placeholder="987654321, 050">`,
                'Separados por coma. Si cobras por más de un número, ponlos acá: el pago a cualquiera de ellos se confirma igual, en vez de quedar "por revisar". Vale con los últimos dígitos.', true)}
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

      ${bloqueCorreos}
      ${bloqueCorte}
      ${bloqueCasero}
      ${bloqueFrescura}
      ${bloqueGracia}
      ${bloqueReserva}
      ${zonasOp.map((z) => bloqueZona(z)).join('')}
      ${nuevoDistrito}

      <div class="foot">⚽ Pichangueros · Config</div>
    </div>
  `, { refresh: false, activo: 'config', key, aviso: query });
}

// ==============================================================================
//  Vista PARTIDOS — convocatorias, inscripciones, lista de espera, asistencia
// ==============================================================================
const ESTADOS_INSC = { pagado: 'Pagado ✅', reservado: 'Reservado', espera: 'En espera ⏳', baja: 'Baja' };
// Cómo se pinta cada fase. La fase la calcula db.js (fasePartido) — acá solo
// vive el color, para que el panel no pueda contar una historia distinta a la
// que cuenta el bot.
const COLOR_FASE = {
  proximo: 'est-ok', en_curso: 'est-ok', gracia: 'est-debe',
  por_liquidar: 'est-debe', cerrado: 'est-off', liquidado: 'est-off', cancelado: 'est-off',
};

/**
 * VISTA PARTIDOS — una SEMANA, no una lista plana.
 *
 * El negocio se piensa por semana ("los domingos 6pm en el Politécnico"), y es
 * en una semana donde un duplicado o un hueco se ven solos. La lista plana
 * ordenada por fecha descendente mostraba el mes entero y no dejaba ver que el
 * domingo que viene no tenía nada cargado — que es exactamente lo que pasó el
 * 15/08: se vendió un partido que no existía.
 */
function paginaPartidos(db, key, query = {}) {
  const keyRaw = decodeURIComponent(key);
  const partidoId = Number(query.partido) || null;
  if (partidoId) return paginaPartidoDetalle(db, key, keyRaw, partidoId, query);

  // Al abrir la vista se materializan los turnos activos. Es idempotente y no
  // toca el camino caliente del bot (partidosAbiertos sigue siendo una lectura
  // pura): acá sí, porque es la pantalla donde Clarck viene a ver la semana y
  // tiene que estar completa cuando la mira.
  try { db.generarPartidosDeTurnos(); } catch (e) { console.error('[turnos] No se pudieron generar:', e.message); }

  const neg = db.getNegocio();
  const hoy = hoyLima();
  const todosPartidos = db.listPartidos();

  // Navegación por semanas: 0 = la que empieza HOY. La semana arranca hoy y no
  // el lunes a propósito — a Clarck le importa "de acá para adelante", no el
  // calendario.
  const semana = Math.max(-8, Math.min(8, Number(query.semana) || 0));
  const desde = db.sumarDias(hoy, semana * 7);
  const dias = Array.from({ length: 7 }, (_, i) => db.sumarDias(desde, i));
  const hasta = dias[6];

  const porFecha = {};
  for (const p of todosPartidos) (porFecha[p.fecha] ||= []).push(p);
  for (const f of Object.keys(porFecha)) porFecha[f].sort((a, b) => (a.inicio_min ?? 9999) - (b.inicio_min ?? 9999));

  const huecos = db.diasSinCargar({ dias: Math.max(14, (semana + 1) * 7) });
  const porLiquidar = db.partidosPorLiquidar();
  const vacios = db.partidosArchivables();
  const conflictos = db.conflictosDePartidos();
  const soles = (n) => `S/ ${Number(n || 0).toLocaleString('es-PE', { maximumFractionDigits: 2 })}`;

  const fila = (p) => {
    const zonaNombre = db.nombreDeZona(p.zona);
    const lleno = p.ocupados >= p.cupo;
    // "Lleno" se decía SOLO pintando el "12/14" de ámbar en vez de verde: con
    // daltonismo rojo-verde los dos son el mismo marrón, y a contraluz tampoco
    // se distinguen. Ahora la palabra está escrita y el chip trae su glifo.
    const chipCupos = lleno
      ? `<span class="est est-lleno">${p.ocupados}/${p.cupo} lleno</span>`
      : `<span class="est est-ok">${p.ocupados}/${p.cupo} · ${p.cupo - p.ocupados} libre${p.cupo - p.ocupados === 1 ? '' : 's'}</span>`;
    return `<a class="lrow" href="/admin/leads?key=${key}&vista=partidos&partido=${p.id}">
      <span class="pfecha"><b>${esc(p.hora ? p.hora.split('-')[0] : '—')}</b><small>${esc(p.hora ? (/am/i.test(p.hora) ? 'am' : 'pm') : 'sin hora')}</small></span>
      <span class="lbody">
        <span class="lname">${esc(zonaNombre)}${p.turno_id ? ' <small style="font-weight:600;color:var(--ink-3)">· turno fijo</small>' : ''}</span>
        <span class="lsub">${esc(p.sede || 'Sede por definir')} · S/ ${esc(p.precio ?? neg.zonas[p.zona]?.precio ?? '?')}</span>
        <span class="pchips">
          ${chipCupos}
          <span class="est ${COLOR_FASE[p.fase] || 'est-off'}">${esc(db.FASES[p.fase].corto)}</span>
          ${p.pagados ? `<span class="est est-ok">${p.pagados} pagados</span>` : ''}
          ${p.en_espera ? `<span class="est est-debe">${p.en_espera} en espera</span>` : ''}
        </span>
      </span>
      ${SVG.chev}
    </a>`;
  };

  /** Un día de la grilla: sus partidos, o el hueco con el aviso de costumbre. */
  const bloqueDia = (fecha) => {
    const delDia = (porFecha[fecha] || []).filter((p) => p.fase !== 'cancelado' || p.ocupados || p.en_espera);
    const huecosDia = huecos.filter((h) => h.fecha === fecha);
    const esHoy = fecha === hoy;
    const nombreDia = db.DIAS_NOMBRE[db.diaSemanaDe(fecha)];
    return `
      <div class="shdr" style="${esHoy ? 'color:var(--lime-ink)' : ''}">
        ${esHoy ? 'HOY · ' : ''}${esc(nombreDia)} ${Number(fecha.slice(8, 10))} ${esc(mesCorto(fecha))}
        <small>· <a style="color:var(--lime-ink)" href="/admin/leads?key=${key}&vista=partidos&dia=${fecha}#abrir">+ abrir</a></small>
      </div>
      <div class="group">
        ${delDia.map(fila).join('')}
        ${huecosDia.map((h) => `
          <div class="prow" style="border-bottom:0">
            <span class="pico2">📅</span>
            <span class="ptxt"><b>Nada cargado a las ${esc(h.hora)} en ${esc(db.nombreDeZona(h.zona))}</b>
              <small>${h.cancelado ? 'Este día está cancelado.' : `Los últimos ${h.veces} ${esc(db.diaPlural(h.dia_nombre))} jugaste a esta hora${h.sede ? ` en ${esc(h.sede)}` : ''}. Si lo vendes por WhatsApp no habrá dónde anotarlo.`}</small></span>
            ${h.cancelado ? '' : `<a class="pcta" href="/admin/leads?key=${key}&vista=partidos&dia=${fecha}&hora=${encodeURIComponent(h.hora)}&zona=${encodeURIComponent(h.zona)}#abrir">Cargarlo ›</a>`}
          </div>`).join('')}
        ${!delDia.length && !huecosDia.length ? '<p style="padding:12px 14px;color:var(--ink-3);font-size:14px">Sin pichangas este día.</p>' : ''}
      </div>`;
  };

  // Cola de cierre: lo que terminó y todavía necesita algo de Clarck.
  const bloqueLiquidar = (porLiquidar.length || vacios.length) ? `
      <div class="shdr ancla" id="liquidar">Terminados <small>· cuenta la plata y archiva lo que ya es historia</small></div>
      ${porLiquidar.length ? `<div class="group">
        ${porLiquidar.map((p) => `<a class="lrow" href="/admin/leads?key=${key}&vista=partidos&partido=${p.id}#liquidacion">
          <span class="pfecha"><b>${esc(p.fecha.slice(8, 10))}</b><small>${esc(mesCorto(p.fecha))}</small></span>
          <span class="lbody">
            <span class="lname">${esc(db.nombreDeZona(p.zona))}${p.hora ? ` · ${esc(p.hora)}` : ''}</span>
            <span class="lsub">${p.ocupados} jugador${p.ocupados === 1 ? '' : 'es'} · cobrado ${soles(p.caja ? p.caja.cobrado : 0)}${p.caja && p.caja.porCobrar > 0 ? ` · falta ${soles(p.caja.porCobrar)}` : ''}</span>
            <span class="pchips"><span class="est ${p.caja && p.caja.porCobrar > 0 ? 'est-debe' : 'est-ok'}">${p.caja && p.caja.porCobrar > 0 ? 'falta cobrar' : 'todo cobrado'}</span></span>
          </span>
          ${SVG.chev}
        </a>`).join('')}
      </div>` : ''}
      ${vacios.length ? `
      <form method="post" action="/admin/partidos/archivar-vacios" class="group" style="padding:14px;margin-top:10px">
        <input type="hidden" name="key" value="${esc(keyRaw)}">
        <div style="font-size:var(--t-s);color:var(--ink-2);line-height:1.45;margin-bottom:10px">
          <b>${vacios.length} partido${vacios.length === 1 ? '' : 's'} terminado${vacios.length === 1 ? '' : 's'} para archivar</b> (${vacios.slice(0, 4).map((p) => esc(fechaCompacta(p.fecha, false, false))).join(' · ')}${vacios.length > 4 ? ` y ${vacios.length - 4} más` : ''}).
          ${(() => { const conGente = vacios.length - vacios.filter((p) => (p.ocupados + p.en_espera) === 0).length;
            // Decir "vacíos" de un partido con 10 inscritos y 9 pagados sería
            // mentirle: lo archiva creyendo que no había nadie. Los de antes
            // del arranque SÍ tuvieron gente; lo que dice el corte es que ya
            // son historia, no que estuvieran vacíos.
            return conGente
              ? `${vacios.length - conGente} terminaron sin nadie inscrito y ${conGente} son anteriores al punto de arranque (ya jugados, con su gente adentro). Archivar es darlos por cerrados.`
              : 'No hay plata que contar: se archivan todos juntos.'; })()}
        </div>
        <button class="btn-toque" style="width:100%;min-height:var(--tap);background:var(--surface-2);color:var(--ink);border:1.5px solid var(--line-strong)">🧹 Archivar los ${vacios.length} terminados</button>
      </form>` : ''}` : '';

  const bloqueConflictos = conflictos.length ? `
      <div class="banner px" style="margin:0 0 14px">
        <div class="bic">⚠️</div>
        <div class="btxt"><b>${conflictos.length} partido${conflictos.length === 1 ? '' : 's'} duplicado${conflictos.length === 1 ? '' : 's'} con gente en las DOS listas.</b>
          ${esc(conflictos.join(' · '))}. Nadie los junta solo: entra a cada uno, decide cuál es la lista buena y da de baja la otra.</div>
      </div>` : '';

  // --- Turnos fijos: la plantilla de la que salen las fechas -------------------
  const turnos = db.listTurnos();
  const sugeridos = db.turnosSugeridos();
  const sedesTodas = db.listSedes();
  const filaTurno = (t) => `
    <div class="finsc">
      <div style="flex:1;min-width:150px">
        <div style="font-weight:700;font-size:var(--t-m)">${esc(db.diaPlural(t.dia_nombre.charAt(0).toUpperCase() + t.dia_nombre.slice(1)))} · ${esc(t.hora)}</div>
        <div style="font-size:var(--t-s);color:var(--ink-2);margin-top:3px">
          ${esc(db.nombreDeZona(t.zona))}${t.sede_nombre ? ` · ${esc(t.sede_nombre)}` : ''} · ${t.cupo} cupos${t.precio != null ? ` · S/ ${esc(t.precio)}` : ''}
        </div>
        <div style="margin-top:5px">
          <span class="badge ${t.activo ? 'b-done' : 'b-new'}">${t.activo ? `Activo · carga ${db.HORIZONTE_DIAS} días` : 'Pausado'}</span>
          ${t.nota ? `<span class="badge b-new">${esc(t.nota)}</span>` : ''}
        </div>
      </div>
      <div class="finsc-acc">
        <form method="post" action="/admin/turno/activo" style="display:inline">
          <input type="hidden" name="key" value="${esc(keyRaw)}"><input type="hidden" name="id" value="${t.id}"><input type="hidden" name="activo" value="${t.activo ? '0' : '1'}">
          <button class="btn-fila" style="${t.activo
            ? 'background:var(--surface-2);color:var(--ink-2);border:1.5px solid var(--line-strong)'
            : 'background:var(--st-ok-bg);color:var(--st-ok-ink);border:1.5px solid var(--st-ok-ink)'}">${t.activo ? '⏸ Pausar' : '▶ Encender'}</button>
        </form>
      </div>
      <div class="finsc-peligro">
        <form method="post" action="/admin/turno/eliminar" style="display:inline" onsubmit="return confirm('¿Borrar este turno fijo? Los partidos ya cargados no se tocan.')">
          <input type="hidden" name="key" value="${esc(keyRaw)}"><input type="hidden" name="id" value="${t.id}">
          <button class="btn-fila" style="background:var(--st-alerta-bg);color:var(--st-alerta-ink);border:1.5px solid var(--st-alerta-ink)">🗑</button>
        </form>
      </div>
    </div>`;

  const bloqueTurnos = `
      <div class="shdr ancla" id="turnos">Turnos fijos <small>· la plantilla, no el partido</small></div>
      <div class="group">
        ${turnos.length ? turnos.map(filaTurno).join('')
          : '<p style="padding:14px;color:var(--ink-3);font-size:14px">Todavía no hay turnos fijos. Un turno es "todos los domingos 6pm en el Politécnico": encendido, carga solo las próximas dos semanas.</p>'}
      </div>
      ${sugeridos.length ? `
      <div class="group" style="margin-top:10px;padding:14px">
        <div style="font-size:var(--t-s);color:var(--ink-2);line-height:1.45;margin-bottom:10px">
          <b>Esto ya lo juegas, aunque no esté escrito:</b> ${esc(sugeridos.slice(0, 4).map((s) => `${db.diaPlural(s.dia_nombre)} ${s.hora} en ${db.nombreDeZona(s.zona)} (${s.veces} veces)`).join(' · '))}.
          Cárgalo como turno fijo abajo y enciéndelo cuando quieras que se materialice solo.
        </div>
      </div>` : ''}
      <div class="group" style="margin-top:10px">
        <form method="post" action="/admin/turno">
          <input type="hidden" name="key" value="${esc(keyRaw)}">
          <div class="campos" style="padding-top:14px">
            <div class="campo">
              <label for="t-zona">Distrito</label>
              <select id="t-zona" name="zona">
                ${db.zonasOperativas().map((z) => `<option value="${esc(z)}">${esc(db.nombreDeZona(z))}</option>`).join('')}
              </select>
            </div>
            <div class="campo campo-ancho">
              <label for="t-sede">Cancha</label>
              <select id="t-sede" name="sede_id">
                <option value="">Por definir</option>
                ${sedesTodas.map((s) => `<option value="${s.id}">🏟 ${esc(db.nombreDeZona(s.zona))} — ${esc(s.nombre)}</option>`).join('')}
              </select>
            </div>
            <div class="campo">
              <label for="t-dia">Día de la semana</label>
              <select id="t-dia" name="dia_semana">
                ${db.DIAS_NOMBRE.map((d, i) => `<option value="${i}">${esc(db.diaPlural(d.charAt(0).toUpperCase() + d.slice(1)))}</option>`).join('')}
              </select>
            </div>
            <div class="campo">
              <label for="t-hora">Hora de inicio</label>
              <input id="t-hora" name="hora" type="time" step="1800" required>
            </div>
            <div class="campo">
              <label for="t-cupo">Cupo</label>
              <input id="t-cupo" name="cupo" type="number" min="2" max="60" value="14">
            </div>
            <div class="campo">
              <label for="t-precio">Precio por jugador</label>
              <input id="t-precio" name="precio" type="number" step="0.5" placeholder="S/ auto">
              <small>Vacío = el precio del distrito</small>
            </div>
          </div>
          <div style="padding:0 14px 14px">
            <button class="btn-toque btn-guardar" style="width:100%;min-height:var(--tap-lg);font-size:var(--t-l)">Guardar turno fijo</button>
            <div style="font-size:var(--t-s);color:var(--ink-2);margin-top:9px;text-align:center">
              Nace APAGADO. Un turno encendido carga partidos reales, y cada partido es una cancha que hay que pagar: eso lo enciendes tú.
            </div>
          </div>
        </form>
      </div>`;

  // Precarga del formulario cuando se llega desde un hueco ("Cargarlo ›").
  const diaPre = /^\d{4}-\d{2}-\d{2}$/.test(query.dia || '') ? query.dia : hoy;
  const horaPre = db.horaInput(query.hora || '');
  const zonaPre = db.zonasOperativas().includes(query.zona) ? query.zona : db.zonasOperativas()[0];

  return baseHtml('Partidos · Pichangueros', `
    <div class="px">
      <div class="ltitle"><div><div class="eyebrow">Convocatorias</div><h2>Partidos</h2></div></div>

      ${bloqueConflictos}
      ${bloqueLiquidar}

      <div class="shdr ancla" id="abrir">Abrir partido nuevo <small>· 3 toques: zona, día y listo</small></div>
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
            ${db.zonasOperativas().map((z) => `<label class="zbtn"><input type="radio" name="zona" value="${esc(z)}" ${z === zonaPre ? 'checked' : ''} onchange="pintaSedes('${esc(z)}')">${esc(db.nombreDeZona(z))}</label>`).join('')}
          </div>
          <select name="sede" id="selSede" onchange="cupoDeSede()"></select>
          <label>¿Cuándo?</label>
          <div style="display:flex;gap:8px;flex-basis:100%;align-items:center">
            <button type="button" class="qd${diaPre === hoy ? ' on' : ''}" onclick="setDia(this,'${hoy}')">Hoy</button>
            <button type="button" class="qd${diaPre === fechaLima(1) ? ' on' : ''}" onclick="setDia(this,'${fechaLima(1)}')">Mañana</button>
            <input name="fecha" id="fFecha" type="date" required min="${hoy}" value="${esc(diaPre)}" style="flex:1;min-width:130px">
          </div>
          <div class="campos" style="flex-basis:100%">
            ${campo('fHora', 'Hora de inicio',
              `<input id="fHora" name="hora" type="time" step="1800" value="${esc(horaPre)}" required>`,
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
        pintaSedes(${JSON.stringify(zonaPre)});
      </script>

      ${/* LA SEMANA. Es como se piensa el negocio ("los domingos 6pm") y es
            donde un hueco o un duplicado se ven solos — en la lista plana
            ordenada por fecha no se veía que el domingo estaba vacío. */ ''}
      <div class="shdr">La semana <small>· ${esc(fechaCompacta(desde, true, false))} al ${esc(fechaCompacta(hasta, true, false))}</small></div>
      <div style="display:flex;gap:8px;margin-bottom:12px">
        <a class="btn-toque" style="flex:1;text-align:center;text-decoration:none;min-height:var(--tap);display:flex;align-items:center;justify-content:center;background:var(--surface);color:var(--ink);border:1.5px solid var(--line-strong)"
           href="/admin/leads?key=${key}&vista=partidos&semana=${semana - 1}">‹ Semana anterior</a>
        ${semana !== 0 ? `<a class="btn-toque" style="flex:1;text-align:center;text-decoration:none;min-height:var(--tap);display:flex;align-items:center;justify-content:center;background:var(--lime);color:var(--on-lime);border:1.5px solid var(--lime)"
           href="/admin/leads?key=${key}&vista=partidos">Esta semana</a>` : ''}
        <a class="btn-toque" style="flex:1;text-align:center;text-decoration:none;min-height:var(--tap);display:flex;align-items:center;justify-content:center;background:var(--surface);color:var(--ink);border:1.5px solid var(--line-strong)"
           href="/admin/leads?key=${key}&vista=partidos&semana=${semana + 1}">Semana siguiente ›</a>
      </div>
      ${dias.map(bloqueDia).join('')}

      ${bloqueTurnos}

      <div class="foot">⚽ Pichangueros · Partidos</div>
    </div>
  `, { refresh: false, activo: 'partidos', key, aviso: query });
}

function paginaPartidoDetalle(db, key, keyRaw, partidoId, query = {}) {
  const p = db.getPartido(partidoId);
  if (!p) return baseHtml('Partido · Pichangueros', `<div class="px"><p style="padding:20px">Partido no encontrado. <a href="/admin/leads?key=${key}&vista=partidos">Volver</a></p></div>`, { activo: 'partidos', key });

  const neg = db.getNegocio();
  const z = { color: colorZona(p.zona), nombre: db.nombreDeZona(p.zona) };
  const inscripciones = db.inscripcionesDe(partidoId);
  const activas = inscripciones.filter((i) => i.estado !== 'baja');
  const ocupados = inscripciones.filter((i) => ['pagado', 'reservado'].includes(i.estado)).length;
  const lista = db.textoLista(partidoId);
  const pagosSueltos = db.pagosSinPartido();
  const libres = Math.max(0, p.cupo - ocupados);
  // La fase se CALCULA (db.fasePartido): esta pantalla no la deduce por su
  // cuenta, así que no puede contar una historia distinta a la del bot.
  const fase = db.fasePartido(p);
  const termino = db.yaPaso(p);

  /**
   * EL RECORRIDO DEL PARTIDO.
   *
   * La fase salía como un badge suelto ("Por liquidar") arriba a la derecha:
   * decía dónde está, pero no de dónde viene ni qué falta. Un partido tiene un
   * camino de cuatro escalones y la pregunta que uno trae al abrir la pantalla
   * es "¿esto ya se cobró o todavía no?".
   *
   * No agrega estado: dibuja el que `db.fasePartido` ya calcula. Cancelado se
   * dibuja aparte porque no es un escalón del camino, es salirse de él.
   */
  const CAMINO = [
    { id: 'proximo', label: 'Abierto' },
    { id: 'en_curso', label: 'Jugándose' },
    { id: 'gracia', label: 'Terminó' },
    { id: 'liquidado', label: 'Liquidado' },
  ];
  const recorrido = (() => {
    if (fase === 'cancelado') {
      return '<div class="via"><span class="vp corte" style="flex:1">✕ Partido cancelado — no cuenta para la caja</span></div>';
    }
    // 'por_liquidar' y 'cerrado' viven en el mismo escalón que 'gracia': el
    // partido ya pasó y la plata todavía no se dio por contada.
    const indiceDe = { proximo: 0, en_curso: 1, gracia: 2, por_liquidar: 2, cerrado: 2, liquidado: 3 };
    const aqui = indiceDe[fase] ?? 0;
    return `<div class="via">${CAMINO.map((paso, i) => {
      const clase = i < aqui ? 'hecho' : i === aqui ? 'aqui' : '';
      // El escalón donde uno está dice la etiqueta larga (la que ya usaba el
      // badge); los demás, la corta.
      const texto = i === aqui ? db.FASES[fase].corto : paso.label;
      return `<span class="vp ${clase}">${esc(texto)}</span>`;
    }).join('')}</div>`;
  })();

  /**
   * CONVOCAR — "¿a quién le escribo para llenar el viernes en Breña?".
   *
   * Es la pregunta que ninguna pantalla contestaba: el CRM ordena por último
   * mensaje, que no tiene nada que ver con quién viene a jugar. Acá salen los
   * que YA vinieron alguna vez, de esta zona, que todavía no están en esta
   * lista, con el más fresco arriba.
   *
   * GENERA LA LISTA, NO MANDA NADA. Cada uno con su link de WhatsApp y el
   * mensaje ya escrito: Clarck toca, revisa y envía. Con SAFE_MODE encendido y
   * la cuenta con alertas de salud de Meta, disparar 200 mensajes de una es
   * pedir el baneo del número con el que vive el negocio.
   *
   * Se pinta solo si se pide (?convocar=1): son cientos de contactos y esta
   * pantalla se abre sobre todo para pasar lista.
   */
  const verConvocar = query.convocar === '1';
  const CONVOCAR_TOPE = 30; // lo que se puede recorrer a dedo de una sentada
  const candidatos = verConvocar ? db.candidatosConvocatoria(partidoId) : [];
  const umConv = verConvocar ? db.umbralesFrescura() : null;
  const precioP = p.precio ?? neg.zonas[p.zona]?.precio;
  const textoInvite = `Habla crack ⚽ Tenemos pichanga ${db.fechaBonita(p.fecha)}${p.hora ? ` de ${p.hora}` : ''}${p.sede ? ` en ${p.sede}` : ''}. Quedan ${libres} cupo${libres === 1 ? '' : 's'} a S/ ${precioP ?? '?'}. ¿Te separo uno?`;
  const filaCand = (c) => {
    const rel = db.relacionDe(c.visitas);
    const dias = db.diasDesde(c.ultima);
    const fresc = db.frescuraDe(dias, umConv);
    return `<a class="lrow" href="https://wa.me/${esc(c.numero)}?text=${encodeURIComponent(textoInvite)}" target="_blank" rel="noopener">
      <span class="ava" style="background:${avatarColor(c.numero)}">${esc(iniciales(c.nombre, c.numero))}</span>
      <span class="lbody">
        <span class="lname">${esc(c.nombre || `+${c.numero}`)}</span>
        <span class="lsub">${esc(db.RELACIONES[rel].label)} · ${c.visitas} visita${c.visitas === 1 ? '' : 's'} · última ${esc(fechaCompacta(c.ultima, false, false))} (hace ${dias} d)</span>
      </span>
      <span class="lmeta"><span class="lbadges">
        <span class="badge ${COLOR_RELACION[rel]}">${rel === 'casero' ? '⭐ ' : ''}${db.RELACIONES[rel].label} · ${c.visitas}</span>
        ${fresc && fresc !== 'al_dia' ? `<span class="badge ${COLOR_FRESCURA[fresc]}">${db.FRESCURAS[fresc].corto} · ${dias} d</span>` : ''}
      </span></span>
      ${SVG.wa}</a>`;
  };
  const bloqueConvocar = `
    <div class="shdr ancla" id="convocar">Convocar <small>· a quién escribirle para llenar este partido</small></div>
    ${verConvocar ? `
    <div class="group" style="padding:12px 14px">
      <div style="font-size:var(--t-s);color:var(--ink-2);line-height:1.45">
        ${candidatos.length
          ? `<b>${candidatos.length} jugador${candidatos.length === 1 ? '' : 'es'} de ${esc(z ? z.nombre : p.zona)}</b> que ya vinieron alguna vez y no están en esta lista${candidatos.length > CONVOCAR_TOPE ? ` — se muestran los ${CONVOCAR_TOPE} más frescos` : ''}.
             Toca a uno y se abre su chat con el mensaje escrito: <b>lo mandas tú</b>, uno por uno.`
          : `Todavía no hay a quién convocar en ${esc(z ? z.nombre : p.zona)}: hacen falta jugadores que ya hayan venido alguna vez y que no estén ya en esta lista.`}
      </div>
    </div>
    ${candidatos.length ? `<div class="llist" style="margin-top:10px">${candidatos.slice(0, CONVOCAR_TOPE).map(filaCand).join('')}</div>` : ''}`
    : `<div class="group" style="padding:14px">
        <a class="btn-toque btn-guardar" style="display:flex;align-items:center;justify-content:center;width:100%;min-height:var(--tap-lg);font-size:var(--t-l);text-decoration:none"
           href="/admin/leads?key=${key}&vista=partidos&partido=${partidoId}&convocar=1#convocar">📣 Ver a quién convocar${libres ? ` (${libres} cupo${libres === 1 ? '' : 's'} libre${libres === 1 ? '' : 's'})` : ''}</a>
        <div style="font-size:var(--t-s);color:var(--ink-2);margin-top:9px;text-align:center">
          Jugadores de ${esc(z ? z.nombre : p.zona)} que ya vinieron y no están en esta lista, del que vino hace menos al que vino hace más. No manda mensajes: te arma la lista.
        </div>
      </div>`}`;

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
  /**
   * Cuánto le queda al cupo guardado sin Yape. Se pinta al lado del estado
   * porque "Reservado" a secas no dice lo único que importa mirando la lista:
   * si ese lugar es de alguien o está a punto de volver a estar libre.
   * Una baja con vencimiento cumplido es una reserva que caducó sola, no una
   * que dio de baja una persona: se dicen distinto.
   */
  const cuentaRegresiva = (i) => {
    if (!i.reserva_vence_en) return '';
    const faltan = Math.round((Date.parse(`${String(i.reserva_vence_en).replace(' ', 'T')}-05:00`) - Date.now()) / 60000);
    if (i.estado === 'baja') return '<span class="badge b-wait">reserva vencida</span>';
    if (i.estado !== 'reservado') return '';
    return faltan > 0
      ? `<span class="badge b-wait">se libera en ${faltan} min</span>`
      : '<span class="badge b-wait">por liberarse</span>';
  };
  const filaInsc = (i) => {
    const nombre = i.nombre || i.lead_nombre || (i.numero ? `+${i.numero}` : '¿?');
    // Pasar lista se habilita cuando el partido ya arrancó, no cuando alguien
    // lo declaró jugado: nadie iba a apretar un botón antes de entrar a la
    // cancha, y sin eso los botones "Vino/Faltó" no aparecían nunca.
    const puedeMarcar = fase !== 'proximo' || p.fecha <= hoyLima();
    return `<div class="finsc ancla" id="insc-${i.id}">
      <div style="flex:1;min-width:140px">
        <div style="font-weight:700;font-size:var(--t-m)">${i.numero ? `<a href="/admin/leads?key=${key}&numero=${i.numero}">${esc(nombre)}</a>` : esc(nombre)}</div>
        <div style="margin-top:5px">
          <span class="badge ${chipInsc[i.estado] || 'b-new'}">${esc(ESTADOS_INSC[i.estado] || i.estado)}</span>
          ${i.pago_id ? `<span class="badge b-new">pago #${i.pago_id}</span>` : ''}
          ${cuentaRegresiva(i)}
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

  /**
   * LIQUIDAR — la pantalla que "Cerrar" nunca fue.
   *
   * "Marcar jugado" no compraba nada: los recurrentes se cuentan por FECHA, no
   * por estado, así que apretarlo no cambiaba ningún número y por eso nadie lo
   * tocaba. Liquidar sí dice algo — quién vino, cuánto entró, cuánto falta, qué
   * costó la cancha y qué queda — y recién después se afirma que está contado.
   *
   * Solo aparece cuando el partido YA TERMINÓ: antes de eso no hay nada que
   * liquidar y el botón sería una trampa.
   */
  const vinieron = activas.filter((i) => i.asistencia === 'si').length;
  const sinMarcar = activas.filter((i) => !i.asistencia).length;
  const deudores = activas.filter((i) => i.estado === 'reservado');
  const nombreDe = (i) => i.nombre || i.lead_nombre || (i.numero ? `+${i.numero}` : 'Sin nombre');
  const bloqueLiquidacion = (termino && fase !== 'liquidado' && fase !== 'cancelado') ? `
    <div class="shdr ancla" id="liquidacion">Liquidar <small>· este partido ya se jugó</small></div>
    <div class="group" style="padding:14px;margin-bottom:14px">
      <div style="font-size:var(--t-m);line-height:1.5">
        <b>${vinieron || ocupados} de ${activas.length}</b> ${vinieron ? 'marcados como que vinieron' : 'inscritos'}${sinMarcar ? ` · ${sinMarcar} sin marcar asistencia` : ''}.
      </div>
      ${deudores.length ? `<div style="font-size:var(--t-s);color:var(--st-alerta-ink);margin-top:8px;line-height:1.5">
        <b>Falta cobrarle a ${deudores.length}:</b> ${deudores.map((i) => (i.numero
          ? `<a href="https://wa.me/${esc(i.numero)}" target="_blank" rel="noopener">${esc(nombreDe(i))}</a>`
          : esc(nombreDe(i)))).join(' · ')}.
        Puedes cobrar ahora y marcarlos con "💰 Pagó" antes de liquidar.
      </div>` : '<div style="font-size:var(--t-s);color:var(--ink-2);margin-top:8px">No queda nadie por cobrar.</div>'}
      <form method="post" action="/admin/partido/liquidar" style="margin-top:12px"
        onsubmit="return confirm('${jsTxt(`¿Liquidar el partido del ${db.fechaBonita(p.fecha, { relativa: false })}? Es afirmar que la plata ya está contada.${deudores.length ? ` Quedan ${deudores.length} sin pagar y se van a dar por perdidos.` : ''} Deja de aceptar pagos.`)}')">
        <input type="hidden" name="key" value="${esc(keyRaw)}"><input type="hidden" name="id" value="${partidoId}">
        <button class="btn-toque btn-guardar" style="width:100%;min-height:var(--tap-lg);font-size:var(--t-l)">🧾 Liquidar este partido</button>
      </form>
      <div style="font-size:var(--t-s);color:var(--ink-2);margin-top:9px;text-align:center">
        Hasta que lo liquides sigue aceptando Yapes tardíos (${db.graciaHoras()} h después del partido, o siempre que lo reabras).
      </div>
    </div>` : '';

  /**
   * Cancelado con gente adentro: la lista con sus wa.me.
   *
   * NADIE recibe aviso automático — un mensaje masivo del bot diciendo "no hay
   * pichanga" es exactamente lo que no puede salir solo. Lo que sí se puede
   * hacer es dejarle los links a un toque para que escriba él.
   */
  const bloqueAvisar = (fase === 'cancelado' && activas.length) ? `
    <div class="group" style="padding:14px;margin-bottom:14px;border:1.5px solid var(--st-alerta-ink)">
      <div style="font-size:var(--t-m);font-weight:700">Este partido está cancelado y tiene ${activas.length} inscrito${activas.length === 1 ? '' : 's'}.</div>
      <div style="font-size:var(--t-s);color:var(--ink-2);margin-top:6px;line-height:1.5">
        Nadie recibe aviso automático. Escríbeles tú, uno por uno:
        ${activas.map((i) => (i.numero
          ? `<a href="https://wa.me/${esc(i.numero)}?text=${encodeURIComponent(`Habla crack, se cayó la pichanga del ${db.fechaBonita(p.fecha, { relativa: false })}${p.hora ? ` de ${p.hora}` : ''}. ${i.estado === 'pagado' ? 'Te devuelvo tu Yape o te lo dejo para la próxima, tú me dices.' : 'Te aviso apenas tenga otra fecha.'}`)}" target="_blank" rel="noopener">${esc(nombreDe(i))}</a>`
          : esc(nombreDe(i)))).join(' · ')}.
      </div>
    </div>` : '';

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
          <span class="badge b-zona" style="background:${db.FASES[fase].ok ? 'var(--st-ok-solid)' : 'var(--st-off-solid)'}">${esc(db.FASES[fase].label)}</span>
        </span>
      </div>
      ${recorrido}
      ${caja}

      ${bloqueAvisar}
      ${bloqueLiquidacion}

      ${editor}

      <div style="display:flex;gap:var(--s2);flex-wrap:wrap;align-items:center;margin-bottom:var(--s3)">
        ${fase === 'proximo' || fase === 'en_curso' || fase === 'gracia'
          ? cambioEstado('cerrado', '🔒 Cerrar inscripción', 'background:var(--surface-2);color:var(--ink);border:1.5px solid var(--line-strong)')
          : cambioEstado('abierto', `🔓 Reabrir${termino ? ` (${db.graciaHoras()} h más)` : ''}`, 'background:var(--st-ok-bg);color:var(--st-ok-ink);border:1.5px solid var(--st-ok-ink)')}
      </div>

      ${/* Lo destructivo va en su propia fila, separado por 24px y una línea:
           antes "✖ Cancelar" y "🗑 Eliminar" compartían fila con "Cerrar" y
           "Marcar jugado", y en 360px eso envuelve — el botón que saca el
           partido de la parrilla del bot terminaba justo debajo del dedo. */ ''}
      ${(fase !== 'cancelado' || !inscripciones.length) ? `
      <div class="acc-peligro" style="margin-bottom:16px">
        ${fase !== 'cancelado' ? `
        <form method="post" action="/admin/partido/cancelar-fecha" style="display:inline" onsubmit="return confirm('${jsTxt(`¿CANCELAR el partido del ${db.fechaBonita(p.fecha, { relativa: false })}? ${activas.length ? `Hay ${activas.length} inscritos y nadie recibe aviso automático: tienes que avisarles tú.` : 'No hay nadie inscrito.'}${p.turno_id ? ' El turno fijo sigue activo para las demás semanas.' : ''}`)}')">
          <input type="hidden" name="key" value="${esc(keyRaw)}"><input type="hidden" name="id" value="${partidoId}">
          <button class="btn-toque" style="font-size:13px;background:var(--st-alerta-bg);color:var(--st-alerta-ink);border:1.5px solid var(--st-alerta-ink)">✖ Cancelar${p.turno_id ? ' esta fecha' : ''}</button>
        </form>` : ''}
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

      ${bloqueConvocar}

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
