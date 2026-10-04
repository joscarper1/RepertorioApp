/* Pruebas de los avisos de programación (avisos.js) y del procesamiento de
   la cola del workflow (.github/avisos/enviar.js). Sin Firebase real: la
   cola corre contra una base falsa en memoria y el "envío" solo se anota.
   `node --test tests/avisos.test.js` */
const test = require('node:test');
const assert = require('node:assert/strict');
const A = require('../avisos.js');
const { procesarCola, procesarNuevos, procesarBitacora } = require('../.github/avisos/enviar.js');

const org = { id: 'o1', name: 'Templo Betel', slug: 'templobetel' };
const slot = (tipo, musicianId, nombre) => ({ tipo, musicianId, nombre: nombre === undefined ? 'X' : nombre });
const ev = (id, fecha, servicio, banda, extra) => Object.assign({ id, fecha, hora: '8:00 am', servicio, organizationId: 'o1', estado: 'PUBLICADO', banda }, extra || {});

const eventos = [
  ev('e1', '2026-10-05', 'Cultos Dominicales', [slot('Corista', 'ana'), slot('Piano', 'beto')]),
  ev('e2', '2026-10-08', 'Ensayo', [slot('Corista', 'ana')], { hora: '7:00 pm' }),
  ev('e3', '2026-10-01', 'Culto Familiar', [slot('Corista', 'ana')], { estado: 'BORRADOR' }),
  ev('e4', '2026-09-20', 'Cultos Dominicales', [slot('Corista', 'ana')]),
  ev('e5', '2026-11-02', 'Vigilia General', [slot('Director de Alabanza', 'ana'), slot('Corista', 'ana')]),
  ev('e6', '2026-10-05', 'Culto Familiar', [slot('Bajo', 'ana')], { hora: '6:30 pm', estado: undefined })
];
const usuarios = [
  { uid: 'u-ana', email: 'ana@x.com', telefono: '50370001111', organizationIds: { o1: true }, musicianLinks: { o1: 'ana' } },
  { uid: 'u-beto', email: '', organizationIds: { o1: true }, musicianLinks: { o1: 'beto' } },
  { uid: 'u-sin', email: 'sin@x.com', organizationIds: { o1: true } },
  { uid: 'u-otra', email: 'otra@x.com', organizationIds: { o2: true }, musicianLinks: { o2: 'ana' } }
];
const musicos = [{ id: 'ana', nombre: 'Ana María López' }, { id: 'beto', nombre: 'Beto Ruiz' }];
const datos = { org, usuarios, musicos, eventos, hoy: '2026-09-28' };

test('diaCorto y minutosHora', () => {
  assert.equal(A.diaCorto('2026-10-05'), 'Lun 5 oct');
  assert.equal(A.diaCorto('2026-10-04'), 'Dom 4 oct');
  assert.equal(A.minutosHora('6:30 pm'), 1110);
  assert.equal(A.minutosHora('12:00 pm'), 720);
  assert.equal(A.minutosHora('12:00 am'), 0);
});

test('eventosDePersona: solo publicados (o sin estado), de hoy en adelante, ordenados', () => {
  const ids = A.eventosDePersona(eventos, 'ana', '2026-09-28').map((e) => e.id);
  assert.deepEqual(ids, ['e1', 'e6', 'e2', 'e5']);
});

test('armarAviso: saludo, viñetas con puestos y enlace al mes del último evento', () => {
  const a = A.armarAviso(org, 'Ana María López', 'ana', A.eventosDePersona(eventos, 'ana', '2026-09-28'));
  assert.equal(a.saludo, 'Hola Ana, ¡Dios te bendiga!\n\nTienes participación en los siguientes eventos de Templo Betel:');
  assert.deepEqual(a.lineas, [
    'Lun 5 oct – Cultos Dominicales (Corista)',
    'Lun 5 oct – Culto Familiar (Bajo)',
    'Jue 8 oct – Ensayo (Corista)',
    'Lun 2 nov – Vigilia General (Director de Alabanza, Corista)'
  ]);
  assert.equal(a.url, 'https://joscarper1.github.io/RepertorioApp/index.html?group=templobetel&month=2026-11');
  assert.ok(a.texto.startsWith(a.saludo + '\n\n• Lun 5 oct'));
  assert.equal(a.urlConfirmar, 'https://joscarper1.github.io/RepertorioApp/dashboard.html?org=templobetel');
  assert.ok(a.texto.endsWith('Confirma tu participación aquí: ' + a.urlConfirmar + '\n\nVer calendario: ' + a.url));
  assert.ok(a.html.indexOf('Confirma tu participación aquí: <a href="' + a.urlConfirmar + '">') < a.html.indexOf('Ver calendario'));
  assert.equal(a.asunto, 'Tus próximos eventos – Templo Betel');
  assert.equal(A.armarAviso(org, 'Ana', 'ana', []), null);
});

test('armarAviso escapa HTML en el correo', () => {
  const a = A.armarAviso({ name: 'A<b>', slug: 's' }, 'Ana', 'ana', [ev('x', '2026-10-05', '<script>', [slot('Piano', 'ana')])]);
  assert.ok(a.html.indexOf('<script>') < 0);
  assert.ok(a.html.indexOf('&lt;script&gt;') >= 0);
});

test('planAvisos publicación: solo cuentas con persona vinculada que participan en lo publicado', () => {
  const filas = A.planAvisos({ tipo: 'publicacion', eventIds: { e1: true } }, datos);
  assert.deepEqual(filas.map((f) => f.uid), ['u-ana', 'u-beto']);
  const ana = filas.find((f) => f.uid === 'u-ana');
  assert.equal(ana.nombre, 'Ana María López');
  assert.equal(ana.aviso.lineas.length, 4);
  /* Un borrador en el pedido no avisa a nadie */
  assert.deepEqual(A.planAvisos({ tipo: 'publicacion', eventIds: ['e3'] }, datos), []);
  /* Beto no participa en e2 */
  assert.deepEqual(A.planAvisos({ tipo: 'publicacion', eventIds: ['e2'] }, datos).map((f) => f.uid), ['u-ana']);
});

test('planAvisos reenvío: una sola cuenta; sin persona vinculada no hay fila', () => {
  assert.deepEqual(A.planAvisos({ tipo: 'reenvio', uid: 'u-ana' }, datos).map((f) => f.uid), ['u-ana']);
  assert.deepEqual(A.planAvisos({ tipo: 'reenvio', uid: 'u-sin' }, datos), []);
  /* Persona vinculada en otra organización no cuenta */
  assert.deepEqual(A.planAvisos({ tipo: 'reenvio', uid: 'u-otra' }, datos), []);
});

test('cuenta en dos organizaciones: un aviso por organización, cada uno solo con sus eventos', () => {
  const org2 = { id: 'o2', name: 'Filial Los Chorros', slug: 'loschorros' };
  const yes = { uid: 'u-yes', email: 'yes@x.com', telefono: '50370002222', organizationIds: { o1: true, o2: true }, musicianLinks: { o1: 'yes1', o2: 'yes2' } };
  const ev1 = ev('y1', '2026-10-05', 'Culto o1', [slot('Corista', 'yes1')]);
  const ev2 = ev('y2', '2026-10-06', 'Culto o2', [slot('Piano', 'yes2')], { organizationId: 'o2' });
  const base = { usuarios: [yes], hoy: '2026-09-28' };
  /* Aunque llegaran eventos de la otra organización, no se mezclan. */
  const d1 = Object.assign({ org, musicos: [{ id: 'yes1', nombre: 'Yessy Sorto' }], eventos: [ev1, ev2] }, base);
  const d2 = Object.assign({ org: org2, musicos: [{ id: 'yes2', nombre: 'Yessy Sorto' }], eventos: [ev1, ev2] }, base);
  const [f1] = A.planAvisos({ tipo: 'reenvio', uid: 'u-yes' }, d1);
  const [f2] = A.planAvisos({ tipo: 'reenvio', uid: 'u-yes' }, d2);
  assert.deepEqual(f1.aviso.lineas, ['Lun 5 oct – Culto o1 (Corista)']);
  assert.deepEqual(f2.aviso.lineas, ['Mar 6 oct – Culto o2 (Piano)']);
  assert.equal(f1.aviso.asunto, 'Tus próximos eventos – Templo Betel');
  assert.equal(f2.aviso.asunto, 'Tus próximos eventos – Filial Los Chorros');
  assert.ok(f2.aviso.url.indexOf('group=loschorros') >= 0);
  /* Publicar en o2 no avisa por la persona de o1, y viceversa. */
  assert.deepEqual(A.planAvisos({ tipo: 'publicacion', eventIds: ['y1'] }, d2), []);
  /* Si se le quita la organización, deja de recibir sus avisos aunque quede el vínculo. */
  const sinO2 = Object.assign({}, d2, { usuarios: [Object.assign({}, yes, { organizationIds: { o1: true } })] });
  assert.deepEqual(A.planAvisos({ tipo: 'reenvio', uid: 'u-yes' }, sinO2), []);
});

test('teléfonos y WhatsApp', () => {
  assert.equal(A.normalizarTelefono('7000-1111'), '50370001111');
  assert.equal(A.normalizarTelefono('+503 7000 1111'), '50370001111');
  assert.equal(A.normalizarTelefono('+1 (415) 555-0100'), '14155550100');
  assert.equal(A.normalizarTelefono(''), '');
  assert.equal(A.telefonoValido('50370001111'), true);
  assert.equal(A.telefonoValido('7000'), false);
  assert.equal(A.formatoTelefono('50370001111'), '+503 7000-1111');
  assert.equal(A.urlWhatsApp('50370001111', 'Hola • Ana'), 'https://wa.me/50370001111?text=Hola%20%E2%80%A2%20Ana');
});

test('diasParaVencer', () => {
  assert.equal(A.diasParaVencer('2026-10-12', '2026-09-28'), 14);
  assert.equal(A.diasParaVencer('2026-09-20', '2026-09-28'), -8);
  assert.equal(A.diasParaVencer('', '2026-09-28'), null);
});

/* --- Base falsa mínima con la API de firebase-admin que usa enviar.js --- */
function baseFalsa(inicial) {
  const data = JSON.parse(JSON.stringify(inicial));
  const get = (p) => p.reduce((o, k) => (o == null ? undefined : o[k]), data);
  const set = (p, v) => {
    let o = data;
    p.slice(0, -1).forEach((k) => { if (o[k] == null) o[k] = {}; o = o[k]; });
    if (v === null || v === undefined) delete o[p[p.length - 1]]; else o[p[p.length - 1]] = JSON.parse(JSON.stringify(v));
  };
  const snap = (v, key) => ({
    key, val: () => (v === undefined ? null : JSON.parse(JSON.stringify(v))),
    forEach: (fn) => Object.keys(v || {}).forEach((k) => fn(snap(v[k], k)))
  });
  const ref = (p) => ({
    child: (k) => ref(p.concat(String(k).split('/'))),
    orderByChild: (campo) => ({
      equalTo: (val) => ({
        once: async () => {
          const v = get(p) || {};
          const f = {};
          Object.keys(v).forEach((k) => { if (v[k] && v[k][campo] === val) f[k] = v[k]; });
          return snap(f, p[p.length - 1]);
        }
      })
    }),
    once: async () => snap(get(p), p[p.length - 1]),
    update: async (patch) => { Object.keys(patch).forEach((k) => set(p.concat(k.split('/')), patch[k])); },
    set: async (v) => set(p, v),
    remove: async () => set(p, null),
    push: async (v) => { const k = 'k' + Math.random().toString(36).slice(2); set(p.concat(k), v); return ref(p.concat(k)); },
    transaction: async (fn) => {
      const r = fn(get(p) === undefined ? null : JSON.parse(JSON.stringify(get(p))));
      if (r === undefined) return { committed: false, snapshot: snap(get(p)) };
      set(p, r);
      return { committed: true, snapshot: snap(get(p)) };
    }
  });
  return { root: ref([]), data };
}

function baseDePrueba(cola) {
  const users = {};
  usuarios.forEach((u) => { const c = Object.assign({}, u); delete c.uid; users[u.uid] = c; });
  const events = {};
  eventos.forEach((e) => { events[e.id] = e; });
  const musicians = {};
  musicos.forEach((m) => { musicians[m.id] = Object.assign({ organizationId: 'o1' }, m); });
  return baseFalsa({ organizations: { o1: { name: org.name, slug: org.slug } }, users, events, musicians, colaAvisos: cola });
}

test('procesarCola: envía, marca resultados y no repite pedidos ya enviados', async () => {
  const ahora = Date.now();
  const { root, data } = baseDePrueba({
    p1: { orgId: 'o1', tipo: 'publicacion', eventIds: { e1: true }, estado: 'pendiente', creado: ahora },
    p2: { orgId: 'o1', tipo: 'reenvio', uid: 'u-ana', estado: 'enviado', creado: ahora },
    viejo: { orgId: 'o1', tipo: 'reenvio', uid: 'u-ana', estado: 'enviado', creado: ahora - 100 * 24 * 3600 * 1000 }
  });
  const enviados = [];
  const r = await procesarCola(root, async (m) => { enviados.push(m); }, { ahora });
  assert.equal(r.pedidos, 1);
  assert.equal(enviados.length, 1);
  assert.equal(enviados[0].para, 'ana@x.com');
  assert.equal(enviados[0].remitente, 'Templo Betel');
  assert.ok(enviados[0].texto.indexOf('Hola Ana') === 0);
  const p1 = data.colaAvisos.p1;
  assert.equal(p1.estado, 'enviado');
  assert.equal(p1.enviados, 1);
  assert.equal(p1.sinCorreo, 1);
  assert.deepEqual(p1.resultados, { 'u-ana': 'enviado', 'u-beto': 'sin_correo' });
  assert.equal(data.colaAvisos.viejo, undefined, 'los pedidos viejos se borran');
  /* Segunda corrida: nada pendiente */
  const r2 = await procesarCola(root, async (m) => { enviados.push(m); }, { ahora });
  assert.equal(r2.pedidos, 0);
  assert.equal(enviados.length, 1);
});

test('procesarCola: error de envío queda registrado y el pedido inválido no rompe la cola', async () => {
  const ahora = Date.now();
  const { root, data } = baseDePrueba({
    p1: { orgId: 'o1', tipo: 'reenvio', uid: 'u-ana', estado: 'pendiente', creado: ahora },
    p2: { orgId: 'o1', tipo: 'otro', estado: 'pendiente', creado: ahora },
    p3: { orgId: 'o1', tipo: 'reenvio', uid: 'u-ana', estado: 'procesando', tomado: ahora - 60 * 60 * 1000, creado: ahora }
  });
  let intentos = 0;
  const r = await procesarCola(root, async () => { intentos++; throw Object.assign(new Error('x'), { responseCode: 550 }); }, { ahora });
  assert.equal(r.pedidos, 3, 'incluye el procesando abandonado');
  assert.equal(intentos, 2);
  assert.equal(data.colaAvisos.p1.estado, 'error');
  assert.deepEqual(data.colaAvisos.p1.resultados, { 'u-ana': 'error' });
  assert.equal(data.colaAvisos.p2.estado, 'error');
  assert.equal(data.colaAvisos.p2.fallo, 'pedido-invalido');
  assert.equal(data.colaAvisos.p3.estado, 'error');
});

test('procesarCola en modo prueba no envía ni toca la cola', async () => {
  const ahora = Date.now();
  const { root, data } = baseDePrueba({ p1: { orgId: 'o1', tipo: 'reenvio', uid: 'u-ana', estado: 'pendiente', creado: ahora } });
  let llamadas = 0;
  const r = await procesarCola(root, async () => { llamadas++; }, { ahora, prueba: true });
  assert.equal(llamadas, 0);
  assert.equal(r.enviados, 1);
  assert.equal(data.colaAvisos.p1.estado, 'pendiente');
});

test('procesarCola: Gmail rechaza credenciales (535) → no insiste y deja el motivo', async () => {
  const ahora = Date.now();
  const { root, data } = baseDePrueba({
    p1: { orgId: 'o1', tipo: 'publicacion', eventIds: { e1: true }, estado: 'pendiente', creado: ahora },
    p2: { orgId: 'o1', tipo: 'reenvio', uid: 'u-ana', estado: 'pendiente', creado: ahora }
  });
  let intentos = 0;
  await procesarCola(root, async () => { intentos++; throw Object.assign(new Error('auth'), { responseCode: 535, code: 'EAUTH' }); }, { ahora });
  assert.equal(intentos, 1, 'tras el 535 no se intenta con los demás');
  assert.equal(data.colaAvisos.p1.fallo, 'gmail-credenciales');
  assert.equal(data.colaAvisos.p2.fallo, 'gmail-credenciales');
  assert.equal(data.colaAvisos.p2.estado, 'error');
  assert.ok(A.textoFallo('gmail-credenciales').indexOf('GMAIL_APP_PASSWORD') >= 0);
});

/* --- Aviso a administradores de un usuario nuevo --- */
function baseNuevos(extra) {
  const ahora = Date.now();
  const users = {
    nuevo: { email: 'nuevo@x.com', displayName: 'Nuevo Pérez', role: 'normal', nuevo: true, createdAt: ahora - 3600 * 1000, organizationIds: { o1: true } },
    viejo: { email: 'viejo@x.com', role: 'normal', nuevo: true, createdAt: ahora - 30 * 24 * 3600 * 1000, organizationIds: { o1: true } },
    adminSi: { email: 'admin1@x.com', role: 'admin', organizationIds: { o1: true }, avisos: { nuevosUsuarios: true } },
    adminNo: { email: 'admin2@x.com', role: 'admin', organizationIds: { o1: true } },
    adminOtra: { email: 'admin3@x.com', role: 'admin', organizationIds: { o2: true }, avisos: { nuevosUsuarios: true } },
    editorSi: { email: 'ed@x.com', role: 'editor', organizationIds: { o1: true }, avisos: { nuevosUsuarios: true } }
  };
  Object.assign(users, extra || {});
  return Object.assign(baseFalsa({ organizations: { o1: { name: org.name, slug: org.slug } }, users, colaAvisos: {} }), { ahora });
}

test('nuevosPorAvisar y adminsParaNuevos: solo nuevos recientes y admins suscritos de esa organización', () => {
  const ahora = Date.now();
  const us = [
    { uid: 'n1', nuevo: true, createdAt: ahora, organizationIds: { o1: true } },
    { uid: 'n2', nuevo: true, createdAt: ahora - 8 * 24 * 3600 * 1000, organizationIds: { o1: true } },
    { uid: 'n3', nuevo: true, createdAt: ahora, organizationIds: { o1: true }, avisoNuevo: { tomado: ahora, enviado: ahora } },
    { uid: 'n4', nuevo: true, createdAt: ahora, organizationIds: {} },
    { uid: 'n5', nuevo: true, createdAt: ahora, organizationIds: { o1: true }, avisoNuevo: { tomado: ahora - 3600 * 1000 } },
    { uid: 'a1', role: 'admin', email: 'a@x.com', organizationIds: { o1: true }, avisos: { nuevosUsuarios: true } },
    { uid: 'a2', role: 'admin', email: '', organizationIds: { o1: true }, avisos: { nuevosUsuarios: true } }
  ];
  assert.deepEqual(A.nuevosPorAvisar(us, ahora).map((u) => u.uid), ['n1', 'n5']);
  assert.deepEqual(A.adminsParaNuevos(us, 'o1', 'n1').map((u) => u.uid), ['a1']);
  assert.deepEqual(A.adminsParaNuevos(us, 'o1', 'a1'), []);
});

test('armarAvisoNuevoUsuario: nombre, correo, organización y enlace a Usuarios', () => {
  const a = A.armarAvisoNuevoUsuario(org, { displayName: 'Ana <b>', email: 'ana@x.com' });
  assert.equal(a.asunto, 'Nuevo usuario en Templo Betel: Ana <b>');
  assert.match(a.texto, /Ana <b> \(ana@x\.com\) inició sesión desde el calendario y se unió a Templo Betel\./);
  assert.match(a.texto, /admin\.html\?tab=usuarios&org=o1/);
  assert.match(a.html, /Ana &lt;b&gt;/);
});

test('procesarNuevos: avisa solo a admins suscritos, una sola vez, y queda en el historial', async () => {
  const { root, data, ahora } = baseNuevos();
  const enviados = [];
  const r = await procesarNuevos(root, async (m) => { enviados.push(m); }, { ahora });
  assert.equal(r.nuevos, 1);
  assert.deepEqual(enviados.map((m) => m.para), ['admin1@x.com']);
  assert.equal(enviados[0].remitente, 'Templo Betel');
  assert.ok(data.users.nuevo.avisoNuevo.enviado);
  assert.equal(data.users.viejo.avisoNuevo, undefined);
  const hist = Object.values(data.colaAvisos);
  assert.equal(hist.length, 1);
  assert.equal(hist[0].tipo, 'nuevoUsuario');
  assert.equal(hist[0].uid, 'nuevo');
  assert.equal(hist[0].estado, 'enviado');
  const r2 = await procesarNuevos(root, async (m) => { enviados.push(m); }, { ahora: ahora + 1000 });
  assert.equal(r2.nuevos, 0);
  assert.equal(enviados.length, 1);
});

test('procesarNuevos: sin admin suscrito no envía pero no vuelve a intentarlo; si todo falla, se reintenta', async () => {
  const sin = baseNuevos({ adminSi: { email: 'admin1@x.com', role: 'admin', organizationIds: { o1: true } } });
  const r = await procesarNuevos(sin.root, async () => { throw new Error('no debería'); }, { ahora: sin.ahora });
  assert.equal(r.sinDestinatarios, 1);
  assert.ok(sin.data.users.nuevo.avisoNuevo);
  const falla = baseNuevos();
  const r2 = await procesarNuevos(falla.root, async () => { throw Object.assign(new Error('x'), { responseCode: 550 }); }, { ahora: falla.ahora });
  assert.equal(r2.errores, 1);
  assert.equal(falla.data.users.nuevo.avisoNuevo, undefined);
});

/* --- Bitácora de cambios y repertorio actualizado --- */
const cancion = (t, sm, k) => ({ t, sm: sm || '', k: k || '' });
const conCanciones = (lista) => ({ bloques: [{ titulo: 'Alabanza', canciones: lista }] });

test('cambioRepertorio: solo si antes había más de una canción y la lista cambió', () => {
  const dos = conCanciones([cancion('Cuán grande es Él', 'Ana', 'G'), cancion('Santo', '', 'D')]);
  assert.equal(A.cambioRepertorio(conCanciones([cancion('Una')]), conCanciones([cancion('Otra')])), null);
  assert.equal(A.cambioRepertorio(dos, JSON.parse(JSON.stringify(dos))), null);
  const r = A.cambioRepertorio(dos, conCanciones([cancion('Cuán grande es Él', 'Ana', 'G'), cancion('Digno', '', 'E')]));
  assert.deepEqual(r.agregadas, ['Digno (E)']);
  assert.deepEqual(r.quitadas, ['Santo (D)']);
  assert.deepEqual(r.ahora, ['Cuán grande es Él – Ana (G)', 'Digno (E)']);
  const orden = A.cambioRepertorio(dos, conCanciones([cancion('Santo', '', 'D'), cancion('Cuán grande es Él', 'Ana', 'G')]));
  assert.deepEqual([orden.agregadas, orden.quitadas], [[], []]);
});

test('entradaBitacora y armarAvisoBitacora: autor, fecha, evento, acción y versión', () => {
  const antes = ev('e1', '2026-10-05', 'Cultos Dominicales', [], { version: 3 });
  const e = A.entradaBitacora('movido', antes, Object.assign({}, antes, { fecha: '2026-10-12' }));
  assert.equal(e.fechaAnterior, '2026-10-05');
  assert.equal(e.version, 3);
  Object.assign(e, { autorUid: 'u-ana', creado: Date.UTC(2026, 9, 4, 21, 15) });
  assert.ok(A.entradaValida(e));
  const a = A.armarAvisoBitacora(org, [e], { 'u-ana': 'Ana <b>' });
  assert.match(a.asunto, /^Movido: Lun 12 oct – Cultos Dominicales – Templo Betel$/);
  assert.match(a.texto, /Movido del Lun 5 oct al Lun 12 oct/);
  assert.match(a.texto, /Por: Ana <b> · .*2026.*3:15/);
  assert.match(a.texto, /Versión: v3/);
  assert.match(a.html, /Ana &lt;b&gt;/);
  const borrador = A.entradaBitacora('modificado', Object.assign({}, antes, { estado: 'BORRADOR', version: undefined }), Object.assign({}, antes, { version: undefined }));
  assert.match(A.armarAvisoBitacora(org, [Object.assign(borrador, { autorUid: 'x' })], {}).texto, /estado: Borrador → Publicado[\s\S]*Versión: —/);
});

function baseBitacora(extra) {
  const ahora = Date.UTC(2026, 9, 4, 20, 0);
  const users = Object.assign({
    ana: { email: 'ana@x.com', displayName: 'Ana', role: 'editor', organizationIds: { o1: true } },
    adminBit: { email: 'bit@x.com', role: 'admin', organizationIds: { o1: true }, avisos: { bitacoraEventos: true } },
    adminRep: { email: 'rep@x.com', role: 'admin', organizationIds: { o1: true }, avisos: { repertorioActualizado: true } },
    adminNada: { email: 'nada@x.com', role: 'admin', organizationIds: { o1: true } },
    adminOtra: { email: 'otra@x.com', role: 'admin', organizationIds: { o2: true }, avisos: { bitacoraEventos: true, repertorioActualizado: true } }
  }, extra || {});
  const events = { e1: ev('e1', '2026-10-12', 'Cultos Dominicales', []), e9: Object.assign(ev('e9', '2026-10-12', 'X', []), { organizationId: 'o2' }) };
  const base = (accion, more) => Object.assign({ orgId: 'o1', eventId: 'e1', accion, eventoNombre: 'Cultos Dominicales', eventoFecha: '2026-10-12', autorUid: 'ana', creado: ahora - 1000, estado: 'pendiente' }, more || {});
  const bitacoraEventos = {
    b1: base('movido', { fechaAnterior: '2026-10-05', version: 2 }),
    b2: base('modificado', { version: 3, repertorio: { ahora: ['Santo (D)'], agregadas: ['Santo (D)'], quitadas: ['Digno'] } }),
    b3: base('cancelado', { eventId: 'e9' }),
    b4: base('archivado', { estado: 'enviado', creado: ahora - 100 * 24 * 3600 * 1000 })
  };
  return Object.assign(baseFalsa({ organizations: { o1: { name: org.name, slug: org.slug } }, users, events, bitacoraEventos, colaAvisos: {} }), { ahora });
}

test('procesarBitacora: un correo de bitácora por admin suscrito y uno de repertorio; valida evento y limpia viejos', async () => {
  const { root, data, ahora } = baseBitacora();
  const enviados = [];
  const r = await procesarBitacora(root, async (m) => { enviados.push(m); }, { ahora });
  assert.equal(r.cambios, 2);
  assert.equal(r.invalidos, 1);
  const bit = enviados.filter((m) => m.para === 'bit@x.com');
  assert.equal(bit.length, 1);
  assert.match(bit[0].asunto, /Bitácora de cambios \(2\)/);
  assert.match(bit[0].texto, /Por: Ana/);
  const rep = enviados.filter((m) => m.para === 'rep@x.com');
  assert.equal(rep.length, 1);
  assert.match(rep[0].asunto, /^Repertorio actualizado: Cultos Dominicales/);
  assert.match(rep[0].texto, /Agregadas:\n• Santo \(D\)[\s\S]*Quitadas:\n• Digno/);
  assert.equal(enviados.length, 2);
  assert.equal(data.bitacoraEventos.b1.estado, 'enviado');
  assert.equal(data.bitacoraEventos.b3.estado, 'invalido');
  assert.equal(data.bitacoraEventos.b4, undefined);
  const hist = Object.values(data.colaAvisos);
  assert.equal(hist.length, 1);
  assert.equal(hist[0].tipo, 'bitacora');
  assert.equal(hist[0].cambios, 2);
  const r2 = await procesarBitacora(root, async (m) => { enviados.push(m); }, { ahora: ahora + 1000 });
  assert.equal(r2.cambios, 0);
  assert.equal(enviados.length, 2);
});

test('procesarBitacora: sin admins suscritos (interruptores apagados) no envía nada', async () => {
  const { root, data, ahora } = baseBitacora({ adminBit: { email: 'bit@x.com', role: 'admin', organizationIds: { o1: true } }, adminRep: null });
  const r = await procesarBitacora(root, async () => { throw new Error('no debería'); }, { ahora });
  assert.equal(r.enviados, 0);
  assert.equal(data.bitacoraEventos.b1.estado, 'sin-destinatarios');
  assert.deepEqual(data.colaAvisos, {});
});
