"use strict";

const assert = require("node:assert/strict");
const crypto = require("node:crypto");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const net = require("node:net");
const { spawnSync } = require("node:child_process");
const test = require("node:test");

const documents = require("../packages/local-search/documents");
const parser = path.resolve(__dirname, "../packages/local-search/document-parser.py");
const python = process.env.MYOS_TEST_DOCUMENT_PYTHON;
const defaults = documents.DEFAULT_LIMITS;

function temporaryDirectory(t) {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "myos-documents-"));
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }));
  return directory;
}

function makeFixtures(t) {
  if (!python) return null;
  const directory = temporaryDirectory(t);
  const generator = path.join(directory, "fixtures.py");
  fs.writeFileSync(generator, String.raw`
import io, os, sys, zipfile
from docx import Document
from docx.oxml import OxmlElement
from openpyxl import Workbook
from PIL import Image
from pypdf import PdfReader, PdfWriter
from pptx import Presentation
from pptx.chart.data import ChartData
from pptx.enum.chart import XL_CHART_TYPE
from pptx.util import Inches
from reportlab.lib.utils import ImageReader
from reportlab.pdfgen import canvas

root=sys.argv[1]
pdf=canvas.Canvas(os.path.join(root,"sample.pdf")); pdf.drawString(72,720,"PDF page one"); pdf.showPage(); pdf.save()
image=Image.new("RGB",(2,2),(255,0,0)); image_bytes=io.BytesIO(); image.save(image_bytes,"PNG"); image_bytes.seek(0)
mixed=canvas.Canvas(os.path.join(root,"mixed.pdf")); mixed.drawString(72,720,"searchable"); mixed.showPage(); mixed.drawImage(ImageReader(image_bytes),72,700,20,20); mixed.showPage(); mixed.save()
image_bytes.seek(0); image_pdf=canvas.Canvas(os.path.join(root,"image.pdf")); image_pdf.drawImage(ImageReader(image_bytes),72,700,20,20); image_pdf.showPage(); image_pdf.save()
image_bytes.seek(0); nested_pdf=canvas.Canvas(os.path.join(root,"nested-form-image.pdf")); nested_pdf.beginForm("NestedImage"); nested_pdf.drawImage(ImageReader(image_bytes),0,0,20,20); nested_pdf.endForm(); nested_pdf.doForm("NestedImage"); nested_pdf.showPage(); nested_pdf.save()
writer=PdfWriter(); writer.add_blank_page(width=72,height=72); writer.encrypt("secret"); out=open(os.path.join(root,"encrypted.pdf"),"wb"); writer.write(out); out.close()
writer=PdfWriter(); page=writer.add_blank_page(width=72,height=72)
from pypdf.generic import DecodedStreamObject, NameObject
stream=DecodedStreamObject(); stream.set_data(b"q " * (3 * 1024 * 1024)); page[NameObject("/Contents")]=writer._add_object(stream.flate_encode())
with open(os.path.join(root,"compressed-bomb.pdf"),"wb") as out: writer.write(out)

doc=Document(); doc.add_paragraph("Hello 😀 中文"); table=doc.add_table(rows=1,cols=1); table.cell(0,0).text="Tabel Bahasa Indonesia"; doc.add_paragraph("After table"); doc.save(os.path.join(root,"sample.docx"))
coverage_doc=Document(); coverage_doc.add_paragraph("Body text"); outer=coverage_doc.add_table(rows=1,cols=1); outer.cell(0,0).add_table(rows=1,cols=1).cell(0,0).text="Nested text"; coverage_doc.sections[0].header.paragraphs[0].text="Header text"
textbox=OxmlElement("w:txbxContent"); paragraph=OxmlElement("w:p"); run=OxmlElement("w:r"); text=OxmlElement("w:t"); text.text="Textbox text"; run.append(text); paragraph.append(run); textbox.append(paragraph); coverage_doc._body._element.append(textbox)
coverage_doc.save(os.path.join(root,"coverage.docx"))
empty_doc=Document(); empty_doc.save(os.path.join(root,"empty.docx"))
with zipfile.ZipFile(os.path.join(root,"empty.docx")) as archive:
    empty_doc_entries={name:archive.read(name) for name in archive.namelist()}
with zipfile.ZipFile(os.path.join(root,"footnote-only.docx"),"w",zipfile.ZIP_DEFLATED) as archive:
    for entry, payload in empty_doc_entries.items(): archive.writestr(entry,payload)
    archive.writestr("word/footnotes.xml", '<w:footnotes xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main"><w:footnote w:id="1"><w:p><w:r><w:t>Footnote only text</w:t></w:r></w:p></w:footnote></w:footnotes>')
with zipfile.ZipFile(os.path.join(root,"endnote-only.docx"),"w",zipfile.ZIP_DEFLATED) as archive:
    for entry, payload in empty_doc_entries.items(): archive.writestr(entry,payload)
    archive.writestr("word/endnotes.xml", '<w:endnotes xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main"><w:endnote w:id="1"><w:p><w:r><w:t>Endnote only text</w:t></w:r></w:p></w:endnote></w:endnotes>')
image_only_doc=Document(); image_bytes.seek(0); image_only_doc.add_picture(image_bytes); image_only_doc.save(os.path.join(root,"image-only.docx"))

deck=Presentation(); slide=deck.slides.add_slide(deck.slide_layouts[6]); group=slide.shapes.add_group_shape(); group.shapes.add_textbox(Inches(1),Inches(1),Inches(2),Inches(1)).text="Grouped 中文"; table_shape=slide.shapes.add_table(1,1,Inches(1),Inches(3),Inches(2),Inches(1)); table_shape.table.cell(0,0).text="Slide cell"; deck.save(os.path.join(root,"sample.pptx"))
coverage_deck=Presentation(); coverage_slide=coverage_deck.slides.add_slide(coverage_deck.slide_layouts[6]); coverage_slide.shapes.add_textbox(Inches(1),Inches(1),Inches(2),Inches(1)).text="Visible text"; image_bytes.seek(0); coverage_slide.shapes.add_picture(image_bytes, Inches(1), Inches(2)); coverage_slide.notes_slide.notes_text_frame.text="Speaker note"; chart_data=ChartData(); chart_data.categories=["Category"]; chart_data.add_series("Series text",(1,)); coverage_slide.shapes.add_chart(XL_CHART_TYPE.COLUMN_CLUSTERED, Inches(3), Inches(1), Inches(3), Inches(2), chart_data); coverage_deck.save(os.path.join(root,"coverage.pptx"))

book=Workbook(); sheet=book.active; sheet.title="Data 中文"; sheet["A1"]="Selamat datang"; sheet["B1"]="=1+1"; book.save(os.path.join(root,"sample.xlsx"))

with zipfile.ZipFile(os.path.join(root,"duplicate.docx"),"w") as archive:
    archive.writestr("same.xml","<x/>"); archive.writestr("same.xml","<y/>")
with zipfile.ZipFile(os.path.join(root,"dtd.docx"),"w") as archive: archive.writestr("word/document.xml",'<!DOCTYPE x [<!ENTITY y "z">]><x>&y;</x>')
for byte_order, encoding, marker in (("le", "utf-16-le", b"\xff\xfe"), ("be", "utf-16-be", b"\xfe\xff")):
    payload = '<?xml version="1.0" encoding="UTF-16"?><!DoCtYpE x [<!EnTiTy y "z">]><x>&y;</x>'.encode(encoding)
    with zipfile.ZipFile(os.path.join(root,f"dtd-utf16{byte_order}.docx"),"w") as archive: archive.writestr("word/document.xml", marker + payload)
    external = '<?xml version="1.0" encoding="UTF-16"?><!DOCTYPE x [<!ENTITY ext SYSTEM "file:///etc/passwd">]><x>&ext;</x>'.encode(encoding)
    with zipfile.ZipFile(os.path.join(root,f"external-utf16{byte_order}.docx"),"w") as archive: archive.writestr("word/document.xml", marker + external)
with zipfile.ZipFile(os.path.join(root,"bomb.docx"),"w",zipfile.ZIP_DEFLATED) as archive: archive.writestr("large.bin",b"0"*200000)
with zipfile.ZipFile(os.path.join(root,"traversal.docx"),"w") as archive: archive.writestr("../outside.xml","<x/>")
with zipfile.ZipFile(os.path.join(root,"symlink.docx"),"w") as archive:
    link=zipfile.ZipInfo("word/link.xml"); link.create_system=3; link.external_attr=(0o120777 << 16); archive.writestr(link,"target")
with zipfile.ZipFile(os.path.join(root,"macro.docx"),"w") as archive: archive.writestr("word/vbaProject.bin",b"not executed")
with zipfile.ZipFile(os.path.join(root,"flagged.docx"),"w") as archive: archive.writestr("x.xml","<x/>")
target=os.path.join(root,"flagged.docx"); flagged=bytearray(open(target,"rb").read())
local=flagged.find(b"PK\x03\x04"); central=flagged.find(b"PK\x01\x02")
flagged[local+6:local+8]=(int.from_bytes(flagged[local+6:local+8],"little")|1).to_bytes(2,"little")
flagged[central+8:central+10]=(int.from_bytes(flagged[central+8:central+10],"little")|1).to_bytes(2,"little")
open(target,"wb").write(flagged)

source=os.path.join(root,"sample.xlsx")
with zipfile.ZipFile(source) as archive:
    entries={name:archive.read(name) for name in archive.namelist()}
sheet_name="xl/worksheets/sheet1.xml"
sheet_xml=entries[sheet_name].decode("utf-8")
prefixed=sheet_xml.replace("<worksheet ", '<worksheet xmlns:x="http://schemas.openxmlformats.org/spreadsheetml/2006/main" ', 1).replace("<c ", "<x:c ").replace("</c>", "</x:c>")
for name, replacement in (
    ("prefixed-cells.xlsx", prefixed),
    ("bogus-dimension.xlsx", __import__("re").sub(r'<dimension ref="[^"]+"', '<dimension ref="A1:XFD1048576"', sheet_xml)),
    ("huge-merge.xlsx", sheet_xml.replace("</worksheet>", '<mergeCells count="1"><mergeCell ref="A1:XFD1048576"/></mergeCells></worksheet>')),
    ("cached-formula.xlsx", sheet_xml.replace("<f>1+1</f><v></v>", "<f>1+1</f><v>2</v>")),
):
    with zipfile.ZipFile(os.path.join(root,name),"w",zipfile.ZIP_DEFLATED) as archive:
        for entry, payload in entries.items(): archive.writestr(entry, replacement.encode("utf-8") if entry == sheet_name else payload)
`);
  const result = spawnSync(python, ["-I", generator, directory], { encoding: "utf8" });
  assert.equal(result.status, 0, result.stderr);
  return directory;
}

function runParser(file, extension, overrides = {}) {
  const limits = { ...defaults, ...overrides };
  return spawnSync(python, ["-I", parser, extension, String(limits.inputBytes), String(limits.extractedUtf8Bytes), String(limits.pagesOrSlides), String(limits.cells), String(limits.segments), String(limits.archiveMembers), String(limits.archiveExpandedBytes), String(limits.archiveMemberBytes), String(limits.archiveCompressionRatio)], {
    input: fs.readFileSync(file), encoding: "utf8", maxBuffer: defaults.stdoutBytes + 1024,
  });
}

function parseSuccess(result) {
  assert.equal(result.status, 0, result.stderr);
  return JSON.parse(result.stdout);
}

function parserCode(result) {
  assert.notEqual(result.status, 0);
  return JSON.parse(result.stderr).error.code;
}

function sandboxAvailable() {
  return process.platform === "darwin" && fs.existsSync("/usr/bin/sandbox-exec") && spawnSync("/usr/bin/sandbox-exec", ["-p", "(version 1)(allow default)(deny network*)", "/usr/bin/true"]).status === 0;
}

function makeSlowPdf(t) {
  const directory = temporaryDirectory(t);
  const target = path.join(directory, "slow.pdf");
  const result = spawnSync(python, ["-I", "-c", "from pypdf import PdfWriter; import sys; w=PdfWriter(); [w.add_blank_page(width=72,height=72) for _ in range(1000)]; f=open(sys.argv[1],'wb'); w.write(f); f.close()", target], { encoding: "utf8" });
  assert.equal(result.status, 0, result.stderr);
  return target;
}

test("document extraction rejects a missing Python runtime before reading input", async () => {
  await assert.rejects(
    documents.extractDocument(Buffer.from("not a document"), { extension: ".pdf", pythonPath: "/definitely/missing/python3" }),
    (error) => error.code === "PYTHON_UNAVAILABLE",
  );
});

test("immutable parser contract exposes conservative hard defaults", () => {
  assert.equal(Object.isFrozen(defaults), true);
  assert.deepEqual(defaults, { inputBytes: 16 * 1024 * 1024, extractedUtf8Bytes: 4 * 1024 * 1024, stdoutBytes: 8 * 1024 * 1024, pagesOrSlides: 2000, cells: 100000, segments: 50000, archiveMembers: 5000, archiveExpandedBytes: 64 * 1024 * 1024, archiveMemberBytes: 16 * 1024 * 1024, archiveCompressionRatio: 100, timeoutMs: 30000 });
  assert.equal(documents.PARSER_SCHEMA_VERSION, 1);
  assert.equal(Object.isFrozen(documents.PARSER_IDENTITY_SCHEMA), true);
  assert.deepEqual(documents.PARSER_IDENTITY_SCHEMA, { schemaVersion: 1, implementation: "myos-local-document-parser", formulaEvaluation: false, xmlEntities: false });
});

test("unsupported and legacy formats fail before process launch", async () => {
  for (const extension of ["doc", "xls", "ppt", "docm", "xlsm", "pptm", "txt"]) {
    await assert.rejects(documents.extractDocument(Buffer.alloc(0), { extension, pythonPath: python || process.execPath }), (error) => error.code === "UNSUPPORTED_FORMAT");
  }
});

test("callers may lower hard limits but never increase them", async () => {
  await assert.rejects(documents.extractDocument(Buffer.alloc(0), { extension: "pdf", pythonPath: python || process.execPath, cells: defaults.cells + 1 }), (error) => error.code === "INVALID_LIMIT");
  await assert.rejects(documents.extractDocument(Buffer.alloc(2), { extension: "pdf", pythonPath: python || process.execPath, inputBytes: 1 }), (error) => error.code === "INPUT_LIMIT");
});

test("pre-cancelled and expired work never launches a parser", async () => {
  const controller = new AbortController(); controller.abort();
  await assert.rejects(documents.extractDocument(Buffer.alloc(0), { extension: "pdf", pythonPath: python || process.execPath, signal: controller.signal }), (error) => error.code === "ABORTED");
  await assert.rejects(documents.extractDocument(Buffer.alloc(0), { extension: "pdf", pythonPath: python || process.execPath, deadline: Date.now() - 1 }), (error) => error.code === "TIMEOUT");
});

test("all four formats preserve text, true locators, hashes, and UTF-16 offsets", (t) => {
  if (!python) return t.skip("set MYOS_TEST_DOCUMENT_PYTHON to run real parser cases");
  const root = makeFixtures(t);
  const pdfResult = runParser(path.join(root, "sample.pdf"), "pdf");
  if (parserCodeOrNull(pdfResult) === "UNSUPPORTED_SAFETY_BOUNDARY") assert.equal(process.platform, "darwin");
  else {
    const pdf = parseSuccess(pdfResult);
    assert.equal(pdf.segments[0].locator.page, 1);
    assert.match(pdf.text, /PDF page one/);
  }

  const docxBytes = fs.readFileSync(path.join(root, "sample.docx"));
  const docx = parseSuccess(runParser(path.join(root, "sample.docx"), "docx"));
  assert.equal(docx.sourceHash, crypto.createHash("sha256").update(docxBytes).digest("hex"));
  assert.deepEqual(docx.segments.map(({ locator }) => locator), [{ paragraph: 1 }, { table: 1, row: 1, cell: 1, paragraph: 1 }, { paragraph: 2 }]);
  assert.equal(docx.text.slice(docx.segments[0].start, docx.segments[0].end), "Hello 😀 中文");
  assert.equal(docx.segments[0].end, "Hello 😀 中文".length);

  const pptx = parseSuccess(runParser(path.join(root, "sample.pptx"), "pptx"));
  assert.deepEqual(pptx.segments[0].locator.shape, [1, 1]);
  assert.deepEqual(pptx.segments[1].locator.tableCell, { row: 1, cell: 1 });

  const xlsx = parseSuccess(runParser(path.join(root, "sample.xlsx"), "xlsx"));
  assert.equal(xlsx.text, "Selamat datang");
  assert.deepEqual(xlsx.segments[0].locator, { sheet: "Data 中文", cell: "A1" });
  assert.deepEqual(xlsx.coverage.limitations, ["cachedFormulaValuesMayBeStale", "formulaCacheMissing"]);
  assert.equal(xlsx.complete, false);
});

function parserCodeOrNull(result) {
  return result.status === 0 ? null : JSON.parse(result.stderr).error.code;
}

function canonicalJson(value) {
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(",")}]`;
  if (value && typeof value === "object") return `{${Object.keys(value).sort().map((key) => `${JSON.stringify(key)}:${canonicalJson(value[key])}`).join(",")}}`;
  return JSON.stringify(value);
}

test("parser identity fingerprints actual implementation, library, options, and invoked limits", (t) => {
  if (!python) return t.skip("set MYOS_TEST_DOCUMENT_PYTHON to run real parser cases");
  const root = makeFixtures(t);
  const result = parseSuccess(runParser(path.join(root, "sample.docx"), "docx", { segments: 17 }));
  assert.equal(result.parserIdentity.implementation, "myos-local-document-parser");
  assert.match(result.parserIdentity.implementationHash, /^[a-f0-9]{64}$/);
  assert.match(result.parserIdentity.libraries.docx, /^\d+\.\d+/);
  assert.equal(result.parserIdentity.options.formulaEvaluation, false);
  assert.equal(result.parserIdentity.options.xmlEntities, false);
  assert.equal(result.parserIdentity.limits.segments, 17);
  assert.equal(result.parserFingerprint, crypto.createHash("sha256").update(canonicalJson(result.parserIdentity)).digest("hex"));
});

test("image PDF coverage is honest and never claims OCR", (t) => {
  if (!python) return t.skip("set MYOS_TEST_DOCUMENT_PYTHON to run real parser cases");
  const root = makeFixtures(t);
  const boundary = parserCodeOrNull(runParser(path.join(root, "sample.pdf"), "pdf"));
  if (boundary === "UNSUPPORTED_SAFETY_BOUNDARY") {
    assert.equal(process.platform, "darwin");
    assert.equal(parserCode(runParser(path.join(root, "image.pdf"), "pdf")), "UNSUPPORTED_SAFETY_BOUNDARY");
    return;
  }
  assert.equal(parserCode(runParser(path.join(root, "image.pdf"), "pdf")), "OCR_REQUIRED");
  assert.equal(parserCode(runParser(path.join(root, "nested-form-image.pdf"), "pdf")), "OCR_REQUIRED");
  const mixed = parseSuccess(runParser(path.join(root, "mixed.pdf"), "pdf"));
  assert.equal(mixed.complete, false);
  assert.equal(mixed.coverage.status, "partial");
  assert.deepEqual(mixed.coverage.limitations, ["imageTextNotExtracted", "page:2:nonTextContentNotExtracted"]);
});

test("malformed, encrypted, hostile XML, duplicate, traversal, and bomb inputs fail explicitly", (t) => {
  if (!python) return t.skip("set MYOS_TEST_DOCUMENT_PYTHON to run real parser cases");
  const root = makeFixtures(t);
  const malformed = path.join(root, "malformed.docx"); fs.writeFileSync(malformed, "not zip");
  const cases = [
    ["malformed.docx", "docx", "MALFORMED_ARCHIVE"],
    ["flagged.docx", "docx", "ENCRYPTED_UNSUPPORTED"],
    ["dtd.docx", "docx", "UNSAFE_XML"],
    ["dtd-utf16le.docx", "docx", "UNSAFE_XML"],
    ["dtd-utf16be.docx", "docx", "UNSAFE_XML"],
    ["external-utf16le.docx", "docx", "UNSAFE_XML"],
    ["external-utf16be.docx", "docx", "UNSAFE_XML"],
    ["duplicate.docx", "docx", "UNSAFE_ARCHIVE"],
    ["traversal.docx", "docx", "UNSAFE_ARCHIVE"],
    ["symlink.docx", "docx", "UNSAFE_ARCHIVE"],
    ["macro.docx", "docx", "UNSUPPORTED_FORMAT"],
    ["bomb.docx", "docx", "ARCHIVE_LIMIT"],
  ];
  for (const [name, extension, code] of cases) assert.equal(parserCode(runParser(path.join(root, name), extension)), code, name);
});

test("PDF decoded stream expansion is hard-capped or the platform fails closed", (t) => {
  if (!python) return t.skip("set MYOS_TEST_DOCUMENT_PYTHON to run real parser cases");
  const root = makeFixtures(t);
  const code = parserCode(runParser(path.join(root, "compressed-bomb.pdf"), "pdf"));
  assert.equal(code, process.platform === "darwin" ? "UNSUPPORTED_SAFETY_BOUNDARY" : "PDF_STREAM_LIMIT");
});

test("Office omitted-content coverage is explicitly partial", (t) => {
  if (!python) return t.skip("set MYOS_TEST_DOCUMENT_PYTHON to run real parser cases");
  const root = makeFixtures(t);
  const docx = parseSuccess(runParser(path.join(root, "coverage.docx"), "docx"));
  assert.equal(docx.complete, false);
  assert.deepEqual(docx.coverage.limitations, ["headersFootersNotExtracted", "nestedTablesNotExtracted", "textBoxesNotExtracted"]);
  const pptx = parseSuccess(runParser(path.join(root, "coverage.pptx"), "pptx"));
  assert.equal(pptx.complete, false);
  assert.deepEqual(pptx.coverage.limitations, ["chartTextNotExtracted", "imageTextNotExtracted", "notesNotExtracted"]);
});

test("DOCX footnote-only content cannot claim complete empty extraction", (t) => {
  if (!python) return t.skip("set MYOS_TEST_DOCUMENT_PYTHON to run real parser cases");
  const root = makeFixtures(t);
  const result = parseSuccess(runParser(path.join(root, "footnote-only.docx"), "docx"));
  assert.equal(result.text, "");
  assert.equal(result.complete, false);
  assert.deepEqual(result.coverage.limitations, ["footnotesNotExtracted"]);
});

test("DOCX endnote-only content cannot claim complete empty extraction", (t) => {
  if (!python) return t.skip("set MYOS_TEST_DOCUMENT_PYTHON to run real parser cases");
  const root = makeFixtures(t);
  const result = parseSuccess(runParser(path.join(root, "endnote-only.docx"), "docx"));
  assert.equal(result.text, "");
  assert.equal(result.complete, false);
  assert.deepEqual(result.coverage.limitations, ["endnotesNotExtracted"]);
});

test("DOCX image-only content cannot claim complete empty extraction", (t) => {
  if (!python) return t.skip("set MYOS_TEST_DOCUMENT_PYTHON to run real parser cases");
  const root = makeFixtures(t);
  const result = parseSuccess(runParser(path.join(root, "image-only.docx"), "docx"));
  assert.equal(result.text, "");
  assert.equal(result.complete, false);
  assert.deepEqual(result.coverage.limitations, ["imageTextNotExtracted"]);
});

test("XLSX namespace-aware preflight rejects prefixed cells and unsafe extents before loading", (t) => {
  if (!python) return t.skip("set MYOS_TEST_DOCUMENT_PYTHON to run real parser cases");
  const root = makeFixtures(t);
  assert.equal(parserCode(runParser(path.join(root, "prefixed-cells.xlsx"), "xlsx", { cells: 1 })), "CELL_LIMIT");
  assert.equal(parserCode(runParser(path.join(root, "bogus-dimension.xlsx"), "xlsx")), "CELL_LIMIT");
  assert.equal(parserCode(runParser(path.join(root, "huge-merge.xlsx"), "xlsx")), "CELL_LIMIT");
});

test("XLSX never evaluates formulas and marks cached values as potentially stale", (t) => {
  if (!python) return t.skip("set MYOS_TEST_DOCUMENT_PYTHON to run real parser cases");
  const root = makeFixtures(t);
  const result = parseSuccess(runParser(path.join(root, "cached-formula.xlsx"), "xlsx"));
  assert.match(result.text, /2/);
  assert.deepEqual(result.coverage.limitations, ["cachedFormulaValuesMayBeStale"]);
  assert.equal(result.complete, false);
  assert.equal(result.segments.at(-1).locator.valueSource, "cachedFormula");
});

test("parser enforces extracted output and segment limits", (t) => {
  if (!python) return t.skip("set MYOS_TEST_DOCUMENT_PYTHON to run real parser cases");
  const root = makeFixtures(t);
  assert.equal(parserCode(runParser(path.join(root, "sample.docx"), "docx", { extractedUtf8Bytes: 5 })), "EXTRACTED_TEXT_LIMIT");
  assert.equal(parserCode(runParser(path.join(root, "sample.docx"), "docx", { segments: 1 })), "SEGMENT_LIMIT");
  assert.equal(parserCode(runParser(path.join(root, "sample.xlsx"), "xlsx", { cells: 1 })), "CELL_LIMIT");
});

test("sandbox policy denies network for the parser root and its descendants", async (t) => {
  if (!python) return t.skip("set MYOS_TEST_DOCUMENT_PYTHON to run sandbox cases");
  const policy = "(version 1)(allow default)(deny network*)";
  const probe = spawnSync("/usr/bin/sandbox-exec", ["-p", policy, "/usr/bin/true"], { encoding: "utf8" });
  if (probe.status !== 0) {
    await assert.rejects(documents.extractDocument(Buffer.from("x"), { extension: "pdf", pythonPath: python }), (error) => error.code === "SANDBOX_UNAVAILABLE");
    return t.skip(`blockedPlatformStatus=sandbox-exec:${probe.status}:${probe.stderr.trim().slice(0, 120)}`);
  }
  const listener = net.createServer();
  await new Promise((resolve, reject) => listener.once("error", reject).listen(0, "127.0.0.1", resolve));
  t.after(() => listener.close());
  const port = listener.address().port;
  const inner = "import socket,sys\ntry:\n socket.create_connection(('127.0.0.1',int(sys.argv[1])),.5)\nexcept PermissionError as e:\n print('permission-denied',e.errno,file=sys.stderr); raise SystemExit(0 if e.errno == 1 else 3)\nexcept Exception as e:\n print(type(e).__name__,getattr(e,'errno',None),file=sys.stderr); raise SystemExit(4)\nraise SystemExit(5)";
  const rootCode = "import subprocess,sys; raise SystemExit(subprocess.run([sys.executable,'-I','-c',sys.argv[1],sys.argv[2]]).returncode)";
  const network = spawnSync("/usr/bin/sandbox-exec", ["-p", policy, python, "-I", "-c", rootCode, inner, String(port)], { encoding: "utf8" });
  assert.equal(network.status, 0, network.stderr);
  assert.match(network.stderr, /permission-denied 1/);
  const root = makeFixtures(t);
  const result = await documents.extractDocument(fs.readFileSync(path.join(root, "sample.docx")), { extension: "docx", pythonPath: python });
  assert.equal(result.segments[0].locator.paragraph, 1);
  assert.equal(Object.isFrozen(result.parserIdentity), true);
});

test("configured absolute venv symlink path remains usable", async (t) => {
  if (!python) return t.skip("set MYOS_TEST_DOCUMENT_PYTHON to run sandbox cases");
  if (!sandboxAvailable()) return t.skip("blockedPlatformStatus=sandbox-exec-unavailable");
  const root = makeFixtures(t);
  const linkedRoot = path.join(temporaryDirectory(t), "python-venv");
  fs.symlinkSync(path.dirname(path.dirname(python)), linkedRoot, "dir");
  const linkedPython = path.join(linkedRoot, "bin", path.basename(python));
  const result = await documents.extractDocument(fs.readFileSync(path.join(root, "sample.docx")), { extension: "docx", pythonPath: linkedPython });
  assert.match(result.text, /Hello/);
});

test("sandboxed runner bounds stdout, times out, cancels, and settles only after child cleanup", async (t) => {
  if (!python) return t.skip("set MYOS_TEST_DOCUMENT_PYTHON to run sandbox cases");
  if (!sandboxAvailable()) return t.skip("sandbox-exec is blocked by the enclosing test environment");
  const root = makeFixtures(t);
  const bytes = fs.readFileSync(path.join(root, "sample.docx"));
  await assert.rejects(documents.extractDocument(bytes, { extension: "docx", pythonPath: python, stdoutBytes: 100 }), (error) => error.code === "OUTPUT_LIMIT");

  const slowBytes = fs.readFileSync(makeSlowPdf(t));
  await assert.rejects(documents.extractDocument(slowBytes, { extension: "pdf", pythonPath: python, timeoutMs: 1 }), (error) => error.code === "TIMEOUT");
  const controller = new AbortController();
  const pending = documents.extractDocument(slowBytes, { extension: "pdf", pythonPath: python, signal: controller.signal });
  setImmediate(() => controller.abort());
  await assert.rejects(pending, (error) => error.code === "ABORTED");
});
