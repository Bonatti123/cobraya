#!/usr/bin/env python3
"""Pruebas de humo de CobraYa (sin dependencias externas).

Ejecutar:
    python3 pruebas/test_api.py
"""

from __future__ import annotations

import http.cookiejar
import json
import os
import sys
import tempfile
import threading
import unittest
import urllib.error
import urllib.request
from unittest import mock

RAIZ = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
sys.path.insert(0, RAIZ)

# La base de prueba se define antes de importar los módulos.
TEMPORAL = tempfile.TemporaryDirectory(prefix="cobraya-pruebas-")
os.environ["COBRAYA_DB"] = os.path.join(TEMPORAL.name, "prueba.db")
os.environ["COBRAYA_EMISION"] = os.path.join(TEMPORAL.name, "emision.json")

import db  # noqa: E402
import emision  # noqa: E402
import servidor  # noqa: E402
import sunat  # noqa: E402


class ApiTest(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        db.inicializar()

        # No llamamos a Nubefact de verdad en las pruebas: el envío se simula,
        # pero la configuración de emisión sí es real dentro del temporal.
        def emision_falsa(negocio, venta, config):
            return {
                "estado": "aceptada",
                "mensaje": "Aceptada por SUNAT (prueba).",
                "hash": "hash-de-prueba",
                "pdf": "",
                "xml": "",
            }

        cls.parche = mock.patch.object(sunat, "_emitir_nubefact", emision_falsa)
        cls.parche.start()

        cls.servidor = servidor.ThreadingHTTPServer(("127.0.0.1", 0), servidor.Manejador)
        cls.hilo = threading.Thread(target=cls.servidor.serve_forever, daemon=True)
        cls.hilo.start()
        cls.base = f"http://127.0.0.1:{cls.servidor.server_address[1]}"

        cls.galletas = http.cookiejar.CookieJar()
        cls.navegador = urllib.request.build_opener(
            urllib.request.HTTPCookieProcessor(cls.galletas)
        )

    @classmethod
    def tearDownClass(cls):
        cls.servidor.shutdown()
        cls.servidor.server_close()
        cls.parche.stop()
        TEMPORAL.cleanup()

    # ------------------------------------------------------------ ayudas
    def peticion(self, ruta, metodo="GET", cuerpo=None, esperado=200):
        datos = None
        cabeceras = {}
        if cuerpo is not None:
            datos = json.dumps(cuerpo).encode("utf-8")
            cabeceras["Content-Type"] = "application/json"
        solicitud = urllib.request.Request(
            self.base + ruta, data=datos, method=metodo, headers=cabeceras
        )
        try:
            with self.navegador.open(solicitud, timeout=10) as respuesta:
                estado = respuesta.status
                contenido = respuesta.read().decode("utf-8")
        except urllib.error.HTTPError as error:
            estado = error.code
            contenido = error.read().decode("utf-8")
        self.assertEqual(estado, esperado, f"{ruta}: {contenido[:300]}")
        return contenido

    def json(self, ruta, metodo="GET", cuerpo=None, esperado=200):
        return json.loads(self.peticion(ruta, metodo, cuerpo, esperado))

    def peticion_bytes(self, ruta, esperado=200):
        solicitud = urllib.request.Request(self.base + ruta)
        try:
            with self.navegador.open(solicitud, timeout=10) as respuesta:
                estado = respuesta.status
                contenido = respuesta.read()
                tipo = respuesta.headers.get("Content-Type", "")
        except urllib.error.HTTPError as error:
            estado = error.code
            contenido = error.read()
            tipo = error.headers.get("Content-Type", "")
        self.assertEqual(estado, esperado, f"{ruta}: {contenido[:300]!r}")
        return contenido, tipo

    # ------------------------------------------------------------ pruebas
    def test_01_flujo_completo(self):
        estado = self.json("/api/estado")
        self.assertFalse(estado["configurado"])
        self.assertFalse(estado["emision_activa"])
        self.assertFalse(estado["emision_real"])

        # Sin emisión activada se puede configurar el negocio, pero no vender.
        creado = self.json(
            "/api/setup",
            "POST",
            {
                "nombre": "Bodega Los Ángeles",
                "ruc": "20123456789",
                "pin": "1234",
            },
            esperado=200,
        )
        self.assertTrue(creado["ok"])
        self.assertFalse(creado["negocio"]["emision_activa"])
        self.assertEqual(creado["negocio"]["sunat_modo"], "")
        self.assertNotIn("nubefact_url", creado["negocio"])
        self.assertNotIn("nubefact_token", creado["negocio"])

        # El QR de cobro se guarda como data URL y vuelve en la respuesta.
        qr = (
            "data:image/png;base64,"
            "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg=="
        )
        con_qr = self.json("/api/negocio", "PUT", {"qr_pago": qr})
        self.assertEqual(con_qr["qr_pago"], qr)

        catalogo = self.json("/api/productos")
        self.assertGreaterEqual(len(catalogo["productos"]), 5)

        # Vender sin activar la emisión debe rechazarse con un mensaje claro.
        bloqueada = self.json(
            "/api/ventas",
            "POST",
            {
                "items": [{"descripcion": "Pan", "cantidad": 1, "precio_unitario": 1}],
                "metodo_pago": "Yape",
            },
            esperado=409,
        )
        self.assertIn("no está activada", bloqueada["error"])

        # Activación de la instalación (lo que hace configurar_emision.py).
        emision.guardar("https://api.nubefact.com/api/v1/prueba", "token-de-prueba")
        self.assertTrue(self.json("/api/estado")["emision_activa"])

        venta = self.json(
            "/api/ventas",
            "POST",
            {
                "id_cliente": "prueba-idempotencia-0001",
                "items": [
                    {"descripcion": "Pan francés", "cantidad": 4, "precio_unitario": 0.5},
                    {"descripcion": "Corte de cabello", "cantidad": 1, "precio_unitario": 20},
                ],
                "metodo_pago": "Yape",
                "cliente_nombre": "Ana Pérez",
                "cliente_doc": "45678912",
                "cliente_celular": "987654321",
            },
            esperado=201,
        )
        self.assertEqual(venta["numero"], "B001-00000001")
        self.assertEqual(venta["total"], 22.0)
        self.assertAlmostEqual(venta["subtotal"], 18.64, places=2)
        self.assertAlmostEqual(venta["igv"], 3.36, places=2)
        self.assertEqual(venta["sunat_estado"], "aceptada")
        self.assertEqual(venta["cliente_celular"], "987654321")

        # Reintento con el mismo id: no debe duplicar la boleta.
        repetida = self.json(
            "/api/ventas",
            "POST",
            {
                "id_cliente": "prueba-idempotencia-0001",
                "items": [{"descripcion": "Pan francés", "cantidad": 4, "precio_unitario": 0.5}],
                "metodo_pago": "Yape",
            },
            esperado=201,
        )
        self.assertEqual(repetida["numero"], "B001-00000001")

        listado = self.json("/api/ventas")
        self.assertEqual(listado["cantidad"], 1)
        self.assertEqual(listado["total"], 22.0)

        resumen = self.json("/api/resumen?dias=7")
        self.assertEqual(resumen["hoy"]["boletas"], 1)
        self.assertEqual(resumen["hoy"]["total"], 22.0)

        boleta = self.peticion(f"/api/boleta/{venta['id']}")
        self.assertIn("B001-00000001", boleta)
        self.assertIn("Ana Pérez", boleta)
        self.assertIn("wa.me/51987654321", boleta)

        reporte = self.peticion("/api/reporte")
        self.assertIn("Resumen para el contador", reporte)
        self.assertIn("B001-00000001", reporte)

        # El mismo resumen debe llegar como PDF descargable.
        pdf, tipo = self.peticion_bytes("/api/reporte.pdf")
        self.assertTrue(pdf.startswith(b"%PDF-1.4"), pdf[:40])
        self.assertIn("application/pdf", tipo)
        self.assertGreater(len(pdf), 1000)

        csv = self.peticion("/api/export.csv")
        self.assertIn("B001-00000001", csv)

    def test_02_regla_dni_mas_de_700(self):
        cuerpo = {
            "items": [{"descripcion": "Televisor", "cantidad": 1, "precio_unitario": 899}],
            "metodo_pago": "Efectivo",
            "id_cliente": "prueba-monto-alto-0002",
        }
        error = self.json("/api/ventas", "POST", cuerpo, esperado=400)
        self.assertIn("S/ 700", error["error"])

        cuerpo["cliente_doc"] = "45678912"
        venta = self.json("/api/ventas", "POST", cuerpo, esperado=201)
        self.assertEqual(venta["total"], 899.0)
        self.assertEqual(venta["cliente_doc"], "45678912")

    def test_03_validaciones(self):
        self.json("/api/ventas", "POST", {"items": [], "metodo_pago": "Yape"}, esperado=400)
        self.json(
            "/api/ventas",
            "POST",
            {
                "items": [{"descripcion": "X", "cantidad": 1, "precio_unitario": 1}],
                "metodo_pago": "Bitcoin",
            },
            esperado=400,
        )
        self.json(
            "/api/negocio",
            "PUT",
            {"serie": "ZZZZ"},
            esperado=400,
        )
        self.json(
            "/api/negocio",
            "PUT",
            {"qr_pago": "javascript:alert(1)"},
            esperado=400,
        )
        self.json(
            "/api/ventas",
            "POST",
            {
                "items": [{"descripcion": "X", "cantidad": 1, "precio_unitario": 1}],
                "metodo_pago": "Yape",
                "cliente_celular": "123",
            },
            esperado=400,
        )

    def test_04_login_y_sesion(self):
        self.json("/api/logout", "POST", {}, esperado=200)
        self.json("/api/negocio", esperado=401)
        self.json("/api/login", "POST", {"pin": "0000"}, esperado=401)
        self.json("/api/login", "POST", {"pin": "1234"}, esperado=200)
        negocio = self.json("/api/negocio")
        self.assertEqual(negocio["nombre"], "Bodega Los Ángeles")
        self.assertNotIn("pin_hash", negocio)
        self.assertNotIn("nubefact_token", negocio)

    def test_05_factura_con_ruc(self):
        base = {
            "tipo_comprobante": "factura",
            "items": [{"descripcion": "Servicio de diseño", "cantidad": 1, "precio_unitario": 118}],
            "metodo_pago": "Transferencia",
            "cliente_nombre": "Empresa Cliente SAC",
        }
        # Sin RUC no se puede emitir una factura.
        sin_ruc = dict(base, id_cliente="prueba-factura-sin-ruc")
        error = self.json("/api/ventas", "POST", sin_ruc, esperado=400)
        self.assertIn("RUC", error["error"])

        # RUC con prefijo inválido.
        malo = dict(base, id_cliente="prueba-factura-ruc-malo", cliente_doc="12345678901")
        error = self.json("/api/ventas", "POST", malo, esperado=400)
        self.assertIn("RUC", error["error"])

        # Factura correcta: serie F001 y RUC de 11 dígitos.
        buena = dict(base, id_cliente="prueba-factura-ok", cliente_doc="20123456789")
        venta = self.json("/api/ventas", "POST", buena, esperado=201)
        self.assertTrue(venta["numero"].startswith("F001-"), venta["numero"])
        self.assertEqual(venta["cliente_doc"], "20123456789")
        boleta = self.peticion(f"/api/boleta/{venta['id']}")
        self.assertIn("Factura", boleta)

        # La boleta sigue usando su propia serie y correlativo.
        boleta = self.json(
            "/api/ventas",
            "POST",
            {
                "id_cliente": "prueba-boleta-despues-factura",
                "items": [{"descripcion": "Pan", "cantidad": 2, "precio_unitario": 1}],
                "metodo_pago": "Efectivo",
            },
            esperado=201,
        )
        self.assertTrue(boleta["numero"].startswith("B001-"), boleta["numero"])

        # Documento con letras: se rechaza.
        malo = dict(base, id_cliente="prueba-doc-letras", cliente_doc="20ABCDEFGHI")
        self.json("/api/ventas", "POST", malo, esperado=400)

    def test_06_payload_nubefact_factura(self):
        """La factura debe viajar a Nubefact como tipo 1, serie F001 y RUC."""
        negocio = db.obtener_negocio()
        venta = {
            "numero": "F001-00000042",
            "items": [
                {
                    "descripcion": "Servicio",
                    "cantidad": 1,
                    "precio_unitario": 118.0,
                    "total": 118.0,
                }
            ],
            "subtotal": 100.0,
            "igv": 18.0,
            "total": 118.0,
            "cliente_doc": "20123456789",
            "cliente_nombre": "Empresa Cliente SAC",
            "creado_en": "2026-11-12 10:00:00",
        }
        payload = sunat._payload_nubefact(negocio, venta)
        self.assertEqual(payload["tipo_de_comprobante"], 1)
        self.assertEqual(payload["serie"], "F001")
        self.assertEqual(payload["numero"], 42)
        self.assertEqual(payload["cliente_tipo_de_documento"], 6)
        self.assertEqual(payload["cliente_numero_de_documento"], "20123456789")

    def test_07_configuracion_emision(self):
        """La emisión se activa por instalación; sin ella no se puede vender."""
        self.assertTrue(emision.estado()["activada"])

        # Copiar el ejemplo tal cual no cuenta como activación.
        with self.assertRaises(ValueError):
            emision.guardar(
                "https://api.nubefact.com/api/v1/TU_RUTA",
                "TU_TOKEN",
            )

        # Desactivar bloquea la app de inmediato.
        emision.borrar()
        info = self.json("/api/estado")
        self.assertFalse(info["emision_activa"])
        self.assertFalse(info["emision_real"])
        self.assertFalse(emision.estado()["activada"])

        bloqueada = self.json(
            "/api/ventas",
            "POST",
            {
                "id_cliente": "prueba-emision-apagada",
                "items": [{"descripcion": "Pan", "cantidad": 1, "precio_unitario": 1}],
                "metodo_pago": "Efectivo",
            },
            esperado=409,
        )
        self.assertIn("no está activada", bloqueada["error"])

        # La API pública nunca devuelve el token ni la URL.
        negocio = self.json("/api/negocio")
        self.assertNotIn("nubefact_token", negocio)
        self.assertNotIn("nubefact_url", negocio)
        self.assertFalse(negocio["emision_activa"])

        # Reactivar para dejar la instalación como estaba.
        emision.guardar("https://api.nubefact.com/api/v1/prueba", "token-de-prueba")
        self.assertTrue(self.json("/api/estado")["emision_activa"])


if __name__ == "__main__":
    unittest.main(verbosity=2)
