#!/usr/bin/env python3
"""Post-process a pandoc-generated .docx for client distribution.

pandoc leaves the core document properties blank and writes no footer. This
script (run by `npm run docs:docx` after pandoc) fills the title/author/subject
properties and injects a centred page-number footer. It edits the OPOX zip in
place using only the Python standard library.

    python3 scripts/docx_finalize.py docs/DESIGN_DOC.docx
"""
import os
import re
import sys
import zipfile

TITLE = "AEP Data Lifecycle Helper — Design & Architecture Document"
AUTHOR = "Tushar Kant Kar (Adobe)"
SUBJECT = "AEP Data Lifecycle Helper design and architecture"
KEYWORDS = "Confidential — client engagement"

FOOTER_XML = (
    '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>'
    '<w:ftr xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main">'
    '<w:p><w:pPr><w:jc w:val="center"/></w:pPr>'
    '<w:r><w:t xml:space="preserve">AEP Data Lifecycle Helper  ·  Confidential  ·  Page </w:t></w:r>'
    '<w:r><w:fldChar w:fldCharType="begin"/></w:r>'
    '<w:r><w:instrText xml:space="preserve"> PAGE </w:instrText></w:r>'
    '<w:r><w:fldChar w:fldCharType="end"/></w:r>'
    '</w:p></w:ftr>'
)


def esc(s):
    return s.replace("&", "&amp;").replace("<", "&lt;").replace(">", "&gt;")


def main(path):
    with zipfile.ZipFile(path) as z:
        parts = {n: z.read(n) for n in z.namelist()}

    # 1) Core document properties (were blank).
    core = parts["docProps/core.xml"].decode("utf8")
    core = core.replace("<dc:title></dc:title>", f"<dc:title>{esc(TITLE)}</dc:title>")
    core = core.replace("<dc:creator></dc:creator>", f"<dc:creator>{esc(AUTHOR)}</dc:creator>")
    core = core.replace("<cp:keywords></cp:keywords>", f"<cp:keywords>{esc(KEYWORDS)}</cp:keywords>")
    if "<dc:subject>" not in core:
        core = core.replace("</cp:coreProperties>", f"<dc:subject>{esc(SUBJECT)}</dc:subject></cp:coreProperties>")
    parts["docProps/core.xml"] = core.encode("utf8")

    # 2) Footer part.
    parts["word/footer1.xml"] = FOOTER_XML.encode("utf8")

    ct = parts["[Content_Types].xml"].decode("utf8")
    if "footer1.xml" not in ct:
        ct = ct.replace(
            "</Types>",
            '<Override PartName="/word/footer1.xml" '
            'ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.footer+xml"/></Types>',
        )
    parts["[Content_Types].xml"] = ct.encode("utf8")

    rels = parts["word/_rels/document.xml.rels"].decode("utf8")
    rid = "rId" + str(max(int(i) for i in re.findall(r'Id="rId(\d+)"', rels)) + 1)
    rels = rels.replace(
        "</Relationships>",
        f'<Relationship Id="{rid}" '
        'Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/footer" '
        'Target="footer1.xml"/></Relationships>',
    )
    parts["word/_rels/document.xml.rels"] = rels.encode("utf8")

    # 3) Reference the footer from the document-level section properties.
    #    footerReference must be the first child of <w:sectPr> (schema order).
    doc = parts["word/document.xml"].decode("utf8")
    opens = list(re.finditer(r"<w:sectPr\b[^>]*>", doc))
    if not opens:
        raise SystemExit("docx_finalize: no <w:sectPr> in document.xml")
    at = opens[-1].end()
    doc = doc[:at] + f'<w:footerReference w:type="default" r:id="{rid}"/>' + doc[at:]
    parts["word/document.xml"] = doc.encode("utf8")

    tmp = path + ".tmp"
    with zipfile.ZipFile(tmp, "w", zipfile.ZIP_DEFLATED) as z:
        for name, data in parts.items():
            z.writestr(name, data)
    os.replace(tmp, path)
    print(f"docx_finalize: set properties + page-number footer ({rid}) on {path}")


if __name__ == "__main__":
    if len(sys.argv) != 2:
        raise SystemExit("usage: python3 scripts/docx_finalize.py <file.docx>")
    main(sys.argv[1])
