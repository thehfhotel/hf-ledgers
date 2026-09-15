import { useEffect, useMemo, useRef, useState } from "react";
import { EngineUnreachableError, SessionExpiredError, createExpense, getMonthExpenses, uploadExpensePhoto } from "../api.ts";
import { EditDrawer } from "../components/EditDrawer.tsx";
import { RowOrigin } from "../components/RowOrigin.tsx";
import { navigate } from "../App.tsx";
import { categoryByCode, isBillingMonthCategory, type ExpenseCategoryCode } from "../../shared/categories.ts";
import { CategoryPicker } from "../components/CategoryPicker.tsx";
import { currentMonthBangkok, isoToThaiLong, todayBangkok } from "@shared/date.ts";
import { formatSatang, parseAmountToSatang } from "@shared/money.ts";
import { AMOUNT_IN_TEXT_WARNING_TH, looksLikeAmountInText } from "@shared/textAmount.ts";
import type { ExpenseInput, ExpenseTransaction, PaymentMethod } from "../../shared/types.ts";
import { expenseOrigin } from "../../shared/expenseOrigin.ts";
import {
  AMOUNT_ARIA_LABEL,
  AMOUNT_PLACEHOLDER,
  DAY_STRIP,
  ENGINE_ERROR,
  FIELD_LABELS,
  ITEM_PLACEHOLDER_BILLING_MONTH,
  ITEM_PLACEHOLDER_DEFAULT,
  LOADING,
  PAYMENT_METHOD_LABELS,
  PHOTO,
  SAVE,
  VALIDATION,
} from "../labels.ts";
import {
  clearDraft,
  loadDraft,
  loadPaymentMethod,
  loadRecentCategories,
  pushRecentCategory,
  saveDraft,
  savePaymentMethod,
  type DraftState,
} from "../storage.ts";

interface Props {
  /** Deep link from the month checklist (/entry?cat=<code>) — the ONE case
   * where a category is allowed to arrive pre-selected (frontend spec
   * §2.3): the clerk explicitly chose that line. */
  initialCategoryCode?: ExpenseCategoryCode;
}

interface FieldErrors {
  amount?: string;
  category?: string;
  date?: string;
}

const HIGHLIGHT_MS = 300;

/** Screen 1 — บันทึกรายจ่าย (frontend spec §2). Batch entry of a stack of
 * bills: keyboard-first, six fields on one screen, no wizard. */
export function EntryPage({ initialCategoryCode }: Props) {
  const draft = useMemo(() => loadDraft(), []);

  const [date, setDate] = useState(draft?.date ?? todayBangkok());
  const [amountText, setAmountText] = useState(draft?.amountText ?? "");
  const [categoryCode, setCategoryCode] = useState<ExpenseCategoryCode | null>(
    initialCategoryCode ?? draft?.categoryCode ?? null,
  );
  const [paymentMethod, setPaymentMethod] = useState<PaymentMethod>(draft?.paymentMethod ?? loadPaymentMethod());
  const [comment, setComment] = useState(draft?.comment ?? "");
  const [stagedPhotos, setStagedPhotos] = useState<File[]>([]);

  const [recentCodes, setRecentCodes] = useState<ExpenseCategoryCode[]>(() => loadRecentCategories());
  const [errors, setErrors] = useState<FieldErrors>({});
  const [saving, setSaving] = useState(false);
  const [engineError, setEngineError] = useState(false);

  const [monthEntries, setMonthEntries] = useState<ExpenseTransaction[]>([]);
  const [dateOpen, setDateOpen] = useState(false);
  const [dayEntries, setDayEntries] = useState<ExpenseTransaction[] | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [highlightId, setHighlightId] = useState<string | null>(null);
  const [photoFailures, setPhotoFailures] = useState<Record<string, File[]>>({});
  const [editingItem, setEditingItem] = useState<ExpenseTransaction | null>(null);

  const dateInputRef = useRef<HTMLInputElement>(null);
  const amountInputRef = useRef<HTMLInputElement>(null);
  const fileInputRef = useRef<HTMLInputElement>(null);

  // Mirror every change to localStorage so an engine-unreachable or
  // session-expired reload never loses in-progress work (frontend spec §6
  // "Draft preservation").
  useEffect(() => {
    const state: DraftState = { date, amountText, categoryCode, paymentMethod, comment };
    saveDraft(state);
  }, [date, amountText, categoryCode, paymentMethod, comment]);

  // วันที่: uncontrolled + commit-on-native-change (DateBar.tsx's fix —
  // never React's onChange, or a two-digit day loses its second keystroke).
  useEffect(() => {
    const el = dateInputRef.current;
    if (!el) return;
    const commit = () => {
      if (el.value && el.value !== date) setDate(el.value);
    };
    el.addEventListener("change", commit);
    return () => el.removeEventListener("change", commit);
  }, [date]);

  // Ctrl+Enter saves from anywhere in the form.
  useEffect(() => {
    function onKeyDown(e: KeyboardEvent) {
      if (e.ctrlKey && e.key === "Enter") {
        e.preventDefault();
        void handleSave();
      }
    }
    document.addEventListener("keydown", onKeyDown);
    return () => document.removeEventListener("keydown", onKeyDown);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  });

  // Desktop paste (Ctrl+V) of a scanned invoice image, anywhere on the page
  // while this screen is open (frontend spec §2.6).
  useEffect(() => {
    function onPaste(e: ClipboardEvent) {
      const items = e.clipboardData?.items;
      if (!items) return;
      const files: File[] = [];
      for (const item of items) {
        if (item.type.startsWith("image/")) {
          const file = item.getAsFile();
          if (file) files.push(file);
        }
      }
      if (files.length > 0) setStagedPhotos((prev) => [...prev, ...files]);
    }
    document.addEventListener("paste", onPaste);
    return () => document.removeEventListener("paste", onPaste);
  }, []);

  async function loadDayStrip(forDate: string) {
    try {
      const month = forDate.slice(0, 7);
      const res = await getMonthExpenses(month);
      setMonthEntries(res.items);
      setDayEntries(res.items.filter((item) => item.date === forDate));
      setLoadError(null);
    } catch (err) {
      if (err instanceof SessionExpiredError) return;
      setDayEntries([]);
      setLoadError(err instanceof Error ? err.message : String(err));
    }
  }

  useEffect(() => {
    setDayEntries(null);
    void loadDayStrip(date);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [date]);

  function validate(): FieldErrors | null {
    const next: FieldErrors = {};
    const parsedAmount = parseAmountToSatang(amountText);
    if (amountText.trim() === "") next.amount = VALIDATION.amountRequired;
    else if (parsedAmount === null || parsedAmount <= 0) next.amount = VALIDATION.amountInvalid;
    if (!categoryCode) next.category = VALIDATION.categoryRequired;
    if (date > todayBangkok()) next.date = VALIDATION.dateNotFuture;
    return Object.keys(next).length > 0 ? next : null;
  }

  function buildInput(): ExpenseInput {
    return {
      date,
      amountSatang: parseAmountToSatang(amountText)!,
      categoryCode: categoryCode!,
      paymentMethod,
      comment,
    };
  }

  async function handleSave() {
    const validationErrors = validate();
    if (validationErrors) {
      setErrors(validationErrors);
      if (validationErrors.amount) amountInputRef.current?.focus();
      else if (validationErrors.date) dateInputRef.current?.focus();
      return;
    }
    setErrors({});
    setEngineError(false);
    setSaving(true);

    const input = buildInput();
    try {
      const { id } = await createExpense(input);

      // Photo attach-after-save (frontend spec §2.6): the entry is durable
      // the moment createExpense resolves; a photo failure never undoes it.
      const failures: File[] = [];
      for (const file of stagedPhotos) {
        try {
          await uploadExpensePhoto(id, file, file.name);
        } catch (err) {
          if (err instanceof SessionExpiredError) break;
          failures.push(file);
        }
      }
      if (failures.length > 0) setPhotoFailures((prev) => ({ ...prev, [id]: failures }));

      clearDraft();
      setRecentCodes(pushRecentCategory(input.categoryCode));
      savePaymentMethod(paymentMethod);

      // Reset per §2.7: keep วันที่ and จ่ายด้วย, clear everything else.
      setAmountText("");
      setCategoryCode(null);
      setComment("");
      setStagedPhotos([]);
      amountInputRef.current?.focus();

      setHighlightId(id);
      setTimeout(() => setHighlightId((current) => (current === id ? null : current)), HIGHLIGHT_MS);
      await loadDayStrip(date);
    } catch (err) {
      if (err instanceof SessionExpiredError) {
        // handled globally — form stays intact, nothing else to do here.
      } else if (err instanceof EngineUnreachableError) {
        setEngineError(true);
      } else {
        setEngineError(true);
      }
    } finally {
      setSaving(false);
    }
  }

  async function retryPhoto(id: string) {
    const files = photoFailures[id];
    if (!files || files.length === 0) return;
    const stillFailing: File[] = [];
    for (const file of files) {
      try {
        await uploadExpensePhoto(id, file, file.name);
      } catch (err) {
        if (err instanceof SessionExpiredError) return;
        stillFailing.push(file);
      }
    }
    setPhotoFailures((prev) => {
      const next = { ...prev };
      if (stillFailing.length > 0) next[id] = stillFailing;
      else delete next[id];
      return next;
    });
    await loadDayStrip(date);
  }

  function addFiles(files: FileList | File[] | null) {
    if (!files) return;
    const list = Array.from(files);
    if (list.length > 0) setStagedPhotos((prev) => [...prev, ...list]);
  }

  const itemPlaceholder =
    categoryCode && isBillingMonthCategory(categoryCode) ? ITEM_PLACEHOLDER_BILLING_MONTH : ITEM_PLACEHOLDER_DEFAULT;

  const lastSimilar = monthEntries.find(r => r.categoryCode === categoryCode && expenseOrigin(r) === 'manual');

  return (
    <div className="mx-auto flex max-w-5xl flex-col gap-6">
      <header>
        <p className="text-sm font-semibold text-brand-700">เพิ่มบิลของโรงแรม</p>
        <h1 className="mt-1 text-2xl font-bold text-ink">บิลนี้จ่ายเงินแล้วหรือยัง?</h1>
        <div className="mt-4 grid grid-cols-2 gap-3">
          <div className="rounded-xl border-2 border-brand-500 bg-brand-50 p-4">
            <strong className="block text-base text-brand-700">จ่ายแล้ว</strong>
            <span className="mt-1 block text-sm text-ink-muted">บันทึกเงินที่จ่ายออกไป</span>
          </div>
          <button type="button" onClick={() => navigate('/ap?new=1')} className="rounded-xl border border-line-strong bg-panel p-4 text-left hover:bg-tint">
            <strong className="block text-base text-ink">ยังไม่จ่าย</strong>
            <span className="mt-1 block text-sm text-ink-muted">เก็บบิลไว้ในรายการค้างจ่าย</span>
          </button>
        </div>
        <p className="mt-3 text-sm text-ink-muted">ใบเสร็จจากระบบเบิกจ่ายและรายการเงินเดือนเข้ามาเอง ไม่ต้องกรอกซ้ำ</p>
      </header>

      <section className="overflow-hidden rounded-2xl border border-line bg-panel shadow-sm">
        <div className="grid gap-6 p-5 sm:p-6 lg:grid-cols-2 lg:gap-8">
          <div>
            <label htmlFor="entry-amount" className="mb-2 block text-base font-semibold text-ink">จ่ายไปเท่าไร</label>
            <div className="relative">
              <span className="absolute left-4 top-1/2 -translate-y-1/2 text-xl text-ink-muted">฿</span>
              <input ref={amountInputRef} id="entry-amount" inputMode="decimal" value={amountText}
                onChange={e => setAmountText(e.target.value)} placeholder="0.00" aria-label={AMOUNT_ARIA_LABEL} autoFocus
                className="h-20 w-full rounded-xl border border-line-strong bg-tint pl-10 pr-4 text-right text-3xl font-bold tabular-nums text-ink focus:outline-none focus:ring-2 focus:ring-brand-500/40" />
            </div>
            {errors.amount && <p className="mt-2 text-sm text-bad">{errors.amount}</p>}
          </div>
          <div>
            <label className="mb-2 block text-base font-semibold text-ink">เป็นค่าอะไร</label>
            <CategoryPicker value={categoryCode} onChange={code => {
              setCategoryCode(code);
              const previous = monthEntries.find(r => r.categoryCode === code && expenseOrigin(r) === 'manual');
              if (previous) setPaymentMethod(previous.paymentMethod);
            }} recentCodes={recentCodes} />
            {errors.category && <p className="mt-2 text-sm text-bad">{errors.category}</p>}
            {lastSimilar && <button type="button" onClick={() => {
              setAmountText((lastSimilar.amountSatang / 100).toFixed(2)); setComment(lastSimilar.comment); setPaymentMethod(lastSimilar.paymentMethod);
            }} className="mt-3 w-full rounded-lg bg-tint p-3 text-left text-sm text-ink">
              <span className="block font-medium">ใช้ข้อมูลรายการล่าสุด · ฿{formatSatang(lastSimilar.amountSatang)}</span>
              <span className="mt-1 block text-xs text-ink-muted">{lastSimilar.comment || 'คัดลอกยอดและวิธีจ่าย แล้วตรวจสอบก่อนบันทึก'}</span>
            </button>}
          </div>
          <div>
            <label className="mb-2 block text-sm font-semibold text-ink">จ่ายจาก</label>
            <div role="radiogroup" aria-label={FIELD_LABELS.paymentMethod} className="grid grid-cols-2 gap-2">
              {(['cash', 'bank'] as const).map(m => <button key={m} type="button" role="radio" aria-checked={paymentMethod === m}
                onClick={() => { setPaymentMethod(m); savePaymentMethod(m); }}
                className={'min-h-12 rounded-lg border px-4 text-base font-medium ' + (paymentMethod === m ? 'border-brand-500 bg-brand-50 text-brand-700' : 'border-line-strong text-ink hover:bg-tint')}>
                {m === 'cash' ? 'เงินสด' : 'โอนผ่านธนาคาร'}
              </button>)}
            </div>
            <p className="mt-2 text-xs text-ink-muted">เลือกไว้ให้จากข้อมูลเดิม เปลี่ยนได้ตามบิลนี้</p>
          </div>
          <div>
            <span className="mb-2 block text-sm font-semibold text-ink">วันที่จ่าย</span>
            <div className="flex min-h-12 flex-wrap items-center justify-between gap-2 rounded-lg bg-tint px-3 py-2">
              <span className="text-sm text-ink">{date === todayBangkok() ? 'วันนี้ · ' : ''}{isoToThaiLong(date)}</span>
              <button type="button" aria-expanded={dateOpen} onClick={() => setDateOpen(!dateOpen)} className="min-h-10 px-2 text-sm font-semibold text-brand-700">เปลี่ยนวันที่</button>
            </div>
            <div hidden={!dateOpen && !errors.date} className="mt-2">
              <input ref={dateInputRef} id="entry-date" key={date} type="date" defaultValue={date} aria-label="วันที่จ่าย"
                min={`${currentMonthBangkok()}-01`} max={todayBangkok()} className="h-12 rounded-lg border border-line-strong px-3 text-base text-ink" />
            </div>
            {errors.date && <p className="mt-2 text-sm text-bad">{errors.date}</p>}
          </div>
          <div>
            <label htmlFor="entry-comment" className="mb-2 block text-sm font-semibold text-ink">รายละเอียดสั้น ๆ <span className="font-normal text-ink-muted">(ถ้ามี)</span></label>
            <input id="entry-comment" value={comment} onChange={e => setComment(e.target.value)} maxLength={200} placeholder={itemPlaceholder}
              className="h-12 w-full rounded-lg border border-line-strong px-3 text-base text-ink focus:outline-none focus:ring-2 focus:ring-brand-500/40" />
            {looksLikeAmountInText(comment) && <p className="mt-2 text-sm text-warn">{AMOUNT_IN_TEXT_WARNING_TH}</p>}
          </div>
          <div onDragOver={e => e.preventDefault()} onDrop={e => { e.preventDefault(); addFiles(Array.from(e.dataTransfer.files).filter(f => f.type.startsWith('image/'))); }}>
            <span className="mb-2 block text-sm font-semibold text-ink">รูปใบเสร็จ <span className="font-normal text-ink-muted">(เพิ่มภายหลังได้)</span></span>
            <input ref={fileInputRef} type="file" accept="image/*" capture="environment" multiple className="hidden" onChange={e => { addFiles(e.target.files); e.target.value=''; }} />
            <button type="button" onClick={() => fileInputRef.current?.click()} className="min-h-12 w-full rounded-lg border border-dashed border-line-strong px-4 text-sm font-medium text-brand-700">{stagedPhotos.length ? `แนบแล้ว ${stagedPhotos.length} รูป · เพิ่มรูป` : 'ถ่ายรูป หรือเลือกรูปใบเสร็จ'}</button>
            {stagedPhotos.length > 0 && <div className="mt-2 flex flex-wrap gap-2">{stagedPhotos.map((f,i) => <div key={i} className="rounded border border-line p-2 text-xs"><span>{f.name}</span><button type="button" onClick={() => setStagedPhotos(prev => prev.filter((_,j) => i!==j))} className="ml-2 text-bad">เอาออก</button></div>)}</div>}
          </div>
        </div>
        <footer className="sticky bottom-0 flex flex-wrap items-center justify-between gap-4 border-t border-line bg-tint p-5 sm:p-6">
          <div><span className="block text-sm text-ink-muted">ยอดที่จะบันทึก</span><strong className="text-2xl tabular-nums text-ink">฿{formatSatang(parseAmountToSatang(amountText) ?? 0)}</strong></div>
          {engineError && <p role="alert" className="text-sm text-bad">{ENGINE_ERROR.message}</p>}
          <button type="button" onClick={() => void handleSave()} disabled={saving} className="min-h-13 flex-1 rounded-xl bg-brand-500 px-8 py-3 text-base font-semibold text-white hover:bg-brand-600 disabled:opacity-50 sm:flex-none">{saving ? SAVE.saving : 'บันทึกรายจ่าย'}</button>
        </footer>
      </section>

      {/* Day strip — full width, below both columns */}
      <section className="rounded-lg border border-line bg-panel">
        <h2 className="border-b border-line px-4 py-2.5 text-sm font-semibold text-ink">
          {DAY_STRIP.heading(isoToThaiLong(date))}
        </h2>
        {loadError ? (
          <div className="p-4 text-sm text-bad">{loadError}</div>
        ) : dayEntries === null ? (
          <div className="p-6 text-sm text-ink-muted">{LOADING}</div>
        ) : dayEntries.length === 0 ? (
          <p className="px-4 py-3 text-sm text-ink-muted">{DAY_STRIP.empty}</p>
        ) : (
          <div className="divide-y divide-line">
            {dayEntries.map((item) => (
              <div
                key={item.id}
                className={
                  "flex flex-wrap items-center justify-between gap-2 px-4 py-2.5 text-sm transition-colors duration-300 " +
                  (highlightId === item.id ? "bg-gold-100" : "")
                }
              >
                <button
                  type="button"
                  onClick={() => expenseOrigin(item) !== 'manual' ? navigate('/ap?f=all') : setEditingItem(item)}
                  className="min-w-0 flex-1 truncate text-left text-ink hover:underline focus:outline-none"
                >
                  <span className="mr-2"><RowOrigin synced={expenseOrigin(item) === 'reimbursement'} payroll={expenseOrigin(item) === 'payroll'} /></span>
                  {categoryByCode(item.categoryCode).label}
                  <span className="text-ink-muted"> · {item.comment || "-"} · {PAYMENT_METHOD_LABELS[item.paymentMethod]}</span>
                </button>
                <span className="shrink-0 tabular-nums font-medium text-ink">฿{formatSatang(item.amountSatang)}</span>
                {photoFailures[item.id]?.length ? (
                  <span className="flex shrink-0 items-center gap-1.5 text-xs text-warn">
                    {PHOTO.notUploaded}
                    <button type="button" onClick={() => void retryPhoto(item.id)} className="underline">
                      {PHOTO.retry}
                    </button>
                  </span>
                ) : null}
              </div>
            ))}
          </div>
        )}
      </section>

      {editingItem && (
        <EditDrawer
          item={editingItem}
          recentCodes={recentCodes}
          onClose={() => setEditingItem(null)}
          onSaved={() => {
            setEditingItem(null);
            void loadDayStrip(date);
          }}
          onDeleted={() => {
            setEditingItem(null);
            void loadDayStrip(date);
          }}
        />
      )}
    </div>
  );
}
