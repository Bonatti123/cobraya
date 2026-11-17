"""Representación impresa (HTML) de la boleta / factura electrónica."""

from __future__ import annotations

import re
from datetime import datetime
from html import escape
from urllib.parse import quote

from sunat import tipo_comprobante
from pdf import Pdf

MESES = {
    "01": "enero", "02": "febrero", "03": "marzo", "04": "abril",
    "05": "mayo", "06": "junio", "07": "julio", "08": "agosto",
    "09": "setiembre", "10": "octubre", "11": "noviembre", "12": "diciembre",
}


def soles(valor: float) -> str:
    return f"S/ {valor:,.2f}"


def fecha_legible(texto: str) -> str:
    try:
        f, h = texto.split(" ")
        anio, mes, dia = f.split("-")
        return f"{int(dia)} de {MESES.get(mes, mes)} de {anio} · {h[:5]}"
    except (ValueError, AttributeError):
        return texto


def _fila_item(item: dict, factor: float) -> str:
    cantidad = float(item["cantidad"])
    precio = float(item["precio_unitario"])
    total = float(item["total"])
    valor_unitario = precio / factor
    return f"""
      <tr>
        <td class="cant">{cantidad:g}</td>
        <td>
          <strong>{escape(item['descripcion'])}</strong>
          <span class="unit">Valor unit. {soles(valor_unitario)} · IGV incluido</span>
        </td>
        <td class="num">{soles(precio)}</td>
        <td class="num">{soles(total)}</td>
      </tr>"""


def generar_html(negocio: dict, venta: dict, volver: str = "/") -> str:
    tipo, titulo = tipo_comprobante(venta["numero"])
    factor = 1 + float(negocio.get("igv", 18.0)) / 100.0
    anulada = venta.get("estado") == "anulada"
    estado_sunat = (venta.get("sunat_estado") or "").lower()
    badge = {
        "aceptada": ("Aceptada por SUNAT", "ok"),
        "error": ("Observada por SUNAT", "error"),
        "pendiente": ("Envío pendiente", "warn"),
    }.get(estado_sunat, ("Sin estado", "warn"))

    items_html = "".join(_fila_item(i, factor) for i in venta["items"])
    ruc = escape(negocio.get("ruc") or "—")
    direccion = escape(negocio.get("direccion") or "")
    telefono = escape(negocio.get("telefono") or "")
    cliente = escape(venta.get("cliente_nombre") or "CLIENTES VARIOS")
    documento = escape(venta.get("cliente_doc") or "—")

    enlaces = ""
    if venta.get("enlace_pdf"):
        enlaces += f'<a class="btn-sec" href="{escape(venta["enlace_pdf"])}" target="_blank" rel="noopener">PDF SUNAT</a>'
    if venta.get("enlace_xml"):
        enlaces += f'<a class="btn-sec" href="{escape(venta["enlace_xml"])}" target="_blank" rel="noopener">XML</a>'

    notas = ""
    if estado_sunat == "error":
        notas = f"<p class='nota error'>SUNAT: {escape(venta.get('sunat_mensaje') or 'sin detalle')}</p>"

    mensaje_wa = (
        f"{negocio.get('nombre', '')}%0A{titulo.title()} {venta['numero']}%0A"
        f"Total: {soles(venta['total']).replace(' ', '%20')}%0A"
        f"Fecha: {fecha_legible(venta['creado_en'])}"
    )
    # Si el cliente dejó su celular, el botón abre el chat directo con él.
    celular_wa = re.sub(r"\D", "", str(venta.get("cliente_celular") or ""))
    destino_wa = f"51{celular_wa}" if len(celular_wa) == 9 else ""

    return f"""<!DOCTYPE html>
<html lang="es">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>{titulo.title()} {escape(venta['numero'])}</title>
<style>
  :root {{
    --tinta: #10241f;
    --suave: #5b6f68;
    --linea: #dfe7e3;
    --verde: #0f766e;
    --verde-claro: #e6f4f1;
    --rojo: #b42318;
    --ambar: #b54708;
  }}
  * {{ box-sizing: border-box; }}
  body {{
    margin: 0; padding: 24px 16px 64px;
    background: #eef3f1; color: var(--tinta);
    font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, "Helvetica Neue", Arial, sans-serif;
    font-size: 14px; line-height: 1.45;
  }}
  .acciones {{ max-width: 760px; margin: 0 auto 14px; display: flex; gap: 8px; flex-wrap: wrap; }}
  .btn, .btn-sec {{
    display: inline-flex; align-items: center; gap: 6px; border: 0; cursor: pointer;
    font: inherit; font-weight: 600; padding: 10px 16px; border-radius: 10px;
    text-decoration: none; background: var(--verde); color: #fff;
  }}
  .btn-sec {{ background: #fff; color: var(--tinta); border: 1px solid var(--linea); }}
  .hoja {{
    position: relative; max-width: 760px; margin: 0 auto; background: #fff;
    border-radius: 14px; padding: 32px; box-shadow: 0 10px 30px rgba(16, 36, 31, .08);
  }}
  header {{ display: flex; justify-content: space-between; gap: 24px; align-items: flex-start; }}
  .marca {{ display: flex; gap: 12px; align-items: center; }}
  .logo {{
    width: 46px; height: 46px; border-radius: 12px; background: var(--verde);
    display: grid; place-items: center; color: #fff; flex: none;
  }}
  h1 {{ font-size: 18px; margin: 0 0 2px; letter-spacing: -.01em; }}
  .muted {{ color: var(--suave); font-size: 12.5px; margin: 0; }}
  .doc {{ text-align: right; }}
  .doc .tipo {{ font-size: 11px; letter-spacing: .12em; text-transform: uppercase; color: var(--suave); }}
  .doc .numero {{ font-size: 20px; font-weight: 700; letter-spacing: -.02em; }}
  .badge {{
    display: inline-block; margin-top: 8px; padding: 3px 9px; border-radius: 999px;
    font-size: 11px; font-weight: 600; background: var(--verde-claro); color: var(--verde);
  }}
  .badge.error {{ background: #fdecea; color: var(--rojo); }}
  .badge.warn {{ background: #fef3e7; color: var(--ambar); }}
  hr {{ border: 0; border-top: 1px solid var(--linea); margin: 20px 0; }}
  .cliente {{ display: grid; grid-template-columns: 1fr 1fr; gap: 10px 24px; }}
  .campo span {{ display: block; font-size: 10.5px; letter-spacing: .08em; text-transform: uppercase; color: var(--suave); }}
  .campo strong {{ font-weight: 600; }}
  table {{ width: 100%; border-collapse: collapse; margin-top: 6px; }}
  thead th {{
    text-align: left; font-size: 10.5px; letter-spacing: .08em; text-transform: uppercase;
    color: var(--suave); border-bottom: 1px solid var(--linea); padding: 8px 6px;
  }}
  tbody td {{ padding: 10px 6px; border-bottom: 1px solid #f1f5f3; vertical-align: top; }}
  td.cant, th.cant {{ width: 46px; }}
  td.num, th.num {{ text-align: right; white-space: nowrap; }}
  .unit {{ display: block; color: var(--suave); font-size: 11.5px; }}
  .totales {{ margin-left: auto; width: 100%; max-width: 300px; margin-top: 16px; }}
  .totales div {{ display: flex; justify-content: space-between; padding: 5px 0; }}
  .totales .final {{
    border-top: 1px solid var(--linea); margin-top: 6px; padding-top: 10px;
    font-size: 17px; font-weight: 700;
  }}
  .pago {{ display: flex; gap: 10px; flex-wrap: wrap; margin-top: 4px; }}
  .chip {{ background: #f4f8f6; border: 1px solid var(--linea); border-radius: 8px; padding: 5px 10px; font-size: 12px; }}
  .nota {{ font-size: 12px; color: var(--suave); background: #fafcfb; border: 1px dashed var(--linea); padding: 10px 12px; border-radius: 8px; }}
  .nota.error {{ color: var(--rojo); }}
  footer {{ margin-top: 28px; padding-top: 14px; border-top: 1px solid var(--linea); color: var(--suave); font-size: 11.5px; }}
  .anulada {{
    position: absolute; inset: 0; display: grid; place-items: center; pointer-events: none;
  }}
  .anulada span {{
    border: 4px solid rgba(180, 35, 24, .35); color: rgba(180, 35, 24, .45);
    font-size: 46px; font-weight: 800; letter-spacing: .2em; padding: 8px 28px;
    transform: rotate(-14deg); border-radius: 10px;
  }}
  @media (max-width: 560px) {{
    body {{ padding: 12px 8px 80px; }}
    .hoja {{ padding: 20px 16px; border-radius: 10px; }}
    header {{ flex-direction: column; gap: 14px; }}
    .doc {{ text-align: left; }}
    .cliente {{ grid-template-columns: 1fr; }}
  }}
  @media print {{
    body {{ background: #fff; padding: 0; }}
    .acciones {{ display: none; }}
    .hoja {{ box-shadow: none; border-radius: 0; max-width: none; padding: 0; }}
    @page {{ margin: 14mm; }}
  }}
</style>
</head>
<body>
  <div class="acciones">
    <button class="btn" onclick="window.print()">Imprimir / Guardar PDF</button>
    <a class="btn-sec" href="{escape(volver)}">Volver a la app</a>
    <a class="btn-sec" href="https://wa.me/{destino_wa}?text={escape(mensaje_wa)}" target="_blank" rel="noopener">Enviar por WhatsApp</a>
    {enlaces}
  </div>

  <article class="hoja">
    {'<div class="anulada"><span>ANULADA</span></div>' if anulada else ''}
    <header>
      <div class="marca">
        <div class="logo" aria-hidden="true">
          <svg width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round">
            <path d="M5 3h14v18l-3-2-2 2-2-2-2 2-2-2-3 2V3z"/><path d="M9 8h6M9 12h6M9 16h3"/>
          </svg>
        </div>
        <div>
          <h1>{escape(negocio.get('nombre') or 'Mi negocio')}</h1>
          <p class="muted">RUC {ruc}</p>
          {f'<p class="muted">{direccion}</p>' if direccion else ''}
          {f'<p class="muted">Tel. {telefono}</p>' if telefono else ''}
        </div>
      </div>
      <div class="doc">
        <div class="tipo">{titulo}</div>
        <div class="numero">{escape(venta['numero'])}</div>
        <span class="badge {badge[1]}">{badge[0]}</span>
      </div>
    </header>

    <hr>

    <section class="cliente">
      <div class="campo"><span>Cliente</span><strong>{cliente}</strong></div>
      <div class="campo"><span>Documento</span><strong>{documento}</strong></div>
      <div class="campo"><span>Fecha de emisión</span><strong>{fecha_legible(venta['creado_en'])}</strong></div>
      <div class="campo"><span>Forma de pago</span><strong>{escape(venta['metodo_pago'])}</strong></div>
    </section>

    <hr>

    <table>
      <thead>
        <tr><th class="cant">Cant.</th><th>Descripción</th><th class="num">P. unit.</th><th class="num">Total</th></tr>
      </thead>
      <tbody>{items_html}
      </tbody>
    </table>

    <div class="totales">
      <div><span>Op. gravada</span><strong>{soles(venta['subtotal'])}</strong></div>
      <div><span>IGV ({negocio.get('igv', 18):g}%)</span><strong>{soles(venta['igv'])}</strong></div>
      <div class="final"><span>Total</span><span>{soles(venta['total'])}</span></div>
    </div>

    <hr>

    <div class="pago">
      <span class="chip">Pago: {escape(venta['metodo_pago'])}</span>
      <span class="chip">Moneda: Soles</span>
      <span class="chip">Comprobante: {'Factura' if tipo == 1 else 'Boleta'} electrónica</span>
    </div>

    {notas}

    <footer>
      <p>Representación impresa de la {titulo.lower()}. Su validez puede verificarse en
      <strong>sunat.gob.pe</strong> con el número de comprobante.</p>
      {f'<p>Código de verificación: {escape(venta["sunat_hash"])}</p>' if venta.get('sunat_hash') else ''}
      <p>Emitido con CobraYa · caja y boleta para micronegocios</p>
    </footer>
  </article>
</body>
</html>"""


def generar_reporte_html(negocio: dict, datos: dict, volver: str = "/") -> str:
    """Resumen imprimible para el contador (insumo para validar el SIRE)."""
    desde = datos["desde"]
    hasta = datos["hasta"]
    periodo = f"{desde[8:10]}/{desde[5:7]}/{desde[0:4]} al {hasta[8:10]}/{hasta[5:7]}/{hasta[0:4]}"
    titulo = f"Resumen de ventas · {periodo}"

    filas_dia = "".join(
        f"<tr><td>{escape(d['fecha'])}</td><td class='num'>{d['boletas']}</td>"
        f"<td class='num'>{soles(d['total'])}</td></tr>"
        for d in datos["por_dia"]
    ) or "<tr class='vacio'><td colspan='3'>Sin ventas en el periodo</td></tr>"

    filas_metodo = "".join(
        f"<tr><td>{escape(m['metodo'])}</td><td class='num'>{m['boletas']}</td>"
        f"<td class='num'>{soles(m['total'])}</td></tr>"
        for m in datos["por_metodo"]
    ) or "<tr class='vacio'><td colspan='3'>Sin ventas en el periodo</td></tr>"

    filas_venta = "".join(
        "<tr>"
        f"<td>{escape(v['numero'])}</td>"
        f"<td>{escape(fecha_legible(v['creado_en']).split(' · ')[0])}</td>"
        f"<td>{escape(v['cliente_nombre'] or 'Clientes varios')}</td>"
        f"<td>{escape(v['cliente_doc'] or '—')}</td>"
        f"<td>{escape(v['metodo_pago'])}</td>"
        f"<td class='num'>{soles(v['total'])}</td>"
        f"<td>{'Anulada' if v['estado'] == 'anulada' else 'Emitida'}</td>"
        "</tr>"
        for v in datos["detalle"]
    ) or "<tr class='vacio'><td colspan='7'>Sin comprobantes en el periodo</td></tr>"

    if datos["pendientes_sunat"]:
        aviso_pendientes = (
            f"Hay {datos['pendientes_sunat']} comprobante(s) con envío pendiente u observado: "
            "revisar antes de declarar."
        )
    else:
        aviso_pendientes = "Todos los comprobantes del periodo fueron aceptados."

    aviso_anuladas = ""
    if datos["anuladas_cantidad"]:
        aviso_anuladas = (
            f" Se anularon {datos['anuladas_cantidad']} comprobante(s) por "
            f"{soles(datos['anuladas_total'])}."
        )

    # Fecha real de generación del reporte (no la de la primera venta).
    from datetime import datetime

    generado = fecha_legible(datetime.now().strftime("%Y-%m-%d %H:%M:%S"))

    # Texto corto para compartir con el contador por WhatsApp
    mensaje = (
        f"Resumen CobraYa · {negocio.get('nombre', '')}\n"
        f"Periodo: {periodo}\n"
        f"Comprobantes emitidos: {datos['boletas']}\n"
        f"Total vendido: {soles(datos['total'])}\n"
        f"IGV desagregado: {soles(datos['igv'])}\n"
        f"Anuladas: {datos['anuladas_cantidad']} ({soles(datos['anuladas_total'])})\n"
        f"Ticket promedio: {soles(datos['ticket_promedio'])}"
    )
    enlace_wa = "https://wa.me/?text=" + quote(mensaje)

    return f"""<!DOCTYPE html>
<html lang="es">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>{escape(titulo)}</title>
<style>
  :root {{ --tinta:#10241f; --suave:#5b6f68; --linea:#dfe7e3; --verde:#0f766e; }}
  * {{ box-sizing:border-box; }}
  body {{
    margin:0; padding:24px 16px 64px; background:#eef3f1; color:var(--tinta);
    font-family:-apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, Arial, sans-serif;
    font-size:13px; line-height:1.45;
  }}
  .acciones {{ max-width:820px; margin:0 auto 14px; display:flex; gap:8px; flex-wrap:wrap; }}
  .acciones-nota {{ max-width:820px; margin:-6px auto 14px; color:var(--suave); font-size:11.5px; }}
  .btn, .btn-sec {{
    display:inline-flex; align-items:center; gap:6px; border:0; cursor:pointer;
    font:inherit; font-weight:600; padding:10px 16px; border-radius:10px;
    text-decoration:none; background:var(--verde); color:#fff;
  }}
  .btn-sec {{ background:#fff; color:var(--tinta); border:1px solid var(--linea); }}
  .hoja {{
    max-width:820px; margin:0 auto; background:#fff; border-radius:14px;
    padding:34px; box-shadow:0 10px 30px rgba(16,36,31,.08);
  }}
  header {{ display:flex; justify-content:space-between; gap:24px; align-items:flex-start; }}
  h1 {{ font-size:20px; margin:0 0 3px; letter-spacing:-.02em; }}
  h2 {{ font-size:14px; margin:26px 0 10px; letter-spacing:-.01em; }}
  .muted {{ color:var(--suave); font-size:12px; margin:0; }}
  .doc {{ text-align:right; }}
  .doc strong {{ display:block; font-size:16px; }}
  .kpis {{ display:grid; grid-template-columns:repeat(4,1fr); gap:10px; margin-top:22px; }}
  .kpi {{ background:#f6faf8; border:1px solid var(--linea); border-radius:12px; padding:12px; }}
  .kpi span {{ display:block; font-size:10.5px; text-transform:uppercase; letter-spacing:.08em; color:var(--suave); margin-bottom:4px; }}
  .kpi strong {{ font-size:17px; font-variant-numeric:tabular-nums; }}
  table {{ width:100%; border-collapse:collapse; }}
  th {{ text-align:left; font-size:10.5px; text-transform:uppercase; letter-spacing:.07em; color:var(--suave); padding:7px 6px; border-bottom:1px solid var(--linea); }}
  td {{ padding:8px 6px; border-bottom:1px solid #f1f5f3; vertical-align:top; }}
  td.num, th.num {{ text-align:right; font-variant-numeric:tabular-nums; white-space:nowrap; }}
  tr.vacio td {{ text-align:center; color:var(--suave); padding:18px; }}
  .aviso {{ font-size:12px; color:var(--suave); background:#fafcfb; border:1px dashed var(--linea); padding:11px 13px; border-radius:9px; margin-top:18px; }}
  footer {{ margin-top:26px; padding-top:14px; border-top:1px solid var(--linea); color:var(--suave); font-size:11px; }}
  @media (max-width:640px) {{
    .hoja {{ padding:20px 14px; }}
    .kpis {{ grid-template-columns:1fr 1fr; }}
    header {{ flex-direction:column; }}
    .doc {{ text-align:left; }}
    .tabla-scroll {{ overflow-x:auto; }}
  }}
  @media print {{
    body {{ background:#fff; padding:0; }}
    .acciones {{ display:none; }}
    .hoja {{ box-shadow:none; border-radius:0; padding:0; max-width:none; }}
    @page {{ margin:14mm; }}
  }}
</style>
</head>
<body>
  <div class="acciones">
    <a class="btn" href="/api/reporte.pdf?desde={desde}&hasta={hasta}">Descargar PDF</a>
    <button class="btn-sec" onclick="window.print()">Imprimir</button>
    <a class="btn-sec" href="{escape(volver)}">Volver a la app</a>
    <a class="btn-sec" href="{escape(enlace_wa)}" target="_blank" rel="noopener">Enviar resumen por WhatsApp</a>
  </div>
  <p class="acciones-nota">El PDF se descarga listo para adjuntarlo en WhatsApp. El botón de WhatsApp comparte el resumen en texto.</p>

  <article class="hoja">
    <header>
      <div>
        <h1>{escape(negocio.get('nombre') or 'Mi negocio')}</h1>
        <p class="muted">RUC {escape(negocio.get('ruc') or '—')}{(' · ' + escape(negocio.get('direccion'))) if negocio.get('direccion') else ''}</p>
        {f'<p class="muted">Tel. {escape(negocio.get("telefono"))}</p>' if negocio.get('telefono') else ''}
      </div>
      <div class="doc">
        <strong>Resumen para el contador</strong>
        <p class="muted">{periodo}</p>
      </div>
    </header>

    <section class="kpis">
      <div class="kpi"><span>Total vendido</span><strong>{soles(datos['total'])}</strong></div>
      <div class="kpi"><span>Comprobantes</span><strong>{datos['boletas']}</strong></div>
      <div class="kpi"><span>IGV desagregado</span><strong>{soles(datos['igv'])}</strong></div>
      <div class="kpi"><span>Ticket promedio</span><strong>{soles(datos['ticket_promedio'])}</strong></div>
    </section>

    <h2>Ventas por día</h2>
    <table>
      <thead><tr><th>Fecha</th><th class="num">Comprobantes</th><th class="num">Total</th></tr></thead>
      <tbody>{filas_dia}</tbody>
    </table>

    <h2>Por medio de pago</h2>
    <table>
      <thead><tr><th>Medio</th><th class="num">Comprobantes</th><th class="num">Total</th></tr></thead>
      <tbody>{filas_metodo}</tbody>
    </table>

    <h2>Comprobantes del periodo</h2>
    <div class="tabla-scroll">
      <table>
        <thead>
          <tr><th>Comprobante</th><th>Fecha</th><th>Cliente</th><th>Documento</th><th>Pago</th><th class="num">Total</th><th>Estado</th></tr>
        </thead>
        <tbody>{filas_venta}</tbody>
      </table>
    </div>

    <p class="aviso">
      <strong>Para el SIRE:</strong> este resumen ordena las ventas del periodo tal como fueron emitidas.
      El contador puede contrastarlo con la propuesta automática de SUNAT y aceptarla o corregirla.
      {aviso_pendientes}{aviso_anuladas}
    </p>

    <footer>
      <p>El IGV mostrado es el desagregado de los precios cobrados (IGV incluido); no constituye una declaración tributaria.</p>
      <p>Generado con CobraYa · caja y boleta para micronegocios · {escape(generado)}</p>
    </footer>
  </article>
</body>
</html>"""


# ----------------------------------------------------------------------
# PDF del resumen para el contador
# ----------------------------------------------------------------------
def _fecha_corta(texto: str) -> str:
    """Convierte «2026-11-12 10:30:00» en «12/11/2026»."""
    try:
        fecha = str(texto).split(" ")[0]
        anio, mes, dia = fecha.split("-")
        return f"{dia}/{mes}/{anio}"
    except (ValueError, AttributeError):
        return str(texto)


def _envolver(texto: str, limite: int) -> list[str]:
    """Corta un texto en líneas de ``limite`` caracteres (aproximado)."""
    lineas: list[str] = []
    actual = ""
    for palabra in str(texto).split():
        if len(actual) + len(palabra) + 1 <= limite:
            actual = f"{actual} {palabra}".strip()
        else:
            if actual:
                lineas.append(actual)
            actual = palabra
    if actual:
        lineas.append(actual)
    return lineas or [""]


def generar_reporte_pdf(negocio: dict, datos: dict) -> bytes:
    """Arma el resumen del periodo en un PDF listo para descargar y adjuntar."""
    desde = datos["desde"]
    hasta = datos["hasta"]
    periodo = (
        f"{desde[8:10]}/{desde[5:7]}/{desde[0:4]} al "
        f"{hasta[8:10]}/{hasta[5:7]}/{hasta[0:4]}"
    )

    doc = Pdf()
    y = 800.0

    def asegurar(espacio: float) -> None:
        nonlocal y
        if y - espacio < 60:
            doc.nueva_pagina()
            y = 800.0

    def cabecera_tabla(titulo: str, columnas: list[tuple[float, str, str]]) -> None:
        nonlocal y
        asegurar(70)
        doc.texto(40, y, titulo, 10.5, negrita=True)
        y -= 15
        for x, etiqueta, alineacion in columnas:
            if alineacion == "r":
                doc.texto_derecha(x, y, etiqueta.upper(), 7.2, gris=0.45)
            else:
                doc.texto(x, y, etiqueta.upper(), 7.2, gris=0.45)
        y -= 5
        doc.linea(40, y, 555, y, 0.84, 0.7)
        y -= 12

    def fila_tabla(valores: list[str], columnas: list[tuple[float, str, str]],
                   tam: float = 9.2, gris: float = 0.12) -> None:
        nonlocal y
        asegurar(20)
        for (x, _etiqueta, alineacion), valor in zip(columnas, valores):
            if alineacion == "r":
                doc.texto_derecha(x, y, valor, tam, gris=gris)
            else:
                doc.texto(x, y, valor, tam, gris=gris)
        y -= 12.5

    # ------------------------------------------------------------ encabezado
    doc.texto(40, y, negocio.get("nombre") or "Mi negocio", 15, negrita=True)
    lineas_ruc = f"RUC {negocio.get('ruc') or '—'}"
    if negocio.get("direccion"):
        lineas_ruc += f" · {negocio['direccion']}"
    if negocio.get("telefono"):
        lineas_ruc += f" · Tel. {negocio['telefono']}"
    doc.texto(40, y - 14, lineas_ruc, 8.3, gris=0.42)
    doc.texto_derecha(555, y, "RESUMEN PARA EL CONTADOR", 9.5, negrita=True)
    doc.texto_derecha(555, y - 13, periodo, 8.3, gris=0.42)
    y -= 24
    doc.linea(40, y, 555, y, 0.8, 0.8)
    y -= 20

    # ------------------------------------------------------------ indicadores
    cajas = [
        ("Total vendido", soles(datos["total"])),
        ("Comprobantes", str(datos["boletas"])),
        ("IGV desagregado", soles(datos["igv"])),
        ("Ticket promedio", soles(datos["ticket_promedio"])),
    ]
    ancho_caja = (555 - 40 - 8 * 3) / 4
    for indice, (etiqueta, valor) in enumerate(cajas):
        x = 40 + indice * (ancho_caja + 8)
        doc.rectangulo(x, y - 46, ancho_caja, 46, 0.965)
        doc.texto(x + 9, y - 15, etiqueta.upper(), 6.6, gris=0.45)
        doc.texto(x + 9, y - 34, valor, 12.5, negrita=True)
    y -= 64

    # ------------------------------------------------------------ ventas por día
    columnas_dia = [(40, "Fecha", "l"), (430, "Comprobantes", "r"), (555, "Total", "r")]
    cabecera_tabla("Ventas por día", columnas_dia)
    if datos["por_dia"]:
        for dia in datos["por_dia"]:
            fila_tabla(
                [dia["fecha"], str(dia["boletas"]), soles(dia["total"])],
                columnas_dia,
            )
    else:
        fila_tabla(["Sin ventas en el periodo", "", ""], columnas_dia, gris=0.45)
    y -= 8

    # ------------------------------------------------------------ medios de pago
    columnas_pago = [(40, "Medio", "l"), (430, "Comprobantes", "r"), (555, "Total", "r")]
    cabecera_tabla("Por medio de pago", columnas_pago)
    if datos["por_metodo"]:
        for metodo in datos["por_metodo"]:
            fila_tabla(
                [metodo["metodo"], str(metodo["boletas"]), soles(metodo["total"])],
                columnas_pago,
            )
    else:
        fila_tabla(["Sin ventas en el periodo", "", ""], columnas_pago, gris=0.45)
    y -= 8

    # ------------------------------------------------------------ comprobantes
    columnas_detalle = [
        (40, "Comprobante", "l"),
        (130, "Fecha", "l"),
        (200, "Cliente", "l"),
        (300, "Documento", "l"),
        (358, "Pago", "l"),
        (470, "Total", "r"),
        (480, "Estado", "l"),
    ]
    cabecera_tabla("Comprobantes del periodo", columnas_detalle)
    if datos["detalle"]:
        for venta in datos["detalle"]:
            fecha = _fecha_corta(venta.get("creado_en", ""))
            cliente = (venta.get("cliente_nombre") or "Clientes varios")[:19]
            fila_tabla(
                [
                    str(venta.get("numero", "")),
                    fecha,
                    cliente,
                    str(venta.get("cliente_doc") or "—")[:11],
                    str(venta.get("metodo_pago") or "")[:13],
                    soles(venta.get("total") or 0),
                    "Anulada" if venta.get("estado") == "anulada" else "Emitida",
                ],
                columnas_detalle,
                tam=8.4,
            )
    else:
        fila_tabla(["Sin comprobantes en el periodo", "", "", "", "", "", ""],
                   columnas_detalle, gris=0.45)
    y -= 14

    # ------------------------------------------------------------ nota SIRE
    aviso = (
        "Para el SIRE: este resumen ordena las ventas del periodo tal como fueron "
        "emitidas. El contador puede contrastarlo con la propuesta automática de "
        "SUNAT y aceptarla o corregirla. "
    )
    if datos["pendientes_sunat"]:
        aviso += (
            f"Hay {datos['pendientes_sunat']} comprobante(s) con envío pendiente u "
            "observado: revisar antes de declarar."
        )
    else:
        aviso += "Todos los comprobantes del periodo fueron aceptados."
    if datos["anuladas_cantidad"]:
        aviso += (
            f" Se anularon {datos['anuladas_cantidad']} comprobante(s) por "
            f"{soles(datos['anuladas_total'])}."
        )

    lineas_aviso = _envolver(aviso, 104)
    alto_aviso = 12 + len(lineas_aviso) * 10.5
    asegurar(alto_aviso + 30)
    doc.rectangulo(40, y - alto_aviso, 515, alto_aviso, 0.975)
    y -= 15
    for linea in lineas_aviso:
        doc.texto(50, y, linea, 8.1, gris=0.28)
        y -= 10.5
    y -= 12

    # ------------------------------------------------------------ pie
    doc.linea(40, y, 555, y, 0.86, 0.6)
    y -= 13
    doc.texto(
        40, y,
        "El IGV mostrado es el desagregado de los precios cobrados (IGV incluido); "
        "no constituye una declaración tributaria.",
        7.4, gris=0.45,
    )
    y -= 10
    doc.texto(
        40, y,
        f"Generado con CobraYa · caja y boleta para micronegocios · "
        f"{fecha_legible(datetime.now().strftime('%Y-%m-%d %H:%M:%S'))}",
        7.4, gris=0.45,
    )

    doc.pie("CobraYa · resumen para el contador")
    return doc.guardar()
