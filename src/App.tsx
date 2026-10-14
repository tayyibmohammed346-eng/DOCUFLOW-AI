import { useState, useMemo } from 'react';
import {
  FileText, Upload, CheckCircle2, AlertTriangle, XCircle, HelpCircle,
  RefreshCw, Plus, Trash2, Eye, Check, X, Search,
  Terminal, ShieldAlert, Sparkles, ArrowRight, FileSpreadsheet, FileJson, RotateCcw
} from 'lucide-react';

// ============================================================================
// 1. DECIMAL-SAFE ARITHMETIC ENGINE (Cents/Paise Integer Representation)
// ============================================================================
class SafeDecimal {
  private cents: number;

  constructor(value: string | number | null | undefined) {
    if (value === null || value === undefined || String(value).trim() === '') {
      this.cents = 0;
      return;
    }
    const clean = String(value).replace(/[^0-9.-]/g, '');
    const parsed = Number(clean);
    this.cents = Number.isNaN(parsed) ? 0 : Math.round(parsed * 100);
  }

  static fromCents(cents: number): SafeDecimal {
    const d = new SafeDecimal(0);
    d.cents = Math.round(cents);
    return d;
  }

  add(other: SafeDecimal): SafeDecimal {
    return SafeDecimal.fromCents(this.cents + other.cents);
  }

  sub(other: SafeDecimal): SafeDecimal {
    return SafeDecimal.fromCents(this.cents - other.cents);
  }

  mulQty(qty: string | number): SafeDecimal {
    const q = Number(qty);
    if (Number.isNaN(q)) return SafeDecimal.fromCents(0);
    return SafeDecimal.fromCents(Math.round(this.cents * q));
  }

  mulRate(percentRate: string | number): SafeDecimal {
    const r = Number(percentRate);
    if (Number.isNaN(r)) return SafeDecimal.fromCents(0);
    return SafeDecimal.fromCents(Math.round((this.cents * r) / 100));
  }

  diffCents(other: SafeDecimal): number {
    return Math.abs(this.cents - other.cents);
  }

  toString(): string {
    const sign = this.cents < 0 ? '-' : '';
    const abs = Math.abs(this.cents);
    const whole = Math.floor(abs / 100);
    const frac = String(abs % 100).padStart(2, '0');
    return `${sign}${whole}.${frac}`;
  }
}

// ============================================================================
// 2. DATA SCHEMAS & TYPES
// ============================================================================
type ExtractionSource = 'PDF_TEXT' | 'OCR' | 'AI' | 'SAMPLE';
type FieldReviewStatus = 'EXTRACTED' | 'MISSING' | 'UNCERTAIN' | 'USER_EDITED';
type ValidationStatus = 'PASS' | 'WARNING' | 'FAIL' | 'NOT_VERIFIABLE';
type DocumentReviewStatus = 'PENDING_REVIEW' | 'APPROVED' | 'REJECTED';

interface ExtractedField {
  value: string | null;
  source: ExtractionSource;
  confidence: string | null;
  reviewStatus: FieldReviewStatus;
  warning?: string;
  manuallyEdited?: boolean;
}

interface LineItem {
  id: string;
  description: string;
  quantity: string;
  unitPrice: string;
  lineTotal: string;
  manuallyEdited?: boolean;
}

interface ValidationResult {
  ruleId: string;
  status: ValidationStatus;
  fields: string[];
  explanation: string;
  expected?: string;
  observed?: string;
}

interface InvoiceRecord {
  id: string;
  filename: string;
  uploadDate: string;
  processingMethod: ExtractionSource;
  reviewStatus: DocumentReviewStatus;
  overrideReason?: string;
  rawText: string;
  fields: {
    invoiceNumber: ExtractedField;
    invoiceDate: ExtractedField;
    dueDate: ExtractedField;
    supplierName: ExtractedField;
    supplierAddress: ExtractedField;
    supplierTaxId: ExtractedField;
    customerName: ExtractedField;
    customerAddress: ExtractedField;
    customerTaxId: ExtractedField;
    currency: ExtractedField;
    subtotal: ExtractedField;
    discount: ExtractedField;
    taxRate: ExtractedField;
    taxAmount: ExtractedField;
    shipping: ExtractedField;
    grandTotal: ExtractedField;
  };
  lineItems: LineItem[];
}

// ============================================================================
// 3. DETERMINISTIC VALIDATION ENGINE
// ============================================================================
function validateInvoice(invoice: InvoiceRecord, allInvoices: InvoiceRecord[]): ValidationResult[] {
  const results: ValidationResult[] = [];
  const f = invoice.fields;
  const sym = f.currency.value === 'USD' ? '$' : '₹';

  // 1. Required Field Checks
  const requiredMap: Array<{ key: keyof InvoiceRecord['fields']; label: string; ruleId: string }> = [
    { key: 'invoiceNumber', label: 'Invoice Number', ruleId: 'REQ-001' },
    { key: 'invoiceDate', label: 'Invoice Date', ruleId: 'REQ-002' },
    { key: 'supplierName', label: 'Supplier Name', ruleId: 'REQ-003' },
    { key: 'grandTotal', label: 'Grand Total', ruleId: 'REQ-004' },
  ];

  for (const req of requiredMap) {
    const val = f[req.key].value;
    const present = val !== null && val.trim() !== '';
    results.push({
      ruleId: req.ruleId,
      status: present ? 'PASS' : 'FAIL',
      fields: [req.key],
      explanation: present
        ? `Required field '${req.label}' is present.`
        : `Critical required field '${req.label}' is missing.`,
      expected: 'Non-empty value',
      observed: present ? val! : 'null (MISSING)',
    });
  }

  // 2. Line-Item Arithmetic Checks (Tolerance ₹0.01 = 1 cent/paisa)
  let computedSubtotal = new SafeDecimal(0);
  invoice.lineItems.forEach((item, idx) => {
    const qty = Number(item.quantity);
    const unit = new SafeDecimal(item.unitPrice);
    const observedLine = new SafeDecimal(item.lineTotal);
    const expectedLine = unit.mulQty(qty);
    computedSubtotal = computedSubtotal.add(expectedLine);

    const diff = expectedLine.diffCents(observedLine);
    results.push({
      ruleId: `ARITH-LI-${idx + 1}`,
      status: diff <= 1 ? 'PASS' : 'FAIL',
      fields: [`lineItems[${idx}]`],
      explanation:
        diff <= 1
          ? `Line #${idx + 1} (${item.description || 'Item'}) arithmetic verified: ${item.quantity} × ${sym}${unit.toString()} = ${sym}${expectedLine.toString()}.`
          : `Line #${idx + 1} arithmetic mismatch: ${item.quantity} × ${sym}${unit.toString()} equals ${sym}${expectedLine.toString()}, but document shows ${sym}${observedLine.toString()}.`,
      expected: `${sym}${expectedLine.toString()}`,
      observed: `${sym}${observedLine.toString()}`,
    });
  });

  // 3. Subtotal Check
  if (f.subtotal.value && invoice.lineItems.length > 0) {
    const observedSub = new SafeDecimal(f.subtotal.value);
    const diffSub = computedSubtotal.diffCents(observedSub);
    results.push({
      ruleId: 'ARITH-SUB',
      status: diffSub <= 1 ? 'PASS' : 'FAIL',
      fields: ['subtotal'],
      explanation:
        diffSub <= 1
          ? `Extracted subtotal matches sum of line items (${sym}${computedSubtotal.toString()}).`
          : `Subtotal mismatch: Sum of line items is ${sym}${computedSubtotal.toString()}, but extracted subtotal is ${sym}${observedSub.toString()}.`,
      expected: `${sym}${computedSubtotal.toString()}`,
      observed: `${sym}${observedSub.toString()}`,
    });
  } else {
    results.push({
      ruleId: 'ARITH-SUB',
      status: 'NOT_VERIFIABLE',
      fields: ['subtotal'],
      explanation: 'Subtotal or line items unavailable; subtotal cross-check is not verifiable.',
    });
  }

  // 4. Tax Calculation Check
  const baseSub = f.subtotal.value ? new SafeDecimal(f.subtotal.value) : computedSubtotal;
  const disc = new SafeDecimal(f.discount.value || '0');
  const taxableBase = baseSub.sub(disc);

  if (f.taxRate.value && f.taxAmount.value) {
    const expectedTax = taxableBase.mulRate(f.taxRate.value);
    const observedTax = new SafeDecimal(f.taxAmount.value);
    const diffTax = expectedTax.diffCents(observedTax);
    results.push({
      ruleId: 'ARITH-TAX',
      status: diffTax <= 1 ? 'PASS' : 'FAIL',
      fields: ['taxRate', 'taxAmount'],
      explanation:
        diffTax <= 1
          ? `Tax calculation verified at ${f.taxRate.value}% on taxable base ${sym}${taxableBase.toString()} (±${sym}0.01 tolerance).`
          : `Tax mismatch: ${f.taxRate.value}% of ${sym}${taxableBase.toString()} is ${sym}${expectedTax.toString()}, but observed tax is ${sym}${observedTax.toString()}.`,
      expected: `${sym}${expectedTax.toString()}`,
      observed: `${sym}${observedTax.toString()}`,
    });
  } else {
    results.push({
      ruleId: 'ARITH-TAX',
      status: 'NOT_VERIFIABLE',
      fields: ['taxRate', 'taxAmount'],
      explanation: 'Tax rate or tax amount not provided; tax percentage verification marked NOT_VERIFIABLE.',
    });
  }

  // 5. Grand Total Check
  if (f.grandTotal.value) {
    const taxVal = new SafeDecimal(f.taxAmount.value || '0');
    const shipVal = new SafeDecimal(f.shipping.value || '0');
    const expectedGrand = taxableBase.add(taxVal).add(shipVal);
    const observedGrand = new SafeDecimal(f.grandTotal.value);
    const diffGrand = expectedGrand.diffCents(observedGrand);

    results.push({
      ruleId: 'ARITH-GRAND',
      status: diffGrand <= 1 ? 'PASS' : 'FAIL',
      fields: ['grandTotal', 'subtotal', 'discount', 'taxAmount', 'shipping'],
      explanation:
        diffGrand <= 1
          ? `Grand Total (${sym}${observedGrand.toString()}) matches (Subtotal − Discount + Tax + Shipping).`
          : `Grand Total arithmetic failure: Expected ${sym}${expectedGrand.toString()}, but invoice states ${sym}${observedGrand.toString()}.`,
      expected: `${sym}${expectedGrand.toString()}`,
      observed: `${sym}${observedGrand.toString()}`,
    });
  }

  // 6. Consistency Checks (Dates, GSTIN, Duplicate Invoice)
  if (f.invoiceDate.value && f.dueDate.value) {
    const invD = new Date(f.invoiceDate.value);
    const dueD = new Date(f.dueDate.value);
    if (!Number.isNaN(invD.getTime()) && !Number.isNaN(dueD.getTime())) {
      const validOrder = dueD.getTime() >= invD.getTime();
      results.push({
        ruleId: 'CONS-DATE',
        status: validOrder ? 'PASS' : 'FAIL',
        fields: ['invoiceDate', 'dueDate'],
        explanation: validOrder
          ? 'Due date occurs on or after the invoice date.'
          : 'Chronological error: Due date precedes the invoice date.',
        expected: `>= ${f.invoiceDate.value}`,
        observed: f.dueDate.value,
      });
    }
  } else {
    results.push({
      ruleId: 'CONS-DATE',
      status: 'NOT_VERIFIABLE',
      fields: ['invoiceDate', 'dueDate'],
      explanation: 'Due date or invoice date is missing; chronological comparison not verifiable.',
    });
  }

  // GSTIN format check
  const gstRegex = /^[0-9]{2}[A-Z]{5}[0-9]{4}[A-Z]{1}[1-9A-Z]{1}Z[0-9A-Z]{1}$/;
  if (f.supplierTaxId.value) {
    const validGst = gstRegex.test(f.supplierTaxId.value.trim());
    results.push({
      ruleId: 'CONS-GSTIN',
      status: validGst ? 'PASS' : 'WARNING',
      fields: ['supplierTaxId'],
      explanation: validGst
        ? 'Supplier Tax/GSTIN matches standard 15-character structure.'
        : 'Supplier Tax ID does not match standard 15-character Indian GSTIN format.',
      expected: '29ABCDE1234F1Z5 pattern',
      observed: f.supplierTaxId.value,
    });
  }

  // Duplicate check
  if (f.invoiceNumber.value && f.supplierName.value) {
    const dup = allInvoices.find(
      (other) =>
        other.id !== invoice.id &&
        other.fields.invoiceNumber.value?.trim().toLowerCase() === f.invoiceNumber.value?.trim().toLowerCase() &&
        other.fields.supplierName.value?.trim().toLowerCase() === f.supplierName.value?.trim().toLowerCase()
    );
    results.push({
      ruleId: 'CONS-DUP',
      status: dup ? 'WARNING' : 'PASS',
      fields: ['invoiceNumber', 'supplierName'],
      explanation: dup
        ? `Duplicate invoice number '${f.invoiceNumber.value}' detected for supplier '${f.supplierName.value}'.`
        : 'No duplicate invoice number found for this supplier.',
    });
  }

  return results;
}

// ============================================================================
// 4. THREE PREPARED SAMPLE INVOICES (DETERMINISTIC DEMO MODE)
// ============================================================================
const INITIAL_SAMPLES: InvoiceRecord[] = [
  {
    id: 'SAMPLE-VALID-01',
    filename: '[SAMPLE 1 - VALID INVOICE] BharatCloud_INV_2026_104.pdf',
    uploadDate: '2026-10-14 09:30',
    processingMethod: 'SAMPLE',
    reviewStatus: 'PENDING_REVIEW',
    rawText: `[SAMPLE DOCUMENT - DEMONSTRATION ONLY]
SUPPLIER: BharatCloud Infrastructure Pvt Ltd
Address: Plot 42, Electronic City Phase II, Bengaluru, KA 560100
GSTIN: 29AABCB1518L1Z4
INVOICE NO: INV-2026-1042 | DATE: 2026-10-01 | DUE DATE: 2026-10-31
CUSTOMER: Apex Manufacturing India Ltd (GSTIN: 27AAACA8921B1Z9)
1. Dedicated GPU Compute Node (Qty: 2, Unit: 25000.00, Total: 50000.00)
2. Managed NVMe Block Storage 10TB (Qty: 4, Unit: 3500.00, Total: 14000.00)
Subtotal: 64000.00 | Discount: 4000.00 | IGST (18%): 10800.00 | Shipping: 0.00
GRAND TOTAL: INR 70800.00`,
    fields: {
      invoiceNumber: { value: 'INV-2026-1042', source: 'SAMPLE', confidence: null, reviewStatus: 'EXTRACTED' },
      invoiceDate: { value: '2026-10-01', source: 'SAMPLE', confidence: null, reviewStatus: 'EXTRACTED' },
      dueDate: { value: '2026-10-31', source: 'SAMPLE', confidence: null, reviewStatus: 'EXTRACTED' },
      supplierName: { value: 'BharatCloud Infrastructure Pvt Ltd', source: 'SAMPLE', confidence: null, reviewStatus: 'EXTRACTED' },
      supplierAddress: { value: 'Plot 42, Electronic City Phase II, Bengaluru, KA 560100', source: 'SAMPLE', confidence: null, reviewStatus: 'EXTRACTED' },
      supplierTaxId: { value: '29AABCB1518L1Z4', source: 'SAMPLE', confidence: null, reviewStatus: 'EXTRACTED' },
      customerName: { value: 'Apex Manufacturing India Ltd', source: 'SAMPLE', confidence: null, reviewStatus: 'EXTRACTED' },
      customerAddress: { value: 'MIDC Andheri East, Mumbai, MH 400093', source: 'SAMPLE', confidence: null, reviewStatus: 'EXTRACTED' },
      customerTaxId: { value: '27AAACA8921B1Z9', source: 'SAMPLE', confidence: null, reviewStatus: 'EXTRACTED' },
      currency: { value: 'INR', source: 'SAMPLE', confidence: null, reviewStatus: 'EXTRACTED' },
      subtotal: { value: '64000.00', source: 'SAMPLE', confidence: null, reviewStatus: 'EXTRACTED' },
      discount: { value: '4000.00', source: 'SAMPLE', confidence: null, reviewStatus: 'EXTRACTED' },
      taxRate: { value: '18', source: 'SAMPLE', confidence: null, reviewStatus: 'EXTRACTED' },
      taxAmount: { value: '10800.00', source: 'SAMPLE', confidence: null, reviewStatus: 'EXTRACTED' },
      shipping: { value: '0.00', source: 'SAMPLE', confidence: null, reviewStatus: 'EXTRACTED' },
      grandTotal: { value: '70800.00', source: 'SAMPLE', confidence: null, reviewStatus: 'EXTRACTED' },
    },
    lineItems: [
      { id: 'li-1', description: 'Dedicated GPU Compute Node (Monthly)', quantity: '2', unitPrice: '25000.00', lineTotal: '50000.00' },
      { id: 'li-2', description: 'Managed NVMe Block Storage 10TB', quantity: '4', unitPrice: '3500.00', lineTotal: '14000.00' },
    ],
  },
  {
    id: 'SAMPLE-BAD-TOTAL-02',
    filename: '[SAMPLE 2 - INCORRECT TOTAL] ZenithLogistics_Freight_889.pdf',
    uploadDate: '2026-10-14 10:05',
    processingMethod: 'SAMPLE',
    reviewStatus: 'PENDING_REVIEW',
    rawText: `[SAMPLE DOCUMENT - DEMONSTRATION ONLY - DELIBERATE ARITHMETIC ERROR]
SUPPLIER: Zenith Freight & Logistics Co.
Address: NH-48 Logistics Park, Gurugram, HR 122001
GSTIN: 06AAACZ4412R1Z1
INVOICE NO: ZFL-2026-889 | DATE: 2026-10-05 | DUE DATE: 2026-10-20
CUSTOMER: Deccan Retail Networks Pvt Ltd (GSTIN: 36AAACD7711M1Z2)
1. Cold-Chain Container Haulage (Qty: 3, Unit: 12000.00, Total: 36000.00)
2. Express Port Customs Clearance (Qty: 1, Unit: 4500.00, Total: 4500.00)
Subtotal: 40500.00 | Discount: 0.00 | GST (18%): 7290.00 | Shipping/Toll: 1200.00
GRAND TOTAL PRINTED ON DOCUMENT: INR 52990.00  <-- (Expected 48990.00)`,
    fields: {
      invoiceNumber: { value: 'ZFL-2026-889', source: 'SAMPLE', confidence: null, reviewStatus: 'EXTRACTED' },
      invoiceDate: { value: '2026-10-05', source: 'SAMPLE', confidence: null, reviewStatus: 'EXTRACTED' },
      dueDate: { value: '2026-10-20', source: 'SAMPLE', confidence: null, reviewStatus: 'EXTRACTED' },
      supplierName: { value: 'Zenith Freight & Logistics Co.', source: 'SAMPLE', confidence: null, reviewStatus: 'EXTRACTED' },
      supplierAddress: { value: 'NH-48 Logistics Park, Gurugram, HR 122001', source: 'SAMPLE', confidence: null, reviewStatus: 'EXTRACTED' },
      supplierTaxId: { value: '06AAACZ4412R1Z1', source: 'SAMPLE', confidence: null, reviewStatus: 'EXTRACTED' },
      customerName: { value: 'Deccan Retail Networks Pvt Ltd', source: 'SAMPLE', confidence: null, reviewStatus: 'EXTRACTED' },
      customerAddress: { value: 'Banjara Hills, Hyderabad, TS 500034', source: 'SAMPLE', confidence: null, reviewStatus: 'EXTRACTED' },
      customerTaxId: { value: '36AAACD7711M1Z2', source: 'SAMPLE', confidence: null, reviewStatus: 'EXTRACTED' },
      currency: { value: 'INR', source: 'SAMPLE', confidence: null, reviewStatus: 'EXTRACTED' },
      subtotal: { value: '40500.00', source: 'SAMPLE', confidence: null, reviewStatus: 'EXTRACTED' },
      discount: { value: '0.00', source: 'SAMPLE', confidence: null, reviewStatus: 'EXTRACTED' },
      taxRate: { value: '18', source: 'SAMPLE', confidence: null, reviewStatus: 'EXTRACTED' },
      taxAmount: { value: '7290.00', source: 'SAMPLE', confidence: null, reviewStatus: 'EXTRACTED' },
      shipping: { value: '1200.00', source: 'SAMPLE', confidence: null, reviewStatus: 'EXTRACTED' },
      grandTotal: {
        value: '52990.00',
        source: 'SAMPLE',
        confidence: null,
        reviewStatus: 'UNCERTAIN',
        warning: 'Discrepancy detected: Sum equals 48990.00',
      },
    },
    lineItems: [
      { id: 'li-201', description: 'Cold-Chain Container Haulage', quantity: '3', unitPrice: '12000.00', lineTotal: '36000.00' },
      { id: 'li-202', description: 'Express Port Customs Clearance', quantity: '1', unitPrice: '4500.00', lineTotal: '4500.00' },
    ],
  },
  {
    id: 'SAMPLE-INCOMPLETE-03',
    filename: '[SAMPLE 3 - INCOMPLETE INVOICE] Scanned_Vendor_Bill_MissingNo.jpg',
    uploadDate: '2026-10-14 10:20',
    processingMethod: 'SAMPLE',
    reviewStatus: 'PENDING_REVIEW',
    rawText: `[SAMPLE DOCUMENT - DEMONSTRATION ONLY - MISSING REQUIRED INVOICE NUMBER]
SUPPLIER: Sri Krishna Industrial Supplies
Address: Peenya Industrial Area, Bengaluru, KA 560058
GSTIN: 29AABCS9981K1Z8
INVOICE NO: [BLURRED / TORN CORNER - MISSING] | DATE: 2026-10-10
CUSTOMER: Precision Motors Hassan Pvt Ltd
1. CNC Carbide Insert Pack (Qty: 10, Unit: 850.00, Total: 8500.00)
Subtotal: 8500.00 | GST (18%): 1530.00 | GRAND TOTAL: INR 10030.00`,
    fields: {
      invoiceNumber: {
        value: null,
        source: 'SAMPLE',
        confidence: 'UNAVAILABLE (Torn edge in scan)',
        reviewStatus: 'MISSING',
        warning: 'Required field missing from source document',
      },
      invoiceDate: { value: '2026-10-10', source: 'SAMPLE', confidence: null, reviewStatus: 'EXTRACTED' },
      dueDate: { value: null, source: 'SAMPLE', confidence: null, reviewStatus: 'MISSING' },
      supplierName: { value: 'Sri Krishna Industrial Supplies', source: 'SAMPLE', confidence: null, reviewStatus: 'EXTRACTED' },
      supplierAddress: { value: 'Peenya Industrial Area, Bengaluru, KA 560058', source: 'SAMPLE', confidence: null, reviewStatus: 'EXTRACTED' },
      supplierTaxId: { value: '29AABCS9981K1Z8', source: 'SAMPLE', confidence: null, reviewStatus: 'EXTRACTED' },
      customerName: { value: 'Precision Motors Hassan Pvt Ltd', source: 'SAMPLE', confidence: null, reviewStatus: 'EXTRACTED' },
      customerAddress: { value: 'KIADB Growth Centre, Hassan, KA 573201', source: 'SAMPLE', confidence: null, reviewStatus: 'EXTRACTED' },
      customerTaxId: { value: null, source: 'SAMPLE', confidence: null, reviewStatus: 'MISSING' },
      currency: { value: 'INR', source: 'SAMPLE', confidence: null, reviewStatus: 'EXTRACTED' },
      subtotal: { value: '8500.00', source: 'SAMPLE', confidence: null, reviewStatus: 'EXTRACTED' },
      discount: { value: '0.00', source: 'SAMPLE', confidence: null, reviewStatus: 'EXTRACTED' },
      taxRate: { value: '18', source: 'SAMPLE', confidence: null, reviewStatus: 'EXTRACTED' },
      taxAmount: { value: '1530.00', source: 'SAMPLE', confidence: null, reviewStatus: 'EXTRACTED' },
      shipping: { value: '0.00', source: 'SAMPLE', confidence: null, reviewStatus: 'EXTRACTED' },
      grandTotal: { value: '10030.00', source: 'SAMPLE', confidence: null, reviewStatus: 'EXTRACTED' },
    },
    lineItems: [
      { id: 'li-301', description: 'CNC Carbide Insert Pack (Box of 10)', quantity: '10', unitPrice: '850.00', lineTotal: '8500.00' },
    ],
  },
];

// ============================================================================
// 5. CSV FORMULA-INJECTION SANITIZER & EXPORTERS
// ============================================================================
function sanitizeCsvCell(val: string | null | undefined): string {
  if (val === null || val === undefined) return '""';
  let str = String(val);
  // Prevent spreadsheet formula injection (=, +, -, @, Tab, CR)
  if (/^[=+\-@\t\r]/.test(str)) {
    str = `'${str}`;
  }
  return `"${str.replace(/"/g, '""')}"`;
}

// ============================================================================
// 6. MAIN REACT COMPONENT
// ============================================================================
export default function App() {
  const [invoices, setInvoices] = useState<InvoiceRecord[]>(() => {
    const saved = localStorage.getItem('docuflow_invoices_v1');
    if (saved) {
      try { return JSON.parse(saved); } catch { /* fallback */ }
    }
    return INITIAL_SAMPLES;
  });

  const [activeTab, setActiveTab] = useState<'dashboard' | 'upload' | 'review' | 'history'>('dashboard');
  const [selectedId, setSelectedId] = useState<string>(INITIAL_SAMPLES[0].id);
  const [searchQuery, setSearchQuery] = useState('');
  const [uploadError, setUploadError] = useState<string | null>(null);
  const [isProcessing, setIsProcessing] = useState(false);
  const [overrideModalOpen, setOverrideModalOpen] = useState(false);
  const [overrideReasonInput, setOverrideReasonInput] = useState('');
  const [toast, setToast] = useState<string | null>(null);
  // Validation list filter: clicking the FAIL counter shows only failed rules.
  const [validationFilter, setValidationFilter] = useState<'ALL' | 'FAIL'>('ALL');

  const saveInvoices = (updated: InvoiceRecord[]) => {
    setInvoices(updated);
    localStorage.setItem('docuflow_invoices_v1', JSON.stringify(updated));
  };

  const showToast = (msg: string) => {
    setToast(msg);
    setTimeout(() => setToast(null), 3500);
  };

  const activeInvoice = useMemo(
    () => invoices.find((inv) => inv.id === selectedId) || invoices[0],
    [invoices, selectedId]
  );

  const activeValidations = useMemo(
    () => validateInvoice(activeInvoice, invoices),
    [activeInvoice, invoices]
  );

  const visibleValidations = useMemo(
    () => validationFilter === 'FAIL'
      ? activeValidations.filter((validation) => validation.status === 'FAIL')
      : activeValidations,
    [activeValidations, validationFilter]
  );

  // Clicking a failed validation takes the reviewer directly to the most relevant editable field.
  const handleValidationClick = (validation: ValidationResult) => {
    if (validation.status === 'PASS') return;
    setActiveTab('review');

    const fieldKeys = validation.fields || [];
    let targetSelector = '';
    if (validation.ruleId === 'ARITH-GRAND' || fieldKeys.includes('grandTotal')) {
      targetSelector = '[data-invoice-field="grandTotal"]';
    } else if (validation.ruleId.includes('LINE') || fieldKeys.some((key) => /lineItems|quantity|unitPrice|lineTotal/i.test(key))) {
      targetSelector = '[data-line-field="lineTotal"]';
    } else {
      const preferred = ['invoiceNumber', 'invoiceDate', 'dueDate', 'supplierName', 'supplierTaxId', 'subtotal', 'discount', 'taxRate', 'taxAmount', 'shipping'];
      const targetKey = preferred.find((key) => fieldKeys.includes(key));
      if (targetKey) targetSelector = `[data-invoice-field="${targetKey}"]`;
    }

    window.requestAnimationFrame(() => {
      const target = targetSelector ? document.querySelector<HTMLInputElement>(targetSelector) : null;
      if (target) {
        target.scrollIntoView({ behavior: 'smooth', block: 'center' });
        target.focus({ preventScroll: true });
        target.classList.add('ring-2', 'ring-rose-500', 'border-rose-500');
        window.setTimeout(() => target.classList.remove('ring-2', 'ring-rose-500', 'border-rose-500'), 1800);
      } else {
        showToast('Could not locate an editable field for this check. Review the fields below.');
      }
    });
  };

  // Dashboard Metrics
  const stats = useMemo(() => {
    let approved = 0;
    let needsReview = 0;
    let criticalFailures = 0;
    invoices.forEach((inv) => {
      if (inv.reviewStatus === 'APPROVED') approved++;
      if (inv.reviewStatus === 'PENDING_REVIEW') needsReview++;
      const vals = validateInvoice(inv, invoices);
      if (vals.some((v) => v.status === 'FAIL')) criticalFailures++;
    });
    return { total: invoices.length, approved, needsReview, criticalFailures };
  }, [invoices]);

  // Handlers
  const handleSelectSample = (sampleId: string) => {
    setSelectedId(sampleId);
    setValidationFilter('ALL');
    setActiveTab('review');
    showToast(`Loaded ${sampleId} into Review Studio`);
  };

  const handleResetDemo = () => {
    localStorage.removeItem('docuflow_invoices_v1');
    setInvoices(INITIAL_SAMPLES);
    setSelectedId(INITIAL_SAMPLES[0].id);
    setValidationFilter('ALL');
    showToast('Reset all sample invoices to original state.');
  };

  const handleFieldChange = (key: keyof InvoiceRecord['fields'], newVal: string) => {
    const updated = invoices.map((inv) => {
      if (inv.id !== activeInvoice.id) return inv;
      return {
        ...inv,
        reviewStatus: 'PENDING_REVIEW' as DocumentReviewStatus,
        overrideReason: undefined,
        fields: {
          ...inv.fields,
          [key]: {
            ...inv.fields[key],
            value: newVal.trim() === '' ? null : newVal,
            reviewStatus: 'USER_EDITED' as FieldReviewStatus,
            manuallyEdited: true,
          },
        },
      };
    });
    saveInvoices(updated);
  };

  const handleLineItemChange = (itemId: string, prop: keyof LineItem, val: string) => {
    const updated = invoices.map((inv) => {
      if (inv.id !== activeInvoice.id) return inv;
      return {
        ...inv,
        reviewStatus: 'PENDING_REVIEW' as DocumentReviewStatus,
        overrideReason: undefined,
        lineItems: inv.lineItems.map((li) =>
          li.id === itemId ? { ...li, [prop]: val, manuallyEdited: true } : li
        ),
      };
    });
    saveInvoices(updated);
  };

  // Recalculate derived invoice amounts from editable quantities, unit prices, discount, tax rate, and shipping.
  // This is an explicit reviewer action; it never silently changes an invoice during upload.
  const handleRecalculateAmounts = () => {
    const current = activeInvoice;
    const taxRateText = current.fields.taxRate.value;
    if (taxRateText === null || taxRateText.trim() === '' || !Number.isFinite(Number(taxRateText))) {
      showToast('Cannot calculate tax: enter a valid Tax Rate (%) first.');
      return;
    }

    let computedSubtotal: SafeDecimal;
    let recalculatedLineItems = current.lineItems;
    if (current.lineItems.length > 0) {
      let sum = new SafeDecimal(0);
      let invalidLine = false;
      recalculatedLineItems = current.lineItems.map((item) => {
        const qtyText = String(item.quantity ?? '').trim();
        const unitText = String(item.unitPrice ?? '').trim().replace(/,/g, '');
        const qty = Number(qtyText);
        const unitValue = Number(unitText);
        if (!qtyText || !unitText || !Number.isFinite(qty) || !Number.isFinite(unitValue)) {
          invalidLine = true;
          return item;
        }
        const lineTotal = new SafeDecimal(unitText).mulQty(qty).toString();
        sum = sum.add(new SafeDecimal(lineTotal));
        return { ...item, lineTotal, manuallyEdited: true };
      });
      if (invalidLine) {
        showToast('Cannot recalculate totals: every line item needs a valid quantity and unit price.');
        return;
      }
      computedSubtotal = sum;
    } else if (current.fields.subtotal.value !== null && current.fields.subtotal.value.trim() !== '') {
      computedSubtotal = new SafeDecimal(current.fields.subtotal.value);
    } else {
      showToast('Cannot recalculate totals: provide a subtotal or at least one complete line item.');
      return;
    }

    const discountText = current.fields.discount.value || '0';
    const shippingText = current.fields.shipping.value || '0';
    if (!Number.isFinite(Number(String(discountText).replace(/,/g, ''))) || !Number.isFinite(Number(String(shippingText).replace(/,/g, '')))) {
      showToast('Cannot recalculate totals: discount and shipping must be valid numbers.');
      return;
    }

    const discount = new SafeDecimal(discountText);
    const shipping = new SafeDecimal(shippingText);
    const taxableBase = computedSubtotal.sub(discount);
    if (Number(taxableBase.toString()) < 0) {
      showToast('Cannot recalculate totals: discount cannot exceed the subtotal.');
      return;
    }
    const taxAmount = taxableBase.mulRate(taxRateText);
    const grandTotal = taxableBase.add(taxAmount).add(shipping);

    const markEdited = (key: keyof InvoiceRecord['fields'], value: string): ExtractedField => ({
      ...current.fields[key],
      value,
      reviewStatus: 'USER_EDITED',
      manuallyEdited: true,
      warning: undefined,
    });

    const updated = invoices.map((inv) => inv.id !== current.id ? inv : ({
      ...inv,
      reviewStatus: 'PENDING_REVIEW' as DocumentReviewStatus,
      overrideReason: undefined,
      lineItems: recalculatedLineItems,
      fields: {
        ...inv.fields,
        subtotal: markEdited('subtotal', computedSubtotal.toString()),
        taxAmount: markEdited('taxAmount', taxAmount.toString()),
        grandTotal: markEdited('grandTotal', grandTotal.toString()),
      },
    }));
    saveInvoices(updated);
    showToast(`Recalculated subtotal, tax (${taxAmount.toString()}), and grand total (${grandTotal.toString()}). Review the updated checks before approval.`);
  };

  const handleAddLineItem = () => {
    const updated = invoices.map((inv) => {
      if (inv.id !== activeInvoice.id) return inv;
      return {
        ...inv,
        reviewStatus: 'PENDING_REVIEW' as DocumentReviewStatus,
        overrideReason: undefined,
        lineItems: [
          ...inv.lineItems,
          {
            id: `li-${Date.now()}`,
            description: 'New Item',
            quantity: '1',
            unitPrice: '0.00',
            lineTotal: '0.00',
            manuallyEdited: true,
          },
        ],
      };
    });
    saveInvoices(updated);
  };

  const handleDeleteLineItem = (itemId: string) => {
    const updated = invoices.map((inv) => {
      if (inv.id !== activeInvoice.id) return inv;
      return {
        ...inv,
        reviewStatus: 'PENDING_REVIEW' as DocumentReviewStatus,
        overrideReason: undefined,
        lineItems: inv.lineItems.filter((li) => li.id !== itemId),
      };
    });
    saveInvoices(updated);
  };

  // Real extraction is performed by the FastAPI backend. Never fabricate values on upload.
  const handleFileUpload = async (file: File | null, simulateCorrupt = false) => {
    setUploadError(null);
    if (simulateCorrupt) {
      setUploadError('Extraction test: the selected file was intentionally treated as corrupt. No invoice was created.');
      return;
    }
    if (!file) return;
    const allowed = ['application/pdf', 'image/png', 'image/jpeg'];
    if (!allowed.includes(file.type) && !/\.(pdf|png|jpg|jpeg)$/i.test(file.name)) {
      setUploadError(`Unsupported format "${file.name}". Only PDF, PNG, and JPG invoices are accepted.`);
      return;
    }
    if (file.size === 0) { setUploadError(`File "${file.name}" is empty (0 bytes).`); return; }
    if (file.size > 15 * 1024 * 1024) { setUploadError('File exceeds maximum allowed size of 15 MB.'); return; }

    setIsProcessing(true);
    try {
      const form = new FormData();
      form.append('file', file);
      const response = await fetch('http://127.0.0.1:8000/api/extract', { method: 'POST', body: form });
      const body = await response.json().catch(() => ({}));
      if (!response.ok) throw new Error(body.detail || `Extraction service returned HTTP ${response.status}.`);
      const sourceType: ExtractionSource = body.source === 'OCR' ? 'OCR' : 'PDF_TEXT';
      const fieldKeys: Array<keyof InvoiceRecord['fields']> = [
        'invoiceNumber', 'invoiceDate', 'dueDate', 'supplierName', 'supplierAddress', 'supplierTaxId',
        'customerName', 'customerAddress', 'customerTaxId', 'currency', 'subtotal', 'discount',
        'taxRate', 'taxAmount', 'shipping', 'grandTotal'
      ];
      const extracted = {} as InvoiceRecord['fields'];
      for (const key of fieldKeys) {
        const value = body.fields?.[key] ?? null;
        extracted[key] = {
          value: value === '' || value === undefined ? null : String(value),
          source: sourceType,
          confidence: null,
          reviewStatus: value === null || value === undefined || value === '' ? 'MISSING' : 'UNCERTAIN',
          warning: value === null || value === undefined || value === '' ? 'Not confidently found; review the original document.' : undefined,
        };
      }
      const lineItems: LineItem[] = Array.isArray(body.lineItems) ? body.lineItems.map((item: any, index: number) => ({
        id: `li-${Date.now()}-${index}`,
        description: String(item.description || ''),
        quantity: String(item.quantity ?? ''),
        unitPrice: String(item.unitPrice ?? ''),
        lineTotal: String(item.lineTotal ?? ''),
      })) : [];
      if (!body.rawText || !String(body.rawText).trim()) throw new Error('No readable text was found. Try a clearer scan or a text-based PDF.');
      const newInv: InvoiceRecord = {
        id: `DOC-${Date.now().toString().slice(-6)}`,
        filename: file.name,
        uploadDate: new Date().toISOString().slice(0, 16).replace('T', ' '),
        processingMethod: sourceType,
        reviewStatus: 'PENDING_REVIEW',
        rawText: String(body.rawText),
        fields: extracted,
        lineItems,
      };
      const nextList = [newInv, ...invoices];
      saveInvoices(nextList);
      setSelectedId(newInv.id);
      setActiveTab('review');
      showToast(`Extracted text from "${file.name}". Review uncertain fields before approval.`);
    } catch (error) {
      const message = error instanceof Error ? error.message : 'Unknown extraction error.';
      setUploadError(`${message} Make sure the DOCUFLOW backend is running; see backend/README.md.`);
    } finally {
      setIsProcessing(false);
    }
  };

  // Approval & Auditable Override
  const hasCriticalFailures = activeValidations.some((v) => v.status === 'FAIL' || v.status === 'NOT_VERIFIABLE');

  const handleApprove = () => {
    if (hasCriticalFailures) {
      setOverrideModalOpen(true);
      return;
    }
    const updated = invoices.map((inv) =>
      inv.id === activeInvoice.id ? { ...inv, reviewStatus: 'APPROVED' as DocumentReviewStatus } : inv
    );
    saveInvoices(updated);
    showToast('Invoice approved and ready for export.');
    setActiveTab('dashboard');
  };

  const handleConfirmOverride = () => {
    if (overrideReasonInput.trim().length < 5) return;
    const updated = invoices.map((inv) =>
      inv.id === activeInvoice.id
        ? {
            ...inv,
            reviewStatus: 'APPROVED' as DocumentReviewStatus,
            overrideReason: overrideReasonInput.trim(),
          }
        : inv
    );
    saveInvoices(updated);
    setOverrideModalOpen(false);
    setOverrideReasonInput('');
    showToast('Invoice approved with auditable override.');
    setActiveTab('dashboard');
  };

  const handleReject = () => {
  const updated = invoices.map((inv) =>
    inv.id === activeInvoice.id
      ? { ...inv, reviewStatus: 'REJECTED' as DocumentReviewStatus }
      : inv
  );
  saveInvoices(updated);
  showToast('Invoice rejected. Returning to Dashboard.');
  setActiveTab('dashboard');
};


  // Exports
  const exportJSON = (inv: InvoiceRecord) => {
    const payload = {
      exportTimestamp: new Date().toISOString(),
      documentId: inv.id,
      filename: inv.filename,
      processingMethod: inv.processingMethod,
      reviewAndApprovalStatus: inv.reviewStatus,
      auditableOverrideReason: inv.overrideReason || null,
      validationSummary: {
        criticalFailures: activeValidations.filter((v) => v.status === 'FAIL').length,
        warnings: activeValidations.filter((v) => v.status === 'WARNING').length,
        checks: activeValidations,
      },
      extractedFields: inv.fields,
      lineItems: inv.lineItems,
    };
    const blob = new Blob([JSON.stringify(payload, null, 2)], { type: 'application/json' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = `${inv.fields.invoiceNumber.value || inv.id}_validated.json`;
    a.click();
    URL.revokeObjectURL(url);
  };

  const exportCSV = (inv: InvoiceRecord) => {
    const headers = [
      'Document_ID', 'Approval_Status', 'Override_Audit_Note', 'Invoice_Number',
      'Invoice_Date', 'Due_Date', 'Supplier_Name', 'Supplier_GSTIN', 'Customer_Name',
      'Currency', 'Subtotal', 'Discount', 'Tax_Rate', 'Tax_Amount', 'Shipping', 'Grand_Total', 'Line_Items_Count'
    ];
    const f = inv.fields;
    const row = [
      inv.id, inv.reviewStatus, inv.overrideReason || 'NONE',
      f.invoiceNumber.value, f.invoiceDate.value, f.dueDate.value,
      f.supplierName.value, f.supplierTaxId.value, f.customerName.value,
      f.currency.value, f.subtotal.value, f.discount.value,
      f.taxRate.value, f.taxAmount.value, f.shipping.value, f.grandTotal.value,
      String(inv.lineItems.length)
    ].map(sanitizeCsvCell);

    const csvContent = `${headers.join(',')}\n${row.join(',')}`;
    const blob = new Blob([csvContent], { type: 'text/csv;charset=utf-8;' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = `${inv.fields.invoiceNumber.value || inv.id}_validated.csv`;
    a.click();
    URL.revokeObjectURL(url);
  };

  return (
    <div className="min-h-screen bg-slate-50 text-slate-900 flex flex-col font-sans">
      {/* Top Enterprise Header */}
      <header className="bg-slate-900 text-white border-b border-slate-800 sticky top-0 z-30">
        <div className="max-w-7xl mx-auto px-4 sm:px-6 h-16 flex items-center justify-between">
          <div className="flex items-center gap-3">
            <div className="w-9 h-9 rounded-lg bg-teal-500 flex items-center justify-center text-slate-950 font-bold shadow-sm">
              <FileText className="w-5 h-5" />
            </div>
            <div>
              <span className="font-bold tracking-tight text-lg">DOCUFLOW AI</span>
              <span className="ml-2 text-xs bg-teal-500/20 text-teal-300 border border-teal-500/30 px-2 py-0.5 rounded-full">
                Invoice Validation Engine
              </span>
            </div>
          </div>

          <nav className="flex items-center gap-1">
            {[
              { id: 'dashboard', label: 'Dashboard' },
              { id: 'upload', label: 'Upload Invoice' },
              { id: 'review', label: 'Review Studio' },
              { id: 'history', label: 'Document History' },
            ].map((t) => (
              <button
                key={t.id}
                onClick={() => setActiveTab(t.id as typeof activeTab)}
                className={`px-3.5 py-2 rounded-md text-sm font-medium transition ${
                  activeTab === t.id
                    ? 'bg-teal-600 text-white shadow-xs'
                    : 'text-slate-300 hover:text-white hover:bg-slate-800'
                }`}
              >
                {t.label}
              </button>
            ))}
          </nav>

          <button
            onClick={handleResetDemo}
            title="Reset Demo Data to Initial State"
            className="text-xs flex items-center gap-1.5 text-slate-300 hover:text-white bg-slate-800 hover:bg-slate-700 px-3 py-1.5 rounded-md border border-slate-700"
          >
            <RotateCcw className="w-3.5 h-3.5" /> Reset Demo
          </button>
        </div>
      </header>

      {/* Toast Notification */}
      {toast && (
        <div className="fixed bottom-5 right-5 z-50 bg-slate-900 text-white px-4 py-3 rounded-lg shadow-lg border border-teal-500/40 flex items-center gap-2 text-sm">
          <CheckCircle2 className="w-4 h-4 text-teal-400 shrink-0" />
          <span>{toast}</span>
        </div>
      )}

      {/* Main Content Container */}
      <main className="max-w-7xl w-full mx-auto px-4 sm:px-6 py-8 flex-1">
        {/* ================================================================
            VIEW 1: MAIN DASHBOARD
        ================================================================ */}
        {activeTab === 'dashboard' && (
          <div className="space-y-8">
            <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-4">
              <div>
                <h1 className="text-2xl font-bold text-slate-900">Invoice Processing & Validation Overview</h1>
                <p className="text-sm text-slate-600 mt-1">
                  Deterministic decimal-safe financial validation, OCR extraction, and human-in-the-loop verification.
                </p>
              </div>
              <button
                onClick={() => setActiveTab('upload')}
                className="inline-flex items-center gap-2 bg-teal-600 hover:bg-teal-700 text-white px-4 py-2.5 rounded-lg text-sm font-semibold shadow-xs transition"
              >
                <Upload className="w-4 h-4" /> Upload New Invoice
              </button>
            </div>

            {/* KPI Cards */}
            <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-4 gap-4">
              <div className="bg-white p-5 rounded-xl border border-slate-200 shadow-2xs">
                <span className="text-xs font-semibold uppercase tracking-wider text-slate-500">Total Processed</span>
                <div className="mt-2 flex items-baseline justify-between">
                  <span className="text-3xl font-bold text-slate-900">{stats.total}</span>
                  <span className="text-xs text-slate-500">SQLite / Local Persist</span>
                </div>
              </div>
              <div className="bg-white p-5 rounded-xl border border-slate-200 shadow-2xs">
                <span className="text-xs font-semibold uppercase tracking-wider text-emerald-700">Approved Invoices</span>
                <div className="mt-2 flex items-baseline justify-between">
                  <span className="text-3xl font-bold text-emerald-600">{stats.approved}</span>
                  <span className="text-xs text-emerald-700 bg-emerald-50 px-2 py-0.5 rounded-full font-medium">Export Ready</span>
                </div>
              </div>
              <div className="bg-white p-5 rounded-xl border border-slate-200 shadow-2xs">
                <span className="text-xs font-semibold uppercase tracking-wider text-amber-700">Requiring Review</span>
                <div className="mt-2 flex items-baseline justify-between">
                  <span className="text-3xl font-bold text-amber-600">{stats.needsReview}</span>
                  <span className="text-xs text-amber-700 bg-amber-50 px-2 py-0.5 rounded-full font-medium">Human-in-the-Loop</span>
                </div>
              </div>
              <div className="bg-white p-5 rounded-xl border border-slate-200 shadow-2xs">
                <span className="text-xs font-semibold uppercase tracking-wider text-rose-700">Validation Failures</span>
                <div className="mt-2 flex items-baseline justify-between">
                  <span className="text-3xl font-bold text-rose-600">{stats.criticalFailures}</span>
                  <span className="text-xs text-rose-700 bg-rose-50 px-2 py-0.5 rounded-full font-medium">Arithmetic / Missing</span>
                </div>
              </div>
            </div>

            {/* 3 Mandatory Hackathon Demonstration Scenarios */}
            <div className="bg-white rounded-xl border border-slate-200 p-6 shadow-2xs">
              <div className="flex items-center justify-between mb-4">
                <div>
                  <h2 className="text-base font-bold text-slate-900 flex items-center gap-2">
                    <Sparkles className="w-4 h-4 text-teal-600" />
                    Hackathon Acceptance Test Scenarios (Works Offline Without External API Keys)
                  </h2>
                  <p className="text-xs text-slate-500 mt-0.5">
                    Click any prepared sample below to inspect extraction, verify arithmetic mismatches, edit fields, and export.
                  </p>
                </div>
              </div>

              <div className="grid grid-cols-1 md:grid-cols-3 gap-4">
                <div className="border border-emerald-200 bg-emerald-50/40 rounded-lg p-4 flex flex-col justify-between">
                  <div>
                    <span className="inline-flex items-center gap-1 text-xs font-bold uppercase px-2 py-0.5 rounded bg-emerald-100 text-emerald-800">
                      <CheckCircle2 className="w-3.5 h-3.5" /> Sample 1: VALID INVOICE
                    </span>
                    <h3 className="font-semibold text-slate-900 mt-2 text-sm">BharatCloud Infrastructure (INV-2026-1042)</h3>
                    <p className="text-xs text-slate-600 mt-1">
                      All required fields present. Line items (₹50,000 + ₹14,000 − ₹4,000 discount + 18% GST = ₹70,800.00) pass every check.
                    </p>
                  </div>
                  <button
                    onClick={() => handleSelectSample('SAMPLE-VALID-01')}
                    className="mt-4 w-full inline-flex items-center justify-center gap-1.5 bg-slate-900 hover:bg-slate-800 text-white text-xs font-semibold py-2 px-3 rounded-md transition"
                  >
                    Load Test A (Valid Invoice) <ArrowRight className="w-3.5 h-3.5" />
                  </button>
                </div>

                <div className="border border-rose-200 bg-rose-50/40 rounded-lg p-4 flex flex-col justify-between">
                  <div>
                    <span className="inline-flex items-center gap-1 text-xs font-bold uppercase px-2 py-0.5 rounded bg-rose-100 text-rose-800">
                      <XCircle className="w-3.5 h-3.5" /> Sample 2: INCORRECT TOTAL
                    </span>
                    <h3 className="font-semibold text-slate-900 mt-2 text-sm">Zenith Freight & Logistics (ZFL-2026-889)</h3>
                    <p className="text-xs text-slate-600 mt-1">
                      Deliberate ₹4,000.00 grand total error: Observed Grand Total is ₹52,990.00, while deterministic calculation expects ₹48,990.00.
                    </p>
                  </div>
                  <button
                    onClick={() => handleSelectSample('SAMPLE-BAD-TOTAL-02')}
                    className="mt-4 w-full inline-flex items-center justify-center gap-1.5 bg-rose-700 hover:bg-rose-800 text-white text-xs font-semibold py-2 px-3 rounded-md transition"
                  >
                    Load Test B (Incorrect Total) <ArrowRight className="w-3.5 h-3.5" />
                  </button>
                </div>

                <div className="border border-amber-200 bg-amber-50/40 rounded-lg p-4 flex flex-col justify-between">
                  <div>
                    <span className="inline-flex items-center gap-1 text-xs font-bold uppercase px-2 py-0.5 rounded bg-amber-100 text-amber-800">
                      <AlertTriangle className="w-3.5 h-3.5" /> Sample 3: INCOMPLETE INVOICE
                    </span>
                    <h3 className="font-semibold text-slate-900 mt-2 text-sm">Sri Krishna Industrial Supplies</h3>
                    <p className="text-xs text-slate-600 mt-1">
                      Missing critical `invoiceNumber` (represented explicitly as `null`). Flags rule `REQ-001` FAIL for human completion.
                    </p>
                  </div>
                  <button
                    onClick={() => handleSelectSample('SAMPLE-INCOMPLETE-03')}
                    className="mt-4 w-full inline-flex items-center justify-center gap-1.5 bg-amber-700 hover:bg-amber-800 text-white text-xs font-semibold py-2 px-3 rounded-md transition"
                  >
                    Load Test C (Incomplete Field) <ArrowRight className="w-3.5 h-3.5" />
                  </button>
                </div>
              </div>
            </div>

            {/* Recent Processing Activity */}
            <div className="bg-white rounded-xl border border-slate-200 shadow-2xs overflow-hidden">
              <div className="px-6 py-4 border-b border-slate-200 flex items-center justify-between">
                <h2 className="text-base font-bold text-slate-900">Recent Processing Activity</h2>
                <button
                  onClick={() => setActiveTab('history')}
                  className="text-xs font-semibold text-teal-700 hover:underline"
                >
                  View Full History →
                </button>
              </div>
              <div className="overflow-x-auto">
                <table className="w-full text-left border-collapse text-sm">
                  <thead>
                    <tr className="bg-slate-50 text-slate-600 text-xs uppercase border-b border-slate-200">
                      <th className="py-3 px-4">Document</th>
                      <th className="py-3 px-4">Supplier</th>
                      <th className="py-3 px-4">Invoice No.</th>
                      <th className="py-3 px-4">Grand Total</th>
                      <th className="py-3 px-4">Validation</th>
                      <th className="py-3 px-4">Review Status</th>
                      <th className="py-3 px-4 text-right">Action</th>
                    </tr>
                  </thead>
                  <tbody className="divide-y divide-slate-200">
                    {invoices.map((inv) => {
                      const vals = validateInvoice(inv, invoices);
                      const failCount = vals.filter((v) => v.status === 'FAIL').length;
                      return (
                        <tr key={inv.id} className="hover:bg-slate-50">
                          <td className="py-3 px-4 font-medium text-slate-900">{inv.filename}</td>
                          <td className="py-3 px-4 text-slate-600">{inv.fields.supplierName.value || '—'}</td>
                          <td className="py-3 px-4 font-mono text-xs">
                            {inv.fields.invoiceNumber.value || (
                              <span className="text-rose-600 font-bold">MISSING (null)</span>
                            )}
                          </td>
                          <td className="py-3 px-4 font-mono">
                            ₹{inv.fields.grandTotal.value || '0.00'}
                          </td>
                          <td className="py-3 px-4">
                            {failCount === 0 ? (
                              <span className="inline-flex items-center gap-1 text-xs font-semibold text-emerald-700 bg-emerald-50 border border-emerald-200 px-2 py-0.5 rounded-full">
                                <CheckCircle2 className="w-3.5 h-3.5" /> ALL PASS
                              </span>
                            ) : (
                              <span className="inline-flex items-center gap-1 text-xs font-semibold text-rose-700 bg-rose-50 border border-rose-200 px-2 py-0.5 rounded-full">
                                <XCircle className="w-3.5 h-3.5" /> {failCount} FAIL
                              </span>
                            )}
                          </td>
                          <td className="py-3 px-4">
                            <span
                              className={`text-xs font-semibold px-2.5 py-0.5 rounded-full ${
                                inv.reviewStatus === 'APPROVED'
                                  ? 'bg-emerald-100 text-emerald-800'
                                  : inv.reviewStatus === 'REJECTED'
                                  ? 'bg-rose-100 text-rose-800'
                                  : 'bg-amber-100 text-amber-800'
                              }`}
                            >
                              {inv.reviewStatus}
                            </span>
                          </td>
                          <td className="py-3 px-4 text-right">
                            <button
                              onClick={() => {
                                setSelectedId(inv.id);
                                setActiveTab('review');
                              }}
                              className="text-xs font-semibold text-teal-700 hover:text-teal-900 bg-teal-50 hover:bg-teal-100 px-3 py-1.5 rounded-md transition"
                            >
                              Inspect & Edit
                            </button>
                          </td>
                        </tr>
                      );
                    })}
                  </tbody>
                </table>
              </div>
            </div>
          </div>
        )}

        {/* ================================================================
            VIEW 2: UPLOAD INVOICE PAGE
        ================================================================ */}
        {activeTab === 'upload' && (
          <div className="max-w-2xl mx-auto space-y-6">
            <div>
              <h1 className="text-2xl font-bold text-slate-900">Upload Invoice Document</h1>
              <p className="text-sm text-slate-600 mt-1">
                Digital PDFs are parsed with PyMuPDF (`PDF_TEXT`), while scanned documents and images use Tesseract OCR (`OCR`).
              </p>
            </div>

            <label
              onDragOver={(e) => e.preventDefault()}
              onDrop={(e) => {
                e.preventDefault();
                if (e.dataTransfer.files && e.dataTransfer.files[0]) {
                  handleFileUpload(e.dataTransfer.files[0]);
                }
              }}
              className="border-2 border-dashed border-slate-300 hover:border-teal-600 bg-white rounded-xl p-10 flex flex-col items-center justify-center text-center cursor-pointer transition shadow-2xs"
            >
              <div className="w-14 h-14 rounded-full bg-teal-50 text-teal-600 flex items-center justify-center mb-4">
                <Upload className="w-7 h-7" />
              </div>
              <span className="text-base font-semibold text-slate-900">
                Drag and drop your invoice file here, or click to browse
              </span>
              <span className="text-xs text-slate-500 mt-1">
                Supported formats: PDF, PNG, JPG (Max file size: 15 MB)
              </span>
              <input
                type="file"
                accept=".pdf,.png,.jpg,.jpeg"
                onChange={(e) => handleFileUpload(e.target.files?.[0] || null)}
                className="hidden"
              />
              <span className="mt-5 inline-flex items-center gap-2 bg-slate-900 text-white text-xs font-semibold px-4 py-2 rounded-lg">
                Browse Invoice Files
              </span>
            </label>

            {isProcessing && (
              <div className="bg-teal-50 border border-teal-200 rounded-lg p-4 flex items-center gap-3 text-teal-900 text-sm">
                <RefreshCw className="w-5 h-5 animate-spin text-teal-600 shrink-0" />
                <div>
                  <div className="font-semibold">Running Extraction & Decimal-Safe Validation Pipeline...</div>
                  <div className="text-xs text-teal-700">Extracting structured fields and checking line-item arithmetic.</div>
                </div>
              </div>
            )}

            {uploadError && (
              <div className="bg-rose-50 border border-rose-300 rounded-lg p-4 flex items-start gap-3 text-rose-900 text-sm">
                <XCircle className="w-5 h-5 text-rose-600 shrink-0 mt-0.5" />
                <div>
                  <div className="font-bold">Extraction Refused — Document Error</div>
                  <div className="text-xs text-rose-800 mt-1">{uploadError}</div>
                </div>
              </div>
            )}

            {/* Acceptance Test D Trigger */}
            <div className="bg-white border border-slate-200 rounded-xl p-5 flex items-center justify-between">
              <div>
                <h3 className="text-sm font-bold text-slate-900">Acceptance Test D: Corrupt / Unsupported File Simulation</h3>
                <p className="text-xs text-slate-600 mt-0.5">
                  Verify that corrupt or empty documents trigger a clean error state without crashing the workflow.
                </p>
              </div>
              <button
                onClick={() => handleFileUpload(null, true)}
                className="shrink-0 bg-rose-100 hover:bg-rose-200 text-rose-800 text-xs font-semibold px-3.5 py-2 rounded-lg transition"
              >
                Simulate Corrupt File (Test D)
              </button>
            </div>
          </div>
        )}

        {/* ================================================================
            VIEW 3: TWO-COLUMN INVOICE REVIEW STUDIO
        ================================================================ */}
        {activeTab === 'review' && (
          <div className="space-y-6">
            {/* Top Bar */}
            <div className="bg-white p-4 rounded-xl border border-slate-200 flex flex-wrap items-center justify-between gap-4 shadow-2xs">
              <div>
                <div className="flex items-center gap-2">
                  <span className="text-xs font-mono uppercase px-2 py-0.5 rounded bg-slate-100 text-slate-700 border border-slate-300">
                    Source: {activeInvoice.processingMethod}
                  </span>
                  <span
                    className={`text-xs font-bold px-2.5 py-0.5 rounded-full ${
                      activeInvoice.reviewStatus === 'APPROVED'
                        ? 'bg-emerald-100 text-emerald-800'
                        : activeInvoice.reviewStatus === 'REJECTED'
                        ? 'bg-rose-100 text-rose-800'
                        : 'bg-amber-100 text-amber-800'
                    }`}
                  >
                    STATUS: {activeInvoice.reviewStatus}
                  </span>
                </div>
                <h1 className="text-lg font-bold text-slate-900 mt-1">{activeInvoice.filename}</h1>
                {activeInvoice.overrideReason && (
                  <p className="text-xs text-amber-800 bg-amber-50 border border-amber-200 px-2.5 py-1 rounded mt-1 inline-block">
                    <strong>Auditable Override Note:</strong> {activeInvoice.overrideReason}
                  </p>
                )}
              </div>

              <div className="flex flex-wrap items-center gap-2">
                <button
                  onClick={() => exportCSV(activeInvoice)}
                  className="inline-flex items-center gap-1.5 text-xs font-semibold bg-slate-100 hover:bg-slate-200 text-slate-800 px-3 py-2 rounded-lg border border-slate-300 transition"
                >
                  <FileSpreadsheet className="w-4 h-4 text-teal-700" /> Export CSV
                </button>
                <button
                  onClick={() => exportJSON(activeInvoice)}
                  className="inline-flex items-center gap-1.5 text-xs font-semibold bg-slate-100 hover:bg-slate-200 text-slate-800 px-3 py-2 rounded-lg border border-slate-300 transition"
                >
                  <FileJson className="w-4 h-4 text-teal-700" /> Export JSON
                </button>
                <button
                  onClick={handleReject}
                  className="inline-flex items-center gap-1.5 text-xs font-semibold bg-rose-50 hover:bg-rose-100 text-rose-700 px-3 py-2 rounded-lg border border-rose-200 transition"
                >
                  <X className="w-4 h-4" /> Reject
                </button>
                <button
                  onClick={handleApprove}
                  className="inline-flex items-center gap-1.5 text-xs font-semibold bg-emerald-600 hover:bg-emerald-700 text-white px-4 py-2 rounded-lg shadow-xs transition"
                >
                  <Check className="w-4 h-4" /> Approve Invoice
                </button>
              </div>
            </div>

            {/* Two-Column Split Layout */}
            <div className="grid grid-cols-1 lg:grid-cols-12 gap-6 items-start">
              {/* LEFT COLUMN: Document Preview & Raw Text Evidence (5 Cols) */}
              <div className="lg:col-span-5 space-y-6 lg:sticky lg:top-20">
                <div className="bg-white rounded-xl border border-slate-200 shadow-2xs overflow-hidden">
                  <div className="bg-slate-900 text-white px-4 py-3 flex items-center justify-between text-xs font-semibold">
                    <span className="flex items-center gap-2">
                      <Eye className="w-4 h-4 text-teal-400" /> Document Preview & Source Evidence
                    </span>
                    <span className="text-slate-400">Confidence: Calibrated or Explicit Null</span>
                  </div>

                  {/* Simulated Visual Invoice Sheet */}
                  <div className="p-5 bg-slate-100 border-b border-slate-200">
                    <div className="bg-white border border-slate-300 rounded-lg p-4 shadow-2xs text-xs space-y-3">
                      <div className="flex justify-between items-start border-b border-slate-200 pb-3">
                        <div>
                          <div className="font-bold text-slate-900 text-sm">
                            {activeInvoice.fields.supplierName.value || 'UNKNOWN SUPPLIER'}
                          </div>
                          <div className="text-slate-500">{activeInvoice.fields.supplierAddress.value}</div>
                          <div className="text-slate-600 font-mono mt-0.5">
                            GSTIN: {activeInvoice.fields.supplierTaxId.value || 'N/A'}
                          </div>
                        </div>
                        <div className="text-right">
                          <span className="font-bold text-teal-700 uppercase">TAX INVOICE</span>
                          <div className="font-mono mt-1">
                            No: {activeInvoice.fields.invoiceNumber.value || <span className="text-rose-600 font-bold">MISSING</span>}
                          </div>
                          <div className="text-slate-500">Date: {activeInvoice.fields.invoiceDate.value || 'N/A'}</div>
                        </div>
                      </div>

                      <div className="space-y-1">
                        <div className="font-semibold text-slate-700">Billed To:</div>
                        <div>{activeInvoice.fields.customerName.value || 'N/A'}</div>
                      </div>

                      <table className="w-full text-left border-t border-b border-slate-200 py-2">
                        <thead>
                          <tr className="text-slate-500 border-b border-slate-200">
                            <th className="py-1">Item</th>
                            <th className="py-1 text-right">Qty</th>
                            <th className="py-1 text-right">Price</th>
                            <th className="py-1 text-right">Total</th>
                          </tr>
                        </thead>
                        <tbody>
                          {activeInvoice.lineItems.map((li) => (
                            <tr key={li.id} className="border-b border-slate-100">
                              <td className="py-1">{li.description}</td>
                              <td className="py-1 text-right font-mono">{li.quantity}</td>
                              <td className="py-1 text-right font-mono">{li.unitPrice}</td>
                              <td className="py-1 text-right font-mono">{li.lineTotal}</td>
                            </tr>
                          ))}
                        </tbody>
                      </table>

                      <div className="flex justify-end">
                        <div className="w-48 space-y-1 text-right font-mono">
                          <div className="flex justify-between">
                            <span className="text-slate-500">Subtotal:</span>
                            <span>₹{activeInvoice.fields.subtotal.value || '0.00'}</span>
                          </div>
                          <div className="flex justify-between">
                            <span className="text-slate-500">Discount:</span>
                            <span>-₹{activeInvoice.fields.discount.value || '0.00'}</span>
                          </div>
                          <div className="flex justify-between">
                            <span className="text-slate-500">Tax ({activeInvoice.fields.taxRate.value || '0'}%):</span>
                            <span>₹{activeInvoice.fields.taxAmount.value || '0.00'}</span>
                          </div>
                          <div className="flex justify-between font-bold text-slate-900 border-t border-slate-300 pt-1">
                            <span>Grand Total:</span>
                            <span>₹{activeInvoice.fields.grandTotal.value || '0.00'}</span>
                          </div>
                        </div>
                      </div>
                    </div>
                  </div>

                  {/* Raw Extracted Text Stream */}
                  <div className="p-4">
                    <div className="text-xs font-bold uppercase text-slate-500 mb-2 flex items-center gap-1.5">
                      <Terminal className="w-3.5 h-3.5" /> Raw Extracted Text Evidence
                    </div>
                    <pre className="bg-slate-950 text-slate-200 p-3 rounded-lg text-xs font-mono overflow-x-auto whitespace-pre-wrap leading-relaxed">
                      {activeInvoice.rawText}
                    </pre>
                  </div>
                </div>
              </div>

              {/* RIGHT COLUMN: Editable Fields, Line Items, and Validation Engine Results (7 Cols) */}
              <div className="lg:col-span-7 space-y-6">
                {/* Validation Results Panel */}
                <div className="bg-white rounded-xl border border-slate-200 shadow-2xs overflow-hidden">
                  <div className="px-5 py-4 border-b border-slate-200 flex items-center justify-between bg-slate-50">
                    <div>
                      <h2 className="text-sm font-bold text-slate-900">
                        Deterministic Validation Engine Results (Tolerance: ±₹0.01)
                      </h2>
                      <p className="text-xs text-slate-500">
                        Automatically recalculates whenever you edit any field or line item below.
                      </p>
                      {activeValidations.some((v) => v.status === 'FAIL' && /^(ARITH-(LI-\d+|SUB|TAX|GRAND))$/.test(v.ruleId)) && (
                        <button
                          type="button"
                          onClick={handleRecalculateAmounts}
                          className="mt-2 inline-flex items-center gap-1.5 rounded-md border border-teal-300 bg-teal-50 px-2.5 py-1.5 text-xs font-semibold text-teal-800 hover:bg-teal-100 transition"
                          title="Recalculate line totals, subtotal, tax, and grand total from the current quantities, unit prices, discount, tax rate, and shipping"
                        >
                          <RefreshCw className="h-3.5 w-3.5" /> Recalculate Tax & Totals
                        </button>
                      )}
                    </div>
                    <div className="flex items-center gap-2 text-xs font-bold">
                      <button
                        type="button"
                        aria-pressed={validationFilter === 'ALL'}
                        onClick={() => setValidationFilter('ALL')}
                        title="Show all validation checks"
                        className={`px-2 py-1 rounded transition ${validationFilter === 'ALL' ? 'bg-emerald-200 text-emerald-900 ring-2 ring-emerald-400' : 'bg-emerald-100 text-emerald-800 hover:bg-emerald-200'}`}
                      >
                        {activeValidations.filter((v) => v.status === 'PASS').length} PASS
                      </button>
                      <button
                        type="button"
                        aria-pressed={validationFilter === 'FAIL'}
                        onClick={() => setValidationFilter((current) => current === 'FAIL' ? 'ALL' : 'FAIL')}
                        title={validationFilter === 'FAIL' ? 'Show all validation checks' : 'Show only failed validation checks'}
                        className={`px-2 py-1 rounded transition ${validationFilter === 'FAIL' ? 'bg-rose-200 text-rose-900 ring-2 ring-rose-400' : 'bg-rose-100 text-rose-800 hover:bg-rose-200'}`}
                      >
                        {activeValidations.filter((v) => v.status === 'FAIL').length} FAIL
                      </button>
                    </div>
                  </div>

                  <div className="divide-y divide-slate-200 max-h-80 overflow-y-auto">
                    {validationFilter === 'FAIL' && visibleValidations.length === 0 ? (
                      <div className="p-6 text-center text-sm text-emerald-700">
                        No failed validation checks. <button type="button" className="underline font-semibold" onClick={() => setValidationFilter('ALL')}>Show all checks</button>
                      </div>
                    ) : visibleValidations.map((v) => (
                      <div
                        key={v.ruleId}
                        role={v.status === 'PASS' ? undefined : 'button'}
                        tabIndex={v.status === 'PASS' ? undefined : 0}
                        title={v.status === 'PASS' ? undefined : 'Click to jump to the field that needs review'}
                        onClick={() => handleValidationClick(v)}
                        onKeyDown={(e) => { if (v.status !== 'PASS' && (e.key === 'Enter' || e.key === ' ')) { e.preventDefault(); handleValidationClick(v); } }}
                        className={`p-3.5 flex items-start justify-between gap-4 text-xs ${v.status === 'PASS' ? '' : 'cursor-pointer hover:bg-rose-50 focus:outline-none focus:ring-2 focus:ring-inset focus:ring-rose-400'}`}
                      >
                        <div className="flex items-start gap-2.5">
                          {v.status === 'PASS' && <CheckCircle2 className="w-4 h-4 text-emerald-600 shrink-0 mt-0.5" />}
                          {v.status === 'FAIL' && <XCircle className="w-4 h-4 text-rose-600 shrink-0 mt-0.5" />}
                          {v.status === 'WARNING' && <AlertTriangle className="w-4 h-4 text-amber-600 shrink-0 mt-0.5" />}
                          {v.status === 'NOT_VERIFIABLE' && <HelpCircle className="w-4 h-4 text-slate-400 shrink-0 mt-0.5" />}
                          <div>
                            <div className="flex items-center gap-2">
                              <span className="font-mono font-bold text-slate-800">{v.ruleId}</span>
                              <span
                                className={`font-bold px-1.5 py-0.2 rounded text-[10px] ${
                                  v.status === 'PASS'
                                    ? 'bg-emerald-100 text-emerald-800'
                                    : v.status === 'FAIL'
                                    ? 'bg-rose-100 text-rose-800'
                                    : v.status === 'WARNING'
                                    ? 'bg-amber-100 text-amber-800'
                                    : 'bg-slate-100 text-slate-600'
                                }`}
                              >
                                {v.status}
                              </span>
                              <span className="text-slate-400 font-mono">[{v.fields.join(', ')}]</span>
                            </div>
                            <p className="text-slate-700 mt-1">{v.explanation}</p>
                          </div>
                        </div>

                        {(v.expected || v.observed) && (
                          <div className="text-right font-mono shrink-0 bg-slate-50 px-2.5 py-1.5 rounded border border-slate-200">
                            {v.expected && <div className="text-slate-500">Exp: {v.expected}</div>}
                            {v.observed && (
                              <div className={v.status === 'FAIL' ? 'text-rose-700 font-bold' : 'text-slate-800'}>
                                Obs: {v.observed}
                              </div>
                            )}
                          </div>
                        )}
                      </div>
                    ))}
                  </div>
                </div>

                {/* Editable Invoice Metadata & Totals */}
                <div className="bg-white rounded-xl border border-slate-200 shadow-2xs p-5 space-y-5">
                  <div className="flex items-center justify-between border-b border-slate-200 pb-3">
                    <h2 className="text-sm font-bold text-slate-900">Extracted Invoice Fields (Human-in-the-Loop Review)</h2>
                    <span className="text-xs text-slate-500">Edited fields are tagged USER_EDITED</span>
                  </div>

                  <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
                    {(
                      [
                        { key: 'invoiceNumber', label: 'Invoice Number *' },
                        { key: 'invoiceDate', label: 'Invoice Date (YYYY-MM-DD) *' },
                        { key: 'dueDate', label: 'Due Date (YYYY-MM-DD)' },
                        { key: 'currency', label: 'Currency' },
                        { key: 'supplierName', label: 'Supplier Name *' },
                        { key: 'supplierTaxId', label: 'Supplier GSTIN / Tax ID' },
                        { key: 'supplierAddress', label: 'Supplier Address' },
                        { key: 'customerName', label: 'Customer Name' },
                        { key: 'customerTaxId', label: 'Customer GSTIN / Tax ID' },
                        { key: 'subtotal', label: 'Subtotal' },
                        { key: 'discount', label: 'Discount' },
                        { key: 'taxRate', label: 'Tax Rate (%)' },
                        { key: 'taxAmount', label: 'Tax Amount' },
                        { key: 'shipping', label: 'Shipping / Additional' },
                        { key: 'grandTotal', label: 'Grand Total *' },
                      ] as Array<{ key: keyof InvoiceRecord['fields']; label: string }>
                    ).map(({ key, label }) => {
                      const fieldObj = activeInvoice.fields[key];
                      const isMissing = fieldObj.value === null || fieldObj.value === '';
                      return (
                        <div key={key} className="space-y-1">
                          <div className="flex items-center justify-between text-xs">
                            <label className="font-semibold text-slate-700">{label}</label>
                            <div className="flex items-center gap-1">
                              {fieldObj.manuallyEdited && (
                                <span className="text-[10px] font-bold bg-teal-100 text-teal-800 px-1.5 py-0.5 rounded">
                                  USER_EDITED
                                </span>
                              )}
                              {isMissing && (
                                <span className="text-[10px] font-bold bg-rose-100 text-rose-800 px-1.5 py-0.5 rounded">
                                  MISSING (null)
                                </span>
                              )}
                            </div>
                          </div>
                          <input
                            type="text"
                            data-invoice-field={String(key)}
                            value={fieldObj.value ?? ''}
                            placeholder="null (Missing — enter value to fix)"
                            onChange={(e) => handleFieldChange(key, e.target.value)}
                            className={`w-full px-3 py-1.5 text-sm rounded-lg border font-mono transition ${
                              isMissing
                                ? 'border-rose-400 bg-rose-50/40 focus:border-rose-600'
                                : fieldObj.manuallyEdited
                                ? 'border-teal-500 bg-teal-50/20'
                                : 'border-slate-300 bg-white focus:border-teal-600'
                            } focus:outline-hidden`}
                          />
                        </div>
                      );
                    })}
                  </div>
                </div>

                {/* Editable Line Items Table */}
                <div className="bg-white rounded-xl border border-slate-200 shadow-2xs p-5 space-y-4">
                  <div className="flex items-center justify-between">
                    <h2 className="text-sm font-bold text-slate-900">Line Items</h2>
                    <button
                      onClick={handleAddLineItem}
                      className="inline-flex items-center gap-1 text-xs font-semibold text-teal-700 bg-teal-50 hover:bg-teal-100 px-2.5 py-1.5 rounded-md transition"
                    >
                      <Plus className="w-3.5 h-3.5" /> Add Line Item
                    </button>
                  </div>

                  <div className="overflow-x-auto">
                    <table className="w-full text-left border-collapse text-xs">
                      <thead>
                        <tr className="border-b border-slate-200 text-slate-500 uppercase">
                          <th className="py-2 pr-2">Description</th>
                          <th className="py-2 px-2 w-20">Qty</th>
                          <th className="py-2 px-2 w-28">Unit Price</th>
                          <th className="py-2 px-2 w-28">Line Total</th>
                          <th className="py-2 pl-2 w-10"></th>
                        </tr>
                      </thead>
                      <tbody className="divide-y divide-slate-200">
                        {activeInvoice.lineItems.map((item) => (
                          <tr key={item.id}>
                            <td className="py-2 pr-2">
                              <input
                                type="text"
                                value={item.description}
                                onChange={(e) => handleLineItemChange(item.id, 'description', e.target.value)}
                                className="w-full px-2 py-1 border border-slate-300 rounded"
                              />
                            </td>
                            <td className="py-2 px-2">
                              <input
                                type="text"
                                value={item.quantity}
                                onChange={(e) => handleLineItemChange(item.id, 'quantity', e.target.value)}
                                className="w-full px-2 py-1 border border-slate-300 rounded font-mono"
                              />
                            </td>
                            <td className="py-2 px-2">
                              <input
                                type="text"
                                value={item.unitPrice}
                                onChange={(e) => handleLineItemChange(item.id, 'unitPrice', e.target.value)}
                                className="w-full px-2 py-1 border border-slate-300 rounded font-mono"
                              />
                            </td>
                            <td className="py-2 px-2">
                              <input
                                type="text"
                                data-line-field="lineTotal"
                                value={item.lineTotal}
                                onChange={(e) => handleLineItemChange(item.id, 'lineTotal', e.target.value)}
                                className="w-full px-2 py-1 border border-slate-300 rounded font-mono"
                              />
                            </td>
                            <td className="py-2 pl-2 text-right">
                              <button
                                onClick={() => handleDeleteLineItem(item.id)}
                                className="text-slate-400 hover:text-rose-600 p-1"
                              >
                                <Trash2 className="w-4 h-4" />
                              </button>
                            </td>
                          </tr>
                        ))}
                      </tbody>
                    </table>
                  </div>
                </div>
              </div>
            </div>
          </div>
        )}

        {/* ================================================================
            VIEW 4: SEARCHABLE DOCUMENT HISTORY
        ================================================================ */}
        {activeTab === 'history' && (
          <div className="space-y-6">
            <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-4">
              <div>
                <h1 className="text-2xl font-bold text-slate-900">Processed Document History</h1>
                <p className="text-sm text-slate-600">Search and reopen any processed invoice record.</p>
              </div>
              <div className="relative w-full sm:w-72">
                <Search className="w-4 h-4 text-slate-400 absolute left-3 top-2.5" />
                <input
                  type="text"
                  value={searchQuery}
                  onChange={(e) => setSearchQuery(e.target.value)}
                  placeholder="Search filename, supplier, invoice #..."
                  className="w-full pl-9 pr-3 py-2 text-sm bg-white border border-slate-300 rounded-lg focus:outline-hidden focus:border-teal-600"
                />
              </div>
            </div>

            <div className="bg-white rounded-xl border border-slate-200 shadow-2xs overflow-hidden">
              <table className="w-full text-left border-collapse text-sm">
                <thead>
                  <tr className="bg-slate-50 text-slate-600 text-xs uppercase border-b border-slate-200">
                    <th className="py-3 px-4">Filename</th>
                    <th className="py-3 px-4">Supplier</th>
                    <th className="py-3 px-4">Invoice #</th>
                    <th className="py-3 px-4">Total</th>
                    <th className="py-3 px-4">Source</th>
                    <th className="py-3 px-4">Review Status</th>
                    <th className="py-3 px-4">Date</th>
                    <th className="py-3 px-4 text-right">Actions</th>
                  </tr>
                </thead>
                <tbody className="divide-y divide-slate-200">
                  {invoices
                    .filter((inv) => {
                      const q = searchQuery.toLowerCase();
                      return (
                        inv.filename.toLowerCase().includes(q) ||
                        (inv.fields.supplierName.value || '').toLowerCase().includes(q) ||
                        (inv.fields.invoiceNumber.value || '').toLowerCase().includes(q)
                      );
                    })
                    .map((inv) => (
                      <tr key={inv.id} className="hover:bg-slate-50">
                        <td className="py-3 px-4 font-medium">{inv.filename}</td>
                        <td className="py-3 px-4 text-slate-600">{inv.fields.supplierName.value || '—'}</td>
                        <td className="py-3 px-4 font-mono text-xs">{inv.fields.invoiceNumber.value || 'MISSING'}</td>
                        <td className="py-3 px-4 font-mono">₹{inv.fields.grandTotal.value || '0.00'}</td>
                        <td className="py-3 px-4 font-mono text-xs">{inv.processingMethod}</td>
                        <td className="py-3 px-4">
                          <span
                            className={`text-xs font-semibold px-2 py-0.5 rounded-full ${
                              inv.reviewStatus === 'APPROVED'
                                ? 'bg-emerald-100 text-emerald-800'
                                : inv.reviewStatus === 'REJECTED'
                                ? 'bg-rose-100 text-rose-800'
                                : 'bg-amber-100 text-amber-800'
                            }`}
                          >
                            {inv.reviewStatus}
                          </span>
                        </td>
                        <td className="py-3 px-4 text-xs text-slate-500">{inv.uploadDate}</td>
                        <td className="py-3 px-4 text-right space-x-2">
                          <button
                            onClick={() => {
                              setSelectedId(inv.id);
                              setActiveTab('review');
                            }}
                            className="text-xs font-semibold text-teal-700 hover:underline"
                          >
                            Reopen
                          </button>
                          <button
                            onClick={() => exportCSV(inv)}
                            className="text-xs font-semibold text-slate-600 hover:underline"
                          >
                            CSV
                          </button>
                        </td>
                      </tr>
                    ))}
                </tbody>
              </table>
            </div>
          </div>
        )}
      </main>

      {/* Auditable Override Modal for Invoices with Critical Failures */}
      {overrideModalOpen && (
        <div className="fixed inset-0 z-50 bg-slate-950/60 flex items-center justify-center p-4">
          <div className="bg-white rounded-xl max-w-md w-full p-6 space-y-4 border border-slate-200 shadow-xl">
            <div className="flex items-center gap-2 text-rose-700 font-bold text-base">
              <ShieldAlert className="w-5 h-5" /> Critical Validation Failures Detected
            </div>
            <p className="text-xs text-slate-600 leading-relaxed">
              This invoice currently has <strong>FAIL</strong> validation checks. Per audit policy, you should either fix the values in the Review Studio first, or provide an explicit auditable override justification below.
            </p>
            <div>
              <label className="block text-xs font-semibold text-slate-700 mb-1">
                Mandatory Audit Override Justification (min 5 chars):
              </label>
              <textarea
                rows={3}
                value={overrideReasonInput}
                onChange={(e) => setOverrideReasonInput(e.target.value)}
                placeholder="e.g., Confirmed ₹4,000 emergency detention surcharge via supplier email."
                className="w-full p-2.5 text-xs border border-slate-300 rounded-lg focus:outline-hidden focus:border-teal-600"
              />
            </div>
            <div className="flex justify-end gap-2 pt-2">
              <button
                onClick={() => setOverrideModalOpen(false)}
                className="px-3 py-1.5 text-xs font-semibold text-slate-600 hover:bg-slate-100 rounded-lg"
              >
                Cancel & Fix Fields
              </button>
              <button
                disabled={overrideReasonInput.trim().length < 5}
                onClick={handleConfirmOverride}
                className="px-4 py-1.5 text-xs font-semibold bg-rose-700 disabled:bg-slate-300 text-white rounded-lg"
              >
                Confirm Auditable Override
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}