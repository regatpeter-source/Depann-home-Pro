"""Generate first-page PNG previews for visual PDF galleries."""

from pathlib import Path

import fitz

ROOT = Path(__file__).resolve().parents[1]
GALLERIES = [
    (
        ROOT / "assets" / "notices" / "somfy" / "volet-roulant" / "astuces rapide somfy" / "astuces en image moteur vr oximo, altus et orea",
        ROOT / "assets" / "previews" / "somfy" / "volet-roulant" / "astuces-rapides"
    ),
    (
        ROOT / "assets" / "notices" / "servistores" / "volet-roulant",
        ROOT / "assets" / "previews" / "servistores" / "volet-roulant"
    ),
    (
        ROOT / "assets" / "notices" / "nice" / "portail",
        ROOT / "assets" / "previews" / "nice" / "portail"
    ),
    (
        ROOT / "assets" / "notices" / "came" / "portail",
        ROOT / "assets" / "previews" / "came" / "portail"
    ),
    (
        ROOT / "assets" / "notices" / "faac" / "portail",
        ROOT / "assets" / "previews" / "faac" / "portail"
    )
]
ZOOM = 1.5


def main():
    matrix = fitz.Matrix(ZOOM, ZOOM)
    generated = 0

    for source_dir, output_dir in GALLERIES:
        output_dir.mkdir(parents=True, exist_ok=True)
        for pdf_path in sorted(source_dir.glob("*.pdf")):
            preview_path = output_dir / f"{pdf_path.stem}.png"
            document = fitz.open(pdf_path)
            try:
                page = document[0]
                pixmap = page.get_pixmap(matrix=matrix, alpha=False)
                pixmap.save(preview_path)
                generated += 1
            finally:
                document.close()

    print(f"Generated {generated} preview image(s)")


if __name__ == "__main__":
    main()
