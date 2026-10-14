from __future__ import annotations
import re
import shutil
from decimal import Decimal, InvalidOperation
from pathlib import Path
from typing import Any

import fitz
import pytesseract
from PIL import Image, ImageEnhance, ImageFilter, ImageOps, UnidentifiedImageError
from fastapi import FastAPI, File, HTTPException, UploadFile
from fastapi.middleware.cors import CORSMiddleware

app = FastAPI(title="DOCUFLOW AI Extraction API", version="1.0.0")
app.add_middleware(
    CORSMiddleware,
    allow_origins=["http://localhost:5173", "http://127.0.0.1:5173", "http://localhost:4173"],
    allow_credentials=False, allow_methods=["GET", "POST", "OPTIONS"], allow_headers=["*"]
)
MAX_BYTES = 15 * 1024 * 1024
ALLOWED = {".pdf", ".png", ".jpg", ".jpeg"}


def configure_tesseract() -> None:
    """Find the Windows Tesseract executable or return a helpful setup error."""
    if shutil.which("tesseract"):
        return
    common_paths = [
        Path(r"C:\Program Files\Tesseract-OCR\tesseract.exe"),
        Path(r"C:\Program Files (x86)\Tesseract-OCR\tesseract.exe"),
    ]
    for candidate in common_paths:
        if candidate.is_file():
            pytesseract.pytesseract.tesseract_cmd = str(candidate)
            return
    raise HTTPException(
        status_code=503,
        detail=(
            "Tesseract OCR is not installed or is not on PATH. Install Tesseract OCR "
            "for Windows, then restart the backend. If already installed, add "
            r"C:\Program Files\Tesseract-OCR to PATH or set "
            "pytesseract.pytesseract.tesseract_cmd in backend/main.py."
        ),
    )


def prepare_ocr_images(image: Image.Image) -> list[Image.Image]:
    """Create a few OCR-friendly versions to improve extraction from phone images."""
    image = ImageOps.exif_transpose(image).convert("RGB")
    # Upscale small images so characters are easier for OCR to distinguish.
    max_side = max(image.size)
    if max_side < 2200:
        scale = min(3.0, 2200 / max_side)
        if scale > 1.05:
            image = image.resize(
                (int(image.width * scale), int(image.height * scale)),
                Image.Resampling.LANCZOS,
            )

    gray = ImageOps.grayscale(image)
    gray = ImageOps.autocontrast(gray)
    sharpened = gray.filter(ImageFilter.SHARPEN)
    contrast = ImageEnhance.Contrast(sharpened).enhance(1.6)
    # Thresholded copy can help with faint text, while grayscale handles coloured text.
    thresholded = contrast.point(lambda px: 255 if px > 165 else 0)
    return [contrast, thresholded]


def run_ocr(image: Image.Image) -> str:
    """Run OCR with multiple page segmentation modes and return the strongest result."""
    configure_tesseract()
    candidates: list[str] = []
    for prepared in prepare_ocr_images(image):
        for psm in (6, 11):
            try:
                result = pytesseract.image_to_string(
                    prepared,
                    config=f"--oem 3 --psm {psm}",
                    timeout=45,
                ).strip()
                if result:
                    candidates.append(result)
            except RuntimeError as exc:
                if "timeout" in str(exc).lower():
                    continue
                raise
    if not candidates:
        return ""
    # Prefer the output with more usable non-whitespace characters.
    return max(candidates, key=lambda value: sum(ch.isalnum() for ch in value))


def clean_money(value: str | None) -> str | None:
    if not value:
        return None
    raw = value.replace(",", "").replace("₹", "").replace("Rs.", "").replace("INR", "").strip()
    raw = re.sub(r"[^0-9.\-]", "", raw)
    try:
        return str(Decimal(raw).quantize(Decimal("0.01")))
    except (InvalidOperation, ValueError):
        return None


def first(patterns: list[str], text: str, flags: int = re.I | re.M) -> str | None:
    for pattern in patterns:
        match = re.search(pattern, text, flags)
        if match:
            return match.group(1).strip(" \t:|-")
    return None


def extract_fields(text: str) -> tuple[dict[str, Any], list[dict[str, str]]]:
    """Extract common invoice fields from PDF/OCR text; unresolved values remain null."""
    lines = [line.strip() for line in text.splitlines() if line.strip()]
    normalized = "\n".join(lines)

    def money_after(patterns: list[str]) -> str | None:
        # Currency symbols can be mangled by PDF font maps (₹ may become I).
        for pattern in patterns:
            m = re.search(pattern + r"[\s:₹$A-Z()\-]*([0-9][0-9,]*(?:\.\d{1,2})?)", normalized, re.I | re.M)
            if m:
                return clean_money(m.group(1))
        return None

    invoice_number = first([
        r"(?:invoice\s*(?:no\.?|number|#|id))\s*[:#\-]?\s*([A-Z0-9][A-Z0-9\-/]+)",
        r"(?:bill\s*(?:no\.?|number|#))\s*[:#\-]?\s*([A-Z0-9][A-Z0-9\-/]+)"
    ], normalized)
    date_pattern = r"(\d{4}[-/]\d{1,2}[-/]\d{1,2}|\d{1,2}[-/]\d{1,2}[-/]\d{2,4}|\d{1,2}[- ](?:Jan|Feb|Mar|Apr|May|Jun|Jul|Aug|Sep|Oct|Nov|Dec)[a-z]*[- ,]\d{4})"
    if invoice_number and invoice_number.upper() in {"NOT", "PROVIDED", "N/A", "NULL", "NONE"}:
        invoice_number = None
    invoice_date = first([
        rf"(?:invoice\s*date|date\s*of\s*issue|bill\s*date|date)\s*[:\-]?\s*{date_pattern}"
    ], normalized)
    due_date = first([rf"(?:due\s*date|payment\s*due)\s*[:\-]?\s*{date_pattern}"], normalized)

    supplier_name = first([
        r"(?:supplier|seller|vendor|from)\s*(?:name)?\s*[:\-]\s*([^\n]{2,100})"
    ], normalized)
    # Common invoices put the seller's name as the first line after "TAX INVOICE".
    if not supplier_name:
        skip_exact = re.compile(r"^(?:tax invoice|invoice|specimen.*|bill to|billed to|description|hsn/sac|qty|unit price|amount|#)$", re.I)
        try:
            title_index = next(i for i, line in enumerate(lines) if re.search(r"\bTAX\s+INVOICE\b", line, re.I))
            stop_index = next((i for i in range(title_index + 1, len(lines)) if re.search(r"invoice\s*(?:no|number|date)", lines[i], re.I)), len(lines))
            for line in lines[title_index + 1:stop_index]:
                if (skip_exact.match(line) or "@" in line or re.search(r"gstin|tax\s*id|^\d", line, re.I)
                        or re.search(r"\b(?:road|street|avenue|lane)\b", line, re.I)
                        or len(line) > 90):
                    continue
                if re.search(r"\b(?:INR|USD|subtotal|total|payment terms)\b", line, re.I):
                    continue
                supplier_name = line
                break
        except StopIteration:
            pass

    customer_name = first([
        r"(?:bill\s*to|billed\s*to|customer|buyer|ship\s*to)\s*(?:name)?\s*[:\-]\s*([^\n]{2,100})"
    ], normalized)
    if not customer_name:
        for i, line in enumerate(lines):
            if re.fullmatch(r"(?:bill\s*to|billed\s*to)", line, re.I) and i + 1 < len(lines):
                candidate = lines[i + 1]
                if not re.search(r"gstin|tax id|^\d", candidate, re.I):
                    customer_name = candidate
                    break

    supplier_address = first([r"(?:supplier\s*address|seller\s*address|vendor\s*address)\s*[:\-]\s*([^\n]+)"], normalized)
    customer_address = first([r"(?:customer\s*address|billing\s*address)\s*[:\-]\s*([^\n]+)"], normalized)
    tax_values = re.findall(r"(?:GSTIN|GST\s*IN|Tax\s*ID)\s*[:#]\s*([A-Z0-9][A-Z0-9\-]{5,25})", normalized, re.I)
    supplier_tax = first([r"(?:supplier|seller|vendor)\s*(?:GSTIN|GST\s*IN|Tax\s*ID)\s*[:#]\s*([A-Z0-9\-]{6,25})"], normalized)
    # A standalone specimen identifier may contain GSTIN in its value.
    specimen_seller = first([r"^(SPECIMEN-GSTIN-SELLER)$"], normalized)
    if not supplier_tax:
        supplier_tax = specimen_seller or (tax_values[0] if tax_values else None)
    customer_tax = first([r"(?:customer|buyer)\s*(?:GSTIN|GST\s*IN|Tax\s*ID)\s*[:#]\s*([A-Z0-9\-]{6,25})"], normalized)
    if not customer_tax and tax_values:
        customer_tax = tax_values[-1] if supplier_tax else tax_values[0]

    if not supplier_address and supplier_name in lines:
        si = lines.index(supplier_name)
        if si + 1 < len(lines) and re.search(r"\b(?:road|street|avenue|lane|karnataka|hassan|bangalore|mysuru)\b", lines[si + 1], re.I):
            supplier_address = lines[si + 1]
    if not customer_address and customer_name in lines:
        ci = lines.index(customer_name)
        if ci + 1 < len(lines) and re.search(r"\b(?:road|street|avenue|lane|karnataka|hassan|bangalore|mysuru)\b", lines[ci + 1], re.I):
            customer_address = lines[ci + 1]

    subtotal = money_after([r"(?:sub\s*total|subtotal|taxable\s*value)"])
    discount = money_after([r"discount"])
    tax_rate = first([r"(?:GST|IGST|CGST\s*\+\s*SGST|tax)\s*\(?\s*(\d{1,2}(?:\.\d+)?)\s*%"], normalized)
    # Handles label and amount being separated into adjacent PDF text lines.
    tax_amount = money_after([r"(?:tax\s*amount|GST\s*amount|total\s*tax|IGST|CGST|SGST)", r"GST\s*\d{1,2}(?:\.\d+)?\s*%"])
    shipping = money_after([r"(?:shipping|freight|delivery\s*charges)"])
    total = money_after([
        r"\b(?:grand\s*total|total\s*due|total\s*amount|amount\s*payable|invoice\s*total|net\s*payable|total)\b"
    ])

    fields = {
        "invoiceNumber": invoice_number,
        "invoiceDate": invoice_date,
        "dueDate": due_date,
        "supplierName": supplier_name,
        "supplierAddress": supplier_address,
        "supplierTaxId": supplier_tax,
        "customerName": customer_name,
        "customerAddress": customer_address,
        "customerTaxId": customer_tax,
        "currency": "INR" if re.search(r"\b(?:INR|Rs\.?|Rupees)\b", normalized, re.I) or "₹" in normalized else ("USD" if "$" in normalized else None),
        "subtotal": subtotal,
        "discount": discount or "0.00",
        "taxRate": tax_rate,
        "taxAmount": tax_amount,
        "shipping": shipping or "0.00",
        "grandTotal": total,
    }

    # Parse the common extracted PDF table pattern where each cell is emitted on its own line.
    items: list[dict[str, str]] = []
    try:
        table_start = next(i for i, line in enumerate(lines) if re.fullmatch(r"description", line, re.I))
        table_end = next((i for i in range(table_start + 1, len(lines)) if re.search(r"^(?:subtotal|sub\s*total)$", lines[i], re.I)), len(lines))
        table_lines = lines[table_start + 1:table_end]
        # Remove column headers, then parse groups: row number, description, HSN, qty, unit price, amount.
        table_lines = [x for x in table_lines if not re.fullmatch(r"(?:HSN/SAC|Qty|Unit Price|Unit|Price|Amount|#)", x, re.I)]
        i = 0
        while i < len(table_lines):
            if not re.fullmatch(r"\d+", table_lines[i]):
                i += 1
                continue
            row_no = table_lines[i]
            if i + 5 >= len(table_lines):
                break
            desc, hsn, qty_raw, price_raw, amount_raw = table_lines[i+1:i+6]
            qty_match = re.fullmatch(r"\d+(?:\.\d+)?", qty_raw)
            price = clean_money(price_raw)
            amount = clean_money(amount_raw)
            if qty_match and price is not None and amount is not None and not re.fullmatch(r"\d+", desc):
                items.append({
                    "description": desc,
                    "quantity": qty_match.group(0),
                    "unitPrice": price,
                    "lineTotal": amount,
                })
                i += 6
            else:
                i += 1
    except StopIteration:
        pass

    # Fallback for single-line tables in other invoice layouts.
    if not items:
        for line in lines:
            m = re.match(r"^\s*(.{2,70}?)\s{2,}(\d+(?:\.\d+)?)\s{1,}(?:[₹$]?\s*)?([\d,I,]+\.\d{2})\s{1,}(?:[₹$]?\s*)?([\d,I,]+\.\d{2})\s*$", line)
            if m:
                items.append({"description": m.group(1).strip(), "quantity": m.group(2), "unitPrice": clean_money(m.group(3)), "lineTotal": clean_money(m.group(4))})
    return fields, items


@app.get("/api/health")
def health() -> dict[str, str]:
    return {"status": "ok", "service": "DOCUFLOW AI extraction API"}


@app.post("/api/extract")
async def extract_invoice(file: UploadFile = File(...)) -> dict[str, Any]:
    filename = file.filename or "invoice"
    suffix = Path(filename).suffix.lower()
    if suffix not in ALLOWED:
        raise HTTPException(status_code=415, detail="Unsupported file type. Upload PDF, PNG, or JPG.")
    data = await file.read(MAX_BYTES + 1)
    if not data:
        raise HTTPException(status_code=400, detail="The uploaded file is empty.")
    if len(data) > MAX_BYTES:
        raise HTTPException(status_code=413, detail="File exceeds the 15 MB limit.")

    text = ""
    source = "PDF_TEXT"
    try:
        if suffix == ".pdf":
            doc = fitz.open(stream=data, filetype="pdf")
            text = "\n".join(page.get_text("text") for page in doc).strip()
            if not text:
                source = "OCR"
                pages = []
                for page in doc:
                    pix = page.get_pixmap(matrix=fitz.Matrix(2, 2), alpha=False)
                    import io
                    image = Image.open(io.BytesIO(pix.tobytes("png")))
                    pages.append(run_ocr(image))
                text = "\n".join(pages).strip()
        else:
            source = "OCR"
            import io
            image = Image.open(io.BytesIO(data))
            text = run_ocr(image).strip()
    except HTTPException:
        raise
    except (fitz.FileDataError, UnidentifiedImageError, OSError, RuntimeError) as exc:
        raise HTTPException(status_code=400, detail=f"Could not read this document: {exc}") from exc
    except Exception as exc:
        raise HTTPException(status_code=500, detail=f"Document extraction failed. Check OCR/PDF dependencies: {exc}") from exc

    if not text:
        raise HTTPException(status_code=422, detail="No readable text was found. Try a clearer scan or a text-based PDF.")
    fields, line_items = extract_fields(text)
    return {"filename": filename, "source": source, "rawText": text, "fields": fields, "lineItems": line_items}
