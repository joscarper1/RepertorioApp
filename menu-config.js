/* Menú de administración — ÚNICO lugar donde se define qué módulos y
   botones superiores aparecen y en qué orden. admin.html y el Formulario
   (y cualquier página de administración futura) lo renderizan desde aquí
   con un <sc-for>, así que para reordenar, renombrar o agregar un módulo
   basta con editar estas listas: el orden de la lista es el orden en
   pantalla, igual en todas las páginas.

   - MODULOS: menú lateral ("Módulos"). `requiereOrg` lo deshabilita
     mientras no haya organización activa.
   - ACCIONES: botones de la barra superior, debajo del título.
   - ACCIONES_DASHBOARD: botones bajo el encabezado de dashboard.html.
     `soloAdmin` los oculta a quien no tiene rol admin.
   - ACCIONES_CALENDARIO: botones del pie de index.html. Los de
     `tipo: 'accion'` no navegan: ejecutan la función que la página
     registra con ese mismo id (ej. copiar el mes para WhatsApp). */
(function (w) {
  var MODULOS = [
    { id: 'eventos', label: 'Eventos', requiereOrg: true },
    { id: 'usuarios', label: 'Usuarios' },
    { id: 'repertorio', label: 'Repertorio', requiereOrg: true },
    { id: 'organizaciones', label: 'Organizaciones' }
  ];

  var ACCIONES = [
    { id: 'dashboard', label: 'Dashboard' },
    { id: 'publicado', label: 'Ver publicado' }
  ];

  var ACCIONES_DASHBOARD = [
    { id: 'publicado', label: 'Ir al calendario' },
    { id: 'eventos', label: 'Panel de administración', soloAdmin: true }
  ];

  var ACCIONES_CALENDARIO = [
    { id: 'eventos', label: 'Gestionar Eventos' },
    { id: 'whatsapp', label: 'Copiar para WhatsApp', tipo: 'accion' }
  ];

  /* Eventos vive en su propia página (eventos.html); el resto son pestañas
     de admin.html seleccionadas por ?tab=. */
  function hrefModulo(id, org) {
    /* Sin organización, eventos.html manda a admin.html, que elige la
       organización activa y vuelve aquí. */
    if (id === 'eventos') return org ? ('eventos.html?org=' + encodeURIComponent(org.id)) : 'admin.html';
    return 'admin.html?tab=' + encodeURIComponent(id);
  }

  function hrefAccion(id, org) {
    if (id === 'dashboard') return org && org.slug ? ('dashboard.html?org=' + encodeURIComponent(org.slug)) : 'dashboard.html';
    if (id === 'eventos') return hrefModulo('eventos', org);
    if (id === 'publicado') return org && org.slug ? ('index.html?group=' + encodeURIComponent(org.slug)) : 'index.html';
    return '#';
  }

  /* Lista lista para pintar: [{id, label, activo, deshabilitado, href}]. */
  function modulos(activoId, org) {
    return MODULOS.map(function (m) {
      return {
        id: m.id, label: m.label,
        activo: m.id === activoId,
        deshabilitado: !!m.requiereOrg && !org,
        href: hrefModulo(m.id, org)
      };
    });
  }

  function armarAcciones(lista, org, esAdmin) {
    return lista
      .filter(function (a) { return !a.soloAdmin || esAdmin; })
      .map(function (a) {
        var esAccion = a.tipo === 'accion';
        return { id: a.id, label: a.label, esAccion: esAccion, esLink: !esAccion, href: esAccion ? '' : hrefAccion(a.id, org) };
      });
  }

  function acciones(org) { return armarAcciones(ACCIONES, org, true); }

  function accionesDashboard(org, esAdmin) { return armarAcciones(ACCIONES_DASHBOARD, org, esAdmin); }

  function accionesCalendario(org, esAdmin) { return armarAcciones(ACCIONES_CALENDARIO, org, esAdmin); }

  w.RepertorioMenu = {
    MODULOS: MODULOS, ACCIONES: ACCIONES, ACCIONES_DASHBOARD: ACCIONES_DASHBOARD, ACCIONES_CALENDARIO: ACCIONES_CALENDARIO,
    modulos: modulos, acciones: acciones, accionesDashboard: accionesDashboard, accionesCalendario: accionesCalendario
  };
})(window);
