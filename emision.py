"""Configuración de emisión electrónica de esta instalación.

CobraYa no habla directo con SUNAT: los comprobantes los valida un proveedor
autorizado (OSE/PSE). El dueño del negocio no ve URLs ni tokens; esos datos
los configura quien instala la app en `datos/emision.json`.

Si ese archivo no existe o está incompleto, la instalación **no está
activada** y la app no permite emitir comprobantes. No hay modo simulado.

Uso desde la terminal:
    python3 herramientas/configurar_emision.py --estado
    python3 herramientas/configurar_emision.py --url https://... --token ...
    python3 herramientas/configurar_emision.py --borrar
"""

from __future__ import annotations

import json
import os
import re

RAIZ = os.path.dirname(os.path.abspath(__file__))
RUTA_POR_DEFECTO = os.path.join(RAIZ, "datos", "emision.json")

MODO_REAL = "nubefact"

# Textos de ejemplo que la gente copia sin darse cuenta. Si aparecen en la URL
# o el token, la emisión real no está configurada de verdad.
MARCADORES = (
    "tu_token",
    "tu-token",
    "tu_ruta",
    "tu-url",
    "pega tu",
    "pega_tu",
    "aqui",
    "xxxx",
    "ejemplo",
)


def _es_marcador(valor: str) -> bool:
    texto = str(valor or "").lower()
    return any(marcador in texto for marcador in MARCADORES)


def ruta() -> str:
    """Permite a las pruebas usar un archivo temporal."""
    return os.environ.get("COBRAYA_EMISION") or RUTA_POR_DEFECTO


def leer() -> dict:
    """Devuelve la configuración actual. Sin archivo válido, no hay emisión."""
    try:
        with open(ruta(), encoding="utf-8") as archivo:
            crudo = json.load(archivo)
    except (FileNotFoundError, json.JSONDecodeError, OSError):
        crudo = {}
    if not isinstance(crudo, dict):
        crudo = {}
    modo = str(crudo.get("modo") or "").lower()
    return {
        "modo": MODO_REAL if modo == MODO_REAL else "",
        "nubefact_url": str(crudo.get("nubefact_url") or "").strip(),
        "nubefact_token": str(crudo.get("nubefact_token") or "").strip(),
    }


def estado() -> dict:
    """Resumen sin secretos, apto para mostrar en la app."""
    config = leer()
    listo = (
        config["modo"] == MODO_REAL
        and bool(config["nubefact_url"])
        and bool(config["nubefact_token"])
        and not _es_marcador(config["nubefact_url"])
        and not _es_marcador(config["nubefact_token"])
    )
    return {
        "modo": MODO_REAL if listo else "",
        "real_listo": listo,
        "activada": listo,
    }


def guardar(url: str, token: str) -> dict:
    """Activa la emisión real. Valida lo mínimo antes de guardar."""
    url = str(url or "").strip()
    token = str(token or "").strip()
    if not token:
        raise ValueError("Falta el token del proveedor autorizado (OSE/PSE).")
    if _es_marcador(token):
        raise ValueError("Ese token parece un ejemplo. Pega el token real del proveedor.")
    if not url:
        url = "https://api.nubefact.com/api/v1"
    if not re.match(r"^https://", url):
        raise ValueError("La URL del proveedor debe empezar con https://")
    if _es_marcador(url):
        raise ValueError("Esa URL parece un ejemplo. Pega la URL real del proveedor.")

    destino = ruta()
    os.makedirs(os.path.dirname(destino) or ".", exist_ok=True)
    with open(destino, "w", encoding="utf-8") as archivo:
        json.dump(
            {
                "modo": MODO_REAL,
                "nubefact_url": url,
                "nubefact_token": token,
            },
            archivo,
            ensure_ascii=False,
            indent=2,
        )
    try:
        os.chmod(destino, 0o600)
    except OSError:
        pass
    return estado()


def borrar() -> None:
    """Desactiva la emisión: la app queda bloqueada hasta configurarla."""
    try:
        os.remove(ruta())
    except FileNotFoundError:
        pass
