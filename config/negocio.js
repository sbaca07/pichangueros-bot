/**
 * Datos del negocio — fuente: Brief de Clarck (Google Docs, 2026-06-10).
 *
 * YA NO es la fuente en vivo: este archivo solo sirvió para sembrar la tabla
 * `config`/`sedes` (src/db.js) la primera vez que corrió esta versión del bot.
 * De ahí en adelante, precios/sedes/horarios/textos se editan en el panel
 * admin (`/admin/leads?vista=config`), no acá. Se deja el archivo como
 * referencia histórica del brief original.
 * Los precios suben en ~1 mes: Breña 15→18, Comas 10→13.
 *
 * PENDIENTE CONFIRMAR CON CLARCK (el brief llegó con la tabla corrupta):
 *   - Horarios exactos por día de cada sede.
 *   - Que Mariano Melgar es Breña (la tabla del brief decía Comas, pero el
 *     resto del brief y sus mensajes fijos dicen Breña).
 *   - Links de invitación a los grupos de WhatsApp (groupLink).
 */
module.exports = {
  marca: 'Pichangueros',
  yape: {
    numero: '915395067',
    titular: 'Clarck Valentin',
    tipo: 'personal',
  },

  zonas: {
    brena: {
      nombre: 'Breña',
      precio: 15,
      sedes: [
        {
          nombre: 'Estadio Mariano Melgar',
          cancha: 'Cancha 2',
          cupo: 14,
          ubicacion: 'https://share.google/4S9BH55GgQLJkCRvc',
          horario: 'Lunes a viernes 8pm a 9pm (jueves 9pm a 10pm) — POR CONFIRMAR',
          estacionamiento: 'Estacionamiento disponible (gratis)',
        },
      ],
      groupLink: null, // pendiente: link de invitación del grupo de Breña
    },
    comas: {
      nombre: 'Comas',
      precio: 10,
      sedes: [
        {
          nombre: 'Colegio Politécnico Estados Unidos',
          cancha: 'Cancha 6',
          cupo: 12,
          ubicacion: 'https://share.google/IBjAWNh142AkhYihO',
          horario: 'Lunes a viernes 8pm a 9pm — POR CONFIRMAR',
          estacionamiento: 'Estacionamiento disponible (gratis)',
        },
        {
          nombre: 'IE Luis Braille',
          cancha: null,
          cupo: 14,
          ubicacion: 'https://share.google/ExgzqUkV3z25y3TKU',
          horario: 'Lunes 8pm y 9pm — POR CONFIRMAR',
          estacionamiento: null,
        },
      ],
      groupLink: null, // pendiente: link de invitación del grupo de Comas
    },
  },

  reglas: {
    horaLlegada: '7:45 pm (para iniciar puntuales a las 8)',
    pago: 'La inscripción es previa reserva por Yape. No se paga en cancha.',
    devoluciones:
      'No se devuelve el dinero. Si te bajas con más de 3 horas de anticipación, se te guarda el cupo para otra fecha; con menos de 3 horas, se pierde.',
    convivencia: 'Jugar con respeto, buena actitud y compañerismo.',
  },

  // Texto de la mecánica — copiado tal cual del brief de Clarck.
  mecanica: `⚽️🫂 ¡Te explico cómo puedes jugar con nosotros!

1️⃣ Te unes a nuestro grupo de Pichangueros haciendo click en el link enviado.
2️⃣ Mantente atento a las convocatorias de las pichangas.
3️⃣ Si te interesa participar en alguna, me escribes por interno y haces la reserva por YAPE.
4️⃣ Verás tu nombre actualizado en la lista de jugadores.`,

  // Bienvenida a alguien nuevo — copiada tal cual del brief (sirve de filtro).
  bienvenida: `¡Hola! Bienvenido a Pichangueros ⚽ Si estás aquí es porque eres un apasionado de las pichangas.

Por favor, bríndame tus:
- Nombres y apellidos
- Edad
- Distrito(s) en el que te gustaría jugar`,

  // Emojis "de la casa" — set provisional (los del brief llegaron corruptos;
  // pedir a Clarck su lista real por WhatsApp).
  emojis: ['⚽', '🏟️', '🔥', '💪', '🤝', '⏰', '📍', '🚗'],
};
