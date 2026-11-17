#!/usr/bin/env python3
"""Activa la emisión electrónica de CobraYa en esta instalación.

El dueño del negocio no ve URLs ni tokens: eso lo configura quien instala la
app. Sin este paso, la app deja configurar el negocio pero **no permite
vender**, porque no puede emitir comprobantes.

Uso:
    python3 herramientas/configurar_emision.py --estado
    python3 herramientas/configurar_emision.py \\
        --url https://api.nubefact.com/api/v1/xxxxxxxx \\
        --token TU_TOKEN
    python3 herramientas/configurar_emision.py --borrar

Después de configurar, reinicia el servidor para que la app lo detecte.
"""

from __future__ import annotations

import argparse
import os
import sys

RAIZ = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
sys.path.insert(0, RAIZ)

import emision  # noqa: E402


def mostrar_estado() -> None:
    config = emision.leer()
    estado = emision.estado()
    print("=" * 56)
    print("  Emisión electrónica de CobraYa")
    print("=" * 56)
    print(f"  Activada    : {'sí' if estado['activada'] else 'no'}")
    print(f"  Archivo     : {emision.ruta()}")
    if estado["activada"]:
        print(f"  URL         : {config['nubefact_url']}")
        print(f"  Token       : (guardado)")
    print()
    print("  Para activar la emisión:")
    print("    python3 herramientas/configurar_emision.py \\")
    print("      --url https://api.nubefact.com/api/v1/xxxx \\")
    print("      --token TU_TOKEN")
    print()
    print("  Para desactivarla:")
    print("    python3 herramientas/configurar_emision.py --borrar")


def main() -> int:
    parser = argparse.ArgumentParser(
        description="Configura el proveedor autorizado (OSE/PSE) de esta instalación."
    )
    parser.add_argument("--estado", action="store_true", help="Muestra la configuración actual.")
    parser.add_argument("--borrar", action="store_true", help="Desactiva la emisión electrónica.")
    parser.add_argument("--url", default="", help="URL de la API del proveedor.")
    parser.add_argument("--token", default="", help="Token del proveedor.")
    args = parser.parse_args()

    if args.borrar:
        emision.borrar()
        print("Listo: la emisión electrónica quedó desactivada.")
        mostrar_estado()
        return 0

    if args.url or args.token:
        try:
            emision.guardar(args.url, args.token)
        except ValueError as error:
            print(f"Error: {error}", file=sys.stderr)
            return 1
        print("Listo: emisión electrónica activada.")
        mostrar_estado()
        return 0

    mostrar_estado()
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
