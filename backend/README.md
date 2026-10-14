# DOCUFLOW AI extraction backend

The React app sends uploaded PDFs/images to this local FastAPI service. It extracts text from digital PDFs with PyMuPDF, uses Tesseract OCR for images/scanned PDFs, and applies conservative regex-based field extraction. Unrecognized values remain missing for human review; this is not a universal invoice parser.

## 1. Prerequisites
- Python 3.10+
- Tesseract OCR installed and available on PATH for image/scanned-PDF OCR.
  - Windows: install Tesseract OCR and, if needed, set `pytesseract.pytesseract.tesseract_cmd` in `main.py` to its installed `tesseract.exe` path.

## 2. Install and run (Windows PowerShell)
```powershell
cd backend
py -m venv .venv
.\.venv\Scripts\Activate.ps1
python -m pip install -r requirements.txt
python -m uvicorn main:app --reload --host 127.0.0.1 --port 8000
```

## 3. Run the frontend in a second terminal
```powershell
npm install
npm run dev
```

Backend health check: http://127.0.0.1:8000/api/health

## Notes
- API is local-only by default. Do not expose it publicly without authentication and stronger upload controls.
- OCR/field extraction may miss or misread values. Always review extracted data before approval.
- Tax rules vary by invoice and jurisdiction; uncertain calculations should be reviewed by a person.
