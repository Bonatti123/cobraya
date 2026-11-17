"""Generador mínimo de PDF con la biblioteca estándar.

No usa dependencias externas: escribe los objetos PDF a mano y usa las
fuentes Helvetica ya incluidas en cualquier lector. Sirve para entregar el
"Resumen para el contador" como archivo descargable y adjuntarlo por WhatsApp.
"""

from __future__ import annotations

ANCHO_PAGINA = 595.28   # A4 en puntos
ALTO_PAGINA = 841.89


def _escapar(texto) -> str:
    """Convierte el texto a WinAnsi y escapa los paréntesis del PDF."""
    limpio = str(texto)
    for viejo, nuevo in (
        ("—", "-"), ("–", "-"), ("“", '"'), ("”", '"'),
        ("’", "'"), ("…", "..."), ("\t", " "),
    ):
        limpio = limpio.replace(viejo, nuevo)
    # latin-1 cubre tildes, ñ, ¿ y ¡ (lo que usa el español).
    limpio = limpio.encode("latin-1", "replace").decode("latin-1")
    return limpio.replace("\\", "\\\\").replace("(", "\\(").replace(")", "\\)")


class Pdf:
    """Documento PDF secuencial: se escribe de arriba hacia abajo."""

    def __init__(self):
        self._paginas: list[list[str]] = [[]]

    def nueva_pagina(self) -> None:
        self._paginas.append([])

    def texto(self, x: float, y: float, contenido, tam: float = 10,
              negrita: bool = False, gris: float = 0.0) -> None:
        fuente = "F2" if negrita else "F1"
        self._paginas[-1].append(
            f"BT {gris:.2f} g /{fuente} {tam:.1f} Tf "
            f"{x:.1f} {y:.1f} Td ({_escapar(contenido)}) Tj ET"
        )

    def texto_derecha(self, x_derecha: float, y: float, contenido,
                      tam: float = 10, negrita: bool = False,
                      gris: float = 0.0) -> None:
        # Ancho aproximado de Helvetica; suficiente para alinear montos.
        ancho = len(str(contenido)) * tam * 0.52
        self.texto(x_derecha - ancho, y, contenido, tam, negrita, gris)

    def linea(self, x1: float, y1: float, x2: float, y2: float,
              gris: float = 0.85, grosor: float = 0.6) -> None:
        self._paginas[-1].append(
            f"{gris:.2f} G {grosor:.1f} w {x1:.1f} {y1:.1f} m "
            f"{x2:.1f} {y2:.1f} l S"
        )

    def rectangulo(self, x: float, y: float, ancho: float, alto: float,
                   gris: float = 0.96) -> None:
        self._paginas[-1].append(f"{gris:.2f} g {x:.1f} {y:.1f} {ancho:.1f} {alto:.1f} re f")

    def pie(self, izquierda: str = "") -> None:
        """Texto fijo al pie de todas las páginas, con numeración."""
        total = len(self._paginas)
        for indice, pagina in enumerate(self._paginas, start=1):
            if izquierda:
                pagina.append(
                    f"BT 0.45 g /F1 8 Tf 40 30 Td ({_escapar(izquierda)}) Tj ET"
                )
            pagina.append(
                f"BT 0.45 g /F1 8 Tf 480 30 Td "
                f"({_escapar(f'Página {indice} de {total}')}) Tj ET"
            )

    # ------------------------------------------------------------ escritura
    def guardar(self) -> bytes:
        contenidos = ["\n".join(pagina).encode("latin-1") for pagina in self._paginas]
        total_paginas = len(contenidos)
        objetos: dict[int, bytes] = {}

        hijos = []
        for i in range(total_paginas):
            pagina_id = 5 + 2 * i
            contenido_id = 6 + 2 * i
            hijos.append(f"{pagina_id} 0 R")
            objetos[pagina_id] = (
                "<< /Type /Page /Parent 2 0 R /MediaBox [0 0 595.28 841.89] "
                "/Resources << /Font << /F1 3 0 R /F2 4 0 R >> >> "
                f"/Contents {contenido_id} 0 R >>"
            ).encode("latin-1")
            cuerpo = contenidos[i]
            objetos[contenido_id] = (
                b"<< /Length " + str(len(cuerpo)).encode() +
                b" >>\nstream\n" + cuerpo + b"\nendstream"
            )

        objetos[1] = b"<< /Type /Catalog /Pages 2 0 R >>"
        objetos[2] = (
            "<< /Type /Pages /Kids [" + " ".join(hijos) +
            f"] /Count {total_paginas} >>"
        ).encode("latin-1")
        objetos[3] = (
            b"<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica "
            b"/Encoding /WinAnsiEncoding >>"
        )
        objetos[4] = (
            b"<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica-Bold "
            b"/Encoding /WinAnsiEncoding >>"
        )

        max_id = 4 + 2 * total_paginas
        salida = bytearray(b"%PDF-1.4\n%\xe2\xe3\xcf\xd3\n")
        posiciones = [0] * (max_id + 1)
        for numero in range(1, max_id + 1):
            posiciones[numero] = len(salida)
            salida += f"{numero} 0 obj\n".encode("ascii")
            salida += objetos[numero]
            salida += b"\nendobj\n"

        inicio_xref = len(salida)
        salida += f"xref\n0 {max_id + 1}\n".encode("ascii")
        salida += b"0000000000 65535 f \n"
        for numero in range(1, max_id + 1):
            salida += f"{posiciones[numero]:010d} 00000 n \n".encode("ascii")
        salida += (
            f"trailer\n<< /Size {max_id + 1} /Root 1 0 R >>\n"
            f"startxref\n{inicio_xref}\n%%EOF\n"
        ).encode("ascii")
        return bytes(salida)
