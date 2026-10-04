/* Avisos de programación: "Hola Ana, tienes participación en los siguientes
   eventos de <Organización>: …" por correo y WhatsApp.

   - El CORREO no sale del navegador: la página deja un pedido en
     /colaAvisos/{id} y dispara el workflow de GitHub Actions
     (.github/workflows/avisos.yml), que lee la base con una cuenta de
     servicio, recalcula destinatarios y mensaje con estas mismas funciones y
     envía con Gmail. Si el disparo falla, el cron de respaldo
     (avisos-respaldo.yml) toma los pedidos que sigan pendientes.
   - WHATSAPP es un enlace wa.me por persona con el mensaje ya escrito (la
     API oficial no es gratuita): el panel de avisos lo muestra al publicar
     y en "Reenviar eventos".

   Solo reciben aviso las cuentas con acceso confirmado (/users/{uid}) que
   tienen persona vinculada en la organización (musicianLinks[orgId]) y
   participan en eventos PUBLICADOS de hoy en adelante.

   Se usa igual desde el navegador (window.RepertorioAvisos) y desde node
   (require('./avisos.js')) en el workflow y en tests/. */
(function (root) {
  var SITIO_URL = 'https://joscarper1.github.io/RepertorioApp/';
  var ZONA_HORARIA = 'America/El_Salvador';
  var CODIGO_PAIS = '503';
  var REPO = 'joscarper1/RepertorioApp';
  var RAMA = 'main';
  var WORKFLOW_ENVIO = 'avisos.yml';
  var WORKFLOW_RESPALDO = 'avisos-respaldo.yml';
  var COLA_PATH = 'colaAvisos';
  var CONFIG_PATH = 'config/avisos';
  /* Días antes del vencimiento del token de GitHub en que se empieza a avisar. */
  var DIAS_AVISO_TOKEN = 14;

  var DIAS_CORTOS = ['Dom', 'Lun', 'Mar', 'Mié', 'Jue', 'Vie', 'Sáb'];
  var MESES_CORTOS = ['ene', 'feb', 'mar', 'abr', 'may', 'jun', 'jul', 'ago', 'sep', 'oct', 'nov', 'dic'];

  /* --- Funciones puras (navegador y node) --- */

  /* Los eventos guardados antes de que existiera `estado` cuentan como
     publicados (mismo criterio que RepertorioData.estadoEvento). */
  function estadoEvento(ev) { return (ev && ev.estado) || 'PUBLICADO'; }

  /* Fecha de hoy (YYYY-MM-DD) en la zona de la iglesia: el workflow corre en
     UTC y a las 7 pm de El Salvador allá ya es mañana. */
  function hoyIso(ahora) {
    var d = ahora || new Date();
    try {
      return new Intl.DateTimeFormat('en-CA', { timeZone: ZONA_HORARIA, year: 'numeric', month: '2-digit', day: '2-digit' }).format(d);
    } catch (e) {
      var local = new Date(d.getTime() - 6 * 3600 * 1000);
      return local.toISOString().slice(0, 10);
    }
  }

  function parseIso(s) {
    var p = String(s || '').split('-');
    return new Date(Number(p[0]), Number(p[1]) - 1, Number(p[2]));
  }

  /* '2026-10-05' → 'Dom 5 oct' */
  function diaCorto(iso) {
    var d = parseIso(iso);
    if (isNaN(d.getTime())) return String(iso || '');
    return DIAS_CORTOS[d.getDay()] + ' ' + d.getDate() + ' ' + MESES_CORTOS[d.getMonth()];
  }

  /* '6:30 pm' → 1110, para ordenar eventos del mismo día. */
  function minutosHora(h) {
    var m = String(h || '').trim().toLowerCase().match(/^(\d{1,2})(?::(\d{2}))?\s*(am|pm|a\.m\.|p\.m\.)?/);
    if (!m) return 0;
    var hh = Number(m[1]) % 12, mm = Number(m[2] || 0);
    if (m[3] && m[3].charAt(0) === 'p') hh += 12;
    else if (!m[3] && Number(m[1]) === 12) hh = 12;
    return hh * 60 + mm;
  }

  function nombreValido(slot) { return !!(slot && (slot.nombre || '').trim()); }

  /* Puestos (banda[].tipo, sin número) que ocupa la persona en el evento; si
     el puesto lleva rol de banda (Alabanza en servicio ministerial), con el
     rol: "Alabanza · Corista". */
  function puestosDePersona(ev, musicianId) {
    var out = [];
    ((ev && ev.banda) || []).forEach(function (slot) {
      if (!slot || slot.musicianId !== musicianId || !nombreValido(slot) || !slot.tipo) return;
      var p = slot.rol ? slot.tipo + ' · ' + slot.rol : slot.tipo;
      if (out.indexOf(p) < 0) out.push(p);
    });
    return out;
  }

  function participa(ev, musicianId) {
    if (!musicianId || !ev) return false;
    if (puestosDePersona(ev, musicianId).length) return true;
    return !!(ev.integrantes && ev.integrantes[musicianId]);
  }

  /* musicianId de quienes ocupan un puesto con nombre en el evento. */
  function integrantesDe(ev) {
    var out = {};
    ((ev && ev.banda) || []).forEach(function (slot) {
      if (slot && slot.musicianId && nombreValido(slot)) out[slot.musicianId] = true;
    });
    Object.keys((ev && ev.integrantes) || {}).forEach(function (id) { if (ev.integrantes[id]) out[id] = true; });
    return out;
  }

  function ordenEventos(a, b) {
    if ((a.fecha || '') !== (b.fecha || '')) return (a.fecha || '') < (b.fecha || '') ? -1 : 1;
    return minutosHora(a.hora) - minutosHora(b.hora);
  }

  /* Eventos PUBLICADOS de `desde` en adelante donde participa la persona. */
  function eventosDePersona(eventos, musicianId, desde) {
    return (eventos || []).filter(function (ev) {
      return ev && estadoEvento(ev) === 'PUBLICADO' && (ev.fecha || '') >= (desde || '') && participa(ev, musicianId);
    }).sort(ordenEventos);
  }

  /* 'Dom 5 oct – Cultos Dominicales (Corista)' */
  function lineaEvento(ev, musicianId) {
    var puestos = puestosDePersona(ev, musicianId);
    return diaCorto(ev.fecha) + ' – ' + (ev.servicio || 'Evento') + (puestos.length ? ' (' + puestos.join(', ') + ')' : '');
  }

  function primerNombre(nombre) {
    return String(nombre || '').trim().split(/\s+/)[0] || '';
  }

  function urlCalendario(org, isoFecha) {
    var q = [];
    if (org && org.slug) q.push('group=' + encodeURIComponent(org.slug));
    if (isoFecha) q.push('month=' + String(isoFecha).slice(0, 7));
    return SITIO_URL + 'index.html' + (q.length ? '?' + q.join('&') : '');
  }

  /* Dashboard de la persona: abre en "Próximos eventos", donde confirma. */
  function urlDashboard(org) {
    return SITIO_URL + 'dashboard.html' + (org && org.slug ? '?org=' + encodeURIComponent(org.slug) : '');
  }

  function escaparHtml(s) {
    return String(s == null ? '' : s).replace(/[&<>"']/g, function (c) {
      return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c];
    });
  }

  /* Mensaje para una persona. eventos: ya filtrados (eventosDePersona).
     null si no tiene eventos. */
  function armarAviso(org, nombre, musicianId, eventos) {
    if (!eventos || !eventos.length) return null;
    var orgNombre = (org && (org.name || org.nombre)) || 'la organización';
    var primer = primerNombre(nombre);
    var saludo = 'Hola' + (primer ? ' ' + primer : '') + ', ¡Dios te bendiga!'+ '\n\n' + 'Tienes participación en los siguientes eventos de ' + orgNombre + ':';
    var lineas = eventos.map(function (ev) { return lineaEvento(ev, musicianId); });
    var url = urlCalendario(org, eventos[eventos.length - 1].fecha);
    var urlConfirmar = urlDashboard(org);
    var texto = saludo + '\n\n' + lineas.map(function (l) { return '• ' + l; }).join('\n') +
      '\n\nConfirma tu participación aquí: ' + urlConfirmar + '\n\nVer calendario: ' + url;
    var html = '<p>' + escaparHtml(saludo) + '</p><ul>' +
      lineas.map(function (l) { return '<li>' + escaparHtml(l) + '</li>'; }).join('') +
      '</ul><p>Confirma tu participación aquí: <a href="' + escaparHtml(urlConfirmar) + '">' + escaparHtml(urlConfirmar) + '</a></p>' +
      '<p><a href="' + escaparHtml(url) + '">Ver calendario</a></p>';
    return { asunto: 'Tus próximos eventos – ' + orgNombre, saludo: saludo, lineas: lineas, url: url, urlConfirmar: urlConfirmar, texto: texto, html: html };
  }

  /* Solo dígitos con código de país; 8 dígitos se toman como número local. */
  function normalizarTelefono(txt) {
    var d = String(txt || '').replace(/\D/g, '');
    if (!d) return '';
    if (d.length === 8) d = CODIGO_PAIS + d;
    return d;
  }

  function telefonoValido(tel) { return /^\d{10,15}$/.test(String(tel || '')); }

  function formatoTelefono(tel) {
    var d = String(tel || '');
    if (d.indexOf(CODIGO_PAIS) === 0 && d.length === CODIGO_PAIS.length + 8) {
      var n = d.slice(CODIGO_PAIS.length);
      return '+' + CODIGO_PAIS + ' ' + n.slice(0, 4) + '-' + n.slice(4);
    }
    return d ? '+' + d : '';
  }

  function urlWhatsApp(tel, texto) {
    return 'https://wa.me/' + String(tel || '') + '?text=' + encodeURIComponent(texto || '');
  }

  function orgIdsDe(u) { return Object.keys((u && u.organizationIds) || {}).filter(function (k) { return u.organizationIds[k]; }); }

  /* Plan de avisos de un pedido. pedido: {tipo: 'publicacion', eventIds}
     o {tipo: 'reenvio', uid}. datos: {org, usuarios: [{uid,…}], musicos,
     eventos, hoy}. Devuelve una fila por cuenta con persona vinculada en la
     organización e involucrada en el pedido:
     {uid, email, telefono, musicianId, nombre, aviso (null = sin eventos)}. */
  function planAvisos(pedido, datos) {
    var org = datos.org || {};
    var orgId = org.id || pedido.orgId;
    /* Solo eventos de esta organización, aunque `datos` trajera otros: una
       cuenta en varias organizaciones recibe un aviso aparte por cada una. */
    var eventos = (datos.eventos || []).filter(function (ev) { return ev && (!ev.organizationId || ev.organizationId === orgId); });
    var hoy = datos.hoy || hoyIso();
    var personas = null;
    if (pedido.tipo === 'publicacion') {
      personas = {};
      var ids = Array.isArray(pedido.eventIds) ? pedido.eventIds : Object.keys(pedido.eventIds || {});
      eventos.forEach(function (ev) {
        if (ids.indexOf(ev.id) < 0 || estadoEvento(ev) !== 'PUBLICADO') return;
        Object.keys(integrantesDe(ev)).forEach(function (mid) { personas[mid] = true; });
      });
    }
    var musicoPorId = {};
    (datos.musicos || []).forEach(function (m) { if (m && m.id) musicoPorId[m.id] = m; });
    /* Un registro sin correo al que se le agregó correo (emailPendiente) deja
       de avisarse en cuanto existe su cuenta de Google, aunque el panel de
       admin todavía no lo haya fusionado: si no, recibiría el aviso doble. */
    var correos = {};
    (datos.usuarios || []).forEach(function (u) { if (u && u.email) correos[String(u.email).trim().toLowerCase()] = true; });
    var filas = [];
    (datos.usuarios || []).forEach(function (u) {
      if (!u || !u.uid) return;
      if (u.emailPendiente && !u.email && correos[String(u.emailPendiente).trim().toLowerCase()]) return;
      if (pedido.tipo === 'reenvio' && u.uid !== pedido.uid) return;
      if (orgIdsDe(u).indexOf(orgId) < 0) return;
      var mid = ((u.musicianLinks || {})[orgId]) || '';
      if (!mid) return;
      if (personas && !personas[mid]) return;
      var m = musicoPorId[mid];
      var nombre = (m && m.nombre) || u.displayName || '';
      filas.push({
        uid: u.uid, email: u.email || '', telefono: u.telefono || '', musicianId: mid, nombre: nombre,
        aviso: armarAviso(org, nombre, mid, eventosDePersona(eventos, mid, hoy))
      });
    });
    return filas.sort(function (a, b) { return a.nombre.localeCompare(b.nombre, 'es'); });
  }

  /* --- Aviso a administradores: "usuario nuevo" ---
     Cuando alguien inicia sesión por su cuenta desde un calendario queda en
     esa organización con la marca `nuevo` (R.ensureUserRegistered). El
     workflow avisa por correo a los administradores de esa organización que
     lo activaron en Administración → Avisos (users/{uid}/avisos/nuevosUsuarios)
     y marca users/{uid}/avisoNuevo para no repetirlo. */
  var PREF_NUEVOS = 'nuevosUsuarios';
  /* Solo cuentas creadas en esta ventana: al activar la función no se
     avisa de todas las marcas "nuevo" viejas que nadie quitó. */
  var VENTANA_NUEVOS_MS = 7 * 24 * 3600 * 1000;

  function quiereAvisoNuevos(u) { return !!(u && u.avisos && u.avisos[PREF_NUEVOS] === true); }

  /* Cuentas con marca "nuevo" de las que todavía no se avisó (o cuyo envío
     quedó a medias hace más de 15 min: la ejecución anterior murió). */
  function nuevosPorAvisar(usuarios, ahora) {
    ahora = ahora || Date.now();
    var desde = ahora - VENTANA_NUEVOS_MS;
    return (usuarios || []).filter(function (u) {
      var a = u && u.avisoNuevo;
      var pendiente = !a || (!a.enviado && (a.tomado || 0) < ahora - 15 * 60 * 1000);
      return u && u.uid && u.nuevo === true && pendiente && (u.createdAt || 0) >= desde && orgIdsDe(u).length > 0;
    });
  }

  /* Administradores de la organización que quieren el aviso (con correo). */
  function adminsParaNuevos(usuarios, orgId, excluirUid) {
    return (usuarios || []).filter(function (u) {
      return u && u.uid !== excluirUid && u.role === 'admin' && u.email && orgIdsDe(u).indexOf(orgId) >= 0 && quiereAvisoNuevos(u);
    });
  }

  function urlUsuarios(org) {
    return SITIO_URL + 'admin.html?tab=usuarios' + (org && org.id ? '&org=' + encodeURIComponent(org.id) : '');
  }

  function armarAvisoNuevoUsuario(org, nuevo) {
    var orgNombre = (org && (org.name || org.nombre)) || 'la organización';
    var nombre = String((nuevo && (nuevo.displayName || nuevo.email)) || 'Alguien').trim();
    var correo = String((nuevo && nuevo.email) || '').trim();
    var quien = nombre + (correo && correo !== nombre ? ' (' + correo + ')' : '');
    var url = urlUsuarios(org);
    var p1 = quien + ' inició sesión desde el calendario y se unió a ' + orgNombre + '.';
    var p2 = 'Revisa su cuenta en Usuarios → Cuentas: confirma que es bienvenido (quita la etiqueta "Nuevo"), asígnale su rol y vincúlalo con su persona.';
    var p3 = 'Recibes este correo porque lo activaste en Administración → Avisos; desde ahí puedes desactivarlo.';
    return {
      asunto: 'Nuevo usuario en ' + orgNombre + ': ' + nombre,
      texto: p1 + '\n\n' + p2 + '\n\nVer usuarios: ' + url + '\n\n' + p3,
      html: '<p>' + escaparHtml(p1) + '</p><p>' + escaparHtml(p2) + '</p><p><a href="' + escaparHtml(url) + '">Ver usuarios</a></p>' +
        '<p style="color:#8a867f;font-size:12px">' + escaparHtml(p3) + '</p>',
      url: url
    };
  }

  /* --- Avisos a administradores: bitácora de cambios y repertorio ---
     Cada vez que alguien modifica, mueve, cancela o archiva un evento,
     eventos.html deja una entrada en /bitacoraEventos/{id} (ver
     entradaBitacora). El workflow la toma y manda correo a los
     administradores de la organización que activaron, en Administración →
     Avisos, la bitácora (users/{uid}/avisos/bitacoraEventos) y/o el aviso de
     repertorio actualizado (users/{uid}/avisos/repertorioActualizado). Ambos
     interruptores vienen apagados. */
  var BITACORA_PATH = 'bitacoraEventos';
  var PREF_BITACORA = 'bitacoraEventos';
  var PREF_REPERTORIO = 'repertorioActualizado';
  var ACCIONES_BITACORA = { modificado: 'Modificado', movido: 'Movido', cancelado: 'Cancelado', archivado: 'Archivado' };
  var ESTADOS_TXT = { BORRADOR: 'Borrador', PUBLICADO: 'Publicado', CANCELADO: 'Cancelado', ARCHIVADO: 'Archivado', ELIMINADO: 'Eliminado' };

  function quierePref(u, clave) { return !!(u && u.avisos && u.avisos[clave] === true); }

  /* Administradores de la organización con la preferencia activada (con correo). */
  function adminsConPref(usuarios, orgId, clave) {
    return (usuarios || []).filter(function (u) {
      return u && u.uid && u.role === 'admin' && u.email && orgIdsDe(u).indexOf(orgId) >= 0 && quierePref(u, clave);
    });
  }

  /* Canciones con título del evento: 'Título – Salmista (Tono)'. */
  function cancionesDe(ev) {
    var out = [];
    ((ev && ev.bloques) || []).forEach(function (bl) {
      ((bl && bl.canciones) || []).forEach(function (c) {
        var t = String((c && c.t) || '').trim();
        if (!t) return;
        var sm = String(c.sm || '').trim(), k = String(c.k || '').trim();
        out.push(t + (sm ? ' – ' + sm : '') + (k ? ' (' + k + ')' : ''));
      });
    });
    return out;
  }

  /* Cambio de repertorio al guardar `ahora` sobre `antes` (el evento en la
     nube): cualquier cambio en la lista (canciones, salmista, tono u orden),
     incluida la primera canción de un evento vacío. null si no cambió. */
  function cambioRepertorio(antes, ahora) {
    var a = cancionesDe(antes), b = cancionesDe(ahora);
    if (a.join('\n') === b.join('\n')) return null;
    var norm = function (s) { return s.toLowerCase(); };
    var an = a.map(norm), bn = b.map(norm);
    return {
      ahora: b,
      agregadas: b.filter(function (s) { return an.indexOf(norm(s)) < 0; }),
      quitadas: a.filter(function (s) { return bn.indexOf(norm(s)) < 0; })
    };
  }

  /* Entrada para /bitacoraEventos. accion: modificado | movido | cancelado |
     archivado. anterior = el evento antes del cambio; ev = como quedó.
     opts: {version, repertorio (cambioRepertorio)}. */
  function entradaBitacora(accion, anterior, ev, opts) {
    opts = opts || {};
    ev = ev || anterior || {};
    anterior = anterior || ev;
    var e = {
      orgId: ev.organizationId || anterior.organizationId || '',
      eventId: ev.id || anterior.id || '',
      accion: accion,
      eventoNombre: ev.servicio || anterior.servicio || 'Evento',
      eventoFecha: ev.fecha || anterior.fecha || '',
      estadoAntes: estadoEvento(anterior),
      estadoAhora: estadoEvento(ev)
    };
    if ((anterior.fecha || '') !== (ev.fecha || '')) e.fechaAnterior = anterior.fecha || '';
    var v = opts.version !== undefined ? opts.version : ev.version;
    if (v) e.version = v;
    if (opts.repertorio) e.repertorio = opts.repertorio;
    return e;
  }

  function entradaValida(e) {
    return !!(e && e.orgId && e.eventId && e.autorUid && ACCIONES_BITACORA[e.accion]);
  }

  /* 'sáb 4 oct 2026, 3:15 p. m.' en la zona de la iglesia. */
  function fechaHora(ms) {
    var d = new Date(ms || Date.now());
    try {
      return new Intl.DateTimeFormat('es', { timeZone: ZONA_HORARIA, weekday: 'short', day: 'numeric', month: 'short', year: 'numeric', hour: 'numeric', minute: '2-digit', hour12: true }).format(d);
    } catch (err) { return d.toISOString().replace('T', ' ').slice(0, 16) + ' UTC'; }
  }

  function textoVersion(e) { return e.version ? 'v' + e.version : (e.estadoAhora === 'PUBLICADO' ? '—' : 'sin versión (no publicado)'); }

  /* Líneas de una entrada: [título, detalle…]. autores: {uid: nombre}. */
  function lineasEntrada(e, autores) {
    var autor = (autores && autores[e.autorUid]) || 'Alguien';
    var accion = ACCIONES_BITACORA[e.accion] || e.accion;
    if (e.accion === 'movido' || (e.fechaAnterior && e.fechaAnterior !== e.eventoFecha)) {
      accion += (e.accion === 'movido' ? '' : ' y movido') + ' del ' + diaCorto(e.fechaAnterior) + ' al ' + diaCorto(e.eventoFecha);
    }
    if (e.accion === 'modificado' && e.estadoAntes && e.estadoAhora && e.estadoAntes !== e.estadoAhora) {
      accion += ' · estado: ' + (ESTADOS_TXT[e.estadoAntes] || e.estadoAntes) + ' → ' + (ESTADOS_TXT[e.estadoAhora] || e.estadoAhora);
    }
    if (e.repertorio) accion += ' · repertorio actualizado';
    return [
      diaCorto(e.eventoFecha) + ' – ' + (e.eventoNombre || 'Evento'),
      'Cambio: ' + accion,
      'Por: ' + autor + ' · ' + fechaHora(e.creado),
      'Versión: ' + textoVersion(e)
    ];
  }

  var PIE_PREF = 'Recibes este correo porque lo activaste en Administración → Avisos; desde ahí puedes desactivarlo.';

  /* Correo de bitácora con uno o varios cambios de la organización. */
  function armarAvisoBitacora(org, entradas, autores) {
    var orgNombre = (org && (org.name || org.nombre)) || 'la organización';
    var lista = (entradas || []).slice().sort(function (a, b) { return (a.creado || 0) - (b.creado || 0); });
    if (!lista.length) return null;
    var bloques = lista.map(function (e) { return lineasEntrada(e, autores); });
    var url = urlCalendario(org, lista[lista.length - 1].eventoFecha);
    var asunto = lista.length === 1
      ? (ACCIONES_BITACORA[lista[0].accion] || 'Cambio') + ': ' + bloques[0][0] + ' – ' + orgNombre
      : 'Bitácora de cambios (' + lista.length + ') – ' + orgNombre;
    var intro = lista.length === 1 ? 'Se registró este cambio en ' + orgNombre + ':' : 'Se registraron estos cambios en ' + orgNombre + ':';
    var texto = intro + '\n\n' + bloques.map(function (b) {
      return '• ' + b[0] + '\n' + b.slice(1).map(function (l) { return '  ' + l; }).join('\n');
    }).join('\n\n') + '\n\nVer calendario: ' + url + '\n\n' + PIE_PREF;
    var html = '<p>' + escaparHtml(intro) + '</p>' + bloques.map(function (b) {
      return '<div style="margin:0 0 14px;padding:10px 12px;border-left:3px solid #0e7a3c;background:#f4f3f0">' +
        '<div style="font-weight:700">' + escaparHtml(b[0]) + '</div>' +
        b.slice(1).map(function (l) { return '<div style="font-size:13px">' + escaparHtml(l) + '</div>'; }).join('') + '</div>';
    }).join('') + '<p><a href="' + escaparHtml(url) + '">Ver calendario</a></p>' +
      '<p style="color:#8a867f;font-size:12px">' + escaparHtml(PIE_PREF) + '</p>';
    return { asunto: asunto, texto: texto, html: html, url: url };
  }

  /* Correo de "repertorio actualizado" de una entrada con e.repertorio. */
  function armarAvisoRepertorio(org, e, autores) {
    if (!e || !e.repertorio) return null;
    var orgNombre = (org && (org.name || org.nombre)) || 'la organización';
    var r = e.repertorio;
    var evTxt = (e.eventoNombre || 'Evento') + ' (' + diaCorto(e.eventoFecha) + ')';
    var autor = (autores && autores[e.autorUid]) || 'Alguien';
    var p1 = autor + ' actualizó el repertorio de ' + evTxt + ' el ' + fechaHora(e.creado) + '. Versión: ' + textoVersion(e) + '.';
    var secciones = [];
    if ((r.agregadas || []).length) secciones.push(['Agregadas', r.agregadas]);
    if ((r.quitadas || []).length) secciones.push(['Quitadas', r.quitadas]);
    if (!secciones.length) secciones.push(['Cambio', ['Se cambió el orden de las canciones']]);
    secciones.push(['Lista actual', (r.ahora || []).length ? r.ahora : ['(sin canciones)']]);
    var url = urlCalendario(org, e.eventoFecha);
    var texto = p1 + '\n\n' + secciones.map(function (s) {
      return s[0] + ':\n' + s[1].map(function (l) { return '• ' + l; }).join('\n');
    }).join('\n\n') + '\n\nVer calendario: ' + url + '\n\n' + PIE_PREF;
    var html = '<p>' + escaparHtml(p1) + '</p>' + secciones.map(function (s) {
      return '<p style="margin:12px 0 4px;font-weight:700">' + escaparHtml(s[0]) + '</p><ul style="margin:0">' +
        s[1].map(function (l) { return '<li>' + escaparHtml(l) + '</li>'; }).join('') + '</ul>';
    }).join('') + '<p><a href="' + escaparHtml(url) + '">Ver calendario</a></p>' +
      '<p style="color:#8a867f;font-size:12px">' + escaparHtml(PIE_PREF) + '</p>';
    return { asunto: 'Repertorio actualizado: ' + evTxt + ' – ' + orgNombre, texto: texto, html: html, url: url };
  }

  /* Días que faltan para `venceIso` (negativo = vencido); null sin fecha. */
  function diasParaVencer(venceIso, hoy) {
    if (!venceIso) return null;
    var a = parseIso(hoy || hoyIso()), b = parseIso(String(venceIso).slice(0, 10));
    if (isNaN(b.getTime())) return null;
    return Math.round((b - a) / 86400000);
  }

  /* Motivo guardado por el workflow en colaAvisos/{id}.fallo. */
  var FALLOS = {
    'gmail-credenciales': 'Gmail rechazó el usuario o la contraseña: revisa los secrets GMAIL_USER y GMAIL_APP_PASSWORD (contraseña de aplicación de 16 letras, sin espacios).',
    'pedido-invalido': 'El pedido estaba incompleto.',
    'organizacion-inexistente': 'La organización ya no existe.',
    'error-interno': 'El envío falló por un error interno: revisa la ejecución en GitHub.'
  };
  function textoFallo(f) { return f ? (FALLOS[f] || f) : ''; }

  var api = {
    SITIO_URL: SITIO_URL, REPO: REPO, RAMA: RAMA, WORKFLOW_ENVIO: WORKFLOW_ENVIO, WORKFLOW_RESPALDO: WORKFLOW_RESPALDO,
    COLA_PATH: COLA_PATH, CONFIG_PATH: CONFIG_PATH, DIAS_AVISO_TOKEN: DIAS_AVISO_TOKEN,
    estadoEvento: estadoEvento, hoyIso: hoyIso, diaCorto: diaCorto, minutosHora: minutosHora,
    puestosDePersona: puestosDePersona, participa: participa, integrantesDe: integrantesDe,
    eventosDePersona: eventosDePersona, lineaEvento: lineaEvento, primerNombre: primerNombre,
    urlCalendario: urlCalendario, armarAviso: armarAviso, planAvisos: planAvisos,
    normalizarTelefono: normalizarTelefono, telefonoValido: telefonoValido, formatoTelefono: formatoTelefono,
    urlWhatsApp: urlWhatsApp, diasParaVencer: diasParaVencer, escaparHtml: escaparHtml, textoFallo: textoFallo,
    PREF_NUEVOS: PREF_NUEVOS, VENTANA_NUEVOS_MS: VENTANA_NUEVOS_MS, quiereAvisoNuevos: quiereAvisoNuevos,
    nuevosPorAvisar: nuevosPorAvisar, adminsParaNuevos: adminsParaNuevos, armarAvisoNuevoUsuario: armarAvisoNuevoUsuario,
    BITACORA_PATH: BITACORA_PATH, PREF_BITACORA: PREF_BITACORA, PREF_REPERTORIO: PREF_REPERTORIO, ACCIONES_BITACORA: ACCIONES_BITACORA,
    quierePref: quierePref, adminsConPref: adminsConPref, cancionesDe: cancionesDe, cambioRepertorio: cambioRepertorio,
    entradaBitacora: entradaBitacora, entradaValida: entradaValida, fechaHora: fechaHora,
    armarAvisoBitacora: armarAvisoBitacora, armarAvisoRepertorio: armarAvisoRepertorio
  };

  if (typeof module !== 'undefined' && module.exports) { module.exports = api; return; }

  /* --- Solo navegador: cola en Firebase, GitHub Actions y panel --- */

  function db() {
    var fb = root.firebase;
    if (!fb || !fb.apps || !fb.apps.length || !fb.database) return null;
    try { return fb.database().ref(); } catch (e) { return null; }
  }

  function lista(snap) {
    var out = [];
    snap.forEach(function (c) { var v = c.val() || {}; if (typeof v === 'object') { if (!v.id) v.id = c.key; out.push(v); } });
    return out;
  }

  /* Lo necesario para planAvisos. Leer /users completo solo lo permiten las
     reglas a un admin, y solo un admin publica o reenvía. */
  function leerDatos(orgId) {
    var r = db();
    if (!r) return Promise.reject(new Error('sin-firebase'));
    return Promise.all([
      r.child('organizations').child(orgId).once('value'),
      r.child('users').once('value'),
      r.child('musicians').orderByChild('organizationId').equalTo(orgId).once('value'),
      r.child('events').orderByChild('organizationId').equalTo(orgId).once('value')
    ]).then(function (s) {
      var org = s[0].val() || {};
      org.id = orgId;
      var usuarios = [];
      s[1].forEach(function (c) { var v = c.val() || {}; v.uid = c.key; usuarios.push(v); });
      return { org: org, usuarios: usuarios, musicos: lista(s[2]), eventos: lista(s[3]), hoy: hoyIso() };
    });
  }

  function uidActual() {
    var fb = root.firebase;
    var u = fb && fb.auth && fb.auth().currentUser;
    return u ? u.uid : null;
  }

  /* Deja el pedido en la cola; el workflow lo procesa. Promise<key>. */
  function encolar(pedido) {
    var r = db();
    if (!r) return Promise.reject(new Error('sin-firebase'));
    var doc = { orgId: pedido.orgId, tipo: pedido.tipo, pedidoPor: uidActual(), creado: root.firebase.database.ServerValue.TIMESTAMP, estado: 'pendiente' };
    if (pedido.tipo === 'publicacion') {
      doc.eventIds = {};
      pedido.eventIds.forEach(function (id) { doc.eventIds[id] = true; });
    } else doc.uid = pedido.uid;
    var ref = r.child(COLA_PATH).push();
    return ref.set(doc).then(function () { return ref.key; });
  }

  /* Deja un cambio de evento en /bitacoraEventos (ver entradaBitacora) e
     intenta lanzar el envío. Solo un admin puede leer el token de GitHub; si
     cambió un editor o director, sale con el cron de respaldo (~30 min).
     Nunca bloquea ni avisa nada en pantalla. */
  function registrarCambio(entrada) {
    var r = db();
    var uid = uidActual();
    if (!r || !entrada || !uid) return Promise.resolve(null);
    var doc = Object.assign({}, entrada, { autorUid: uid, creado: root.firebase.database.ServerValue.TIMESTAMP, estado: 'pendiente' });
    if (!entradaValida(doc)) return Promise.resolve(null);
    var ref = r.child(BITACORA_PATH).push();
    return ref.set(doc).then(function () {
      api.dispararEnvio().then(null, function () {});
      return ref.key;
    }, function (err) {
      console.warn('No se pudo registrar el cambio en la bitácora:', err && err.code);
      return null;
    });
  }

  function leerConfig() {
    var r = db();
    if (!r) return Promise.resolve({});
    return r.child(CONFIG_PATH).once('value').then(function (s) { return s.val() || {}; }, function () { return {}; });
  }

  function guardarConfig(patch) {
    var r = db();
    if (!r) return Promise.reject(new Error('sin-firebase'));
    var p = Object.assign({}, patch, { actualizado: root.firebase.database.ServerValue.TIMESTAMP, actualizadoPor: uidActual() });
    return r.child(CONFIG_PATH).update(p);
  }

  /* Llamada a la API de GitHub. Con token si hay; las lecturas del repo
     público funcionan también sin él (60 por hora). */
  function github(ruta, opts, token) {
    opts = opts || {};
    var headers = { Accept: 'application/vnd.github+json', 'X-GitHub-Api-Version': '2022-11-28' };
    if (token) headers.Authorization = 'Bearer ' + token;
    if (opts.body) headers['Content-Type'] = 'application/json';
    return fetch('https://api.github.com/repos/' + REPO + ruta, { method: opts.method || 'GET', headers: headers, body: opts.body ? JSON.stringify(opts.body) : undefined })
      .then(function (res) {
        return res.text().then(function (t) {
          var data = null;
          try { data = t ? JSON.parse(t) : null; } catch (e) { data = null; }
          return { ok: res.ok, status: res.status, data: data };
        });
      });
  }

  /* Dispara avisos.yml. Promise<{ok, motivo}>: 'sin-token', 'token-vencido'
     (401), 'sin-permiso' (403/404) o 'red'. */
  function dispararEnvio() {
    return leerConfig().then(function (cfg) {
      if (!cfg.githubToken) return { ok: false, motivo: 'sin-token' };
      return github('/actions/workflows/' + WORKFLOW_ENVIO + '/dispatches', { method: 'POST', body: { ref: RAMA } }, cfg.githubToken)
        .then(function (r) {
          if (r.ok) return { ok: true };
          return { ok: false, motivo: r.status === 401 ? 'token-vencido' : (r.status === 403 || r.status === 404 ? 'sin-permiso' : 'error-' + r.status) };
        }, function () { return { ok: false, motivo: 'red' }; });
    });
  }

  var MOTIVOS = {
    'sin-token': 'Falta configurar el token de GitHub (Administración → Avisos).',
    'token-vencido': 'El token de GitHub venció o no es válido (Administración → Avisos).',
    'sin-permiso': 'El token de GitHub no tiene permiso para lanzar el envío (Administración → Avisos).',
    red: 'No se pudo contactar a GitHub.'
  };
  function textoMotivo(m) { return MOTIVOS[m] || ('GitHub respondió con un error (' + String(m || '').replace('error-', '') + ').'); }

  /* Estado de los dos workflows y sus últimas ejecuciones, para el
     monitoreo en Administración → Avisos. */
  function estadoWorkflows(token) {
    function uno(archivo) {
      return Promise.all([
        github('/actions/workflows/' + archivo, null, token),
        github('/actions/workflows/' + archivo + '/runs?per_page=5', null, token)
      ]).then(function (r) {
        var wf = r[0].ok ? r[0].data : null;
        return {
          archivo: archivo,
          existe: !!wf,
          estado: wf ? wf.state : (r[0].status === 404 ? 'no-existe' : 'desconocido'),
          url: wf ? wf.html_url : 'https://github.com/' + REPO + '/actions',
          corridas: (r[1].ok && r[1].data && r[1].data.workflow_runs || []).map(function (c) {
            return { id: c.id, evento: c.event, estado: c.status, conclusion: c.conclusion, creado: c.created_at, url: c.html_url };
          })
        };
      });
    }
    return Promise.all([uno(WORKFLOW_ENVIO), uno(WORKFLOW_RESPALDO)]);
  }

  function reactivarRespaldo(token) {
    return github('/actions/workflows/' + WORKFLOW_RESPALDO + '/enable', { method: 'PUT' }, token).then(function (r) { return r.ok; });
  }

  /* Verifica el token y, si GitHub lo informa, su fecha de vencimiento. */
  function probarToken(token) {
    return fetch('https://api.github.com/repos/' + REPO, { headers: { Accept: 'application/vnd.github+json', Authorization: 'Bearer ' + token } })
      .then(function (res) {
        var vence = res.headers.get('github-authentication-token-expiration') || '';
        return { ok: res.ok, status: res.status, vence: vence ? vence.slice(0, 10) : '' };
      }, function () { return { ok: false, status: 0, vence: '' }; });
  }

  function historial(n, cb) {
    var r = db();
    if (!r) { cb([]); return function () {}; }
    var ref = r.child(COLA_PATH).orderByChild('creado').limitToLast(n || 20);
    var h = function (s) { cb(lista(s).reverse()); };
    ref.on('value', h, function () { cb([]); });
    return function () { ref.off('value', h); };
  }

  /* --- Panel (DOM propio, igual en las tres páginas) --- */

  var CSS = '' +
    '.av-fondo{position:fixed;inset:0;background:rgba(20,18,16,.45);z-index:2147483000;display:flex;align-items:center;justify-content:center;padding:16px;font-family:Archivo,system-ui,sans-serif}' +
    '.av-caja{background:#fff;color:#1d1b19;border-radius:16px;width:min(100%,520px);max-height:calc(100vh - 32px);display:flex;flex-direction:column;box-shadow:0 20px 50px rgba(0,0,0,.2)}' +
    '.av-cab{display:flex;align-items:flex-start;justify-content:space-between;gap:12px;padding:20px 22px 12px;border-bottom:1px solid rgba(0,0,0,.08)}' +
    '.av-kicker{font-size:11px;font-weight:800;letter-spacing:.14em;text-transform:uppercase;color:var(--ac,#0e7a3c)}' +
    '.av-tit{font-size:20px;font-weight:900;margin:4px 0 0;line-height:1.15}' +
    '.av-x{border:0;background:none;font-size:18px;cursor:pointer;color:#5d5a55;padding:4px 6px;border-radius:8px}' +
    '.av-cuerpo{padding:14px 22px 20px;overflow-y:auto;display:flex;flex-direction:column;gap:12px}' +
    '.av-correo{font-size:13px;line-height:1.45;padding:10px 12px;border-radius:10px;background:#f4f3f0;color:#5d5a55}' +
    '.av-correo.ok{background:var(--ac-lt,#e2f0e7);color:var(--ac-dk,#095a2c)}' +
    '.av-correo.err{background:#fdecea;color:#b00020}' +
    '.av-rot{font-size:11px;font-weight:800;letter-spacing:.12em;text-transform:uppercase;color:#8a867f;margin-top:4px}' +
    '.av-fila{display:flex;align-items:center;justify-content:space-between;gap:10px;padding:10px 0;border-top:1px solid rgba(0,0,0,.06)}' +
    '.av-fila:first-of-type{border-top:0}' +
    '.av-nom{font-size:14px;font-weight:700}' +
    '.av-sub{font-size:12px;color:#8a867f;margin-top:2px}' +
    '.av-btn{display:inline-flex;align-items:center;gap:6px;min-height:36px;padding:0 14px;border-radius:10px;border:1px solid rgba(0,0,0,.14);background:#fff;font:inherit;font-size:13px;font-weight:700;cursor:pointer;color:#1d1b19;text-decoration:none;white-space:nowrap;flex:none}' +
    '.av-btn.wa{background:#1f9d55;border-color:#1f9d55;color:#fff}' +
    '.av-btn.hecho{background:var(--ac-lt,#e2f0e7);border-color:transparent;color:var(--ac-dk,#095a2c)}' +
    '.av-btn[disabled]{opacity:.5;cursor:default}' +
    '.av-pre{white-space:pre-wrap;font-size:13px;line-height:1.5;background:#f4f3f0;border-radius:10px;padding:12px;margin:0;font-family:inherit}' +
    '.av-acc{display:flex;gap:8px;flex-wrap:wrap}';

  function asegurarCss() {
    if (document.getElementById('av-css')) return;
    var st = document.createElement('style');
    st.id = 'av-css';
    st.textContent = CSS;
    document.head.appendChild(st);
  }

  var panelActual = null;

  function cerrarPanel() {
    if (!panelActual) return;
    if (panelActual.unsub) panelActual.unsub();
    if (panelActual.el && panelActual.el.parentNode) panelActual.el.parentNode.removeChild(panelActual.el);
    document.removeEventListener('keydown', panelActual.onKey);
    panelActual = null;
  }

  function el(tag, cls, txt) {
    var e = document.createElement(tag);
    if (cls) e.className = cls;
    if (txt != null) e.textContent = txt;
    return e;
  }

  /* Muestra el panel. opts: {titulo, kicker, filas (planAvisos), vistaPrevia}. */
  function abrirPanel(opts) {
    cerrarPanel();
    asegurarCss();
    var fondo = el('div', 'av-fondo');
    var caja = el('div', 'av-caja');
    caja.setAttribute('role', 'dialog');
    caja.setAttribute('aria-modal', 'true');
    var cab = el('div', 'av-cab');
    var t = el('div');
    t.appendChild(el('div', 'av-kicker', opts.kicker || 'Avisos de programación'));
    t.appendChild(el('h2', 'av-tit', opts.titulo || 'Avisar al equipo'));
    var x = el('button', 'av-x', '✕');
    x.type = 'button';
    x.setAttribute('aria-label', 'Cerrar');
    x.onclick = cerrarPanel;
    cab.appendChild(t);
    cab.appendChild(x);
    var cuerpo = el('div', 'av-cuerpo');
    var correo = el('div', 'av-correo', 'Preparando el envío por correo…');
    cuerpo.appendChild(correo);

    var filas = opts.filas || [];
    if (opts.vistaPrevia && filas[0] && filas[0].aviso) cuerpo.appendChild(el('pre', 'av-pre', filas[0].aviso.texto));

    var conAviso = filas.filter(function (f) { return f.aviso; });
    if (conAviso.length) {
      cuerpo.appendChild(el('div', 'av-rot', 'WhatsApp'));
      var cont = el('div');
      conAviso.forEach(function (f) {
        var fila = el('div', 'av-fila');
        var info = el('div');
        info.style.minWidth = '0';
        info.appendChild(el('div', 'av-nom', f.nombre || f.email));
        info.appendChild(el('div', 'av-sub', f.aviso.lineas.length + (f.aviso.lineas.length === 1 ? ' evento' : ' eventos') +
          (f.telefono ? ' · ' + formatoTelefono(f.telefono) : ' · sin teléfono')));
        fila.appendChild(info);
        var b;
        if (f.telefono) {
          b = el('a', 'av-btn wa', 'Abrir WhatsApp');
          b.href = urlWhatsApp(f.telefono, f.aviso.texto);
          b.target = '_blank';
          b.rel = 'noopener';
          b.onclick = function () { b.className = 'av-btn hecho'; b.textContent = '✓ Abierto'; };
        } else {
          b = el('button', 'av-btn', 'Sin teléfono');
          b.type = 'button';
          b.disabled = true;
          b.title = 'Agrega el teléfono en Usuarios → Cuentas';
        }
        fila.appendChild(b);
        cont.appendChild(fila);
      });
      cuerpo.appendChild(cont);
    }
    var sinEventos = filas.filter(function (f) { return !f.aviso; });
    if (sinEventos.length) {
      cuerpo.appendChild(el('div', 'av-sub', (sinEventos.length === 1 ? sinEventos[0].nombre + ' no tiene' : sinEventos.length + ' personas no tienen') + ' eventos publicados próximos.'));
    }

    caja.appendChild(cab);
    caja.appendChild(cuerpo);
    fondo.appendChild(caja);
    fondo.addEventListener('click', function (e) { if (e.target === fondo) cerrarPanel(); });
    var onKey = function (e) { if (e.key === 'Escape') cerrarPanel(); };
    document.addEventListener('keydown', onKey);
    document.body.appendChild(fondo);
    panelActual = { el: fondo, onKey: onKey, unsub: null };

    return {
      correo: function (texto, clase) { correo.textContent = texto; correo.className = 'av-correo' + (clase ? ' ' + clase : ''); },
      alCerrar: function (unsub) { if (panelActual) panelActual.unsub = unsub; }
    };
  }

  /* Sigue el pedido en la cola y actualiza la línea de correo del panel. */
  function seguirPedido(key, panel, aviso) {
    var r = db();
    if (!r || !key) return;
    var ref = r.child(COLA_PATH).child(key);
    var h = function (s) {
      var v = s.val();
      if (!v) return;
      if (v.estado === 'enviado' || v.estado === 'error') {
        var n = v.enviados || 0, e = v.errores || 0;
        var txt = n ? ('✓ Correo enviado a ' + n + (n === 1 ? ' persona' : ' personas')) : 'No se envió ningún correo';
        if (e) txt += ' · ' + e + ' con error';
        if (v.sinCorreo) txt += ' · ' + v.sinCorreo + ' sin correo';
        txt += '.';
        if (v.fallo) txt += ' ' + textoFallo(v.fallo);
        panel.correo(txt, (e && !n) || v.fallo ? 'err' : 'ok');
      } else if (v.estado === 'procesando') {
        panel.correo('Enviando correos…');
      } else if (aviso) {
        panel.correo(aviso);
      }
    };
    ref.on('value', h);
    panel.alCerrar(function () { ref.off('value', h); });
  }

  function lanzar(pedido, filas, panel) {
    var conCorreo = filas.filter(function (f) { return f.aviso && f.email; });
    if (!conCorreo.length) {
      panel.correo(filas.some(function (f) { return f.aviso; }) ? 'Nadie tiene correo registrado.' : 'No hay eventos publicados próximos que avisar.');
      return;
    }
    panel.correo('Enviando correo a ' + conCorreo.length + (conCorreo.length === 1 ? ' persona…' : ' personas…'));
    /* Vía api.* para poder simularlos en pruebas desde la consola. */
    api.encolar(pedido).then(function (key) {
      return api.dispararEnvio().then(function (d) {
        var enCola = d.ok ? 'Enviando correos… (puede tardar un minuto)'
          : 'El correo quedó en cola y saldrá en la próxima revisión automática (unos 30 min). ' + textoMotivo(d.motivo);
        panel.correo(enCola, d.ok ? '' : 'err');
        api.seguirPedido(key, panel, enCola);
      });
    }).catch(function (err) {
      console.error('No se pudo encolar el aviso:', err);
      panel.correo('No se pudo registrar el envío por correo: revisa tu sesión o las reglas de Firebase.', 'err');
    });
  }

  /* Tras publicar: eventIds son solo los que pasaron a PUBLICADO. */
  function alPublicar(orgId, eventIds) {
    if (!orgId || !eventIds || !eventIds.length) return Promise.resolve();
    var pedido = { orgId: orgId, tipo: 'publicacion', eventIds: eventIds };
    return api.leerDatos(orgId).then(function (datos) {
      /* La lectura puede llegar antes de que el listener vea el cambio de
         estado: los recién publicados cuentan como PUBLICADO. */
      datos.eventos.forEach(function (ev) { if (eventIds.indexOf(ev.id) >= 0) ev.estado = 'PUBLICADO'; });
      var filas = planAvisos(pedido, datos);
      if (!filas.length) return;
      var n = eventIds.length;
      var panel = abrirPanel({
        kicker: n === 1 ? 'Evento publicado' : n + ' eventos publicados',
        titulo: 'Avisar al equipo (' + filas.length + ')',
        filas: filas
      });
      lanzar(pedido, filas, panel);
    }).catch(function (err) { console.error('Avisos al publicar:', err); });
  }

  /* "Reenviar eventos" de una cuenta (Usuarios → Cuentas). */
  function reenviar(orgId, uid) {
    var pedido = { orgId: orgId, tipo: 'reenvio', uid: uid };
    return api.leerDatos(orgId).then(function (datos) {
      var filas = planAvisos(pedido, datos);
      var f = filas[0];
      var panel = abrirPanel({ kicker: 'Reenviar eventos', titulo: f ? (f.nombre || f.email) : 'Sin persona vinculada', filas: filas, vistaPrevia: true });
      if (!f) { panel.correo('Esta cuenta no tiene persona vinculada en la organización.', 'err'); return; }
      if (!f.aviso) { panel.correo('No tiene eventos publicados próximos.', ''); return; }
      lanzar(pedido, filas, panel);
    }).catch(function (err) { console.error('Reenviar eventos:', err); });
  }

  /* Reabre el panel de la última publicación de la organización (botón
     "Avisos WhatsApp" del dashboard). El correo no se vuelve a enviar: solo
     se muestra cómo quedó; los enlaces de WhatsApp se arman con los datos
     actuales. Sin publicaciones en la cola, muestra a todos los que tienen
     eventos publicados próximos. */
  function abrirUltimo(orgId) {
    var r = db();
    if (!r || !orgId) return Promise.resolve();
    var cola = r.child(COLA_PATH).orderByChild('creado').limitToLast(50).once('value')
      .then(function (s) { return lista(s); }, function () { return []; });
    return Promise.all([api.leerDatos(orgId), cola]).then(function (res) {
      var datos = res[0];
      var ultimo = res[1].filter(function (p) { return p.orgId === orgId && p.tipo === 'publicacion' && p.eventIds; }).pop();
      var pedido, kicker;
      if (ultimo) {
        pedido = { orgId: orgId, tipo: 'publicacion', eventIds: ultimo.eventIds };
        var n = Object.keys(ultimo.eventIds).length;
        var cuando = ultimo.creado ? new Date(ultimo.creado).toLocaleString('es', { weekday: 'short', day: 'numeric', month: 'short', hour: 'numeric', minute: '2-digit' }) : '';
        kicker = 'Última publicación' + (cuando ? ' · ' + cuando : '') + ' · ' + n + (n === 1 ? ' evento' : ' eventos');
      } else {
        var hoy = datos.hoy || hoyIso();
        pedido = {
          orgId: orgId, tipo: 'publicacion',
          eventIds: datos.eventos.filter(function (ev) { return estadoEvento(ev) === 'PUBLICADO' && (ev.fecha || '') >= hoy; }).map(function (ev) { return ev.id; })
        };
        kicker = 'Eventos publicados próximos';
      }
      var filas = planAvisos(pedido, datos);
      var panel = abrirPanel({ kicker: kicker, titulo: 'Avisar al equipo (' + filas.length + ')', filas: filas });
      if (!filas.length) panel.correo('No hay personas con eventos publicados próximos.');
      else if (ultimo) {
        panel.correo('Revisando el correo de esta publicación…');
        api.seguirPedido(ultimo.id, panel, 'El correo de esta publicación sigue en cola.');
      } else panel.correo('El correo se envía al publicar; aquí solo están los enlaces de WhatsApp.');
    }).catch(function (err) { console.error('Abrir avisos:', err); });
  }

  api.leerDatos = leerDatos;
  api.encolar = encolar;
  api.registrarCambio = registrarCambio;
  api.leerConfig = leerConfig;
  api.guardarConfig = guardarConfig;
  api.dispararEnvio = dispararEnvio;
  api.textoMotivo = textoMotivo;
  api.estadoWorkflows = estadoWorkflows;
  api.reactivarRespaldo = reactivarRespaldo;
  api.probarToken = probarToken;
  api.historial = historial;
  api.alPublicar = alPublicar;
  api.reenviar = reenviar;
  api.abrirUltimo = abrirUltimo;
  api.cerrarPanel = cerrarPanel;
  api.seguirPedido = seguirPedido;
  root.RepertorioAvisos = api;
})(typeof window !== 'undefined' ? window : this);
