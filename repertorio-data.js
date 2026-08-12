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
  var SERVICIOS = ['Cultos Dominicales','Culto Familiar','Vigilia General','Vigilia Juvenil','Evento Especial', 'Capacitación', 'Convocatoria', 'Otro'];
  /* Estos tipos de evento llevan repertorio musical (paso 3 con bloques de
     canciones); el resto sólo pide detalles/responsable y personas requeridas. */
  var SERVICIOS_CON_REPERTORIO = ['Cultos Dominicales','Culto Familiar','Vigilia General','Vigilia Juvenil','Evento Especial'];

  function usaRepertorio(servicio) { return SERVICIOS_CON_REPERTORIO.indexOf(servicio) >= 0; }

  function song(t, d, k, u) { return { t: t || '', d: d || '', k: k || '', u: u || '' }; }

  function defaultBlocks() {
    return [
      { titulo: 'Alabanza de inicio', canciones: [song()] },
      { titulo: 'Júbilo', canciones: [song(), song()] },
      { titulo: 'Adoración', canciones: [song(), song()] },
      { titulo: 'Himno', canciones: [song()] },
      { titulo: 'Ofrenda', canciones: [song()] }
    ];
  }

  function uid() { return 'e' + Math.random().toString(36).slice(2, 9); }

  function newEvento(o) {
    o = o || {};
    return {
      id: o.id || uid(),
      fecha: o.fecha || '',
      hora: o.hora || '8:00 am',
      servicio: o.servicio || SERVICIOS[0],
      tema: o.tema || '',
      cita: o.cita || '',
      notas: o.notas || '',
      bloques: o.bloques || defaultBlocks(),
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
      kicker: 'Repertorio mensual',
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
  function save(data) {
    try { localStorage.setItem(KEY, JSON.stringify(data)); } catch (e) {}
    saveCloud(data);
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

  function saveCloud(data, cb) {
    var ref = dbRef();
    if (!ref) { cb && cb(false); return; }
    ref.set(data).then(function () { cb && cb(true); }, function () { cb && cb(false); });
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
    song: song, defaultBlocks: defaultBlocks, newEvento: newEvento, uid: uid,
    parse: parse, iso: iso, monthKey: monthKey, monthLabel: monthLabel,
    diaNombre: diaNombre, fechaLarga: fechaLarga, semanaDelMes: semanaDelMes,
    hoyKey: hoyKey, calendario: calendario,
    seed: seed, clone: clone, encode: encode, decode: decode,
    load: load, save: save, reset: reset,
    loadCloudOnce: loadCloudOnce, watchCloud: watchCloud
  };
})(window);
