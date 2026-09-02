/* Modelo de datos del repertorio, multi-organizacional. Los eventos se
   guardan planos en /events/{id} con un campo organizationId; las
   organizaciones viven en /organizations/{id} y los usuarios/roles en
   /users/{uid}, todo en Firebase Realtime Database. La fecha de cada evento
   se guarda en formato ISO (YYYY-MM-DD); el mes y la semana se derivan de
   ahí. */
(function (w) {
  var ORGS_PATH = 'organizations';
  var USERS_PATH = 'users';
  var EVENTS_PATH = 'events';
  var INVITES_PATH = 'invitaciones';
  var SONG_CATALOG_PATH = 'songCatalog';
  var MUSICIANS_PATH = 'musicians';
  var META_PATH = 'meta';
  /* Correos que ya editaban el repertorio antes de que existiera el rol de
     admin (ver reglas de seguridad previas). La primera vez que inicien
     sesión después de la migración multi-organización, se auto-registran
     como 'admin' de la organización por defecto en vez de quedar
     pendientes — así no hace falta crear su doc de usuario a mano. Una vez
     migrado, la promoción de nuevos admins se hace desde el panel. */
  var BOOTSTRAP_ADMIN_EMAILS = ['joscarper@gmail.com', 'josuevaldizon1601@gmail.com'];
  var BOOTSTRAP_ORG_SLUG = 'templobetel';
  var FIREBASE_CONFIG = {
    apiKey: "AIzaSyDLMmgs75ekQJRDSHfIVt2ojp2A9fnuh58",
    authDomain: "repertoriodb-b84d8.firebaseapp.com",
    databaseURL: "https://repertoriodb-b84d8-default-rtdb.firebaseio.com",
    projectId: "repertoriodb-b84d8",
    storageBucket: "repertoriodb-b84d8.firebasestorage.app",
    messagingSenderId: "768768401559",
    appId: "1:768768401559:web:eba18fdb7919069fef89d2"
  };

  var MESES = ['enero','febrero','marzo','abril','mayo','junio','julio','agosto','septiembre','octubre','noviembre','diciembre'];
  var DIAS = ['Domingo','Lunes','Martes','Miércoles','Jueves','Viernes','Sábado'];
  var SERVICIOS = ['Cultos Dominicales','Culto Familiar','Vigilia General','Vigilia Juvenil','Evento Especial','Ensayo','Capacitación', 'Convocatoria', 'Otro'];
  /* Estos tipos de evento llevan repertorio musical (paso 3 con bloques de
     canciones); el resto sólo pide detalles/responsable y personas requeridas. */
  var SERVICIOS_CON_REPERTORIO = ['Cultos Dominicales','Culto Familiar','Vigilia General','Vigilia Juvenil','Evento Especial', 'Ensayo'];

  function usaRepertorio(servicio) { return SERVICIOS_CON_REPERTORIO.indexOf(servicio) >= 0; }

  function song(t, d, k, u, sm) { return { t: t || '', d: d || '', k: k || '', u: u || '', sm: sm || '' }; }

  /* Parte de la llave que representa "el mismo link": dos URLs de YouTube
     distintas en su forma (youtu.be vs watch?v= vs con &t=30 de más) pero que
     apuntan al mismo video deben contar como el mismo link, así que se
     compara por el ID de video ya extraído (ver youtubeId más abajo) y sólo
     se cae al texto crudo cuando el link no es de YouTube. */
  function songLinkIdentity(url) {
    var id = youtubeId(url);
    return id ? ('yt:' + id) : (url || '').trim().toLowerCase();
  }

  /* Llave estable para identificar una canción del catálogo: título + artista
     + link (el link es la parte más importante — dos participaciones con el
     mismo título/artista pero un link distinto son en la práctica versiones
     distintas, así que deben quedar como entradas separadas del catálogo en
     vez de fusionarse y perder una de las dos). Normalizada a
     minúsculas/recortada y saneada para servir de llave de Realtime Database
     (que prohíbe '.', '#', '$', '[', ']', '/' en las llaves). */
  function songKey(nombre, salmista, url) {
    var raw = (nombre || '').trim().toLowerCase() + '|' + (salmista || '').trim().toLowerCase() + '|' + songLinkIdentity(url);
    return encodeURIComponent(raw).replace(/\./g, '%2E');
  }

  /* Catálogo de canciones ya alimentadas en toda la base (no sólo un borrador
     puntual), deduplicado por título + artista + link (ver songKey): el tono
     queda fuera a propósito — es un dato de cada participación, no una llave
     de la canción.
     `overrides` (opcional) es el mapa crudo de /songCatalog/{orgId}: permite
     corregir título/artista/link de cara al autocompletado y al CRUD del
     panel de administración, o marcar la entrada como archivada, sin tocar el
     texto ya guardado en los eventos históricos que la usan. */
  function buildSongCatalog(eventos, overrides) {
    overrides = overrides || {};
    var porClave = new Map();
    (eventos || []).forEach(function (ev) {
      (ev.bloques || []).forEach(function (bl) {
        (bl.canciones || []).forEach(function (c) {
          var nombre = (c.t || '').trim();
          if (!nombre) return;
          var salmista = (c.sm || '').trim();
          var url = (c.u || '').trim();
          var key = songKey(nombre, salmista, url);
          if (!porClave.has(key)) porClave.set(key, { key: key, nombre: nombre, salmista: salmista, u: url });
        });
      });
    });
    var out = [];
    porClave.forEach(function (entry) {
      var ov = overrides[entry.key];
      out.push({
        key: entry.key,
        nombre: ov && ov.titulo ? ov.titulo : entry.nombre,
        salmista: ov && ov.artista !== undefined ? ov.artista : entry.salmista,
        u: ov && ov.url !== undefined ? ov.url : entry.u,
        archivado: !!(ov && ov.archivado)
      });
    });
    /* Canciones creadas directamente desde el CRUD de Repertorio (ver
       R.addSong), que todavía no han sido usadas en ningún evento: viven
       únicamente como override, sin entrada correspondiente en `porClave`. Se
       agregan aquí para que también aparezcan en el catálogo — y por lo
       tanto en el autocompletado del Formulario — igual que cualquier otra
       canción. */
    Object.keys(overrides).forEach(function (key) {
      if (porClave.has(key)) return;
      var ov = overrides[key];
      if (!ov || !ov.titulo) return;
      out.push({ key: key, nombre: ov.titulo, salmista: ov.artista || '', u: ov.url || '', archivado: !!ov.archivado });
    });
    out.sort(function (a, b) { return a.nombre.localeCompare(b.nombre, 'es'); });
    return out;
  }

  /* Etiqueta con la que se muestra una canción donde sea que aparezca su
     nombre: si tiene salmista (artista/versión de origen), se concatena
     entre paréntesis para distinguir covers del mismo título. */
  function songLabel(c) {
   var t = ((c && c.t) || '').trim();
   var sm = ((c && c.sm) || '').trim();
   var fullText = sm ? (t + ' (' + sm + ')') : t;
  
   // Dividir por saltos de línea
   var lines = fullText.split('\n');
  
   return {
    fullText: fullText,
    lines: lines,
    hasLineBreaks: lines.length > 1
   };
  }

  /* Extrae el ID de video de un link de YouTube en cualquiera de sus formas
     usuales (youtu.be, watch?v=, embed/, shorts/), ignorando parámetros extra
     como &t= o &list=. Devuelve '' si el link no es de YouTube o no trae ID. */
  function youtubeId(url) {
    var m = /(?:youtu\.be\/|youtube(?:-nocookie)?\.com\/(?:watch\?(?:.*&)?v=|embed\/|shorts\/|v\/))([A-Za-z0-9_-]{6,})/i.exec(String(url || ''));
    return m ? m[1] : '';
  }

  /* Controlador de un único reproductor de YouTube oculto, compartido por
     todas las filas de canciones de una página (evita crear un iframe por
     fila). onChange(key|null, paused) se llama con la llave de la fila que
     quedó cargada (o null cuando se termina) y si está en pausa, para que el
     componente sólo tenga que reflejar esos valores en su estado. */
  function youtubeController(elementId, onChange) {
    var player = null, ready = false, pending = null, current = null, currentVideoId = null, paused = false;

    function start() {
      if (player || !w.YT || !w.YT.Player) return;
      player = new w.YT.Player(elementId, {
        height: '0', width: '0',
        playerVars: { controls: 0, disablekb: 1, playsinline: 1 },
        events: {
          onReady: function () {
            ready = true;
            if (pending) { var p = pending; pending = null; toggle(p.key, p.videoId); }
          },
          onStateChange: function (e) {
            if (e.data === w.YT.PlayerState.ENDED) { current = null; currentVideoId = null; paused = false; if (onChange) onChange(null, false); }
          }
        }
      });
    }

    if (w.YT && w.YT.Player) start();
    else {
      var prevReady = w.onYouTubeIframeAPIReady;
      w.onYouTubeIframeAPIReady = function () { if (prevReady) prevReady(); start(); };
      if (!document.getElementById('yt-iframe-api')) {
        var tag = document.createElement('script');
        tag.id = 'yt-iframe-api';
        tag.src = 'https://www.youtube.com/iframe_api';
        document.head.appendChild(tag);
      }
    }

    /* Misma canción ya cargada Y mismo video: alterna pausa/reanudar sin
       perder la posición. Canción distinta, o misma fila pero con un link
       editado a otro video (ver el CRUD de Repertorio del panel), carga y
       reproduce desde el inicio — comparar solo por `key` no bastaba, porque
       la llave de una canción no cambia cuando se le corrige el link. */
    function toggle(key, videoId) {
      if (!videoId) return;
      if (!ready) { pending = { key: key, videoId: videoId }; return; }
      if (current === key && currentVideoId === videoId) {
        if (paused) { player.playVideo(); paused = false; } else { player.pauseVideo(); paused = true; }
        if (onChange) onChange(key, paused);
      } else {
        player.loadVideoById(videoId);
        player.playVideo();
        current = key;
        currentVideoId = videoId;
        paused = false;
        if (onChange) onChange(key, false);
      }
    }

    function destroy() { if (player && player.destroy) player.destroy(); }

    return { toggle: toggle, destroy: destroy };
  }

  function defaultBlocks() {
    return [
      { titulo: 'Alabanza de inicio', canciones: [song()] },
      { titulo: 'Júbilo', canciones: [song(), song()] },
      { titulo: 'Adoración', canciones: [song(), song()] },
      { titulo: 'Himno', canciones: [song()] },
      { titulo: 'Ofrenda', canciones: [song()] }
    ];
  }

  /* Roles de banda que se solicitan por defecto. Los que llevan "numerar"
     muestran su número desde el primero (Piano 1); el resto no muestra
     número hasta que se agregue un segundo del mismo tipo (Bajo, Bajo 2). */
  var BANDA_ROLES = [
    { tipo: 'Director de Alabanza', cantidad: 2, numerar: true },
    { tipo: 'Corista', cantidad: 3, numerar: true },
    { tipo: 'Piano', cantidad: 1, numerar: true },
    { tipo: 'Guitarra Eléctrica', cantidad: 1, numerar: false },
    { tipo: 'Guitarra Acústica', cantidad: 1, numerar: false },
    { tipo: 'Bajo', cantidad: 1, numerar: false },
    { tipo: 'Batería', cantidad: 1, numerar: false }
  ];

  function bandaSlot(tipo, numero) { return { id: uid(), tipo: tipo, numero: numero || null, nombre: '', resaltado: false, tarea: '' }; }

  function defaultBanda() {
    var out = [];
    BANDA_ROLES.forEach(function (r) {
      for (var i = 1; i <= r.cantidad; i++) out.push(bandaSlot(r.tipo, r.numerar ? i : null));
    });
    return out;
  }

  function bandaLabel(slot) { return slot.numero ? (slot.tipo + ' ' + slot.numero) : slot.tipo; }

  /* Siguiente número disponible para agregar otro integrante del mismo tipo
     (un slot sin número cuenta como 1, así la próxima incorporación es 2). */
  function bandaSiguienteNumero(banda, tipo) {
    var existentes = (banda || []).filter(function (b) { return b.tipo === tipo; }).map(function (b) { return b.numero || 1; });
    var max = existentes.length ? Math.max.apply(null, existentes) : 0;
    return max + 1;
  }

  function uid() { return 'e' + Math.random().toString(36).slice(2, 9); }

  /* La iglesia opera en horario de El Salvador (UTC-6, sin horario de
     verano), así que la hora local del evento se ancla a esa zona al
     construir el .ics / enlace de Google Calendar: así muestran la hora
     correcta sin depender de la zona horaria del dispositivo del usuario. */
  var TZ_OFFSET_HORAS = 6;
  var DURACION_DEFECTO_MIN = 90;

  function pad2(n) { return String(n).padStart(2, '0'); }

  function parseHora12(horaStr) {
    var m = /^(\d{1,2}):(\d{2})\s*([ap]m)$/i.exec(String(horaStr || '').trim());
    if (!m) return { h: 9, m: 0 };
    var h = Number(m[1]) % 12;
    if (/pm/i.test(m[3])) h += 12;
    return { h: h, m: Number(m[2]) };
  }

  /* Minutos desde medianoche para poder comparar/ordenar horas en formato
     "H:MM am/pm" numéricamente (una comparación de texto ordenaría "10:00 am"
     antes de "9:00 am"). */
  function horaMinutos(horaStr) {
    var t = parseHora12(horaStr);
    return t.h * 60 + t.m;
  }

  function eventoInicioUTC(ev) {
    var f = parse(ev.fecha);
    var t = parseHora12(ev.hora);
    return new Date(Date.UTC(f.getFullYear(), f.getMonth(), f.getDate(), t.h + TZ_OFFSET_HORAS, t.m, 0));
  }
  function eventoFinUTC(ev) {
    return new Date(eventoInicioUTC(ev).getTime() + DURACION_DEFECTO_MIN * 60000);
  }
  function stampUTC(d) {
    return d.getUTCFullYear() + pad2(d.getUTCMonth() + 1) + pad2(d.getUTCDate()) + 'T' +
      pad2(d.getUTCHours()) + pad2(d.getUTCMinutes()) + pad2(d.getUTCSeconds()) + 'Z';
  }

  function eventoTitulo(ev) {
    return [ev.servicio, (ev.tema || '').trim()].filter(Boolean).join(' — ') || 'Evento';
  }

  /* Descripción para calendario externo (.ics / Google Calendar): sin
     enlaces, sólo texto plano. Para eventos con repertorio musical incluye
     banda y canciones (con tono); para el resto, únicamente la descripción
     del evento y las personas requeridas. */
  function eventoDescripcion(ev) {
    var out = [];
    if (usaRepertorio(ev.servicio)) {
      var orden = BANDA_ROLES.map(function (r) { return r.tipo; });
      var banda = (ev.banda || [])
        .filter(function (b) { return b.nombre && b.nombre.trim(); })
        .slice()
        .sort(function (a, b) {
          var d = orden.indexOf(a.tipo) - orden.indexOf(b.tipo);
          return d !== 0 ? d : (a.numero || 0) - (b.numero || 0);
        });
      if (banda.length) {
        out.push('Banda:');
        banda.forEach(function (b) { out.push(b.tipo + ': ' + b.nombre.trim()); });
        out.push('');
      }
      var canciones = [];
      (ev.bloques || []).forEach(function (bl) {
        (bl.canciones || []).forEach(function (c) { if (c.t && c.t.trim()) canciones.push(c); });
      });
      if (canciones.length) {
        out.push('Canciones:');
        canciones.forEach(function (c) { out.push('- ' + c.t.trim() + (c.k && c.k.trim() ? ' (' + c.k.trim() + ')' : '')); });
        out.push('');
      }
      out.push('Descripción:');
      out.push(ev.tema && ev.tema.trim() ? ev.tema.trim() : 'Por confirmar');
      if (ev.cita && ev.cita.trim()) out.push(ev.cita.trim());
    } else {
      if (ev.detalles && ev.detalles.trim()) out.push(ev.detalles.trim());
      if (ev.personas && ev.personas.trim()) {
        if (out.length) out.push('');
        out.push('Personas requeridas:');
        out.push(ev.personas.trim());
      }
    }
    return out.join('\n');
  }

  function icsEscape(text) {
    return String(text || '')
      .replace(/\\/g, '\\\\')
      .replace(/;/g, '\\;')
      .replace(/,/g, '\\,')
      .replace(/\r\n|\n|\r/g, '\\n');
  }

  /* Pliegue de línea a 75 octetos según RFC5545; las continuaciones llevan
     un espacio inicial. */
  function icsFoldLine(line) {
    var out = [];
    var s = line;
    while (s.length > 75) {
      out.push(s.slice(0, 75));
      s = ' ' + s.slice(75);
    }
    out.push(s);
    return out.join('\r\n');
  }

  function buildIcs(ev) {
    var lines = [
      'BEGIN:VCALENDAR',
      'VERSION:2.0',
      'PRODID:-//Ministerio de Alabanza//RepertorioApp//ES',
      'CALSCALE:GREGORIAN',
      'METHOD:PUBLISH',
      'BEGIN:VEVENT',
      'UID:' + ev.id + '@repertorio-app',
      'DTSTAMP:' + stampUTC(new Date()),
      'DTSTART:' + stampUTC(eventoInicioUTC(ev)),
      'DTEND:' + stampUTC(eventoFinUTC(ev)),
      'SUMMARY:' + icsEscape(eventoTitulo(ev)),
      'DESCRIPTION:' + icsEscape(eventoDescripcion(ev)),
      'END:VEVENT',
      'END:VCALENDAR'
    ];
    return lines.map(icsFoldLine).join('\r\n') + '\r\n';
  }

  function icsDataHref(ev) {
    return 'data:text/calendar;charset=utf-8,' + encodeURIComponent(buildIcs(ev));
  }

  function icsFilename(ev) {
    return 'evento-' + (ev.fecha || 'sf') + '.ics';
  }

  function googleCalendarUrl(ev) {
    var params = new URLSearchParams({
      action: 'TEMPLATE',
      text: eventoTitulo(ev),
      dates: stampUTC(eventoInicioUTC(ev)) + '/' + stampUTC(eventoFinUTC(ev)),
      details: eventoDescripcion(ev)
    });
    return 'https://calendar.google.com/calendar/render?' + params.toString();
  }

  /* Estados del ciclo de vida de un evento. BORRADOR/PUBLICADO se controlan
     desde el paso final del asistente; CANCELADO/ARCHIVADO se marcan con
     acciones rápidas desde el listado del día, sin pasar por el asistente. */
  var ESTADOS_EVENTO = ['BORRADOR', 'PUBLICADO', 'CANCELADO', 'ARCHIVADO'];
  var ESTADOS_VISIBLES_PUBLICO = ['PUBLICADO', 'CANCELADO'];

  /* Los eventos guardados antes de que existiera este campo no tienen
     `estado`: se tratan como PUBLICADO, ya que antes todo lo guardado se
     publicaba de inmediato. */
  function estadoEvento(ev) { return (ev && ev.estado) || 'PUBLICADO'; }

  function esVisiblePublico(ev) { return ESTADOS_VISIBLES_PUBLICO.indexOf(estadoEvento(ev)) >= 0; }

  function estadoInfo(ev) {
    var map = {
      BORRADOR: { label: 'Borrador', bg: '#c7cad0', color: '#3a3f47' },
      PUBLICADO: { label: 'Publicado', bg: 'var(--ac)', color: '#fff' },
      CANCELADO: { label: 'Cancelado', bg: '#b00020', color: '#fff' },
      ARCHIVADO: { label: 'Archivado', bg: '#6b6866', color: '#fff' }
    };
    return map[estadoEvento(ev)] || map.PUBLICADO;
  }

  function newEvento(o) {
    o = o || {};
    return {
      id: o.id || uid(),
      fecha: o.fecha || '',
      hora: o.hora || '8:00 am',
      servicio: o.servicio || SERVICIOS[0],
      tema: o.tema || '',
      cita: o.cita || '',
      avisoImportante: o.avisoImportante || '',
      notas: o.notas || '',
      bloques: o.bloques || defaultBlocks(),
      banda: o.banda || defaultBanda(),
      detalles: o.detalles || '',
      personas: o.personas || '',
      organizationId: o.organizationId || '',
      estado: o.estado || 'BORRADOR'
    };
  }

  function parse(iso) {
    var p = String(iso || '').split('-');
    return new Date(Number(p[0]), Number(p[1]) - 1, Number(p[2]));
  }
  function iso(y, m, d) {
    return y + '-' + String(m + 1).padStart(2, '0') + '-' + String(d).padStart(2, '0');
  }
  function monthKey(isoStr) { return String(isoStr || '').slice(0, 7); }
  function monthLabel(key) {
    var p = String(key || '').split('-');
    if (p.length < 2) return '';
    var n = MESES[Number(p[1]) - 1] || '';
    return n.charAt(0).toUpperCase() + n.slice(1) + ' ' + p[0];
  }
  function diaNombre(isoStr) { return DIAS[parse(isoStr).getDay()]; }
  function fechaLarga(isoStr) {
    var d = parse(isoStr);
    return d.getDate() + ' de ' + MESES[d.getMonth()];
  }
  /* Semana del mes según la fila del calendario (domingo a sábado), tope 6:
     un mes puede empezar en sábado y tener 31 días, lo que ocupa 6 filas. */
  function semanaDelMes(isoStr) {
    var d = parse(isoStr);
    var primero = new Date(d.getFullYear(), d.getMonth(), 1).getDay();
    return Math.min(6, Math.floor((d.getDate() + primero - 1) / 7) + 1);
  }
  function hoyKey() {
    var n = new Date();
    return n.getFullYear() + '-' + String(n.getMonth() + 1).padStart(2, '0');
  }

  /* Filas del calendario para un mes: seis como máximo, la última se fusiona
     en la quinta para respetar el tope de cinco semanas. */
  function calendario(year, month) {
    var primero = new Date(year, month, 1).getDay();
    var dias = new Date(year, month + 1, 0).getDate();
    var celdas = [];
    for (var i = 0; i < primero; i++) celdas.push(null);
    for (var d = 1; d <= dias; d++) celdas.push({ dia: d, iso: iso(year, month, d) });
    while (celdas.length % 7) celdas.push(null);
    var filas = [];
    for (var j = 0; j < celdas.length; j += 7) filas.push(celdas.slice(j, j + 7));
    return filas;
  }

  function clone(x) { return JSON.parse(JSON.stringify(x)); }

  /* --- Conexión con Firebase (Auth + Realtime Database) --- */

  function ensureApp() {
    if (!w.firebase) return false;
    if (!w.firebase.apps || !w.firebase.apps.length) w.firebase.initializeApp(FIREBASE_CONFIG);
    return true;
  }

  function dbRoot() {
    if (!ensureApp() || !w.firebase.database) return null;
    try { return w.firebase.database().ref(); } catch (e) { return null; }
  }

  /* Autenticación con Google, usada por admin.html y por el Formulario: la
     lectura del calendario publicado se queda pública, pero escribir
     requiere una sesión que las reglas de la base de datos puedan verificar
     del lado del servidor. */
  function ensureAuthApp() {
    if (!ensureApp() || !w.firebase.auth) return null;
    return w.firebase.auth();
  }

  function signInWithGoogle() {
    var auth = ensureAuthApp();
    if (!auth) return Promise.reject(new Error('Firebase Auth no disponible'));
    return auth.signInWithPopup(new w.firebase.auth.GoogleAuthProvider());
  }

  function signOutUser() {
    var auth = ensureAuthApp();
    return auth ? auth.signOut() : Promise.resolve();
  }

  /* cb(user|null) se llama de inmediato con el estado actual y de nuevo cada
     vez que cambia (login/logout, incluso en otra pestaña). Devuelve una
     función para dejar de escuchar. */
  function onAuthChange(cb) {
    var auth = ensureAuthApp();
    if (!auth) { cb(null); return function () {}; }
    return auth.onAuthStateChanged(cb);
  }

  /* Convierte un DataSnapshot de un nodo de "muchos hijos" en un arreglo
     plano de objetos (cada uno con su key ya mezclada si el objeto no trae
     id propio). */
  function snapshotToArray(snap) {
    var out = [];
    snap.forEach(function (child) {
      var v = child.val() || {};
      if (!v.id) v.id = child.key;
      out.push(v);
    });
    return out;
  }

  /* minúsculas, sin acentos/diacríticos, solo [a-z0-9]: "Templo Betel" ->
     "templobetel". No garantiza unicidad por sí sola (ver createOrganization,
     que revisa colisiones antes de guardar). */
  function slugify(name) {
    return String(name || '')
      .normalize('NFD')
      .toLowerCase()
      .replace(/[^a-z0-9]/g, '');
  }

  /* Las llaves de Realtime Database no admiten '.', así que un correo no
     puede usarse tal cual como llave de /invitaciones. Solo se sustituye el
     punto (el único carácter prohibido que aparece en la práctica en un
     correo real); esta misma sustitución se replica del lado de las reglas
     de seguridad para poder validar el auto-consumo de la invitación. */
  function emailKey(email) {
    return String(email || '').trim().toLowerCase().replace(/\./g, ',');
  }

  /* --- Organizaciones --- */

  function watchAllOrganizations(cb) {
    var root = dbRoot();
    if (!root) return function () {};
    var ref = root.child(ORGS_PATH);
    var handler = function (snap) { cb(snapshotToArray(snap)); };
    ref.on('value', handler);
    return function () { ref.off('value', handler); };
  }

  function getOrganization(orgId, cb) {
    var root = dbRoot();
    if (!root || !orgId) { cb(null); return; }
    root.child(ORGS_PATH).child(orgId).once('value').then(function (snap) {
      var v = snap.val();
      if (v) v.id = orgId;
      cb(v);
    }, function () { cb(null); });
  }

  function getOrganizationBySlug(slug, cb) {
    var root = dbRoot();
    if (!root) { cb(null); return; }
    root.child(ORGS_PATH).orderByChild('slug').equalTo(slug).once('value').then(function (snap) {
      var arr = snapshotToArray(snap);
      cb(arr.length ? arr[0] : null);
    }, function () { cb(null); });
  }

  /* cb(org|null, error|null). Revisa que el slug generado del nombre no
     colisione con uno existente antes de escribir (agrega un sufijo numérico
     si hace falta). */
  function createOrganization(name, cb) {
    var root = dbRoot();
    if (!root) { cb && cb(null, new Error('Firebase no disponible')); return; }
    var base = slugify(name) || 'organizacion';
    root.child(ORGS_PATH).once('value').then(function (snap) {
      var existentes = snapshotToArray(snap).map(function (o) { return o.slug; });
      var slug = base, n = 2;
      while (existentes.indexOf(slug) >= 0) { slug = base + n; n++; }
      var id = root.child(ORGS_PATH).push().key;
      var org = { id: id, name: name, slug: slug, kicker: 'Calendario mensual', nota: '', createdAt: Date.now() };
      root.child(ORGS_PATH).child(id).set(org).then(function () { cb && cb(org, null); }, function (err) { cb && cb(null, err); });
    }, function (err) { cb && cb(null, err); });
  }

  /* patch no puede tocar id/slug (el slug es inmutable una vez creado para
     no romper enlaces ?group=slug ya compartidos). bannerUrl es una URL de
     imagen alojada externamente (no se sube ningún archivo, para mantener
     el sitio sin costo de Firebase Storage). */
  function updateOrganization(orgId, patch, cb) {
    var root = dbRoot();
    if (!root) { cb && cb(false); return; }
    var safe = { name: patch.name, kicker: patch.kicker, nota: patch.nota };
    if (patch.bannerUrl !== undefined) safe.bannerUrl = patch.bannerUrl;
    root.child(ORGS_PATH).child(orgId).update(safe).then(function () { cb && cb(true); }, function () { cb && cb(false); });
  }

  function countEventsForOrg(orgId, cb) {
    var root = dbRoot();
    if (!root) { cb(0); return; }
    root.child(EVENTS_PATH).orderByChild('organizationId').equalTo(orgId).once('value').then(function (snap) {
      cb(snap.numChildren());
    }, function () { cb(0); });
  }

  function countUsersForOrg(orgId, cb) {
    var root = dbRoot();
    if (!root) { cb(0); return; }
    root.child(USERS_PATH).once('value').then(function (snap) {
      var n = 0;
      snap.forEach(function (child) {
        var v = child.val();
        if (v && v.organizationIds && v.organizationIds[orgId]) n++;
      });
      cb(n);
    }, function () { cb(0); });
  }

  /* Borra la organización, todos sus eventos, y la referencia a ella en
     cualquier usuario que la tuviera asignada — en una sola escritura
     multi-ruta (atómica): o se aplica todo, o no se aplica nada. */
  function deleteOrganization(orgId, cb) {
    var root = dbRoot();
    if (!root) { cb && cb(false); return; }
    root.child(EVENTS_PATH).orderByChild('organizationId').equalTo(orgId).once('value').then(function (eventsSnap) {
      root.child(USERS_PATH).once('value').then(function (usersSnap) {
        var updates = {};
        updates[ORGS_PATH + '/' + orgId] = null;
        eventsSnap.forEach(function (child) { updates[EVENTS_PATH + '/' + child.key] = null; });
        usersSnap.forEach(function (child) {
          var v = child.val();
          if (v && v.organizationIds && v.organizationIds[orgId]) {
            updates[USERS_PATH + '/' + child.key + '/organizationIds/' + orgId] = null;
          }
        });
        root.update(updates).then(function () { cb && cb(true); }, function () { cb && cb(false); });
      }, function () { cb && cb(false); });
    }, function () { cb && cb(false); });
  }

  /* --- Usuarios --- */

  /* Se llama justo después de cada login. Si el usuario no tiene doc en
     /users todavía, lo crea como 'normal' sin organizaciones asignadas
     (queda pendiente de que un admin lo vincule). cb(userDoc). */
  function ensureUserRegistered(firebaseUser, cb) {
    var root = dbRoot();
    if (!root || !firebaseUser) { cb && cb(null); return; }
    var ref = root.child(USERS_PATH).child(firebaseUser.uid);
    var email = firebaseUser.email || '';

    /* El ascenso a admin de un correo "bootstrap" no depende de en qué orden
       pasaron las cosas: se intenta tanto al crear el doc por primera vez
       como en cada visita posterior mientras siga pendiente (organización
       por defecto todavía no existía cuando se registró la primera vez). */
    function promoverSiAplica(doc, onDone) {
      if (BOOTSTRAP_ADMIN_EMAILS.indexOf(email) < 0 || doc.role === 'admin') { onDone(doc); return; }
      getOrganizationBySlug(BOOTSTRAP_ORG_SLUG, function (org) {
        if (!org) { onDone(doc); return; }
        doc.role = 'admin';
        doc.organizationIds = {};
        doc.organizationIds[org.id] = true;
        ref.update({ role: doc.role, organizationIds: doc.organizationIds }).then(function () { onDone(doc); }, function () { onDone(doc); });
      });
    }

    /* Si un admin ya invitó este correo (rol + organizaciones definidos de
       antemano desde el panel), se usa eso en vez del valor por defecto
       'normal' sin organización; la invitación se borra una vez consumida
       para no volver a aplicarse en un futuro cambio de rol manual. */
    function crearConInvitacionSiAplica(onDone) {
      var key = emailKey(email);
      root.child(INVITES_PATH).child(key).once('value').then(function (inviteSnap) {
        var doc = {
          uid: firebaseUser.uid,
          email: email,
          displayName: firebaseUser.displayName || email,
          role: 'normal',
          createdAt: Date.now()
        };
        var invite = inviteSnap.exists() ? inviteSnap.val() : null;
        if (invite) {
          doc.role = invite.role === 'admin' ? 'admin' : 'normal';
          if (invite.organizationIds) doc.organizationIds = invite.organizationIds;
          /* Si la invitación venía pre-vinculada a un perfil de músico (ver
             módulo de Usuarios de admin.html), la cuenta recién creada queda
             vinculada a ese músico en las mismas organizaciones de la
             invitación, sin que el admin tenga que repetir el paso luego. */
          if (invite.musicianId) {
            doc.musicianLinks = {};
            Object.keys(invite.organizationIds || {}).forEach(function (orgId) { doc.musicianLinks[orgId] = invite.musicianId; });
          }
        }
        ref.set(doc).then(function () {
          if (!invite) { onDone(doc); return; }
          /* El vínculo con el músico se escribe ANTES de borrar la
             invitación (y a propósito solo toca `userId`, ningún otro
             campo): las reglas de seguridad autorizan este auto-vínculo
             comparando contra la invitación viva de este correo, así que
             borrarla primero dejaría el vínculo sin forma de validarse. Si
             esta escritura es rechazada (invitación ya no vigente, etc.), la
             invitación se conserva en vez de perderse en silencio. */
          if (invite.musicianId) {
            root.child(MUSICIANS_PATH).child(invite.musicianId).child('userId').set(firebaseUser.uid).then(function () {
              root.child(INVITES_PATH).child(key).remove();
            });
          } else {
            root.child(INVITES_PATH).child(key).remove();
          }
          onDone(doc);
        }, function () { onDone(doc); });
      }, function () {
        var doc = { uid: firebaseUser.uid, email: email, displayName: firebaseUser.displayName || email, role: 'normal', createdAt: Date.now() };
        ref.set(doc).then(function () { onDone(doc); }, function () { onDone(doc); });
      });
    }

    function intentar(reintentosRestantes) {
      ref.once('value').then(function (snap) {
        if (snap.exists()) {
          var v = snap.val();
          v.uid = firebaseUser.uid;
          promoverSiAplica(v, function (doc) { cb && cb(doc); });
          return;
        }
        crearConInvitacionSiAplica(function (doc) {
          promoverSiAplica(doc, function (d) { cb && cb(d); });
        });
      }, function (err) {
        /* Justo después de recargar la página, el evento de sesión de
           Firebase Auth puede llegar antes de que la conexión de Realtime
           Database termine de propagar el token: la primera lectura puede
           salir "permission_denied" aunque la sesión sí sea válida. Forzar
           la renovación del token empuja al SDK a reautenticar la conexión
           de la base de datos, además de darle más tiempo con reintentos. */
        if (reintentosRestantes > 0 && err && err.code === 'PERMISSION_DENIED') {
          var auth = ensureAuthApp();
          var actual = auth && auth.currentUser;
          var refrescar = actual ? actual.getIdToken(true) : Promise.resolve();
          refrescar.then(function () {
            setTimeout(function () { intentar(reintentosRestantes - 1); }, 1200);
          }, function () {
            setTimeout(function () { intentar(reintentosRestantes - 1); }, 1200);
          });
          return;
        }
        cb && cb(null);
      });
    }

    intentar(5);
  }

  function watchUser(uid, cb) {
    var root = dbRoot();
    if (!root) return function () {};
    var ref = root.child(USERS_PATH).child(uid);
    var handler = function (snap) {
      var v = snap.val();
      if (v) v.uid = uid;
      cb(v);
    };
    ref.on('value', handler);
    return function () { ref.off('value', handler); };
  }

  /* Solo debe llamarse si el usuario actual ya es 'admin' (las reglas del
     servidor lo exigen igualmente). */
  function watchAllUsers(cb) {
    var root = dbRoot();
    if (!root) return function () {};
    var ref = root.child(USERS_PATH);
    var handler = function (snap) { cb(snapshotToArray(snap)); };
    ref.on('value', handler);
    return function () { ref.off('value', handler); };
  }

  function setUserRole(uid, role, cb) {
    var root = dbRoot();
    if (!root) { cb && cb(false); return; }
    root.child(USERS_PATH).child(uid).child('role').set(role).then(function () { cb && cb(true); }, function () { cb && cb(false); });
  }

  function deleteUser(uid, cb) {
    var root = dbRoot();
    if (!root) { cb && cb(false); return; }
    root.child(USERS_PATH).child(uid).remove().then(function () { cb && cb(true); }, function () { cb && cb(false); });
  }

  /* orgIds: arreglo de organizationId. Se guarda como mapa {orgId: true}
     para que las reglas de seguridad puedan usar hasChild(orgId) al validar
     pertenencia (un arreglo JS se guarda como objeto con llaves "0","1",...
     lo que no sirve para ese chequeo). */
  function setUserOrgs(uid, orgIds, cb) {
    var root = dbRoot();
    if (!root) { cb && cb(false); return; }
    var map = {};
    (orgIds || []).forEach(function (id) { map[id] = true; });
    root.child(USERS_PATH).child(uid).child('organizationIds').set(map).then(function () { cb && cb(true); }, function () { cb && cb(false); });
  }

  /* El doc de usuario guarda organizationIds como mapa {orgId:true}; esta
     función la vuelve un arreglo de ids para que el resto de la app (que
     piensa en listas) no tenga que conocer ese detalle de almacenamiento. */
  function userOrgIds(userDoc) {
    return userDoc && userDoc.organizationIds ? Object.keys(userDoc.organizationIds) : [];
  }

  /* {organizationId: musicianId} — a qué perfil de músico está vinculada
     esta cuenta en cada organización (puede no tener ninguno todavía). */
  function userMusicianLinks(userDoc) {
    return (userDoc && userDoc.musicianLinks) || {};
  }

  /* Usada por admin.html y el Formulario cuando a un usuario no le toca
     estar ahí (rol 'normal', o sin organización asignada todavía), y por
     index.html tras cada login: lo manda a su Dashboard (eventos propios +,
     si es admin, acceso al panel), o a index.html a secas si aún no tiene
     ninguna organización asignada (ahí verá el mensaje de "esperando
     asignación"). */
  function redirectToUserLanding(userDoc) {
    var ids = userOrgIds(userDoc);
    if (!ids.length) { w.location.href = 'index.html'; return; }
    getOrganization(ids[0], function (org) {
      w.location.href = org ? ('dashboard.html?org=' + org.slug) : 'index.html';
    });
  }

  /* --- Invitaciones (alta de usuarios antes de su primer login) --- */

  /* orgIds: arreglo de organizationId, igual que setUserOrgs. musicianId
     (opcional) pre-vincula la cuenta que se cree al primer login con un
     perfil de músico ya existente (ver módulo de Usuarios de admin.html),
     para que un músico migrado sin correo quede con acceso a su Dashboard
     en cuanto inicie sesión. Sobrescribe cualquier invitación previa para
     ese mismo correo. */
  function createInvitation(email, role, orgIds, musicianId, cb) {
    var root = dbRoot();
    if (!root) { cb && cb(false); return; }
    var map = {};
    (orgIds || []).forEach(function (id) { map[id] = true; });
    var doc = {
      email: String(email || '').trim().toLowerCase(),
      role: role === 'admin' ? 'admin' : 'normal',
      organizationIds: map,
      createdAt: Date.now()
    };
    if (musicianId) doc.musicianId = musicianId;
    root.child(INVITES_PATH).child(emailKey(email)).set(doc).then(function () { cb && cb(true); }, function () { cb && cb(false); });
  }

  /* Solo debe llamarse si el usuario actual ya es 'admin' (las reglas del
     servidor lo exigen igualmente). */
  function watchInvitations(cb) {
    var root = dbRoot();
    if (!root) return function () {};
    var ref = root.child(INVITES_PATH);
    var handler = function (snap) { cb(snapshotToArray(snap)); };
    ref.on('value', handler);
    return function () { ref.off('value', handler); };
  }

  function deleteInvitation(key, cb) {
    var root = dbRoot();
    if (!root) { cb && cb(false); return; }
    root.child(INVITES_PATH).child(key).remove().then(function () { cb && cb(true); }, function () { cb && cb(false); });
  }

  /* --- Eventos --- */

  function watchEventsForOrg(orgId, cb) {
    var root = dbRoot();
    if (!root) return function () {};
    var ref = root.child(EVENTS_PATH).orderByChild('organizationId').equalTo(orgId);
    var handler = function (snap) { cb(snapshotToArray(snap)); };
    ref.on('value', handler);
    return function () { ref.off('value', handler); };
  }

  /* cb(ok) avisa si la escritura fue rechazada (por ejemplo, por las reglas
     de Firebase si la sesión no tiene permiso de admin sobre esa
     organización), para que quien llama no asuma que ya quedó guardado. */
  function saveEvent(evento, orgId, cb) {
    var root = dbRoot();
    if (!root) { cb && cb(false); return; }
    var ev = clone(evento);
    ev.organizationId = orgId || ev.organizationId;
    root.child(EVENTS_PATH).child(ev.id).set(ev).then(function () { cb && cb(true); }, function (err) {
      console.error('Firebase saveEvent rechazado:', err && err.code, err && err.message, err);
      cb && cb(false);
    });
  }

  /* Cambia solo el estado de un evento ya existente, sin pasar por el
     asistente completo (usado por las acciones rápidas "Cancelado" y
     "Archivar" del listado del día). */
  function setEventEstado(id, estado, cb) {
    var root = dbRoot();
    if (!root) { cb && cb(false); return; }
    root.child(EVENTS_PATH).child(id).update({ estado: estado }).then(function () { cb && cb(true); }, function (err) {
      console.error('Firebase setEventEstado rechazado:', err && err.code, err && err.message, err);
      cb && cb(false);
    });
  }

  /* --- Catálogo de canciones (overrides de renombre/archivado) --- */

  /* cb(map) con el contenido crudo de /songCatalog/{orgId} ({} si aún no
     tiene ninguna entrada) — pensado para combinarse con buildSongCatalog. */
  function watchSongCatalog(orgId, cb) {
    var root = dbRoot();
    if (!root || !orgId) return function () {};
    var ref = root.child(SONG_CATALOG_PATH).child(orgId);
    var handler = function (snap) { cb(snap.val() || {}); };
    ref.on('value', handler);
    return function () { ref.off('value', handler); };
  }

  /* patch: { titulo, artista, url, archivado }, cualquier subconjunto. No
     toca los eventos históricos que ya usan esta canción — solo afecta el
     catálogo que alimenta el autocompletado y el CRUD de Repertorio del
     panel. */
  function saveSongOverride(orgId, key, patch, cb) {
    var root = dbRoot();
    if (!root || !orgId || !key) { cb && cb(false); return; }
    var safe = { updatedAt: Date.now() };
    if (patch.titulo !== undefined) safe.titulo = patch.titulo;
    if (patch.artista !== undefined) safe.artista = patch.artista;
    if (patch.url !== undefined) safe.url = patch.url;
    if (patch.archivado !== undefined) safe.archivado = !!patch.archivado;
    root.child(SONG_CATALOG_PATH).child(orgId).child(key).update(safe).then(function () { cb && cb(true); }, function (err) {
      console.error('Firebase saveSongOverride rechazado:', err && err.code, err && err.message, err);
      cb && cb(false);
    });
  }

  /* "Eliminar" una canción del repertorio es en realidad archivarla: deja de
     sugerirse en el autocompletado y de listarse en el panel, sin borrar
     nada de los eventos que ya la usan (para no romper su historial). */
  function archiveSong(orgId, key, cb) {
    saveSongOverride(orgId, key, { archivado: true }, cb);
  }

  /* Cambia la fecha de un evento ya existente (usado por el modal "Mover"). */
  function moveEvent(id, nuevaFecha, cb) {
    var root = dbRoot();
    if (!root) { cb && cb(false); return; }
    root.child(EVENTS_PATH).child(id).update({ fecha: nuevaFecha }).then(function () { cb && cb(true); }, function (err) {
      console.error('Firebase moveEvent rechazado:', err && err.code, err && err.message, err);
      cb && cb(false);
    });
  }

  /* --- Músicos (identidad detrás de los puestos de `banda`) ---
     Un músico es una persona identificada dentro de una organización,
     independiente de si ya tiene cuenta (userId null hasta que un admin la
     vincula). rolesBanda es una lista de tags persistentes (ej. ['Corista',
     'Piano']) que identifican a la persona, separada de en qué puesto haya
     quedado asignado en un evento puntual. */

  var ESTADOS_CONFIRMACION = ['pendiente', 'aceptado', 'rechazado'];

  /* Los slots guardados antes de que existiera este campo no tienen
     estadoConfirmacion: se tratan como 'pendiente'. */
  function estadoConfirmacionSlot(slot) { return (slot && slot.estadoConfirmacion) || 'pendiente'; }

  function newMusician(o) {
    o = o || {};
    var nombre = o.nombre || '';
    return {
      id: o.id || uid(),
      organizationId: o.organizationId || '',
      nombre: nombre,
      nombreNormalizado: slugify(nombre),
      aliases: o.aliases || (nombre ? [nombre] : []),
      rolesBanda: o.rolesBanda || [],
      userId: o.userId || null,
      createdAt: o.createdAt || Date.now(),
      updatedAt: o.updatedAt || Date.now()
    };
  }

  function watchMusiciansForOrg(orgId, cb) {
    var root = dbRoot();
    if (!root) return function () {};
    var ref = root.child(MUSICIANS_PATH).orderByChild('organizationId').equalTo(orgId);
    var handler = function (snap) { cb(snapshotToArray(snap)); };
    ref.on('value', handler);
    return function () { ref.off('value', handler); };
  }

  function getMusician(id, cb) {
    var root = dbRoot();
    if (!root || !id) { cb(null); return; }
    root.child(MUSICIANS_PATH).child(id).once('value').then(function (snap) {
      var v = snap.val();
      if (v) v.id = id;
      cb(v);
    }, function () { cb(null); });
  }

  function createMusician(orgId, nombre, rolesBanda, cb) {
    var root = dbRoot();
    if (!root) { cb && cb(null); return; }
    var m = newMusician({ organizationId: orgId, nombre: nombre, rolesBanda: rolesBanda || [] });
    root.child(MUSICIANS_PATH).child(m.id).set(m).then(function () { cb && cb(m); }, function () { cb && cb(null); });
  }

  /* patch puede incluir nombre, rolesBanda (arreglo), aliases, userId —
     cualquier subconjunto. Si cambia el nombre, se recalcula
     nombreNormalizado para que siga participando en matchMusicianByNombre. */
  function updateMusician(id, patch, cb) {
    var root = dbRoot();
    if (!root || !id) { cb && cb(false); return; }
    var safe = { updatedAt: Date.now() };
    if (patch.nombre !== undefined) { safe.nombre = patch.nombre; safe.nombreNormalizado = slugify(patch.nombre); }
    if (patch.rolesBanda !== undefined) safe.rolesBanda = patch.rolesBanda;
    if (patch.aliases !== undefined) safe.aliases = patch.aliases;
    if (patch.userId !== undefined) safe.userId = patch.userId;
    root.child(MUSICIANS_PATH).child(id).update(safe).then(function () { cb && cb(true); }, function () { cb && cb(false); });
  }

  /* Vincula un músico ya existente a una cuenta ya autenticada (uid): guarda
     el vínculo en ambos sentidos —musicians/{id}.userId y
     users/{uid}.musicianLinks/{orgId}— en una sola escritura multi-ruta,
     para que nunca queden desincronizados entre sí. */
  function linkMusicianToUser(musicianId, targetUid, orgId, cb) {
    var root = dbRoot();
    if (!root || !musicianId || !targetUid || !orgId) { cb && cb(false); return; }
    var updates = {};
    updates[MUSICIANS_PATH + '/' + musicianId + '/userId'] = targetUid;
    updates[MUSICIANS_PATH + '/' + musicianId + '/updatedAt'] = Date.now();
    updates[USERS_PATH + '/' + targetUid + '/musicianLinks/' + orgId] = musicianId;
    root.update(updates).then(function () { cb && cb(true); }, function () { cb && cb(false); });
  }

  /* Borra el perfil de músico (no la cuenta vinculada, si tenía una — esa
     queda intacta, solo pierde el vínculo). No repunta los `musicianId` que
     hayan quedado apuntando a este perfil en eventos históricos; queda como
     una referencia huérfana inofensiva, igual que un usuario borrado deja de
     figurar en /users sin que sus eventos pasados se toquen. */
  function deleteMusician(musicianId, cb) {
    var root = dbRoot();
    if (!root || !musicianId) { cb && cb(false); return; }
    root.child(MUSICIANS_PATH).child(musicianId).remove().then(function () { cb && cb(true); }, function () { cb && cb(false); });
  }

  function unlinkMusician(musicianId, orgId, targetUid, cb) {
    var root = dbRoot();
    if (!root || !musicianId || !orgId) { cb && cb(false); return; }
    var updates = {};
    updates[MUSICIANS_PATH + '/' + musicianId + '/userId'] = null;
    if (targetUid) updates[USERS_PATH + '/' + targetUid + '/musicianLinks/' + orgId] = null;
    root.update(updates).then(function () { cb && cb(true); }, function () { cb && cb(false); });
  }

  /* Funde mergeIds dentro de keepId: une aliases y rolesBanda, repunta
     musicianId en cualquier slot de banda de la misma organización que
     apuntara a alguno de los mergeIds, y borra los perfiles fundidos — todo
     en una sola escritura multi-ruta. */
  function mergeMusicians(keepId, mergeIds, cb) {
    var root = dbRoot();
    if (!root || !keepId || !mergeIds || !mergeIds.length) { cb && cb(false); return; }
    root.child(MUSICIANS_PATH).child(keepId).once('value').then(function (keepSnap) {
      var keep = keepSnap.val();
      if (!keep) { cb && cb(false); return; }
      Promise.all(mergeIds.map(function (id) { return root.child(MUSICIANS_PATH).child(id).once('value'); })).then(function (snaps) {
        var aliases = (keep.aliases || []).slice();
        var roles = (keep.rolesBanda || []).slice();
        snaps.forEach(function (s) {
          var v = s.val();
          if (!v) return;
          (v.aliases || []).forEach(function (a) { if (aliases.indexOf(a) < 0) aliases.push(a); });
          (v.rolesBanda || []).forEach(function (r) { if (roles.indexOf(r) < 0) roles.push(r); });
        });
        root.child(EVENTS_PATH).orderByChild('organizationId').equalTo(keep.organizationId).once('value').then(function (eventsSnap) {
          var updates = {};
          eventsSnap.forEach(function (evChild) {
            var ev = evChild.val();
            (ev.banda || []).forEach(function (slot, idx) {
              if (slot && mergeIds.indexOf(slot.musicianId) >= 0) {
                updates[EVENTS_PATH + '/' + evChild.key + '/banda/' + idx + '/musicianId'] = keepId;
              }
            });
          });
          updates[MUSICIANS_PATH + '/' + keepId + '/aliases'] = aliases;
          updates[MUSICIANS_PATH + '/' + keepId + '/rolesBanda'] = roles;
          updates[MUSICIANS_PATH + '/' + keepId + '/updatedAt'] = Date.now();
          mergeIds.forEach(function (id) { updates[MUSICIANS_PATH + '/' + id] = null; });
          root.update(updates).then(function () { cb && cb(true); }, function () { cb && cb(false); });
        }, function () { cb && cb(false); });
      }, function () { cb && cb(false); });
    }, function () { cb && cb(false); });
  }

  /* Encuentra, dentro de una lista de músicos ya cargada, cuál corresponde a
     un nombre libre (el texto tal cual se tipeó en un slot de banda),
     comparando por la misma normalización que usa la migración. No crea
     nada — solo empareja; si no hay match devuelve null. */
  function matchMusicianByNombre(lista, nombreLibre) {
    var key = slugify(nombreLibre);
    if (!key) return null;
    var found = null;
    (lista || []).some(function (m) {
      if (m.nombreNormalizado === key) { found = m; return true; }
      if ((m.aliases || []).some(function (a) { return slugify(a) === key; })) { found = m; return true; }
      return false;
    });
    return found;
  }

  /* --- Migración de nombres de banda a perfiles de músico ---
     previewMusicianMigration es de solo lectura: agrupa los `banda[].nombre`
     de todos los eventos de todas las organizaciones por su forma
     normalizada, para que el panel de administración los revise/ajuste
     (fusionar o separar grupos) antes de escribir nada. Cada grupo trae los
     slots exactos (eventId + slotId) que habría que parchear si se
     confirma. */
  function previewMusicianMigration(cb) {
    var root = dbRoot();
    if (!root) { cb && cb([]); return; }
    root.child(EVENTS_PATH).once('value').then(function (snap) {
      var eventos = snapshotToArray(snap);
      var grupos = {};
      eventos.forEach(function (ev) {
        (ev.banda || []).forEach(function (slot) {
          var nombre = (slot.nombre || '').trim();
          if (!nombre) return;
          var normKey = slugify(nombre);
          if (!normKey) return;
          var llave = (ev.organizationId || '') + '|' + normKey;
          if (!grupos[llave]) {
            grupos[llave] = { normKey: normKey, organizationId: ev.organizationId || '', nombreCanonico: nombre, aliases: [], rolesBanda: [], slots: [] };
          }
          var g = grupos[llave];
          if (g.aliases.indexOf(nombre) < 0) g.aliases.push(nombre);
          g.slots.push({ eventId: ev.id, slotId: slot.id, tipo: slot.tipo });
        });
      });
      var out = Object.keys(grupos).map(function (k) { return grupos[k]; });
      out.forEach(function (g) { g.count = g.slots.length; });
      out.sort(function (a, b) { return a.nombreCanonico.localeCompare(b.nombreCanonico, 'es'); });
      cb && cb(out);
    }, function () { cb && cb([]); });
  }

  /* Escribe los grupos ya revisados/ajustados por un admin (posiblemente
     fusionados/separados respecto a la vista previa): crea un
     `musicians/{id}` por grupo y parchea `musicianId` en cada slot referido,
     todo en un único root.update() multi-ruta (todo o nada). Vuelve a leer
     el `banda` de cada evento involucrado justo antes de escribir, para
     ubicar el slot por su `id` en vez de confiar en el índice capturado en
     la vista previa (el índice puede haber cambiado si alguien editó el
     evento mientras tanto). Se niega a correr si la migración ya se marcó
     como hecha. cb(ok, error|null, slotsOmitidos) */
  function commitMusicianMigration(grupos, cb) {
    var root = dbRoot();
    if (!root) { cb && cb(false); return; }
    root.child(META_PATH).child('migrations').child('musiciansV1').once('value').then(function (flagSnap) {
      if (flagSnap.val() === true) { cb && cb(false, new Error('La migración ya se ejecutó antes.')); return; }
      var eventIds = [];
      (grupos || []).forEach(function (g) { (g.slots || []).forEach(function (s) { if (eventIds.indexOf(s.eventId) < 0) eventIds.push(s.eventId); }); });
      Promise.all(eventIds.map(function (id) {
        return root.child(EVENTS_PATH).child(id).child('banda').once('value').then(function (snap) { return { id: id, banda: snap.val() || [] }; });
      })).then(function (bandas) {
        var bandaPorEvento = {};
        bandas.forEach(function (b) { bandaPorEvento[b.id] = b.banda; });
        var updates = {};
        var omitidos = 0;
        (grupos || []).forEach(function (g) {
          if (!g.slots || !g.slots.length) return;
          var m = newMusician({ organizationId: g.organizationId, nombre: g.nombreCanonico, aliases: g.aliases, rolesBanda: g.rolesBanda || [] });
          updates[MUSICIANS_PATH + '/' + m.id] = m;
          g.slots.forEach(function (s) {
            var banda = bandaPorEvento[s.eventId] || [];
            var idx = -1;
            for (var i = 0; i < banda.length; i++) { if (banda[i] && banda[i].id === s.slotId) { idx = i; break; } }
            if (idx < 0) { omitidos++; return; }
            updates[EVENTS_PATH + '/' + s.eventId + '/banda/' + idx + '/musicianId'] = m.id;
          });
        });
        updates[META_PATH + '/migrations/musiciansV1'] = true;
        root.update(updates).then(function () { cb && cb(true, null, omitidos); }, function (err) { cb && cb(false, err); });
      }, function (err) { cb && cb(false, err); });
    }, function (err) { cb && cb(false, err); });
  }

  function migracionMusicosYaCorrio(cb) {
    var root = dbRoot();
    if (!root) { cb(false); return; }
    root.child(META_PATH).child('migrations').child('musiciansV1').once('value').then(function (snap) {
      cb(snap.val() === true);
    }, function () { cb(false); });
  }

  /* Corrige, en un solo lote, el texto de `nombre` (y `musicianId`) de los
     puestos de banda indicados — usada por el panel de administración para
     sincronizar de una vez los nombres ya guardados en eventos pasados y
     futuros con el nombre canónico vigente en el catálogo de Personas
     (la migración original solo vinculó `musicianId`, nunca reescribió el
     texto ya guardado en cada evento). `fixes` es un arreglo de
     { eventId, slotId, nombreNuevo, musicianId }. Igual que
     commitMusicianMigration, vuelve a leer el `banda` de cada evento
     involucrado justo antes de escribir y ubica cada puesto por su `id`
     propio (no por índice) para no pisar un cambio concurrente; los puestos
     que ya no existan en ese momento se omiten en vez de fallar todo el
     lote. cb(ok, omitidos) */
  function updateEventBandaSlots(fixes, cb) {
    var root = dbRoot();
    if (!root) { cb && cb(false, 0); return; }
    if (!fixes || !fixes.length) { cb && cb(true, 0); return; }
    var eventIds = [];
    fixes.forEach(function (f) { if (eventIds.indexOf(f.eventId) < 0) eventIds.push(f.eventId); });
    Promise.all(eventIds.map(function (id) {
      return root.child(EVENTS_PATH).child(id).child('banda').once('value').then(function (snap) { return { id: id, banda: snap.val() || [] }; });
    })).then(function (bandas) {
      var bandaPorEvento = {};
      bandas.forEach(function (b) { bandaPorEvento[b.id] = b.banda; });
      var updates = {};
      var omitidos = 0;
      fixes.forEach(function (f) {
        var banda = bandaPorEvento[f.eventId] || [];
        var idx = -1;
        for (var i = 0; i < banda.length; i++) { if (banda[i] && banda[i].id === f.slotId) { idx = i; break; } }
        if (idx < 0) { omitidos++; return; }
        updates[EVENTS_PATH + '/' + f.eventId + '/banda/' + idx + '/nombre'] = f.nombreNuevo;
        updates[EVENTS_PATH + '/' + f.eventId + '/banda/' + idx + '/musicianId'] = f.musicianId;
      });
      root.update(updates).then(function () { cb && cb(true, omitidos); }, function (err) {
        console.error('Firebase updateEventBandaSlots rechazado:', err && err.code, err && err.message, err);
        cb && cb(false, 0);
      });
    }, function (err) {
      console.error('Firebase updateEventBandaSlots lectura rechazada:', err);
      cb && cb(false, 0);
    });
  }

  /* --- Confirmación de asistencia (Aceptar/Declinar) --- */

  /* No escribe por índice fijo de arreglo: banda puede reordenarse (el
     Formulario hace splice() al eliminar puestos), así que se vuelve a leer
     el banda actual y se ubica el slot por su `id` propio justo antes de
     escribir, para no repuntar accidentalmente el estado de otro puesto. */
  function setBandaConfirmacion(eventId, slotId, estado, cb) {
    var root = dbRoot();
    if (!root || !eventId || !slotId) { cb && cb(false); return; }
    root.child(EVENTS_PATH).child(eventId).child('banda').once('value').then(function (snap) {
      var banda = snap.val() || [];
      var idx = -1;
      for (var i = 0; i < banda.length; i++) { if (banda[i] && banda[i].id === slotId) { idx = i; break; } }
      if (idx < 0) { cb && cb(false); return; }
      var patch = {};
      patch['banda/' + idx + '/estadoConfirmacion'] = estado;
      root.child(EVENTS_PATH).child(eventId).update(patch).then(function () { cb && cb(true); }, function (err) {
        console.error('Firebase setBandaConfirmacion rechazado:', err && err.code, err && err.message, err);
        cb && cb(false);
      });
    }, function () { cb && cb(false); });
  }

  /* --- Fechas no disponibles --- */

  function watchUnavailableDates(musicianId, cb) {
    var root = dbRoot();
    if (!root || !musicianId) return function () {};
    var ref = root.child(MUSICIANS_PATH).child(musicianId).child('unavailableDates');
    var handler = function (snap) { cb(snapshotToArray(snap)); };
    ref.on('value', handler);
    return function () { ref.off('value', handler); };
  }

  function addUnavailableDate(musicianId, range, cb) {
    var root = dbRoot();
    if (!root || !musicianId) { cb && cb(null); return; }
    var id = uid();
    var doc = { id: id, startDate: (range && range.startDate) || '', endDate: (range && (range.endDate || range.startDate)) || '', reason: (range && range.reason) || '', createdAt: Date.now() };
    root.child(MUSICIANS_PATH).child(musicianId).child('unavailableDates').child(id).set(doc).then(function () { cb && cb(doc); }, function () { cb && cb(null); });
  }

  function deleteUnavailableDate(musicianId, rangeId, cb) {
    var root = dbRoot();
    if (!root || !musicianId || !rangeId) { cb && cb(false); return; }
    root.child(MUSICIANS_PATH).child(musicianId).child('unavailableDates').child(rangeId).remove().then(function () { cb && cb(true); }, function () { cb && cb(false); });
  }

  /* true si `fechaIso` (YYYY-MM-DD) cae dentro de algún rango marcado como
     no disponible — comparación de texto porque el formato ISO ya ordena
     igual que el string. Usada por el Formulario para advertir (no bloquea
     el guardado). */
  function fechaNoDisponible(unavailableDates, fechaIso) {
    if (!fechaIso) return false;
    return (unavailableDates || []).some(function (r) {
      return fechaIso >= (r.startDate || '') && fechaIso <= (r.endDate || r.startDate || '');
    });
  }

  w.RepertorioData = {
    MESES: MESES, DIAS: DIAS, SERVICIOS: SERVICIOS,
    SERVICIOS_CON_REPERTORIO: SERVICIOS_CON_REPERTORIO, usaRepertorio: usaRepertorio,
    song: song, songLabel: songLabel, songKey: songKey, buildSongCatalog: buildSongCatalog,
    youtubeId: youtubeId, youtubeController: youtubeController, defaultBlocks: defaultBlocks, newEvento: newEvento, uid: uid,
    BANDA_ROLES: BANDA_ROLES, defaultBanda: defaultBanda, bandaSlot: bandaSlot,
    bandaLabel: bandaLabel, bandaSiguienteNumero: bandaSiguienteNumero,
    parse: parse, iso: iso, monthKey: monthKey, monthLabel: monthLabel,
    diaNombre: diaNombre, fechaLarga: fechaLarga, semanaDelMes: semanaDelMes,
    hoyKey: hoyKey, calendario: calendario, clone: clone,
    signInWithGoogle: signInWithGoogle, signOutUser: signOutUser, onAuthChange: onAuthChange,
    eventoTitulo: eventoTitulo, eventoDescripcion: eventoDescripcion,
    icsDataHref: icsDataHref, icsFilename: icsFilename, googleCalendarUrl: googleCalendarUrl,
    horaMinutos: horaMinutos,
    slugify: slugify,
    ESTADOS_EVENTO: ESTADOS_EVENTO, estadoEvento: estadoEvento, esVisiblePublico: esVisiblePublico, estadoInfo: estadoInfo,
    watchAllOrganizations: watchAllOrganizations, getOrganizationBySlug: getOrganizationBySlug, getOrganization: getOrganization,
    createOrganization: createOrganization, updateOrganization: updateOrganization, deleteOrganization: deleteOrganization,
    countEventsForOrg: countEventsForOrg, countUsersForOrg: countUsersForOrg,
    ensureUserRegistered: ensureUserRegistered, watchUser: watchUser, watchAllUsers: watchAllUsers,
    setUserRole: setUserRole, setUserOrgs: setUserOrgs, deleteUser: deleteUser, userOrgIds: userOrgIds,
    userMusicianLinks: userMusicianLinks, redirectToUserLanding: redirectToUserLanding,
    createInvitation: createInvitation, watchInvitations: watchInvitations, deleteInvitation: deleteInvitation,
    watchEventsForOrg: watchEventsForOrg, saveEvent: saveEvent, setEventEstado: setEventEstado, moveEvent: moveEvent,
    watchSongCatalog: watchSongCatalog, saveSongOverride: saveSongOverride, archiveSong: archiveSong,
    ESTADOS_CONFIRMACION: ESTADOS_CONFIRMACION, estadoConfirmacionSlot: estadoConfirmacionSlot,
    newMusician: newMusician, watchMusiciansForOrg: watchMusiciansForOrg, getMusician: getMusician,
    createMusician: createMusician, updateMusician: updateMusician,
    linkMusicianToUser: linkMusicianToUser, unlinkMusician: unlinkMusician, mergeMusicians: mergeMusicians,
    deleteMusician: deleteMusician,
    matchMusicianByNombre: matchMusicianByNombre,
    previewMusicianMigration: previewMusicianMigration, commitMusicianMigration: commitMusicianMigration,
    migracionMusicosYaCorrio: migracionMusicosYaCorrio,
    updateEventBandaSlots: updateEventBandaSlots,
    setBandaConfirmacion: setBandaConfirmacion,
    watchUnavailableDates: watchUnavailableDates, addUnavailableDate: addUnavailableDate, deleteUnavailableDate: deleteUnavailableDate,
    fechaNoDisponible: fechaNoDisponible
  };
})(window);
