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
  var EVENT_VERSIONS_PATH = 'eventVersions';
  /* Índice heredado {emailKey: {musicianId: organizationId}}: se llenaba al
     escribir el correo en una Persona (ese campo ya no existe). Solo se sigue
     leyendo al iniciar sesión, para no perder vínculos que quedaron
     pendientes; ya no se escribe. */
  var PERSONAS_EMAIL_PATH = 'personasPorCorreo';
  /* Accesos creados desde "+ Agregar usuario": {emailKey: {email, role,
     organizationIds: {orgId: true}, musicianLinks: {orgId: musicianId},
     createdAt, createdBy}}. Se aplican (y se borran) en el primer inicio de
     sesión con ese correo; las reglas de seguridad usan este mismo nodo para
     autorizar que la propia cuenta tome ese rol, organizaciones y persona. */
  var ACCESOS_PATH = 'accesosPorCorreo';
  var SONG_CATALOG_PATH = 'songCatalog';
  /* Cifrados (letra + acordes) importados una vez por canción:
     {orgId: {cifradoId: {titulo, artista, fuenteUrl, tonoOriginal, lineas,
     createdAt, createdBy, updatedAt, updatedBy}}}. Las canciones de los
     eventos lo referencian con `cid`; ver cifrado.js para el formato de
     `lineas` y la transposición. */
  var CIFRADOS_PATH = 'cifrados';
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
  /* Catálogo único de tipos de evento (se guarda el nombre en ev.servicio).
     - calendarios: perfiles de calendario que lo ofrecen (ver
       PERFILES_CALENDARIO); un tipo puede estar en uno o en varios.
     - equipo: asigna personas a puestos (banda[]). En un perfil con
       canciones, esos mismos tipos llevan además repertorio musical; el
       resto sólo pide detalles/responsable y personas requeridas.
     - hora: hora con la que se precarga al elegirlo; sin hora se conserva
       la que ya tenía el borrador.
     El orden es el de los colores fijos del calendario público: los tipos
     nuevos van al final para no cambiarle el color a los existentes. */
  var TIPOS_EVENTO = [
    { nombre: 'Cultos Dominicales', equipo: true, hora: '8:00 am', calendarios: ['repertorio', 'servicio'] },
    { nombre: 'Culto Familiar', equipo: true, hora: '6:30 pm', calendarios: ['repertorio', 'servicio'] },
    { nombre: 'Vigilia General', equipo: true, hora: '7:00 pm', calendarios: ['repertorio', 'servicio'] },
    { nombre: 'Vigilia Juvenil', equipo: true, hora: '7:00 pm', calendarios: ['repertorio', 'servicio'] },
    { nombre: 'Evento Especial', equipo: true, calendarios: ['repertorio', 'servicio'] },
    { nombre: 'Ensayo', equipo: true, calendarios: ['repertorio'] },
    { nombre: 'Capacitación', calendarios: ['repertorio', 'servicio'] },
    { nombre: 'Convocatoria', calendarios: ['repertorio', 'servicio'] },
    { nombre: 'Otro', calendarios: ['repertorio', 'servicio'] },
    { nombre: 'Culto Filial', equipo: true, hora: '7:00 pm', calendarios: ['servicio'] },
    { nombre: 'Vigilia Filial', equipo: true, hora: '7:00 pm', calendarios: ['servicio'] }
  ];

  function tipoEvento(servicio) {
    return TIPOS_EVENTO.filter(function (t) { return t.nombre === servicio; })[0] || null;
  }

  /* Posición fija del tipo en el catálogo (para su color), -1 si no existe. */
  function indiceTipoEvento(servicio) {
    var t = tipoEvento(servicio);
    return t ? TIPOS_EVENTO.indexOf(t) : -1;
  }

  function tiposDeCalendario(calendario, pred) {
    return TIPOS_EVENTO.filter(function (t) { return t.calendarios.indexOf(calendario) >= 0 && (!pred || pred(t)); })
      .map(function (t) { return t.nombre; });
  }

  /* Catálogos del perfil de calendario "repertorio", que se exportan con sus
     nombres de siempre. Las funciones que dependen de un perfil lo reciben
     como último argumento opcional; sin él usan el de repertorio. */
  var SERVICIOS = tiposDeCalendario('repertorio');
  var SERVICIOS_CON_REPERTORIO = tiposDeCalendario('repertorio', function (t) { return t.equipo; });
  var HORA_POR_SERVICIO = {};
  TIPOS_EVENTO.forEach(function (t) { if (t.hora) HORA_POR_SERVICIO[t.nombre] = t.hora; });

  function usaRepertorio(servicio, perfil) { return perfilOr(perfil).usaCanciones(servicio); }

  function horaPorServicio(servicio, perfil) { return HORA_POR_SERVICIO[servicio] || ''; }

  /* Al cambiar el tipo de evento: se usa la hora predefinida del tipo nuevo
     solo si la hora actual está vacía o es una de las predefinidas (vino de
     elegir otro tipo, nadie la ajustó a mano). */
  function horaAlCambiarServicio(horaActual, servicioNuevo, perfil) {
    var horas = HORA_POR_SERVICIO;
    var nueva = horaPorServicio(servicioNuevo, perfil);
    var actual = String(horaActual || '').trim();
    if (!nueva) return actual;
    var predefinidas = Object.keys(horas).map(function (k) { return horas[k]; });
    if (!actual || predefinidas.indexOf(actual) >= 0) return nueva;
    return actual;
  }

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
          if (!porClave.has(key)) porClave.set(key, { key: key, nombre: nombre, salmista: salmista, u: url, cid: '', cidFecha: '' });
          /* El cifrado viaja con la canción: si en algún evento ya se
             importó, el catálogo lo ofrece (el del evento más reciente). */
          var entry = porClave.get(key);
          if (c.cid && (!entry.cid || (ev.fecha || '') > entry.cidFecha)) { entry.cid = c.cid; entry.cidFecha = ev.fecha || ''; }
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
        cifradoId: (ov && ov.cifradoId) || entry.cid,
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
      out.push({ key: key, nombre: ov.titulo, salmista: ov.artista || '', u: ov.url || '', cifradoId: ov.cifradoId || '', archivado: !!ov.archivado });
    });
    out.sort(function (a, b) { return a.nombre.localeCompare(b.nombre, 'es'); });
    return out;
  }

  /* Etiqueta con la que se muestra una canción donde sea que aparezca su
     nombre: si tiene salmista (artista/versión de origen), se concatena
     entre paréntesis para distinguir covers del mismo título. Devuelve
     siempre texto plano (compatible con concatenación de strings). */
  function songLabel(c) {
    var t = ((c && c.t) || '').trim();
    var sm = ((c && c.sm) || '').trim();
    return sm ? (t + ' (' + sm + ')') : t;
  }

  /* Igual que songLabel pero además separa el resultado por saltos de línea,
     para pintar la primera línea en tamaño normal y el resto en letra más
     chica (título de canción con salto = subtítulo/línea aclaratoria). */
  function songLabelParts(c) {
    var fullText = songLabel(c);
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

  /* Códigos de error de la IFrame Player API (evento onError). 101 y 150 son
     el mismo caso: el dueño no permite reproducirlo fuera de YouTube. 153
     aparece cuando el reproductor no se identifica bien (p. ej. la página no
     envía Referer). */
  var YT_ERRORES = {
    2:   { nombre: 'parametro-invalido', mensaje: 'El link de YouTube no es válido.' },
    5:   { nombre: 'error-html5',        mensaje: 'El navegador no pudo reproducir este video.' },
    100: { nombre: 'no-encontrado',      mensaje: 'Este video ya no está disponible (se eliminó o es privado).' },
    101: { nombre: 'embed-no-permitido', mensaje: 'El dueño del video no permite reproducirlo fuera de YouTube.' },
    150: { nombre: 'embed-no-permitido', mensaje: 'El dueño del video no permite reproducirlo fuera de YouTube.' },
    153: { nombre: 'config-reproductor', mensaje: 'YouTube rechazó el reproductor de esta página.' }
  };

  function youtubeErrorMessage(code) {
    var e = YT_ERRORES[code];
    return e ? e.mensaje : 'No se pudo reproducir este video de YouTube (código ' + code + ').';
  }

  /* Los videos monetizados pueden traer un anuncio antes: en el reproductor
     oculto no se ve, así que sólo se percibe silencio (y la IFrame API no lo
     reporta como error: se queda en -1/3 hasta que empieza el video). Si tras
     este tiempo no ha empezado a sonar, se avisa para que no parezca trabado. */
  var YT_ESPERA_LENTO_MS = 6000;
  var YT_MSG_LENTO = 'YouTube está tardando, espera un momento e intenta probar nuevamente...';

  /* Link para que la página ofrezca "Ábrelo en YouTube ↗" junto al aviso
     (allá el anuncio se ve y se puede saltar con el botón de YouTube). Sin
     link cuando no hay nada que abrir: link inválido o video eliminado. */
  function youtubeWatchUrl(videoId, code) {
    if (!videoId || code === 2 || code === 100) return '';
    return 'https://www.youtube.com/watch?v=' + videoId;
  }

  /* Segundos a "m:ss" (o "h:mm:ss") para la línea de tiempo del audio. */
  function formatoTiempo(seg) {
    seg = Math.max(0, Math.floor(seg || 0));
    var h = Math.floor(seg / 3600), m = Math.floor(seg / 60) % 60, s = seg % 60;
    var ss = (s < 10 ? '0' : '') + s;
    return h ? h + ':' + (m < 10 ? '0' : '') + m + ':' + ss : m + ':' + ss;
  }

  /* Valores que pinta la línea de tiempo de la fila que suena (misma forma en
     index, eventos y el Repertorio del panel). `arrastre` (o null) es el
     segundo elegido mientras se arrastra la barra y manda sobre `t`. */
  function progresoAudio(t, d, arrastre, titulo) {
    var pos = arrastre != null ? arrastre : (d ? Math.min(t, d) : t);
    var pct = d ? Math.min(100, (pos / d) * 100) : 0;
    return {
      progActual: formatoTiempo(pos),
      progTotal: d ? formatoTiempo(d) : '–:––',
      progMax: d || 1, progValor: d ? pos : 0, progSinDur: !d,
      progStyle: '--p:' + pct.toFixed(2) + '%',
      progLabel: 'Posición en ' + (titulo || 'la canción'),
      progTexto: formatoTiempo(pos) + ' de ' + (d ? formatoTiempo(d) : 'duración desconocida')
    };
  }

  /* Controlador de un único reproductor de YouTube oculto, compartido por
     todas las filas de canciones de una página (evita crear un iframe por
     fila). onChange(key|null, paused) se llama con la llave de la fila que
     quedó cargada (o null cuando se termina) y si está en pausa, para que el
     componente sólo tenga que reflejar esos valores en su estado.
     Un tercer argumento opcional trae un aviso para mostrar al usuario:
       - { tipo: 'error', code, videoId, key, mensaje, url } cuando YouTube
         no puede reproducir el video (llega con key null: la fila se libera).
       - { tipo: 'lento', videoId, key, mensaje, url } cuando el video tarda en
         empezar (la fila sigue cargada). Cuando por fin suena llega un
         onChange(key, false) sin aviso, señal para quitar el mensaje.
       `url` (puede venir vacío) es el video en YouTube, ver youtubeWatchUrl.
     onProgress(key, segundos, duracion) (opcional) alimenta la línea de tiempo
     de la fila cargada: se consulta el reproductor cada YT_PROGRESO_MS pero
     solo se avisa cuando cambia el segundo entero o la duración, para no
     re-renderizar la página de más. duracion llega en 0 mientras YouTube no
     la conoce (cargando o pasando un anuncio). */
  var YT_PROGRESO_MS = 250;

  function youtubeController(elementId, onChange, onProgress) {
    var player = null, ready = false, pending = null, current = null, currentVideoId = null, paused = false;
    var lentoTimer = null, lentoAvisado = false;
    var progresoTimer = null, ultimoSeg = -1, ultimaDur = -1;

    function avisarProgreso(forzar) {
      if (!onProgress || !current || !player || !player.getCurrentTime) return;
      var t = 0, d = 0;
      try { t = player.getCurrentTime() || 0; d = player.getDuration() || 0; } catch (x) { return; }
      var seg = Math.floor(t), dur = Math.floor(d);
      if (!forzar && seg === ultimoSeg && dur === ultimaDur) return;
      ultimoSeg = seg; ultimaDur = dur;
      onProgress(current, seg, dur);
    }

    function vigilarProgreso() {
      if (!onProgress || progresoTimer) return;
      progresoTimer = setInterval(function () { avisarProgreso(false); }, YT_PROGRESO_MS);
    }

    function detenerProgreso() {
      clearInterval(progresoTimer); progresoTimer = null; ultimoSeg = -1; ultimaDur = -1;
    }

    function cancelarLento() { clearTimeout(lentoTimer); lentoTimer = null; lentoAvisado = false; }

    function vigilarInicio() {
      cancelarLento();
      lentoTimer = setTimeout(function () {
        lentoTimer = null;
        if (!current || paused) return;
        lentoAvisado = true;
        console.info('[YouTube] El video ' + currentVideoId + ' (fila ' + current + ') no ha empezado tras ' +
          (YT_ESPERA_LENTO_MS / 1000) + ' s (posible anuncio).');
        if (onChange) onChange(current, false, { tipo: 'lento', videoId: currentVideoId, key: current, mensaje: YT_MSG_LENTO, url: youtubeWatchUrl(currentVideoId) });
      }, YT_ESPERA_LENTO_MS);
    }

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
            if (e.data === w.YT.PlayerState.PLAYING) {
              var avisado = lentoAvisado;
              cancelarLento();
              if (avisado && onChange) onChange(current, paused);
            }
            if (e.data === w.YT.PlayerState.ENDED) { cancelarLento(); detenerProgreso(); current = null; currentVideoId = null; paused = false; if (onChange) onChange(null, false); }
          },
          /* Sin esto la fila quedaba marcada como sonando aunque YouTube
             rechazara el video. Se detiene el reproductor y se libera la
             fila; volver a tocarla reintenta la carga desde cero. */
          onError: function (e) {
            var code = e && e.data;
            var info = YT_ERRORES[code];
            var err = { tipo: 'error', code: code, videoId: currentVideoId, key: current, mensaje: youtubeErrorMessage(code), url: youtubeWatchUrl(currentVideoId, code) };
            cancelarLento();
            detenerProgreso();
            console.warn('[YouTube] Error ' + code + (info ? ' (' + info.nombre + ')' : '') +
              ' con el video ' + err.videoId + ' (fila ' + err.key + '): https://www.youtube.com/watch?v=' + err.videoId);
            try { if (player && player.stopVideo) player.stopVideo(); } catch (x) {}
            current = null; currentVideoId = null; paused = false; pending = null;
            if (onChange) onChange(null, false, err);
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
        if (paused) { player.playVideo(); paused = false; } else { player.pauseVideo(); paused = true; cancelarLento(); }
        if (onChange) onChange(key, paused);
      } else {
        player.loadVideoById(videoId);
        player.playVideo();
        current = key;
        currentVideoId = videoId;
        paused = false;
        vigilarInicio();
        detenerProgreso();
        if (onProgress) onProgress(key, 0, 0);
        vigilarProgreso();
        if (onChange) onChange(key, false);
      }
    }

    /* Salta a `segundos` del video cargado, solo si es el de esa fila (evita
       que un arrastre tardío mueva otra canción que ya empezó a sonar). */
    function seek(key, segundos) {
      if (!ready || !player || key !== current || !(segundos >= 0)) return;
      try { player.seekTo(segundos, true); } catch (x) { return; }
      avisarProgreso(true);
    }

    function destroy() { cancelarLento(); detenerProgreso(); if (player && player.destroy) player.destroy(); }

    return { toggle: toggle, seek: seek, destroy: destroy };
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

  /* Un evento puede tener varias participaciones de la banda ("Bloque 1",
     "Bloque 2", …). No se anida un nivel nuevo: cada sección de `bloques`
     (Júbilo, Adoración, …) lleva un número `parte`, y las secciones de una
     misma parte quedan contiguas en el arreglo. Los eventos guardados antes
     de que existiera el campo no lo traen y cuentan como Bloque 1. */
  function bloqueParte(bl) {
    var n = Number(bl && bl.parte);
    return n > 0 ? n : 1;
  }

  /* Secciones con las que arranca cada bloque agregado con "Agregar Bloque". */
  function nuevaParte(parte) {
    return [
      { titulo: 'Júbilo', parte: parte, canciones: [song(), song()] },
      { titulo: 'Adoración', parte: parte, canciones: [song(), song()] }
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

  /* Puestos de un ministerio con roles de banda (Alabanza, en servicio
     ministerial): el slot sigue siendo del ministerio (tipo: 'Alabanza') y
     además lleva el rol que hará la persona (rol: 'Corista'). El número es
     por rol dentro del ministerio y respeta el `numerar` de BANDA_ROLES
     (Director de Alabanza 1, Corista 1; Bajo, Bajo 2). */
  function numeroParaRol(banda, tipo, rol, excluirId) {
    var existentes = (banda || []).filter(function (b) { return b.tipo === tipo && b.rol === rol && b.id !== excluirId; });
    var def = BANDA_ROLES.filter(function (r) { return r.tipo === rol; })[0];
    if (!existentes.length) return def && def.numerar ? 1 : null;
    return Math.max.apply(null, existentes.map(function (b) { return b.numero || 1; })) + 1;
  }

  function bandaSlotRol(banda, tipo, rol) {
    var sl = bandaSlot(tipo, numeroParaRol(banda, tipo, rol));
    sl.rol = rol;
    return sl;
  }

  /* Rol con que arranca cada puesto nuevo de un ministerio con roles de
     banda: el primero es Director de Alabanza; los que se agregan después,
     el siguiente rol de la lista (Corista). */
  function rolInicialMinisterio(banda, rolDef) {
    var subroles = (rolDef && rolDef.subroles) || [];
    var yaHay = (banda || []).some(function (b) { return b.tipo === rolDef.tipo; });
    return (yaHay ? subroles[1] : null) || subroles[0] || '';
  }

  function defaultBanda(perfil) {
    var out = [];
    perfilOr(perfil).roles.forEach(function (r) {
      for (var i = 1; i <= r.cantidad; i++) {
        if (r.rolesBanda) out.push(bandaSlotRol(out, r.tipo, rolInicialMinisterio(out, r)));
        else out.push(bandaSlot(r.tipo, r.numerar ? i : null));
      }
    });
    return out;
  }

  function bandaLabel(slot) {
    var base = slot.rol || slot.tipo;
    return slot.numero ? (base + ' ' + slot.numero) : base;
  }

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
     del evento y las personas requeridas. Un perfil sin canciones (servicio
     ministerial) lista solo el equipo asignado. */
  function eventoDescripcion(ev, perfil) {
    var pf = perfilOr(perfil);
    var out = [];
    if (pf.usaBanda(ev.servicio)) {
      var orden = pf.ordenRoles();
      var banda = (ev.banda || [])
        .filter(function (b) { return b.nombre && b.nombre.trim(); })
        .slice()
        .sort(function (a, b) {
          var d = orden.indexOf(a.tipo) - orden.indexOf(b.tipo);
          return d !== 0 ? d : (a.numero || 0) - (b.numero || 0);
        });
      if (banda.length) {
        out.push(pf.textos.equipo + ':');
        banda.forEach(function (b) { out.push((b.rol ? b.tipo + ' · ' + bandaLabel(b) : b.tipo) + ': ' + b.nombre.trim()); });
        out.push('');
      }
      var canciones = [];
      var partes = [];
      (pf.usaCanciones(ev.servicio) ? (ev.bloques || []) : []).forEach(function (bl) {
        (bl.canciones || []).forEach(function (c) {
          if (!(c.t && c.t.trim())) return;
          var parte = bloqueParte(bl);
          if (partes.indexOf(parte) < 0) partes.push(parte);
          canciones.push({ c: c, parte: parte });
        });
      });
      if (canciones.length) {
        out.push('Canciones:');
        var ultimaParte = null;
        canciones.forEach(function (x) {
          if (partes.length > 1 && x.parte !== ultimaParte) {
            out.push('Bloque ' + (partes.indexOf(x.parte) + 1) + ':');
            ultimaParte = x.parte;
          }
          var c = x.c;
          out.push('- ' + c.t.trim() + (c.k && c.k.trim() ? ' (' + c.k.trim() + ')' : ''));
        });
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

  function buildIcs(ev, perfil) {
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
      'DESCRIPTION:' + icsEscape(eventoDescripcion(ev, perfil)),
      'END:VEVENT',
      'END:VCALENDAR'
    ];
    return lines.map(icsFoldLine).join('\r\n') + '\r\n';
  }

  function icsDataHref(ev, perfil) {
    return 'data:text/calendar;charset=utf-8,' + encodeURIComponent(buildIcs(ev, perfil));
  }

  function icsFilename(ev) {
    return 'evento-' + (ev.fecha || 'sf') + '.ics';
  }

  function googleCalendarUrl(ev, perfil) {
    var params = new URLSearchParams({
      action: 'TEMPLATE',
      text: eventoTitulo(ev),
      dates: stampUTC(eventoInicioUTC(ev)) + '/' + stampUTC(eventoFinUTC(ev)),
      details: eventoDescripcion(ev, perfil)
    });
    return 'https://calendar.google.com/calendar/render?' + params.toString();
  }

  /* Estados del ciclo de vida de un evento. BORRADOR/PUBLICADO se controlan
     desde el paso final del asistente; CANCELADO/ARCHIVADO se marcan con
     acciones rápidas desde el listado del día, sin pasar por el asistente.
     ELIMINADO es un borrado lógico que solo aplica a borradores: el registro
     se queda en la base pero watchEventsForOrg lo descarta, así que
     desaparece de todas las vistas. */
  var ESTADOS_EVENTO = ['BORRADOR', 'PUBLICADO', 'CANCELADO', 'ARCHIVADO', 'ELIMINADO'];
  /* El calendario público muestra también los borradores, con su etiqueta. */
  var ESTADOS_VISIBLES_PUBLICO = ['PUBLICADO', 'BORRADOR', 'CANCELADO'];

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
      ARCHIVADO: { label: 'Archivado', bg: '#6b6866', color: '#fff' },
      ELIMINADO: { label: 'Eliminado', bg: '#6b6866', color: '#fff' }
    };
    return map[estadoEvento(ev)] || map.PUBLICADO;
  }

  /* `perfil` (opcional) decide el tipo, la hora y la banda con que arranca
     un evento nuevo; lo que ya trae `o` se respeta tal cual. */
  function newEvento(o, perfil) {
    o = o || {};
    var pf = perfilOr(perfil);
    var servicio = o.servicio || pf.servicios[0];
    var ev = {
      id: o.id || uid(),
      fecha: o.fecha || '',
      hora: o.hora || horaPorServicio(servicio, pf) || '8:00 am',
      servicio: servicio,
      tema: o.tema || '',
      cita: o.cita || '',
      avisoImportante: o.avisoImportante || '',
      notas: o.notas || '',
      bloques: o.bloques || (pf.tieneCanciones ? defaultBlocks() : []),
      banda: o.banda || defaultBanda(pf),
      detalles: o.detalles || '',
      personas: o.personas || '',
      organizationId: o.organizationId || '',
      estado: o.estado || 'BORRADOR'
    };
    /* Solo los ensayos lo llevan (ver heredarDeEvento). */
    if (o.eventoAsociadoId) ev.eventoAsociadoId = o.eventoAsociadoId;
    return ev;
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
     puede usarse tal cual como llave de /personasPorCorreo. Solo se sustituye
     el punto (el único carácter prohibido que aparece en la práctica en un
     correo real); esta misma sustitución se replica del lado de las reglas
     de seguridad para poder validar el auto-vínculo al iniciar sesión. */
  function normalizarEmail(email) { return String(email || '').trim().toLowerCase(); }

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
     si hace falta). tipoCalendario (ver PERFILES_CALENDARIO) se fija aquí y
     no se cambia después; se acepta la firma vieja (name, cb). Los
     ministerios de una organización de servicio no se escriben: sin lista
     propia usa MINISTERIOS_DEFECTO. */
  function createOrganization(name, tipoCalendario, cb) {
    if (typeof tipoCalendario === 'function') { cb = tipoCalendario; tipoCalendario = null; }
    var root = dbRoot();
    if (!root) { cb && cb(null, new Error('Firebase no disponible')); return; }
    var base = slugify(name) || 'organizacion';
    root.child(ORGS_PATH).once('value').then(function (snap) {
      var existentes = snapshotToArray(snap).map(function (o) { return o.slug; });
      var slug = base, n = 2;
      while (existentes.indexOf(slug) >= 0) { slug = base + n; n++; }
      var id = root.child(ORGS_PATH).push().key;
      var org = { id: id, name: name, slug: slug, kicker: 'Calendario mensual', nota: '', createdAt: Date.now(),
        tipoCalendario: tipoCalendarioValido(tipoCalendario) };
      root.child(ORGS_PATH).child(id).set(org).then(function () { cb && cb(org, null); }, function (err) { cb && cb(null, err); });
    }, function (err) { cb && cb(null, err); });
  }

  /* patch no puede tocar id/slug (el slug es inmutable una vez creado para
     no romper enlaces ?group=slug ya compartidos). bannerUrl es una URL de
     imagen alojada externamente (no se sube ningún archivo, para mantener
     el sitio sin costo de Firebase Storage). tipoCalendario tampoco se toca
     (se elige al crear). ministerios solo aplica a las de servicio
     ministerial y se guarda ya normalizado. */
  function updateOrganization(orgId, patch, cb) {
    var root = dbRoot();
    if (!root) { cb && cb(false); return; }
    var safe = { name: patch.name, kicker: patch.kicker, nota: patch.nota };
    if (patch.bannerUrl !== undefined) safe.bannerUrl = patch.bannerUrl;
    if (patch.ministerios !== undefined) safe.ministerios = normalizarMinisterios(patch.ministerios);
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

  /* --- Permisos por rol ---
     Qué puede hacer cada rol. Por ahora es fijo aquí; la futura opción de
     "Roles" configurables solo tendrá que reemplazar este mapa. '*' = todo.
     Permisos: eventos.ver, eventos.crear, eventos.editar, eventos.mover,
     eventos.estado (publicar / borrador / cancelar / archivar),
     eventos.todos (editar/mover cualquier evento, no solo aquellos donde su
     persona es integrante), usuarios.gestionar, repertorio.gestionar,
     organizaciones.gestionar, cifrados.editar (importar/reemplazar el
     cifrado de las canciones de los eventos que puede editar),
     canciones.editar (sub-pestaña Canciones y el orden en la revisión;
     eventos.editar y estos dos, fuera de admin, solo los da el puesto en
     el evento: PERMISOS_POR_ROL_BANDA),
     banda.editar (sub-pestaña Banda: asignar integrantes; sin él la banda
     solo se consulta en la revisión y se guarda tal como está en la nube),
     eventos.tipo (cambiar el tipo de evento de uno existente; sin él, al
     editar se entra directo al paso 2 y se conserva el tipo de la nube),
     avisos.gestionar (módulo Avisos y el panel "Avisar al equipo" al
     publicar: sin él se publica igual, pero sin avisar).
     editor: todo lo de eventos como un admin, más el Repertorio; nada de
     usuarios/personas, organizaciones ni avisos. */
  var PERMISOS_POR_ROL = {
    admin: ['*'],
    editor: [
      'eventos.ver', 'eventos.crear', 'eventos.editar', 'eventos.mover', 'eventos.estado',
      'eventos.todos', 'eventos.tipo', 'banda.editar', 'canciones.editar', 'cifrados.editar',
      'repertorio.gestionar'
    ],
    normal: ['eventos.ver']
  };

  /* Roles de cuenta en el orden en que se ofrecen en Usuarios. */
  var ROLES = [
    { id: 'normal', label: 'Normal' },
    { id: 'editor', label: 'Editor' },
    { id: 'admin', label: 'Admin' }
  ];

  function rolValido(role) {
    return ROLES.some(function (r) { return r.id === role; }) ? role : 'normal';
  }

  function rolLabel(role) {
    var r = ROLES.filter(function (x) { return x.id === role; })[0];
    return r ? r.label : 'Normal';
  }

  /* Permisos que da el PUESTO que la persona ocupa en un evento concreto
     (banda[].tipo), solo para ese evento. Un Director de Alabanza asignado
     como tal edita el evento y sus canciones; si ese día va de Corista, no.
     Coristas y músicos no reciben permisos de edición. Ver puedeSobreEvento. */
  var PERMISOS_POR_ROL_BANDA = {
    'Director de Alabanza': ['eventos.editar', 'canciones.editar', 'cifrados.editar']
  };

  /* --- Perfiles de calendario ---
     Cada organización elige al crearse qué clase de calendario lleva
     (organizations/{id}.tipoCalendario, no se cambia después). Todas
     comparten el mismo asistente, el mismo modelo de evento y los mismos
     puestos en `banda[]` (con confirmación/declinación, integrantes, avisos
     y participaciones); lo que cambia es el catálogo:
     - servicios: tipos de evento que ofrece (TIPOS_EVENTO.calendarios).
     - canciones: si sus tipos con equipo llevan además bloques de canciones.
     - roles: puestos que se solicitan por defecto (orden = orden en
       pantalla). En servicio ministerial son los ministerios, que cada
       organización puede ajustar (organizations/{id}.ministerios); un
       ministerio con `rolesBanda` (Alabanza) convoca con los roles de la
       banda (Director de Alabanza, Corista, Piano…) en `subroles`.
     - permisosPorPuesto: permisos que da ocupar un puesto en un evento. En
       servicio ministerial no hay: los eventos los crea y edita el rol de
       cuenta Editor (o Admin) de la organización.
     - ensayos: si existe el tipo Ensayo (asociado a un evento de repertorio).
     - textos: cómo se llama el equipo en pantalla.
     - modulosOcultos: módulos de menu-config.js que no aplican.
     Una organización sin tipoCalendario es de repertorio (todas las que
     existían antes de los perfiles). */
  var TIPO_CALENDARIO_DEFECTO = 'repertorio';

  /* Ministerios con que arranca una organización de servicio ministerial. */
  var MINISTERIOS_DEFECTO = [
    { tipo: 'Protocolo', cantidad: 1 },
    { tipo: 'Alabanza', cantidad: 1, rolesBanda: true },
    { tipo: 'Ofrenda', cantidad: 1 },
    { tipo: 'Limpieza', cantidad: 1 },
    { tipo: 'Infantil', cantidad: 1 }
  ];
  var MINISTERIO_CANTIDAD_MAX = 10;

  /* Limpia la lista de ministerios de una organización: nombre recortado y
     sin repetir (sin distinguir mayúsculas), cantidad entera 1..10. Vacía o
     inválida → los de por defecto. */
  function normalizarMinisterios(lista) {
    var vistos = {};
    var out = (Array.isArray(lista) ? lista : []).map(function (m) {
      var tipo = String((m && m.tipo) || '').replace(/\s+/g, ' ').trim().slice(0, 40);
      var cantidad = Math.round(Number(m && m.cantidad));
      if (!(cantidad >= 1)) cantidad = 1;
      if (cantidad > MINISTERIO_CANTIDAD_MAX) cantidad = MINISTERIO_CANTIDAD_MAX;
      var r = { tipo: tipo, cantidad: cantidad };
      if (m && m.rolesBanda) r.rolesBanda = true;
      return r;
    }).filter(function (m) {
      var k = m.tipo.toLowerCase();
      if (!m.tipo || vistos[k]) return false;
      vistos[k] = true;
      return true;
    });
    return out.length ? out : MINISTERIOS_DEFECTO.map(function (m) { return Object.assign({}, m); });
  }

  function rolesDeMinisterios(lista) {
    return normalizarMinisterios(lista).map(function (m) {
      var r = { tipo: m.tipo, cantidad: m.cantidad, numerar: false };
      if (m.rolesBanda) { r.rolesBanda = true; r.subroles = BANDA_ROLES.map(function (b) { return b.tipo; }); }
      return r;
    });
  }

  function crearPerfil(def) {
    var servicios = tiposDeCalendario(def.id);
    var tieneCanciones = !!def.canciones;
    var usaBanda = function (servicio) { var t = tipoEvento(servicio); return !!(t && t.equipo); };
    return {
      id: def.id,
      label: def.label,
      descripcion: def.descripcion,
      servicios: servicios,
      roles: def.roles,
      permisosPorPuesto: def.permisosPorPuesto || {},
      ensayos: !!def.ensayos,
      tieneCanciones: tieneCanciones,
      textos: def.textos,
      modulosOcultos: def.modulosOcultos || [],
      usaBanda: usaBanda,
      usaCanciones: function (servicio) { return tieneCanciones && usaBanda(servicio); },
      ordenRoles: function () { return def.roles.map(function (r) { return r.tipo; }); },
      /* Etiquetas que se le pueden poner a una persona (rolesBanda): los
         puestos y, si algún ministerio convoca con roles de banda, también
         esos roles, para filtrar a quién se ofrece en cada uno. */
      etiquetasPersona: function () {
        var out = [];
        def.roles.forEach(function (r) {
          [r.tipo].concat(r.subroles || []).forEach(function (t) { if (out.indexOf(t) < 0) out.push(t); });
        });
        return out;
      },
      /* Tipos para elegir en el asistente: si el evento trae uno que este
         perfil no ofrece (dato viejo), se ofrece primero para no perderlo. */
      serviciosCon: function (actual) {
        return actual && servicios.indexOf(actual) < 0 ? [actual].concat(servicios) : servicios.slice();
      },
      muestraModulo: function (id) { return (def.modulosOcultos || []).indexOf(id) < 0; }
    };
  }

  var DEF_PERFILES = {
    repertorio: {
      id: 'repertorio',
      label: 'Repertorio musical',
      descripcion: 'Banda, canciones, cifrados y ensayos',
      canciones: true,
      roles: BANDA_ROLES,
      permisosPorPuesto: PERMISOS_POR_ROL_BANDA,
      ensayos: true,
      textos: {
        equipo: 'Banda', integrantes: 'Integrantes de la banda', puesto: 'Rol',
        soloLectura: 'La banda la asigna un administrador.',
        personas: 'Identidad y roles de banda de cada integrante, con o sin cuenta todavía.', agregarEtiqueta: '+ Agregar rol',
        notas: 'Notas del ensayo', notasPlaceholder: 'Indicaciones especiales para el ensayo o el repertorio'
      }
    },
    servicio: {
      id: 'servicio',
      label: 'Servicio ministerial',
      descripcion: 'Servidores por ministerio (Protocolo, Alabanza, Ofrenda…), sin canciones',
      canciones: false,
      roles: rolesDeMinisterios(MINISTERIOS_DEFECTO),
      permisosPorPuesto: {},
      ensayos: false,
      textos: {
        equipo: 'Servidores', integrantes: 'Servidores asignados', puesto: 'Ministerio',
        soloLectura: 'Los servidores los asigna un administrador.',
        personas: 'Identidad, ministerios y roles de banda (para Alabanza) de cada servidor, con o sin cuenta todavía.', agregarEtiqueta: '+ Agregar ministerio o rol',
        notas: 'Notas para los servidores', notasPlaceholder: 'Indicaciones especiales para los servidores de este evento'
      },
      modulosOcultos: ['repertorio'],
      ministerios: true
    }
  };

  var PERFILES_CALENDARIO = {};
  Object.keys(DEF_PERFILES).forEach(function (k) { PERFILES_CALENDARIO[k] = crearPerfil(DEF_PERFILES[k]); });

  var TIPOS_CALENDARIO = Object.keys(PERFILES_CALENDARIO).map(function (k) {
    return { id: k, label: PERFILES_CALENDARIO[k].label, descripcion: PERFILES_CALENDARIO[k].descripcion };
  });

  function tipoCalendarioValido(tipo) {
    return PERFILES_CALENDARIO[tipo] ? tipo : TIPO_CALENDARIO_DEFECTO;
  }

  function perfilCalendario(tipo) { return PERFILES_CALENDARIO[tipoCalendarioValido(tipo)]; }

  /* Perfil de una organización: el de su tipo de calendario, con sus propios
     ministerios si es de servicio y los configuró. Se reutiliza mientras la
     lista no cambie (las páginas lo piden en cada render). */
  var perfilesPorOrg = {};
  function perfilOrg(org) {
    var tipo = tipoCalendarioValido(org && org.tipoCalendario);
    var def = DEF_PERFILES[tipo];
    if (!def.ministerios || !org || !org.ministerios) return PERFILES_CALENDARIO[tipo];
    var firma = JSON.stringify(normalizarMinisterios(org.ministerios));
    var cache = perfilesPorOrg[org.id || ''];
    if (cache && cache.firma === firma) return cache.perfil;
    var perfil = crearPerfil(Object.assign({}, def, { roles: rolesDeMinisterios(org.ministerios) }));
    perfilesPorOrg[org.id || ''] = { firma: firma, perfil: perfil };
    return perfil;
  }

  /* Acepta un perfil ya resuelto o nada (→ repertorio). */
  function perfilOr(perfil) { return perfil && perfil.usaBanda ? perfil : PERFILES_CALENDARIO[TIPO_CALENDARIO_DEFECTO]; }

  function puede(userDoc, permiso) {
    if (!userDoc) return false;
    var lista = PERMISOS_POR_ROL[userDoc.role || 'normal'] || [];
    return lista.indexOf('*') >= 0 || lista.indexOf(permiso) >= 0;
  }

  /* Permiso sobre un evento concreto (eventos.editar, eventos.mover,
     canciones.editar, cifrados.editar…). Lo da:
     - el rol de la cuenta junto con 'eventos.todos' (admin), o
     - el rol de la cuenta, si su persona vinculada es integrante del evento, o
     - el puesto de banda que esa persona ocupa en el evento
       (permisosPorPuesto del perfil; sin perfil, PERMISOS_POR_ROL_BANDA). */
  function puedeSobreEvento(userDoc, permiso, ev, perfil) {
    if (!userDoc || !ev) return false;
    var porCuenta = puede(userDoc, permiso);
    if (porCuenta && puede(userDoc, 'eventos.todos')) return true;
    var miPersona = userMusicianLinks(userDoc)[ev.organizationId];
    if (!miPersona) return false;
    if (porCuenta && integrantesEvento(ev)[miPersona]) return true;
    var clave = function (t) { return String(t || '').trim().toLowerCase(); };
    return (ev.banda || []).some(function (slot) {
      if (!slot || slot.musicianId !== miPersona || !(slot.nombre || '').trim()) return false;
      var porPuesto = perfilOr(perfil).permisosPorPuesto;
      return Object.keys(porPuesto).some(function (r) {
        return clave(r) === clave(slot.tipo) && porPuesto[r].indexOf(permiso) >= 0;
      });
    });
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

    function crearDoc(onDone) {
      var doc = { uid: firebaseUser.uid, email: email, displayName: firebaseUser.displayName || email, role: 'normal', createdAt: Date.now() };
      ref.set(doc).then(function () { onDone(doc); }, function () { onDone(doc); });
    }

    /* Heredado: vínculos que quedaron pendientes cuando el correo se definía
       en la Persona (ver PERSONAS_EMAIL_PATH). Ya no se crean nuevos. */
    function vincularPorCorreo(doc, onDone) {
      var key = emailKey(email);
      if (!key) { onDone(doc); return; }
      root.child(PERSONAS_EMAIL_PATH).child(key).once('value').then(function (snap) {
        var personas = snap.val() || {};
        var links = doc.musicianLinks || {};
        var orgs = doc.organizationIds || {};
        var updates = {};
        Object.keys(personas).forEach(function (musicianId) {
          var orgId = personas[musicianId];
          if (!orgId || (links[orgId] === musicianId && orgs[orgId])) return;
          updates[MUSICIANS_PATH + '/' + musicianId + '/userId'] = firebaseUser.uid;
          updates[USERS_PATH + '/' + firebaseUser.uid + '/musicianLinks/' + orgId] = musicianId;
          updates[USERS_PATH + '/' + firebaseUser.uid + '/organizationIds/' + orgId] = true;
        });
        if (!Object.keys(updates).length) { onDone(doc); return; }
        root.update(updates).then(function () {
          doc.musicianLinks = Object.assign({}, links);
          doc.organizationIds = Object.assign({}, orgs);
          Object.keys(personas).forEach(function (musicianId) {
            doc.musicianLinks[personas[musicianId]] = musicianId;
            doc.organizationIds[personas[musicianId]] = true;
          });
          onDone(doc);
        }, function (err) {
          console.error('Firebase vincularPorCorreo rechazado:', err && err.code, err && err.message, err);
          onDone(doc);
        });
      }, function () { onDone(doc); });
    }

    /* Acceso creado por un admin con "+ Agregar usuario": se aplica una sola
       vez (rol, organizaciones y persona) y se borra en la misma escritura.
       Nunca baja de rol a una cuenta que ya era admin (ni de editor a normal). */
    function aplicarAccesoPendiente(doc, onDone) {
      var key = emailKey(email);
      if (!key) { onDone(doc); return; }
      root.child(ACCESOS_PATH).child(key).once('value').then(function (snap) {
        var acc = snap.val();
        if (!acc) { onDone(doc); return; }
        var base = USERS_PATH + '/' + firebaseUser.uid;
        var orgs = Object.assign({}, acc.organizationIds || {});
        var links = acc.musicianLinks || {};
        Object.keys(links).forEach(function (orgId) { orgs[orgId] = true; });
        var nivel = { normal: 0, editor: 1, admin: 2 };
        var rolAcceso = rolValido(acc.role), rolActual = rolValido(doc.role);
        var nuevoRol = nivel[rolAcceso] > nivel[rolActual] ? rolAcceso : rolActual;
        var updates = {};
        updates[ACCESOS_PATH + '/' + key] = null;
        if (nuevoRol !== doc.role) updates[base + '/role'] = nuevoRol;
        Object.keys(orgs).forEach(function (orgId) { updates[base + '/organizationIds/' + orgId] = true; });
        Object.keys(links).forEach(function (orgId) {
          updates[base + '/musicianLinks/' + orgId] = links[orgId];
          updates[MUSICIANS_PATH + '/' + links[orgId] + '/userId'] = firebaseUser.uid;
        });
        root.update(updates).then(function () {
          doc.role = nuevoRol;
          doc.organizationIds = Object.assign({}, doc.organizationIds || {}, orgs);
          doc.musicianLinks = Object.assign({}, doc.musicianLinks || {}, links);
          onDone(doc);
        }, function (err) {
          console.error('Firebase aplicarAccesoPendiente rechazado:', err && err.code, err && err.message, err);
          onDone(doc);
        });
      }, function () { onDone(doc); });
    }

    function completar(doc) {
      aplicarAccesoPendiente(doc, function (d) { vincularPorCorreo(d, function (d2) { cb && cb(d2); }); });
    }

    function intentar(reintentosRestantes) {
      ref.once('value').then(function (snap) {
        if (snap.exists()) {
          var v = snap.val();
          v.uid = firebaseUser.uid;
          promoverSiAplica(v, completar);
          return;
        }
        crearDoc(function (doc) {
          promoverSiAplica(doc, completar);
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

  /* Teléfono para los avisos por WhatsApp (ver avisos.js): solo dígitos con
     código de país, '' lo borra. */
  function setUserTelefono(uid, telefono, cb) {
    var root = dbRoot();
    if (!root || !uid) { cb && cb(false); return; }
    root.child(USERS_PATH).child(uid).child('telefono').set(telefono || null).then(function () { cb && cb(true); }, function (err) {
      console.error('Firebase setUserTelefono rechazado:', err && err.code, err && err.message, err);
      cb && cb(false);
    });
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

  /* Último calendario abierto en este navegador (con o sin sesión): una
     cookie con el id de la organización, que index.html escribe cada vez que
     muestra un calendario. Sirve para que un visitante sin sesión no tenga
     que elegir en cada visita y para que una cuenta con varias
     organizaciones vuelva a la última que abrió. Vale un año y queda
     acotada a la carpeta del sitio (en GitHub Pages, /RepertorioApp/). */
  var COOKIE_ORG = 'repertorio_org';
  var COOKIE_ORG_MAX_AGE = 365 * 24 * 60 * 60;

  function rutaCookie() {
    var p = (w.location && w.location.pathname) || '/';
    return p.slice(0, p.lastIndexOf('/') + 1) || '/';
  }

  function guardarOrgPreferida(orgId) {
    if (!orgId) return;
    try {
      w.document.cookie = COOKIE_ORG + '=' + encodeURIComponent(orgId) + '; max-age=' + COOKIE_ORG_MAX_AGE +
        '; path=' + rutaCookie() + '; SameSite=Lax';
    } catch (e) { /* sin cookies */ }
  }

  function orgPreferida() {
    try {
      var m = String(w.document.cookie || '').match(new RegExp('(?:^|;\\s*)' + COOKIE_ORG + '=([^;]*)'));
      return m && m[1] ? decodeURIComponent(m[1]) : null;
    } catch (e) { return null; }
  }

  function borrarOrgPreferida() {
    try { w.document.cookie = COOKIE_ORG + '=; max-age=0; path=' + rutaCookie() + '; SameSite=Lax'; } catch (e) { /* sin cookies */ }
  }

  /* Organización con que arranca una cuenta: la del último calendario que
     abrió en este navegador, si pertenece a ella; si no, la primera donde ya
     tiene una Persona vinculada (para que un admin que también es
     integrante aterrice en su propio Dashboard de persona), o la primera a
     secas si no tiene ninguna. */
  function orgInicialDeUsuario(userDoc) {
    var ids = userOrgIds(userDoc);
    var links = userMusicianLinks(userDoc);
    var pref = orgPreferida();
    if (pref && ids.indexOf(pref) >= 0) return pref;
    return ids.filter(function (id) { return !!links[id]; })[0] || ids[0] || null;
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
    getOrganization(orgInicialDeUsuario(userDoc), function (org) {
      w.location.href = org ? ('dashboard.html?org=' + org.slug) : 'index.html';
    });
  }

  /* --- Accesos pendientes ("+ Agregar usuario") --- */

  function watchAccesosPendientes(cb) {
    var root = dbRoot();
    if (!root) return function () {};
    var ref = root.child(ACCESOS_PATH);
    var handler = function (snap) {
      var out = [];
      snap.forEach(function (child) { var v = child.val() || {}; v.key = child.key; out.push(v); });
      cb(out);
    };
    ref.on('value', handler, function () { cb([]); });
    return function () { ref.off('value', handler); };
  }

  /* acc: {email, role, orgIds: [..], musicianLinks: {orgId: musicianId}}.
     Si ya había un acceso pendiente para ese correo, se reemplaza. */
  function crearAccesoPendiente(acc, creadoPor, cb) {
    var root = dbRoot();
    var email = normalizarEmail(acc && acc.email);
    if (!root || !email) { cb && cb(false); return; }
    var orgs = {};
    (acc.orgIds || []).forEach(function (id) { orgs[id] = true; });
    var links = {};
    Object.keys(acc.musicianLinks || {}).forEach(function (orgId) {
      if (acc.musicianLinks[orgId]) { links[orgId] = acc.musicianLinks[orgId]; orgs[orgId] = true; }
    });
    var doc = { email: email, role: rolValido(acc.role), organizationIds: orgs, createdAt: Date.now(), createdBy: creadoPor || null };
    if (Object.keys(links).length) doc.musicianLinks = links;
    root.child(ACCESOS_PATH).child(emailKey(email)).set(doc).then(function () { cb && cb(true); }, function (err) {
      console.error('Firebase crearAccesoPendiente rechazado:', err && err.code, err && err.message, err);
      cb && cb(false);
    });
  }

  function borrarAccesoPendiente(key, cb) {
    var root = dbRoot();
    if (!root || !key) { cb && cb(false); return; }
    root.child(ACCESOS_PATH).child(key).remove().then(function () { cb && cb(true); }, function () { cb && cb(false); });
  }

  /* --- Eventos --- */

  function watchEventsForOrg(orgId, cb) {
    var root = dbRoot();
    if (!root) return function () {};
    var ref = root.child(EVENTS_PATH).orderByChild('organizationId').equalTo(orgId);
    var handler = function (snap) {
      cb(snapshotToArray(snap).filter(function (ev) { return estadoEvento(ev) !== 'ELIMINADO'; }));
    };
    ref.on('value', handler);
    return function () { ref.off('value', handler); };
  }

  /* cb(ok) avisa si la escritura fue rechazada (por ejemplo, por las reglas
     de Firebase si la sesión no tiene permiso de admin sobre esa
     organización), para que quien llama no asuma que ya quedó guardado. */
  /* {musicianId: true} de quienes ocupan un puesto de banda. Se guarda en
     cada evento (ev.integrantes) porque las reglas de Firebase no pueden
     recorrer el arreglo banda: con este índice verifican que un usuario
     sin 'eventos.todos' solo edite eventos donde participa. */
  function integrantesEvento(ev) {
    var out = {};
    ((ev && ev.banda) || []).forEach(function (slot) {
      if (slot && slot.musicianId && (slot.nombre || '').trim()) out[slot.musicianId] = true;
    });
    return out;
  }

  function mismosIntegrantes(a, b) {
    var ka = Object.keys(a || {}).sort(), kb = Object.keys(b || {}).sort();
    return ka.join('|') === kb.join('|');
  }

  /* Recalcula ev.integrantes en los eventos donde quedó desactualizado
     (eventos anteriores a este índice, o musicianId repuntados por una
     fusión/sincronización de Personas). Lo corre eventos.html al cargar
     cuando quien entra puede editar todos los eventos. */
  function sincronizarIntegrantes(eventos, cb) {
    var root = dbRoot();
    if (!root) { cb && cb(false, 0); return; }
    var updates = {};
    (eventos || []).forEach(function (ev) {
      var calc = integrantesEvento(ev);
      if (!mismosIntegrantes(calc, ev.integrantes)) {
        updates[EVENTS_PATH + '/' + ev.id + '/integrantes'] = Object.keys(calc).length ? calc : null;
      }
    });
    var n = Object.keys(updates).length;
    if (!n) { cb && cb(true, 0); return; }
    root.update(updates).then(function () { cb && cb(true, n); }, function (err) {
      console.error('Firebase sincronizarIntegrantes rechazado:', err && err.code, err && err.message, err);
      cb && cb(false, 0);
    });
  }

  function saveEvent(evento, orgId, cb) {
    var root = dbRoot();
    if (!root) { cb && cb(false); return; }
    var ev = clone(evento);
    ev.organizationId = orgId || ev.organizationId;
    var integrantes = integrantesEvento(ev);
    if (Object.keys(integrantes).length) ev.integrantes = integrantes; else delete ev.integrantes;
    root.child(EVENTS_PATH).child(ev.id).set(ev).then(function () { cb && cb(true); }, function (err) {
      console.error('Firebase saveEvent rechazado:', err && err.code, err && err.message, err);
      cb && cb(false);
    });
  }

  /* Guardado de quien no tiene 'banda.editar': escribe campo por campo
     (update) sin tocar banda, integrantes, estado, fecha, servicio (tipo
     de evento), organizationId ni id. Las reglas de la base solo le permiten escribir esos otros
     campos (ver events/$eventId/$campo), así que un set() del evento
     completo sería rechazado. `original` es el evento como está en la
     nube: los campos que ya no vienen en `evento` se borran (null). */
  var CAMPOS_EVENTO_PROTEGIDOS = ['id', 'organizationId', 'estado', 'integrantes', 'banda', 'fecha', 'servicio'];

  function saveEventSinBanda(evento, original, cb) {
    var root = dbRoot();
    if (!root || !evento || !evento.id) { cb && cb(false); return; }
    var ev = clone(evento);
    var cambios = {};
    Object.keys(ev).forEach(function (k) {
      if (CAMPOS_EVENTO_PROTEGIDOS.indexOf(k) < 0) cambios[k] = ev[k];
    });
    Object.keys(original || {}).forEach(function (k) {
      if (CAMPOS_EVENTO_PROTEGIDOS.indexOf(k) < 0 && !(k in ev)) cambios[k] = null;
    });
    root.child(EVENTS_PATH).child(ev.id).update(cambios).then(function () { cb && cb(true); }, function (err) {
      console.error('Firebase saveEventSinBanda rechazado:', err && err.code, err && err.message, err);
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

  /* Publica de una sola vez varios eventos (botón "Publicar todos" del
     Dashboard): una única escritura multi-ruta, así o se publican todos o
     ninguno. */
  function publicarEventos(ids, cb) {
    var root = dbRoot();
    if (!root || !ids || !ids.length) { cb && cb(false); return; }
    var patch = {};
    ids.forEach(function (id) { patch[id + '/estado'] = 'PUBLICADO'; });
    root.child(EVENTS_PATH).update(patch).then(function () { cb && cb(true); }, function (err) {
      console.error('Firebase publicarEventos rechazado:', err && err.code, err && err.message, err);
      cb && cb(false);
    });
  }

  /* Cuántas canciones con título tiene listadas un evento (las filas vacías
     de los bloques por defecto no cuentan). */
  function cancionesEvento(ev) {
    var n = 0;
    ((ev && ev.bloques) || []).forEach(function (bl) {
      (bl.canciones || []).forEach(function (c) { if (c && (c.t || '').trim()) n++; });
    });
    return n;
  }

  /* --- Ensayos ---
     Un Ensayo no arma su propia banda ni su lista: se asocia a un evento de
     repertorio (ev.eventoAsociadoId) y hereda de él bloques y banda. Se
     copian (no se resuelven al leer) para que el calendario, el Dashboard,
     los permisos por evento (integrantes) y las declinaciones sigan
     funcionando igual; al guardar el evento de repertorio se vuelven a
     copiar a sus ensayos (sincronizarEnsayos). */
  var SERVICIO_ENSAYO = 'Ensayo';

  function esEnsayo(ev) { return !!ev && ev.servicio === SERVICIO_ENSAYO; }

  /* Eventos a los que puede asociarse un ensayo: de repertorio (no otro
     ensayo), de `desde` en adelante, borradores o publicados. */
  function eventosParaEnsayo(eventos, desde, excluirId, perfil) {
    return (eventos || []).filter(function (e) {
      var est = estadoEvento(e);
      return e && e.id !== excluirId && usaRepertorio(e.servicio, perfil) && !esEnsayo(e) &&
        (e.fecha || '') >= (desde || '') && (est === 'BORRADOR' || est === 'PUBLICADO');
    }).sort(function (a, b) {
      return (a.fecha || '').localeCompare(b.fecha || '') ||
        (parseHora12(a.hora).h * 60 + parseHora12(a.hora).m) - (parseHora12(b.hora).h * 60 + parseHora12(b.hora).m);
    });
  }

  /* Banda del evento de repertorio para su ensayo. Las confirmaciones son
     de cada evento: se conservan las que el ensayo ya tenía en el mismo
     puesto con la misma persona, el resto se descarta. */
  function heredarBanda(bandaPadre, bandaPropia) {
    var propia = bandaPropia || [];
    return clone(bandaPadre || []).map(function (slot) {
      if (!slot) return slot;
      delete slot.estadoConfirmacion;
      delete slot.motivoDeclinacion;
      var igual = propia.find(function (p) {
        return p && p.id === slot.id && (p.nombre || '').trim() === (slot.nombre || '').trim();
      });
      if (igual && igual.estadoConfirmacion) {
        slot.estadoConfirmacion = igual.estadoConfirmacion;
        if (igual.motivoDeclinacion) slot.motivoDeclinacion = igual.motivoDeclinacion;
      }
      return slot;
    });
  }

  /* Copia en `ensayo` (mutándolo) la lista y la banda de `padre`. */
  function heredarDeEvento(ensayo, padre) {
    if (!ensayo || !padre) return ensayo;
    ensayo.eventoAsociadoId = padre.id;
    ensayo.bloques = clone(padre.bloques || []);
    ensayo.banda = heredarBanda(padre.banda, ensayo.banda);
    return ensayo;
  }

  /* Tras guardar un evento de repertorio, vuelve a copiar su lista (y su
     banda, si conBanda: quien no tiene 'banda.editar' no puede escribirla)
     en los ensayos asociados, en una sola escritura multi-ruta. */
  function sincronizarEnsayos(padre, eventos, conBanda, cb) {
    var root = dbRoot();
    if (!root || !padre || !padre.id || esEnsayo(padre)) { cb && cb(true, 0); return; }
    var updates = {};
    var n = 0;
    (eventos || []).forEach(function (ev) {
      if (!ev || ev.id === padre.id || !esEnsayo(ev) || ev.eventoAsociadoId !== padre.id) return;
      var base = EVENTS_PATH + '/' + ev.id + '/';
      updates[base + 'bloques'] = clone(padre.bloques || []);
      if (conBanda) {
        var banda = heredarBanda(padre.banda, ev.banda);
        var integrantes = integrantesEvento({ banda: banda });
        updates[base + 'banda'] = banda;
        updates[base + 'integrantes'] = Object.keys(integrantes).length ? integrantes : null;
      }
      n++;
    });
    if (!n) { cb && cb(true, 0); return; }
    root.update(updates).then(function () { cb && cb(true, n); }, function (err) {
      console.error('Firebase sincronizarEnsayos rechazado:', err && err.code, err && err.message, err);
      cb && cb(false, 0);
    });
  }

  /* --- Versiones de eventos ---
     Un evento PUBLICADO (de cualquier tipo) guarda cada edición como una versión
     numerada en eventVersions/{eventId}/v{n} = { n, organizationId,
     guardadoEn, autorUid, autorNombre, evento }. `evento` es el contenido
     editable del evento: sin id/organizationId/estado/fecha/integrantes/
     version, ni las confirmaciones de asistencia de la banda (eso no es
     parte del contenido; restaurar una versión no mueve ni despublica el
     evento). ev.version guarda el número de la versión vigente. Las
     versiones viven fuera de /events para no engordar lo que carga el
     calendario público. */
  var CAMPOS_NO_VERSIONADOS = ['id', 'organizationId', 'estado', 'fecha', 'integrantes', 'version'];

  function eventoVersionable(ev) {
    return !!ev && estadoEvento(ev) === 'PUBLICADO';
  }

  function contenidoVersion(ev) {
    var c = clone(ev || {});
    CAMPOS_NO_VERSIONADOS.forEach(function (k) { delete c[k]; });
    (c.banda || []).forEach(function (slot) {
      if (!slot) return;
      delete slot.estadoConfirmacion;
      delete slot.motivoDeclinacion;
    });
    return c;
  }

  /* Texto canónico para comparar contenidos: claves ordenadas y sin campos
     vacíos (el asistente completa con '' campos que en la nube no existen). */
  function canonico(x) {
    if (Array.isArray(x)) return '[' + x.map(canonico).join(',') + ']';
    if (x && typeof x === 'object') {
      return '{' + Object.keys(x).sort().filter(function (k) {
        return x[k] !== '' && x[k] !== null && x[k] !== undefined;
      }).map(function (k) { return JSON.stringify(k) + ':' + canonico(x[k]); }).join(',') + '}';
    }
    return JSON.stringify(x);
  }

  function mismoContenidoEvento(a, b) {
    return canonico(contenidoVersion(a)) === canonico(contenidoVersion(b));
  }

  function listaVersiones(map) {
    return Object.keys(map || {}).map(function (k) { return map[k]; })
      .filter(function (v) { return v && v.n; })
      .sort(function (a, b) { return b.n - a.n; });
  }

  /* Qué versiones hay que escribir al guardar `nuevo` sobre `anterior` (el
     evento como está en la nube, o null si es nuevo), dada la lista de
     versiones ya guardadas (más reciente primero). Devuelve
     { version, creada, entradas: [{ n, evento }] } o null si no aplica
     versionar (creada: si `nuevo` estrena un número de versión).
     - Si el resultado no es PUBLICADO, no hay versión.
     - Un evento publicado antes de que existieran las versiones estrena la
       v1 con su contenido previo a esta edición.
     - Si el contenido es igual al de una versión ya guardada (la vigente
       primero), el evento queda en esa versión sin crear otra: así
       regresar a una versión anterior desde el menú no crea copias.
     - Si no, es la versión siguiente a la más alta que exista. */
  function planVersionEvento(anterior, nuevo, versiones) {
    if (!eventoVersionable(nuevo)) return null;
    var lista = (versiones || []).slice();
    var vigente = (anterior && anterior.version) || 0;
    var entradas = [];
    if (!lista.length && !vigente && anterior && eventoVersionable(anterior)) {
      var previa = { n: 1, evento: contenidoVersion(anterior), previa: true };
      entradas.push(previa);
      lista.push(previa);
      vigente = 1;
    }
    lista.sort(function (a, b) { return (b.n === vigente) - (a.n === vigente) || b.n - a.n; });
    var igual = lista.find(function (v) { return mismoContenidoEvento(v.evento, nuevo); });
    if (igual) return { version: igual.n, creada: false, entradas: entradas };
    var n = lista.reduce(function (m, v) { return Math.max(m, v.n); }, vigente);
    entradas.push({ n: n + 1, evento: contenidoVersion(nuevo) });
    return { version: n + 1, creada: true, entradas: entradas };
  }

  function watchEventVersions(eventId, cb) {
    var root = dbRoot();
    if (!root || !eventId) { cb([]); return function () {}; }
    var ref = root.child(EVENT_VERSIONS_PATH).child(eventId);
    var handler = function (snap) { cb(listaVersiones(snap.val())); };
    var fallo = function (err) { console.warn('No se pudieron leer las versiones del evento:', err && err.code); cb([]); };
    ref.on('value', handler, fallo);
    return function () { ref.off('value', handler); };
  }

  /* Escribe las versiones que tocan al guardar `nuevo` (ver
     planVersionEvento) y llama cb(version, creada): el número que debe
     llevar ev.version (creada = es una versión nueva, no un regreso a una
     que ya existía), o el que ya tenía si no se pudo versionar (por ejemplo, si
     las reglas aún no permiten escribir eventVersions): el guardado del
     evento no se bloquea por eso. autor = { uid, nombre }. */
  function versionarEvento(anterior, nuevo, orgId, autor, cb) {
    var root = dbRoot();
    var previa = (anterior && anterior.version) || null;
    if (!root || !nuevo || !nuevo.id || !eventoVersionable(nuevo)) { cb && cb(previa); return; }
    var ref = root.child(EVENT_VERSIONS_PATH).child(nuevo.id);
    ref.once('value').then(function (snap) {
      var plan = planVersionEvento(anterior, nuevo, listaVersiones(snap.val()));
      if (!plan) { cb && cb(previa); return; }
      if (!plan.entradas.length) { cb && cb(plan.version, false); return; }
      var patch = {};
      plan.entradas.forEach(function (e) {
        patch['v' + e.n] = {
          n: e.n,
          organizationId: orgId || nuevo.organizationId || '',
          guardadoEn: e.previa ? null : Date.now(),
          autorUid: e.previa ? null : ((autor && autor.uid) || null),
          autorNombre: e.previa ? null : ((autor && autor.nombre) || null),
          evento: e.evento
        };
      });
      return ref.update(patch).then(function () { cb && cb(plan.version, plan.creada); });
    }).then(null, function (err) {
      console.error('Firebase versionarEvento rechazado:', err && err.code, err && err.message, err);
      cb && cb(previa);
    });
  }

  /* Borrador listo para el asistente a partir de una versión guardada:
     toma su contenido y conserva de `actual` lo que no se versiona (id,
     fecha, estado, organización) y las confirmaciones de asistencia de
     quienes siguen en el mismo puesto. */
  function eventoDesdeVersion(version, actual) {
    var ev = clone((version && version.evento) || {});
    actual = actual || {};
    ev.id = actual.id;
    ev.fecha = actual.fecha;
    ev.estado = actual.estado;
    ev.organizationId = actual.organizationId;
    var previos = actual.banda || [];
    (ev.banda || []).forEach(function (slot) {
      if (!slot || !slot.musicianId) return;
      var igual = previos.find(function (p) { return p && p.musicianId === slot.musicianId && p.tipo === slot.tipo; });
      if (igual && igual.estadoConfirmacion) {
        slot.estadoConfirmacion = igual.estadoConfirmacion;
        if (igual.motivoDeclinacion) slot.motivoDeclinacion = igual.motivoDeclinacion;
      }
    });
    return ev;
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

  /* patch: { titulo, artista, url, cifradoId, archivado }, cualquier subconjunto. No
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
    if (patch.cifradoId !== undefined) safe.cifradoId = patch.cifradoId || null;
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

  /* --- Cifrados (letra + acordes, ver cifrado.js) --- */

  /* Topes de tamaño: los mismos que validan las reglas de la base. */
  var LIMITES_CIFRADO = { lineas: 600, texto: 400, acordesPorLinea: 60, acorde: 20, titulo: 200 };

  /* Enlace de la fuente (opcional): '' si no hay, normalizado si es de
     LaCuerda, tal cual si es otro sitio http(s); null si no es válido. */
  function urlCifrado(url) {
    var C = w.RepertorioCifrado;
    return C ? C.normalizarUrlFuente(url) : null;
  }

  /* Deja solo lo que admite el formato de cifrado.js, recortado a los topes.
     null si el enlace (opcional) no es válido, si falta un tono original
     reconocible o al menos una línea de acordes. No incluye los campos de
     auditoría. */
  function prepararCifrado(data) {
    var C = w.RepertorioCifrado;
    data = data || {};
    var fuenteUrl = urlCifrado(data.fuenteUrl);
    var tono = C ? C.parseTono(data.tonoOriginal) : null;
    if (fuenteUrl === null || !tono || tono.especial) return null;
    var L = LIMITES_CIFRADO;
    var lineas = (Array.isArray(data.lineas) ? data.lineas : []).slice(0, L.lineas).map(function (ln) {
      var x = String((ln && ln.x) || '').slice(0, L.texto);
      if (ln && ln.t === 'a' && Array.isArray(ln.i)) {
        var i = ln.i.filter(function (p) {
          return Array.isArray(p) && typeof p[0] === 'number' && p[0] >= 0 && p[0] < x.length &&
            typeof p[1] === 'string' && p[1].length > 0 && p[1].length <= L.acorde;
        }).slice(0, L.acordesPorLinea).map(function (p) { return [Math.floor(p[0]), p[1]]; });
        if (i.length) return { t: 'a', x: x, i: i };
      }
      return { t: 'l', x: x };
    });
    if (!lineas.some(function (l) { return l.t === 'a'; })) return null;
    return {
      titulo: String(data.titulo || '').trim().slice(0, L.titulo),
      artista: String(data.artista || '').trim().slice(0, L.titulo),
      fuenteUrl: fuenteUrl,
      tonoOriginal: tono.label,
      lineas: lineas
    };
  }

  /* Cifrados ya leídos en esta página: se leen una sola vez (al abrir el
     modal), no se quedan escuchando cambios. */
  var cifradosLeidos = {};

  /* cb(cifrado | null, error). null sin error = no existe. */
  function getCifrado(orgId, id, cb) {
    var k = orgId + '/' + id;
    if (cifradosLeidos[k]) { cb(cifradosLeidos[k], null); return; }
    var root = dbRoot();
    if (!root || !orgId || !id) { cb(null, root ? null : new Error('Firebase no disponible')); return; }
    root.child(CIFRADOS_PATH).child(orgId).child(id).once('value').then(function (snap) {
      var v = snap.val();
      if (v) cifradosLeidos[k] = v;
      cb(v || null, null);
    }, function (err) {
      console.error('Firebase getCifrado rechazado:', err && err.code, err && err.message, err);
      cb(null, err || new Error('Error al leer el cifrado'));
    });
  }

  /* Crea (id vacío) o reemplaza un cifrado. cb(ok, id). Requiere sesión:
     las reglas exigen ser admin o miembro de la organización. */
  function saveCifrado(orgId, id, data, cb) {
    var root = dbRoot();
    var auth = ensureAuthApp();
    var user = auth && auth.currentUser;
    var limpio = prepararCifrado(data);
    if (!root || !orgId || !user || !limpio) { cb && cb(false, null); return; }
    var base = root.child(CIFRADOS_PATH).child(orgId);
    var ref = id ? base.child(id) : base.push();
    var TS = w.firebase.database.ServerValue.TIMESTAMP;
    var payload = clone(limpio);
    /* Sin enlace: se omite (y al reemplazar, se borra el anterior). */
    if (!payload.fuenteUrl) payload.fuenteUrl = null;
    payload.updatedAt = TS;
    payload.updatedBy = user.uid;
    if (!id) { payload.createdAt = TS; payload.createdBy = user.uid; }
    ref.update(payload).then(function () {
      var previo = cifradosLeidos[orgId + '/' + ref.key] || {};
      limpio.createdAt = previo.createdAt || Date.now();
      limpio.createdBy = previo.createdBy || user.uid;
      limpio.updatedAt = Date.now();
      limpio.updatedBy = user.uid;
      cifradosLeidos[orgId + '/' + ref.key] = limpio;
      cb && cb(true, ref.key);
    }, function (err) {
      console.error('Firebase saveCifrado rechazado:', err && err.code, err && err.message, err);
      cb && cb(false, null);
    });
  }

  /* Controlador del modal "Cifrado" (ver/importar), compartido por el paso 4
     de eventos.html y la pestaña Repertorio de admin.html: cada página pone
     el marcado (idéntico) y le pasa aquí cómo leer/escribir su estado y qué
     hacer al guardar. El estado del modal vive en `state.cifrado` de la
     página (null = cerrado).
       host.estado()          → state.cifrado actual
       host.poner(v)          → reemplaza state.cifrado (v o null)
       host.parchar(patch)    → mezcla patch en state.cifrado (si está abierto)
       host.orgId()           → organización activa
       host.puedeEditar()     → si puede importar/reemplazar
       host.alGuardar(id, c, listo) → vincula el cifrado guardado (a la canción
                                del borrador, al catálogo…); listo(aviso)
     abrir(extra, cid) recibe en `extra` lo propio de la página más la canción:
     { t, sm, k } — k null = sin tono configurado (catálogo): se muestra en
     el tono del cifrado sin avisos de tono. */
  function modalCifrado(host) {
    var C = function () { return w.RepertorioCifrado; };
    var elPegado = null, escPuesto = false;

    function segStyle(sg) {
      return sg.acorde ? (sg.desconocido ? 'color:#9a9694;text-decoration:underline dotted' : 'font-weight:800;color:var(--ac-dk)') : '';
    }
    function pintar(lineas) {
      return lineas.map(function (l) { return { segs: l.segs.map(function (sg) { return { txt: sg.txt, style: segStyle(sg) }; }) }; });
    }

    function abrir(extra, cid) {
      elPegado = null;
      host.poner(Object.assign({}, extra, {
        cid: cid || '', modo: cid ? 'ver' : 'importar', cargando: !!cid,
        cifrado: null, url: '', texto: '', pegado: null, tono: '', deteccion: null,
        crudoHtml: '', crudoTexto: '', leidoConHtml: false,
        guardando: false, error: '', aviso: ''
      }));
      if (!cid) return;
      /* Diferido: si ya está en caché, getCifrado responde en el acto, antes
         de que la página haya registrado el modal recién abierto. */
      setTimeout(function () {
        getCifrado(host.orgId(), cid, function (cf, err) {
          var c = host.estado();
          if (!c || c.cid !== cid) return;
          if (err) host.parchar({ cargando: false, error: 'No se pudo leer el cifrado: revisa tu conexión.' });
          else if (!cf) host.parchar({ cargando: false, modo: 'importar', cid: '', aviso: 'El cifrado vinculado ya no existe. Impórtalo de nuevo.' });
          else host.parchar({ cargando: false, cifrado: cf });
        });
      }, 0);
    }

    function cerrar() { host.poner(null); }

    /* Reemplazar conserva el mismo id: se actualiza en todas las canciones
       y eventos que ya lo usan. */
    function reemplazar() {
      var c = host.estado();
      if (!c) return;
      elPegado = null;
      host.parchar({ modo: 'importar', url: c.cifrado ? (c.cifrado.fuenteUrl || '') : '', texto: '', pegado: null, tono: '', deteccion: null,
        crudoHtml: '', crudoTexto: '', leidoConHtml: false, error: '', aviso: '' });
    }

    function cancelar() {
      var c = host.estado();
      if (c && c.cifrado) host.parchar({ modo: 'ver', error: '', aviso: '' });
      else cerrar();
    }

    /* Cómo se lee lo pegado lo decide el enlace: con uno de LaCuerda se usan
       las marcas de acordes de su HTML; sin enlace o de otra fuente se toma
       solo el texto plano y los acordes se detectan en él. Lo pegado se
       guarda tal cual (crudo*) para volver a leerlo si el enlace cambia.
       `url` omitido = el enlace escrito en el modal. */
    function procesarPegado(html, texto, url) {
      var c = host.estado();
      var enlace = url !== undefined ? url : (c ? c.url : '');
      var usarHtml = !!html && !!C().normalizarUrlCifrado(enlace);
      var p = C().parsePegado(usarHtml ? html : '', texto || '');
      var hayAcordes = p.lineas.some(function (l) { return l.t === 'a'; });
      var det = hayAcordes ? C().detectarTono(p.lineas) : null;
      host.parchar({
        crudoHtml: html || '', crudoTexto: texto || '', leidoConHtml: usarHtml,
        /* El textarea muestra la versión en texto; si luego se edita a mano
           se vuelve a leer como texto. */
        texto: p.lineas.map(function (l) { return l.x; }).join('\n'),
        pegado: hayAcordes ? p : null, deteccion: det, tono: det && det.tono ? det.tono : '',
        error: hayAcordes ? '' : 'No se encontraron acordes. Pega o escribe la letra con cada línea de acordes encima de su letra.'
      });
    }

    function cambiarUrl(url) {
      var c = host.estado();
      if (!c) return;
      host.parchar({ url: url });
      if (c.crudoHtml && !!C().normalizarUrlCifrado(url) !== !!c.leidoConHtml) procesarPegado(c.crudoHtml, c.crudoTexto, url);
    }

    function cambiarTexto(v) {
      if (!v.trim()) { host.parchar({ texto: v, crudoHtml: '', crudoTexto: '', pegado: null, deteccion: null, tono: '', error: '' }); return; }
      procesarPegado('', v);
    }

    function guardar() {
      var c = host.estado();
      if (!c || c.guardando || !host.puedeEditar()) return;
      var datos = { titulo: c.t, artista: c.sm, fuenteUrl: c.url, tonoOriginal: c.tono, lineas: c.pegado ? c.pegado.lineas : [] };
      if (!prepararCifrado(datos)) {
        host.parchar({ error: 'Falta algo: el cifrado con acordes y su tono original (y, si pusiste un enlace, que sea válido).' });
        return;
      }
      host.parchar({ guardando: true, error: '' });
      saveCifrado(host.orgId(), c.cid, datos, function (ok, id) {
        if (!ok) { host.parchar({ guardando: false, error: 'No se guardó el cifrado: revisa tu sesión o conexión.' }); return; }
        host.alGuardar(id, c, function (aviso) {
          getCifrado(host.orgId(), id, function (cf) {
            host.parchar({ guardando: false, modo: 'ver', cid: id, cifrado: cf, aviso: aviso || 'Cifrado guardado.' });
          });
        });
      });
    }

    /* Llamar en componentDidUpdate: engancha el pegado al textarea (el motor
       de plantillas no expone onPaste; se vuelve a enganchar si React lo
       recrea) y Esc para cerrar. Del portapapeles se lee el HTML y el texto;
       nunca se inserta en la página. */
    function enganchar() {
      var el = w.document.getElementById('cifrado-pegado');
      if (el && el !== elPegado) {
        elPegado = el;
        el.addEventListener('paste', function (e) {
          var dt = e.clipboardData;
          if (!dt) return;
          var html = dt.getData('text/html') || '';
          var texto = dt.getData('text/plain') || '';
          if (!html && !texto) return;
          e.preventDefault();
          procesarPegado(html, texto);
        });
      }
      if (!escPuesto) {
        escPuesto = true;
        w.document.addEventListener('keydown', function (e) { if (e.key === 'Escape' && host.estado()) cerrar(); });
      }
    }

    /* Campos del modal para renderVals (mismos nombres en ambas páginas). */
    function vals() {
      var c = host.estado();
      var out = {
        cifAbierto: !!c,
        cerrarCifrado: cerrar, reemplazarCifrado: reemplazar, cancelarImportacion: cancelar, guardarCifrado: guardar,
        /* Clic dentro del modal: no debe llegar al fondo (que lo cierra). */
        detenerPropagacion: function (e) { if (e && e.stopPropagation) e.stopPropagation(); },
        cifKicker: '', cifTitulo: '', cifArtista: '',
        cifCargando: false, cifVer: false, cifImportar: false,
        cifHayAviso: false, cifAviso: '', cifHayError: false, cifError: '',
        cifTonoMostrado: '', cifTonoOrigenTxt: '', cifAvisos: [], cifLineas: [], cifFuenteUrl: '#', cifTieneFuente: false, cifFuenteNombre: '',
        cifPuedeEditar: false,
        cifUrl: '', onCifUrl: function () {}, cifUrlInvalida: false, cifUrlValida: false, cifUrlNormalizada: '#', cifBuscarUrl: '#',
        cifTexto: '', onCifTexto: function () {}, cifHayPegado: false, cifResumen: '', cifResumenStyle: '',
        cifTono: '', onCifTono: function () {}, cifTonos: [], cifDeteccion: '', cifPreview: [],
        cifGuardarLabel: 'Guardar cifrado', cifGuardarStyle: ''
      };
      if (!c) return out;
      var puedeEditarlo = host.puedeEditar();
      out.cifPuedeEditar = puedeEditarlo;
      out.cifTitulo = (c.t || '').trim() || 'Canción sin nombre';
      out.cifArtista = (c.sm || '').trim();
      out.cifKicker = c.modo === 'ver' ? 'Cifrado' : (c.cid ? 'Reemplazar cifrado' : 'Agregar cifrado');
      out.cifCargando = c.cargando;
      out.cifHayAviso = !!c.aviso; out.cifAviso = c.aviso;
      out.cifHayError = !!c.error; out.cifError = c.error;

      if (c.modo === 'ver' && c.cifrado && !c.cargando) {
        var sinTono = c.k === null || c.k === undefined;
        var r = C().transponerCifrado(c.cifrado, sinTono ? 'Original' : c.k);
        out.cifVer = true;
        out.cifTonoMostrado = r.tono || '—';
        out.cifTonoOrigenTxt = sinTono ? 'Tono en que está escrito'
          : (r.tonoOriginal ? (r.delta ? 'Transpuesto desde ' + r.tonoOriginal + ' (tono del cifrado)' : 'Tono del cifrado: ' + r.tonoOriginal) : '');
        out.cifAvisos = r.avisos.filter(function (a) { return !(sinTono && a === 'ORIGINAL'); })
          .map(function (a) { return C().mensajeAviso(a, r, c.k); }).filter(Boolean);
        out.cifLineas = pintar(r.lineas);
        out.cifTieneFuente = !!c.cifrado.fuenteUrl;
        out.cifFuenteUrl = c.cifrado.fuenteUrl || '#';
        out.cifFuenteNombre = C().nombreFuente(c.cifrado.fuenteUrl) || 'la fuente';
      }

      if (c.modo === 'importar' && !c.cargando) {
        out.cifImportar = true;
        var urlNorm = urlCifrado(c.url);
        out.cifUrl = c.url;
        out.onCifUrl = function (e) { cambiarUrl(e.target.value); };
        out.cifUrlInvalida = urlNorm === null;
        out.cifUrlValida = !!urlNorm;
        out.cifUrlNormalizada = urlNorm || '#';
        out.cifBuscarUrl = C().urlBusqueda(c.t, c.sm);
        out.cifTexto = c.texto;
        out.onCifTexto = function (e) { cambiarTexto(e.target.value); };
        if (c.pegado) {
          var p = c.pegado;
          var nAcordes = p.lineas.filter(function (l) { return l.t === 'a'; }).length;
          out.cifHayPegado = true;
          out.cifResumen = '✓ ' + nAcordes + (nAcordes === 1 ? ' línea' : ' líneas') + ' con acordes · ' + p.acordes + ' acordes · ' +
            (p.origen === 'html' ? 'leídos con las marcas de LaCuerda.' : 'detectados en el texto: revisa que estén marcados en verde.') +
            (p.desconocidos.length ? ' No reconocidos: ' + p.desconocidos.join(', ').replace(/\.$/, '') + '.' : '');
          out.cifResumenStyle = 'font-size:13px;margin:6px 0 0;color:' + (p.origen === 'html' && !p.desconocidos.length ? 'var(--ac-dk)' : '#8a5a00');
          var lista = C().TONOS_LISTA.slice();
          if (c.tono && lista.indexOf(c.tono) < 0) lista.unshift(c.tono);
          out.cifTonos = [{ valor: '', label: 'Elige…' }].concat(lista.map(function (t) { return { valor: t, label: t }; }));
          out.cifTono = c.tono;
          out.onCifTono = function (e) { host.parchar({ tono: e.target.value }); };
          var det = c.deteccion;
          out.cifDeteccion = det && det.tono
            ? (c.tono === det.tono
              ? 'Detectado automáticamente' + (det.confianza < 0.15 ? ' (verifícalo: podría ser ' + (det.candidatos[1] ? det.candidatos[1].tono : 'otro') + ')' : '')
              : 'Detectado: ' + det.tono)
            : 'No se pudo detectar: elígelo';
          out.cifPreview = pintar(C().transponerCifrado({ tonoOriginal: c.tono, lineas: p.lineas }, 'Original').lineas);
        }
        var listo = puedeEditarlo && urlNorm !== null && !!c.pegado && !!c.tono && !c.guardando;
        out.cifGuardarLabel = c.guardando ? 'Guardando…' : (c.cid ? 'Reemplazar cifrado' : 'Guardar cifrado');
        out.cifGuardarStyle = 'font-size:12px;font-weight:800;letter-spacing:.06em;text-transform:uppercase;padding:8px 14px;border:2px solid var(--ac);' +
          (listo ? 'background:var(--ac);color:#fff;cursor:pointer' : 'background:#fff;color:#9a9694;border-color:#d7d3d3;cursor:not-allowed');
      }
      return out;
    }

    return { abrir: abrir, cerrar: cerrar, vals: vals, enganchar: enganchar, procesarPegado: procesarPegado, cambiarUrl: cambiarUrl };
  }

  /* Cifrado que corresponde a una canción de un evento: el suyo propio
     (`cid`) o, si no tiene, el del catálogo (buildSongCatalog) para esa
     misma canción. '' si no hay. */
  function cifradoIdDeCancion(c, catalogo) {
    if (!c) return '';
    if (c.cid) return c.cid;
    if (!catalogo || !catalogo.length || !(c.t || '').trim()) return '';
    var key = songKey((c.t || '').trim(), (c.sm || '').trim(), (c.u || '').trim());
    for (var n = 0; n < catalogo.length; n++) {
      if (catalogo[n].key === key) return catalogo[n].cifradoId || '';
    }
    return '';
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

  /* Un "conflicto" es un puesto que sigue asignado a alguien que declinó.
     Desaparece solo si la persona cambia a "Sí" o si el admin la quita /
     reemplaza en el puesto (el Formulario reinicia la confirmación al
     cambiar el nombre). Los eventos cancelados o archivados no cuentan. */
  function declinadosEvento(ev) {
    var est = estadoEvento(ev);
    if (est === 'CANCELADO' || est === 'ARCHIVADO') return [];
    return ((ev && ev.banda) || []).filter(function (slot) {
      return slot && (slot.nombre || '').trim() && estadoConfirmacionSlot(slot) === 'rechazado';
    });
  }

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
      email: o.email ? normalizarEmail(o.email) : null,
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
    /* Vincular a una persona de la organización implica tener acceso a ella. */
    updates[USERS_PATH + '/' + targetUid + '/organizationIds/' + orgId] = true;
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
    root.child(MUSICIANS_PATH).child(musicianId).once('value').then(function (snap) {
      var m = snap.val() || {};
      var updates = {};
      updates[MUSICIANS_PATH + '/' + musicianId] = null;
      if (m.email) updates[PERSONAS_EMAIL_PATH + '/' + emailKey(m.email) + '/' + musicianId] = null;
      if (m.userId && m.organizationId) updates[USERS_PATH + '/' + m.userId + '/musicianLinks/' + m.organizationId] = null;
      root.update(updates).then(function () { cb && cb(true); }, function () { cb && cb(false); });
    }, function () { cb && cb(false); });
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
          /* El correo (y la cuenta vinculada) de un perfil fundido pasa al que
             se conserva si este no tenía uno propio; los demás se sueltan del
             índice /personasPorCorreo para no revincular un perfil borrado. */
          var heredado = null;
          snaps.forEach(function (sn) {
            var v = sn.val();
            if (!v) return;
            if (v.email) updates[PERSONAS_EMAIL_PATH + '/' + emailKey(v.email) + '/' + sn.key] = null;
            if (v.userId) updates[USERS_PATH + '/' + v.userId + '/musicianLinks/' + keep.organizationId] = null;
            if (v.email && !keep.email && !heredado) heredado = v;
          });
          if (heredado) {
            updates[MUSICIANS_PATH + '/' + keepId + '/email'] = heredado.email;
            updates[PERSONAS_EMAIL_PATH + '/' + emailKey(heredado.email) + '/' + keepId] = keep.organizationId;
            if (heredado.userId && !keep.userId) {
              updates[MUSICIANS_PATH + '/' + keepId + '/userId'] = heredado.userId;
              updates[USERS_PATH + '/' + heredado.userId + '/musicianLinks/' + keep.organizationId] = keepId;
            }
          }
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
  function setBandaConfirmacion(eventId, slotId, estado, cb, motivo) {
    var root = dbRoot();
    if (!root || !eventId || !slotId) { cb && cb(false); return; }
    root.child(EVENTS_PATH).child(eventId).child('banda').once('value').then(function (snap) {
      var banda = snap.val() || [];
      var idx = -1;
      for (var i = 0; i < banda.length; i++) { if (banda[i] && banda[i].id === slotId) { idx = i; break; } }
      if (idx < 0) { cb && cb(false); return; }
      var patch = {};
      patch['banda/' + idx + '/estadoConfirmacion'] = estado;
      patch['banda/' + idx + '/motivoDeclinacion'] = estado === 'rechazado' ? (motivo || '') : null;
      root.child(EVENTS_PATH).child(eventId).update(patch).then(function () { cb && cb(true); }, function (err) {
        console.error('Firebase setBandaConfirmacion rechazado:', err && err.code, err && err.message, err);
        cb && cb(false);
      });
    }, function () { cb && cb(false); });
  }

  /* "Confirmo asistencia" del Dashboard: además del estado del puesto,
     mantiene sincronizada una fecha no disponible ligada al evento
     (unavailableDates[].eventId). Declinar la crea (o la reemplaza, si ya
     había declinado antes con otro motivo); volver a "Sí" la elimina. Las
     fechas no disponibles agregadas a mano no tienen eventId y no se tocan. */
  function responderAsistencia(ev, slotId, musicianId, estado, motivo, cb) {
    var root = dbRoot();
    if (!root || !ev || !ev.id || !musicianId) { cb && cb(false); return; }
    setBandaConfirmacion(ev.id, slotId, estado, function (ok) {
      if (!ok) { cb && cb(false); return; }
      var ref = root.child(MUSICIANS_PATH).child(musicianId).child('unavailableDates');
      ref.once('value').then(function (snap) {
        var updates = {};
        snapshotToArray(snap).forEach(function (r) { if (r.eventId === ev.id) updates[r.id] = null; });
        if (estado === 'rechazado') {
          var id = uid();
          updates[id] = { id: id, startDate: ev.fecha || '', endDate: ev.fecha || '', reason: motivo || '', eventId: ev.id, createdAt: Date.now() };
        }
        if (!Object.keys(updates).length) { cb && cb(true); return; }
        ref.update(updates).then(function () { cb && cb(true); }, function (err) {
          console.error('Firebase responderAsistencia (fechas no disponibles) rechazado:', err && err.code, err && err.message, err);
          cb && cb(false);
        });
      }, function () { cb && cb(false); });
    }, motivo);
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
    PERFILES_CALENDARIO: PERFILES_CALENDARIO, TIPOS_CALENDARIO: TIPOS_CALENDARIO, TIPO_CALENDARIO_DEFECTO: TIPO_CALENDARIO_DEFECTO,
    tipoCalendarioValido: tipoCalendarioValido, perfilCalendario: perfilCalendario, perfilOrg: perfilOrg,
    TIPOS_EVENTO: TIPOS_EVENTO, tipoEvento: tipoEvento, indiceTipoEvento: indiceTipoEvento,
    MINISTERIOS_DEFECTO: MINISTERIOS_DEFECTO, MINISTERIO_CANTIDAD_MAX: MINISTERIO_CANTIDAD_MAX, normalizarMinisterios: normalizarMinisterios,
    song: song, songLabel: songLabel, songLabelParts: songLabelParts, songKey: songKey, buildSongCatalog: buildSongCatalog,
    youtubeId: youtubeId, youtubeController: youtubeController, formatoTiempo: formatoTiempo, progresoAudio: progresoAudio, youtubeErrorMessage: youtubeErrorMessage,defaultBlocks: defaultBlocks, bloqueParte: bloqueParte, nuevaParte: nuevaParte, newEvento: newEvento, uid: uid,
    BANDA_ROLES: BANDA_ROLES, defaultBanda: defaultBanda, bandaSlot: bandaSlot,
    bandaSlotRol: bandaSlotRol, numeroParaRol: numeroParaRol, rolInicialMinisterio: rolInicialMinisterio,
    bandaLabel: bandaLabel, bandaSiguienteNumero: bandaSiguienteNumero,
    parse: parse, iso: iso, monthKey: monthKey, monthLabel: monthLabel,
    diaNombre: diaNombre, fechaLarga: fechaLarga, semanaDelMes: semanaDelMes,
    hoyKey: hoyKey, calendario: calendario, clone: clone,
    signInWithGoogle: signInWithGoogle, signOutUser: signOutUser, onAuthChange: onAuthChange,
    eventoTitulo: eventoTitulo, eventoDescripcion: eventoDescripcion,
    icsDataHref: icsDataHref, icsFilename: icsFilename, googleCalendarUrl: googleCalendarUrl,
    horaMinutos: horaMinutos, horaPorServicio: horaPorServicio, horaAlCambiarServicio: horaAlCambiarServicio,
    slugify: slugify,
    ESTADOS_EVENTO: ESTADOS_EVENTO, estadoEvento: estadoEvento, esVisiblePublico: esVisiblePublico, estadoInfo: estadoInfo,
    publicarEventos: publicarEventos, cancionesEvento: cancionesEvento,
    SERVICIO_ENSAYO: SERVICIO_ENSAYO, esEnsayo: esEnsayo, eventosParaEnsayo: eventosParaEnsayo,
    heredarDeEvento: heredarDeEvento, sincronizarEnsayos: sincronizarEnsayos,
    eventoVersionable: eventoVersionable, mismoContenidoEvento: mismoContenidoEvento, planVersionEvento: planVersionEvento,
    watchEventVersions: watchEventVersions, versionarEvento: versionarEvento, eventoDesdeVersion: eventoDesdeVersion,
    watchAllOrganizations: watchAllOrganizations, getOrganizationBySlug: getOrganizationBySlug, getOrganization: getOrganization,
    createOrganization: createOrganization, updateOrganization: updateOrganization, deleteOrganization: deleteOrganization,
    countEventsForOrg: countEventsForOrg, countUsersForOrg: countUsersForOrg,
    ensureUserRegistered: ensureUserRegistered, watchUser: watchUser, watchAllUsers: watchAllUsers,
    setUserRole: setUserRole, setUserOrgs: setUserOrgs, setUserTelefono: setUserTelefono, deleteUser: deleteUser, userOrgIds: userOrgIds,
    userMusicianLinks: userMusicianLinks, redirectToUserLanding: redirectToUserLanding, orgInicialDeUsuario: orgInicialDeUsuario,
    guardarOrgPreferida: guardarOrgPreferida, orgPreferida: orgPreferida, borrarOrgPreferida: borrarOrgPreferida,
    normalizarEmail: normalizarEmail, emailKey: emailKey, puede: puede, puedeSobreEvento: puedeSobreEvento, PERMISOS_POR_ROL: PERMISOS_POR_ROL, ROLES: ROLES, rolLabel: rolLabel, PERMISOS_POR_ROL_BANDA: PERMISOS_POR_ROL_BANDA,
    integrantesEvento: integrantesEvento, sincronizarIntegrantes: sincronizarIntegrantes,
    watchAccesosPendientes: watchAccesosPendientes, crearAccesoPendiente: crearAccesoPendiente, borrarAccesoPendiente: borrarAccesoPendiente,
    watchEventsForOrg: watchEventsForOrg, saveEvent: saveEvent, saveEventSinBanda: saveEventSinBanda, setEventEstado: setEventEstado, moveEvent: moveEvent,
    watchSongCatalog: watchSongCatalog, saveSongOverride: saveSongOverride, archiveSong: archiveSong,
    urlCifrado: urlCifrado, prepararCifrado: prepararCifrado, getCifrado: getCifrado, saveCifrado: saveCifrado,
    cifradoIdDeCancion: cifradoIdDeCancion, modalCifrado: modalCifrado,
    ESTADOS_CONFIRMACION: ESTADOS_CONFIRMACION, estadoConfirmacionSlot: estadoConfirmacionSlot, declinadosEvento: declinadosEvento,
    newMusician: newMusician, watchMusiciansForOrg: watchMusiciansForOrg, getMusician: getMusician,
    createMusician: createMusician, updateMusician: updateMusician,
    linkMusicianToUser: linkMusicianToUser, unlinkMusician: unlinkMusician, mergeMusicians: mergeMusicians,
    deleteMusician: deleteMusician,
    matchMusicianByNombre: matchMusicianByNombre,
    previewMusicianMigration: previewMusicianMigration, commitMusicianMigration: commitMusicianMigration,
    migracionMusicosYaCorrio: migracionMusicosYaCorrio,
    updateEventBandaSlots: updateEventBandaSlots,
    setBandaConfirmacion: setBandaConfirmacion, responderAsistencia: responderAsistencia,
    watchUnavailableDates: watchUnavailableDates, addUnavailableDate: addUnavailableDate, deleteUnavailableDate: deleteUnavailableDate,
    fechaNoDisponible: fechaNoDisponible
  };
})(window);
