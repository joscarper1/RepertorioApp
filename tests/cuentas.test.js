/* Pruebas de agregar correo a un usuario sin correo (repertorio-data.js):
   acceso pendiente con sus datos, detección de la cuenta de Google que lo
   reemplaza y fusión. Firebase falso: solo se anotan las escrituras.
   `node --test tests/cuentas.test.js` */
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const A = require('../avisos.js');

function cargar() {
  const escrituras = [];
  const ref = { update: (u) => { escrituras.push(u); return Promise.resolve(); } };
  const window = {
    RepertorioCifrado: require('../cifrado.js'),
    firebase: { apps: [1], database: () => ({ ref: () => ref }) }
  };
  const ctx = vm.createContext({ window, console, Date, Math, JSON, Promise, Map, encodeURIComponent, setTimeout });
  vm.runInContext(fs.readFileSync(path.join(__dirname, '..', 'repertorio-data.js'), 'utf8'), ctx);
  return { R: window.RepertorioData, escrituras };
}
const hecho = (fn) => new Promise((resolve) => fn(resolve));

const sinCorreo = {
  uid: '-abc', email: '', sinCorreo: true, displayName: 'Yessy', role: 'normal', telefono: '50370002222',
  organizationIds: { o1: true, o2: true }, musicianLinks: { o1: 'm1', o2: 'm2' }
};

test('agregarCorreoAUsuario: acceso pendiente con organizaciones, personas y WhatsApp', async () => {
  const { R, escrituras } = cargar();
  assert.equal(await hecho((cb) => R.agregarCorreoAUsuario(sinCorreo, ' Yessy.Sorto7@gmail.com ', '', 'admin1', cb)), true);
  const u = escrituras[0];
  const acc = u['accesosPorCorreo/yessy,sorto7@gmail,com'];
  assert.equal(acc.email, 'yessy.sorto7@gmail.com');
  assert.equal(acc.reemplazaUid, '-abc');
  assert.equal(acc.telefono, '50370002222');
  assert.deepEqual({ ...acc.organizationIds }, { o1: true, o2: true });
  assert.deepEqual({ ...acc.musicianLinks }, { o1: 'm1', o2: 'm2' });
  assert.equal(u['users/-abc/emailPendiente'], 'yessy.sorto7@gmail.com');
});

test('agregarCorreoAUsuario: cambiar el correo pendiente borra el acceso anterior', async () => {
  const { R, escrituras } = cargar();
  await hecho((cb) => R.agregarCorreoAUsuario(sinCorreo, 'nuevo@x.com', 'viejo@x.com', 'admin1', cb));
  assert.equal(escrituras[0]['accesosPorCorreo/viejo@x,com'], null);
  assert.ok(escrituras[0]['accesosPorCorreo/nuevo@x,com']);
});

test('cuentasReemplazadas y fusión: pasa organizaciones, personas y WhatsApp y borra el registro viejo', async () => {
  const { R, escrituras } = cargar();
  const viejo = Object.assign({}, sinCorreo, { emailPendiente: 'yessy@x.com', organizationIds: { o1: true, o2: true, o3: true }, musicianLinks: { o1: 'm1', o2: 'm2', o3: 'm3' } });
  /* Al iniciar sesión se le aplicó el acceso (o1, o2); o3 se agregó después. */
  const nuevo = { uid: 'g1', email: 'Yessy@x.com', role: 'normal', organizationIds: { o1: true, o2: true }, musicianLinks: { o1: 'm1', o2: 'm2' } };
  const otro = { uid: 'g2', email: 'otro@x.com' };
  assert.equal(R.cuentasReemplazadas([viejo, otro]).length, 0);
  const pares = R.cuentasReemplazadas([viejo, nuevo, otro]);
  assert.equal(pares.length, 1);
  assert.equal(pares[0].nuevo.uid, 'g1');
  assert.equal(await hecho((cb) => R.fusionarCuentasReemplazadas([viejo, nuevo, otro], cb)), 1);
  const u = escrituras[0];
  assert.equal(u['users/-abc'], null);
  assert.equal(u['users/g1/musicianLinks/o3'], 'm3');
  assert.equal(u['users/g1/organizationIds/o3'], true);
  assert.equal(u['musicians/m3/userId'], 'g1');
  assert.equal(u['users/g1/telefono'], '50370002222');
  /* No pisa la persona que la cuenta de Google ya tiene */
  assert.equal(u['users/g1/musicianLinks/o1'], undefined);
});

test('borrarAccesoPendiente con reemplazaUid también quita el correo pendiente', async () => {
  const { R, escrituras } = cargar();
  await hecho((cb) => R.borrarAccesoPendiente('yessy@x,com', cb, '-abc'));
  assert.equal(escrituras[0]['accesosPorCorreo/yessy@x,com'], null);
  assert.equal(escrituras[0]['users/-abc/emailPendiente'], null);
});

test('avisos: el registro sin correo ya reemplazado por su cuenta de Google no recibe aviso doble', () => {
  const org = { id: 'o1', name: 'Templo Betel', slug: 'tb' };
  const ev = { id: 'e1', organizationId: 'o1', fecha: '2026-10-05', servicio: 'Culto', estado: 'PUBLICADO', banda: [{ tipo: 'Corista', musicianId: 'm1', nombre: 'Yessy' }] };
  const viejo = Object.assign({}, sinCorreo, { emailPendiente: 'yessy@x.com' });
  const nuevo = { uid: 'g1', email: 'yessy@x.com', organizationIds: { o1: true }, musicianLinks: { o1: 'm1' } };
  const datos = (usuarios) => ({ org, usuarios, musicos: [{ id: 'm1', nombre: 'Yessy' }], eventos: [ev], hoy: '2026-09-30' });
  /* Antes de iniciar sesión: sigue recibiendo por WhatsApp */
  assert.deepEqual(A.planAvisos({ tipo: 'publicacion', eventIds: ['e1'] }, datos([viejo])).map((f) => f.uid), ['-abc']);
  /* Ya entró con Google: solo la cuenta nueva */
  assert.deepEqual(A.planAvisos({ tipo: 'publicacion', eventIds: ['e1'] }, datos([viejo, nuevo])).map((f) => f.uid), ['g1']);
});

test('unirCuentas: cuenta de Google que entró por su cuenta se une a su usuario de WhatsApp', async () => {
  const { R, escrituras } = cargar();
  /* Entró sola: normal, sin organizaciones; en o2 un admin ya le había vinculado otra persona. */
  const google = { uid: 'g9', email: 'yessy@x.com', role: 'normal', musicianLinks: { o2: 'mX' } };
  assert.equal(await hecho((cb) => R.unirCuentas([{ viejo: sinCorreo, nuevo: google }], cb)), 1);
  const u = escrituras[0];
  assert.equal(u['users/-abc'], null);
  assert.equal(u['users/g9/organizationIds/o1'], true);
  assert.equal(u['users/g9/organizationIds/o2'], true);
  assert.equal(u['users/g9/musicianLinks/o1'], 'm1');
  assert.equal(u['musicians/m1/userId'], 'g9');
  /* o2: se queda con su persona; la del registro viejo queda sin cuenta */
  assert.equal(u['users/g9/musicianLinks/o2'], undefined);
  assert.equal(u['musicians/m2/userId'], null);
  assert.equal(u['users/g9/telefono'], '50370002222');
  assert.equal(await hecho((cb) => R.unirCuentas([{ viejo: google, nuevo: google }], cb)), 0);
});
