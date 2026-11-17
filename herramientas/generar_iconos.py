#!/usr/bin/env python3
"""Genera los iconos PNG de la PWA sin dependencias externas.

Dibuja un recibo blanco sobre un fondo verde con degradado y escribe los
archivos en estatico/iconos/. Solo hay que ejecutarlo si se quiere cambiar
el diseño del icono:

    python3 herramientas/generar_iconos.py
"""

from __future__ import annotations

import math
import os
import struct
import zlib

BASE = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
DESTINO = os.path.join(BASE, "estatico", "iconos")

VERDE_ARRIBA = (20, 184, 166)
VERDE_ABAJO = (15, 95, 88)
BLANCO = (255, 255, 255)
VERDE_TINTA = (15, 118, 110)

X0, X1 = 0.315, 0.685
Y0, Y1 = 0.185, 0.785
RADIO = 0.035
DIENTES = 5
AMPLITUD = 0.030
LINEAS = ((0.635, 0.300), (0.635, 0.372))
GRUESO_LINEA = 0.021
CHECK_CX, CHECK_CY, CHECK_R = 0.500, 0.565, 0.108


def dentro_redondeado(x, y, x0, y0, x1, y1, r):
    if x < x0 or x > x1 or y < y0 or y > y1:
        return False
    if y0 + r <= y <= y1 - r:
        return True
    cx = min(max(x, x0 + r), x1 - r)
    cy = min(max(y, y0 + r), y1 - r)
    return (x - cx) ** 2 + (y - cy) ** 2 <= r * r


def distancia_segmento(px, py, x1, y1, x2, y2):
    dx, dy = x2 - x1, y2 - y1
    if dx == 0 and dy == 0:
        return math.hypot(px - x1, py - y1)
    t = max(0.0, min(1.0, ((px - x1) * dx + (py - y1) * dy) / (dx * dx + dy * dy)))
    return math.hypot(px - (x1 + t * dx), py - (y1 + t * dy))


def color(x, y):
    """Devuelve el color RGB del punto (x, y) en coordenadas 0..1."""
    # Fondo con degradado diagonal
    t = max(0.0, min(1.0, (x + y) / 2))
    fondo = tuple(
        round(VERDE_ARRIBA[i] + (VERDE_ABAJO[i] - VERDE_ARRIBA[i]) * t) for i in range(3)
    )

    if not (X0 <= x <= X1):
        return fondo

    # Borde inferior en zigzag del recibo
    fase = ((x - X0) / ((X1 - X0) / DIENTES)) % 1.0
    borde = Y1 - AMPLITUD + AMPLITUD * abs(2 * fase - 1)

    dentro = Y0 <= y <= borde
    if dentro and y < Y0 + RADIO:
        cx = min(max(x, X0 + RADIO), X1 - RADIO)
        cy = Y0 + RADIO
        dentro = (x - cx) ** 2 + (y - cy) ** 2 <= RADIO * RADIO

    if not dentro:
        return fondo

    # Círculo con el check
    distancia = math.hypot(x - CHECK_CX, y - CHECK_CY)
    if distancia <= CHECK_R:
        puntos = [
            (CHECK_CX - 0.045, CHECK_CY + 0.002),
            (CHECK_CX - 0.012, CHECK_CY + 0.036),
            (CHECK_CX + 0.052, CHECK_CY - 0.036),
        ]
        for i in range(len(puntos) - 1):
            if distancia_segmento(x, y, *puntos[i], *puntos[i + 1]) <= 0.022:
                return BLANCO
        return VERDE_TINTA

    # Rayas del recibo
    for fin, alto in LINEAS:
        if abs(y - alto) <= GRUESO_LINEA / 2 and X0 + 0.055 <= x <= fin:
            return VERDE_TINTA

    return BLANCO


def renderizar(lado: int, muestras: int = 3):
    """Renderiza con supersampling. Devuelve (rgb, cobertura)."""
    rgb = []
    alfa = []
    paso = 1.0 / lado
    for py in range(lado):
        fila_rgb = []
        fila_a = []
        for px in range(lado):
            r = g = b = 0
            cubierto = 0
            for sy in range(muestras):
                for sx in range(muestras):
                    x = px * paso + (sx + 0.5) * paso / muestras
                    y = py * paso + (sy + 0.5) * paso / muestras
                    cr, cg, cb = color(x, y)
                    r += cr
                    g += cg
                    b += cb
                    if dentro_redondeado(x, y, 0.015, 0.015, 0.985, 0.985, 0.205):
                        cubierto += 1
            total = muestras * muestras
            fila_rgb.append((round(r / total), round(g / total), round(b / total)))
            fila_a.append(cubierto / total)
        rgb.append(fila_rgb)
        alfa.append(fila_a)
    return rgb, alfa


def escalar(rgb, alfa, destino):
    alto = len(rgb)
    ancho = len(rgb[0])
    factor_x = ancho / destino
    factor_y = alto / destino
    nuevo_rgb = []
    nuevo_alfa = []
    for py in range(destino):
        y0, y1 = py * factor_y, (py + 1) * factor_y
        fila_rgb = []
        fila_a = []
        for px in range(destino):
            x0, x1 = px * factor_x, (px + 1) * factor_x
            r = g = b = a = 0.0
            n = 0
            for sy in range(int(y0), min(alto, math.ceil(y1))):
                for sx in range(int(x0), min(ancho, math.ceil(x1))):
                    peso = (min(x1, sx + 1) - max(x0, sx)) * (min(y1, sy + 1) - max(y0, sy))
                    if peso <= 0:
                        continue
                    pr, pg, pb = rgb[sy][sx]
                    r += pr * peso
                    g += pg * peso
                    b += pb * peso
                    a += alfa[sy][sx] * peso
                    n += peso
            fila_rgb.append((round(r / n), round(g / n), round(b / n)))
            fila_a.append(a / n)
        nuevo_rgb.append(fila_rgb)
        nuevo_alfa.append(fila_a)
    return nuevo_rgb, nuevo_alfa


def guardar_png(ruta, rgb, alfa, opaco=False):
    alto = len(rgb)
    ancho = len(rgb[0])
    crudo = bytearray()
    for y in range(alto):
        crudo.append(0)  # filtro None
        for x in range(ancho):
            r, g, b = rgb[y][x]
            a = 255 if opaco else round(alfa[y][x] * 255)
            crudo.extend((r, g, b, a))

    def trozo(tipo, datos):
        return (
            struct.pack(">I", len(datos))
            + tipo
            + datos
            + struct.pack(">I", zlib.crc32(tipo + datos) & 0xFFFFFFFF)
        )

    cabecera = struct.pack(">IIBBBBB", ancho, alto, 8, 6, 0, 0, 0)
    with open(ruta, "wb") as archivo:
        archivo.write(b"\x89PNG\r\n\x1a\n")
        archivo.write(trozo(b"IHDR", cabecera))
        archivo.write(trozo(b"IDAT", zlib.compress(bytes(crudo), 9)))
        archivo.write(trozo(b"IEND", b""))
    print(f"  ✓ {os.path.relpath(ruta, BASE)} ({ancho}×{alto}, {os.path.getsize(ruta) // 1024} KB)")


def main():
    os.makedirs(DESTINO, exist_ok=True)
    print("Generando iconos de CobraYa…")
    rgb, alfa = renderizar(512, muestras=3)

    guardar_png(os.path.join(DESTINO, "icono-512.png"), rgb, alfa)
    for lado in (192, 180):
        r, a = escalar(rgb, alfa, lado)
        guardar_png(os.path.join(DESTINO, f"icono-{lado}.png"), r, a)
    guardar_png(os.path.join(DESTINO, "icono-maskable-512.png"), rgb, alfa, opaco=True)
    print("Listo.")


if __name__ == "__main__":
    main()
