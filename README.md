# CobraYa · caja y boleta para micronegocios

**Cobra por Yape, Plin o efectivo, emite boletas y facturas electrónicas, y revisa tus ventas desde el celular.**

CobraYa es una aplicación web instalable (PWA) pensada para bodegas, restaurantes,
peluquerías, puestos de mercado y cualquier micronegocio peruano. Corre en tu propia
computadora, guarda los datos en un archivo SQLite y se usa desde el celular en la
misma red Wi-Fi, sin depender de la nube.

> **Una instalación = un negocio.** No es un servicio multiinquilino ni envía datos a
> servidores de terceros. La única conexión externa es con el proveedor autorizado
> (OSE/PSE) cuando se emite un comprobante electrónico.

---

## 1. Lenguajes y tecnologías

| Capa | Tecnología |
|---|---|
| Backend | **Python 3** (biblioteca estándar, sin frameworks) |
| Base de datos | **SQLite** (incluida en Python) |
| Frontend | **JavaScript** moderno (ES2020+, sin frameworks ni build) |
| Interfaz | **HTML5** semántico |
| Estilos | **CSS3** (responsive, tema claro/oscuro, variables CSS) |
| PWA | `manifest.webmanifest` + **Service Worker** para uso sin conexión |
| PDF | Generador propio en Python (`pdf.py`), sin librerías externas |
| API | HTTP/JSON con `http.server` de la biblioteca estándar |
| Seguridad | PBKDF2-HMAC-SHA256 para el PIN y cookies `HttpOnly` |
| Scripts | **Bash** (`iniciar.sh`) |

**Cero dependencias externas.** No hace falta `npm`, `pip`, Docker ni compilar nada.
Solo Python 3 y un navegador moderno.

---

## 2. Funcionalidades

| Módulo | Qué hace |
|---|---|
| **Vender** | Catálogo táctil, carrito con cantidades, producto suelto (nombre, precio y cantidad), cliente opcional y 5 métodos de pago |
| **Yape / Plin** | Muestra el QR de cobro del negocio y confirma el pago antes de emitir |
| **Comprobantes** | Boleta (serie `B001`) o factura (serie `F001`) con correlativo independiente, IGV incluido y vista imprimible |
| **Clientes** | Boleta sin DNI por defecto; factura exige RUC de 11 dígitos y razón social; DNI/RUC obligatorio desde S/ 700 |
| **Ventas** | Historial con filtros (hoy, 7 días, mes), búsqueda, detalle, anulación y reenvío por WhatsApp |
| **Inicio** | Vendido hoy, ticket promedio, comparación con ayer, gráfico de 7 días, medios de pago y top de productos |
| **SUNAT** | Envío al proveedor autorizado (OSE/PSE) configurado por instalación |
| **Contador** | Resumen del periodo para el SIRE en **PDF A4**, CSV para Excel y resumen HTML imprimible |
| **Offline** | Si se cae la señal, la venta se guarda en el celular y se reintenta al volver |
| **Seguridad** | PIN con PBKDF2, sesión por cookie `HttpOnly`, límite de intentos y validación en el servidor |
| **Respaldo** | Descarga de la base SQLite completa desde la app |
| **Marca** | Nombre del negocio editable; aparece en la app, la boleta, el PDF y el título de la página |

---

## 3. Requisitos

- **Python 3.10 o superior** (probado con Python 3.13 en Debian 13).
- Un navegador moderno (Chrome, Edge, Safari o Firefox).
- Para emitir comprobantes reales: una cuenta con un **OSE/PSE autorizado**
  (por ejemplo Nubefact) y sus credenciales de API.

No se necesita internet para operar la caja; solo para enviar comprobantes al OSE.

---

## 4. Arrancar en 30 segundos

```bash
git clone https://github.com/TU-USUARIO/cobraya.git
cd cobraya
python3 servidor.py
```

Verás algo así:

```
  CobraYa · caja y boleta para micronegocios
  ──────────────────────────────────────────────
  En esta computadora : http://localhost:8787
  Desde tu celular    : http://192.168.1.23:8787
  (celular y PC en la misma red Wi-Fi)
```

1. Abre la dirección en el navegador.
2. Escribe el nombre de tu negocio, un RUC opcional y un PIN de 4 a 6 dígitos.
3. Toca **Vender**, elige productos, el método de pago y **Emitir boleta**.

Los datos quedan en `datos/cobraya.db` (se crea solo).

### Opciones útiles

```bash
python3 servidor.py --puerto 9000      # cambiar puerto
python3 servidor.py --host 127.0.0.1   # solo esta computadora
python3 servidor.py --reset-pin        # si olvidaste el PIN
./iniciar.sh 8787                      # arrancar con un puerto
```

### Instalar en el celular (PWA)

Con el celular en la misma red Wi-Fi, abre `http://IP-DE-TU-PC:8787` en Chrome y usa
**Menú → Instalar aplicación**. Queda con ícono propio y pantalla completa.

> El service worker solo se activa en `localhost` o con HTTPS, por seguridad de los
> navegadores. En red local sin HTTPS la app abre, pero sin caché offline.

---

## 5. Activar la emisión electrónica

CobraYa **no habla directo con SUNAT**. Los comprobantes los valida un proveedor
autorizado (OSE/PSE). Esa configuración es de la instalación, no del cliente:
el dueño del negocio nunca ve URLs ni tokens.

Sin esta configuración la app permite crear el negocio y el catálogo, pero
**no permite vender**, porque no puede emitir comprobantes.

### Activar

```bash
cd cobraya
python3 herramientas/configurar_emision.py \
  --url https://api.nubefact.com/api/v1/TU_RUTA_REAL \
  --token TU_TOKEN_REAL
```

### Ver estado

```bash
python3 herramientas/configurar_emision.py --estado
```

### Desactivar

```bash
python3 herramientas/configurar_emision.py --borrar
```

La configuración se guarda en `datos/emision.json` con permisos `600` y **nunca se
envía al navegador**. Si usas otro proveedor OSE/PSE, solo se adapta `sunat.py`;
la app del celular no cambia.

> **Importante:** CobraYa no está certificado como PSE. La validez del comprobante
> depende del proveedor autorizado que configures.

---

## 6. Cómo se emite un comprobante

```
Celular (HTML + CSS + JS)
   │  POST /api/ventas  (JSON)
   ▼
servidor.py (Python)
   ├─ valida la venta
   ├─ guarda en SQLite y asigna el correlativo
   └─ sunat.py ──► API REST del OSE/PSE
                        └─► SUNAT
   ▼
Responde la venta + estado SUNAT  →  el celular muestra el comprobante
```

### Boleta o factura

En el carrito, arriba de los medios de pago, elige **Boleta** o **Factura**:

- **Boleta:** sale a «Clientes varios» sin DNI. Solo pide documento si el cliente lo
  quiere o si la venta supera **S/ 700**.
- **Factura:** exige **RUC de 11 dígitos** (empieza con 10, 15, 17 o 20) y razón
  social. Usa la serie **F001** y su propio correlativo, sin mezclarse con las boletas.

El servidor vuelve a validar el documento: no confía solo en el navegador.

### Cobrar con Yape o Plin

1. En **Ajustes → Mi negocio → QR de cobro**, sube una captura del QR de tu Yape o Plin.
2. Al vender, elige **Yape** o **Plin**: la app muestra el QR y el total.
3. Confirma el pago manualmente y emite el comprobante.

No se conecta a la API de Yape/Plin: la confirmación es visual, como en la mayoría de
micronegocios.

### Enviar por WhatsApp

Cada comprobante tiene un botón que abre WhatsApp con el detalle en texto. Si el
cliente dejó su celular, abre el chat directo. El PDF se descarga aparte y se adjunta
manualmente, porque WhatsApp no permite adjuntar archivos desde un enlace web.

---

## 7. Resumen para el contador (SIRE)

En **Ventas** o **Ajustes** puedes descargar:

- **PDF A4** con el resumen del periodo: ventas, base imponible, IGV, totales por
  método de pago y detalle de comprobantes.
- **CSV** para Excel.
- **Resumen HTML** imprimible.

El PDF se genera localmente con `pdf.py`, sin dependencias externas.

```bash
curl -o resumen.pdf "http://localhost:8787/api/reporte.pdf?desde=2026-11-01&hasta=2026-11-30"
```

---

## 8. Respaldo y restauración

- Desde la app: **Ajustes → Respaldo** descarga una copia de la base.
- Manual: copia el archivo `datos/cobraya.db` con el servidor detenido.

Para restaurar, reemplaza `datos/cobraya.db` por tu copia y vuelve a arrancar.

---

## 9. Estructura del proyecto

```
cobraya/
├── servidor.py                 API HTTP + archivos estáticos
├── db.py                       esquema, consultas y reportes (SQLite)
├── emision.py                  configuración de emisión de la instalación
├── sunat.py                    envío al proveedor autorizado (OSE/PSE)
├── boleta.py                   comprobante imprimible y reporte del contador
├── pdf.py                      generador de PDF sin dependencias
├── estatico/
│   ├── index.html              interfaz
│   ├── estilos.css             diseño responsive + tema oscuro
│   ├── app.js                  lógica del navegador (JS puro)
│   ├── manifest.webmanifest    metadatos PWA
│   ├── sw.js                   caché offline
│   └── iconos/                 íconos PNG
├── herramientas/
│   ├── configurar_emision.py   activa o desactiva la emisión
│   └── generar_iconos.py       íconos PNG sin dependencias
├── pruebas/
│   └── test_api.py             pruebas de humo de la API
├── datos/                      base y configuración local (ignorados por git)
├── iniciar.sh
└── README.md
```

---

## 10. API resumida

| Método | Ruta | Para qué |
|---|---|---|
| `GET` | `/api/estado` | ¿Está configurado? ¿Hay sesión? ¿Emisión activa? |
| `POST` | `/api/setup` | Crear negocio + PIN |
| `POST` | `/api/login` | Abrir sesión |
| `POST` | `/api/logout` | Cerrar sesión |
| `GET/PUT` | `/api/negocio` | Datos del negocio y QR de cobro |
| `POST` | `/api/negocio/pin` | Cambiar PIN |
| `GET/POST` | `/api/productos` | Catálogo |
| `PUT/DELETE` | `/api/productos/{id}` | Editar o desactivar producto |
| `POST` | `/api/ventas` | Registrar venta y emitir comprobante |
| `GET` | `/api/ventas` | Historial con filtros |
| `POST` | `/api/ventas/{id}/anular` | Anular |
| `POST` | `/api/ventas/{id}/reintentar-sunat` | Reenviar al OSE |
| `GET` | `/api/resumen` | KPIs y gráficos |
| `GET` | `/api/boleta/{id}` | Comprobante imprimible |
| `GET` | `/api/reporte` | Resumen del periodo para el contador |
| `GET` | `/api/reporte.pdf` | El mismo resumen en PDF A4 |
| `GET` | `/api/export.csv` | Exportar ventas para Excel |
| `GET` | `/api/respaldo` | Copia de la base SQLite |

---

## 11. Pruebas

```bash
python3 pruebas/test_api.py
```

Son 7 pruebas de humo que cubren:

- Estado inicial y activación de la emisión.
- Bloqueo de ventas sin emisión configurada.
- Flujo completo de venta, correlativos, boleta y PDF.
- Regla de DNI/RUC desde S/ 700.
- Validaciones de entrada.
- Login, sesión y cambio de PIN.
- Factura con RUC y serie `F001`.
- Payload enviado al proveedor.
- Que el token y la URL nunca se expongan al navegador.

Las pruebas usan una base temporal y simulan la respuesta del OSE, sin llamadas reales.

---

## 12. Seguridad y límites

- Pensado para una **red local de confianza** (la PC del negocio + celulares).
- Para exponerlo a internet: usa **HTTPS** (Caddy/Nginx), un PIN fuerte y un proxy con
  límite de peticiones.
- La anulación es local. En producción también debe enviarse la baja o comunicación
  al OSE.
- El token del proveedor vive en `datos/emision.json` (permisos `600`) y nunca se
  envía al navegador.
- Una instalación atiende a **un solo negocio**. No hay cuentas multiinquilino ni
  sincronización en la nube.
- La validez tributaria depende del proveedor OSE/PSE que configures.

---

## 13. Próximos pasos

1. **Anulación real:** enviar la baja o comunicación al OSE.
2. **QR real de SUNAT** en la boleta (la cadena que devuelve el OSE).
3. **Multi-usuario** por negocio y roles (dueño / cajero).
4. **Backend multiinquilino** (Rust/Axum + PostgreSQL) para suscripciones y marca blanca.
5. **SIRE:** descargar la propuesta de SUNAT y conciliarla con las ventas.
6. **Pasarela de pagos** para confirmar Yape/Plin por webhook.

---

## Licencia

MIT. Úsalo, modifícalo y véndelo como base para tu propio producto.

---

Hecho para que un bodeguero emita su primera boleta **sin saber de contabilidad**.
