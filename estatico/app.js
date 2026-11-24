/* =====================================================================
   CobraYa · aplicación del navegador (JavaScript puro, sin frameworks)
   ===================================================================== */
'use strict';

const $ = (sel, raiz = document) => raiz.querySelector(sel);
const $$ = (sel, raiz = document) => Array.from(raiz.querySelectorAll(sel));

const soles = (n) =>
  new Intl.NumberFormat('es-PE', {
    style: 'currency',
    currency: 'PEN',
    minimumFractionDigits: 2,
  }).format(Number(n) || 0);

const esc = (texto) =>
  String(texto ?? '').replace(/[&<>"']/g, (c) => ({
    '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;',
  }[c]));

const hoyISO = () => {
  const d = new Date();
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
};

const restarDias = (iso, dias) => {
  const d = new Date(`${iso}T12:00:00`);
  d.setDate(d.getDate() - dias);
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
};

const fechaCorta = (texto) => {
  const [fecha, hora = ''] = String(texto).split(' ');
  const d = new Date(`${fecha}T12:00:00`);
  const dia = d.toLocaleDateString('es-PE', { day: '2-digit', month: 'short' });
  return hora ? `${dia} · ${hora.slice(0, 5)}` : dia;
};

/* Enlace público a la boleta (solo si la app corre en un dominio accesible).
   En la red local el enlace no le serviría al cliente desde sus datos. */
const enlacePublico = (ventaId) => {
  // En Netlify no existe /api/boleta: el enlace no le serviría al cliente.
  if (window.COBRAYA_DEMO) return '';
  const host = location.hostname;
  const privado = host === 'localhost' || host === '127.0.0.1' ||
    /^10\./.test(host) || /^192\.168\./.test(host) ||
    /^172\.(1[6-9]|2\d|3[01])\./.test(host);
  return privado ? '' : `${location.origin}/api/boleta/${ventaId}`;
};

const estado = {
  negocio: null,
  productos: [],
  resumen: null,
  ventas: [],
  vista: 'inicio',
  carrito: [],
  metodoPago: 'Efectivo',
  tipoComprobante: 'boleta',
  categoria: 'Todos',
  busqueda: '',
  rango: 'hoy',
  busquedaVenta: '',
  tema: localStorage.getItem('cobraya-tema') || 'claro',
  pin: '',
  ventaExitosa: null,
  instalacion: null,
};

/* =====================================================================
   Modo offline
   Si se cae el internet, la venta se guarda en el celular (localStorage)
   y se envía sola cuando vuelve la señal. Cada venta lleva un id único
   para que el servidor no emita dos boletas si hay un reintento.
   ===================================================================== */
const COLA_KEY = 'cobraya-cola';

function leerCola() {
  try {
    const cola = JSON.parse(localStorage.getItem(COLA_KEY) || '[]');
    return Array.isArray(cola) ? cola : [];
  } catch (_) {
    return [];
  }
}

function guardarCola(cola) {
  localStorage.setItem(COLA_KEY, JSON.stringify(cola));
  actualizarBanner();
}

function nuevoIdVenta() {
  if (window.crypto && crypto.randomUUID) return crypto.randomUUID();
  return `v-${Date.now()}-${Math.random().toString(16).slice(2, 10)}`;
}

function actualizarBanner() {
  const banner = $('#banner-offline');
  if (!banner) return;
  const pendientes = leerCola().length;
  const sinRed = navigator.onLine === false;

  if (sinRed) {
    banner.classList.remove('oculto', 'pendiente');
    $('#banner-texto').textContent = pendientes
      ? `Sin conexión. ${pendientes} venta(s) guardadas en el celular.`
      : 'Sin conexión. Puedes seguir cobrando: se enviará al volver la señal.';
    $('#btn-sincronizar').classList.add('oculto');
    return;
  }

  if (pendientes) {
    banner.classList.remove('oculto');
    banner.classList.add('pendiente');
    $('#banner-texto').textContent = `${pendientes} venta(s) esperando envío a SUNAT.`;
    $('#btn-sincronizar').classList.remove('oculto');
    return;
  }

  banner.classList.add('oculto');
}

let sincronizando = false;

async function sincronizarCola(silencioso = true) {
  if (sincronizando) return;
  const cola = leerCola();
  if (!cola.length) {
    actualizarBanner();
    return;
  }
  sincronizando = true;
  let enviadas = 0;
  try {
    for (const item of cola.slice()) {
      try {
        await api('/api/ventas', { method: 'POST', body: item.payload });
        guardarCola(leerCola().filter((x) => x.id_cliente !== item.id_cliente));
        enviadas += 1;
      } catch (error) {
        // Sin red, sesión vencida o error del servidor: se conserva y se
        // reintenta después. Solo descartamos errores de validación (4xx).
        if (error.red || error.estado === 401 || !error.estado || error.estado >= 500) break;
        guardarCola(leerCola().filter((x) => x.id_cliente !== item.id_cliente));
        toast(`Una venta no se pudo enviar: ${error.message}`, 'error');
      }
    }
  } finally {
    sincronizando = false;
    actualizarBanner();
  }
  if (enviadas) {
    if (!silencioso) toast(`${enviadas} venta(s) sincronizada(s)`);
    await refrescar();
  }
}

/* Atajos de fecha usados por el historial y el reporte del contador. */
function rangoFechas(rango = estado.rango) {
  const hoy = hoyISO();
  if (rango === 'hoy') return { desde: hoy, hasta: hoy };
  if (rango === '7') return { desde: restarDias(hoy, 6), hasta: hoy };
  if (rango === '30') return { desde: `${hoy.slice(0, 7)}-01`, hasta: hoy };
  return { desde: '', hasta: '' };
}

/* ------------------------------------------------------------ peticiones */
async function api(ruta, opciones = {}) {
  const config = { credentials: 'same-origin', ...opciones };
  if (config.body !== undefined && typeof config.body !== 'string') {
    config.headers = { 'Content-Type': 'application/json', ...(config.headers || {}) };
    config.body = JSON.stringify(config.body);
  }
  let respuesta;
  try {
    respuesta = await fetch(ruta, config);
  } catch (error) {
    // Marcamos el error como "de red" para poder encolar la venta sin conexión.
    const fallo = new Error('Sin conexión con el servidor. Revisa la red Wi-Fi.');
    fallo.red = true;
    throw fallo;
  }
  const tipo = respuesta.headers.get('content-type') || '';
  const datos = tipo.includes('application/json') ? await respuesta.json() : await respuesta.text();

  if (respuesta.status === 401 && !ruta.includes('/login')) {
    mostrarLogin();
    const fallo = new Error('Vuelve a ingresar tu PIN.');
    fallo.estado = 401;
    throw fallo;
  }
  if (!respuesta.ok) {
    const fallo = new Error((datos && datos.error) || `Error ${respuesta.status}`);
    fallo.estado = respuesta.status;
    throw fallo;
  }
  return datos;
}

/* ------------------------------------------------------------------ UI */
const mostrar = (sel) => $(sel)?.classList.remove('oculto');
const ocultar = (...sels) => sels.forEach((s) => $(s)?.classList.add('oculto'));

let toastTimer = null;
function toast(mensaje, tipo = '') {
  const nodo = $('#toast');
  nodo.textContent = mensaje;
  nodo.className = `toast ${tipo}`;
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => nodo.classList.add('oculto'), 3200);
}

function aplicarTema(tema) {
  estado.tema = tema;
  document.documentElement.dataset.tema = tema;
  localStorage.setItem('cobraya-tema', tema);
  const meta = document.querySelector('meta[name="theme-color"]');
  if (meta) meta.content = tema === 'oscuro' ? '#0a1512' : '#0f766e';
  $('#btn-tema')?.setAttribute('aria-label', tema === 'oscuro' ? 'Cambiar a tema claro' : 'Cambiar a tema oscuro');
}

/* --------------------------------------------------------------- arranque */
async function iniciar() {
  aplicarTema(estado.tema);
  registrarServiceWorker();
  try {
    const info = await api('/api/estado');
    ocultar('#cargando');
    if (!info.configurado) {
      mostrar('#pantalla-setup');
      const aviso = $('#setup-modo');
      if (aviso) {
        aviso.textContent = info.demo
          ? 'Modo demostración: los datos quedan en este navegador y no se envían a SUNAT.'
          : info.emision_activa
            ? 'Emisión electrónica activa en esta instalación.'
            : 'Emisión electrónica no activada. Podrás configurar tu negocio, pero no vender hasta que se active.';
        aviso.classList.remove('oculto');
        aviso.classList.toggle('alerta', !info.demo && !info.emision_activa);
      }
      return;
    }
    if (!info.sesion) {
      mostrarLogin(info.nombre_negocio);
      return;
    }
    await entrarApp();
  } catch (error) {
    ocultar('#cargando');
    mostrarLogin();
    toast(error.message, 'error');
  }
}

async function entrarApp() {
  ocultar('#cargando', '#pantalla-login', '#pantalla-setup');
  mostrar('#app');
  try {
    await cargarDatos();
    irA('inicio');
    actualizarBanner();
    // Si quedaron ventas de una sesión sin internet, se envían ahora.
    sincronizarCola();
  } catch (error) {
    toast(error.message, 'error');
  }
}

async function cargarDatos() {
  const [negocio, catalogo, resumen] = await Promise.all([
    api('/api/negocio'),
    api('/api/productos'),
    api('/api/resumen?dias=7'),
  ]);
  estado.negocio = negocio;
  estado.productos = catalogo.productos || [];
  estado.resumen = resumen;
  pintarNegocio();
  pintarInicio();
  pintarVender();
  pintarAjustes();
}

function pintarNegocio() {
  const negocio = estado.negocio || {};
  $('#nombre-negocio').textContent = negocio.nombre || 'Mi negocio';
  document.title = negocio.nombre ? `${negocio.nombre} · CobraYa` : 'CobraYa · caja y boleta';
  $('#saludo-negocio').textContent = (negocio.nombre || 'vecino').split(' ')[0];
  const pill = $('#pill-sunat');
  const demo = negocio.sunat_modo === 'demo';
  const activa = Boolean(negocio.emision_activa);
  pill.textContent = demo ? 'DEMO' : activa ? 'SUNAT' : 'sin activar';
  pill.classList.toggle('real', activa && !demo);
  pill.classList.toggle('demo', demo);
  pill.title = demo
    ? 'Demostración: los datos quedan en este navegador y no se envían a SUNAT.'
    : activa
      ? 'Emisión activa: los comprobantes se envían a SUNAT mediante el proveedor autorizado.'
      : 'Emisión no activada: no se pueden emitir comprobantes.';

  const banner = $('#banner-emision');
  if (banner) {
    banner.classList.toggle('oculto', activa || demo);
    banner.classList.toggle('demo', demo);
    if (demo) {
      banner.classList.remove('oculto');
      $('#banner-emision-texto').textContent =
        'Demostración: los datos quedan en este navegador y no se envían a SUNAT.';
    } else if (!activa) {
      $('#banner-emision-texto').textContent =
        'Emisión electrónica no activada. No se pueden emitir comprobantes. Avisa a quien instaló CobraYa.';
    }
  }
}

/* ---------------------------------------------------------------- inicio */
function pintarInicio() {
  const resumen = estado.resumen;
  if (!resumen) return;

  $('#fecha-hoy').textContent = new Date().toLocaleDateString('es-PE', {
    weekday: 'long', day: 'numeric', month: 'long',
  });

  $('#kpi-hoy').textContent = soles(resumen.hoy.total);
  $('#kpi-boletas').textContent = `${resumen.hoy.boletas} ${resumen.hoy.boletas === 1 ? 'boleta' : 'boletas'}`;
  $('#kpi-ticket').textContent = soles(resumen.hoy.ticket_promedio);
  $('#kpi-mes').textContent = soles(resumen.mes.total);

  const delta = $('#kpi-comparacion');
  const ayer = Number(resumen.ayer.total) || 0;
  const hoy = Number(resumen.hoy.total) || 0;
  delta.className = 'delta';
  if (!ayer && !hoy) {
    delta.textContent = 'Sin ventas aún';
    delta.classList.add('neutro');
  } else if (!ayer) {
    delta.textContent = 'Primeras ventas del día';
    delta.classList.add('positivo');
  } else {
    const cambio = Math.round(((hoy - ayer) / ayer) * 100);
    delta.textContent = `${cambio >= 0 ? '↑' : '↓'} ${Math.abs(cambio)}% vs ayer`;
    delta.classList.add(cambio >= 0 ? 'positivo' : 'negativo');
  }

  pintarGrafico(resumen.serie || []);
  pintarMetodos(resumen.metodos || []);
  pintarTop(resumen.top_productos || []);
  pintarUltimas(resumen.ultimas || []);
}

function pintarGrafico(serie) {
  const contenedor = $('#grafico');
  if (!serie.length) {
    contenedor.innerHTML = '<p class="vacio">Todavía no hay ventas para graficar.</p>';
    return;
  }
  const ancho = 320;
  const alto = 150;
  const arriba = 24;
  const abajo = 26;
  const util = alto - arriba - abajo;
  const max = Math.max(...serie.map((d) => Number(d.total) || 0), 1);
  const paso = ancho / serie.length;

  const barras = serie.map((d, i) => {
    const total = Number(d.total) || 0;
    const h = Math.max(2, (total / max) * util);
    const x = i * paso + paso * 0.22;
    const w = paso * 0.56;
    const y = alto - abajo - h;
    const esHoy = i === serie.length - 1;
    const fecha = new Date(`${d.fecha}T12:00:00`);
    const etiqueta = fecha.toLocaleDateString('es-PE', { weekday: 'short' });
    const valor = total >= 1000 ? `${(total / 1000).toFixed(1).replace('.0', '')}k` : Math.round(total);
    return `
      <rect class="barra ${esHoy ? 'hoy' : ''}" x="${x.toFixed(1)}" y="${y.toFixed(1)}"
            width="${w.toFixed(1)}" height="${h.toFixed(1)}" rx="4">
        <title>${esc(d.etiqueta || d.fecha)}: ${soles(total)}</title>
      </rect>
      ${total > 0 ? `<text class="valor-dia" x="${(x + w / 2).toFixed(1)}" y="${(y - 6).toFixed(1)}">${valor}</text>` : ''}
      <text class="etiqueta-dia" x="${(x + w / 2).toFixed(1)}" y="${alto - 8}">${esc(etiqueta)}</text>`;
  }).join('');

  const totalSemana = serie.reduce((suma, d) => suma + (Number(d.total) || 0), 0);
  $('#chart-total').textContent = `${soles(totalSemana)} en total`;
  contenedor.innerHTML = `<svg viewBox="0 0 ${ancho} ${alto}" role="img" aria-label="Ventas de los últimos 7 días">${barras}</svg>`;
}

function pintarMetodos(metodos) {
  const contenedor = $('#metodos');
  if (!metodos.length) {
    contenedor.innerHTML = '<p class="vacio mini">Sin ventas en los últimos 7 días.</p>';
    return;
  }
  const max = Math.max(...metodos.map((m) => Number(m.total) || 0), 1);
  contenedor.innerHTML = metodos.map((m) => `
    <div class="metodo-fila">
      <span class="metodo-nombre">${esc(m.metodo)}</span>
      <span class="metodo-barra"><i style="width:${Math.max(4, (Number(m.total) / max) * 100).toFixed(1)}%"></i></span>
      <span class="metodo-monto">${soles(m.total)}</span>
    </div>`).join('');
}

function pintarTop(productos) {
  const contenedor = $('#top-productos');
  if (!productos.length) {
    contenedor.innerHTML = '<p class="vacio mini">Aún no hay productos vendidos.</p>';
    return;
  }
  contenedor.innerHTML = productos.map((p, i) => `
    <div class="top-fila">
      <span class="top-puesto">${i + 1}</span>
      <span class="top-nombre">${esc(p.descripcion)}</span>
      <span class="top-cant">${Number(p.cantidad)} u.</span>
      <span class="top-total">${soles(p.total)}</span>
    </div>`).join('');
}

function iconoBoleta() {
  return `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><path d="M5 3h14v18l-3-2-2 2-2-2-2 2-2-2-3 2V3z"/><path d="M9 8h6M9 12h6"/></svg>`;
}

function filaVenta(venta) {
  const estadoSunat = venta.estado === 'anulada' ? 'anulada' : venta.sunat_estado;
  const demo = estado.negocio && estado.negocio.sunat_modo === 'demo';
  const etiqueta = demo ? 'demo' : ({
    aceptada: 'SUNAT ✓',
    error: 'SUNAT !',
    pendiente: 'pendiente',
    anulada: 'anulada',
  }[estadoSunat] || '');
  const claseEstado = demo && estadoSunat !== 'anulada' ? 'pendiente' : estadoSunat;
  return `
    <button class="venta ${venta.estado === 'anulada' ? 'anulada' : ''}" type="button" data-venta="${venta.id}">
      <span class="venta-icono">${iconoBoleta()}</span>
      <span class="venta-izq">
        <span class="venta-doc">${esc(venta.numero)}</span>
        <span class="venta-meta">${esc(fechaCorta(venta.creado_en))} · ${esc(venta.metodo_pago)}</span>
      </span>
      <span class="venta-der">
        <span class="venta-monto">${soles(venta.total)}</span>
        <span class="venta-estado ${claseEstado}">${etiqueta}</span>
      </span>
    </button>`;
}

function pintarUltimas(ventas) {
  const contenedor = $('#ultimas-ventas');
  contenedor.innerHTML = ventas.length
    ? ventas.map(filaVenta).join('')
    : '<p class="vacio mini">Todavía no registraste ventas. Toca <strong>Vender</strong> para empezar.</p>';
}

/* ---------------------------------------------------------------- vender */
function pintarVender() {
  const categorias = ['Todos', ...new Set(estado.productos.map((p) => p.categoria).filter(Boolean))];
  if (!categorias.includes(estado.categoria)) estado.categoria = 'Todos';
  $('#chips-categorias').innerHTML = categorias.map((c) => `
    <button class="chip ${c === estado.categoria ? 'activo' : ''}" type="button" data-categoria="${esc(c)}">${esc(c)}</button>`).join('');

  const texto = estado.busqueda.trim().toLowerCase();
  const filtrados = estado.productos.filter((p) => {
    const coincideCategoria = estado.categoria === 'Todos' || p.categoria === estado.categoria;
    const coincideTexto = !texto || p.nombre.toLowerCase().includes(texto);
    return coincideCategoria && coincideTexto;
  });

  $('#sin-productos').classList.toggle('oculto', filtrados.length > 0);
  $('#grilla-productos').innerHTML = filtrados.map((p) => `
    <button class="producto" type="button" data-producto="${p.id}">
      <span class="producto-cat">${esc(p.categoria || 'general')}</span>
      <span class="producto-nombre">${esc(p.nombre)}</span>
      <span class="producto-precio">${soles(p.precio)}</span>
    </button>`).join('');

  pintarCarrito();
}

function agregarAlCarrito(producto) {
  const existente = estado.carrito.find(
    (i) => i.producto_id === producto.id && i.precio_unitario === Number(producto.precio)
  );
  if (existente) {
    existente.cantidad += 1;
  } else {
    estado.carrito.push({
      producto_id: producto.id,
      descripcion: producto.nombre,
      precio_unitario: Number(producto.precio),
      cantidad: 1,
    });
  }
  pintarCarrito();
  if (navigator.vibrate) navigator.vibrate(8);
}

function agregarLibre(descripcion, precio, cantidad = 1) {
  estado.carrito.push({
    producto_id: null,
    descripcion,
    precio_unitario: Number(precio),
    cantidad: Number(cantidad),
  });
  pintarCarrito();
}

function totalCarrito() {
  return estado.carrito.reduce((suma, i) => suma + i.cantidad * i.precio_unitario, 0);
}

/* ¿Toca mostrar el QR del negocio? Solo con Yape/Plin y si subió su imagen. */
function usaQrPago() {
  return (
    (estado.metodoPago === 'Yape' || estado.metodoPago === 'Plin') &&
    Boolean(estado.negocio && estado.negocio.qr_pago)
  );
}

function pintarCarrito() {
  const cantidad = estado.carrito.reduce((suma, i) => suma + i.cantidad, 0);
  const barra = $('#barra-carro');
  const visible = cantidad > 0 && estado.vista === 'vender';
  barra.classList.toggle('oculto', !visible);
  $('#carro-cantidad').textContent = `${cantidad} ${cantidad === 1 ? 'producto' : 'productos'}`;
  $('#carro-total').textContent = soles(totalCarrito());

  if (!estado.carrito.length) {
    $('#items-carro').innerHTML = '<p class="vacio">Tu venta está vacía.<br>Toca un producto para agregarlo.</p>';
  } else {
    $('#items-carro').innerHTML = estado.carrito.map((item, i) => `
      <div class="item-carro">
        <div class="item-info">
          <div class="item-nombre">${esc(item.descripcion)}</div>
          <div class="item-precio">${soles(item.precio_unitario)} c/u</div>
        </div>
        <div class="stepper">
          <button type="button" data-accion="menos" data-indice="${i}" aria-label="Quitar uno">−</button>
          <span>${item.cantidad}</span>
          <button type="button" data-accion="mas" data-indice="${i}" aria-label="Agregar uno">+</button>
        </div>
        <div class="item-total">${soles(item.cantidad * item.precio_unitario)}</div>
      </div>`).join('');
  }

  $('#chips-pago').innerHTML = ['Efectivo', 'Yape', 'Plin', 'Tarjeta', 'Transferencia'].map((m) => `
    <button class="chip ${m === estado.metodoPago ? 'activo' : ''}" type="button" data-pago="${m}">${m}</button>`).join('');

  // Boleta o factura: la factura siempre pide RUC y razón social.
  const esFactura = estado.tipoComprobante === 'factura';
  $$('#tipo-comprobante button').forEach((boton) => {
    boton.classList.toggle('activo', boton.dataset.tipo === estado.tipoComprobante);
  });

  // Si el negocio subió su QR de Yape/Plin, lo mostramos al cobrar con
  // esas billeteras. El cobro se confirma a mano, tal como en la vida real.
  const mostrarQr = usaQrPago();
  const cajaQr = $('#qr-cobro');
  cajaQr.classList.toggle('oculto', !mostrarQr);
  if (mostrarQr) $('#qr-cobro-img').src = estado.negocio.qr_pago;
  $('#btn-cobrar-etiqueta').textContent = estado.carrito.length && mostrarQr
    ? `Confirmar pago y emitir ${esFactura ? 'factura' : 'boleta'}`
    : `Emitir ${esFactura ? 'factura' : 'boleta'}`;

  const igv = Number((estado.negocio && estado.negocio.igv) || 18);
  const total = totalCarrito();
  const subtotal = total / (1 + igv / 100);
  $('#totales-carro').innerHTML = `
    <div><span>Subtotal</span><span>${soles(subtotal)}</span></div>
    <div><span>IGV (${igv}%) incluido</span><span>${soles(total - subtotal)}</span></div>
    <div class="final"><span>Total</span><span>${soles(total)}</span></div>`;

  // Regla SUNAT: hasta S/ 700 no hace falta DNI ("Clientes varios").
  const nota = $('#nota-dni');
  if (esFactura) {
    nota.classList.add('alerta');
    nota.textContent = 'La factura exige RUC de 11 dígitos y razón social del cliente.';
  } else if (total > 700) {
    nota.classList.add('alerta');
    nota.textContent = 'Venta mayor a S/ 700: la SUNAT exige DNI o RUC del cliente.';
  } else {
    nota.classList.remove('alerta');
    nota.textContent = 'Sale a «Clientes varios» sin DNI. Solo pídelo si el cliente lo quiere o si la venta supera S/ 700.';
  }

  $('#btn-cobrar-total').textContent = soles(total);
  $('#btn-cobrar').disabled = !estado.carrito.length;
  const demo = estado.negocio && estado.negocio.sunat_modo === 'demo';
  const activa = Boolean(estado.negocio && estado.negocio.emision_activa);
  const modo = demo
    ? 'Demostración: no se envía a SUNAT.'
    : activa
      ? 'Se enviará a SUNAT mediante el proveedor autorizado.'
      : 'Emisión no activada: no se puede cobrar todavía.';
  $('#nota-sunat').textContent = `${esFactura ? 'Factura' : 'Boleta'}: ${modo}`;
  $('#nota-sunat').classList.toggle('alerta', !activa && !demo);
  $('#btn-cobrar').disabled = !estado.carrito.length || (!activa && !demo);
  ajustarCamposComprobante();
}

function ajustarCamposComprobante() {
  const esFactura = estado.tipoComprobante === 'factura';
  $('#cliente-nombre').placeholder = esFactura ? 'Razón social (obligatorio)' : 'Nombre o razón social';
  $('#cliente-doc').placeholder = esFactura ? 'RUC de 11 dígitos' : 'DNI / RUC';
  $('#cliente-doc').maxLength = esFactura ? 11 : 15;
  if (esFactura) {
    $('#chk-cliente').checked = true;
    $('#campos-cliente').classList.remove('oculto');
  }
}

/* --------------------------------------------------------------- cobrar */
function limpiarCarrito() {
  estado.carrito = [];
  estado.tipoComprobante = 'boleta';
  $('#cliente-nombre').value = '';
  $('#cliente-doc').value = '';
  $('#cliente-celular').value = '';
  $('#chk-cliente').checked = false;
  $('#campos-cliente').classList.add('oculto');
  pintarCarrito();
}

function guardarVentaPendiente(payload) {
  const cola = leerCola();
  cola.push({
    id_cliente: payload.id_cliente,
    payload,
    total: totalCarrito(),
    metodo_pago: payload.metodo_pago,
    creado_local: new Date().toISOString(),
  });
  guardarCola(cola);
  return {
    id: null,
    numero: 'Pendiente',
    total: totalCarrito(),
    sunat_estado: 'pendiente',
    sunat_mensaje:
      'Venta guardada en el celular. Se enviará a SUNAT automáticamente cuando vuelva la conexión.',
  };
}

async function cobrar() {
  if (!estado.carrito.length) return;

  const total = totalCarrito();
  const esFactura = estado.tipoComprobante === 'factura';
  const clienteNombre = $('#cliente-nombre').value.trim();
  const clienteDoc = $('#cliente-doc').value.replace(/[\s-]/g, '');
  const clienteCelular = $('#cliente-celular').value.replace(/\D/g, '');

  const pedirCliente = () => {
    $('#chk-cliente').checked = true;
    $('#campos-cliente').classList.remove('oculto');
  };

  // La factura siempre necesita RUC y razón social; la boleta puede ir sin DNI.
  if (esFactura && !/^\d{11}$/.test(clienteDoc)) {
    pedirCliente();
    $('#cliente-doc').focus();
    toast('Para factura escribe el RUC de 11 dígitos.', 'error');
    return;
  }
  if (esFactura && !clienteNombre) {
    pedirCliente();
    $('#cliente-nombre').focus();
    toast('Para factura escribe la razón social.', 'error');
    return;
  }
  if (!esFactura && clienteDoc && !/^\d{8}$/.test(clienteDoc) && !/^\d{11}$/.test(clienteDoc)) {
    pedirCliente();
    $('#cliente-doc').focus();
    toast('El documento debe ser DNI de 8 o RUC de 11 dígitos.', 'error');
    return;
  }

  // Regla SUNAT: por encima de S/ 700 hay que identificar al comprador.
  if (total > 700 && !clienteDoc) {
    pedirCliente();
    $('#cliente-doc').focus();
    toast('Venta mayor a S/ 700: agrega el DNI o RUC del cliente.', 'error');
    return;
  }

  if (clienteCelular && !/^9\d{8}$/.test(clienteCelular)) {
    pedirCliente();
    $('#cliente-celular').focus();
    toast('El celular debe tener 9 dígitos y empezar con 9.', 'error');
    return;
  }

  const payload = {
    id_cliente: nuevoIdVenta(),
    tipo_comprobante: estado.tipoComprobante,
    items: estado.carrito.map((i) => ({
      producto_id: i.producto_id,
      descripcion: i.descripcion,
      cantidad: i.cantidad,
      precio_unitario: i.precio_unitario,
    })),
    metodo_pago: estado.metodoPago,
    cliente_nombre: clienteNombre,
    cliente_doc: clienteDoc,
    cliente_celular: clienteCelular,
  };

  const boton = $('#btn-cobrar');
  const etiqueta = $('#btn-cobrar-etiqueta');
  boton.disabled = true;
  if (etiqueta) etiqueta.textContent = 'Emitiendo…';

  try {
    // Sin señal: no esperamos a que falle la petición, se guarda directo.
    if (navigator.onLine === false) {
      const local = guardarVentaPendiente(payload);
      limpiarCarrito();
      cerrarHoja('hoja-carro');
      mostrarExito(local);
      return;
    }

    let venta;
    try {
      venta = await api('/api/ventas', { method: 'POST', body: payload });
    } catch (error) {
      // Si el problema fue la red, la venta no se pierde: se encola.
      if (error.red) {
        const local = guardarVentaPendiente(payload);
        limpiarCarrito();
        cerrarHoja('hoja-carro');
        mostrarExito(local);
        return;
      }
      throw error;
    }

    estado.ventaExitosa = venta;
    limpiarCarrito();
    cerrarHoja('hoja-carro');
    mostrarExito(venta);
    actualizarBanner();
    await refrescar();
  } catch (error) {
    console.error('Error al cobrar:', error);
    toast(error.message, 'error');
  } finally {
    boton.disabled = false;
    pintarCarrito(); // restaura la etiqueta correcta según el medio de pago
  }
}

function mostrarExito(venta) {
  const pendiente = !venta.id; // se guardó offline y aún no tiene número
  $('#exito-titulo').textContent = pendiente
    ? 'Venta guardada'
    : (venta.numero.startsWith('F') ? 'Factura emitida' : 'Boleta emitida');
  $('#exito-numero').textContent = pendiente ? 'Se enviará al recuperar la señal' : venta.numero;
  $('#exito-total').textContent = soles(venta.total);

  const enlace = $('#exito-ver');
  enlace.classList.toggle('oculto', pendiente);
  if (!pendiente) enlace.href = `/api/boleta/${venta.id}`;

  // Botón directo al WhatsApp del cliente (si dejó su celular).
  const botonWa = $('#exito-wa');
  const enlaceWa = !pendiente ? whatsappBoleta(venta) : '';
  if (enlaceWa) {
    botonWa.href = enlaceWa;
    botonWa.classList.remove('oculto');
  } else {
    botonWa.classList.add('oculto');
    botonWa.removeAttribute('href');
  }

  const sunat = $('#exito-sunat');
  if (pendiente) {
    sunat.textContent = venta.sunat_mensaje;
  } else if (venta.sunat_estado === 'aceptada') {
    sunat.textContent = estado.negocio && estado.negocio.sunat_modo === 'demo'
      ? 'Guardada en la demostración (no enviada a SUNAT).'
      : 'Aceptada por SUNAT.';
  } else {
    sunat.textContent = venta.sunat_mensaje || 'Quedó pendiente el envío a SUNAT.';
  }
  mostrar('#hoja-exito');
}

/* Enlace de WhatsApp para reenviar una boleta ya emitida. */
function whatsappBoleta(venta) {
  const celular = String(venta.cliente_celular || '').replace(/\D/g, '');
  if (celular.length !== 9) return '';
  const negocio = estado.negocio || {};
  const texto = [
    `${negocio.nombre || 'Mi negocio'}`,
    `Boleta ${venta.numero}`,
    `Total: ${soles(venta.total)}`,
    enlacePublico(venta.id),
  ].filter(Boolean).join('\n');
  return `https://wa.me/51${celular}?text=${encodeURIComponent(texto)}`;
}

async function refrescar() {
  try {
    const [resumen, catalogo] = await Promise.all([
      api('/api/resumen?dias=7'),
      api('/api/productos'),
    ]);
    estado.resumen = resumen;
    estado.productos = catalogo.productos || [];
    pintarInicio();
    pintarVender();
    if (estado.vista === 'ventas') await cargarVentas();
    if (!$('#hoja-detalle').classList.contains('oculto')) {
      // Refresca el detalle abierto si sigue visible
      const id = Number($('#hoja-detalle').dataset.venta);
      if (id) await abrirDetalle(id, true);
    }
  } catch (_) { /* silencioso: la venta ya se guardó */ }
}

/* ---------------------------------------------------------------- ventas */
async function cargarVentas() {
  const { desde, hasta } = rangoFechas();
  const parametros = new URLSearchParams();
  if (desde) parametros.set('desde', desde);
  if (hasta) parametros.set('hasta', hasta);
  if (estado.busquedaVenta.trim()) parametros.set('q', estado.busquedaVenta.trim());
  parametros.set('limite', '500');

  try {
    const datos = await api(`/api/ventas?${parametros.toString()}`);
    estado.ventas = datos.ventas || [];
    $('#ventas-total').textContent = soles(datos.total);
    $('#ventas-cantidad').textContent = `${datos.cantidad} ${datos.cantidad === 1 ? 'venta' : 'ventas'}`;

    // Las ventas aún no enviadas se muestran arriba, con un aviso claro.
    const pendientes = leerCola();
    const filasPendientes = pendientes.map((item) => `
      <div class="venta pendiente-local">
        <span class="venta-icono">${iconoBoleta()}</span>
        <span class="venta-izq">
          <span class="venta-doc">Por enviar</span>
          <span class="venta-meta">Guardada sin conexión · ${esc(item.metodo_pago)}</span>
        </span>
        <span class="venta-der">
          <span class="venta-monto">${soles(item.total)}</span>
          <span class="venta-estado pendiente">pendiente</span>
        </span>
      </div>`).join('');

    $('#sin-ventas').classList.toggle('oculto', estado.ventas.length + pendientes.length > 0);
    $('#lista-ventas').innerHTML = filasPendientes + estado.ventas.map(filaVenta).join('');
  } catch (error) {
    toast(error.message, 'error');
  }
}

async function abrirDetalle(id, refrescarSilencioso = false) {
  try {
    const venta = await api(`/api/ventas/${id}`);
    $('#hoja-detalle').dataset.venta = String(id);
    const items = (venta.items || []).map((i) => `
      <div class="detalle-linea">
        <span class="cant">${Number(i.cantidad)}×</span>
        <span class="nom">${esc(i.descripcion)}</span>
        <span class="imp">${soles(i.total)}</span>
      </div>`).join('');

    const sunatClase = venta.sunat_estado === 'aceptada' ? 'ok' : venta.sunat_estado === 'error' ? 'mal' : '';
    const puedeReintentar = venta.estado !== 'anulada' && venta.sunat_estado !== 'aceptada'
      && estado.negocio && estado.negocio.emision_activa
      && estado.negocio.sunat_modo !== 'demo';

    $('#detalle-contenido').innerHTML = `
      <div class="hoja-cab">
        <div class="detalle-venta-cab">
          <div>
            <p class="numero-boleta">${esc(venta.numero)}</p>
            <h2>${soles(venta.total)}</h2>
            <p class="muted mini">${esc(fechaCorta(venta.creado_en))} · ${esc(venta.metodo_pago)}</p>
          </div>
        </div>
        <button class="icono-btn" type="button" data-cerrar="hoja-detalle" aria-label="Cerrar">
          <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"><path d="M6 6l12 12M18 6L6 18"/></svg>
        </button>
      </div>
      <p class="muted mini" style="margin-top:6px">${esc(venta.cliente_nombre || 'Clientes varios')}${venta.cliente_doc ? ' · ' + esc(venta.cliente_doc) : ''}${venta.cliente_celular ? ' · ' + esc(venta.cliente_celular) : ''}</p>
      <div class="detalle-items" style="margin-top:14px">${items}</div>
      <div class="detalle-totales">
        <div><span>Op. gravada</span><span>${soles(venta.subtotal)}</span></div>
        <div><span>IGV</span><span>${soles(venta.igv)}</span></div>
        <div class="final"><span>Total</span><span>${soles(venta.total)}</span></div>
      </div>
      <div class="estado-sunat ${sunatClase}">
        ${venta.estado === 'anulada' ? 'Venta anulada. ' : ''}${esc(venta.sunat_mensaje || (venta.sunat_estado === 'aceptada' ? 'Aceptada por SUNAT.' : 'Sin detalle de SUNAT.'))}
      </div>
      <div class="acciones-detalle">
        <a class="btn" href="/api/boleta/${venta.id}" target="_blank" rel="noopener">Ver / imprimir boleta</a>
        ${whatsappBoleta(venta) ? `<a class="btn-secundario" href="${whatsappBoleta(venta)}" target="_blank" rel="noopener">Enviar por WhatsApp</a>` : ''}
        ${puedeReintentar ? '<button class="btn-secundario" type="button" id="btn-reintentar">Reintentar envío a SUNAT</button>' : ''}
        ${venta.estado === 'emitida' ? '<button class="btn-peligro" type="button" id="btn-anular">Anular venta</button>' : ''}
      </div>`;

    $('#btn-anular')?.addEventListener('click', () => anularVenta(venta));
    $('#btn-reintentar')?.addEventListener('click', () => reintentarSunat(venta));
    mostrar('#hoja-detalle');
    if (refrescarSilencioso) $('#toast').classList.add('oculto');
  } catch (error) {
    toast(error.message, 'error');
  }
}

async function anularVenta(venta) {
  if (!confirm(`¿Anular la venta ${venta.numero} por ${soles(venta.total)}? Esta acción no se puede deshacer.`)) return;
  try {
    await api(`/api/ventas/${venta.id}/anular`, { method: 'POST' });
    toast('Venta anulada');
    cerrarHoja('hoja-detalle');
    await refrescar();
  } catch (error) {
    toast(error.message, 'error');
  }
}

async function reintentarSunat(venta) {
  const boton = $('#btn-reintentar');
  if (boton) { boton.disabled = true; boton.textContent = 'Enviando…'; }
  try {
    const actualizada = await api(`/api/ventas/${venta.id}/reintentar-sunat`, { method: 'POST' });
    toast(actualizada.sunat_estado === 'aceptada' ? 'Aceptada por SUNAT' : 'SUNAT devolvió un error', actualizada.sunat_estado === 'aceptada' ? '' : 'error');
    await refrescar();
  } catch (error) {
    toast(error.message, 'error');
    if (boton) { boton.disabled = false; boton.textContent = 'Reintentar envío a SUNAT'; }
  }
}

/* --------------------------------------------------------------- ajustes */
function pintarAjustes() {
  const negocio = estado.negocio || {};
  $('#neg-nombre').value = negocio.nombre || '';
  $('#neg-ruc').value = negocio.ruc || '';
  $('#neg-telefono').value = negocio.telefono || '';
  $('#neg-direccion').value = negocio.direccion || '';
  $('#neg-serie').value = negocio.serie || 'B001';
  $('#neg-igv').value = negocio.igv ?? 18;

  const real = negocio.sunat_modo === 'nubefact';
  const demo = negocio.sunat_modo === 'demo';
  const estadoEmision = $('#estado-emision');
  if (estadoEmision) {
    estadoEmision.textContent = demo
      ? 'Demostración activa: los datos quedan en este navegador y no se envían a SUNAT.'
      : real
        ? 'Emisión activa: los comprobantes se envían a SUNAT mediante el proveedor autorizado.'
        : 'Emisión no activada en esta instalación. No se pueden emitir comprobantes.';
  }

  const catalogo = estado.productos;
  $('#catalogo-cantidad').textContent = `${catalogo.length} productos`;
  $('#lista-catalogo').innerHTML = catalogo.length ? catalogo.map((p) => `
    <div class="catalogo-item">
      <div class="catalogo-datos">
        <div class="catalogo-nombre">${esc(p.nombre)}</div>
        <div class="catalogo-cat">${esc(p.categoria || 'general')}</div>
      </div>
      <div class="catalogo-precio">${soles(p.precio)}</div>
      <div class="catalogo-acciones">
        <button type="button" data-editar="${p.id}" aria-label="Editar ${esc(p.nombre)}">
          <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><path d="M4 20h4l10-10-4-4L4 16v4z"/><path d="M13 5l4 4"/></svg>
        </button>
        <button type="button" data-borrar="${p.id}" aria-label="Eliminar ${esc(p.nombre)}">
          <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><path d="M4 7h16M9 7V4h6v3M6 7l1 13h10l1-13"/></svg>
        </button>
      </div>
    </div>`).join('') : '<p class="vacio mini">Sin productos todavía.</p>';

  // Vista previa del QR de cobro guardado.
  const qr = negocio.qr_pago || '';
  $('#qr-preview').classList.toggle('oculto', !qr);
  if (qr) $('#qr-preview').src = qr;
  $('#btn-quitar-qr').classList.toggle('oculto', !qr);
}

/* Reduce la imagen del QR antes de guardarla: menos peso y carga rápida
   en el celular. Un QR de 440 px se lee perfecto en cualquier pantalla. */
function reducirImagen(archivo, lado = 440) {
  return new Promise((resolve, reject) => {
    if (archivo.size > 8 * 1024 * 1024) {
      reject(new Error('La imagen es muy grande (máximo 8 MB).'));
      return;
    }
    const lector = new FileReader();
    lector.onerror = () => reject(new Error('No se pudo leer la imagen.'));
    lector.onload = () => {
      const img = new Image();
      img.onerror = () => reject(new Error('El archivo no es una imagen válida.'));
      img.onload = () => {
        const escala = Math.min(1, lado / Math.max(img.width, img.height));
        const lienzo = document.createElement('canvas');
        lienzo.width = Math.max(1, Math.round(img.width * escala));
        lienzo.height = Math.max(1, Math.round(img.height * escala));
        const ctx = lienzo.getContext('2d');
        ctx.fillStyle = '#ffffff'; // fondo blanco: el QR debe tener contraste
        ctx.fillRect(0, 0, lienzo.width, lienzo.height);
        ctx.drawImage(img, 0, 0, lienzo.width, lienzo.height);
        resolve(lienzo.toDataURL('image/png'));
      };
      img.src = lector.result;
    };
    lector.readAsDataURL(archivo);
  });
}

async function guardarQr(archivo) {
  try {
    const dataUrl = await reducirImagen(archivo);
    estado.negocio = await api('/api/negocio', { method: 'PUT', body: { qr_pago: dataUrl } });
    pintarAjustes();
    pintarCarrito();
    toast('QR de cobro guardado');
  } catch (error) {
    toast(error.message, 'error');
  }
}

/* ---------------------------------------------------------------- hojas */
function cerrarHoja(id) {
  $(`#${id}`)?.classList.add('oculto');
  if (id === 'hoja-carro') {
    $('#panel-libre').classList.add('oculto');
    $('#btn-libre-carro').classList.remove('oculto');
  }
}

function abrirCarrito(forzar = false) {
  if (!estado.carrito.length && !forzar) {
    toast('Agrega al menos un producto');
    return;
  }
  pintarCarrito();
  mostrar('#hoja-carro');
}

function irA(vista) {
  estado.vista = vista;
  $$('.vista').forEach((seccion) => seccion.classList.add('oculto'));
  $(`#vista-${vista}`)?.classList.remove('oculto');
  $$('#nav-inferior button').forEach((boton) => {
    boton.classList.toggle('activo', boton.dataset.vista === vista);
  });
  if (vista === 'vender') pintarCarrito();
  if (vista === 'ventas') cargarVentas();
  if (vista === 'inicio') pintarCarrito();
  window.scrollTo({ top: 0, behavior: 'instant' });
}

/* --------------------------------------------------------------- eventos */
function conectarEventos() {
  /* --- login --- */
  $('#teclado').addEventListener('click', (evento) => {
    const boton = evento.target.closest('[data-tecla]');
    if (!boton) return;
    const tecla = boton.dataset.tecla;
    if (tecla === 'borrar') {
      estado.pin = estado.pin.slice(0, -1);
    } else if (tecla === 'ok') {
      ingresar();
      return;
    } else if (estado.pin.length < 6) {
      estado.pin += tecla;
    }
    pintarPin();
  });

  /* --- registro --- */
  $('#form-setup').addEventListener('submit', async (evento) => {
    evento.preventDefault();
    const error = $('#setup-error');
    error.classList.add('oculto');
    const nombre = $('#setup-nombre').value.trim();
    const pin = $('#setup-pin').value.trim();
    const pin2 = $('#setup-pin2').value.trim();
    if (!nombre) return mostrarErrorSetup('Escribe el nombre de tu negocio.');
    if (!/^\d{4,6}$/.test(pin)) return mostrarErrorSetup('El PIN debe tener entre 4 y 6 dígitos.');
    if (pin !== pin2) return mostrarErrorSetup('Los PIN no coinciden.');
    const boton = $('#form-setup button[type="submit"]');
    boton.disabled = true;
    boton.textContent = 'Creando…';
    try {
      await api('/api/setup', {
        method: 'POST',
        body: {
          nombre,
          ruc: $('#setup-ruc').value.trim(),
          pin,
        },
      });
      await entrarApp();
    } catch (fallo) {
      mostrarErrorSetup(fallo.message);
    } finally {
      boton.disabled = false;
      boton.textContent = 'Crear mi caja';
    }
  });

  /* --- tema --- */
  $('#btn-tema').addEventListener('click', () => {
    aplicarTema(estado.tema === 'oscuro' ? 'claro' : 'oscuro');
  });

  /* --- navegación --- */
  $('#nav-inferior').addEventListener('click', (evento) => {
    const boton = evento.target.closest('[data-vista]');
    if (boton) irA(boton.dataset.vista);
  });
  document.addEventListener('click', (evento) => {
    const ir = evento.target.closest('[data-ir]');
    if (ir) irA(ir.dataset.ir);
    const cerrar = evento.target.closest('[data-cerrar]');
    if (cerrar) cerrarHoja(cerrar.dataset.cerrar);
  });

  /* --- carrito --- */
  $('#btn-abrir-carro').addEventListener('click', abrirCarrito);
  $('#btn-cobrar').addEventListener('click', cobrar);

  $('#hoja-carro').addEventListener('click', (evento) => {
    const accion = evento.target.closest('[data-accion]');
    if (accion) {
      const indice = Number(accion.dataset.indice);
      const item = estado.carrito[indice];
      if (!item) return;
      if (accion.dataset.accion === 'mas') item.cantidad += 1;
      if (accion.dataset.accion === 'menos') item.cantidad -= 1;
      if (item.cantidad <= 0) estado.carrito.splice(indice, 1);
      pintarCarrito();
    }
    const pago = evento.target.closest('[data-pago]');
    if (pago) {
      estado.metodoPago = pago.dataset.pago;
      pintarCarrito();
    }
    const tipo = evento.target.closest('[data-tipo]');
    if (tipo) {
      estado.tipoComprobante = tipo.dataset.tipo;
      pintarCarrito();
    }
  });

  /* --- hoja: producto suelto --- */
  $('#btn-libre-carro').addEventListener('click', () => {
    $('#panel-libre').classList.remove('oculto');
    $('#btn-libre-carro').classList.add('oculto');
    $('#libre-desc').focus();
  });
  $('#libre-cancelar').addEventListener('click', () => {
    $('#panel-libre').classList.add('oculto');
    $('#btn-libre-carro').classList.remove('oculto');
  });
  $('#libre-agregar').addEventListener('click', () => {
    const descripcion = $('#libre-desc').value.trim();
    const precio = Number(String($('#libre-precio').value).replace(',', '.'));
    const cantidad = Math.floor(Number($('#libre-cantidad').value || 1));
    if (!descripcion) return toast('Escribe qué vendiste', 'error');
    if (!precio || precio <= 0) return toast('Escribe un precio válido', 'error');
    if (!cantidad || cantidad < 1 || cantidad > 9999) return toast('Escribe una cantidad válida', 'error');
    agregarLibre(descripcion, precio, cantidad);
    $('#libre-desc').value = '';
    $('#libre-precio').value = '';
    $('#libre-cantidad').value = '1';
    $('#panel-libre').classList.add('oculto');
    $('#btn-libre-carro').classList.remove('oculto');
  });

  $('#chk-cliente').addEventListener('change', (evento) => {
    $('#campos-cliente').classList.toggle('oculto', !evento.target.checked);
  });

  /* --- éxito --- */
  $('#exito-nueva').addEventListener('click', () => {
    cerrarHoja('hoja-exito');
    irA('vender');
  });
  $('#exito-ver').addEventListener('click', () => {
    // La pestaña nueva pide sesión: la cookie ya está puesta.
  });

  /* --- vender --- */
  $('#buscar-producto').addEventListener('input', (evento) => {
    estado.busqueda = evento.target.value;
    pintarVender();
  });
  $('#chips-categorias').addEventListener('click', (evento) => {
    const chip = evento.target.closest('[data-categoria]');
    if (!chip) return;
    estado.categoria = chip.dataset.categoria;
    pintarVender();
  });
  $('#grilla-productos').addEventListener('click', (evento) => {
    const boton = evento.target.closest('[data-producto]');
    if (!boton) return;
    const producto = estado.productos.find((p) => p.id === Number(boton.dataset.producto));
    if (producto) agregarAlCarrito(producto);
  });
  $('#btn-producto-libre').addEventListener('click', () => {
    abrirCarrito(true);
    $('#panel-libre').classList.remove('oculto');
    $('#btn-libre-carro').classList.add('oculto');
    $('#libre-desc').focus();
  });

  /* --- ventas --- */
  $('#filtro-fechas').addEventListener('click', (evento) => {
    const boton = evento.target.closest('[data-rango]');
    if (!boton) return;
    estado.rango = boton.dataset.rango;
    $$('#filtro-fechas button').forEach((b) => b.classList.toggle('activo', b === boton));
    cargarVentas();
  });
  let temporizadorBusqueda = null;
  $('#buscar-venta').addEventListener('input', (evento) => {
    estado.busquedaVenta = evento.target.value;
    clearTimeout(temporizadorBusqueda);
    temporizadorBusqueda = setTimeout(cargarVentas, 300);
  });
  $('#lista-ventas').addEventListener('click', (evento) => {
    const boton = evento.target.closest('[data-venta]');
    if (boton) abrirDetalle(Number(boton.dataset.venta));
  });
  $('#ultimas-ventas').addEventListener('click', (evento) => {
    const boton = evento.target.closest('[data-venta]');
    if (boton) abrirDetalle(Number(boton.dataset.venta));
  });

  const descargar = (ruta) => {
    const enlace = document.createElement('a');
    enlace.href = ruta;
    enlace.download = '';
    document.body.appendChild(enlace);
    enlace.click();
    enlace.remove();
  };
  $('#btn-csv').addEventListener('click', () => descargar('/api/export.csv'));
  $('#btn-csv-2').addEventListener('click', () => descargar('/api/export.csv'));
  $('#btn-respaldo').addEventListener('click', () => descargar('/api/respaldo'));

  /* --- resumen para el contador --- */
  $('#btn-reporte').addEventListener('click', () => {
    let { desde, hasta } = rangoFechas();
    if (!desde) {
      const hoy = hoyISO();
      desde = `${hoy.slice(0, 7)}-01`;
      hasta = hoy;
    }
    window.open(`/api/reporte?desde=${desde}&hasta=${hasta}`, '_blank');
  });
  $('#btn-reporte-pdf').addEventListener('click', () => {
    let { desde, hasta } = rangoFechas();
    if (!desde) {
      const hoy = hoyISO();
      desde = `${hoy.slice(0, 7)}-01`;
      hasta = hoy;
    }
    descargar(`/api/reporte.pdf?desde=${desde}&hasta=${hasta}`);
  });
  $('#btn-reporte-2').addEventListener('click', () => {
    const hoy = hoyISO();
    window.open(`/api/reporte?desde=${hoy.slice(0, 7)}-01&hasta=${hoy}`, '_blank');
  });
  $('#btn-reporte-pdf-2').addEventListener('click', () => {
    const hoy = hoyISO();
    descargar(`/api/reporte.pdf?desde=${hoy.slice(0, 7)}-01&hasta=${hoy}`);
  });

  /* --- conectividad y cola offline --- */
  $('#btn-sincronizar').addEventListener('click', () => sincronizarCola(false));
  window.addEventListener('online', () => {
    actualizarBanner();
    sincronizarCola(false);
  });
  window.addEventListener('offline', actualizarBanner);

  /* --- ajustes: negocio --- */
  $('#qr-archivo').addEventListener('change', async (evento) => {
    const archivo = evento.target.files && evento.target.files[0];
    evento.target.value = ''; // permite volver a elegir el mismo archivo
    if (archivo) await guardarQr(archivo);
  });
  $('#btn-quitar-qr').addEventListener('click', async () => {
    try {
      estado.negocio = await api('/api/negocio', { method: 'PUT', body: { qr_pago: '' } });
      pintarAjustes();
      pintarCarrito();
      toast('QR eliminado');
    } catch (error) {
      toast(error.message, 'error');
    }
  });

  $('#form-negocio').addEventListener('submit', async (evento) => {
    evento.preventDefault();
    try {
      const negocio = await api('/api/negocio', {
        method: 'PUT',
        body: {
          nombre: $('#neg-nombre').value.trim(),
          ruc: $('#neg-ruc').value.trim(),
          telefono: $('#neg-telefono').value.trim(),
          direccion: $('#neg-direccion').value.trim(),
          serie: $('#neg-serie').value.trim().toUpperCase(),
          igv: Number($('#neg-igv').value),
        },
      });
      estado.negocio = negocio;
      pintarNegocio();
      toast('Datos del negocio guardados');
    } catch (error) {
      toast(error.message, 'error');
    }
  });

  /* --- ajustes: catálogo --- */
  $('#form-producto').addEventListener('submit', async (evento) => {
    evento.preventDefault();
    const nombre = $('#prod-nombre').value.trim();
    const precio = Number(String($('#prod-precio').value).replace(',', '.'));
    const categoria = $('#prod-categoria').value.trim();
    if (!nombre || !precio || precio <= 0) return toast('Completa nombre y precio', 'error');
    try {
      await api('/api/productos', { method: 'POST', body: { nombre, precio, categoria } });
      $('#prod-nombre').value = '';
      $('#prod-precio').value = '';
      $('#prod-categoria').value = '';
      const catalogo = await api('/api/productos');
      estado.productos = catalogo.productos || [];
      pintarAjustes();
      pintarVender();
      toast('Producto agregado');
      $('#prod-nombre').focus();
    } catch (error) {
      toast(error.message, 'error');
    }
  });

  $('#lista-catalogo').addEventListener('click', async (evento) => {
    const editar = evento.target.closest('[data-editar]');
    const borrar = evento.target.closest('[data-borrar]');
    if (editar) {
      const producto = estado.productos.find((p) => p.id === Number(editar.dataset.editar));
      if (!producto) return;
      const nombre = prompt('Nombre del producto', producto.nombre);
      if (nombre === null) return;
      const precio = prompt('Precio en soles', String(producto.precio));
      if (precio === null) return;
      const categoria = prompt('Categoría', producto.categoria || '');
      try {
        await api(`/api/productos/${producto.id}`, {
          method: 'PUT',
          body: {
            nombre: nombre.trim() || producto.nombre,
            precio: Number(String(precio).replace(',', '.')),
            categoria: categoria === null ? producto.categoria : categoria.trim(),
          },
        });
        const catalogo = await api('/api/productos');
        estado.productos = catalogo.productos || [];
        pintarAjustes();
        pintarVender();
        toast('Producto actualizado');
      } catch (error) {
        toast(error.message, 'error');
      }
    }
    if (borrar) {
      const producto = estado.productos.find((p) => p.id === Number(borrar.dataset.borrar));
      if (!producto) return;
      if (!confirm(`¿Quitar «${producto.nombre}» del catálogo?`)) return;
      try {
        await api(`/api/productos/${producto.id}`, { method: 'DELETE' });
        estado.productos = estado.productos.filter((p) => p.id !== producto.id);
        pintarAjustes();
        pintarVender();
        toast('Producto quitado');
      } catch (error) {
        toast(error.message, 'error');
      }
    }
  });

  /* --- ajustes: PIN y sesión --- */
  $('#form-pin').addEventListener('submit', async (evento) => {
    evento.preventDefault();
    const actual = $('#pin-actual').value.trim();
    const nuevo = $('#pin-nuevo').value.trim();
    const nuevo2 = $('#pin-nuevo2').value.trim();
    if (!/^\d{4,6}$/.test(nuevo)) return toast('El PIN nuevo debe tener 4 a 6 dígitos', 'error');
    if (nuevo !== nuevo2) return toast('Los PIN nuevos no coinciden', 'error');
    try {
      await api('/api/negocio/pin', { method: 'POST', body: { actual, nuevo } });
      $('#pin-actual').value = '';
      $('#pin-nuevo').value = '';
      $('#pin-nuevo2').value = '';
      toast('PIN actualizado');
    } catch (error) {
      toast(error.message, 'error');
    }
  });

  $('#btn-salir').addEventListener('click', async () => {
    if (!confirm('¿Cerrar la sesión de la caja?')) return;
    try { await api('/api/logout', { method: 'POST' }); } catch (_) { /* nada */ }
    ocultar('#app');
    estado.negocio = null;
    estado.carrito = [];
    mostrarLogin();
  });

  /* --- PWA --- */
  window.addEventListener('beforeinstallprompt', (evento) => {
    evento.preventDefault();
    estado.instalacion = evento;
    $('#btn-instalar').classList.remove('oculto');
  });
  $('#btn-instalar').addEventListener('click', async () => {
    if (!estado.instalacion) return;
    estado.instalacion.prompt();
    await estado.instalacion.userChoice;
    estado.instalacion = null;
    $('#btn-instalar').classList.add('oculto');
  });

  /* --- teclado y accesibilidad --- */
  document.addEventListener('keydown', (evento) => {
    if (evento.key !== 'Escape') return;
    ['hoja-carro', 'hoja-detalle', 'hoja-exito'].forEach((id) => {
      if (!$(`#${id}`).classList.contains('oculto')) cerrarHoja(id);
    });
  });

  /* --- fondos de hojas --- */
  $$('.hoja-fondo').forEach((fondo) => {
    fondo.addEventListener('click', (evento) => {
      if (evento.target === fondo) cerrarHoja(fondo.id);
    });
  });
}

/* ---------------------------------------------------------------- login */
function mostrarLogin(nombre) {
  ocultar('#cargando', '#pantalla-setup', '#app', '#hoja-carro', '#hoja-detalle', '#hoja-exito');
  mostrar('#pantalla-login');
  if (nombre) $('#login-negocio').textContent = nombre;
  estado.pin = '';
  pintarPin();
  $('#login-error').classList.add('oculto');
}

function pintarPin() {
  const contenedor = $('#pin-puntos');
  if (!contenedor.children.length) {
    contenedor.innerHTML = '<i></i>'.repeat(6);
  }
  Array.from(contenedor.children).forEach((punto, i) => {
    punto.classList.toggle('lleno', i < estado.pin.length);
  });
}

async function ingresar() {
  const error = $('#login-error');
  error.classList.add('oculto');
  if (estado.pin.length < 4) {
    error.textContent = 'Ingresa tu PIN de 4 a 6 dígitos.';
    error.classList.remove('oculto');
    return;
  }
  try {
    await api('/api/login', { method: 'POST', body: { pin: estado.pin } });
    await entrarApp();
  } catch (fallo) {
    estado.pin = '';
    pintarPin();
    error.textContent = fallo.message;
    error.classList.remove('oculto');
    if (navigator.vibrate) navigator.vibrate([30, 40, 30]);
  }
}

function mostrarErrorSetup(mensaje) {
  const error = $('#setup-error');
  error.textContent = mensaje;
  error.classList.remove('oculto');
}

/* ------------------------------------------------------------------ PWA */
function registrarServiceWorker() {
  if (!('serviceWorker' in navigator)) return;
  if (!window.isSecureContext) return; // requiere HTTPS o localhost
  navigator.serviceWorker.register('/sw.js').catch(() => { /* sin SW, la app sigue funcionando */ });
}

/* ------------------------------------------------------------------ init */
conectarEventos();
iniciar();
