/* Pruebas de cifrado.js. Sin dependencias: `node --test tests/`.
   El fixture imita el HTML que deja LaCuerda en el portapapeles (acordes
   en <a>, <div></div> vacíos antes de cada línea de acordes), pero con
   letra inventada para no copiar contenido con derechos de autor. */
const test = require('node:test');
const assert = require('node:assert/strict');
const C = require('../cifrado.js');

const HTML_LACUERDA = '<html><body><!--StartFragment--><pre style="font-family:monospace">Nota del autor...\n\nintro:\n\n' +
  '<div></div>(<a>A</a> - <a>D</a> - <a>F#m</a>-<a>E</a>-<a>A</a>) x2\n\n' +
  '<div></div> <a>A</a>               <a>D</a>    <a>A</a>               <a>E</a>\n' +
  ' Linea de prueba numero uno, con fuego\n' +
  '<div></div>    <a>A</a>           <a>F#m</a>  <a>E</a>   <a>D</a>         <a>E</a>     <a>F#m</a>-<a>E</a>-<a>A</a>\n' +
  ' Otra linea de prueba para cantar hoy\n' +
  '<div></div> <a>D</a>  (<a>F#m</a>)   <a>E</a>    <a>A</a> (pausa)\n' +
  ' Coro &amp; final\n' +
  '<div></div> <a>D</a>         <a>E</a>    (<a>F#m</a>-<a>E</a>-<a>A</a>)---&gt; arreglo final\n' +
  ' Fin</pre><!--EndFragment--></body></html>';

function textoPlano(html) {
  return html.replace(/<pre[^>]*>/, '').replace(/<\/pre>[\s\S]*/, '').replace(/^[\s\S]*?(?=Nota)/, '')
    .replace(/<[^>]+>/g, '').replace(/&amp;/g, '&').replace(/&gt;/g, '>');
}

test('acordes mínimos: A → Bb (+1, bemoles)', () => {
  const casos = {
    C: 'Db', Cm: 'Dbm', C7: 'Db7', Cm7: 'Dbm7', Cmaj7: 'Dbmaj7', Csus4: 'Dbsus4',
    Cdim: 'Dbdim', 'C/E': 'Db/F', 'F#': 'G', 'F#m': 'Gm', Bb: 'B', Bbm7: 'Bm7',
    Caug: 'Dbaug', 'C+': 'Db+', 'Am7b5': 'Bbm7b5', 'G7(b9)': 'Ab7(b9)', 'C6/9': 'Db6/9', 'D/F#': 'Eb/G'
  };
  for (const [ent, sal] of Object.entries(casos)) assert.equal(C.transponerAcorde(ent, 1, 'bemol'), sal, ent);
});

test('ejemplo del requerimiento: A D F#m E en A → Bb Eb Gm F', () => {
  const cif = { tonoOriginal: 'A', lineas: [{ t: 'a', x: 'A       D       F#m       E', i: [[0, 'A'], [8, 'D'], [16, 'F#m'], [26, 'E']] }, { t: 'l', x: 'Manda el fuego...' }] };
  const r = C.transponerCifrado(cif, 'Bb');
  assert.equal(r.delta, 1);
  assert.equal(r.tono, 'Bb');
  assert.deepEqual(r.avisos, []);
  assert.equal(C.textoTranspuesto(cif, 'Bb'), 'Bb      Eb      Gm        F\nManda el fuego...');
});

test('las columnas se conservan cuando cambia el largo del acorde', () => {
  const cif = { tonoOriginal: 'A', lineas: [{ t: 'a', x: 'A   E   F#m D', i: [[0, 'A'], [4, 'E'], [8, 'F#m'], [12, 'D']] }] };
  // A→Bb: Bb(+1) Eb... cada acorde debe seguir empezando en 0, 4, 8, 12
  const linea = C.textoTranspuesto(cif, 'Bb');
  assert.equal(linea, 'Bb  F   Gm  Eb');
  // Acordes pegados que crecen: siempre queda al menos un espacio
  const junto = { tonoOriginal: 'C', lineas: [{ t: 'a', x: 'C D E', i: [[0, 'C'], [2, 'D'], [4, 'E']] }] };
  assert.equal(C.textoTranspuesto(junto, 'Db'), 'Db Eb F');
  // Separadores cortos (" - ") no se deforman
  const intro = C.parsePegado('', '(A - D - F#m-E-A) x2');
  assert.equal(C.textoTranspuesto({ tonoOriginal: 'A', lineas: intro.lineas }, 'Bb'), '(Bb - Eb - Gm-F-Bb) x2');
  // Paréntesis opcionales: los acordes siguientes vuelven a su columna
  const par = C.parsePegado('', ' D  (F#m)   E    A');
  assert.equal(C.textoTranspuesto({ tonoOriginal: 'A', lineas: par.lineas }, 'Bb'), ' Eb (Gm)    F    Bb');
});

test('enarmonías: la distancia no depende de cómo se escriba', () => {
  const pares = [['A#', 'Bb'], ['D#', 'Eb'], ['G#', 'Ab'], ['C#', 'Db'], ['F#', 'Gb']];
  for (const [a, b] of pares) {
    assert.equal(C.semitonos(C.parseTono(a), C.parseTono(b)).delta, 0, a + ' vs ' + b);
  }
  assert.equal(C.semitonos(C.parseTono('A#'), C.parseTono('C')).delta, 2);
  assert.equal(C.semitonos(C.parseTono('Bb'), C.parseTono('C')).delta, 2);
  // Misma altura, otra ortografía: el cifrado se reescribe para coincidir con el tono mostrado
  const cif = { tonoOriginal: 'A#', lineas: [{ t: 'a', x: 'A# D#m F', i: [[0, 'A#'], [3, 'D#m'], [7, 'F']] }] };
  assert.equal(C.textoTranspuesto(cif, 'Bb'), 'Bb Ebm F');
});

test('ortografía según la tonalidad destino', () => {
  // Tonos con sostenidos
  assert.equal(C.transponerAcorde('C', 2, C.parseTono('D').pref), 'D');
  assert.equal(C.transponerAcorde('F', 1, C.parseTono('E').pref), 'F#');
  assert.equal(C.transponerAcorde('G', 1, C.parseTono('A').pref), 'G#');
  // Tonos con bemoles (naturales en la letra, pero con armadura de bemoles)
  assert.equal(C.parseTono('F').pref, 'bemol');
  assert.equal(C.parseTono('Dm').pref, 'bemol');
  assert.equal(C.parseTono('Gm').pref, 'bemol');
  assert.equal(C.parseTono('C').pref, 'neutra');
  assert.equal(C.parseTono('Am').pref, 'neutra');
  assert.equal(C.parseTono('Em').pref, 'sostenido');
  assert.equal(C.parseTono('Ebm').pref, 'bemol');
  assert.equal(C.parseTono('C#m').pref, 'sostenido');
});

test('tonos reales de la base de datos', () => {
  const reales = ['C', 'D', 'G', 'A', 'E', 'Am', 'F', 'B', 'Cm', 'Dm', 'F#', 'Bm', 'Em', 'C#m', 'Fm', ' F#', 'Ebm', 'Bb'];
  for (const k of reales) {
    const t = C.parseTono(k);
    assert.ok(t && !t.especial, 'no reconoció ' + JSON.stringify(k));
  }
  assert.deepEqual(C.parseTono('Original'), { especial: 'original' });
  assert.deepEqual(C.parseTono(''), { especial: 'vacio' });
  assert.deepEqual(C.parseTono('—'), { especial: 'vacio' });
  assert.equal(C.parseTono(' F#').label, 'F#');
  assert.equal(C.parseTono('G - A'), null);
  assert.equal(C.parseTono('Capo 2'), null);
  // Solfeo y ♭/♯ también se aceptan como tonalidad
  assert.equal(C.parseTono('Sib').label, 'Bb');
  assert.equal(C.parseTono('Rem').label, 'Dm');
  assert.equal(C.parseTono('B♭').label, 'Bb');
  assert.equal(C.parseTono('La menor').label, 'Am');
});

test('relativas y modos distintos', () => {
  // A mayor y F#m comparten armadura: no se transpone
  const r = C.semitonos(C.parseTono('A'), C.parseTono('F#m'));
  assert.equal(r.delta, 0);
  assert.equal(r.modoDistinto, true);
  const cif = { tonoOriginal: 'A', lineas: [{ t: 'a', x: 'A D', i: [[0, 'A'], [2, 'D']] }] };
  assert.ok(C.transponerCifrado(cif, 'F#m').avisos.includes('MODO_DISTINTO'));
  assert.equal(C.semitonos(C.parseTono('Am'), C.parseTono('Bm')).delta, 2);
});

test('avisos del modal', () => {
  const cif = { tonoOriginal: 'A', lineas: [{ t: 'a', x: 'A N.C. E', i: [[0, 'A'], [2, 'N.C.'], [7, 'E']] }] };
  assert.deepEqual(C.transponerCifrado(cif, 'Original').avisos, ['ORIGINAL', 'ACORDES_DESCONOCIDOS']);
  assert.equal(C.transponerCifrado(cif, 'Original').delta, 0);
  assert.ok(C.transponerCifrado(cif, '').avisos.includes('SIN_TONO'));
  assert.ok(C.transponerCifrado(cif, 'G - A').avisos.includes('TONO_INVALIDO'));
  assert.ok(C.transponerCifrado(cif, 'A').avisos.includes('ACORDES_DESCONOCIDOS'));
  assert.equal(C.transponerCifrado(cif, 'A').delta, 0);
  // Acorde desconocido: se deja tal cual y marcado; los demás sí se transponen
  const segs = C.transponerCifrado(cif, 'B').lineas[0].segs.filter((s) => s.acorde);
  assert.deepEqual(segs.map((s) => [s.txt, s.desconocido]), [['B', false], ['N.C.', true], ['F#', false]]);
  // Sin tono original: se muestra sin transponer
  const sinOrigen = { tonoOriginal: '', lineas: cif.lineas };
  const r = C.transponerCifrado(sinOrigen, 'Bb');
  assert.ok(r.avisos.includes('SIN_TONO_ORIGINAL'));
  assert.equal(r.delta, 0);
});

test('ajuste local ±½ tono', () => {
  const cif = { tonoOriginal: 'A', lineas: [{ t: 'a', x: 'A D E', i: [[0, 'A'], [2, 'D'], [4, 'E']] }] };
  const up = C.transponerCifrado(cif, 'Bb', 1);
  assert.equal(up.tono, 'B');
  assert.equal(C.textoTranspuesto(cif, 'Bb', 1), 'B E F#');
  const down = C.transponerCifrado(cif, 'A', -1);
  assert.equal(down.tono, 'Ab');
  assert.equal(C.textoTranspuesto(cif, 'A', -1), 'Ab Db Eb');
});

test('pegado desde LaCuerda (HTML): acordes marcados, <div> vacíos ignorados', () => {
  const p = C.parsePegado(HTML_LACUERDA, textoPlano(HTML_LACUERDA));
  assert.equal(p.origen, 'html');
  assert.deepEqual(p.desconocidos, []);
  const acordes = p.lineas.filter((l) => l.t === 'a');
  assert.equal(acordes.length, 5);
  // Ningún <div></div> debe generar líneas extra: letra justo debajo de sus acordes
  const idx = p.lineas.findIndex((l) => l.t === 'a' && l.x.startsWith(' A '));
  assert.equal(p.lineas[idx + 1].x, ' Linea de prueba numero uno, con fuego');
  assert.deepEqual(p.lineas[idx].i, [[1, 'A'], [17, 'D'], [22, 'A'], [38, 'E']]);
  // Anotaciones y entidades
  assert.ok(p.lineas.some((l) => l.t === 'a' && l.x.endsWith('(pausa)')));
  assert.ok(p.lineas.some((l) => l.t === 'a' && l.x.includes('---> arreglo final')));
  assert.ok(p.lineas.some((l) => l.t === 'l' && l.x === ' Coro & final'));
  assert.equal(p.lineas[0].x, 'Nota del autor...');
});

test('pegado solo texto: detección heurística de líneas de acordes', () => {
  const p = C.parsePegado('', textoPlano(HTML_LACUERDA));
  assert.equal(p.origen, 'texto');
  const tipos = p.lineas.map((l) => l.t + ':' + l.x.trim().slice(0, 12));
  assert.ok(tipos.includes('a:(A - D - F#m'));
  assert.ok(tipos.includes('a:D  (F#m)   E'), 'línea con (pausa)');
  assert.ok(tipos.includes('a:D         E '), 'línea con ---> arreglo');
  assert.ok(tipos.includes('l:intro:'));
  assert.ok(tipos.includes('l:Linea de pru'));
  // Las mismas posiciones que con HTML
  const h = C.parsePegado(HTML_LACUERDA, '').lineas.filter((l) => l.t === 'a').map((l) => l.i);
  const t = p.lineas.filter((l) => l.t === 'a').map((l) => l.i);
  assert.deepEqual(t, h);
});

test('texto: palabras de la letra no se confunden con acordes', () => {
  const lineas = ['A ti te canto', 'A Dios sea la gloria', 'Mi Dios es fuerte', 'La gloria es tuya', 'E', 'Am  G  F'];
  const p = C.parsePegado('', lineas.join('\n'));
  assert.deepEqual(p.lineas.map((l) => l.t), ['l', 'l', 'l', 'l', 'a', 'a']);
});

test('HTML con líneas de acordes que el autor no marcó', () => {
  // Caso real (LaCuerda, "Nada es imposible"): la intro viene como texto sin <a>
  const html = '<pre>Intro (2 veces): F - C - Dm7 - F\n\n<div></div><a>C</a>            <a>Dm7</a>\nNo voy a vivir por lo que veo\nA ti te canto</pre>';
  const p = C.parsePegado(html, '');
  assert.equal(p.origen, 'html');
  assert.deepEqual(p.lineas.map((l) => l.t), ['a', 'l', 'a', 'l', 'l']);
  assert.deepEqual(p.lineas[0].i, [[17, 'F'], [21, 'C'], [25, 'Dm7'], [31, 'F']]);
  assert.equal(C.textoTranspuesto({ tonoOriginal: 'C', lineas: p.lineas }, 'D').split('\n')[0], 'Intro (2 veces): G - D - Em7 - G');
});

test('HTML de otra fuente con enlaces normales: se lee como texto', () => {
  const html = '<div><a href="/artista">Marcos Witt</a> · <a href="/x">Ver más</a></div><pre>G      C\nTe alabaré\nD      G\nMi Señor</pre>';
  const texto = 'Marcos Witt · Ver más\nG      C\nTe alabaré\nD      G\nMi Señor';
  const p = C.parsePegado(html, texto);
  assert.equal(p.origen, 'texto');
  assert.deepEqual(p.desconocidos, []);
  assert.deepEqual(p.lineas.map((l) => l.t), ['l', 'a', 'l', 'a', 'l']);
  // Sin <pre>: los enlaces sí quedarían marcados como "acordes"; al no serlo, se usa el texto
  const sinPre = '<p><a href="/artista">Marcos Witt</a> · <a href="/x">Ver más</a> · <a>G</a></p><p>G      C<br>Te alabaré</p>';
  const q = C.parsePegado(sinPre, 'Marcos Witt · Ver más · G\nG      C\nTe alabaré');
  assert.equal(q.origen, 'texto');
  assert.deepEqual(q.desconocidos, []);
});

test('pegado seguro: scripts y estilos se descartan, nada se ejecuta', () => {
  const html = '<pre><script>alert(1)</script><style>a{}</style><a>G</a>  <a onclick="x()">C</a>\nhola <img src=x onerror=alert(1)></pre>';
  const p = C.parsePegado(html, '');
  assert.deepEqual(p.lineas, [{ t: 'a', x: 'G  C', i: [[0, 'G'], [3, 'C']] }, { t: 'l', x: 'hola' }]);
});

test('detección de la tonalidad original', () => {
  const p = C.parsePegado(HTML_LACUERDA, '');
  const d = C.detectarTono(p.lineas);
  assert.equal(d.tono, 'A');
  // La relativa menor comparte todos los acordes: siempre es la segunda
  // opción y la confianza es moderada. Por eso el tono lo confirma una persona.
  assert.equal(d.candidatos[1].tono, 'F#m');
  assert.ok(d.confianza > 0.1, 'confianza ' + d.confianza);
  const menor = C.parsePegado('', 'Am  F  G  Am\nx\nAm  Dm  E7  Am');
  assert.equal(C.detectarTono(menor.lineas).tono, 'Am');
  const bemol = C.parsePegado('', 'Bb  Eb  F  Bb\nx\nGm  Eb  F  Bb');
  assert.equal(C.detectarTono(bemol.lineas).tono, 'Bb');
  const g = C.parsePegado('', 'G  C  D  G\nx\nEm  C  D7  G');
  assert.equal(C.detectarTono(g.lineas).tono, 'G');
  assert.equal(C.detectarTono([{ t: 'l', x: 'sin acordes' }]).tono, null);
});

test('mensajes de aviso, lista de tonos y búsqueda', () => {
  const cif = { tonoOriginal: 'A', lineas: [{ t: 'a', x: 'A', i: [[0, 'A']] }] };
  const r = C.transponerCifrado(cif, 'G - A');
  assert.equal(C.mensajeAviso('TONO_INVALIDO', r, 'G - A'), 'El tono "G - A" no se reconoce; se muestra en el tono del cifrado (A).');
  for (const cod of ['ORIGINAL', 'SIN_TONO', 'SIN_TONO_ORIGINAL', 'MODO_DISTINTO', 'ACORDES_DESCONOCIDOS']) assert.ok(C.mensajeAviso(cod, r, ''));
  for (const t of C.TONOS_LISTA) assert.equal(C.parseTono(t).label, t);
  assert.equal(C.urlBusqueda('Manda el fuego', ' Vino Nuevo'), 'https://acordes.lacuerda.net/busca.php?exp=Manda%20el%20fuego%20Vino%20Nuevo');
});

test('URL de LaCuerda: validación y normalización a .shtml', () => {
  const ok = 'https://acordes.lacuerda.net/vino_nuevo/manda_el_fuego.shtml';
  assert.equal(C.normalizarUrlCifrado(ok), ok);
  assert.equal(C.normalizarUrlCifrado('https://acordes.lacuerda.net/vino_nuevo/manda_el_fuego'), ok);
  assert.equal(C.normalizarUrlCifrado(' http://acordes.lacuerda.net/Vino_Nuevo/manda_el_fuego/ '), ok);
  assert.equal(C.normalizarUrlCifrado('https://acordes.lacuerda.net/vino_nuevo/manda_el_fuego-2.shtml'), 'https://acordes.lacuerda.net/vino_nuevo/manda_el_fuego-2.shtml');
  assert.equal(C.normalizarUrlCifrado('https://evil.com/acordes.lacuerda.net/a/b'), null);
  assert.equal(C.normalizarUrlCifrado('https://acordes.lacuerda.net.evil.com/a/b'), null);
  assert.equal(C.normalizarUrlCifrado('javascript:alert(1)'), null);
  assert.equal(C.normalizarUrlCifrado(''), null);
});

test('enlace de fuente opcional: LaCuerda u otro sitio http(s)', () => {
  assert.equal(C.normalizarUrlFuente(''), '');
  assert.equal(C.normalizarUrlFuente('   '), '');
  assert.equal(C.normalizarUrlFuente('https://acordes.lacuerda.net/vino_nuevo/manda_el_fuego'), 'https://acordes.lacuerda.net/vino_nuevo/manda_el_fuego.shtml');
  assert.equal(C.normalizarUrlFuente(' https://www.cifraclub.com/marcos-witt/x/ '), 'https://www.cifraclub.com/marcos-witt/x/');
  assert.equal(C.normalizarUrlFuente('http://example.org/cancion?id=3#a'), 'http://example.org/cancion?id=3#a');
  assert.equal(C.normalizarUrlFuente('javascript:alert(1)'), null);
  assert.equal(C.normalizarUrlFuente('data:text/html,hola'), null);
  assert.equal(C.normalizarUrlFuente('www.cifraclub.com/x'), null);
  assert.equal(C.normalizarUrlFuente('https://a b.com'), null);
  assert.equal(C.nombreFuente('https://acordes.lacuerda.net/a/b.shtml'), 'LaCuerda.net');
  assert.equal(C.nombreFuente('https://www.CifraClub.com/x'), 'cifraclub.com');
  assert.equal(C.nombreFuente(''), '');
});
