"""Emisión de comprobantes electrónicos.

La app nunca habla directo con SUNAT: eso lo hace un proveedor autorizado
(OSE/PSE). Aquí se envía el comprobante a la API REST de Nubefact usando la
configuración de la instalación (`datos/emision.json`).

Si la instalación no está activada, `emitir` devuelve error y no simula nada.
"""

from __future__ import annotations

import json
import urllib.error
import urllib.request
from datetime import datetime

from emision import leer as leer_emision


def _fecha_partes(texto: str) -> tuple[str, str]:
    """Convierte '2026-11-12 09:30:00' al formato que usa Nubefact."""
    try:
        momento = datetime.strptime(texto, "%Y-%m-%d %H:%M:%S")
    except ValueError:
        momento = datetime.now()
    return momento.strftime("%d-%m-%Y"), momento.strftime("%H:%M:%S")


def tipo_comprobante(serie: str) -> tuple[int, str]:
    """Serie F... = factura, B... = boleta."""
    if (serie or "B001").upper().startswith("F"):
        return 1, "FACTURA ELECTRÓNICA"
    return 2, "BOLETA ELECTRÓNICA"


def _payload_nubefact(negocio: dict, venta: dict) -> dict:
    serie = venta["numero"].split("-")[0]
    tipo, _ = tipo_comprobante(serie)
    numero = int(venta["numero"].split("-")[-1])
    factor = 1 + float(negocio.get("igv", 18.0)) / 100.0

    items = []
    for item in venta["items"]:
        precio = float(item["precio_unitario"])
        valor = round(precio / factor, 10)
        cantidad = float(item["cantidad"])
        items.append(
            {
                "unidad_de_medida": "NIU",
                "descripcion": item["descripcion"],
                "cantidad": cantidad,
                "valor_unitario": valor,
                "precio_unitario": precio,
                "subtotal": round(valor * cantidad, 2),
                "tipo_de_igv": 1,
                "igv": round(precio * cantidad - valor * cantidad, 2),
                "total": round(precio * cantidad, 2),
                "anticipo_regularizacion": False,
            }
        )

    doc = (venta.get("cliente_doc") or "").strip()
    # Nubefact: 0 = sin documento, 1 = DNI, 6 = RUC.
    tipo_doc = 6 if len(doc) == 11 else (1 if doc else 0)

    return {
        "operacion": "generar_comprobante",
        "tipo_de_comprobante": tipo,
        "serie": serie,
        "numero": numero,
        "sunat_transaction": 1,
        "cliente_tipo_de_documento": tipo_doc,
        "cliente_numero_de_documento": doc or "00000000",
        "cliente_denominacion": venta.get("cliente_nombre") or "CLIENTES VARIOS",
        "cliente_direccion": "",
        "cliente_email": "",
        "fecha_de_emision": _fecha_partes(venta["creado_en"])[0],
        "hora_de_emision": _fecha_partes(venta["creado_en"])[1],
        "moneda": 1,
        "tipo_de_cambio": 1,
        "porcentaje_de_igv": float(negocio.get("igv", 18.0)),
        "total_gravada": venta["subtotal"],
        "total_igv": venta["igv"],
        "total": venta["total"],
        "detraccion": False,
        "observaciones": "Emitido con CobraYa",
        "items": items,
        "enviar_automaticamente_a_la_sunat": True,
        "enviar_automaticamente_al_cliente": False,
    }


def _resultado(estado: str, mensaje: str, hash_doc: str = "", pdf: str = "", xml: str = "") -> dict:
    return {"estado": estado, "mensaje": mensaje, "hash": hash_doc, "pdf": pdf, "xml": xml}


def emitir(negocio: dict, venta: dict) -> dict:
    """Devuelve {estado, mensaje, hash, pdf, xml}. Nunca lanza excepciones."""
    config = leer_emision()

    if config["modo"] != "nubefact":
        return _resultado(
            "error",
            "La emisión electrónica no está activada en esta instalación. "
            "Avisa a quien instaló CobraYa para configurar el proveedor autorizado.",
        )

    return _emitir_nubefact(negocio, venta, config)


def _emitir_nubefact(negocio: dict, venta: dict, config: dict) -> dict:
    url = (config.get("nubefact_url") or "").strip()
    token = (config.get("nubefact_token") or "").strip()
    if not url or not token:
        return _resultado(
            "error",
            "Falta configurar la URL o el token del proveedor. La venta quedó guardada; avisa a quien instaló CobraYa.",
        )

    cuerpo = json.dumps(_payload_nubefact(negocio, venta)).encode("utf-8")
    peticion = urllib.request.Request(
        url,
        data=cuerpo,
        method="POST",
        headers={
            "Content-Type": "application/json",
            "Authorization": f"Bearer {token}",
            "Accept": "application/json",
        },
    )

    try:
        with urllib.request.urlopen(peticion, timeout=25) as respuesta:
            datos = json.loads(respuesta.read().decode("utf-8") or "{}")
    except urllib.error.HTTPError as error:
        detalle = ""
        try:
            detalle = error.read().decode("utf-8", "replace")[:400]
        except Exception:
            pass
        return _resultado("error", f"Nubefact respondió HTTP {error.code}. {detalle}".strip())
    except (urllib.error.URLError, TimeoutError) as error:
        return _resultado("error", f"No se pudo conectar con Nubefact: {error}")
    except (ValueError, json.JSONDecodeError):
        return _resultado("error", "Nubefact devolvió una respuesta que no es JSON.")
    except Exception as error:  # pragma: no cover
        return _resultado("error", f"Error inesperado al emitir: {error}")

    aceptada = bool(datos.get("aceptada_por_sunat"))
    mensaje = datos.get("sunat_description") or datos.get("errors") or ""
    if isinstance(mensaje, (list, dict)):
        mensaje = json.dumps(mensaje, ensure_ascii=False)
    hash_doc = datos.get("cadena_para_codigo_qr") or datos.get("codigo_hash") or ""

    if aceptada:
        return _resultado(
            "aceptada",
            str(mensaje) or "Aceptada por SUNAT.",
            str(hash_doc),
            datos.get("enlace_del_pdf", "") or "",
            datos.get("enlace_del_xml", "") or "",
        )

    return _resultado(
        "error",
        str(mensaje) or "El comprobante no fue aceptado por SUNAT.",
        str(hash_doc),
        datos.get("enlace_del_pdf", "") or "",
        datos.get("enlace_del_xml", "") or "",
    )
