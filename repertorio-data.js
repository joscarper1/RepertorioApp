/* Modelo de datos del repertorio. Los eventos se guardan planos, con la fecha
   en formato ISO (YYYY-MM-DD); el mes y la semana se derivan de ahí. */
(function (w) {
  var KEY = 'repertorio-data-v2';
  var DB_PATH = 'repertorio';
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
      personas: o.personas || ''
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

  function seed() {
    return {
      kicker: 'Calendario mensual',
      nota: '"El Espíritu del Señor está sobre mí, por cuanto me ha ungido para dar buenas nuevas a los pobres; me ha enviado a sanar a los quebrantados de corazón; a pregonar libertad a los cautivos, y vista a los ciegos" - Lucas 4:18',
      eventos: [
        newEvento({ fecha: '2026-08-02', hora: '9:00 am', servicio: 'Servicio matutino',
          tema: 'La fidelidad de Dios en cada generación',
          cita: '«Grande es tu fidelidad; nuevas son cada mañana sus misericordias». Lamentaciones 3:23',
          notas: 'Lectura bíblica: Salmo 100 — lee Fernando. Ensayo el martes 7:00 pm.',
          bloques: [
            { titulo: 'Alabanza de inicio', canciones: [song('Grande es tu fidelidad', 'Yessy', 'G', 'https://youtu.be')] },
            { titulo: 'Júbilo', canciones: [song('Alabaré', 'Marcos', 'D', 'https://youtu.be'), song()] },
            { titulo: 'Adoración', canciones: [song('Renuévame', 'Yessy', 'E', 'https://youtu.be'), song()] },
            { titulo: 'Himno', canciones: [song()] },
            { titulo: 'Ofrenda', canciones: [song()] }
          ] }),
        newEvento({ fecha: '2026-08-05', hora: '7:00 pm', servicio: 'Servicio de oración',
          tema: 'Un corazón que busca su presencia',
          cita: '«Cerca está el Señor de los que le invocan». Salmo 145:18',
          notas: 'Repasar la transición entre las dos canciones.',
          bloques: [
            { titulo: 'Alabanza de inicio', canciones: [song('Dulce refugio', 'Yessy', 'F', 'https://youtu.be')] },
            { titulo: 'Júbilo', canciones: [song(), song()] },
            { titulo: 'Adoración', canciones: [song('Al que está sentado en el trono', 'Karla', 'A', 'https://youtu.be'), song()] },
            { titulo: 'Himno', canciones: [song()] },
            { titulo: 'Ofrenda', canciones: [song()] }
          ] }),
        newEvento({ fecha: '2026-08-09', hora: '9:00 am', servicio: 'Servicio matutino',
          tema: 'Jesucristo, nuestra esperanza de vida eterna',
          cita: '«Señor, ¿a quién iremos? Solo Tú tienes palabras de vida eterna». Juan 6:68',
          notas: 'Lectura bíblica: Juan 6:60-69 — lee Daniel.',
          bloques: [
            { titulo: 'Alabanza de inicio', canciones: [song('Dulce refugio', 'Yessy', 'F', 'https://youtu.be')] },
            { titulo: 'Júbilo', canciones: [song('Vamos a cantar', 'Yessy', 'C', 'https://youtu.be'), song()] },
            { titulo: 'Adoración', canciones: [song('Cristo, mi esperanza es', 'Karla', 'D', 'https://youtu.be'), song()] },
            { titulo: 'Himno', canciones: [song()] },
            { titulo: 'Ofrenda', canciones: [song()] }
          ] }),
        newEvento({ fecha: '2026-08-09', hora: '6:00 pm', servicio: 'Servicio vespertino',
          tema: 'Noche de gratitud', cita: '«Entrad por sus puertas con acción de gracias». Salmo 100:4',
          notas: 'Ensayo el sábado 4:00 pm.',
          bloques: [
            { titulo: 'Alabanza de inicio', canciones: [song()] },
            { titulo: 'Júbilo', canciones: [song('Cantaré de tu amor', 'Marcos', 'G', 'https://youtu.be'), song()] },
            { titulo: 'Adoración', canciones: [song('Tu fidelidad', 'Yessy', 'Bb', 'https://youtu.be'), song()] },
            { titulo: 'Himno', canciones: [song()] },
            { titulo: 'Ofrenda', canciones: [song()] }
          ] })
      ]
    };
  }

  function clone(x) { return JSON.parse(JSON.stringify(x)); }
  function encode(data) { return btoa(unescape(encodeURIComponent(JSON.stringify(data)))); }
  function decode(str) { try { return JSON.parse(decodeURIComponent(escape(atob(str)))); } catch (e) { return null; } }

  function fromHash() {
    var h = String(location.hash || '');
    var i = h.indexOf('data=');
    return i >= 0 ? decode(h.slice(i + 5)) : null;
  }

  function load() {
    var byUrl = fromHash();
    if (byUrl && byUrl.eventos) return byUrl;
    try {
      var raw = localStorage.getItem(KEY);
      if (raw) { var d = JSON.parse(raw); if (d && d.eventos) return d; }
    } catch (e) {}
    return seed();
  }
  /* cb(ok) es opcional: avisa si la escritura en la nube fue rechazada (por
     ejemplo, por las reglas de Firebase si la sesión no tiene permiso), para
     que quien llama no asuma que todos ya ven el cambio cuando en realidad
     sólo quedó en el caché local de este navegador. */
  function save(data, cb) {
    try { localStorage.setItem(KEY, JSON.stringify(data)); } catch (e) {}
    saveCloud(data, cb);
    return true;
  }
  function reset() { try { localStorage.removeItem(KEY); } catch (e) {} }

  /* La base de datos en la nube es la fuente de verdad compartida entre
     usuarios; localStorage sólo sirve como caché para el primer pintado. */
  function dbRef() {
    if (!w.firebase) return null;
    try {
      if (!w.firebase.apps || !w.firebase.apps.length) w.firebase.initializeApp(FIREBASE_CONFIG);
      return w.firebase.database().ref(DB_PATH);
    } catch (e) { return null; }
  }

  /* Autenticación con Google, usada sólo por el formulario de edición: la
     lectura del repertorio publicado se queda pública (ver index.html), pero
     escribir requiere una sesión que las reglas de la base de datos puedan
     verificar del lado del servidor (ver README de reglas de Firebase). */
  function ensureAuthApp() {
    if (!w.firebase || !w.firebase.auth) return null;
    if (!w.firebase.apps || !w.firebase.apps.length) w.firebase.initializeApp(FIREBASE_CONFIG);
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

  function saveCloud(data, cb) {
    var ref = dbRef();
    if (!ref) { cb && cb(false); return; }
    ref.set(data).then(function () { cb && cb(true); }, function (err) {
      console.error('Firebase saveCloud rechazado:', err && err.code, err && err.message, err);
      cb && cb(false);
    });
  }

  function loadCloudOnce() {
    var ref = dbRef();
    if (!ref) return Promise.resolve(null);
    return ref.once('value').then(function (snap) {
      var d = snap.val();
      return (d && d.eventos) ? d : null;
    }, function () { return null; });
  }

  /* onData se llama cada vez que cambian los datos en la nube (incluyendo la
     primera vez). Devuelve una función para cancelar la suscripción. */
  function watchCloud(onData) {
    var ref = dbRef();
    if (!ref) return function () {};
    var handler = function (snap) {
      var d = snap.val();
      if (d && d.eventos) onData(d);
    };
    ref.on('value', handler);
    return function () { ref.off('value', handler); };
  }

  w.RepertorioData = {
    KEY: KEY, MESES: MESES, DIAS: DIAS, SERVICIOS: SERVICIOS,
    SERVICIOS_CON_REPERTORIO: SERVICIOS_CON_REPERTORIO, usaRepertorio: usaRepertorio,
    song: song, songLabel: songLabel, youtubeId: youtubeId, youtubeController: youtubeController, defaultBlocks: defaultBlocks, newEvento: newEvento, uid: uid,
    BANDA_ROLES: BANDA_ROLES, defaultBanda: defaultBanda, bandaSlot: bandaSlot,
    bandaLabel: bandaLabel, bandaSiguienteNumero: bandaSiguienteNumero,
    parse: parse, iso: iso, monthKey: monthKey, monthLabel: monthLabel,
    diaNombre: diaNombre, fechaLarga: fechaLarga, semanaDelMes: semanaDelMes,
    hoyKey: hoyKey, calendario: calendario,
    seed: seed, clone: clone, encode: encode, decode: decode,
    load: load, save: save, reset: reset,
    loadCloudOnce: loadCloudOnce, watchCloud: watchCloud,
    signInWithGoogle: signInWithGoogle, signOutUser: signOutUser, onAuthChange: onAuthChange,
    eventoTitulo: eventoTitulo, eventoDescripcion: eventoDescripcion,
    icsDataHref: icsDataHref, icsFilename: icsFilename, googleCalendarUrl: googleCalendarUrl,
    horaMinutos: horaMinutos
  };
})(window);
