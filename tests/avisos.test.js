/* Pruebas de los avisos de programación (avisos.js) y del procesamiento de
   la cola del workflow (.github/avisos/enviar.js). Sin Firebase real: la
   cola corre contra una base falsa en memoria y el "envío" solo se anota.
   `node --test tests/avisos.test.js` */
const test = require('node:test');
const assert = require('node:assert/strict');
const A = require('../avisos.js');
const { procesarCola } = require('../.github/avisos/enviar.js');

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
  assert.equal(a.saludo, 'Hola Ana, tienes participación en los siguientes eventos de Templo Betel:');
  assert.deepEqual(a.lineas, [
    'Lun 5 oct – Cultos Dominicales (Corista)',
    'Lun 5 oct – Culto Familiar (Bajo)',
    'Jue 8 oct – Ensayo (Corista)',
    'Lun 2 nov – Vigilia General (Director de Alabanza, Corista)'
  ]);
  assert.equal(a.url, 'https://joscarper1.github.io/RepertorioApp/index.html?group=templobetel&month=2026-11');
  assert.ok(a.texto.startsWith(a.saludo + '\n\n• Lun 5 oct'));
  assert.ok(a.texto.endsWith('Ver calendario: ' + a.url));
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
