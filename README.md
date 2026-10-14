# DOCUFLOW AI

React + TypeScript invoice review frontend with a FastAPI extraction backend.

## Run on Windows

### Terminal 1 — backend
```powershell
cd backend
py -m venv .venv
.\.venv\Scripts\Activate.ps1
python -m pip install -r requirements.txt
python -m uvicorn main:app --reload --host 127.0.0.1 --port 8000
```
Install Tesseract OCR separately and ensure `tesseract.exe` is on PATH for scanned PDFs and images.

### Terminal 2 — frontend
```powershell
npm install
npm run dev
```
Open the URL Vite prints, usually http://localhost:5173.

## Important
- The built-in sample invoices work without the backend.
- Real document uploads call `http://127.0.0.1:8000/api/extract` and will show an error rather than inventing invoice values if the backend is unavailable.
- Text-based PDFs use PyMuPDF. Images and scanned PDFs use Tesseract OCR.
- Extraction is heuristic and may miss values; users must review uncertain fields before approval.
- This is a local hackathon prototype, not a production finance system.
