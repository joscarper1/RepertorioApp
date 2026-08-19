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

  /* Etiqueta con la que se muestra una canción donde sea que aparezca su
     nombre: si tiene salmista (artista/versión de origen), se concatena
     entre paréntesis para distinguir covers del mismo título. */
  function songLabel(c) {
    var t = ((c && c.t) || '').trim();
    var sm = ((c && c.sm) || '').trim();
    return sm ? (t + ' (' + sm + ')') : t;
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
    var player = null, ready = false, pending = null, current = null, paused = false;

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
            if (e.data === w.YT.PlayerState.ENDED) { current = null; paused = false; if (onChange) onChange(null, false); }
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

    /* Misma canción ya cargada: alterna pausa/reanudar sin perder la
       posición. Canción distinta: carga y reproduce desde el inicio. */
    function toggle(key, videoId) {
      if (!videoId) return;
      if (!ready) { pending = { key: key, videoId: videoId }; return; }
      if (current === key) {
        if (paused) { player.playVideo(); paused = false; } else { player.pauseVideo(); paused = true; }
        if (onChange) onChange(key, paused);
      } else {
        player.loadVideoById(videoId);
        player.playVideo();
        current = key;
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
      organizationId: o.organizationId || ''
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
     no romper enlaces ?group=slug ya compartidos). */
  function updateOrganization(orgId, patch, cb) {
    var root = dbRoot();
    if (!root) { cb && cb(false); return; }
    var safe = { name: patch.name, kicker: patch.kicker, nota: patch.nota };
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
        if (inviteSnap.exists()) {
          var invite = inviteSnap.val();
          doc.role = invite.role === 'admin' ? 'admin' : 'normal';
          if (invite.organizationIds) doc.organizationIds = invite.organizationIds;
        }
        ref.set(doc).then(function () {
          if (inviteSnap.exists()) root.child(INVITES_PATH).child(key).remove();
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

  /* Usada por admin.html y el Formulario cuando a un usuario no le toca
     estar ahí (rol 'normal', o sin organización asignada todavía): lo manda
     al calendario público de su primera organización, o a index.html a
     secas si aún no tiene ninguna (ahí verá el mensaje de "esperando
     asignación"). */
  function redirectToUserLanding(userDoc) {
    var ids = userOrgIds(userDoc);
    if (!ids.length) { w.location.href = 'index.html'; return; }
    getOrganization(ids[0], function (org) {
      w.location.href = org ? ('index.html?group=' + org.slug) : 'index.html';
    });
  }

  /* --- Invitaciones (alta de usuarios antes de su primer login) --- */

  /* orgIds: arreglo de organizationId, igual que setUserOrgs. Sobrescribe
     cualquier invitación previa para ese mismo correo. */
  function createInvitation(email, role, orgIds, cb) {
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

  function deleteEvent(id, cb) {
    var root = dbRoot();
    if (!root) { cb && cb(false); return; }
    root.child(EVENTS_PATH).child(id).remove().then(function () { cb && cb(true); }, function (err) {
      console.error('Firebase deleteEvent rechazado:', err && err.code, err && err.message, err);
      cb && cb(false);
    });
  }

  w.RepertorioData = {
    MESES: MESES, DIAS: DIAS, SERVICIOS: SERVICIOS,
    SERVICIOS_CON_REPERTORIO: SERVICIOS_CON_REPERTORIO, usaRepertorio: usaRepertorio,
    song: song, songLabel: songLabel, youtubeId: youtubeId, youtubeController: youtubeController, defaultBlocks: defaultBlocks, newEvento: newEvento, uid: uid,
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
    watchAllOrganizations: watchAllOrganizations, getOrganizationBySlug: getOrganizationBySlug, getOrganization: getOrganization,
    createOrganization: createOrganization, updateOrganization: updateOrganization, deleteOrganization: deleteOrganization,
    countEventsForOrg: countEventsForOrg, countUsersForOrg: countUsersForOrg,
    ensureUserRegistered: ensureUserRegistered, watchUser: watchUser, watchAllUsers: watchAllUsers,
    setUserRole: setUserRole, setUserOrgs: setUserOrgs, deleteUser: deleteUser, userOrgIds: userOrgIds, redirectToUserLanding: redirectToUserLanding,
    createInvitation: createInvitation, watchInvitations: watchInvitations, deleteInvitation: deleteInvitation,
    watchEventsForOrg: watchEventsForOrg, saveEvent: saveEvent, deleteEvent: deleteEvent
  };
})(window);
