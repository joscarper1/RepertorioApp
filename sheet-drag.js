/* Hojas inferiores en el teléfono (.velo > .modal con .agarre): arrastrarlas
   hacia abajo las cierra, como en las apps nativas.

   El gesto empieza en la franja superior de la hoja (donde está el
   "agarre"; la barrita sola mide 4 px y es imposible de acertar) y solo si la
   hoja no está desplazada, para no pelear con su propio scroll. Al soltar,
   si se arrastró lo suficiente (o rápido) se hace clic en el velo, que es lo
   que cada página ya usa para cerrar; si no, la hoja vuelve a su lugar.

   Delegado en document: sirve para las hojas que cada página pinta o quita
   al vuelo, sin tocar su código. */
(function () {
  var ZONA_PX = 64;        /* alto de la franja desde donde se puede arrastrar */
  var CIERRA_PX = 90;      /* distancia que basta para cerrar */
  var CIERRA_VEL = 0.6;    /* px/ms: un deslizamiento rápido también cierra */

  var g = null; /* gesto en curso: {hoja, velo, y0, dy, t0, activo} */

  function hojaDe(el) {
    var hoja = el && el.closest ? el.closest('.modal') : null;
    var velo = hoja && hoja.parentElement;
    if (!hoja || !velo || !velo.classList.contains('velo') || !hoja.querySelector('.agarre')) return null;
    /* Solo cuando es hoja inferior (teléfono): el velo la pega abajo. */
    if (getComputedStyle(velo).alignItems !== 'flex-end') return null;
    return { hoja: hoja, velo: velo };
  }

  document.addEventListener('touchstart', function (e) {
    g = null;
    if (e.touches.length !== 1) return;
    var h = hojaDe(e.target);
    if (!h || h.hoja.scrollTop > 0) return;
    var y = e.touches[0].clientY;
    if (y - h.hoja.getBoundingClientRect().top > ZONA_PX) return;
    g = { hoja: h.hoja, velo: h.velo, y0: y, dy: 0, t0: Date.now(), activo: false };
  }, { passive: true });

  document.addEventListener('touchmove', function (e) {
    if (!g) return;
    var dy = e.touches[0].clientY - g.y0;
    if (dy <= 0 && !g.activo) return; /* hacia arriba no es este gesto */
    g.activo = true;
    g.dy = Math.max(0, dy);
    g.hoja.style.transition = 'none';
    g.hoja.style.transform = 'translateY(' + g.dy + 'px)';
    g.velo.style.opacity = String(Math.max(0.35, 1 - g.dy / 500));
    if (e.cancelable) e.preventDefault(); /* sin esto el navegador hace scroll/recarga */
  }, { passive: false });

  function soltar() {
    if (!g) return;
    var s = g;
    g = null;
    if (!s.activo) return;
    var vel = s.dy / Math.max(1, Date.now() - s.t0);
    s.hoja.style.transition = 'transform .18s ease-out';
    if (s.dy > CIERRA_PX || (s.dy > 24 && vel > CIERRA_VEL)) {
      s.hoja.style.transform = 'translateY(100%)';
      setTimeout(function () {
        s.velo.click(); /* cierra con el mismo clic que ya usa la página */
        /* Si la página no la cerró (p. ej. pide confirmar), vuelve a su lugar. */
        s.hoja.style.transition = ''; s.hoja.style.transform = ''; s.velo.style.opacity = '';
      }, 160);
    } else {
      s.hoja.style.transform = '';
      s.velo.style.opacity = '';
      setTimeout(function () { s.hoja.style.transition = ''; }, 200);
    }
  }
  document.addEventListener('touchend', soltar);
  document.addEventListener('touchcancel', soltar);
})();
