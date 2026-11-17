#!/usr/bin/env python3
"""CobraYa — caja y boleta para micronegocios peruanos.

Servidor HTTP con API JSON, sin dependencias externas (solo biblioteca
estándar de Python + SQLite). Pensado para correr en una PC/laptop o en un
servidor pequeño y usarse desde el celular en la misma red.

Uso:
    python3 servidor.py                 # http://localhost:8787
    python3 servidor.py --puerto 9000
    python3 servidor.py --reset-pin     # si olvidaste el PIN
"""

from __future__ import annotations

import argparse
import csv
import getpass
import io
import ipaddress
import json
import os
import re
import secrets
import socket
import sqlite3
import sys
import tempfile
import time
import traceback
from datetime import datetime
from http import HTTPStatus
from http.cookies import SimpleCookie
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from urllib.parse import parse_qs, urlparse

import boleta
import db
import emision
import sunat

BASE = os.path.dirname(os.path.abspath(__file__))
ESTATICO = os.path.join(BASE, "estatico")
VERSION = "1.3.0"
DURACION_SESION = 12 * 3600  # 12 horas

SESIONES: dict[str, float] = {}
INTENTOS: dict[str, list[float]] = {}

METODOS_PAGO = ("Efectivo", "Yape", "Plin", "Tarjeta", "Transferencia")
TIPOS_MIME = {
    ".html": "text/html; charset=utf-8",
    ".css": "text/css; charset=utf-8",
    ".js": "text/javascript; charset=utf-8",
    ".mjs": "text/javascript; charset=utf-8",
    ".json": "application/json; charset=utf-8",
    ".webmanifest": "application/manifest+json; charset=utf-8",
    ".svg": "image/svg+xml",
    ".png": "image/png",
    ".ico": "image/x-icon",
    ".txt": "text/plain; charset=utf-8",
    ".webp": "image/webp",
}


# ----------------------------------------------------------------------
# Errores y utilidades
# ----------------------------------------------------------------------
class ApiError(Exception):
    def __init__(self, estado: int, mensaje: str):
        super().__init__(mensaje)
        self.estado = estado
        self.mensaje = mensaje


def _texto(valor, campo: str, maximo: int = 200, obligatorio: bool = False) -> str:
    texto = "" if valor is None else str(valor).strip()
    if obligatorio and not texto:
        raise ApiError(400, f"El campo «{campo}» es obligatorio.")
    if len(texto) > maximo:
        raise ApiError(400, f"El campo «{campo}» supera los {maximo} caracteres.")
    return texto


def _decimal(valor, campo: str, minimo: float = 0, maximo: float = 1_000_000) -> float:
    try:
        numero = float(valor)
    except (TypeError, ValueError):
        raise ApiError(400, f"«{campo}» debe ser un número.") from None
    if numero < minimo or numero > maximo:
        raise ApiError(400, f"«{campo}» debe estar entre {minimo:g} y {maximo:g}.")
    return round(numero, 2)


def _entero(valor, campo: str, minimo: int = 1, maximo: int = 10**9) -> int:
    try:
        numero = int(valor)
    except (TypeError, ValueError):
        raise ApiError(400, f"«{campo}» debe ser un número entero.") from None
    if numero < minimo or numero > maximo:
        raise ApiError(400, f"«{campo}» fuera de rango.")
    return numero


RUC_PREFIJOS = ("10", "15", "17", "20")


def _documento_cliente(valor, factura: bool) -> str:
    """Valida DNI (8 dígitos) o RUC (11) y devuelve solo los números.

    La factura siempre exige RUC; la boleta puede ir sin documento.
    """
    limpio = re.sub(r"[\s-]", "", str(valor or "").strip())
    if factura and not re.fullmatch(r"\d{11}", limpio):
        raise ApiError(400, "Para factura necesitas el RUC de 11 dígitos del cliente.")
    if not limpio:
        return ""
    if re.fullmatch(r"\d{8}", limpio):
        return limpio
    if re.fullmatch(r"\d{11}", limpio):
        if limpio[:2] not in RUC_PREFIJOS:
            raise ApiError(400, "El RUC debe empezar con 10, 15, 17 o 20.")
        return limpio
    raise ApiError(400, "El documento debe ser DNI de 8 dígitos o RUC de 11 dígitos.")


def negocio_publico(datos: dict | None) -> dict:
    """Datos del negocio sin secretos ni configuración técnica del proveedor."""
    if not datos:
        return {"configurado": False}
    limpio = dict(datos)
    limpio.pop("nubefact_token", None)
    limpio.pop("nubefact_url", None)
    # La emisión depende de la configuración de la instalación, no de la BD.
    activa = emision.estado()["activada"]
    limpio["sunat_modo"] = "nubefact" if activa else ""
    limpio["emision_activa"] = activa
    return limpio


def ip_local() -> str:
    try:
        with socket.socket(socket.AF_INET, socket.SOCK_DGRAM) as s:
            s.connect(("8.8.8.8", 80))
            return s.getsockname()[0]
    except OSError:
        return "127.0.0.1"


# ----------------------------------------------------------------------
# Manejador HTTP
# ----------------------------------------------------------------------
class Manejador(BaseHTTPRequestHandler):
    server_version = f"CobraYa/{VERSION}"
    sys_version = ""
    protocol_version = "HTTP/1.1"

    # ---------------------------- entrada ----------------------------
    def do_GET(self):
        self._atender("GET")

    def do_POST(self):
        self._atender("POST")

    def do_PUT(self):
        self._atender("PUT")

    def do_DELETE(self):
        self._atender("DELETE")

    def log_message(self, formato, *args):
        sys.stderr.write(f"[{time.strftime('%H:%M:%S')}] {self.address_string()} {formato % args}\n")

    def _atender(self, metodo: str):
        try:
            ruta = urlparse(self.path)
            camino = ruta.path
            if camino.startswith("/api/"):
                self._api(metodo, camino, parse_qs(ruta.query))
            else:
                self._estatico(camino)
        except ApiError as error:
            self._json({"error": error.mensaje}, error.estado)
        except BrokenPipeError:
            pass
        except Exception:
            traceback.print_exc()
            try:
                self._json({"error": "Error interno del servidor."}, 500)
            except Exception:
                pass

    # ---------------------------- estáticos --------------------------
    def _estatico(self, camino: str):
        if camino in ("/", ""):
            camino = "/index.html"
        relativa = camino.lstrip("/")
        destino = os.path.realpath(os.path.join(ESTATICO, relativa))
        raiz = os.path.realpath(ESTATICO)
        if not destino.startswith(raiz + os.sep) or not os.path.isfile(destino):
            self._texto("No encontrado", 404)
            return

        extension = os.path.splitext(destino)[1].lower()
        tipo = TIPOS_MIME.get(extension, "application/octet-stream")
        with open(destino, "rb") as archivo:
            contenido = archivo.read()

        self.send_response(200)
        self.send_header("Content-Type", tipo)
        self.send_header("Content-Length", str(len(contenido)))
        if relativa in ("index.html", "sw.js"):
            self.send_header("Cache-Control", "no-store")
        else:
            self.send_header("Cache-Control", "public, max-age=86400")
        self.send_header("X-Content-Type-Options", "nosniff")
        self.end_headers()
        if self.command != "HEAD":
            self.wfile.write(contenido)

    # ---------------------------- respuestas -------------------------
    def _json(self, datos, estado: int = 200, cabeceras: dict | None = None):
        cuerpo = json.dumps(datos, ensure_ascii=False).encode("utf-8")
        self.send_response(estado)
        self.send_header("Content-Type", "application/json; charset=utf-8")
        self.send_header("Content-Length", str(len(cuerpo)))
        self.send_header("Cache-Control", "no-store")
        self.send_header("X-Content-Type-Options", "nosniff")
        self.send_header("X-Frame-Options", "SAMEORIGIN")
        self.send_header("Referrer-Policy", "same-origin")
        for clave, valor in (cabeceras or {}).items():
            self.send_header(clave, valor)
        self.end_headers()
        self.wfile.write(cuerpo)

    def _texto(self, contenido: str, estado: int = 200, tipo: str = "text/plain; charset=utf-8"):
        cuerpo = contenido.encode("utf-8")
        self.send_response(estado)
        self.send_header("Content-Type", tipo)
        self.send_header("Content-Length", str(len(cuerpo)))
        self.send_header("Cache-Control", "no-store")
        self.end_headers()
        self.wfile.write(cuerpo)

    def _cuerpo(self) -> dict:
        largo = int(self.headers.get("Content-Length") or 0)
        if largo <= 0:
            return {}
        if largo > 2 * 1024 * 1024:
            raise ApiError(413, "La solicitud es demasiado grande.")
        crudo = self.rfile.read(largo)
        try:
            datos = json.loads(crudo.decode("utf-8"))
        except (UnicodeDecodeError, json.JSONDecodeError):
            raise ApiError(400, "El cuerpo de la solicitud no es JSON válido.") from None
        if not isinstance(datos, dict):
            raise ApiError(400, "Se esperaba un objeto JSON.")
        return datos

    def _binario(self, contenido: bytes, tipo: str, nombre: str):
        self.send_response(200)
        self.send_header("Content-Type", tipo)
        self.send_header("Content-Length", str(len(contenido)))
        self.send_header("Content-Disposition", f'attachment; filename="{nombre}"')
        self.send_header("Cache-Control", "no-store")
        self.send_header("X-Content-Type-Options", "nosniff")
        self.end_headers()
        self.wfile.write(contenido)

    # ---------------------------- sesión -----------------------------
    def _token(self) -> str:
        cabecera = self.headers.get("Cookie")
        if not cabecera:
            return ""
        galletas = SimpleCookie()
        try:
            galletas.load(cabecera)
        except Exception:
            return ""
        if "sesion" in galletas:
            return galletas["sesion"].value
        return ""

    def _sesion_valida(self) -> bool:
        token = self._token()
        if not token:
            return False
        expira = SESIONES.get(token)
        if not expira:
            return False
        if expira < time.time():
            SESIONES.pop(token, None)
            return False
        return True

    def _exigir_sesion(self):
        if not self._sesion_valida():
            raise ApiError(401, "Sesión no válida. Vuelve a ingresar tu PIN.")

    def _crear_sesion(self) -> str:
        token = secrets.token_urlsafe(32)
        SESIONES[token] = time.time() + DURACION_SESION
        # Limpieza simple de sesiones vencidas
        for clave in [c for c, v in SESIONES.items() if v < time.time()]:
            SESIONES.pop(clave, None)
        return token

    def _cookie_sesion(self, token: str) -> dict:
        return {
            "Set-Cookie": f"sesion={token}; Path=/; HttpOnly; SameSite=Lax; Max-Age={DURACION_SESION}"
        }

    # ---------------------------- API --------------------------------
    def _api(self, metodo: str, camino: str, consulta: dict):
        # --- públicas ---
        if metodo == "GET" and camino == "/api/estado":
            negocio = db.obtener_negocio()
            modo = emision.estado()
            self._json(
                {
                    "configurado": bool(negocio),
                    "sesion": self._sesion_valida(),
                    "version": VERSION,
                    "nombre_negocio": (negocio or {}).get("nombre", ""),
                    "modo_sunat": modo["modo"],
                    "emision_real": modo["real_listo"],
                    "emision_activa": modo["activada"],
                }
            )
            return

        if metodo == "POST" and camino == "/api/setup":
            self._h_setup()
            return

        if metodo == "POST" and camino == "/api/login":
            self._h_login()
            return

        # --- a partir de aquí se requiere sesión ---
        self._exigir_sesion()

        if metodo == "POST" and camino == "/api/logout":
            SESIONES.pop(self._token(), None)
            self._json({"ok": True}, cabeceras={"Set-Cookie": "sesion=; Path=/; Max-Age=0; HttpOnly; SameSite=Lax"})
            return

        if camino == "/api/negocio" and metodo == "GET":
            self._json(negocio_publico(db.obtener_negocio()))
            return

        if camino == "/api/negocio" and metodo == "PUT":
            self._h_actualizar_negocio()
            return

        if camino == "/api/negocio/pin" and metodo == "POST":
            self._h_cambiar_pin()
            return

        if camino == "/api/productos" and metodo == "GET":
            self._json({"productos": db.listar_productos()})
            return

        if camino == "/api/productos" and metodo == "POST":
            self._h_crear_producto()
            return

        coincidencia = re.fullmatch(r"/api/productos/(\d+)", camino)
        if coincidencia:
            pid = int(coincidencia.group(1))
            if metodo == "PUT":
                self._h_actualizar_producto(pid)
                return
            if metodo == "DELETE":
                if not db.eliminar_producto(pid):
                    raise ApiError(404, "Producto no encontrado.")
                self._json({"ok": True})
                return

        if camino == "/api/ventas" and metodo == "GET":
            self._h_listar_ventas(consulta)
            return

        if camino == "/api/ventas" and metodo == "POST":
            self._h_crear_venta()
            return

        coincidencia = re.fullmatch(r"/api/ventas/(\d+)", camino)
        if coincidencia and metodo == "GET":
            venta = db.obtener_venta(int(coincidencia.group(1)))
            if not venta:
                raise ApiError(404, "Venta no encontrada.")
            self._json(venta)
            return

        coincidencia = re.fullmatch(r"/api/ventas/(\d+)/anular", camino)
        if coincidencia and metodo == "POST":
            venta = db.anular_venta(int(coincidencia.group(1)))
            if not venta:
                raise ApiError(404, "Venta no encontrada.")
            self._json(venta)
            return

        coincidencia = re.fullmatch(r"/api/ventas/(\d+)/reintentar-sunat", camino)
        if coincidencia and metodo == "POST":
            self._h_reintentar_sunat(int(coincidencia.group(1)))
            return

        if camino == "/api/resumen" and metodo == "GET":
            dias = _entero(consulta.get("dias", ["7"])[0], "dias", 1, 90)
            self._json(db.resumen(dias))
            return

        coincidencia = re.fullmatch(r"/api/boleta/(\d+)", camino)
        if coincidencia and metodo == "GET":
            self._h_boleta(int(coincidencia.group(1)))
            return

        if camino == "/api/reporte" and metodo == "GET":
            self._h_reporte(consulta)
            return

        if camino == "/api/reporte.pdf" and metodo == "GET":
            self._h_reporte_pdf(consulta)
            return

        if camino == "/api/export.csv" and metodo == "GET":
            self._h_csv(consulta)
            return

        if camino == "/api/respaldo" and metodo == "GET":
            self._h_respaldo()
            return

        raise ApiError(404, "Ruta no encontrada.")

    # ---------------------------- manejadores ------------------------
    def _h_setup(self):
        if db.obtener_negocio():
            raise ApiError(409, "El negocio ya está configurado. Inicia sesión con tu PIN.")
        datos = self._cuerpo()
        nombre = _texto(datos.get("nombre"), "nombre del negocio", 80, obligatorio=True)
        pin = _texto(datos.get("pin"), "PIN", 6, obligatorio=True)
        if not re.fullmatch(r"\d{4,6}", pin):
            raise ApiError(400, "El PIN debe tener entre 4 y 6 dígitos.")

        # La emisión la define la instalación (datos/emision.json), no el cliente.
        negocio = db.crear_negocio(
            {
                "nombre": nombre,
                "ruc": _texto(datos.get("ruc"), "RUC", 11),
                "direccion": _texto(datos.get("direccion"), "dirección", 120),
                "telefono": _texto(datos.get("telefono"), "teléfono", 20),
                "serie": "B001",
                "igv": 18.0,
                "pin": pin,
            }
        )
        db.sembrar_productos()
        token = self._crear_sesion()
        self._json({"ok": True, "negocio": negocio_publico(negocio)}, cabeceras=self._cookie_sesion(token))

    def _h_login(self):
        ip = self.client_address[0]
        ahora = time.time()
        recientes = [m for m in INTENTOS.get(ip, []) if ahora - m < 60]
        if len(recientes) >= 8:
            raise ApiError(429, "Demasiados intentos. Espera un minuto e inténtalo de nuevo.")
        recientes.append(ahora)
        INTENTOS[ip] = recientes

        datos = self._cuerpo()
        pin = _texto(datos.get("pin"), "PIN", 12)
        if not db.obtener_negocio():
            raise ApiError(409, "Primero configura tu negocio.")
        if not db.verificar_pin(pin, db.pin_guardado()):
            time.sleep(0.4)
            raise ApiError(401, "PIN incorrecto.")
        INTENTOS.pop(ip, None)
        token = self._crear_sesion()
        self._json({"ok": True}, cabeceras=self._cookie_sesion(token))

    def _h_actualizar_negocio(self):
        datos = self._cuerpo()
        cambios: dict = {}
        if "nombre" in datos:
            cambios["nombre"] = _texto(datos["nombre"], "nombre", 80, obligatorio=True)
        if "ruc" in datos:
            ruc = _texto(datos["ruc"], "RUC", 11)
            if ruc and not re.fullmatch(r"\d{11}", ruc):
                raise ApiError(400, "El RUC debe tener 11 dígitos.")
            cambios["ruc"] = ruc
        if "direccion" in datos:
            cambios["direccion"] = _texto(datos["direccion"], "dirección", 120)
        if "telefono" in datos:
            cambios["telefono"] = _texto(datos["telefono"], "teléfono", 20)
        if "qr_pago" in datos:
            # El QR se guarda como data URL (imagen ya reducida en el celular).
            qr = _texto(datos.get("qr_pago"), "QR de cobro", 400_000)
            if qr and not re.fullmatch(
                r"data:image/(png|jpeg|webp);base64,[A-Za-z0-9+/=\s]+", qr
            ):
                raise ApiError(400, "El QR debe ser una imagen PNG, JPG o WebP.")
            cambios["qr_pago"] = qr
        if "serie" in datos:
            serie = _texto(datos["serie"], "serie", 4).upper()
            if not re.fullmatch(r"[BF]\d{3}", serie):
                raise ApiError(400, "La serie debe ser como B001 (boleta) o F001 (factura).")
            cambios["serie"] = serie
        if "igv" in datos:
            cambios["igv"] = _decimal(datos["igv"], "IGV", 0, 30)

        self._json(negocio_publico(db.actualizar_negocio(cambios)))

    def _h_cambiar_pin(self):
        datos = self._cuerpo()
        actual = _texto(datos.get("actual"), "PIN actual", 12)
        nuevo = _texto(datos.get("nuevo"), "PIN nuevo", 6)
        if not re.fullmatch(r"\d{4,6}", nuevo):
            raise ApiError(400, "El PIN nuevo debe tener entre 4 y 6 dígitos.")
        if not db.verificar_pin(actual, db.pin_guardado()):
            raise ApiError(401, "El PIN actual no es correcto.")
        db.cambiar_pin(nuevo)
        self._json({"ok": True})

    def _h_crear_producto(self):
        datos = self._cuerpo()
        nombre = _texto(datos.get("nombre"), "nombre", 80, obligatorio=True)
        precio = _decimal(datos.get("precio"), "precio", 0, 100_000)
        categoria = _texto(datos.get("categoria"), "categoría", 40)
        if precio <= 0:
            raise ApiError(400, "El precio debe ser mayor que cero.")
        self._json(db.crear_producto(nombre, precio, categoria), 201)

    def _h_actualizar_producto(self, pid: int):
        if not db.obtener_producto(pid):
            raise ApiError(404, "Producto no encontrado.")
        datos = self._cuerpo()
        cambios: dict = {}
        if "nombre" in datos:
            cambios["nombre"] = _texto(datos["nombre"], "nombre", 80, obligatorio=True)
        if "precio" in datos:
            cambios["precio"] = _decimal(datos["precio"], "precio", 0.01, 100_000)
        if "categoria" in datos:
            cambios["categoria"] = _texto(datos["categoria"], "categoría", 40)
        if "activo" in datos:
            cambios["activo"] = 1 if datos["activo"] else 0
        self._json(db.actualizar_producto(pid, cambios))

    def _h_crear_venta(self):
        negocio = db.obtener_negocio()
        if not negocio:
            raise ApiError(409, "Configura tu negocio antes de vender.")
        if not emision.estado()["activada"]:
            raise ApiError(
                409,
                "La emisión electrónica no está activada en esta instalación. "
                "No se pueden emitir comprobantes hasta configurar el proveedor autorizado (OSE/PSE).",
            )

        datos = self._cuerpo()
        metodo = _texto(datos.get("metodo_pago") or "Efectivo", "método de pago", 20)
        if metodo not in METODOS_PAGO:
            raise ApiError(400, "Método de pago no válido.")

        tipo = _texto(datos.get("tipo_comprobante") or "boleta", "tipo de comprobante", 10).lower()
        if tipo not in ("boleta", "factura"):
            raise ApiError(400, "El tipo de comprobante debe ser boleta o factura.")

        crudos = datos.get("items")
        if not isinstance(crudos, list) or not crudos:
            raise ApiError(400, "Agrega al menos un producto a la venta.")
        if len(crudos) > 100:
            raise ApiError(400, "Máximo 100 líneas por venta.")

        items = []
        for indice, crudo in enumerate(crudos, start=1):
            if not isinstance(crudo, dict):
                raise ApiError(400, f"Línea {indice} inválida.")
            descripcion = _texto(crudo.get("descripcion"), f"descripción (línea {indice})", 200, obligatorio=True)
            cantidad = _decimal(crudo.get("cantidad"), f"cantidad (línea {indice})", 0.01, 100_000)
            precio = _decimal(crudo.get("precio_unitario"), f"precio (línea {indice})", 0, 100_000)
            if precio <= 0:
                raise ApiError(400, f"El precio de la línea {indice} debe ser mayor que cero.")
            producto_id = crudo.get("producto_id")
            if producto_id is not None and not isinstance(producto_id, int):
                producto_id = None
            items.append(
                {
                    "producto_id": producto_id,
                    "descripcion": descripcion,
                    "cantidad": cantidad,
                    "precio_unitario": precio,
                }
            )

        # Regla SUNAT: la boleta puede ir a "Clientes varios" (sin DNI) salvo
        # que la venta supere los S/ 700 o el cliente pida su comprobante.
        total_venta = round(sum(i["cantidad"] * i["precio_unitario"] for i in items), 2)
        cliente_nombre = _texto(datos.get("cliente_nombre"), "cliente", 100)
        cliente_doc = _documento_cliente(datos.get("cliente_doc"), tipo == "factura")
        if tipo == "factura" and not cliente_nombre:
            raise ApiError(400, "Para factura escribe la razón social del cliente.")
        if total_venta > 700 and not cliente_doc:
            raise ApiError(
                400,
                "Las ventas mayores a S/ 700 deben identificar al cliente. "
                "Agrega su DNI o RUC para emitir la boleta.",
            )

        # La serie se deriva del tipo elegido: B001 para boleta, F001 para factura.
        serie_base = str(negocio.get("serie") or "B001").upper()
        sufijo = serie_base[1:] if re.fullmatch(r"[BF]\d{3}", serie_base) else "001"
        serie = ("F" if tipo == "factura" else "B") + sufijo

        id_cliente = _texto(datos.get("id_cliente"), "identificador de la venta", 64)
        if id_cliente and not re.fullmatch(r"[A-Za-z0-9-]{8,64}", id_cliente):
            raise ApiError(400, "El identificador de la venta no es válido.")

        # Celular opcional solo para reenviar la boleta por WhatsApp.
        celular = re.sub(r"\D", "", _texto(datos.get("cliente_celular"), "celular", 15))
        if celular and not re.fullmatch(r"9\d{8}", celular):
            raise ApiError(400, "El celular debe tener 9 dígitos y empezar con 9.")

        venta = db.registrar_venta(
            serie=serie,
            items=items,
            metodo_pago=metodo,
            cliente_nombre=cliente_nombre or "CLIENTES VARIOS",
            cliente_doc=cliente_doc,
            igv_porcentaje=float(negocio.get("igv", 18.0)),
            id_cliente=id_cliente,
            cliente_celular=celular,
        )

        resultado = sunat.emitir(negocio, venta)
        db.actualizar_sunat(
            venta["id"],
            resultado["estado"],
            resultado["mensaje"],
            resultado["hash"],
            resultado["pdf"],
            resultado["xml"],
        )
        venta = db.obtener_venta(venta["id"]) or venta
        self._json(venta, 201)

    def _h_listar_ventas(self, consulta: dict):
        desde = (consulta.get("desde") or [""])[0] or None
        hasta = (consulta.get("hasta") or [""])[0] or None
        for valor, nombre in ((desde, "desde"), (hasta, "hasta")):
            if valor and not re.fullmatch(r"\d{4}-\d{2}-\d{2}", valor):
                raise ApiError(400, f"Fecha «{nombre}» inválida (usa AAAA-MM-DD).")
        metodo = (consulta.get("metodo") or [""])[0] or None
        if metodo and metodo not in METODOS_PAGO:
            raise ApiError(400, "Método de pago no válido.")
        texto = (consulta.get("q") or [""])[0] or None
        limite = _entero((consulta.get("limite") or ["200"])[0], "límite", 1, 1000)
        ventas = db.listar_ventas(desde=desde, hasta=hasta, metodo=metodo, texto=texto, limite=limite)
        total = round(sum(v["total"] for v in ventas if v["estado"] == "emitida"), 2)
        self._json({"ventas": ventas, "total": total, "cantidad": len(ventas)})

    def _h_reintentar_sunat(self, venta_id: int):
        negocio = db.obtener_negocio()
        venta = db.obtener_venta(venta_id)
        if not venta:
            raise ApiError(404, "Venta no encontrada.")
        if venta["estado"] == "anulada":
            raise ApiError(400, "No se puede reenviar una venta anulada.")
        if not emision.estado()["activada"]:
            raise ApiError(
                409,
                "La emisión electrónica no está activada en esta instalación. "
                "Configura el proveedor autorizado antes de reenviar.",
            )
        resultado = sunat.emitir(negocio or {}, venta)
        db.actualizar_sunat(
            venta_id,
            resultado["estado"],
            resultado["mensaje"],
            resultado["hash"],
            resultado["pdf"],
            resultado["xml"],
        )
        self._json(db.obtener_venta(venta_id))

    def _h_boleta(self, venta_id: int):
        negocio = db.obtener_negocio()
        venta = db.obtener_venta(venta_id)
        if not negocio or not venta:
            raise ApiError(404, "Comprobante no encontrado.")
        html = boleta.generar_html(negocio, venta)
        self._texto(html, 200, "text/html; charset=utf-8")

    def _rango_reporte(self, consulta: dict) -> tuple[str, str]:
        """Valida el periodo pedido y devuelve (desde, hasta) en AAAA-MM-DD."""
        hoy = db.hoy_texto()
        desde = (consulta.get("desde") or [""])[0] or f"{hoy[:7]}-01"
        hasta = (consulta.get("hasta") or [""])[0] or hoy
        for valor, nombre in ((desde, "desde"), (hasta, "hasta")):
            if not re.fullmatch(r"\d{4}-\d{2}-\d{2}", valor):
                raise ApiError(400, f"Fecha «{nombre}» inválida (usa AAAA-MM-DD).")
        if desde > hasta:
            raise ApiError(400, "La fecha inicial no puede ser mayor que la final.")
        return desde, hasta

    def _h_reporte(self, consulta: dict):
        """Resumen del periodo listo para imprimir y enviar al contador."""
        desde, hasta = self._rango_reporte(consulta)
        negocio = db.obtener_negocio()
        if not negocio:
            raise ApiError(409, "Configura tu negocio antes de generar el reporte.")
        datos = db.reporte_periodo(desde, hasta)
        html = boleta.generar_reporte_html(negocio, datos)
        self._texto(html, 200, "text/html; charset=utf-8")

    def _h_reporte_pdf(self, consulta: dict):
        """Mismo resumen, en PDF descargable para adjuntar por WhatsApp."""
        desde, hasta = self._rango_reporte(consulta)
        negocio = db.obtener_negocio()
        if not negocio:
            raise ApiError(409, "Configura tu negocio antes de generar el reporte.")
        datos = db.reporte_periodo(desde, hasta)
        contenido = boleta.generar_reporte_pdf(negocio, datos)
        self._binario(
            contenido,
            "application/pdf",
            f"resumen-cobraya-{desde}-a-{hasta}.pdf",
        )

    def _h_csv(self, consulta: dict):
        desde = (consulta.get("desde") or [""])[0] or None
        hasta = (consulta.get("hasta") or [""])[0] or None
        salida = io.StringIO()
        escritor = csv.writer(salida, delimiter=";", lineterminator="\r\n")
        escritor.writerow(
            [
                "Comprobante", "Fecha", "Cliente", "Documento", "Metodo de pago",
                "Op. gravada", "IGV", "Total", "Estado", "Estado SUNAT", "Detalle",
            ]
        )
        for venta in db.ventas_para_csv(desde=desde, hasta=hasta):
            detalle = " | ".join(
                f"{i['cantidad']:g} x {i['descripcion']}" for i in venta["items"]
            )
            escritor.writerow(
                [
                    venta["numero"],
                    venta["creado_en"],
                    venta["cliente_nombre"],
                    venta["cliente_doc"],
                    venta["metodo_pago"],
                    f"{venta['subtotal']:.2f}",
                    f"{venta['igv']:.2f}",
                    f"{venta['total']:.2f}",
                    venta["estado"],
                    venta["sunat_estado"],
                    detalle,
                ]
            )
        contenido = "\ufeff" + salida.getvalue()
        nombre = f"ventas-{db.hoy_texto()}.csv"
        cuerpo = contenido.encode("utf-8")
        self.send_response(200)
        self.send_header("Content-Type", "text/csv; charset=utf-8")
        self.send_header("Content-Length", str(len(cuerpo)))
        self.send_header("Content-Disposition", f'attachment; filename="{nombre}"')
        self.send_header("Cache-Control", "no-store")
        self.end_headers()
        self.wfile.write(cuerpo)

    def _h_respaldo(self):
        con = db.conectar()
        temporal = tempfile.NamedTemporaryFile(prefix="cobraya-", suffix=".db", delete=False)
        temporal.close()
        try:
            destino = sqlite3.connect(temporal.name)
            with destino:
                con.backup(destino)
            destino.close()
            with open(temporal.name, "rb") as archivo:
                contenido = archivo.read()
        finally:
            con.close()
            try:
                os.unlink(temporal.name)
            except OSError:
                pass
        nombre = f"respaldo-cobraya-{db.hoy_texto()}.db"
        self.send_response(200)
        self.send_header("Content-Type", "application/octet-stream")
        self.send_header("Content-Length", str(len(contenido)))
        self.send_header("Content-Disposition", f'attachment; filename="{nombre}"')
        self.send_header("Cache-Control", "no-store")
        self.end_headers()
        self.wfile.write(contenido)


# ----------------------------------------------------------------------
# Arranque
# ----------------------------------------------------------------------
def reiniciar_pin():
    db.inicializar()
    if not db.obtener_negocio():
        print("Todavía no hay un negocio configurado. Abre la app y completa el registro.")
        return
    print("Restablecer PIN de CobraYa")
    pin = getpass.getpass("Nuevo PIN (4 a 6 dígitos): ").strip()
    if not re.fullmatch(r"\d{4,6}", pin):
        print("PIN inválido. Debe tener entre 4 y 6 dígitos.")
        return
    if getpass.getpass("Repite el PIN: ").strip() != pin:
        print("Los PIN no coinciden.")
        return
    db.cambiar_pin(pin)
    print("PIN actualizado. Ya puedes ingresar.")


def main():
    analizador = argparse.ArgumentParser(description="CobraYa — caja y boleta para micronegocios")
    analizador.add_argument("--host", default="0.0.0.0", help="Interfaz de escucha (por defecto 0.0.0.0)")
    analizador.add_argument("--puerto", type=int, default=int(os.environ.get("COBRAYA_PUERTO", 8787)))
    analizador.add_argument("--reset-pin", action="store_true", help="Cambiar el PIN de acceso")
    argumentos = analizador.parse_args()

    db.inicializar()
    if argumentos.reset_pin:
        reiniciar_pin()
        return

    servidor = ThreadingHTTPServer((argumentos.host, argumentos.puerto), Manejador)
    servidor.daemon_threads = True

    local = ip_local()
    print("\n  CobraYa · caja y boleta para micronegocios")
    print("  " + "─" * 46)
    print(f"  En esta computadora : http://localhost:{argumentos.puerto}")
    if argumentos.host == "0.0.0.0":
        print(f"  Desde tu celular    : http://{local}:{argumentos.puerto}")
        print("  (celular y PC en la misma red Wi-Fi)")
    print(f"  Datos               : {db.RUTA_DB}")
    print("  " + "─" * 46)
    print("  Ctrl+C para detener\n")

    try:
        servidor.serve_forever()
    except KeyboardInterrupt:
        print("\nHasta luego.")
    finally:
        servidor.server_close()


if __name__ == "__main__":
    main()
