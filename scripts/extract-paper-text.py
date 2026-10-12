import json
import html
import pathlib
import sys
import zipfile
import xml.etree.ElementTree as ET


def table_markup(table_id, rows):
    return '<table data-source-table="' + table_id + '">' + ''.join(
        '<tr>' + ''.join('<td>' + html.escape(str(cell or '')).replace('\n', '<br>') + '</td>'
                         for cell in row) + '</tr>' for row in rows) + '</table>'


def pdf_pages(filename):
    try:
        from pypdf import PdfReader
    except ImportError as cause:
        raise RuntimeError("PDF extraction requires pypdf; install requirements-pdf.txt") from cause
    reader = PdfReader(filename)
    pages = []
    try:
        import pdfplumber
    except ImportError as cause:
        raise RuntimeError("PDF table preservation requires pdfplumber; install requirements-pdf.txt") from cause
    table_pdf = pdfplumber.open(filename)
    try:
        for index, page in enumerate(reader.pages):
            page_no = index + 1
            visuals, tables, blocks = [], [], [page.extract_text() or '']
            # Do not decode/re-encode picture pixels: identify XObjects including images inside forms.
            def inspect_resources(resources, seen=None):
                seen = set() if seen is None else seen
                resources = resources.get_object() if hasattr(resources, 'get_object') else resources
                xobjects = (resources or {}).get('/XObject', {})
                xobjects = xobjects.get_object() if hasattr(xobjects, 'get_object') else xobjects
                for name, ref in xobjects.items():
                    key = str(ref)
                    if key in seen:
                        continue
                    seen.add(key)
                    obj = ref.get_object()
                    if obj.get('/Subtype') == '/Image':
                        visuals.append({'id': f'pdf-p{page_no}-image-{len(visuals)+1}',
                                        'kind': 'image', 'page': page_no, 'objectName': str(name),
                                        'width': obj.get('/Width'), 'height': obj.get('/Height'),
                                        'requiresReview': True, 'pixelsProvidedToModel': False})
                    elif obj.get('/Subtype') == '/Form':
                        visuals.append({'id': f'pdf-p{page_no}-form-{len(visuals)+1}',
                                        'kind': 'form_drawing', 'page': page_no, 'objectName': str(name),
                                        'requiresReview': True, 'pixelsProvidedToModel': False})
                        inspect_resources(obj.get('/Resources', {}), seen)
            inspect_resources(page.get('/Resources', {}))
            # PDF diagrams and table rules can be vector paths, without image XObjects.
            contents = page.get_contents()
            operations = contents.operations if contents is not None else []
            drawing_count = sum(operator in (b'S', b's', b'f', b'F', b'f*', b'B', b'B*', b'b', b'b*')
                                for _, operator in operations)
            if drawing_count:
                visuals.append({'id': f'pdf-p{page_no}-vector', 'kind': 'vector_drawing', 'page': page_no,
                                'paintOperationCount': drawing_count, 'requiresReview': True,
                                'pixelsProvidedToModel': False})
            if table_pdf:
                for ti, table in enumerate(table_pdf.pages[index].find_tables()):
                    rows = table.extract() or []
                    table_id = f'pdf-p{page_no}-table-{ti+1}'
                    tables.append({'id': table_id, 'page': page_no, 'rows': rows,
                                   'rowCount': len(rows), 'columnCount': max((len(r) for r in rows), default=0),
                                   'bbox': list(table.bbox), 'requiresReview': True,
                                   'reason': 'PDF cell extraction and reading order require original-page review'})
                    blocks.append(table_markup(table_id, rows))
            for visual in visuals:
                blocks.append(f'[SOURCE_VISUAL_UNRESOLVED id={visual["id"]} kind={visual["kind"]} page={page_no}; 原图未提供给模型，不能据纯文本补造图示]')
            pages.append({'page': page_no, 'text': '\n'.join(blocks), 'visuals': visuals, 'tables': tables,
                          'tableDetection': 'pdfplumber_lines' if table_pdf else 'unavailable'})
    finally:
        if table_pdf:
            table_pdf.close()
    return pages


def docx_text(filename):
    namespace = "{http://schemas.openxmlformats.org/wordprocessingml/2006/main}"
    with zipfile.ZipFile(filename) as archive:
        root = ET.fromstring(archive.read("word/document.xml"))
        rel_path = 'word/_rels/document.xml.rels'
        relationships = {r.attrib['Id']: r.attrib.get('Target')
                         for r in ET.fromstring(archive.read(rel_path))} if rel_path in archive.namelist() else {}
    blocks, visuals, tables = [], [], []
    def paragraph_text(paragraph):
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
            elif node.tag.endswith('}blip') or node.tag.endswith('}imagedata'):
                relationship_id = next((value for key, value in node.attrib.items()
                                        if key.endswith('}embed') or key.endswith('}link') or key.endswith('}id')), None)
                visual_id = f'docx-image-{len(visuals)+1}'
                visuals.append({'id': visual_id, 'kind': 'image', 'page': 1,
                                'relationshipId': relationship_id, 'target': relationships.get(relationship_id),
                                'requiresReview': True, 'pixelsProvidedToModel': False})
                text.append(f'[SOURCE_VISUAL_UNRESOLVED id={visual_id}; 原图未提供给模型]')
            elif node.tag == namespace + 'object':
                visual_id = f'docx-object-{len(visuals)+1}'
                visuals.append({'id': visual_id, 'kind': 'embedded_object', 'page': 1,
                                'requiresReview': True, 'pixelsProvidedToModel': False})
                text.append(f'[SOURCE_VISUAL_UNRESOLVED id={visual_id}; 嵌入对象未解析]')
        # Word drawing shapes can lack a:blip (e.g. vector diagrams).
        if any(n.tag == namespace + 'drawing' or n.tag == namespace + 'pict' for n in paragraph.iter()) and not any('SOURCE_VISUAL_UNRESOLVED' in part for part in text):
            visual_id = f'docx-drawing-{len(visuals)+1}'
            visuals.append({'id': visual_id, 'kind': 'drawing', 'page': 1,
                            'requiresReview': True, 'pixelsProvidedToModel': False})
            text.append(f'[SOURCE_VISUAL_UNRESOLVED id={visual_id}; 绘图未提供给模型]')
        return ''.join(text).strip()

    body = root.find(namespace + 'body')
    for block in body if body is not None else []:
        if block.tag == namespace + 'p':
            joined = paragraph_text(block)
            if joined:
                blocks.append(joined)
        elif block.tag == namespace + 'tbl':
            rows = []
            merged = False
            for row in block.findall(namespace + 'tr'):
                cells = []
                for cell in row.findall(namespace + 'tc'):
                    merged = merged or cell.find('.//' + namespace + 'gridSpan') is not None or cell.find('.//' + namespace + 'vMerge') is not None
                    cells.append('\n'.join(filter(None, (paragraph_text(p) for p in cell.findall(namespace + 'p')))))
                rows.append(cells)
            table_id = f'docx-table-{len(tables)+1}'
            tables.append({'id': table_id, 'page': 1, 'rows': rows, 'rowCount': len(rows),
                           'columnCount': max((len(r) for r in rows), default=0),
                           'hasMergedCells': bool(merged), 'hasNestedTables': block.find('.//' + namespace + 'tc/' + namespace + 'tbl') is not None,
                           'requiresReview': True,
                           'reason': 'Source table structure retained; model-to-question cell alignment still requires review'})
            blocks.append(table_markup(table_id, rows))
        elif block.tag not in (namespace + 'sectPr',):
            # Never silently drop an unsupported body container such as altChunk or content control.
            visual_id = f'docx-block-{len(visuals)+1}'
            visuals.append({'id': visual_id, 'kind': 'unsupported_body_block', 'page': 1,
                            'element': block.tag, 'requiresReview': True, 'pixelsProvidedToModel': False})
            blocks.append(f'[SOURCE_VISUAL_UNRESOLVED id={visual_id}; 未解析文档块需核对原文件]')
    return [{"page": 1, "text": "\n".join(blocks), 'visuals': visuals, 'tables': tables}]


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
