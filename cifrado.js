/* Cifrados (letra + acordes) y transposición, sin dependencias.

   Un cifrado se guarda una sola vez por canción, en la tonalidad en que se
   copió (`tonoOriginal`), como una lista de líneas:
     { t: 'a', x: '<texto de la línea>', i: [[col, 'F#m'], ...] }  línea de acordes
     { t: 'l', x: '<texto>' }                                       letra / texto
   `x` conserva la línea tal cual (paréntesis, "x2", "(pausa)", etc.) y `i`
   marca en qué columna empieza cada acorde, para poder reescribirlo en otra
   tonalidad sin mover el resto de la línea.

   Internamente las notas son clases de altura 0..11 (C=0 … B=11): así
   A# y Bb son el mismo número, y la ortografía (sostenidos o bemoles) se
   decide solo al mostrar, según la tonalidad destino.

   Se usa igual desde el navegador (window.RepertorioCifrado) y desde node
   (require('./cifrado.js')) para las pruebas en tests/. */
(function (root) {
  var LETRA_PC = { C: 0, D: 2, E: 4, F: 5, G: 7, A: 9, B: 11 };
  var SOLFEO = { do: 'C', re: 'D', mi: 'E', fa: 'F', sol: 'G', la: 'A', si: 'B' };
  var SOSTENIDOS = ['C', 'C#', 'D', 'D#', 'E', 'F', 'F#', 'G', 'G#', 'A', 'A#', 'B'];
  var BEMOLES = ['C', 'Db', 'D', 'Eb', 'E', 'F', 'Gb', 'G', 'Ab', 'A', 'Bb', 'B'];
  /* C mayor / A menor no tienen alteraciones propias: se usan las formas más
     comunes de los acordes prestados (Bb, Eb, Ab) y de las dominantes
     secundarias (F#, C#). */
  var NEUTRA = ['C', 'C#', 'D', 'Eb', 'E', 'F', 'F#', 'G', 'Ab', 'A', 'Bb', 'B'];
  /* Tónicas mayores (o relativas mayores) que se escriben con bemoles. */
  var MAYORES_BEMOL = { 5: true, 10: true, 3: true, 8: true, 1: true };

  function alteracion(ch) {
    if (ch === '#' || ch === '♯') return 1;
    if (ch === 'b' || ch === '♭') return -1;
    return 0;
  }

  function pcNota(letra, alt) {
    return (LETRA_PC[letra] + alteracion(alt || '') + 12) % 12;
  }

  /* ---------- Acordes ---------- */

  /* Componentes aceptados después de la raíz. La calidad nunca se
     reinterpreta: se copia tal cual al transponer; esta lista solo sirve
     para distinguir un acorde de una palabra cualquiera. */
  var CALIDAD_TOKEN = /^(maj|Maj|MAJ|min|dim|aug|sus|add|no|omit|M|m|°|º|ø|Δ|\+|\(|\)|,|\/(?=[#b♯♭]?\d)|[#b♯♭]?\d{1,2})/;

  function calidadValida(q) {
    var p = 0;
    while (p < q.length) {
      var m = CALIDAD_TOKEN.exec(q.slice(p));
      if (!m) return false;
      p += m[0].length;
    }
    /* Paréntesis balanceados, p. ej. "7(b9)". */
    var abre = (q.match(/\(/g) || []).length;
    var cierra = (q.match(/\)/g) || []).length;
    return abre === cierra;
  }

  /* 'F#m7/C#' → { root: 6, quality: 'm7', bass: 1, raw } ; null si no es acorde. */
  function parseAcorde(txt) {
    var s = (txt || '').trim();
    var m = /^([A-G])([#b♯♭]?)(.*?)(?:\/([A-G])([#b♯♭]?))?$/.exec(s);
    if (!m) return null;
    if (!calidadValida(m[3])) return null;
    return {
      root: pcNota(m[1], m[2]),
      quality: m[3],
      bass: m[4] ? pcNota(m[4], m[5]) : null,
      raw: s
    };
  }

  function esAcorde(txt) { return parseAcorde(txt) !== null; }

  /* 'mayor' | 'menor' | 'dim' | 'aug' | 'neutro' (sus, power chords). */
  function claseAcorde(quality) {
    var q = quality || '';
    if (/^(maj|Maj|MAJ|M)/.test(q)) return 'mayor';
    if (/^(dim|°|º|ø)/.test(q) || /^m7?b5/.test(q)) return 'dim';
    if (/^(min|m)/.test(q)) return 'menor';
    if (/^(aug|\+)/.test(q)) return 'aug';
    if (/^(sus|5$)/.test(q)) return 'neutro';
    return 'mayor';
  }

  function tablaOrtografia(pref) {
    return pref === 'bemol' ? BEMOLES : pref === 'sostenido' ? SOSTENIDOS : NEUTRA;
  }

  /* Ortografía habitual de una tonalidad dada su tónica y modo. */
  function prefParaTonica(tonic, mode) {
    var relMayor = mode === 'menor' ? (tonic + 3) % 12 : tonic;
    return relMayor === 0 ? 'neutra' : (MAYORES_BEMOL[relMayor] ? 'bemol' : 'sostenido');
  }

  /* Transpone un acorde `delta` semitonos. Si no se reconoce se devuelve
     igual (quien llama decide cómo marcarlo). Con delta 0 se respeta la
     escritura original, salvo `reescribir` (p. ej. cifrado en A# mostrado
     en Bb: misma altura, otra ortografía). */
  function transponerAcorde(txt, delta, pref, reescribir) {
    var a = parseAcorde(txt);
    if (!a) return txt;
    var d = ((delta % 12) + 12) % 12;
    if (d === 0 && !reescribir) return a.raw;
    var tabla = tablaOrtografia(pref);
    var out = tabla[(a.root + d) % 12] + a.quality;
    if (a.bass !== null) out += '/' + tabla[(a.bass + d) % 12];
    return out;
  }

  /* ---------- Tonalidades ---------- */

  /* Acepta 'Bb', 'B♭', ' F#', 'F#m', 'Ebm', 'Sib', 'Rem', 'La menor', 'C mayor'.
     Devuelve:
       { especial: 'original' }  → "Original": no transponer
       { especial: 'vacio' }     → sin tono configurado
       { tonic, mode: 'mayor'|'menor', pref: 'sostenido'|'bemol'|'neutra', label }
       null                      → texto no reconocido como tonalidad */
  function parseTono(txt) {
    var s = (txt == null ? '' : String(txt)).trim();
    if (!s || s === '—' || s === '-') return { especial: 'vacio' };
    if (/^(tono\s+)?original$/i.test(s)) return { especial: 'original' };
    var m = /^([A-Ga-g])\s*([#b♯♭]?)\s*(m|min|menor|-|M|maj|mayor)?$/.exec(s);
    var letra, alt, modo;
    if (m) {
      letra = m[1].toUpperCase(); alt = m[2]; modo = m[3];
    } else {
      m = /^(do|re|mi|fa|sol|la|si)\s*([#b♯♭]?)\s*(m|menor|-|M|mayor)?$/i.exec(s);
      if (!m) return null;
      letra = SOLFEO[m[1].toLowerCase()]; alt = m[2]; modo = m[3];
    }
    var menor = !!modo && /^(m|min|menor|-)$/.test(modo);
    var tonic = pcNota(letra, alt);
    var a = alteracion(alt);
    var pref = a === -1 ? 'bemol' : a === 1 ? 'sostenido' : prefParaTonica(tonic, menor ? 'menor' : 'mayor');
    var nombre = letra + (a === 1 ? '#' : a === -1 ? 'b' : '');
    return { tonic: tonic, mode: menor ? 'menor' : 'mayor', pref: pref, label: nombre + (menor ? 'm' : '') };
  }

  /* Semitonos para llevar un cifrado de `origen` a `destino` (ambos ya
     parseados con parseTono). Si los modos difieren se comparan sus
     relativas mayores: A → F#m da 0 (son la misma armadura). */
  function semitonos(origen, destino) {
    var o = origen.mode === 'menor' ? (origen.tonic + 3) % 12 : origen.tonic;
    var d = destino.mode === 'menor' ? (destino.tonic + 3) % 12 : destino.tonic;
    return {
      delta: (d - o + 12) % 12,
      modoDistinto: origen.mode !== destino.mode
    };
  }

  /* ---------- Detección de la tonalidad original ---------- */

  function acordesDe(lineas) {
    var out = [];
    (lineas || []).forEach(function (ln) {
      if (ln.t !== 'a') return;
      (ln.i || []).forEach(function (par) {
        var a = parseAcorde(par[1]);
        if (a) out.push({ a: a, txt: par[1] });
      });
    });
    return out;
  }

  /* Grados diatónicos de una tonalidad mayor: [intervalo, clase esperada]. */
  var DIATONICOS_MAYOR = [[0, 'mayor'], [2, 'menor'], [4, 'menor'], [5, 'mayor'], [7, 'mayor'], [9, 'menor'], [11, 'dim']];
  /* Menor natural + V mayor (armónica), relativo a la tónica menor. */
  var DIATONICOS_MENOR = [[0, 'menor'], [2, 'dim'], [3, 'mayor'], [5, 'menor'], [7, 'menor'], [7, 'mayor'], [8, 'mayor'], [10, 'mayor']];

  function puntaje(acordes, tonic, mode) {
    var grados = mode === 'mayor' ? DIATONICOS_MAYOR : DIATONICOS_MENOR;
    var claseTonica = mode === 'mayor' ? 'mayor' : 'menor';
    var total = 0;
    acordes.forEach(function (x, idx) {
      var iv = (x.a.root - tonic + 12) % 12;
      var cl = claseAcorde(x.a.quality);
      var enEscala = false, exacto = false;
      grados.forEach(function (g) {
        if (g[0] !== iv) return;
        enEscala = true;
        if (g[1] === cl || cl === 'neutro') exacto = true;
      });
      if (exacto) total += 1; else if (enEscala) total += 0.4; else total -= 0.5;
      var esTonica = iv === 0 && (cl === claseTonica || cl === 'neutro');
      if (esTonica) {
        total += 0.5;
        if (idx === 0) total += 2;
        if (idx === acordes.length - 1) total += 3;
      }
      /* Dominante con séptima resolviendo a la tónica. */
      if (iv === 7 && /^7/.test(x.a.quality)) {
        var sig = acordes[idx + 1];
        if (sig && sig.a.root === tonic) total += 1;
      }
    });
    return total;
  }

  /* Nombre de la tónica: primero como aparece escrita en el propio
     cifrado, si no, la forma habitual. */
  function nombreTonica(tonic, mode, acordes) {
    for (var k = 0; k < acordes.length; k++) {
      if (acordes[k].a.root === tonic) return /^[A-G][#b♯♭]?/.exec(acordes[k].txt)[0].replace('♯', '#').replace('♭', 'b');
    }
    return tablaOrtografia(prefParaTonica(tonic, mode))[tonic];
  }

  /* → { tono: 'A', confianza: 0..1, candidatos: [{tono, puntos}] } ;
       tono null si no hay acordes reconocibles. */
  function detectarTono(lineas) {
    var acordes = acordesDe(lineas);
    if (!acordes.length) return { tono: null, confianza: 0, candidatos: [] };
    var cands = [];
    for (var t = 0; t < 12; t++) {
      cands.push({ tonic: t, mode: 'mayor', puntos: puntaje(acordes, t, 'mayor') });
      cands.push({ tonic: t, mode: 'menor', puntos: puntaje(acordes, t, 'menor') });
    }
    cands.sort(function (x, y) { return y.puntos - x.puntos; });
    var mejor = cands[0], segundo = cands[1];
    var confianza = mejor.puntos <= 0 ? 0 : Math.max(0, Math.min(1, (mejor.puntos - segundo.puntos) / mejor.puntos));
    return {
      tono: nombreTonica(mejor.tonic, mejor.mode, acordes) + (mejor.mode === 'menor' ? 'm' : ''),
      confianza: Math.round(confianza * 100) / 100,
      candidatos: cands.slice(0, 3).map(function (c) {
        return { tono: nombreTonica(c.tonic, c.mode, acordes) + (c.mode === 'menor' ? 'm' : ''), puntos: Math.round(c.puntos * 10) / 10 };
      })
    };
  }

  /* ---------- Pegado: HTML o texto plano → líneas ---------- */

  function expandirTabs(linea) {
    if (linea.indexOf('\t') < 0) return linea;
    var out = '';
    for (var k = 0; k < linea.length; k++) {
      if (linea[k] === '\t') { do { out += ' '; } while (out.length % 8); }
      else out += linea[k];
    }
    return out;
  }

  var ENTIDADES = { amp: '&', lt: '<', gt: '>', quot: '"', apos: "'", nbsp: ' ' };
  function decodificar(s) {
    return s.replace(/&(#x[0-9a-f]+|#\d+|[a-z]+);/gi, function (m, e) {
      if (e[0] === '#') {
        var n = e[1] === 'x' || e[1] === 'X' ? parseInt(e.slice(2), 16) : parseInt(e.slice(1), 10);
        return isFinite(n) ? String.fromCharCode(n) : m;
      }
      var v = ENTIDADES[e.toLowerCase()];
      return v === undefined ? m : v;
    }).replace(/ /g, ' ');
  }

  /* Recorre el HTML del portapapeles SIN insertarlo en la página: nunca se
     ejecuta ni se renderiza nada de él, solo se extrae texto. Cada <a>…</a>
     (así marca LaCuerda sus acordes) se toma como acorde. Devuelve
     [{txt, acorde}] en orden, con los saltos de línea como '\n' dentro de txt. */
  function segmentosHtml(html) {
    var src = String(html || '');
    /* Si hay <pre>, solo interesa su contenido (evita títulos, anuncios, etc.). */
    var pres = src.match(/<pre\b[^>]*>[\s\S]*?<\/pre\s*>/gi);
    if (pres) src = pres.join('\n');
    /* Dentro de <pre> los saltos son literales. Fuera, se usan los bloques. */
    var saltosLiterales = !!pres || /[^>\s]\n/.test(src.replace(/<[^>]*>/g, ''));
    var segs = [];
    var enAcorde = false, saltar = null;
    var re = /<!--[\s\S]*?-->|<\/?([a-zA-Z][a-zA-Z0-9]*)\b[^>]*>|[^<]+|</g;
    var m;
    while ((m = re.exec(src))) {
      var tok = m[0];
      if (tok.slice(0, 4) === '<!--') continue;
      var tag = m[1] ? m[1].toLowerCase() : null;
      var cierre = tok[1] === '/';
      if (saltar) { if (tag === saltar && cierre) saltar = null; continue; }
      if (tag) {
        if (!cierre && (tag === 'script' || tag === 'style')) { saltar = tag; continue; }
        if (tag === 'a') { enAcorde = !cierre; continue; }
        if (tag === 'br') { segs.push({ txt: '\n', acorde: false }); continue; }
        if (!saltosLiterales && cierre && /^(div|p|li|tr|h[1-6])$/.test(tag)) segs.push({ txt: '\n', acorde: false });
        continue;
      }
      var txt = decodificar(tok === '<' ? '<' : tok);
      if (!saltosLiterales) txt = txt.replace(/\s*\n\s*/g, ' ');
      if (txt) segs.push({ txt: txt, acorde: enAcorde });
    }
    return segs;
  }

  function lineasDesdeSegmentos(segs) {
    var lineas = [];
    var actual = { x: '', i: [] };
    function cerrar() {
      var x = expandirTabs(actual.x).replace(/\s+$/, '');
      lineas.push(actual.i.length ? { t: 'a', x: x, i: actual.i } : { t: 'l', x: x });
      actual = { x: '', i: [] };
    }
    segs.forEach(function (sg) {
      var partes = sg.txt.replace(/\r\n?/g, '\n').split('\n');
      partes.forEach(function (p, k) {
        if (k > 0) cerrar();
        if (!p) return;
        if (sg.acorde && p.trim()) {
          var lead = p.length - p.replace(/^\s+/, '').length;
          actual.i.push([expandirTabs(actual.x).length + lead, p.trim()]);
        }
        actual.x += p;
      });
    });
    cerrar();
    return lineas;
  }

  /* Texto plano: una línea es de acordes si sus palabras son acordes o
     separadores. Las palabras entre paréntesis ("(pausa)") se toleran como
     anotaciones; fuera de ellos se toleran algunas palabras solo si hay más
     acordes que palabras (p. ej. "D E (F#m-E-A)---> arreglo final"). Así
     "A ti" (1 acorde, 1 palabra) sigue siendo letra. Solo notación
     americana: "La", "Mi", "Si", "Sol" son palabras comunes en la letra. */
  var SEPARADOR = /^([xX]\d+|\d+[xX]|\/\/|\.{2,}|\*+|:)$/;
  function lineaDeTexto(linea) {
    var x = expandirTabs(linea).replace(/\s+$/, '');
    var re = /[^\s\-|()[\]{},>]+/g, m;
    var acordes = [], palabras = 0, prof = 0, ultimo = 0;
    while ((m = re.exec(x))) {
      var antes = x.slice(ultimo, m.index);
      prof += (antes.match(/\(/g) || []).length - (antes.match(/\)/g) || []).length;
      ultimo = m.index;
      var w = m[0];
      if (esAcorde(w)) acordes.push([m.index, w]);
      else if (!SEPARADOR.test(w) && prof <= 0) palabras++;
    }
    var esLineaAcordes = acordes.length > 0 && (palabras === 0 || (acordes.length >= 2 && palabras < acordes.length));
    return esLineaAcordes ? { t: 'a', x: x, i: acordes } : { t: 'l', x: x };
  }

  function recortarVacias(lineas) {
    while (lineas.length && lineas[0].t === 'l' && !lineas[0].x.trim()) lineas.shift();
    while (lineas.length && lineas[lineas.length - 1].t === 'l' && !lineas[lineas.length - 1].x.trim()) lineas.pop();
    return lineas;
  }

  /* Punto de entrada del pegado. Prefiere el HTML (acordes marcados
     explícitamente por LaCuerda); si no trae ningún <a>, usa el texto.
     → { lineas, origen: 'html'|'texto', acordes: n, desconocidos: ['N.C.', …] } */
  function parsePegado(html, texto) {
    var lineas = null, origen = 'texto';
    if (html && /<a\b/i.test(html)) {
      lineas = lineasDesdeSegmentos(segmentosHtml(html));
      if (lineas.some(function (l) { return l.t === 'a'; })) origen = 'html';
      else lineas = null;
    }
    if (!lineas) {
      var fuente = texto;
      if (!fuente && html) fuente = segmentosHtml(html).map(function (s) { return s.txt; }).join('');
      lineas = String(fuente || '').replace(/\r\n?/g, '\n').split('\n').map(lineaDeTexto);
    }
    recortarVacias(lineas);
    var n = 0, desconocidos = [];
    lineas.forEach(function (l) {
      (l.i || []).forEach(function (par) {
        n++;
        if (!esAcorde(par[1]) && desconocidos.indexOf(par[1]) < 0) desconocidos.push(par[1]);
      });
    });
    return { lineas: lineas, origen: origen, acordes: n, desconocidos: desconocidos };
  }

  /* ---------- Render transpuesto ---------- */

  /* Reescribe una línea de acordes. Cada acorde conserva su columna: si el
     nuevo es más largo se "cobra" de los espacios que siguen (dejando al
     menos uno entre acordes); si es más corto se rellena con espacios, para
     que los siguientes sigan alineados con la letra de abajo.
     → [{txt, acorde: bool, desconocido: bool}] */
  function segmentosLinea(ln, delta, pref, reescribir) {
    var x = ln.x || '';
    var pares = (ln.i || []).slice().sort(function (p, q) { return p[0] - q[0]; });
    var segs = [];
    var pos = 0, deuda = 0;
    function texto(t) { if (t) segs.push({ txt: t, acorde: false, desconocido: false }); }
    /* Solo se ajustan espacios de alineación: el hueco completo si es puro
       espacio, o un tramo de 2+ espacios (primero el que precede al
       siguiente acorde). Separadores cortos como " - " no se tocan y la
       diferencia se arrastra al siguiente hueco. */
    function hueco(gap) {
      if (!deuda || !gap) return gap;
      var ini, fin;
      if (/^ +$/.test(gap)) { ini = 0; fin = gap.length; }
      else {
        var tr = / {2,}$/.exec(gap), ld = /^ {2,}/.exec(gap);
        if (tr) { ini = tr.index; fin = gap.length; }
        else if (ld) { ini = 0; fin = ld[0].length; }
        else return gap;
      }
      var largo = fin - ini;
      if (deuda > 0) {
        var quita = Math.min(deuda, largo - 1);
        if (quita <= 0) return gap;
        deuda -= quita;
        return gap.slice(0, ini) + gap.slice(ini + quita);
      }
      var pon = -deuda;
      deuda = 0;
      return gap.slice(0, ini) + new Array(pon + 1).join(' ') + gap.slice(ini);
    }
    pares.forEach(function (par) {
      var col = par[0], orig = par[1];
      if (col < pos || x.substr(col, orig.length) !== orig) return;
      texto(hueco(x.slice(pos, col)));
      var ok = esAcorde(orig);
      var nuevo = ok ? transponerAcorde(orig, delta, pref, reescribir) : orig;
      segs.push({ txt: nuevo, acorde: true, desconocido: !ok });
      deuda += nuevo.length - orig.length;
      pos = col + orig.length;
    });
    var resto = x.slice(pos);
    if (resto) texto(hueco(resto).replace(/\s+$/, ''));
    return segs;
  }

  /* Lo que el modal necesita para mostrar un cifrado guardado en la
     tonalidad `tonoDestinoTxt` (el campo `k` de la canción).
     `ajuste` suma semitonos extra (botones ±½, solo locales).
     → { lineas: [{t, segs}], tono, tonoOriginal, delta, avisos: [códigos] }
     Avisos: ORIGINAL, SIN_TONO, TONO_INVALIDO, SIN_TONO_ORIGINAL,
             MODO_DISTINTO, ACORDES_DESCONOCIDOS. */
  function transponerCifrado(cifrado, tonoDestinoTxt, ajuste) {
    var avisos = [];
    var lineas = (cifrado && cifrado.lineas) || [];
    var origen = parseTono(cifrado && cifrado.tonoOriginal);
    if (!origen || origen.especial) origen = null;
    var destino = parseTono(tonoDestinoTxt);
    var delta = 0, pref = origen ? origen.pref : 'neutra', tono = origen ? origen.label : null;
    var reescribir = false;

    if (!origen) avisos.push('SIN_TONO_ORIGINAL');
    if (destino && destino.especial === 'original') avisos.push('ORIGINAL');
    else if (destino && destino.especial === 'vacio') avisos.push('SIN_TONO');
    else if (!destino) avisos.push('TONO_INVALIDO');
    else if (origen) {
      var st = semitonos(origen, destino);
      delta = st.delta;
      pref = destino.pref;
      tono = destino.label;
      reescribir = pref !== origen.pref;
      if (st.modoDistinto) avisos.push('MODO_DISTINTO');
    }

    /* Botones ±½ del modal: se suman sobre lo anterior y la tonalidad
       mostrada toma la ortografía habitual de la nueva tónica. */
    var extra = parseInt(ajuste, 10) || 0;
    if (extra && origen) {
      delta = (((delta + extra) % 12) + 12) % 12;
      var modo = destino && !destino.especial ? destino.mode : origen.mode;
      var tonicNuevo = modo === origen.mode ? (origen.tonic + delta) % 12
        : modo === 'menor' ? (origen.tonic + delta + 9) % 12 : (origen.tonic + delta + 3) % 12;
      pref = prefParaTonica(tonicNuevo, modo);
      tono = tablaOrtografia(pref)[tonicNuevo] + (modo === 'menor' ? 'm' : '');
      reescribir = true;
    }

    var hayDesconocidos = false;
    var out = lineas.map(function (ln) {
      if (ln.t !== 'a') return { t: 'l', segs: [{ txt: ln.x || '', acorde: false, desconocido: false }] };
      var segs = segmentosLinea(ln, delta, pref, reescribir);
      if (segs.some(function (s) { return s.desconocido; })) hayDesconocidos = true;
      return { t: 'a', segs: segs };
    });
    if (hayDesconocidos) avisos.push('ACORDES_DESCONOCIDOS');
    return { lineas: out, tono: tono, tonoOriginal: origen ? origen.label : null, delta: delta, avisos: avisos };
  }

  /* Texto plano ya transpuesto (útil para pruebas y para copiar). */
  function textoTranspuesto(cifrado, tonoDestinoTxt, ajuste) {
    return transponerCifrado(cifrado, tonoDestinoTxt, ajuste).lineas.map(function (l) {
      return l.segs.map(function (s) { return s.txt; }).join('');
    }).join('\n');
  }

  /* ---------- URL de la fuente ---------- */

  /* Solo páginas de canción de acordes.lacuerda.net. Devuelve la URL
     normalizada a la versión completa (.shtml) o null si no es válida. */
  function normalizarUrlCifrado(url) {
    var s = (url || '').trim();
    var m = /^https?:\/\/acordes\.lacuerda\.net\/([a-z0-9_]+)\/([a-z0-9_]+?)(-\d+)?(\.shtml)?\/?(?:[?#].*)?$/i.exec(s);
    if (!m) return null;
    return 'https://acordes.lacuerda.net/' + m[1].toLowerCase() + '/' + m[2].toLowerCase() + (m[3] || '') + '.shtml';
  }

  var api = {
    parseAcorde: parseAcorde, esAcorde: esAcorde, claseAcorde: claseAcorde, transponerAcorde: transponerAcorde,
    parseTono: parseTono, semitonos: semitonos, detectarTono: detectarTono,
    parsePegado: parsePegado, transponerCifrado: transponerCifrado, textoTranspuesto: textoTranspuesto,
    normalizarUrlCifrado: normalizarUrlCifrado
  };
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  else root.RepertorioCifrado = api;
})(typeof window !== 'undefined' ? window : this);
