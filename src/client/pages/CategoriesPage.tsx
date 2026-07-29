import { useEffect, useMemo, useState, type FormEvent } from "react";
import { NAME_TH_MAX_LEN, type Category, type CategoryKind, type Property } from "../../shared/types.ts";
import { createCategory, getMe, listCategories, reorderCategories, updateCategory } from "../api.ts";

interface Props {
  property: Property;
}

const TABS: { kind: CategoryKind; label: string }[] = [
  { kind: "income", label: "รายรับ" },
  { kind: "expense", label: "รายจ่าย" },
];

/**
 * Manager admin screen. Gating lives here (not App.tsx, see App.tsx's
 * routing comment): non-managers get a "สำหรับผู้จัดการเท่านั้น" panel
 * instead of the admin UI.
 */
export function CategoriesPage({ property }: Props) {
  const [meLoading, setMeLoading] = useState(true);
  const [isManager, setIsManager] = useState(false);
  const [meError, setMeError] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    getMe()
      .then((me) => {
        if (!cancelled) setIsManager(me.isManager);
      })
      .catch((err) => {
        if (!cancelled) setMeError(err instanceof Error ? err.message : "ตรวจสอบสิทธิ์ไม่สำเร็จ");
      })
      .finally(() => {
        if (!cancelled) setMeLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, []);

  if (meLoading) {
    return <div className="p-6 text-sm text-ink-muted">กำลังตรวจสอบสิทธิ์...</div>;
  }

  if (meError) {
    return (
      <div className="rounded-lg border border-bad/30 bg-panel p-4 text-sm text-bad">
        ตรวจสอบสิทธิ์ไม่สำเร็จ: {meError} — ลองรีเฟรชหน้านี้อีกครั้ง
      </div>
    );
  }

  if (!isManager) {
    return (
      <div className="rounded-lg border border-line bg-panel p-6 text-center text-sm text-ink-muted">
        สำหรับผู้จัดการเท่านั้น
      </div>
    );
  }

  return <CategoriesAdmin property={property} />;
}

function CategoriesAdmin({ property }: { property: Property }) {
  const [kind, setKind] = useState<CategoryKind>("income");
  const [categories, setCategories] = useState<Category[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busyId, setBusyId] = useState<number | null>(null);

  function reload() {
    setCategories(null);
    setError(null);
    listCategories(property, true)
      .then((res) => setCategories(res.categories))
      .catch((err) => setError(err instanceof Error ? err.message : "โหลดหมวดหมู่ไม่สำเร็จ"));
  }

  useEffect(() => {
    reload();
    // Deliberately depends on `property` only — reload() reads `property`
    // via closure each call, so re-declaring it as a dep would just cause
    // an extra re-run on every render.
  }, [property]);

  const active = useMemo(
    () => (categories ?? []).filter((c) => c.kind === kind && !c.archivedAt).sort((a, b) => a.sort - b.sort),
    [categories, kind],
  );
  const archived = useMemo(
    () =>
      (categories ?? [])
        .filter((c) => c.kind === kind && c.archivedAt)
        .sort((a, b) => a.nameTh.localeCompare(b.nameTh, "th")),
    [categories, kind],
  );

  async function persistPatch(id: number, body: Partial<{ nameTh: string; isCash: boolean; archived: boolean }>) {
    setBusyId(id);
    setError(null);
    try {
      const updated = await updateCategory(property, id, body);
      setCategories((prev) => (prev ? prev.map((c) => (c.id === id ? updated : c)) : prev));
    } catch (err) {
      setError(err instanceof Error ? err.message : "บันทึกไม่สำเร็จ ลองใหม่อีกครั้ง");
    } finally {
      setBusyId(null);
    }
  }

  async function persistReorder(orderedIds: number[]) {
    setError(null);
    // Optimistic reorder so up/down feels instant on the kiosk PCs.
    setCategories((prev) => {
      if (!prev) return prev;
      const rankById = new Map(orderedIds.map((id, i) => [id, i]));
      return prev.map((c) => (rankById.has(c.id) ? { ...c, sort: rankById.get(c.id)! } : c));
    });
    try {
      const res = await reorderCategories(property, kind, orderedIds);
      setCategories((prev) => {
        if (!prev) return prev;
        const byId = new Map(res.categories.map((c) => [c.id, c]));
        return prev.map((c) => byId.get(c.id) ?? c);
      });
    } catch (err) {
      setError(err instanceof Error ? err.message : "จัดลำดับไม่สำเร็จ ลองใหม่อีกครั้ง");
      reload();
    }
  }

  function move(index: number, delta: number) {
    const target = index + delta;
    if (target < 0 || target >= active.length) return;
    const ids = active.map((c) => c.id);
    const tmp = ids[index]!;
    ids[index] = ids[target]!;
    ids[target] = tmp;
    persistReorder(ids);
  }

  function renameCommit(category: Category, nameTh: string) {
    const trimmed = nameTh.trim();
    if (trimmed === "" || trimmed === category.nameTh) return;
    persistPatch(category.id, { nameTh: trimmed });
  }

  function toggleCash(category: Category) {
    persistPatch(category.id, { isCash: !category.isCash });
  }

  function archive(category: Category) {
    persistPatch(category.id, { archived: true });
  }

  function restore(category: Category) {
    persistPatch(category.id, { archived: false });
  }

  const [newNameTh, setNewNameTh] = useState("");
  const [newIsCash, setNewIsCash] = useState(false);
  const [adding, setAdding] = useState(false);
  const [addError, setAddError] = useState<string | null>(null);

  async function submitAdd(e: FormEvent) {
    e.preventDefault();
    const trimmed = newNameTh.trim();
    if (trimmed === "") {
      setAddError("กรอกชื่อหมวดหมู่ก่อนบันทึก");
      return;
    }
    setAdding(true);
    setAddError(null);
    try {
      const created = await createCategory(property, { kind, nameTh: trimmed, isCash: newIsCash });
      setCategories((prev) => (prev ? [...prev, created] : [created]));
      setNewNameTh("");
      setNewIsCash(false);
    } catch (err) {
      setAddError(err instanceof Error ? err.message : "เพิ่มหมวดหมู่ไม่สำเร็จ ลองใหม่อีกครั้ง");
    } finally {
      setAdding(false);
    }
  }

  return (
    <div className="flex flex-col gap-4">
      <div className="flex gap-1 rounded-lg border border-line bg-panel p-1">
        {TABS.map((tab) => (
          <button
            key={tab.kind}
            type="button"
            onClick={() => setKind(tab.kind)}
            className={
              "flex-1 rounded-md px-3 py-1.5 text-sm font-medium transition " +
              (kind === tab.kind ? "bg-brand-500 text-white" : "text-ink-muted hover:bg-tint")
            }
          >
            {tab.label}
          </button>
        ))}
      </div>

      {error && <div className="rounded-lg border border-bad/30 bg-panel p-3 text-sm text-bad">{error}</div>}

      {categories === null ? (
        <div className="p-6 text-sm text-ink-muted">กำลังโหลด...</div>
      ) : (
        <>
          <section className="overflow-hidden rounded-lg border border-line bg-panel">
            <h2 className="border-b border-line px-4 py-3 text-sm font-semibold text-ink">หมวดหมู่ที่ใช้งานอยู่</h2>
            {active.length === 0 ? (
              <p className="px-4 py-3 text-sm text-ink-muted">ยังไม่มีหมวดหมู่ — เพิ่มหมวดหมู่แรกด้านล่าง</p>
            ) : (
              <div className="divide-y divide-line">
                {active.map((category, index) => (
                  <div key={category.id} className="flex flex-wrap items-center gap-2 px-4 py-2.5">
                    <div className="flex flex-col gap-0.5">
                      <button
                        type="button"
                        onClick={() => move(index, -1)}
                        disabled={index === 0 || busyId === category.id}
                        aria-label="เลื่อนขึ้น"
                        className="rounded border border-line-strong px-1.5 text-xs leading-tight hover:bg-tint disabled:opacity-30"
                      >
                        {"↑"}
                      </button>
                      <button
                        type="button"
                        onClick={() => move(index, 1)}
                        disabled={index === active.length - 1 || busyId === category.id}
                        aria-label="เลื่อนลง"
                        className="rounded border border-line-strong px-1.5 text-xs leading-tight hover:bg-tint disabled:opacity-30"
                      >
                        {"↓"}
                      </button>
                    </div>
                    <input
                      type="text"
                      key={`${category.id}-${category.nameTh}`}
                      defaultValue={category.nameTh}
                      maxLength={NAME_TH_MAX_LEN}
                      disabled={busyId === category.id}
                      aria-label="ชื่อหมวดหมู่"
                      onBlur={(e) => renameCommit(category, e.target.value)}
                      className="min-w-[9rem] flex-1 rounded-md border border-line-strong bg-panel px-2 py-1.5 text-sm text-ink focus:outline-none focus:ring-2 focus:ring-brand-500/40 disabled:bg-tint"
                    />
                    <label className="flex items-center gap-1.5 text-xs text-ink-muted">
                      <input
                        type="checkbox"
                        checked={category.isCash}
                        disabled={busyId === category.id}
                        onChange={() => toggleCash(category)}
                        className="h-4 w-4 rounded border-line-strong accent-brand-500"
                      />
                      นับเป็นเงินสด
                    </label>
                    <button
                      type="button"
                      onClick={() => archive(category)}
                      disabled={busyId === category.id}
                      className="rounded-md border border-line-strong px-2.5 py-1.5 text-xs font-medium text-ink-muted hover:bg-tint disabled:opacity-50"
                    >
                      ซ่อน
                    </button>
                  </div>
                ))}
              </div>
            )}
          </section>

          {archived.length > 0 && (
            <section className="overflow-hidden rounded-lg border border-line bg-panel">
              <h2 className="border-b border-line px-4 py-3 text-sm font-semibold text-ink-muted">หมวดหมู่ที่ซ่อนอยู่</h2>
              <div className="divide-y divide-line">
                {archived.map((category) => (
                  <div key={category.id} className="flex items-center justify-between gap-2 px-4 py-2.5">
                    <span className="text-sm text-ink-muted">{category.nameTh}</span>
                    <button
                      type="button"
                      onClick={() => restore(category)}
                      disabled={busyId === category.id}
                      className="rounded-md border border-line-strong px-2.5 py-1.5 text-xs font-medium text-brand-500 hover:bg-tint disabled:opacity-50"
                    >
                      เรียกคืน
                    </button>
                  </div>
                ))}
              </div>
            </section>
          )}

          <section className="rounded-lg border border-line bg-panel p-4">
            <h2 className="mb-2 text-sm font-semibold text-ink">
              เพิ่มหมวดหมู่{kind === "income" ? "รายรับ" : "รายจ่าย"}
            </h2>
            <form onSubmit={submitAdd} className="flex flex-wrap items-center gap-2">
              <input
                type="text"
                value={newNameTh}
                onChange={(e) => setNewNameTh(e.target.value)}
                placeholder="ชื่อหมวดหมู่"
                maxLength={NAME_TH_MAX_LEN}
                aria-label="ชื่อหมวดหมู่ใหม่"
                className="min-w-[10rem] flex-1 rounded-md border border-line-strong bg-panel px-2 py-1.5 text-sm text-ink focus:outline-none focus:ring-2 focus:ring-brand-500/40"
              />
              <label className="flex items-center gap-1.5 text-xs text-ink-muted">
                <input
                  type="checkbox"
                  checked={newIsCash}
                  onChange={(e) => setNewIsCash(e.target.checked)}
                  className="h-4 w-4 rounded border-line-strong accent-brand-500"
                />
                นับเป็นเงินสด
              </label>
              <button
                type="submit"
                disabled={adding}
                className="rounded-md bg-brand-500 px-3 py-1.5 text-xs font-semibold text-white hover:bg-brand-600 disabled:opacity-50"
              >
                เพิ่มหมวดหมู่
              </button>
            </form>
            {addError && <p className="mt-2 text-xs text-bad">{addError}</p>}
          </section>
        </>
      )}
    </div>
  );
}
