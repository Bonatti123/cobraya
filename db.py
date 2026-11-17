"""Capa de datos de CobraYa.

SQLite puro, sin dependencias externas. Un solo negocio por instalación
(el MVP está pensado para una bodega / puesto / micronegocio).
"""

from __future__ import annotations

import datetime as dt
import hashlib
import os
import secrets
import sqlite3

try:  # Zona horaria de Perú (tzdata del sistema)
    from zoneinfo import ZoneInfo

    ZONA = ZoneInfo("America/Lima")
except Exception:  # pragma: no cover - respaldo si no hay tzdata
    ZONA = dt.timezone(dt.timedelta(hours=-5))

BASE = os.path.dirname(os.path.abspath(__file__))
DIR_DATOS = os.path.join(BASE, "datos")
RUTA_DB = os.environ.get("COBRAYA_DB", os.path.join(DIR_DATOS, "cobraya.db"))


# ----------------------------------------------------------------------
# Utilidades de fecha
# ----------------------------------------------------------------------
def ahora() -> dt.datetime:
    return dt.datetime.now(ZONA)


def ahora_texto() -> str:
    return ahora().strftime("%Y-%m-%d %H:%M:%S")


def hoy_texto() -> str:
    return ahora().strftime("%Y-%m-%d")


# ----------------------------------------------------------------------
# Conexión
# ----------------------------------------------------------------------
def conectar() -> sqlite3.Connection:
    os.makedirs(os.path.dirname(RUTA_DB), exist_ok=True)
    con = sqlite3.connect(RUTA_DB, timeout=20)
    con.row_factory = sqlite3.Row
    con.execute("PRAGMA foreign_keys = ON")
    return con


ESQUEMA = """
CREATE TABLE IF NOT EXISTS negocio (
    id              INTEGER PRIMARY KEY CHECK (id = 1),
    nombre          TEXT NOT NULL,
    ruc             TEXT DEFAULT '',
    direccion       TEXT DEFAULT '',
    telefono        TEXT DEFAULT '',
    -- Imagen del QR de cobro del negocio (Yape/Plin), guardada como data URL.
    qr_pago         TEXT DEFAULT '',
    serie           TEXT NOT NULL DEFAULT 'B001',
    igv             REAL NOT NULL DEFAULT 18.0,
    pin_hash        TEXT NOT NULL,
    creado_en       TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS productos (
    id          INTEGER PRIMARY KEY AUTOINCREMENT,
    nombre      TEXT NOT NULL,
    precio      REAL NOT NULL,
    categoria   TEXT DEFAULT '',
    activo      INTEGER NOT NULL DEFAULT 1,
    creado_en   TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS ventas (
    id              INTEGER PRIMARY KEY AUTOINCREMENT,
    numero          TEXT NOT NULL UNIQUE,
    id_cliente      TEXT DEFAULT '',
    cliente_nombre  TEXT DEFAULT 'CLIENTES VARIOS',
    cliente_doc     TEXT DEFAULT '',
    -- Celular opcional para reenviar la boleta por WhatsApp.
    cliente_celular TEXT DEFAULT '',
    metodo_pago     TEXT NOT NULL,
    subtotal        REAL NOT NULL,
    igv             REAL NOT NULL,
    total           REAL NOT NULL,
    estado          TEXT NOT NULL DEFAULT 'emitida',
    sunat_estado    TEXT NOT NULL DEFAULT 'pendiente',
    sunat_mensaje   TEXT DEFAULT '',
    sunat_hash      TEXT DEFAULT '',
    enlace_pdf      TEXT DEFAULT '',
    enlace_xml      TEXT DEFAULT '',
    creado_en       TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS venta_items (
    id               INTEGER PRIMARY KEY AUTOINCREMENT,
    venta_id         INTEGER NOT NULL REFERENCES ventas(id) ON DELETE CASCADE,
    producto_id      INTEGER,
    descripcion      TEXT NOT NULL,
    cantidad         REAL NOT NULL,
    precio_unitario  REAL NOT NULL,
    total            REAL NOT NULL
);

CREATE TABLE IF NOT EXISTS contadores (
    serie   TEXT PRIMARY KEY,
    ultimo  INTEGER NOT NULL DEFAULT 0
);

CREATE INDEX IF NOT EXISTS idx_ventas_fecha ON ventas(creado_en);
CREATE INDEX IF NOT EXISTS idx_items_venta ON venta_items(venta_id);
"""


def _migrar(con: sqlite3.Connection) -> None:
    """Agrega columnas nuevas a bases de datos creadas por versiones previas.

    SQLite no tiene ALTER TABLE completo, así que revisamos qué columnas
    existen y agregamos solo las que faltan.
    """
    columnas = {fila["name"] for fila in con.execute("PRAGMA table_info(ventas)")}
    faltantes = {
        "id_cliente": "TEXT DEFAULT ''",
        "cliente_celular": "TEXT DEFAULT ''",
        "enlace_pdf": "TEXT DEFAULT ''",
        "enlace_xml": "TEXT DEFAULT ''",
    }
    for nombre, definicion in faltantes.items():
        if nombre not in columnas:
            con.execute(f"ALTER TABLE ventas ADD COLUMN {nombre} {definicion}")

    # El QR de cobro se agregó después; las bases antiguas no lo tienen.
    columnas_negocio = {fila["name"] for fila in con.execute("PRAGMA table_info(negocio)")}
    if "qr_pago" not in columnas_negocio:
        con.execute("ALTER TABLE negocio ADD COLUMN qr_pago TEXT DEFAULT ''")
    # La clave de idempotencia evita boletas duplicadas cuando el celular
    # reintenta enviar una venta que sí llegó al servidor.
    con.execute(
        "CREATE UNIQUE INDEX IF NOT EXISTS idx_ventas_id_cliente "
        "ON ventas(id_cliente) WHERE id_cliente <> ''"
    )


def inicializar() -> None:
    con = conectar()
    try:
        con.executescript(ESQUEMA)
        _migrar(con)
        con.commit()
        try:
            con.execute("PRAGMA journal_mode = WAL")
        except sqlite3.DatabaseError:
            pass
    finally:
        con.close()


# ----------------------------------------------------------------------
# PIN
# ----------------------------------------------------------------------
_ITERACIONES = 180_000


def hash_pin(pin: str) -> str:
    sal = secrets.token_hex(16)
    derivado = hashlib.pbkdf2_hmac(
        "sha256", pin.encode("utf-8"), sal.encode("utf-8"), _ITERACIONES
    )
    return f"pbkdf2_sha256${_ITERACIONES}${sal}${derivado.hex()}"


def verificar_pin(pin: str, guardado: str) -> bool:
    try:
        algoritmo, iteraciones, sal, esperado = guardado.split("$", 3)
        if algoritmo != "pbkdf2_sha256":
            return False
        derivado = hashlib.pbkdf2_hmac(
            "sha256", pin.encode("utf-8"), sal.encode("utf-8"), int(iteraciones)
        )
        return secrets.compare_digest(derivado.hex(), esperado)
    except (ValueError, TypeError):
        return False


# ----------------------------------------------------------------------
# Negocio
# ----------------------------------------------------------------------
CAMPOS_NEGOCIO = (
    "nombre",
    "ruc",
    "direccion",
    "telefono",
    "qr_pago",
    "serie",
    "igv",
)


def obtener_negocio() -> dict | None:
    con = conectar()
    try:
        fila = con.execute("SELECT * FROM negocio WHERE id = 1").fetchone()
        if not fila:
            return None
        datos = dict(fila)
        datos.pop("pin_hash", None)
        datos["configurado"] = True
        return datos
    finally:
        con.close()


def crear_negocio(datos: dict) -> dict:
    con = conectar()
    try:
        con.execute(
            """INSERT INTO negocio
               (id, nombre, ruc, direccion, telefono, serie, igv, pin_hash, creado_en)
               VALUES (1, ?, ?, ?, ?, ?, ?, ?, ?)""",
            (
                datos["nombre"],
                datos.get("ruc", ""),
                datos.get("direccion", ""),
                datos.get("telefono", ""),
                datos.get("serie", "B001"),
                float(datos.get("igv", 18.0)),
                hash_pin(datos["pin"]),
                ahora_texto(),
            ),
        )
        con.commit()
        return obtener_negocio() or {}
    finally:
        con.close()


def actualizar_negocio(datos: dict) -> dict:
    campos, valores = [], []
    for campo in CAMPOS_NEGOCIO:
        if campo in datos:
            campos.append(f"{campo} = ?")
            valores.append(datos[campo])
    if not campos:
        return obtener_negocio() or {}
    valores.append(1)
    con = conectar()
    try:
        con.execute(f"UPDATE negocio SET {', '.join(campos)} WHERE id = ?", valores)
        con.commit()
        return obtener_negocio() or {}
    finally:
        con.close()


def pin_guardado() -> str:
    con = conectar()
    try:
        fila = con.execute("SELECT pin_hash FROM negocio WHERE id = 1").fetchone()
        return fila["pin_hash"] if fila else ""
    finally:
        con.close()


def cambiar_pin(nuevo: str) -> None:
    con = conectar()
    try:
        con.execute("UPDATE negocio SET pin_hash = ? WHERE id = 1", (hash_pin(nuevo),))
        con.commit()
    finally:
        con.close()


# ----------------------------------------------------------------------
# Productos
# ----------------------------------------------------------------------
def listar_productos(solo_activos: bool = True) -> list[dict]:
    con = conectar()
    try:
        sql = "SELECT * FROM productos"
        if solo_activos:
            sql += " WHERE activo = 1"
        sql += " ORDER BY categoria, nombre"
        return [dict(f) for f in con.execute(sql).fetchall()]
    finally:
        con.close()


def crear_producto(nombre: str, precio: float, categoria: str = "") -> dict:
    con = conectar()
    try:
        cur = con.execute(
            "INSERT INTO productos (nombre, precio, categoria, activo, creado_en) VALUES (?, ?, ?, 1, ?)",
            (nombre, precio, categoria, ahora_texto()),
        )
        con.commit()
        fila = con.execute("SELECT * FROM productos WHERE id = ?", (cur.lastrowid,)).fetchone()
        return dict(fila)
    finally:
        con.close()


def actualizar_producto(pid: int, datos: dict) -> dict | None:
    campos, valores = [], []
    for campo in ("nombre", "precio", "categoria", "activo"):
        if campo in datos:
            campos.append(f"{campo} = ?")
            valores.append(datos[campo])
    if not campos:
        return obtener_producto(pid)
    valores.append(pid)
    con = conectar()
    try:
        con.execute(f"UPDATE productos SET {', '.join(campos)} WHERE id = ?", valores)
        con.commit()
        return obtener_producto(pid)
    finally:
        con.close()


def obtener_producto(pid: int) -> dict | None:
    con = conectar()
    try:
        fila = con.execute("SELECT * FROM productos WHERE id = ?", (pid,)).fetchone()
        return dict(fila) if fila else None
    finally:
        con.close()


def eliminar_producto(pid: int) -> bool:
    """Baja lógica: conserva el historial de ventas."""
    con = conectar()
    try:
        cur = con.execute("UPDATE productos SET activo = 0 WHERE id = ?", (pid,))
        con.commit()
        return cur.rowcount > 0
    finally:
        con.close()


def sembrar_productos() -> None:
    """Catálogo de ejemplo para que la app no arranque vacía."""
    ejemplos = [
        ("Pan francés", 0.50, "Panadería"),
        ("Inca Kola 500 ml", 3.00, "Bebidas"),
        ("Coca Cola 500 ml", 3.00, "Bebidas"),
        ("Agua San Luis 625 ml", 2.00, "Bebidas"),
        ("Arroz 1 kg", 4.50, "Abarrotes"),
        ("Aceite 1 L", 9.90, "Abarrotes"),
        ("Leche Gloria tarro", 4.80, "Abarrotes"),
        ("Huevos (kg)", 8.50, "Abarrotes"),
        ("Yogurt Gloria 1 L", 6.50, "Lácteos"),
        ("Galleta Oreo", 1.50, "Snacks"),
    ]
    con = conectar()
    try:
        existe = con.execute("SELECT COUNT(*) AS n FROM productos").fetchone()["n"]
        if existe:
            return
        for nombre, precio, categoria in ejemplos:
            con.execute(
                "INSERT INTO productos (nombre, precio, categoria, activo, creado_en) VALUES (?, ?, ?, 1, ?)",
                (nombre, precio, categoria, ahora_texto()),
            )
        con.commit()
    finally:
        con.close()


# ----------------------------------------------------------------------
# Ventas
# ----------------------------------------------------------------------
def siguiente_numero(con: sqlite3.Connection, serie: str) -> str:
    """Reserva el siguiente correlativo de la serie de forma atómica."""
    con.execute("BEGIN IMMEDIATE")
    try:
        fila = con.execute("SELECT ultimo FROM contadores WHERE serie = ?", (serie,)).fetchone()
        if fila:
            ultimo = int(fila["ultimo"]) + 1
            con.execute("UPDATE contadores SET ultimo = ? WHERE serie = ?", (ultimo, serie))
        else:
            ultimo = 1
            con.execute("INSERT INTO contadores (serie, ultimo) VALUES (?, 1)", (serie,))
        con.commit()
    except Exception:
        con.rollback()
        raise
    return f"{serie}-{ultimo:08d}"


def registrar_venta(
    serie: str,
    items: list[dict],
    metodo_pago: str,
    cliente_nombre: str,
    cliente_doc: str,
    igv_porcentaje: float,
    id_cliente: str = "",
    cliente_celular: str = "",
) -> dict:
    """Guarda la venta y devuelve el comprobante completo.

    Los precios ya incluyen IGV (uso típico en bodegas y restaurantes).
    ``id_cliente`` es una clave única generada por el celular: si el mismo
    envío llega dos veces (por ejemplo, se cortó la señal justo al responder),
    devolvemos la venta existente en lugar de emitir una boleta duplicada.
    """
    total = round(sum(i["cantidad"] * i["precio_unitario"] for i in items), 2)
    factor = 1 + (igv_porcentaje / 100.0)
    subtotal = round(total / factor, 2)
    igv = round(total - subtotal, 2)

    con = conectar()
    try:
        if id_cliente:
            existente = con.execute(
                "SELECT id FROM ventas WHERE id_cliente = ?", (id_cliente,)
            ).fetchone()
            if existente:
                return obtener_venta(existente["id"]) or {}

        numero = siguiente_numero(con, serie)
        try:
            cur = con.execute(
                """INSERT INTO ventas
                   (numero, id_cliente, cliente_nombre, cliente_doc, cliente_celular,
                    metodo_pago, subtotal, igv, total, estado, sunat_estado,
                    sunat_mensaje, creado_en)
                   VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 'emitida', 'pendiente', '', ?)""",
                (
                    numero,
                    id_cliente or "",
                    cliente_nombre or "CLIENTES VARIOS",
                    cliente_doc or "",
                    cliente_celular or "",
                    metodo_pago,
                    subtotal,
                    igv,
                    total,
                    ahora_texto(),
                ),
            )
        except sqlite3.IntegrityError:
            # Carrera entre dos reintentos del mismo celular.
            if id_cliente:
                existente = con.execute(
                    "SELECT id FROM ventas WHERE id_cliente = ?", (id_cliente,)
                ).fetchone()
                if existente:
                    return obtener_venta(existente["id"]) or {}
            raise
        venta_id = cur.lastrowid
        for item in items:
            con.execute(
                """INSERT INTO venta_items
                   (venta_id, producto_id, descripcion, cantidad, precio_unitario, total)
                   VALUES (?, ?, ?, ?, ?, ?)""",
                (
                    venta_id,
                    item.get("producto_id"),
                    item["descripcion"],
                    item["cantidad"],
                    item["precio_unitario"],
                    round(item["cantidad"] * item["precio_unitario"], 2),
                ),
            )
        con.commit()
        return obtener_venta(venta_id) or {}
    finally:
        con.close()


def _fila_venta(fila: sqlite3.Row, items: list[dict]) -> dict:
    venta = dict(fila)
    venta["items"] = items
    venta["total"] = round(venta["total"], 2)
    return venta


def obtener_venta(venta_id: int) -> dict | None:
    con = conectar()
    try:
        fila = con.execute("SELECT * FROM ventas WHERE id = ?", (venta_id,)).fetchone()
        if not fila:
            return None
        items = [
            dict(i)
            for i in con.execute(
                "SELECT * FROM venta_items WHERE venta_id = ? ORDER BY id", (venta_id,)
            ).fetchall()
        ]
        return _fila_venta(fila, items)
    finally:
        con.close()


def listar_ventas(
    desde: str | None = None,
    hasta: str | None = None,
    metodo: str | None = None,
    texto: str | None = None,
    limite: int = 200,
) -> list[dict]:
    where, valores = [], []
    if desde:
        where.append("date(v.creado_en) >= date(?)")
        valores.append(desde)
    if hasta:
        where.append("date(v.creado_en) <= date(?)")
        valores.append(hasta)
    if metodo:
        where.append("v.metodo_pago = ?")
        valores.append(metodo)
    if texto:
        where.append("(v.numero LIKE ? OR v.cliente_nombre LIKE ? OR v.cliente_doc LIKE ?)")
        patron = f"%{texto}%"
        valores.extend([patron, patron, patron])
    sql = "SELECT v.* FROM ventas v"
    if where:
        sql += " WHERE " + " AND ".join(where)
    sql += " ORDER BY v.id DESC LIMIT ?"
    valores.append(max(1, min(int(limite), 1000)))

    con = conectar()
    try:
        filas = con.execute(sql, valores).fetchall()
        resultado = []
        for fila in filas:
            items = [
                dict(i)
                for i in con.execute(
                    "SELECT * FROM venta_items WHERE venta_id = ? ORDER BY id", (fila["id"],)
                ).fetchall()
            ]
            resultado.append(_fila_venta(fila, items))
        return resultado
    finally:
        con.close()


def anular_venta(venta_id: int) -> dict | None:
    con = conectar()
    try:
        con.execute("UPDATE ventas SET estado = 'anulada' WHERE id = ?", (venta_id,))
        con.commit()
        return obtener_venta(venta_id)
    finally:
        con.close()


def actualizar_sunat(
    venta_id: int,
    estado: str,
    mensaje: str,
    hash_doc: str = "",
    enlace_pdf: str = "",
    enlace_xml: str = "",
) -> None:
    con = conectar()
    try:
        con.execute(
            """UPDATE ventas
               SET sunat_estado = ?, sunat_mensaje = ?, sunat_hash = ?,
                   enlace_pdf = ?, enlace_xml = ?
               WHERE id = ?""",
            (estado, mensaje[:500], hash_doc, enlace_pdf, enlace_xml, venta_id),
        )
        con.commit()
    finally:
        con.close()


# ----------------------------------------------------------------------
# Reportes
# ----------------------------------------------------------------------
def _suma(con, desde: str, hasta: str) -> dict:
    fila = con.execute(
        """SELECT COUNT(*) AS boletas, COALESCE(SUM(total), 0) AS total
           FROM ventas
           WHERE estado = 'emitida' AND date(creado_en) BETWEEN date(?) AND date(?)""",
        (desde, hasta),
    ).fetchone()
    boletas = int(fila["boletas"])
    total = round(float(fila["total"]), 2)
    return {
        "boletas": boletas,
        "total": total,
        "ticket_promedio": round(total / boletas, 2) if boletas else 0.0,
    }


def resumen(dias: int = 7) -> dict:
    hoy = ahora()
    desde_hoy = hoy.strftime("%Y-%m-%d")
    ayer = (hoy - dt.timedelta(days=1)).strftime("%Y-%m-%d")
    desde_rango = (hoy - dt.timedelta(days=dias - 1)).strftime("%Y-%m-%d")
    desde_mes = hoy.strftime("%Y-%m-01")

    con = conectar()
    try:
        ventas_hoy = _suma(con, desde_hoy, desde_hoy)
        ventas_ayer = _suma(con, ayer, ayer)
        ventas_mes = _suma(con, desde_mes, desde_hoy)

        serie = []
        for i in range(dias - 1, -1, -1):
            dia = (hoy - dt.timedelta(days=i)).strftime("%Y-%m-%d")
            datos = _suma(con, dia, dia)
            serie.append(
                {
                    "fecha": dia,
                    "etiqueta": (hoy - dt.timedelta(days=i)).strftime("%a %d"),
                    **datos,
                }
            )

        metodos = [
            {"metodo": f["metodo_pago"], "total": round(float(f["total"]), 2), "boletas": int(f["n"])}
            for f in con.execute(
                """SELECT metodo_pago, SUM(total) AS total, COUNT(*) AS n
                   FROM ventas
                   WHERE estado = 'emitida' AND date(creado_en) BETWEEN date(?) AND date(?)
                   GROUP BY metodo_pago ORDER BY total DESC""",
                (desde_rango, desde_hoy),
            ).fetchall()
        ]

        top = [
            {"descripcion": f["descripcion"], "cantidad": round(float(f["cantidad"]), 2), "total": round(float(f["total"]), 2)}
            for f in con.execute(
                """SELECT i.descripcion, SUM(i.cantidad) AS cantidad, SUM(i.total) AS total
                   FROM venta_items i
                   JOIN ventas v ON v.id = i.venta_id
                   WHERE v.estado = 'emitida' AND date(v.creado_en) BETWEEN date(?) AND date(?)
                   GROUP BY i.descripcion ORDER BY total DESC LIMIT 5""",
                (desde_rango, desde_hoy),
            ).fetchall()
        ]

        ultimas = listar_ventas(limite=5)
        return {
            "hoy": ventas_hoy,
            "ayer": ventas_ayer,
            "mes": ventas_mes,
            "serie": serie,
            "metodos": metodos,
            "top_productos": top,
            "ultimas": ultimas,
        }
    finally:
        con.close()


def ventas_para_csv(desde: str | None = None, hasta: str | None = None) -> list[dict]:
    return listar_ventas(desde=desde, hasta=hasta, limite=1000)


def reporte_periodo(desde: str, hasta: str) -> dict:
    """Datos del resumen que se entrega al contador (y que alimenta el SIRE).

    Devuelve totales de boletas emitidas, IGV, anuladas, desglose por día y
    por medio de pago, además del detalle de comprobantes del periodo.
    """
    con = conectar()
    try:
        fila = con.execute(
            """SELECT COUNT(*) AS boletas,
                      COALESCE(SUM(total), 0) AS total,
                      COALESCE(SUM(subtotal), 0) AS subtotal,
                      COALESCE(SUM(igv), 0) AS igv
               FROM ventas
               WHERE estado = 'emitida'
                 AND date(creado_en) BETWEEN date(?) AND date(?)""",
            (desde, hasta),
        ).fetchone()
        boletas = int(fila["boletas"])
        total = round(float(fila["total"]), 2)

        anuladas = con.execute(
            """SELECT COUNT(*) AS n, COALESCE(SUM(total), 0) AS total
               FROM ventas
               WHERE estado = 'anulada'
                 AND date(creado_en) BETWEEN date(?) AND date(?)""",
            (desde, hasta),
        ).fetchone()

        pendientes = con.execute(
            """SELECT COUNT(*) AS n FROM ventas
               WHERE estado = 'emitida' AND sunat_estado <> 'aceptada'
                 AND date(creado_en) BETWEEN date(?) AND date(?)""",
            (desde, hasta),
        ).fetchone()["n"]

        por_dia = [
            {
                "fecha": f["dia"],
                "boletas": int(f["boletas"]),
                "total": round(float(f["total"]), 2),
            }
            for f in con.execute(
                """SELECT date(creado_en) AS dia, COUNT(*) AS boletas, SUM(total) AS total
                   FROM ventas
                   WHERE estado = 'emitida'
                     AND date(creado_en) BETWEEN date(?) AND date(?)
                   GROUP BY dia ORDER BY dia""",
                (desde, hasta),
            ).fetchall()
        ]

        por_metodo = [
            {
                "metodo": f["metodo_pago"],
                "boletas": int(f["n"]),
                "total": round(float(f["total"]), 2),
            }
            for f in con.execute(
                """SELECT metodo_pago, COUNT(*) AS n, SUM(total) AS total
                   FROM ventas
                   WHERE estado = 'emitida'
                     AND date(creado_en) BETWEEN date(?) AND date(?)
                   GROUP BY metodo_pago ORDER BY total DESC""",
                (desde, hasta),
            ).fetchall()
        ]

        detalle = []
        for f in con.execute(
            """SELECT * FROM ventas
               WHERE date(creado_en) BETWEEN date(?) AND date(?)
               ORDER BY id""",
            (desde, hasta),
        ).fetchall():
            detalle.append(dict(f))

        return {
            "desde": desde,
            "hasta": hasta,
            "boletas": boletas,
            "total": total,
            "subtotal": round(float(fila["subtotal"]), 2),
            "igv": round(float(fila["igv"]), 2),
            "ticket_promedio": round(total / boletas, 2) if boletas else 0.0,
            "anuladas_cantidad": int(anuladas["n"]),
            "anuladas_total": round(float(anuladas["total"]), 2),
            "pendientes_sunat": int(pendientes),
            "por_dia": por_dia,
            "por_metodo": por_metodo,
            "detalle": detalle,
        }
    finally:
        con.close()
