#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""
generate_assets.py — Gerador de assets de marca do DriveFlin (v2)

PROBLEMA DA v1
--------------
A v1 usava retangulos de recorte *fixos* (MARK_BBOX / TEXT_BBOX) que foram
medidos para a arte ANTIGA (DriveFlin.png, 1892x1056). Ao trocar a arte por
Driveflin_logo.png (1377x768), os retangulos deixaram de casar com o desenho:
o recorte do simbolo comecava em x=706, ou seja no MEIO da letra "D", e o
resto do quadro virava espaco vazio. Resultado: icones e banners cortados.

COMO A v2 RESOLVE
-----------------
1. Detecta automaticamente as duas regioes da arte (simbolo em cima,
   assinatura/wordmark embaixo) a partir do canal alfa — funciona com
   qualquer arte, em qualquer resolucao, sem coordenadas magicas.
2. Gera cada arquivo no MESMO tamanho de tela que o cliente web oficial do
   Jellyfin usa (fonte: jellyfin/jellyfin-ux -> branding/web, publicado como
   o pacote npm @jellyfin/ux-web@1.0.0).
3. Mantem transparencia real (fundo recortado, sem halo branco).

TAMANHOS OFICIAIS (conferidos nos arquivos do jellyfin-ux)
----------------------------------------------------------
  assets/img/icon-transparent.png ....... 536 x 536   (transparente)
  assets/img/banner-light.png ........... 1302 x 378  (transparente)
  assets/img/banner-dark.png ............ 1302 x 378  (transparente)
  touchicon.png ......................... 180 x 180   (fundo opaco #101010)
  touchicon72.png ....................... 72 x 72
  touchicon114.png ...................... 114 x 114
  touchicon144.png ...................... 144 x 144
  touchicon512.png ...................... 512 x 512
  favicon.png ........................... 256 x 256
  favicon.ico ........................... 16 + 32 (+48, inofensivo)
  logo.svg (viewBox) .................... 0 0 512 512
  banner-light.svg / banner-dark.svg .... 0 0 1536 512

USO
---
    py -3.13 generate_assets.py                 # apenas gera na pasta do projeto
    py -3.13 generate_assets.py --sync-backend  # tambem copia para backend/public
"""

from __future__ import annotations

import argparse
import base64
import io
import os
import shutil
import sys

from PIL import Image

# ---------------------------------------------------------------------------
# Caminhos
# ---------------------------------------------------------------------------
BASE_DIR = os.path.dirname(os.path.abspath(__file__))

# Arte-fonte. Precisa ter canal alfa (fundo transparente).
SOURCE_CANDIDATES = [
    "Driveflin_logo.png",
    "DriveFlin.png",
]

WEBCLIENT_DIR = os.path.join(BASE_DIR, "src", "assets", "img")
ICON_DIR = os.path.join(WEBCLIENT_DIR, "icon-transparent")
FLAT_DIR = os.path.join(BASE_DIR, "driveflin-web-assets")

# Destino opcional: assets estaticos servidos pelo Worker (wrangler [assets] directory = "public")
BACKEND_PUBLIC = os.path.normpath(os.path.join(BASE_DIR, "..", "backend", "public"))
BACKEND_TARGETS = [
    os.path.join(BACKEND_PUBLIC, "assets", "img"),
    os.path.join(BACKEND_PUBLIC, "web", "assets", "img"),
]
BACKUP_DIR = os.path.join(BASE_DIR, "_backup_assets_v1")

# ---------------------------------------------------------------------------
# Tamanhos oficiais
# ---------------------------------------------------------------------------
SIZE_ICON = 536                 # icon-transparent.png / logo.png
SIZE_TOUCHICON = 180            # touchicon.png
SIZE_TOUCHICON_72 = 72
SIZE_TOUCHICON_114 = 114
SIZE_TOUCHICON_144 = 144
SIZE_TOUCHICON_512 = 512
SIZE_FAVICON_PNG = 256
ICO_SIZES = [(16, 16), (32, 32), (48, 48)]

BANNER_SIZE = (1302, 378)       # banner-light.png / banner-dark.png

SVG_ICON_VIEWBOX = (512, 512)
SVG_BANNER_VIEWBOX = (1536, 512)

# ---------------------------------------------------------------------------
# Ajustes de composicao
# ---------------------------------------------------------------------------
ALPHA_THRESHOLD = 8             # abaixo disso o pixel e considerado vazio
MIN_GAP_RATIO = 0.02            # gap minimo (fracao da altura) p/ separar simbolo e texto

# Preenchimento do simbolo dentro do quadro quadrado.
ICON_FILL = 0.94                # icon-transparent.png
ICON_SMALL_FILL = 0.90          # icon-transparent-36..192.png
FAVICON_FILL = 0.91             # favicon.png / touchicons (igual ao oficial: 234/256)
BANNER_MARK_H_RATIO = 1.0       # no banner oficial o simbolo ocupa 100% da altura
BANNER_GAP_RATIO = 78 / 378     # gap oficial entre simbolo e assinatura (78px em 378px)
BANNER_TEXT_ARG = 1.0           # 1.0 = mantem a proporcao texto/simbolo da propria arte

# O apple-touch-icon oficial (180x180) tem fundo opaco porque o iOS nao
# suporta transparencia. Use None para deixar transparente.
TOUCHICON_180_BG = "#101010"

# Supersampling: desenha grande e reduz com LANCZOS => bordas mais suaves.
SUPERSAMPLE = 4

# ---------------------------------------------------------------------------
# Utilitarios
# ---------------------------------------------------------------------------


def log(msg: str = "") -> None:
    print(msg, flush=True)


def ensure_dir(path: str) -> None:
    os.makedirs(path, exist_ok=True)


def alpha_bbox(img: Image.Image, thresh: int = ALPHA_THRESHOLD):
    """Bounding box do conteudo real (ignora ruido de alfa muito baixo)."""
    if img.mode != "RGBA":
        img = img.convert("RGBA")
    mask = img.getchannel("A").point(lambda v: 255 if v > thresh else 0)
    return mask.getbbox()


def trim(img: Image.Image) -> Image.Image:
    """Recorta a imagem exatamente no conteudo (sem margem transparente)."""
    bbox = alpha_bbox(img)
    if bbox is None:
        raise ValueError("imagem sem conteudo visivel")
    return img.crop(bbox)


def split_regions(src: Image.Image, thresh: int = ALPHA_THRESHOLD):
    """
    Separa a arte em (simbolo, assinatura).

    Estrategia: projeta o canal alfa nas linhas; o maior vao vertical vazio
    entre o primeiro e o ultimo pixel com conteudo e o separador natural
    entre o simbolo (em cima) e o wordmark (embaixo).
    """
    if src.mode != "RGBA":
        src = src.convert("RGBA")

    w, h = src.size
    alpha = src.getchannel("A").tobytes()  # 1 byte por pixel, linha a linha
    row_has = [max(alpha[y * w:(y + 1) * w]) > thresh for y in range(h)]

    content_rows = [y for y, has in enumerate(row_has) if has]
    if not content_rows:
        raise ValueError("arte-fonte totalmente vazia")
    y_top, y_bottom = content_rows[0], content_rows[-1]

    best_gap, best_start = 0, None
    run = 0
    for y in range(y_top, y_bottom + 1):
        if row_has[y]:
            run = 0
        else:
            run += 1
            if run > best_gap:
                best_gap, best_start = run, y - run + 1

    min_gap = max(3, int(round((y_bottom - y_top + 1) * MIN_GAP_RATIO)))
    if best_start is None or best_gap < min_gap:
        # Nao existe uma faixa vazia confiavel: a arte e um bloco unico.
        return trim(src), None

    split = best_start + best_gap // 2
    mark = trim(src.crop((0, y_top, w, split)))
    text = trim(src.crop((0, split, w, y_bottom + 1)))
    if mark.height < text.height:
        # seguranca: o simbolo tem que ser o bloco de cima
        mark, text = mark, text
    return mark, text


def scale_to(im: Image.Image, width: int | None = None, height: int | None = None) -> Image.Image:
    """Redimensiona mantendo a proporcao (usa apenas o parametro informado)."""
    if width is None and height is None:
        return im
    if width is None:
        width = max(1, int(round(im.width * height / im.height)))
    if height is None:
        height = max(1, int(round(im.height * width / im.width)))
    return im.resize((max(1, width), max(1, height)), Image.Resampling.LANCZOS)


def paste_center(canvas: Image.Image, im: Image.Image, cx: int, cy: int) -> None:
    canvas.alpha_composite(im, (int(round(cx - im.width / 2)), int(round(cy - im.height / 2))))


def clean_transparency(im: Image.Image) -> Image.Image:
    """
    Zera o RGB dos pixels totalmente transparentes.

    O LANCZOS deixa sobras de cor em pixels com alfa 0. Eles nao aparecem em
    navegadores modernos, mas alguns WebViews antigos (Android/Android TV)
    tratam PNG sem alfa pre-multiplicado e desenham essas sobras como franja.
    Zerar o RGB tambem melhora a compressao do PNG.
    """
    r, g, b, a = im.split()
    transparent = a.point(lambda v: 255 if v == 0 else 0)
    black = Image.new("L", im.size, 0)
    return Image.merge(
        "RGBA",
        (
            Image.composite(black, r, transparent),
            Image.composite(black, g, transparent),
            Image.composite(black, b, transparent),
            a,
        ),
    )


def colorize(im: Image.Image, color: str) -> Image.Image:
    """Mantem o formato/alfa e troca apenas a cor (para a assinatura clara)."""
    solid = Image.new("RGBA", im.size, color)
    solid.putalpha(im.getchannel("A"))
    return solid


# ---------------------------------------------------------------------------
# Icones (quadro quadrado, fundo transparente)
# ---------------------------------------------------------------------------


def render_icon(mark: Image.Image, size: int, fill: float, background: str | None = None) -> Image.Image:
    big = size * SUPERSAMPLE
    canvas = Image.new("RGBA", (big, big), (0, 0, 0, 0))
    target = big * fill
    scaled = scale_to(mark, width=int(round(target))) if mark.width >= mark.height else scale_to(mark, height=int(round(target)))
    # garante que o maior lado caiba em "target"
    if max(scaled.size) > target:
        scaled = scale_to(scaled, width=int(round(target))) if scaled.width >= scaled.height else scale_to(scaled, height=int(round(target)))
    paste_center(canvas, scaled, big / 2, big / 2)
    out = canvas.resize((size, size), Image.Resampling.LANCZOS)
    if background:
        bg = Image.new("RGBA", (size, size), background)
        bg.alpha_composite(out)
        out = bg
    return clean_transparency(out)


# ---------------------------------------------------------------------------
# Banner (simbolo a esquerda + assinatura a direita)
# ---------------------------------------------------------------------------


def render_banner(mark: Image.Image, text: Image.Image, size=BANNER_SIZE, text_color: str | None = None) -> Image.Image:
    if text is None:
        # Sem assinatura: apenas centraliza o simbolo no quadro oficial.
        return render_icon(mark, max(size), ICON_FILL)

    if text_color:
        text = colorize(text, text_color)

    W, H = size
    big_w, big_h = W * SUPERSAMPLE, H * SUPERSAMPLE

    mark_h = big_h * BANNER_MARK_H_RATIO
    mark_w = mark.width * mark_h / mark.height

    # Proporcao assinatura/simbolo herdada da propria arte (arte empilhada).
    text_h = mark_h * (text.height / mark.height) * BANNER_TEXT_ARG
    text_w = text.width * text_h / text.height

    gap = big_h * BANNER_GAP_RATIO
    group_w = mark_w + gap + text_w
    if group_w > big_w:  # nunca estoura o quadro
        k = big_w / group_w
        mark_h, mark_w, text_h, text_w, gap = mark_h * k, mark_w * k, text_h * k, text_w * k, gap * k
        group_w = big_w

    mark_r = scale_to(mark, height=int(round(mark_h)))
    text_r = scale_to(text, height=int(round(text_h)))

    canvas = Image.new("RGBA", (big_w, big_h), (0, 0, 0, 0))
    x = (big_w - group_w) / 2
    canvas.alpha_composite(mark_r, (int(round(x)), int(round((big_h - mark_r.height) / 2))))
    canvas.alpha_composite(
        text_r,
        (int(round(x + mark_w + gap)), int(round((big_h - text_r.height) / 2))),
    )
    return clean_transparency(canvas.resize((W, H), Image.Resampling.LANCZOS))


# ---------------------------------------------------------------------------
# SVG (PNG embutido em base64 — vetor real exigiria retracar a arte)
# ---------------------------------------------------------------------------


def svg_with_image(vb_w: int, vb_h: int, raster: Image.Image, title: str, comment: str = "") -> str:
    buf = io.BytesIO()
    raster.save(buf, format="PNG", optimize=True)
    b64 = base64.b64encode(buf.getvalue()).decode("ascii")
    return (
        '<?xml version="1.0" encoding="UTF-8"?>\n'
        f"{comment}"
        f'<svg xmlns="http://www.w3.org/2000/svg" xmlns:xlink="http://www.w3.org/1999/xlink" '
        f'viewBox="0 0 {vb_w} {vb_h}" width="{vb_w}" height="{vb_h}" preserveAspectRatio="xMidYMid meet">\n'
        f"  <title>{title}</title>\n"
        f'  <image x="0" y="0" width="{vb_w}" height="{vb_h}" preserveAspectRatio="xMidYMid meet" '
        f'xlink:href="data:image/png;base64,{b64}" />\n'
        "</svg>\n"
    )


def write_text(path: str, data: str) -> None:
    ensure_dir(os.path.dirname(path))
    with open(path, "w", encoding="utf-8", newline="\n") as fh:
        fh.write(data)


def save_png(img: Image.Image, path: str) -> None:
    ensure_dir(os.path.dirname(path))
    img.save(path, "PNG", optimize=True)


# ---------------------------------------------------------------------------
# Pipeline
# ---------------------------------------------------------------------------


def find_source() -> str:
    for name in SOURCE_CANDIDATES:
        path = os.path.join(BASE_DIR, name)
        if os.path.exists(path):
            with Image.open(path) as probe:
                if "A" in probe.convert("RGBA").getbands() and alpha_bbox(probe.convert("RGBA")):
                    return path
    raise SystemExit(
        "Nenhuma arte-fonte com transparencia encontrada. "
        f"Esperado um destes arquivos: {', '.join(SOURCE_CANDIDATES)}"
    )


def main() -> int:
    parser = argparse.ArgumentParser(description="Gera os assets de marca do DriveFlin.")
    parser.add_argument("--sync-backend", action="store_true",
                        help="copia o resultado para backend/public/assets/img e backend/public/web/assets/img (com backup)")
    args = parser.parse_args()

    source_path = find_source()
    source = Image.open(source_path).convert("RGBA")
    log(f"Arte-fonte : {os.path.basename(source_path)}  {source.width}x{source.height}")

    mark, wordmark = split_regions(source)
    log(f"Simbolo    : {mark.width}x{mark.height}  (proporcao {mark.width / mark.height:.3f})")
    if wordmark is None:
        log("Assinatura : nao encontrada (a arte e um bloco unico)")
    else:
        log(f"Assinatura : {wordmark.width}x{wordmark.height}  "
            f"(altura = {wordmark.height / mark.height * 100:.1f}% da altura do simbolo)")

    if max(mark.size) < SIZE_ICON * 0.8:
        log()
        log(f"AVISO: o simbolo tem apenas {mark.width}x{mark.height}px e sera ampliado para "
            f"{SIZE_ICON}x{SIZE_ICON}. Uma arte-fonte maior (>= {SIZE_ICON}px no simbolo) "
            "deixaria as bordas mais nitidas.")

    light_text = colorize(wordmark, "#ffffff") if wordmark is not None else None

    log()
    log("=== ICONES ===")
    icon_set = {
        "logo.png": (SIZE_ICON, ICON_FILL, None),
        "icon-transparent.png": (SIZE_ICON, ICON_FILL, None),
        "icon-transparent-192.png": (192, ICON_SMALL_FILL, None),
        "icon-transparent-144.png": (144, ICON_SMALL_FILL, None),
        "icon-transparent-96.png": (96, ICON_SMALL_FILL, None),
        "icon-transparent-72.png": (72, ICON_SMALL_FILL, None),
        "icon-transparent-48.png": (48, ICON_SMALL_FILL, None),
        "icon-transparent-36.png": (36, ICON_SMALL_FILL, None),
    }
    rendered_icons = {}
    for name, (size, fill, bg) in icon_set.items():
        img = render_icon(mark, size, fill, bg)
        rendered_icons[name] = img
        save_png(img, os.path.join(ICON_DIR, name))
        log(f"  ok  icon-transparent/{name:26s} {size}x{size}")

    log()
    log("=== FAVICONS / TOUCH ICONS ===")
    touch_set = {
        "touchicon.png": (SIZE_TOUCHICON, FAVICON_FILL, TOUCHICON_180_BG),
        "touchicon72.png": (SIZE_TOUCHICON_72, FAVICON_FILL, None),
        "touchicon114.png": (SIZE_TOUCHICON_114, FAVICON_FILL, None),
        "touchicon144.png": (SIZE_TOUCHICON_144, FAVICON_FILL, None),
        "touchicon512.png": (SIZE_TOUCHICON_512, FAVICON_FILL, None),
        "favicon.png": (SIZE_FAVICON_PNG, FAVICON_FILL, None),
    }
    rendered_touch = {}
    for name, (size, fill, bg) in touch_set.items():
        img = render_icon(mark, size, fill, bg)
        rendered_touch[name] = img
        save_png(img, os.path.join(WEBCLIENT_DIR, name))
        log(f"  ok  {name:26s} {size}x{size}")

    # favicon.ico multi-resolucao. Pillow precisa de uma base quadrada grande.
    ico_base = render_icon(mark, 256, FAVICON_FILL)
    ico_path = os.path.join(WEBCLIENT_DIR, "favicon.ico")
    ensure_dir(os.path.dirname(ico_path))
    ico_base.save(ico_path, format="ICO", sizes=ICO_SIZES)
    log(f"  ok  favicon.ico                {', '.join(f'{w}x{h}' for w, h in ICO_SIZES)}")

    log()
    log("=== BANNERS ===")
    banner_light = render_banner(mark, wordmark)
    banner_dark = render_banner(mark, light_text) if light_text is not None else banner_light
    save_png(banner_light, os.path.join(WEBCLIENT_DIR, "banner-light.png"))
    save_png(banner_dark, os.path.join(WEBCLIENT_DIR, "banner-dark.png"))
    log(f"  ok  banner-light.png           {BANNER_SIZE[0]}x{BANNER_SIZE[1]}")
    log(f"  ok  banner-dark.png            {BANNER_SIZE[0]}x{BANNER_SIZE[1]}")

    log()
    log("=== SVG (viewBox oficiais) ===")
    svg_comment = ("  <!-- PNG embutido em base64: a arte de origem e raster.\n"
                   "       Para um vetor de verdade a arte precisa ser retracada (potrace/vtracer). -->\n")
    write_text(
        os.path.join(ICON_DIR, "logo.svg"),
        svg_with_image(*SVG_ICON_VIEWBOX, rendered_icons["logo.png"], "logo", svg_comment),
    )
    write_text(
        os.path.join(WEBCLIENT_DIR, "banner-light.svg"),
        svg_with_image(*SVG_BANNER_VIEWBOX, banner_light, "banner-light", svg_comment),
    )
    write_text(
        os.path.join(WEBCLIENT_DIR, "banner-dark.svg"),
        svg_with_image(*SVG_BANNER_VIEWBOX, banner_dark, "banner-dark", svg_comment),
    )
    log("  ok  icon-transparent/logo.svg  viewBox 0 0 %d %d" % SVG_ICON_VIEWBOX)
    log("  ok  banner-light.svg           viewBox 0 0 %d %d" % SVG_BANNER_VIEWBOX)
    log("  ok  banner-dark.svg            viewBox 0 0 %d %d" % SVG_BANNER_VIEWBOX)

    # -----------------------------------------------------------------------
    # Pasta plana (pronta para publicar)
    # -----------------------------------------------------------------------
    if os.path.exists(FLAT_DIR):
        shutil.rmtree(FLAT_DIR)
    ensure_dir(FLAT_DIR)

    flat = []
    for name in icon_set:
        flat.append(os.path.join(ICON_DIR, name))
    flat.append(os.path.join(ICON_DIR, "logo.svg"))
    for name in list(touch_set) + ["favicon.ico", "banner-light.png", "banner-dark.png",
                                   "banner-light.svg", "banner-dark.svg"]:
        flat.append(os.path.join(WEBCLIENT_DIR, name))
    for src in flat:
        shutil.copy2(src, os.path.join(FLAT_DIR, os.path.basename(src)))
    log()
    log(f"Pasta plana : {len(flat)} arquivos em {os.path.relpath(FLAT_DIR, BASE_DIR)}")

    # -----------------------------------------------------------------------
    # Espelho opcional para o backend
    # -----------------------------------------------------------------------
    if args.sync_backend:
        log()
        log("=== SINCRONIZANDO BACKEND ===")
        ensure_dir(BACKUP_DIR)
        for target in BACKEND_TARGETS:
            if not os.path.isdir(target):
                log(f"  --  {target} nao existe, pulando")
                continue
            ensure_dir(target)
            for name in os.listdir(FLAT_DIR):
                src = os.path.join(FLAT_DIR, name)
                if not os.path.isfile(src):
                    continue
                dst = os.path.join(target, name)
                if os.path.exists(dst) and not os.path.exists(os.path.join(BACKUP_DIR, os.path.basename(target) + "_" + name)):
                    shutil.copy2(dst, os.path.join(BACKUP_DIR, os.path.basename(target) + "_" + name))
                shutil.copy2(src, dst)
            log(f"  ok  {os.path.relpath(target, BASE_DIR)}")

    # -----------------------------------------------------------------------
    # Relatorio final
    # -----------------------------------------------------------------------
    log()
    log("=== RELATORIO ===")
    problems = 0
    for root, _, files in os.walk(BASE_DIR):
        if "_backup" in root or "_official_ref" in root:
            continue
        for name in sorted(files):
            if not name.lower().endswith(".png"):
                continue
            path = os.path.join(root, name)
            with Image.open(path).convert("RGBA") as im:
                bbox = alpha_bbox(im)
                if bbox is None:
                    log(f"  VAZIO   {path}")
                    problems += 1
                    continue
                clipped = bbox[0] == 0 or bbox[1] == 0 or bbox[2] == im.width or bbox[3] == im.height
                flag = "  <-- toca a borda" if clipped else ""
                rel = os.path.relpath(path, BASE_DIR)
                log(f"  {im.width:>4}x{im.height:<4} {str(bbox):24s} {rel}{flag}")

    if problems:
        log(f"{problems} arquivo(s) sem conteudo.")
        return 1
    return 0


if __name__ == "__main__":
    sys.exit(main())
