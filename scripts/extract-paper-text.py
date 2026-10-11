import json
import pathlib
import sys
import zipfile
import xml.etree.ElementTree as ET


def pdf_pages(filename):
    try:
        from pypdf import PdfReader
    except ImportError as cause:
        raise RuntimeError("PDF extraction requires pypdf; install requirements-pdf.txt") from cause
    reader = PdfReader(filename)
    return [{"page": index + 1, "text": page.extract_text() or ""}
            for index, page in enumerate(reader.pages)]


def docx_text(filename):
    namespace = "{http://schemas.openxmlformats.org/wordprocessingml/2006/main}"
    with zipfile.ZipFile(filename) as archive:
        root = ET.fromstring(archive.read("word/document.xml"))
    blocks = []
    for paragraph in root.iter(namespace + "p"):
        text = []
        for node in paragraph.iter():
            # Word stores ordinary runs as w:t and equation glyphs as m:t.
            # Preserve both so OMML formulas are not silently dropped before LLM parsing.
            if node.tag.endswith("}t"):
                text.append(node.text or "")
            elif node.tag == namespace + "tab":
                text.append("\t")
            elif node.tag in (namespace + "br", namespace + "cr"):
                text.append("\n")
        joined = "".join(text).strip()
        if joined:
            blocks.append(joined)
    return [{"page": 1, "text": "\n".join(blocks)}]


def main():
    filename = pathlib.Path(sys.argv[1])
    suffix = filename.suffix.lower()
    if suffix == ".pdf":
        pages = pdf_pages(filename)
    elif suffix == ".docx":
        pages = docx_text(filename)
    else:
        raise RuntimeError("Unsupported document type")
    print(json.dumps({"pages": pages}, ensure_ascii=False))


if __name__ == "__main__":
    try:
        main()
    except Exception as error:
        print(json.dumps({"error": str(error)}, ensure_ascii=False))
        sys.exit(1)
