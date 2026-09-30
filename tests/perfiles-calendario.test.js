/* Pruebas de los perfiles de calendario (repertorio-data.js,
   PERFILES_CALENDARIO / perfilOrg). Sin Firebase: solo funciones puras.
   `node --test tests/perfiles-calendario.test.js` */
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

function cargar() {
  const window = { RepertorioCifrado: require('../cifrado.js') };
  const ctx = vm.createContext({ window, console, Date, Math, JSON, Promise, Map, encodeURIComponent, setTimeout, URLSearchParams });
  vm.runInContext(fs.readFileSync(path.join(__dirname, '..', 'repertorio-data.js'), 'utf8'), ctx);
  vm.runInContext(fs.readFileSync(path.join(__dirname, '..', 'menu-config.js'), 'utf8'), ctx);
  return window;
}
const w = cargar();
const R = w.RepertorioData;
const rep = R.perfilCalendario('repertorio');
const srv = R.perfilCalendario('servicio');
const tipos = (banda) => Array.from(banda, (b) => b.tipo);

test('una organización sin tipoCalendario (o con uno desconocido) es de repertorio', () => {
  assert.equal(R.perfilOrg({ id: 'o1' }), rep);
  assert.equal(R.perfilOrg(null), rep);
  assert.equal(R.perfilOrg({ tipoCalendario: 'otro' }), rep);
  assert.equal(R.perfilOrg({ tipoCalendario: 'servicio' }), srv);
  assert.equal(R.tipoCalendarioValido('x'), 'repertorio');
  assert.deepEqual(Array.from(R.TIPOS_CALENDARIO, (t) => t.id), ['repertorio', 'servicio']);
});

test('el perfil de repertorio usa exactamente los catálogos de siempre', () => {
  assert.deepEqual(rep.servicios, R.SERVICIOS);
  assert.deepEqual(rep.ordenRoles(), R.BANDA_ROLES.map((r) => r.tipo));
  assert.equal(rep.permisosPorPuesto, R.PERMISOS_POR_ROL_BANDA);
  R.SERVICIOS.forEach((sv) => {
    assert.equal(rep.usaBanda(sv), R.SERVICIOS_CON_REPERTORIO.indexOf(sv) >= 0, sv);
    assert.equal(rep.usaCanciones(sv), R.SERVICIOS_CON_REPERTORIO.indexOf(sv) >= 0, sv);
    assert.equal(R.usaRepertorio(sv), R.usaRepertorio(sv, rep), sv);
  });
  assert.equal(rep.ensayos, true);
  assert.equal(rep.muestraModulo('repertorio'), true);
});

test('sin perfil, las funciones se comportan como el perfil de repertorio', () => {
  const a = R.newEvento({ fecha: '2026-10-04' });
  const b = R.newEvento({ fecha: '2026-10-04' }, rep);
  assert.equal(a.servicio, 'Cultos Dominicales');
  assert.equal(a.servicio, b.servicio);
  assert.equal(a.hora, b.hora);
  assert.deepEqual(tipos(a.banda), tipos(b.banda));
  assert.equal(a.bloques.length, b.bloques.length);
  assert.equal(R.horaPorServicio('Culto Familiar', rep), '6:30 pm');
  assert.equal(R.horaAlCambiarServicio('8:00 am', 'Culto Familiar', rep), '6:30 pm');
});

test('tipos de evento: un solo catálogo, cada tipo en uno o varios calendarios', () => {
  assert.deepEqual(Array.from(rep.servicios), ['Cultos Dominicales', 'Culto Familiar', 'Vigilia General', 'Vigilia Juvenil',
    'Evento Especial', 'Ensayo', 'Capacitación', 'Convocatoria', 'Otro']);
  assert.deepEqual(Array.from(srv.servicios), ['Cultos Dominicales', 'Culto Familiar', 'Vigilia General', 'Vigilia Juvenil',
    'Evento Especial', 'Capacitación', 'Convocatoria', 'Otro', 'Culto Filial', 'Vigilia Filial']);
  /* Los filiales solo en servicio; Ensayo solo en repertorio */
  assert.equal(rep.servicios.indexOf('Culto Filial'), -1);
  assert.equal(srv.servicios.indexOf('Ensayo'), -1);
  assert.equal(R.horaPorServicio('Culto Filial', srv), '7:00 pm');
  assert.equal(R.horaPorServicio('Vigilia Filial', srv), '7:00 pm');
  assert.equal(R.horaPorServicio('Cultos Dominicales', srv), '8:00 am');
  assert.equal(R.horaAlCambiarServicio('8:00 am', 'Culto Filial', srv), '7:00 pm');
  /* Color fijo: la posición de los tipos existentes no cambia */
  R.SERVICIOS.forEach((t, i) => assert.equal(R.indiceTipoEvento(t), i, t));
  assert.equal(R.indiceTipoEvento('Culto Filial'), R.SERVICIOS.length);
  assert.equal(R.indiceTipoEvento('Inventado'), -1);
});

test('servicio ministerial: servidores sin canciones, sin Ensayo ni Repertorio', () => {
  ['Cultos Dominicales', 'Culto Filial', 'Vigilia Filial', 'Evento Especial'].forEach((t) => {
    assert.equal(srv.usaBanda(t), true, t);
    assert.equal(srv.usaCanciones(t), false, t);
  });
  assert.equal(srv.usaBanda('Capacitación'), false);
  assert.equal(R.usaRepertorio('Cultos Dominicales', srv), false);
  assert.equal(srv.tieneCanciones, false);
  assert.equal(srv.ensayos, false);
  assert.equal(srv.muestraModulo('repertorio'), false);
  assert.equal(srv.muestraModulo('eventos'), true);
});

test('servicio ministerial: un evento nuevo arranca con un puesto por ministerio y sin bloques', () => {
  const ev = R.newEvento({ fecha: '2026-10-04' }, srv);
  assert.equal(ev.servicio, 'Cultos Dominicales');
  assert.equal(ev.hora, '8:00 am');
  assert.equal(ev.bloques.length, 0);
  assert.deepEqual(tipos(ev.banda), ['Protocolo', 'Alabanza', 'Ofrenda', 'Limpieza', 'Oración', 'Infantil']);
  assert.ok(ev.banda.filter((b) => b.tipo !== 'Alabanza').every((b) => b.numero === null && !b.rol));
  /* Alabanza: una sola persona por defecto, como Director de Alabanza 1 */
  const dir = ev.banda.find((b) => b.tipo === 'Alabanza');
  assert.equal(dir.rol, 'Director de Alabanza');
  assert.equal(dir.numero, 1);
  assert.equal(R.bandaLabel(dir), 'Director de Alabanza 1');
  /* Alabanza convoca con los roles de la banda */
  const alabanza = srv.roles.find((r) => r.tipo === 'Alabanza');
  assert.equal(alabanza.rolesBanda, true);
  assert.deepEqual(Array.from(alabanza.subroles), Array.from(R.BANDA_ROLES, (r) => r.tipo));
  /* Lo que ya trae el evento se respeta */
  const viejo = R.newEvento({ servicio: 'Culto Filial', banda: [{ tipo: 'Protocolo', numero: 1, nombre: 'Ana' }] }, srv);
  assert.equal(viejo.banda.length, 1);
  assert.equal(viejo.hora, '7:00 pm');
});

test('ministerios configurables por organización', () => {
  const org = { id: 'f1', tipoCalendario: 'servicio', ministerios: [
    { tipo: ' Ujieres ', cantidad: 3 }, { tipo: 'ujieres', cantidad: 1 }, { tipo: '', cantidad: 2 },
    { tipo: 'Alabanza', cantidad: 0, rolesBanda: true }, { tipo: 'Sonido', cantidad: 99 }
  ] };
  const pf = R.perfilOrg(org);
  assert.deepEqual(Array.from(pf.ordenRoles()), ['Ujieres', 'Alabanza', 'Sonido']);
  assert.deepEqual(Array.from(pf.roles, (r) => r.cantidad), [3, 1, R.MINISTERIO_CANTIDAD_MAX]);
  assert.equal(pf.roles[1].rolesBanda, true);
  assert.equal(R.perfilOrg(org), pf, 'se reutiliza mientras la lista no cambie');
  assert.notEqual(R.perfilOrg(Object.assign({}, org, { ministerios: [{ tipo: 'Otro', cantidad: 1 }] })), pf);
  assert.equal(R.newEvento({}, pf).banda.filter((b) => b.tipo === 'Ujieres').length, 3);
  /* Lista vacía → los de por defecto; en repertorio se ignoran */
  assert.deepEqual(Array.from(R.perfilOrg({ id: 'f2', tipoCalendario: 'servicio', ministerios: [] }).ordenRoles()), Array.from(R.MINISTERIOS_DEFECTO, (m) => m.tipo));
  assert.equal(R.perfilOrg({ id: 'r1', ministerios: [{ tipo: 'X', cantidad: 1 }] }), rep);
});

test('serviciosCon ofrece primero un tipo que el perfil no tiene (dato viejo)', () => {
  assert.deepEqual(Array.from(srv.serviciosCon('Ensayo').slice(0, 2)), ['Ensayo', 'Cultos Dominicales']);
  assert.deepEqual(Array.from(srv.serviciosCon('Culto Filial')), Array.from(srv.servicios));
  assert.deepEqual(Array.from(srv.serviciosCon('')), Array.from(srv.servicios));
});

test('permisos por puesto vienen del perfil', () => {
  const usuario = { role: 'normal', musicianLinks: { o1: 'd' } };
  const ev = { id: 'e1', organizationId: 'o1', banda: [{ tipo: 'Director de Alabanza', musicianId: 'd', nombre: 'D' }] };
  assert.equal(R.puedeSobreEvento(usuario, 'eventos.editar', ev), true);
  assert.equal(R.puedeSobreEvento(usuario, 'eventos.editar', ev, rep), true);
  /* En servicio ministerial ningún puesto da permisos (por ahora). */
  assert.equal(R.puedeSobreEvento(usuario, 'eventos.editar', ev, srv), false);
  assert.equal(R.puedeSobreEvento({ role: 'admin' }, 'eventos.editar', ev, srv), true);
});

test('descripción de calendario externo: servicio lista servidores, nunca canciones', () => {
  const ev = {
    servicio: 'Culto Filial', tema: 'Fe',
    banda: [{ tipo: 'Limpieza', numero: 1, nombre: 'Luis' }, { tipo: 'Protocolo', numero: 1, nombre: 'Ana' }],
    bloques: [{ titulo: 'Júbilo', canciones: [{ t: 'Canción' }] }]
  };
  const txt = R.eventoDescripcion(ev, srv);
  assert.match(txt, /^Servidores:\nProtocolo: Ana\nLimpieza: Luis/);
  assert.doesNotMatch(txt, /Canciones/);
  const repTxt = R.eventoDescripcion(Object.assign({}, ev, { servicio: 'Cultos Dominicales' }));
  assert.match(repTxt, /^Banda:/);
  assert.match(repTxt, /Canciones:\n- Canción/);
});

test('el menú oculta los módulos que no aplican al perfil', () => {
  const admin = { role: 'admin' };
  const ids = (org) => w.RepertorioMenu.modulos('eventos', org, admin).map((m) => m.id);
  assert.ok(ids({ id: 'o1' }).indexOf('repertorio') >= 0);
  assert.equal(ids({ id: 'o2', tipoCalendario: 'servicio' }).indexOf('repertorio'), -1);
  assert.ok(ids(null).indexOf('repertorio') >= 0);
});

test('Alabanza: roles de banda numerados por rol dentro del ministerio', () => {
  const alabanza = srv.roles.find((r) => r.tipo === 'Alabanza');
  const banda = R.defaultBanda(srv);
  /* El siguiente que se agrega arranca como Corista 1 */
  assert.equal(R.rolInicialMinisterio(banda, alabanza), 'Corista');
  const c1 = R.bandaSlotRol(banda, 'Alabanza', 'Corista');
  banda.push(c1);
  assert.equal(R.bandaLabel(c1), 'Corista 1');
  const c2 = R.bandaSlotRol(banda, 'Alabanza', 'Corista');
  assert.equal(c2.numero, 2);
  /* Roles sin numerar (Bajo) solo muestran número desde el segundo */
  const b1 = R.bandaSlotRol(banda, 'Alabanza', 'Bajo');
  banda.push(b1);
  assert.equal(R.bandaLabel(b1), 'Bajo');
  assert.equal(R.bandaLabel(R.bandaSlotRol(banda, 'Alabanza', 'Bajo')), 'Bajo 2');
  /* Al cambiarle el rol a un puesto, su número no cuenta contra sí mismo */
  assert.equal(R.numeroParaRol(banda, 'Alabanza', 'Corista', c1.id), 1);
  /* Sin rol (repertorio), la etiqueta es la de siempre */
  assert.equal(R.bandaLabel({ tipo: 'Piano', numero: 1 }), 'Piano 1');
  assert.equal(R.bandaLabel({ tipo: 'Protocolo', numero: null }), 'Protocolo');
  const txt = R.eventoDescripcion({ servicio: 'Culto Filial', banda: [Object.assign({}, banda[1], { nombre: 'Ana' })] }, srv);
  assert.match(txt, /Alabanza · Director de Alabanza 1: Ana/);
});

test('etiquetas de Personas: ministerios y, para Alabanza, los roles de banda', () => {
  const et = Array.from(srv.etiquetasPersona());
  assert.deepEqual(et.slice(0, 2), ['Protocolo', 'Alabanza']);
  assert.ok(et.indexOf('Director de Alabanza') >= 0 && et.indexOf('Batería') >= 0);
  assert.equal(new Set(et).size, et.length);
  assert.deepEqual(Array.from(rep.etiquetasPersona()), Array.from(rep.ordenRoles()));
});

test('puestoLabel antepone el ministerio cuando el puesto lleva rol', () => {
  assert.equal(R.puestoLabel({ tipo: 'Alabanza', rol: 'Director de Alabanza', numero: 1 }), 'Alabanza · Director de Alabanza 1');
  assert.equal(R.puestoLabel({ tipo: 'Protocolo', numero: null }), 'Protocolo');
  assert.equal(R.puestoLabel({ tipo: 'Corista', numero: 2 }), 'Corista 2');
  assert.equal(R.servidoresAsignados({ banda: [{ nombre: 'Ana' }, { nombre: ' ' }, {}] }), 1);
  assert.equal(R.servidoresAsignados({}), 0);
});

test('avisos: el puesto de Alabanza incluye el rol', () => {
  const A = require('../avisos.js');
  const ev = { fecha: '2026-10-08', servicio: 'Culto Filial', banda: [
    { tipo: 'Alabanza', rol: 'Corista', numero: 1, nombre: 'Ana', musicianId: 'm1' },
    { tipo: 'Protocolo', nombre: 'Ana', musicianId: 'm1' }
  ] };
  assert.match(A.lineaEvento(ev, 'm1'), /Culto Filial \(Alabanza · Corista, Protocolo\)$/);
  const rep = { fecha: '2026-10-04', servicio: 'Cultos Dominicales', banda: [{ tipo: 'Corista', numero: 2, nombre: 'B', musicianId: 'm2' }] };
  assert.match(A.lineaEvento(rep, 'm2'), /Cultos Dominicales \(Corista\)$/);
});

test('avisos: un usuario sin correo recibe su aviso por WhatsApp', () => {
  const A = require('../avisos.js');
  const ev = { id: 'e1', fecha: '2999-01-07', servicio: 'Culto Filial', estado: 'PUBLICADO', banda: [{ tipo: 'Protocolo', nombre: 'Beto', musicianId: 'm2' }] };
  const filas = A.planAvisos({ tipo: 'publicacion', eventIds: ['e1'] }, {
    org: { id: 'f', name: 'Filial' }, eventos: [ev], hoy: '2998-12-01', musicos: [{ id: 'm2', nombre: 'Beto' }],
    usuarios: [{ uid: '-Nx', email: '', sinCorreo: true, telefono: '50370002222', organizationIds: { f: true }, musicianLinks: { f: 'm2' } }]
  });
  assert.equal(filas.length, 1);
  assert.equal(filas[0].email, '');
  assert.equal(filas[0].telefono, '50370002222');
  assert.ok(filas[0].aviso && /Protocolo/.test(filas[0].aviso.texto));
});
