/* =====================================================================
   CobraYa · demostración pública para Netlify
   ---------------------------------------------------------------------
   Netlify solo puede entregar archivos: no ejecuta Python ni SQLite.
   Este archivo simula la API del servidor dentro del navegador para que
   la app se pueda probar sin instalar nada.

   Todo queda en localStorage del visitante. No se envía nada a SUNAT y
   los comprobantes generados son de demostración, sin validez tributaria.

   Solo se activa en dominios de Netlify o al abrir con ?demo=1.
   ===================================================================== */
(function () {
  'use strict';

  const parametros = new URLSearchParams(location.search);
  const esDemo =
    /(^|\.)netlify\.(app|com)$/i.test(location.hostname) ||
    parametros.get('demo') === '1';
  if (!esDemo) return;

  // app.js consulta esta bandera para no compartir enlaces /api/ que en
  // Netlify responderían 404.
  window.COBRAYA_DEMO = true;

  const CLAVE = 'cobraya_demo_v1';
  const CLAVE_SESION = 'cobraya_demo_sesion';
  const METODOS_PAGO = ['Efectivo', 'Yape', 'Plin', 'Tarjeta', 'Transferencia'];
  const MESES = {
    '01': 'enero', '02': 'febrero', '03': 'marzo', '04': 'abril',
    '05': 'mayo', '06': 'junio', '07': 'julio', '08': 'agosto',
    '09': 'setiembre', '10': 'octubre', '11': 'noviembre', '12': 'diciembre',
  };

  /* ------------------------------------------------------------ utilidades */
  class ErrorApi extends Error {
    constructor(estado, mensaje) {
      super(mensaje);
      this.estado = estado;
    }
  }

  const redondear = (n) => Math.round((Number(n) + Number.EPSILON) * 100) / 100;

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

  const dos = (n) => String(n).padStart(2, '0');

  function ahoraTexto() {
    const d = new Date();
    return `${d.getFullYear()}-${dos(d.getMonth() + 1)}-${dos(d.getDate())} ` +
      `${dos(d.getHours())}:${dos(d.getMinutes())}:${dos(d.getSeconds())}`;
  }

  function hoyTexto() {
    const d = new Date();
    return `${d.getFullYear()}-${dos(d.getMonth() + 1)}-${dos(d.getDate())}`;
  }

  const soloFecha = (texto) => String(texto || '').slice(0, 10);

  function restarDiasISO(iso, dias) {
    const d = new Date(`${iso}T12:00:00`);
    d.setDate(d.getDate() - dias);
    return `${d.getFullYear()}-${dos(d.getMonth() + 1)}-${dos(d.getDate())}`;
  }

  function fechaLegible(texto) {
    try {
      const [f, h] = String(texto).split(' ');
      const [anio, mes, dia] = f.split('-');
      return `${Number(dia)} de ${MESES[mes] || mes} de ${anio} · ${h.slice(0, 5)}`;
    } catch (_) {
      return String(texto);
    }
  }

  function fechaCorta(texto) {
    try {
      const [anio, mes, dia] = soloFecha(texto).split('-');
      return `${dia}/${mes}/${anio}`;
    } catch (_) {
      return String(texto);
    }
  }

  // Hash sencillo solo para no guardar el PIN en texto plano en la demo.
  // No pretende ser seguridad criptográfica: es un PIN de práctica local.
  function hashPin(pin) {
    let h = 2166136261;
    for (let i = 0; i < String(pin).length; i += 1) {
      h ^= String(pin).charCodeAt(i);
      h = Math.imul(h, 16777619);
    }
    return (h >>> 0).toString(16);
  }

  function texto(valor, campo, maximo, obligatorio = false) {
    const limpio = String(valor ?? '').trim();
    if (obligatorio && !limpio) throw new ErrorApi(400, `Falta ${campo}.`);
    if (limpio.length > maximo) throw new ErrorApi(400, `«${campo}» es demasiado largo.`);
    return limpio;
  }

  function decimal(valor, campo, minimo, maximo) {
    const numero = Number(valor);
    if (!Number.isFinite(numero)) throw new ErrorApi(400, `«${campo}» debe ser un número.`);
    if (numero < minimo || numero > maximo) {
      throw new ErrorApi(400, `«${campo}» fuera de rango.`);
    }
    return redondear(numero);
  }

  const RUC_PREFIJOS = ['10', '15', '17', '20'];

  function documentoCliente(valor, factura) {
    const limpio = String(valor ?? '').replace(/[\s-]/g, '').trim();
    if (factura && !/^\d{11}$/.test(limpio)) {
      throw new ErrorApi(400, 'Para factura necesitas el RUC de 11 dígitos del cliente.');
    }
    if (!limpio) return '';
    if (/^\d{8}$/.test(limpio)) return limpio;
    if (/^\d{11}$/.test(limpio)) {
      if (!RUC_PREFIJOS.includes(limpio.slice(0, 2))) {
        throw new ErrorApi(400, 'El RUC debe empezar con 10, 15, 17 o 20.');
      }
      return limpio;
    }
    throw new ErrorApi(400, 'El documento debe ser DNI de 8 dígitos o RUC de 11 dígitos.');
  }

  function respuestaJson(datos, estado = 200) {
    return new Response(JSON.stringify(datos), {
      status: estado,
      headers: { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' },
    });
  }

  function respuestaTexto(contenido, tipo = 'text/plain; charset=utf-8', estado = 200, extra = {}) {
    return new Response(contenido, {
      status: estado,
      headers: { 'Content-Type': tipo, 'Cache-Control': 'no-store', ...extra },
    });
  }

  function respuestaArchivo(bytes, tipo, nombre) {
    return new Response(new Blob([bytes], { type: tipo }), {
      status: 200,
      headers: {
        'Content-Type': tipo,
        'Content-Disposition': `attachment; filename="${nombre}"`,
        'Cache-Control': 'no-store',
      },
    });
  }

  /* --------------------------------------------------------------- almacén */
  function datosIniciales() {
    return {
      version: 1,
      negocio: null,
      acceso: null,
      productos: [],
      ventas: [],
      contadores: {},
      ultimoProducto: 0,
      ultimoVenta: 0,
    };
  }

  function cargar() {
    try {
      const crudo = JSON.parse(localStorage.getItem(CLAVE) || 'null');
      if (!crudo || typeof crudo !== 'object' || crudo.version !== 1) {
        return datosIniciales();
      }
      return {
        ...datosIniciales(),
        ...crudo,
        productos: Array.isArray(crudo.productos) ? crudo.productos : [],
        ventas: Array.isArray(crudo.ventas) ? crudo.ventas : [],
        contadores: crudo.contadores && typeof crudo.contadores === 'object' ? crudo.contadores : {},
      };
    } catch (_) {
      return datosIniciales();
    }
  }

  let db = cargar();

  function guardar() {
    try {
      localStorage.setItem(CLAVE, JSON.stringify(db));
    } catch (_) {
      throw new ErrorApi(507, 'El navegador no tiene espacio para guardar más datos de demostración. Borra la demo e inténtalo otra vez.');
    }
  }

  const sesionActiva = () => sessionStorage.getItem(CLAVE_SESION) === '1';
  const abrirSesion = () => sessionStorage.setItem(CLAVE_SESION, '1');
  const cerrarSesion = () => sessionStorage.removeItem(CLAVE_SESION);

  function negocioPublico() {
    if (!db.negocio) return { configurado: false };
    return {
      ...db.negocio,
      sunat_modo: 'demo',
      emision_real: false,
      emision_activa: true,
    };
  }

  function exigirSesion() {
    if (!db.negocio) throw new ErrorApi(409, 'Primero configura tu negocio.');
    if (!sesionActiva()) throw new ErrorApi(401, 'Vuelve a ingresar tu PIN.');
  }

  /* ------------------------------------------------------- catálogo y ventas */
  function sembrarProductos() {
    if (db.productos.length) return;
    const ejemplos = [
      ['Pan francés', 0.50, 'Panadería'],
      ['Inca Kola 500 ml', 3.00, 'Bebidas'],
      ['Coca Cola 500 ml', 3.00, 'Bebidas'],
      ['Agua San Luis 625 ml', 2.00, 'Bebidas'],
      ['Arroz 1 kg', 4.50, 'Abarrotes'],
      ['Aceite 1 L', 9.90, 'Abarrotes'],
      ['Leche Gloria tarro', 4.80, 'Abarrotes'],
      ['Huevos (kg)', 8.50, 'Abarrotes'],
      ['Yogurt Gloria 1 L', 6.50, 'Lácteos'],
      ['Galleta Oreo', 1.50, 'Snacks'],
    ];
    const creado = ahoraTexto();
    for (const [nombre, precio, categoria] of ejemplos) {
      db.ultimoProducto += 1;
      db.productos.push({
        id: db.ultimoProducto,
        nombre,
        precio,
        categoria,
        activo: 1,
        creado_en: creado,
      });
    }
  }

  const productosActivos = () => db.productos
    .filter((p) => Number(p.activo) === 1)
    .sort((a, b) => String(a.categoria || '').localeCompare(String(b.categoria || ''), 'es') ||
      String(a.nombre).localeCompare(String(b.nombre), 'es'));

  function ventaConItems(venta) {
    const items = db.ventas
      .filter((v) => v.id === venta.id)
      .length
      ? (venta.items || [])
      : [];
    return {
      ...venta,
      total: redondear(venta.total),
      subtotal: redondear(venta.subtotal),
      igv: redondear(venta.igv),
      items: items.map((i) => ({ ...i, total: redondear(i.total) })),
    };
  }

  function listarVentas({ desde, hasta, metodo, texto: busqueda, limite = 200 } = {}) {
    let lista = db.ventas.slice();
    if (desde) lista = lista.filter((v) => soloFecha(v.creado_en) >= desde);
    if (hasta) lista = lista.filter((v) => soloFecha(v.creado_en) <= hasta);
    if (metodo) lista = lista.filter((v) => v.metodo_pago === metodo);
    if (busqueda) {
      const patron = String(busqueda).toLowerCase();
      lista = lista.filter((v) =>
        String(v.numero).toLowerCase().includes(patron) ||
        String(v.cliente_nombre).toLowerCase().includes(patron) ||
        String(v.cliente_doc).includes(patron));
    }
    lista.sort((a, b) => b.id - a.id);
    return lista.slice(0, Math.max(1, Math.min(Number(limite) || 200, 1000)));
  }

  function suma(desde, hasta) {
    const emitidas = db.ventas.filter((v) =>
      v.estado === 'emitida' && soloFecha(v.creado_en) >= desde && soloFecha(v.creado_en) <= hasta);
    const total = redondear(emitidas.reduce((acc, v) => acc + Number(v.total), 0));
    return {
      boletas: emitidas.length,
      total,
      ticket_promedio: emitidas.length ? redondear(total / emitidas.length) : 0,
    };
  }

  function resumen(dias = 7) {
    const hoy = hoyTexto();
    const ayer = restarDiasISO(hoy, 1);
    const desdeRango = restarDiasISO(hoy, dias - 1);
    const desdeMes = `${hoy.slice(0, 7)}-01`;

    const serie = [];
    for (let i = dias - 1; i >= 0; i -= 1) {
      const dia = restarDiasISO(hoy, i);
      const d = new Date(`${dia}T12:00:00`);
      serie.push({
        fecha: dia,
        etiqueta: d.toLocaleDateString('es-PE', { weekday: 'short', day: '2-digit' }),
        ...suma(dia, dia),
      });
    }

    const emitidasRango = db.ventas.filter((v) =>
      v.estado === 'emitida' && soloFecha(v.creado_en) >= desdeRango && soloFecha(v.creado_en) <= hoy);

    const porMetodo = {};
    for (const venta of emitidasRango) {
      const clave = venta.metodo_pago;
      if (!porMetodo[clave]) porMetodo[clave] = { metodo: clave, total: 0, boletas: 0 };
      porMetodo[clave].total = redondear(porMetodo[clave].total + Number(venta.total));
      porMetodo[clave].boletas += 1;
    }
    const metodos = Object.values(porMetodo).sort((a, b) => b.total - a.total);

    const porProducto = {};
    for (const venta of emitidasRango) {
      for (const item of venta.items || []) {
        const clave = item.descripcion;
        if (!porProducto[clave]) porProducto[clave] = { descripcion: clave, cantidad: 0, total: 0 };
        porProducto[clave].cantidad = redondear(porProducto[clave].cantidad + Number(item.cantidad));
        porProducto[clave].total = redondear(porProducto[clave].total + Number(item.total));
      }
    }
    const topProductos = Object.values(porProducto)
      .sort((a, b) => b.total - a.total)
      .slice(0, 5);

    return {
      hoy: suma(hoy, hoy),
      ayer: suma(ayer, ayer),
      mes: suma(desdeMes, hoy),
      serie,
      metodos,
      top_productos: topProductos,
      ultimas: listarVentas({ limite: 5 }),
    };
  }

  function reportePeriodo(desde, hasta) {
    const emitidas = db.ventas.filter((v) =>
      v.estado === 'emitida' && soloFecha(v.creado_en) >= desde && soloFecha(v.creado_en) <= hasta);
    const anuladas = db.ventas.filter((v) =>
      v.estado === 'anulada' && soloFecha(v.creado_en) >= desde && soloFecha(v.creado_en) <= hasta);

    const total = redondear(emitidas.reduce((acc, v) => acc + Number(v.total), 0));
    const subtotal = redondear(emitidas.reduce((acc, v) => acc + Number(v.subtotal), 0));
    const igv = redondear(emitidas.reduce((acc, v) => acc + Number(v.igv), 0));

    const porDia = {};
    for (const venta of emitidas) {
      const dia = soloFecha(venta.creado_en);
      if (!porDia[dia]) porDia[dia] = { fecha: dia, boletas: 0, total: 0 };
      porDia[dia].boletas += 1;
      porDia[dia].total = redondear(porDia[dia].total + Number(venta.total));
    }

    const porMetodo = {};
    for (const venta of emitidas) {
      const clave = venta.metodo_pago;
      if (!porMetodo[clave]) porMetodo[clave] = { metodo: clave, boletas: 0, total: 0 };
      porMetodo[clave].boletas += 1;
      porMetodo[clave].total = redondear(porMetodo[clave].total + Number(venta.total));
    }

    const detalle = db.ventas
      .filter((v) => soloFecha(v.creado_en) >= desde && soloFecha(v.creado_en) <= hasta)
      .sort((a, b) => a.id - b.id)
      .map((v) => ventaConItems(v));

    return {
      desde,
      hasta,
      boletas: emitidas.length,
      total,
      subtotal,
      igv,
      ticket_promedio: emitidas.length ? redondear(total / emitidas.length) : 0,
      anuladas_cantidad: anuladas.length,
      anuladas_total: redondear(anuladas.reduce((acc, v) => acc + Number(v.total), 0)),
      pendientes_sunat: 0,
      por_dia: Object.values(porDia).sort((a, b) => a.fecha.localeCompare(b.fecha)),
      por_metodo: Object.values(porMetodo).sort((a, b) => b.total - a.total),
      detalle,
    };
  }

  function rangoReporte(consulta) {
    const hoy = hoyTexto();
    const desde = consulta.get('desde') || `${hoy.slice(0, 7)}-01`;
    const hasta = consulta.get('hasta') || hoy;
    for (const [valor, nombre] of [[desde, 'desde'], [hasta, 'hasta']]) {
      if (!/^\d{4}-\d{2}-\d{2}$/.test(valor)) {
        throw new ErrorApi(400, `Fecha «${nombre}» inválida (usa AAAA-MM-DD).`);
      }
    }
    if (desde > hasta) throw new ErrorApi(400, 'La fecha inicial no puede ser mayor que la final.');
    return { desde, hasta };
  }

  /* ------------------------------------------------------------- router API */
  async function manejar(ruta, metodo, consulta, cuerpo) {
    db = cargar();

    /* --- públicas --- */
    if (metodo === 'GET' && ruta === '/api/estado') {
      return respuestaJson({
        configurado: Boolean(db.negocio),
        sesion: sesionActiva(),
        version: 'demo',
        nombre_negocio: (db.negocio || {}).nombre || '',
        modo_sunat: 'demo',
        emision_real: false,
        emision_activa: true,
        demo: true,
      });
    }

    if (metodo === 'POST' && ruta === '/api/setup') {
      if (db.negocio) throw new ErrorApi(409, 'El negocio ya está configurado. Inicia sesión con tu PIN.');
      const nombre = texto(cuerpo.nombre, 'nombre del negocio', 80, true);
      const pin = texto(cuerpo.pin, 'PIN', 6, true);
      if (!/^\d{4,6}$/.test(pin)) throw new ErrorApi(400, 'El PIN debe tener entre 4 y 6 dígitos.');
      db.negocio = {
        id: 1,
        nombre,
        ruc: texto(cuerpo.ruc, 'RUC', 11),
        direccion: '',
        telefono: '',
        serie: 'B001',
        igv: 18,
        qr_pago: '',
        creado_en: ahoraTexto(),
      };
      db.acceso = { pinHash: hashPin(pin) };
      sembrarProductos();
      guardar();
      abrirSesion();
      return respuestaJson({ ok: true, negocio: negocioPublico() }, 201);
    }

    if (metodo === 'POST' && ruta === '/api/login') {
      if (!db.negocio) throw new ErrorApi(409, 'Primero configura tu negocio.');
      const pin = texto(cuerpo.pin, 'PIN', 12);
      if (!db.acceso || db.acceso.pinHash !== hashPin(pin)) {
        throw new ErrorApi(401, 'PIN incorrecto.');
      }
      abrirSesion();
      return respuestaJson({ ok: true });
    }

    /* --- a partir de aquí se requiere sesión --- */
    exigirSesion();

    if (metodo === 'POST' && ruta === '/api/logout') {
      cerrarSesion();
      return respuestaJson({ ok: true });
    }

    if (ruta === '/api/negocio' && metodo === 'GET') {
      return respuestaJson(negocioPublico());
    }

    if (ruta === '/api/negocio' && metodo === 'PUT') {
      if ('nombre' in cuerpo) {
        db.negocio.nombre = texto(cuerpo.nombre, 'nombre', 80, true);
      }
      if ('ruc' in cuerpo) {
        const ruc = texto(cuerpo.ruc, 'RUC', 11);
        if (ruc && !/^\d{11}$/.test(ruc)) {
          throw new ErrorApi(400, 'El RUC debe tener 11 dígitos.');
        }
        db.negocio.ruc = ruc;
      }
      if ('direccion' in cuerpo) db.negocio.direccion = texto(cuerpo.direccion, 'dirección', 120);
      if ('telefono' in cuerpo) db.negocio.telefono = texto(cuerpo.telefono, 'teléfono', 20);
      if ('serie' in cuerpo) {
        const serie = texto(cuerpo.serie, 'serie', 4).toUpperCase();
        if (!/^[BF]\d{3}$/.test(serie)) {
          throw new ErrorApi(400, 'La serie debe ser como B001 (boleta) o F001 (factura).');
        }
        db.negocio.serie = serie;
      }
      if ('igv' in cuerpo) db.negocio.igv = decimal(cuerpo.igv, 'IGV', 0, 30);
      if ('qr_pago' in cuerpo) {
        const qr = texto(cuerpo.qr_pago, 'QR de cobro', 400000);
        if (qr && !/^data:image\/(png|jpeg|webp);base64,[A-Za-z0-9+/=\s]+$/.test(qr)) {
          throw new ErrorApi(400, 'El QR debe ser una imagen PNG, JPG o WebP.');
        }
        db.negocio.qr_pago = qr;
      }
      guardar();
      return respuestaJson(negocioPublico());
    }

    if (ruta === '/api/negocio/pin' && metodo === 'POST') {
      const actual = texto(cuerpo.actual, 'PIN actual', 12);
      const nuevo = texto(cuerpo.nuevo, 'PIN nuevo', 6);
      if (!/^\d{4,6}$/.test(nuevo)) {
        throw new ErrorApi(400, 'El PIN nuevo debe tener entre 4 y 6 dígitos.');
      }
      if (!db.acceso || db.acceso.pinHash !== hashPin(actual)) {
        throw new ErrorApi(401, 'El PIN actual no es correcto.');
      }
      db.acceso.pinHash = hashPin(nuevo);
      guardar();
      return respuestaJson({ ok: true });
    }

    if (ruta === '/api/productos' && metodo === 'GET') {
      return respuestaJson({ productos: productosActivos() });
    }

    if (ruta === '/api/productos' && metodo === 'POST') {
      const nombre = texto(cuerpo.nombre, 'nombre', 80, true);
      const precio = decimal(cuerpo.precio, 'precio', 0, 100000);
      if (precio <= 0) throw new ErrorApi(400, 'El precio debe ser mayor que cero.');
      const categoria = texto(cuerpo.categoria, 'categoría', 40);
      db.ultimoProducto += 1;
      const producto = {
        id: db.ultimoProducto,
        nombre,
        precio,
        categoria,
        activo: 1,
        creado_en: ahoraTexto(),
      };
      db.productos.push(producto);
      guardar();
      return respuestaJson(producto, 201);
    }

    let coincidencia = ruta.match(/^\/api\/productos\/(\d+)$/);
    if (coincidencia && metodo === 'PUT') {
      const id = Number(coincidencia[1]);
      const producto = db.productos.find((p) => p.id === id);
      if (!producto) throw new ErrorApi(404, 'Producto no encontrado.');
      if ('nombre' in cuerpo) producto.nombre = texto(cuerpo.nombre, 'nombre', 80, true);
      if ('precio' in cuerpo) producto.precio = decimal(cuerpo.precio, 'precio', 0.01, 100000);
      if ('categoria' in cuerpo) producto.categoria = texto(cuerpo.categoria, 'categoría', 40);
      if ('activo' in cuerpo) producto.activo = cuerpo.activo ? 1 : 0;
      guardar();
      return respuestaJson(producto);
    }

    if (coincidencia && metodo === 'DELETE') {
      const id = Number(coincidencia[1]);
      const producto = db.productos.find((p) => p.id === id);
      if (!producto) throw new ErrorApi(404, 'Producto no encontrado.');
      producto.activo = 0;
      guardar();
      return respuestaJson({ ok: true });
    }

    if (ruta === '/api/ventas' && metodo === 'GET') {
      const desde = consulta.get('desde') || '';
      const hasta = consulta.get('hasta') || '';
      for (const [valor, nombre] of [[desde, 'desde'], [hasta, 'hasta']]) {
        if (valor && !/^\d{4}-\d{2}-\d{2}$/.test(valor)) {
          throw new ErrorApi(400, `Fecha «${nombre}» inválida (usa AAAA-MM-DD).`);
        }
      }
      const metodoPago = consulta.get('metodo') || '';
      if (metodoPago && !METODOS_PAGO.includes(metodoPago)) {
        throw new ErrorApi(400, 'Método de pago no válido.');
      }
      const busqueda = consulta.get('q') || '';
      const limite = Math.max(1, Math.min(Number(consulta.get('limite') || 200), 1000));
      const ventas = listarVentas({
        desde: desde || undefined,
        hasta: hasta || undefined,
        metodo: metodoPago || undefined,
        texto: busqueda || undefined,
        limite,
      }).map((v) => ventaConItems(v));
      const total = redondear(ventas.filter((v) => v.estado === 'emitida')
        .reduce((acc, v) => acc + Number(v.total), 0));
      return respuestaJson({ ventas, total, cantidad: ventas.length });
    }

    if (ruta === '/api/ventas' && metodo === 'POST') {
      const metodoPago = texto(cuerpo.metodo_pago || 'Efectivo', 'método de pago', 20);
      if (!METODOS_PAGO.includes(metodoPago)) {
        throw new ErrorApi(400, 'Método de pago no válido.');
      }
      const tipo = texto(cuerpo.tipo_comprobante || 'boleta', 'tipo de comprobante', 10).toLowerCase();
      if (!['boleta', 'factura'].includes(tipo)) {
        throw new ErrorApi(400, 'El tipo de comprobante debe ser boleta o factura.');
      }
      const crudos = cuerpo.items;
      if (!Array.isArray(crudos) || !crudos.length) {
        throw new ErrorApi(400, 'Agrega al menos un producto a la venta.');
      }
      if (crudos.length > 100) throw new ErrorApi(400, 'Máximo 100 líneas por venta.');

      const items = crudos.map((crudo, indice) => {
        const numero = indice + 1;
        if (!crudo || typeof crudo !== 'object') {
          throw new ErrorApi(400, `Línea ${numero} inválida.`);
        }
        const descripcion = texto(crudo.descripcion, `descripción (línea ${numero})`, 200, true);
        const cantidad = decimal(crudo.cantidad, `cantidad (línea ${numero})`, 0.01, 100000);
        const precio = decimal(crudo.precio_unitario, `precio (línea ${numero})`, 0, 100000);
        if (precio <= 0) {
          throw new ErrorApi(400, `El precio de la línea ${numero} debe ser mayor que cero.`);
        }
        const productoId = Number.isInteger(crudo.producto_id) ? crudo.producto_id : null;
        return {
          producto_id: productoId,
          descripcion,
          cantidad,
          precio_unitario: precio,
        };
      });

      const total = redondear(items.reduce((acc, i) => acc + i.cantidad * i.precio_unitario, 0));
      const clienteNombre = texto(cuerpo.cliente_nombre, 'cliente', 100);
      const clienteDoc = documentoCliente(cuerpo.cliente_doc, tipo === 'factura');
      if (tipo === 'factura' && !clienteNombre) {
        throw new ErrorApi(400, 'Para factura escribe la razón social del cliente.');
      }
      if (total > 700 && !clienteDoc) {
        throw new ErrorApi(
          400,
          'Las ventas mayores a S/ 700 deben identificar al cliente. Agrega su DNI o RUC para emitir la boleta.',
        );
      }

      const idCliente = texto(cuerpo.id_cliente, 'identificador de la venta', 64);
      if (idCliente && !/^[A-Za-z0-9-]{8,64}$/.test(idCliente)) {
        throw new ErrorApi(400, 'El identificador de la venta no es válido.');
      }
      if (idCliente) {
        const existente = db.ventas.find((v) => v.id_cliente === idCliente);
        if (existente) return respuestaJson(ventaConItems(existente), 201);
      }

      const celular = String(texto(cuerpo.cliente_celular, 'celular', 15)).replace(/\D/g, '');
      if (celular && !/^9\d{8}$/.test(celular)) {
        throw new ErrorApi(400, 'El celular debe tener 9 dígitos y empezar con 9.');
      }

      const serieBase = String(db.negocio.serie || 'B001').toUpperCase();
      const sufijo = /^[BF]\d{3}$/.test(serieBase) ? serieBase.slice(1) : '001';
      const serie = (tipo === 'factura' ? 'F' : 'B') + sufijo;
      const ultimo = Number(db.contadores[serie] || 0) + 1;
      db.contadores[serie] = ultimo;

      const factor = 1 + Number(db.negocio.igv || 18) / 100;
      const subtotal = redondear(total / factor);
      const igv = redondear(total - subtotal);

      db.ultimoVenta += 1;
      const venta = {
        id: db.ultimoVenta,
        numero: `${serie}-${String(ultimo).padStart(8, '0')}`,
        id_cliente: idCliente || '',
        cliente_nombre: clienteNombre || 'CLIENTES VARIOS',
        cliente_doc: clienteDoc || '',
        cliente_celular: celular,
        metodo_pago: metodoPago,
        subtotal,
        igv,
        total,
        estado: 'emitida',
        sunat_estado: 'aceptada',
        sunat_mensaje: 'Demostración: guardada solo en este navegador. No se envió a SUNAT.',
        sunat_hash: '',
        enlace_pdf: '',
        enlace_xml: '',
        creado_en: ahoraTexto(),
        items: items.map((item, indice) => ({
          id: indice + 1,
          venta_id: db.ultimoVenta,
          producto_id: item.producto_id,
          descripcion: item.descripcion,
          cantidad: item.cantidad,
          precio_unitario: item.precio_unitario,
          total: redondear(item.cantidad * item.precio_unitario),
        })),
      };
      db.ventas.push(venta);
      guardar();
      return respuestaJson(ventaConItems(venta), 201);
    }

    coincidencia = ruta.match(/^\/api\/ventas\/(\d+)$/);
    if (coincidencia && metodo === 'GET') {
      const venta = db.ventas.find((v) => v.id === Number(coincidencia[1]));
      if (!venta) throw new ErrorApi(404, 'Venta no encontrada.');
      return respuestaJson(ventaConItems(venta));
    }

    coincidencia = ruta.match(/^\/api\/ventas\/(\d+)\/anular$/);
    if (coincidencia && metodo === 'POST') {
      const venta = db.ventas.find((v) => v.id === Number(coincidencia[1]));
      if (!venta) throw new ErrorApi(404, 'Venta no encontrada.');
      venta.estado = 'anulada';
      guardar();
      return respuestaJson(ventaConItems(venta));
    }

    coincidencia = ruta.match(/^\/api\/ventas\/(\d+)\/reintentar-sunat$/);
    if (coincidencia && metodo === 'POST') {
      throw new ErrorApi(409, 'La demostración no envía comprobantes a SUNAT.');
    }

    if (ruta === '/api/resumen' && metodo === 'GET') {
      const dias = Math.max(1, Math.min(Number(consulta.get('dias') || 7), 90));
      return respuestaJson(resumen(dias));
    }

    coincidencia = ruta.match(/^\/api\/boleta\/(\d+)$/);
    if (coincidencia && metodo === 'GET') {
      const venta = db.ventas.find((v) => v.id === Number(coincidencia[1]));
      if (!venta) throw new ErrorApi(404, 'Comprobante no encontrado.');
      return respuestaTexto(htmlBoleta(db.negocio, ventaConItems(venta)), 'text/html; charset=utf-8');
    }

    if (ruta === '/api/reporte' && metodo === 'GET') {
      const { desde, hasta } = rangoReporte(consulta);
      const datos = reportePeriodo(desde, hasta);
      return respuestaTexto(htmlReporte(db.negocio, datos), 'text/html; charset=utf-8');
    }

    if (ruta === '/api/reporte.pdf' && metodo === 'GET') {
      const { desde, hasta } = rangoReporte(consulta);
      const datos = reportePeriodo(desde, hasta);
      const bytes = generarReportePdf(db.negocio, datos);
      return respuestaArchivo(bytes, 'application/pdf', `resumen-contador-${desde}-a-${hasta}.pdf`);
    }

    if (ruta === '/api/export.csv' && metodo === 'GET') {
      const desde = consulta.get('desde') || '';
      const hasta = consulta.get('hasta') || '';
      const ventas = listarVentas({ desde: desde || undefined, hasta: hasta || undefined, limite: 1000 })
        .map((v) => ventaConItems(v));
      return respuestaTexto(csvVentas(ventas), 'text/csv; charset=utf-8');
    }

    if (ruta === '/api/respaldo' && metodo === 'GET') {
      const respaldo = {
        formato: 'cobraya-demo',
        generado_en: ahoraTexto(),
        negocio: negocioPublico(),
        productos: db.productos,
        ventas: db.ventas,
        contadores: db.contadores,
      };
      return respuestaArchivo(
        new TextEncoder().encode(JSON.stringify(respaldo, null, 2)),
        'application/json; charset=utf-8',
        `respaldo-cobraya-demo-${hoyTexto()}.json`,
      );
    }

    throw new ErrorApi(404, 'Ruta no encontrada.');
  }

  /* --------------------------------------------------------------- informes */
  function csvVentas(ventas) {
    const limpiar = (valor) => {
      const textoLimpio = String(valor ?? '');
      return /[;"\n\r]/.test(textoLimpio)
        ? `"${textoLimpio.replace(/"/g, '""')}"`
        : textoLimpio;
    };
    const filas = [[
      'Comprobante', 'Fecha', 'Cliente', 'Documento', 'Metodo de pago',
      'Op. gravada', 'IGV', 'Total', 'Estado', 'Estado SUNAT', 'Detalle',
    ]];
    for (const venta of ventas) {
      const detalle = (venta.items || [])
        .map((i) => `${Number(i.cantidad)} x ${i.descripcion}`)
        .join(' | ');
      filas.push([
        venta.numero,
        venta.creado_en,
        venta.cliente_nombre,
        venta.cliente_doc,
        venta.metodo_pago,
        Number(venta.subtotal).toFixed(2),
        Number(venta.igv).toFixed(2),
        Number(venta.total).toFixed(2),
        venta.estado,
        'demo',
        detalle,
      ]);
    }
    return `\ufeff${filas.map((fila) => fila.map(limpiar).join(';')).join('\r\n')}\r\n`;
  }

  function htmlBoleta(negocio, venta) {
    const tipo = String(venta.numero).startsWith('F') ? 'Factura electrónica' : 'Boleta electrónica';
    const factor = 1 + Number(negocio.igv || 18) / 100;
    const anulada = venta.estado === 'anulada';

    const filas = (venta.items || []).map((item) => {
      const cantidad = Number(item.cantidad);
      const precio = Number(item.precio_unitario);
      return `
        <tr>
          <td class="cant">${cantidad}</td>
          <td>
            <strong>${esc(item.descripcion)}</strong>
            <span class="unit">Valor unit. ${soles(precio / factor)} · IGV incluido</span>
          </td>
          <td class="num">${soles(precio)}</td>
          <td class="num">${soles(item.total)}</td>
        </tr>`;
    }).join('');

    const mensajeWa = encodeURIComponent(
      `${negocio.nombre || 'Mi negocio'}\n${tipo} ${venta.numero}\n` +
      `Total: ${soles(venta.total)}\nFecha: ${fechaLegible(venta.creado_en)}\n` +
      'Documento de demostración, sin validez ante SUNAT.',
    );
    const celular = String(venta.cliente_celular || '').replace(/\D/g, '');
    const destinoWa = celular.length === 9 ? `51${celular}` : '';

    return `<!DOCTYPE html>
<html lang="es">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<meta name="robots" content="noindex">
<title>${tipo} ${esc(venta.numero)} · Demostración</title>
<style>
  :root { --tinta:#10241f; --suave:#5b6f68; --linea:#dfe7e3; --verde:#0f766e; --ambar:#b54708; }
  * { box-sizing:border-box; }
  body { margin:0; padding:24px 16px 64px; background:#eef3f1; color:var(--tinta);
    font-family:-apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, Arial, sans-serif;
    font-size:14px; line-height:1.45; }
  .acciones { max-width:760px; margin:0 auto 14px; display:flex; gap:8px; flex-wrap:wrap; }
  .btn, .btn-sec { display:inline-flex; align-items:center; gap:6px; border:0; cursor:pointer;
    font:inherit; font-weight:600; padding:10px 16px; border-radius:10px; text-decoration:none;
    background:var(--verde); color:#fff; }
  .btn-sec { background:#fff; color:var(--tinta); border:1px solid var(--linea); }
  .hoja { position:relative; max-width:760px; margin:0 auto; background:#fff; border-radius:14px;
    padding:34px; box-shadow:0 10px 30px rgba(16,36,31,.08); }
  header { display:flex; justify-content:space-between; gap:24px; align-items:flex-start; }
  h1 { font-size:19px; margin:0 0 3px; letter-spacing:-.02em; }
  .muted { color:var(--suave); font-size:12px; margin:2px 0; }
  .doc { text-align:right; }
  .doc .tipo { font-size:11px; letter-spacing:.12em; text-transform:uppercase; color:var(--suave); }
  .doc .numero { font-size:20px; font-weight:700; letter-spacing:-.02em; }
  .badge { display:inline-block; margin-top:8px; padding:3px 9px; border-radius:999px;
    font-size:11px; font-weight:700; background:#fef3e7; color:var(--ambar); }
  hr { border:0; border-top:1px solid var(--linea); margin:20px 0; }
  .cliente { display:grid; grid-template-columns:1fr 1fr; gap:10px 24px; }
  .campo span { display:block; font-size:10.5px; letter-spacing:.08em; text-transform:uppercase; color:var(--suave); }
  .campo strong { font-weight:600; }
  table { width:100%; border-collapse:collapse; margin-top:6px; }
  thead th { text-align:left; font-size:10.5px; letter-spacing:.08em; text-transform:uppercase;
    color:var(--suave); border-bottom:1px solid var(--linea); padding:8px 6px; }
  tbody td { padding:10px 6px; border-bottom:1px solid #f1f5f3; vertical-align:top; }
  td.cant, th.cant { width:46px; }
  td.num, th.num { text-align:right; white-space:nowrap; }
  .unit { display:block; color:var(--suave); font-size:11.5px; }
  .totales { margin-left:auto; width:100%; max-width:300px; margin-top:16px; }
  .totales div { display:flex; justify-content:space-between; padding:5px 0; }
  .totales .final { border-top:1px solid var(--linea); margin-top:6px; padding-top:10px;
    font-size:17px; font-weight:700; }
  .pago { display:flex; gap:10px; flex-wrap:wrap; margin-top:4px; }
  .chip { background:#f4f8f6; border:1px solid var(--linea); border-radius:8px; padding:5px 10px; font-size:12px; }
  .nota { font-size:12px; color:#8a4b08; background:#fff8ef; border:1px dashed #f0c99a;
    padding:10px 12px; border-radius:8px; }
  footer { margin-top:28px; padding-top:14px; border-top:1px solid var(--linea); color:var(--suave); font-size:11.5px; }
  .anulada { position:absolute; inset:0; display:grid; place-items:center; pointer-events:none; }
  .anulada span { border:4px solid rgba(180,35,24,.35); color:rgba(180,35,24,.45);
    font-size:46px; font-weight:800; letter-spacing:.2em; padding:8px 28px;
    transform:rotate(-14deg); border-radius:10px; }
  @media (max-width:560px) {
    body { padding:12px 8px 80px; }
    .hoja { padding:20px 16px; border-radius:10px; }
    header { flex-direction:column; gap:14px; }
    .doc { text-align:left; }
    .cliente { grid-template-columns:1fr; }
  }
  @media print {
    body { background:#fff; padding:0; }
    .acciones { display:none; }
    .hoja { box-shadow:none; border-radius:0; max-width:none; padding:0; }
    @page { margin:14mm; }
  }
</style>
</head>
<body>
  <div class="acciones">
    <button class="btn" type="button" onclick="window.print()">Imprimir / Guardar PDF</button>
    <a class="btn-sec" href="/">Volver a la app</a>
    <a class="btn-sec" href="https://wa.me/${destinoWa}?text=${mensajeWa}" target="_blank" rel="noopener">Enviar por WhatsApp</a>
  </div>

  <article class="hoja">
    ${anulada ? '<div class="anulada"><span>ANULADA</span></div>' : ''}
    <header>
      <div>
        <h1>${esc(negocio.nombre || 'Mi negocio')}</h1>
        <p class="muted">RUC ${esc(negocio.ruc || '—')}</p>
        ${negocio.direccion ? `<p class="muted">${esc(negocio.direccion)}</p>` : ''}
        ${negocio.telefono ? `<p class="muted">Tel. ${esc(negocio.telefono)}</p>` : ''}
      </div>
      <div class="doc">
        <div class="tipo">${tipo}</div>
        <div class="numero">${esc(venta.numero)}</div>
        <span class="badge">DEMO · NO VÁLIDO ANTE SUNAT</span>
      </div>
    </header>

    <hr>

    <section class="cliente">
      <div class="campo"><span>Cliente</span><strong>${esc(venta.cliente_nombre || 'CLIENTES VARIOS')}</strong></div>
      <div class="campo"><span>Documento</span><strong>${esc(venta.cliente_doc || '—')}</strong></div>
      <div class="campo"><span>Fecha de emisión</span><strong>${esc(fechaLegible(venta.creado_en))}</strong></div>
      <div class="campo"><span>Forma de pago</span><strong>${esc(venta.metodo_pago)}</strong></div>
    </section>

    <hr>

    <table>
      <thead>
        <tr><th class="cant">Cant.</th><th>Descripción</th><th class="num">P. unit.</th><th class="num">Total</th></tr>
      </thead>
      <tbody>${filas}
      </tbody>
    </table>

    <div class="totales">
      <div><span>Op. gravada</span><strong>${soles(venta.subtotal)}</strong></div>
      <div><span>IGV (${Number(negocio.igv || 18)}%)</span><strong>${soles(venta.igv)}</strong></div>
      <div class="final"><span>Total</span><span>${soles(venta.total)}</span></div>
    </div>

    <hr>

    <div class="pago">
      <span class="chip">Pago: ${esc(venta.metodo_pago)}</span>
      <span class="chip">Moneda: Soles</span>
      <span class="chip">Comprobante: ${tipo.replace(' electrónica', '')} de demostración</span>
    </div>

    <p class="nota">
      <strong>Demostración.</strong> Este documento se generó en el navegador y no se envió a SUNAT.
      No tiene validez tributaria.
    </p>

    <footer>
      <p>Los datos de esta demostración quedan solo en el navegador del visitante.</p>
      <p>Generado con CobraYa · caja y boleta para micronegocios</p>
    </footer>
  </article>
</body>
</html>`;
  }

  function htmlReporte(negocio, datos) {
    const periodo = `${fechaCorta(datos.desde)} al ${fechaCorta(datos.hasta)}`;
    const filasDia = datos.por_dia.map((d) => `
      <tr><td>${esc(d.fecha)}</td><td class="num">${d.boletas}</td><td class="num">${soles(d.total)}</td></tr>`
    ).join('') || "<tr class='vacio'><td colspan='3'>Sin ventas en el periodo</td></tr>";

    const filasMetodo = datos.por_metodo.map((m) => `
      <tr><td>${esc(m.metodo)}</td><td class="num">${m.boletas}</td><td class="num">${soles(m.total)}</td></tr>`
    ).join('') || "<tr class='vacio'><td colspan='3'>Sin ventas en el periodo</td></tr>";

    const filasVenta = datos.detalle.map((v) => `
      <tr>
        <td>${esc(v.numero)}</td>
        <td>${esc(fechaCorta(v.creado_en))}</td>
        <td>${esc(v.cliente_nombre || 'Clientes varios')}</td>
        <td>${esc(v.cliente_doc || '—')}</td>
        <td>${esc(v.metodo_pago)}</td>
        <td class="num">${soles(v.total)}</td>
        <td>${v.estado === 'anulada' ? 'Anulada' : 'Emitida'}</td>
      </tr>`).join('') || "<tr class='vacio'><td colspan='7'>Sin comprobantes en el periodo</td></tr>";

    const mensaje = encodeURIComponent(
      `Resumen CobraYa · ${negocio.nombre || ''}\n` +
      `Periodo: ${periodo}\n` +
      `Comprobantes emitidos: ${datos.boletas}\n` +
      `Total vendido: ${soles(datos.total)}\n` +
      `IGV desagregado: ${soles(datos.igv)}\n` +
      `Anuladas: ${datos.anuladas_cantidad} (${soles(datos.anuladas_total)})\n` +
      `Ticket promedio: ${soles(datos.ticket_promedio)}\n` +
      'Resumen de demostración, sin validez ante SUNAT.',
    );

    return `<!DOCTYPE html>
<html lang="es">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<meta name="robots" content="noindex">
<title>Resumen de ventas · ${periodo}</title>
<style>
  :root { --tinta:#10241f; --suave:#5b6f68; --linea:#dfe7e3; --verde:#0f766e; }
  * { box-sizing:border-box; }
  body { margin:0; padding:24px 16px 64px; background:#eef3f1; color:var(--tinta);
    font-family:-apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, Arial, sans-serif;
    font-size:13px; line-height:1.45; }
  .acciones { max-width:820px; margin:0 auto 14px; display:flex; gap:8px; flex-wrap:wrap; }
  .acciones-nota { max-width:820px; margin:-6px auto 14px; color:var(--suave); font-size:11.5px; }
  .btn, .btn-sec { display:inline-flex; align-items:center; gap:6px; border:0; cursor:pointer;
    font:inherit; font-weight:600; padding:10px 16px; border-radius:10px; text-decoration:none;
    background:var(--verde); color:#fff; }
  .btn-sec { background:#fff; color:var(--tinta); border:1px solid var(--linea); }
  .hoja { max-width:820px; margin:0 auto; background:#fff; border-radius:14px; padding:34px;
    box-shadow:0 10px 30px rgba(16,36,31,.08); }
  header { display:flex; justify-content:space-between; gap:24px; align-items:flex-start; }
  h1 { font-size:20px; margin:0 0 3px; letter-spacing:-.02em; }
  h2 { font-size:14px; margin:26px 0 10px; letter-spacing:-.01em; }
  .muted { color:var(--suave); font-size:12px; margin:2px 0; }
  .doc { text-align:right; }
  .doc strong { display:block; font-size:16px; }
  .kpis { display:grid; grid-template-columns:repeat(4,1fr); gap:10px; margin-top:22px; }
  .kpi { background:#f6faf8; border:1px solid var(--linea); border-radius:12px; padding:12px; }
  .kpi span { display:block; font-size:10.5px; text-transform:uppercase; letter-spacing:.08em;
    color:var(--suave); margin-bottom:4px; }
  .kpi strong { font-size:17px; font-variant-numeric:tabular-nums; }
  table { width:100%; border-collapse:collapse; }
  th { text-align:left; font-size:10.5px; text-transform:uppercase; letter-spacing:.07em;
    color:var(--suave); padding:7px 6px; border-bottom:1px solid var(--linea); }
  td { padding:8px 6px; border-bottom:1px solid #f1f5f3; vertical-align:top; }
  td.num, th.num { text-align:right; font-variant-numeric:tabular-nums; white-space:nowrap; }
  tr.vacio td { text-align:center; color:var(--suave); padding:18px; }
  .aviso { font-size:12px; color:#8a4b08; background:#fff8ef; border:1px dashed #f0c99a;
    padding:11px 13px; border-radius:9px; margin-top:18px; }
  .aviso strong { color:#8a4b08; }
  footer { margin-top:26px; padding-top:14px; border-top:1px solid var(--linea); color:var(--suave); font-size:11px; }
  @media (max-width:640px) {
    .hoja { padding:20px 14px; }
    .kpis { grid-template-columns:1fr 1fr; }
    header { flex-direction:column; }
    .doc { text-align:left; }
    .tabla-scroll { overflow-x:auto; }
  }
  @media print {
    body { background:#fff; padding:0; }
    .acciones, .acciones-nota { display:none; }
    .hoja { box-shadow:none; border-radius:0; padding:0; max-width:none; }
    @page { margin:14mm; }
  }
</style>
</head>
<body>
  <div class="acciones">
    <button class="btn" type="button" onclick="window.print()">Imprimir / Guardar PDF</button>
    <a class="btn-sec" href="/">Volver a la app</a>
    <a class="btn-sec" href="https://wa.me/?text=${mensaje}" target="_blank" rel="noopener">Enviar resumen por WhatsApp</a>
  </div>
  <p class="acciones-nota">Para descargar el PDF usa «Imprimir / Guardar PDF» y elige «Guardar como PDF». En la app real el PDF se descarga directo.</p>

  <article class="hoja">
    <header>
      <div>
        <h1>${esc(negocio.nombre || 'Mi negocio')}</h1>
        <p class="muted">RUC ${esc(negocio.ruc || '—')}${negocio.direccion ? ` · ${esc(negocio.direccion)}` : ''}</p>
        ${negocio.telefono ? `<p class="muted">Tel. ${esc(negocio.telefono)}</p>` : ''}
      </div>
      <div class="doc">
        <strong>Resumen para el contador</strong>
        <p class="muted">${periodo}</p>
      </div>
    </header>

    <section class="kpis">
      <div class="kpi"><span>Total vendido</span><strong>${soles(datos.total)}</strong></div>
      <div class="kpi"><span>Comprobantes</span><strong>${datos.boletas}</strong></div>
      <div class="kpi"><span>IGV desagregado</span><strong>${soles(datos.igv)}</strong></div>
      <div class="kpi"><span>Ticket promedio</span><strong>${soles(datos.ticket_promedio)}</strong></div>
    </section>

    <h2>Ventas por día</h2>
    <table>
      <thead><tr><th>Fecha</th><th class="num">Comprobantes</th><th class="num">Total</th></tr></thead>
      <tbody>${filasDia}</tbody>
    </table>

    <h2>Por medio de pago</h2>
    <table>
      <thead><tr><th>Medio</th><th class="num">Comprobantes</th><th class="num">Total</th></tr></thead>
      <tbody>${filasMetodo}</tbody>
    </table>

    <h2>Comprobantes del periodo</h2>
    <div class="tabla-scroll">
      <table>
        <thead>
          <tr><th>Comprobante</th><th>Fecha</th><th>Cliente</th><th>Documento</th><th>Pago</th><th class="num">Total</th><th>Estado</th></tr>
        </thead>
        <tbody>${filasVenta}</tbody>
      </table>
    </div>

    <p class="aviso">
      <strong>Demostración:</strong> este resumen se generó con datos guardados en el navegador.
      No se envió a SUNAT y no tiene validez tributaria. En la app real, el resumen ordena las
      ventas del periodo para contrastarlas con el SIRE.
    </p>

    <footer>
      <p>El IGV mostrado es el desagregado de los precios cobrados (IGV incluido); no constituye una declaración tributaria.</p>
      <p>Generado con CobraYa · caja y boleta para micronegocios · ${esc(fechaLegible(ahoraTexto()))}</p>
    </footer>
  </article>
</body>
</html>`;
  }

  /* ------------------------------------------------------------- PDF mínimo */
  const ANCHO = 595.28;
  const ALTO = 841.89;

  function latin1(texto) {
    return String(texto)
      .replace(/[—–]/g, '-')
      .replace(/[“”]/g, '"')
      .replace(/’/g, "'")
      .replace(/…/g, '...')
      .replace(/\t/g, ' ')
      .replace(/[^\x00-\xFF]/g, '?');
  }

  function escaparPdf(texto) {
    return latin1(texto)
      .replace(/\\/g, '\\\\')
      .replace(/\(/g, '\\(')
      .replace(/\)/g, '\\)');
  }

  class Pdf {
    constructor() {
      this.paginas = [[]];
    }

    nuevaPagina() {
      this.paginas.push([]);
    }

    texto(x, y, contenido, tam = 10, negrita = false, gris = 0) {
      const fuente = negrita ? 'F2' : 'F1';
      this.paginas[this.paginas.length - 1].push(
        `BT ${gris.toFixed(2)} g /${fuente} ${tam.toFixed(1)} Tf ` +
        `${x.toFixed(1)} ${y.toFixed(1)} Td (${escaparPdf(contenido)}) Tj ET`,
      );
    }

    textoDerecha(xDerecha, y, contenido, tam = 10, negrita = false, gris = 0) {
      const ancho = String(contenido).length * tam * 0.52;
      this.texto(xDerecha - ancho, y, contenido, tam, negrita, gris);
    }

    linea(x1, y1, x2, y2, gris = 0.85, grosor = 0.6) {
      this.paginas[this.paginas.length - 1].push(
        `${gris.toFixed(2)} G ${grosor.toFixed(1)} w ${x1.toFixed(1)} ${y1.toFixed(1)} m ` +
        `${x2.toFixed(1)} ${y2.toFixed(1)} l S`,
      );
    }

    rectangulo(x, y, ancho, alto, gris = 0.96) {
      this.paginas[this.paginas.length - 1].push(
        `${gris.toFixed(2)} g ${x.toFixed(1)} ${y.toFixed(1)} ${ancho.toFixed(1)} ${alto.toFixed(1)} re f`,
      );
    }

    pie(izquierda = '') {
      const total = this.paginas.length;
      this.paginas.forEach((pagina, indice) => {
        if (izquierda) {
          pagina.push(`BT 0.45 g /F1 8 Tf 40 30 Td (${escaparPdf(izquierda)}) Tj ET`);
        }
        pagina.push(
          `BT 0.45 g /F1 8 Tf 480 30 Td (${escaparPdf(`Página ${indice + 1} de ${total}`)}) Tj ET`,
        );
      });
    }

    guardar() {
      const contenidos = this.paginas.map((pagina) => latin1(pagina.join('\n')));
      const totalPaginas = contenidos.length;
      const objetos = {};
      const hijos = [];

      for (let i = 0; i < totalPaginas; i += 1) {
        const paginaId = 5 + 2 * i;
        const contenidoId = 6 + 2 * i;
        hijos.push(`${paginaId} 0 R`);
        objetos[paginaId] =
          '<< /Type /Page /Parent 2 0 R /MediaBox [0 0 595.28 841.89] ' +
          '/Resources << /Font << /F1 3 0 R /F2 4 0 R >> >> ' +
          `/Contents ${contenidoId} 0 R >>`;
        const cuerpo = contenidos[i];
        objetos[contenidoId] =
          `<< /Length ${cuerpo.length} >>\nstream\n${cuerpo}\nendstream`;
      }

      objetos[1] = '<< /Type /Catalog /Pages 2 0 R >>';
      objetos[2] = `<< /Type /Pages /Kids [${hijos.join(' ')}] /Count ${totalPaginas} >>`;
      objetos[3] = '<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica /Encoding /WinAnsiEncoding >>';
      objetos[4] = '<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica-Bold /Encoding /WinAnsiEncoding >>';

      const maxId = 4 + 2 * totalPaginas;
      const salida = [];
      const push = (texto) => {
        for (let i = 0; i < texto.length; i += 1) {
          salida.push(texto.charCodeAt(i) & 0xFF);
        }
      };

      push('%PDF-1.4\n%âãÏÓ\n');
      const posiciones = new Array(maxId + 1).fill(0);
      for (let numero = 1; numero <= maxId; numero += 1) {
        posiciones[numero] = salida.length;
        push(`${numero} 0 obj\n`);
        push(objetos[numero]);
        push('\nendobj\n');
      }

      const inicioXref = salida.length;
      push(`xref\n0 ${maxId + 1}\n`);
      push('0000000000 65535 f \n');
      for (let numero = 1; numero <= maxId; numero += 1) {
        push(`${String(posiciones[numero]).padStart(10, '0')} 00000 n \n`);
      }
      push(
        `trailer\n<< /Size ${maxId + 1} /Root 1 0 R >>\n` +
        `startxref\n${inicioXref}\n%%EOF\n`,
      );
      return new Uint8Array(salida);
    }
  }

  function envolver(texto, limite) {
    const lineas = [];
    let actual = '';
    for (const palabra of String(texto).split(/\s+/)) {
      if ((actual + ' ' + palabra).trim().length <= limite) {
        actual = `${actual} ${palabra}`.trim();
      } else {
        if (actual) lineas.push(actual);
        actual = palabra;
      }
    }
    if (actual) lineas.push(actual);
    return lineas.length ? lineas : [''];
  }

  function generarReportePdf(negocio, datos) {
    const periodo =
      `${fechaCorta(datos.desde)} al ${fechaCorta(datos.hasta)}`;

    const doc = new Pdf();
    let y = 800;

    const asegurar = (espacio) => {
      if (y - espacio < 60) {
        doc.nuevaPagina();
        y = 800;
      }
    };

    const cabeceraTabla = (titulo, columnas) => {
      asegurar(70);
      doc.texto(40, y, titulo, 10.5, true);
      y -= 15;
      for (const [x, etiqueta, alineacion] of columnas) {
        if (alineacion === 'r') doc.textoDerecha(x, y, etiqueta.toUpperCase(), 7.2, false, 0.45);
        else doc.texto(x, y, etiqueta.toUpperCase(), 7.2, false, 0.45);
      }
      y -= 5;
      doc.linea(40, y, 555, y, 0.84, 0.7);
      y -= 12;
    };

    const filaTabla = (valores, columnas, tam = 9.2, gris = 0.12) => {
      asegurar(20);
      columnas.forEach(([x, , alineacion], indice) => {
        const valor = valores[indice] ?? '';
        if (alineacion === 'r') doc.textoDerecha(x, y, valor, tam, false, gris);
        else doc.texto(x, y, valor, tam, false, gris);
      });
      y -= 12.5;
    };

    /* encabezado */
    doc.texto(40, y, negocio.nombre || 'Mi negocio', 15, true);
    let lineaRuc = `RUC ${negocio.ruc || '—'}`;
    if (negocio.direccion) lineaRuc += ` · ${negocio.direccion}`;
    if (negocio.telefono) lineaRuc += ` · Tel. ${negocio.telefono}`;
    doc.texto(40, y - 14, lineaRuc, 8.3, false, 0.42);
    doc.textoDerecha(555, y, 'RESUMEN PARA EL CONTADOR · DEMO', 9.5, true);
    doc.textoDerecha(555, y - 13, periodo, 8.3, false, 0.42);
    y -= 24;
    doc.linea(40, y, 555, y, 0.8, 0.8);
    y -= 20;

    /* indicadores */
    const cajas = [
      ['Total vendido', soles(datos.total)],
      ['Comprobantes', String(datos.boletas)],
      ['IGV desagregado', soles(datos.igv)],
      ['Ticket promedio', soles(datos.ticket_promedio)],
    ];
    const anchoCaja = (555 - 40 - 8 * 3) / 4;
    cajas.forEach(([etiqueta, valor], indice) => {
      const x = 40 + indice * (anchoCaja + 8);
      doc.rectangulo(x, y - 46, anchoCaja, 46, 0.965);
      doc.texto(x + 9, y - 15, etiqueta.toUpperCase(), 6.6, false, 0.45);
      doc.texto(x + 9, y - 34, valor, 12.5, true);
    });
    y -= 64;

    /* ventas por día */
    const columnasDia = [[40, 'Fecha', 'l'], [430, 'Comprobantes', 'r'], [555, 'Total', 'r']];
    cabeceraTabla('Ventas por día', columnasDia);
    if (datos.por_dia.length) {
      for (const dia of datos.por_dia) {
        filaTabla([dia.fecha, String(dia.boletas), soles(dia.total)], columnasDia);
      }
    } else {
      filaTabla(['Sin ventas en el periodo', '', ''], columnasDia, 9.2, 0.45);
    }
    y -= 8;

    /* medios de pago */
    const columnasPago = [[40, 'Medio', 'l'], [430, 'Comprobantes', 'r'], [555, 'Total', 'r']];
    cabeceraTabla('Por medio de pago', columnasPago);
    if (datos.por_metodo.length) {
      for (const metodo of datos.por_metodo) {
        filaTabla([metodo.metodo, String(metodo.boletas), soles(metodo.total)], columnasPago);
      }
    } else {
      filaTabla(['Sin ventas en el periodo', '', ''], columnasPago, 9.2, 0.45);
    }
    y -= 8;

    /* comprobantes */
    const columnasDetalle = [
      [40, 'Comprobante', 'l'],
      [130, 'Fecha', 'l'],
      [200, 'Cliente', 'l'],
      [300, 'Documento', 'l'],
      [358, 'Pago', 'l'],
      [470, 'Total', 'r'],
      [480, 'Estado', 'l'],
    ];
    cabeceraTabla('Comprobantes del periodo', columnasDetalle);
    if (datos.detalle.length) {
      for (const venta of datos.detalle) {
        filaTabla([
          String(venta.numero || ''),
          fechaCorta(venta.creado_en || ''),
          String(venta.cliente_nombre || 'Clientes varios').slice(0, 19),
          String(venta.cliente_doc || '—').slice(0, 11),
          String(venta.metodo_pago || '').slice(0, 13),
          soles(venta.total || 0),
          venta.estado === 'anulada' ? 'Anulada' : 'Emitida',
        ], columnasDetalle, 8.4);
      }
    } else {
      filaTabla(['Sin comprobantes en el periodo', '', '', '', '', '', ''], columnasDetalle, 9.2, 0.45);
    }
    y -= 14;

    /* nota */
    let aviso =
      'DEMOSTRACIÓN: este resumen se generó en el navegador y no tiene validez ante SUNAT. ' +
      'En la app real, este documento ordena las ventas del periodo para contrastarlas con el SIRE. ';
    if (datos.anuladas_cantidad) {
      aviso += `Se anularon ${datos.anuladas_cantidad} comprobante(s) por ${soles(datos.anuladas_total)}.`;
    }
    const lineasAviso = envolver(aviso, 104);
    const altoAviso = 12 + lineasAviso.length * 10.5;
    asegurar(altoAviso + 30);
    doc.rectangulo(40, y - altoAviso, 515, altoAviso, 0.975);
    y -= 15;
    for (const linea of lineasAviso) {
      doc.texto(50, y, linea, 8.1, false, 0.28);
      y -= 10.5;
    }
    y -= 12;

    /* pie */
    doc.linea(40, y, 555, y, 0.86, 0.6);
    y -= 13;
    doc.texto(
      40, y,
      'El IGV mostrado es el desagregado de los precios cobrados (IGV incluido); ' +
      'no constituye una declaración tributaria.',
      7.4, false, 0.45,
    );
    y -= 10;
    doc.texto(
      40, y,
      `Generado con CobraYa · demostración · ${fechaLegible(ahoraTexto())}`,
      7.4, false, 0.45,
    );

    doc.pie('CobraYa · resumen para el contador · demo');
    return doc.guardar();
  }

  /* ------------------------------------------------------ interceptar fetch */
  const fetchOriginal = window.fetch ? window.fetch.bind(window) : null;

  window.fetch = async function fetchDemo(recurso, opciones = {}) {
    let url;
    try {
      const direccion = typeof recurso === 'string' ? recurso : recurso.url;
      url = new URL(direccion, location.href);
    } catch (_) {
      if (fetchOriginal) return fetchOriginal(recurso, opciones);
      throw new TypeError('Dirección no válida');
    }

    if (url.origin !== location.origin || !url.pathname.startsWith('/api/')) {
      if (fetchOriginal) return fetchOriginal(recurso, opciones);
      return Promise.reject(new TypeError('fetch no disponible'));
    }

    const metodo = String(
      opciones.method || (typeof recurso === 'string' ? 'GET' : recurso.method) || 'GET',
    ).toUpperCase();

    let cuerpo = {};
    if (opciones.body !== undefined && opciones.body !== null) {
      if (typeof opciones.body === 'string') {
        try {
          cuerpo = JSON.parse(opciones.body || '{}');
        } catch (_) {
          return respuestaJson({ error: 'El cuerpo de la petición no es JSON válido.' }, 400);
        }
      } else if (typeof opciones.body === 'object') {
        cuerpo = opciones.body;
      }
    }

    try {
      return await manejar(url.pathname, metodo, url.searchParams, cuerpo);
    } catch (error) {
      if (error instanceof ErrorApi) {
        return respuestaJson({ error: error.message }, error.estado);
      }
      console.error('Demo CobraYa:', error);
      return respuestaJson({ error: 'Error interno de la demostración.' }, 500);
    }
  };

  /* ----------------------------------------- enlaces, ventanas y descargas */
  function nombreDescarga(url, tipo) {
    const hoy = hoyTexto();
    if (url.pathname === '/api/reporte.pdf') {
      const desde = url.searchParams.get('desde') || hoy;
      const hasta = url.searchParams.get('hasta') || hoy;
      return `resumen-contador-${desde}-a-${hasta}.pdf`;
    }
    if (url.pathname === '/api/export.csv') return `ventas-${hoy}.csv`;
    if (url.pathname === '/api/respaldo') return `respaldo-cobraya-demo-${hoy}.json`;
    return `cobraya-${hoy}.${tipo === 'application/pdf' ? 'pdf' : 'txt'}`;
  }

  function descargarBlob(blob, nombre) {
    const enlace = document.createElement('a');
    enlace.href = URL.createObjectURL(blob);
    enlace.download = nombre;
    document.body.appendChild(enlace);
    enlace.click();
    enlace.remove();
    setTimeout(() => URL.revokeObjectURL(enlace.href), 60000);
  }

  async function abrirEnlaceDemo(url, pestanaNueva = true) {
    const esHtml = url.pathname.startsWith('/api/boleta/') || url.pathname === '/api/reporte';
    const ventana = pestanaNueva ? window.open('', '_blank') : null;

    try {
      const respuesta = await window.fetch(url.href, {});
      if (!respuesta.ok) {
        const datos = await respuesta.json().catch(() => ({}));
        if (ventana) ventana.close();
        window.dispatchEvent(new CustomEvent('cobraya-demo-error', {
          detail: datos.error || 'No se pudo generar el documento.',
        }));
        return;
      }

      if (esHtml) {
        const html = await respuesta.text();
        const blob = new Blob([html], { type: 'text/html; charset=utf-8' });
        const enlace = URL.createObjectURL(blob);
        if (ventana) ventana.location.replace(enlace);
        else location.href = enlace;
        setTimeout(() => URL.revokeObjectURL(enlace), 60000);
        return;
      }

      const blob = await respuesta.blob();
      descargarBlob(blob, nombreDescarga(url, blob.type));
    } catch (error) {
      if (ventana) ventana.close();
      window.dispatchEvent(new CustomEvent('cobraya-demo-error', {
        detail: 'No se pudo generar el archivo.',
      }));
      console.error('Demo CobraYa:', error);
    }
  }

  // Botones de la app que abren una pestaña nueva con HTML (boleta, reporte).
  const abrirOriginal = window.open ? window.open.bind(window) : null;
  window.open = function abrirDemo(url, ...resto) {
    if (typeof url === 'string') {
      try {
        const destino = new URL(url, location.href);
        if (destino.origin === location.origin && destino.pathname.startsWith('/api/')) {
          abrirEnlaceDemo(destino, true);
          return null;
        }
      } catch (_) { /* deja pasar */ }
    }
    return abrirOriginal ? abrirOriginal(url, ...resto) : null;
  };

  // Enlaces y descargas generados por app.js (boleta, CSV, respaldo, PDF).
  document.addEventListener('click', (evento) => {
    const enlace = evento.target.closest('a[href]');
    if (!enlace) return;
    let destino;
    try {
      destino = new URL(enlace.getAttribute('href'), location.href);
    } catch (_) {
      return;
    }
    if (destino.origin !== location.origin || !destino.pathname.startsWith('/api/')) return;

    evento.preventDefault();
    evento.stopPropagation();
    const pestanaNueva = enlace.target === '_blank';
    abrirEnlaceDemo(destino, pestanaNueva);
  }, true);

  window.addEventListener('cobraya-demo-error', (evento) => {
    const nodo = document.querySelector('#toast');
    if (nodo) {
      nodo.textContent = evento.detail;
      nodo.className = 'toast error';
      nodo.classList.remove('oculto');
      setTimeout(() => nodo.classList.add('oculto'), 3600);
    } else {
      alert(evento.detail);
    }
  });

  /* --------------------------------------------- avisos de la demostración */
  function ajustarAvisos() {
    const ayuda = document.querySelector('#pantalla-login .muted.mini');
    if (ayuda) {
      ayuda.innerHTML =
        'Demostración: los datos quedan en este navegador.<br>' +
        'Si olvidas tu PIN, borra los datos del sitio y vuelve a empezar.';
    }
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', ajustarAvisos);
  } else {
    ajustarAvisos();
  }
}());
