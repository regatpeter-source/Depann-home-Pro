"""Generate first-page PNG previews for the Somfy quick-tip PDFs."""

from pathlib import Path

import fitz

ROOT = Path(__file__).resolve().parents[1]
SOURCE_DIR = ROOT / "assets" / "notices" / "somfy" / "volet-roulant" / "astuces rapide somfy" / "astuces en image moteur vr oximo, altus et orea"
OUTPUT_DIR = ROOT / "assets" / "previews" / "somfy" / "volet-roulant" / "astuces-rapides"
ZOOM = 1.5


def main():
    OUTPUT_DIR.mkdir(parents=True, exist_ok=True)
    pdfs = sorted(SOURCE_DIR.glob("*.pdf"))

    if not pdfs:
        raise SystemExit(f"No PDF files found in {SOURCE_DIR}")

    matrix = fitz.Matrix(ZOOM, ZOOM)
    for pdf_path in pdfs:
        preview_path = OUTPUT_DIR / f"{pdf_path.stem}.png"
        document = fitz.open(pdf_path)
        try:
            page = document[0]
            pixmap = page.get_pixmap(matrix=matrix, alpha=False)
            pixmap.save(preview_path)
        finally:
            document.close()

    print(f"Generated {len(pdfs)} preview image(s) in {OUTPUT_DIR}")


if __name__ == "__main__":
    main()
