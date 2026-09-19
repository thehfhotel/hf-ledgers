import { useEffect, useRef } from 'react';
import type { ApRow } from '../../shared/apTypes.ts';
import { formatSatang } from '@shared/money.ts';
import { isoToBuddhist, monthToThaiLong } from '@shared/date.ts';
import { RowOrigin } from './RowOrigin.tsx';
import { AP_FIELDS } from '../labels.ts';

const STATUS: Record<string, string> = {
  PENDING: 'รออนุมัติส่งเงินเดือน', APPROVED: 'อนุมัติแล้ว กำลังส่งธนาคาร',
  SCHEDULED: 'ส่งธนาคารแล้ว รอตรวจสอบผลโอน', PAID: 'ธนาคารยืนยันจ่ายแล้ว รอลงบัญชี',
  FAILED: 'ยังยืนยันผลโอนไม่ได้ กรุณาตรวจสอบที่ระบบเงินเดือน', REJECTED: 'คำขอถูกยกเลิก',
};

export function PayrollRowDrawer({ row, onClose }: { row: ApRow; onClose: () => void }) {
  const source = row.payroll!;
  const close = useRef<HTMLButtonElement>(null);
  useEffect(() => {
    const previous = document.activeElement as HTMLElement | null;
    close.current?.focus();
    const key = (e: KeyboardEvent) => { if (e.key === 'Escape') onClose(); };
    document.addEventListener('keydown', key);
    return () => { document.removeEventListener('keydown', key); previous?.focus(); };
  }, [onClose]);
  return <div className="fixed inset-0 z-50 flex justify-end bg-black/30" onClick={onClose}>
    <section role="dialog" aria-modal="true" aria-label="รายละเอียดเงินเดือน" className="h-full w-full max-w-xl overflow-y-auto bg-panel p-6 text-ink shadow-xl" onClick={e => e.stopPropagation()}>
      <div className="flex items-center justify-between gap-3"><h2 className="text-lg font-semibold">เงินเดือน {monthToThaiLong(source.period)}</h2><button ref={close} onClick={onClose} className="min-h-11 rounded-lg border border-line-strong px-4">ปิด</button></div>
      <div className="mt-4"><RowOrigin synced={false} payroll issue={source.error} /></div>
      <p className="mt-4 text-sm">วันที่ลงบิลของรายการนี้คือวันสุดท้ายของรอบเงินเดือน แก้ไขที่นี่ไม่ได้ เพราะรอบมาจากระบบเงินเดือน</p>
      <p className="mt-2 text-sm">รายการนี้มาจากคำขอส่งเงินเดือน สถานะจะเปลี่ยนเป็นจ่ายแล้วเมื่อระบบเงินเดือนตรวจสอบผลโอนจากธนาคารสำเร็จ ไม่ต้องกรอกหรือบันทึกการจ่ายซ้ำ</p>
      {source.error && <p className="mt-3 rounded-lg bg-bad/5 p-3 text-sm text-bad">รายการนี้ต้องตรวจสอบ กรุณาเปิดระบบเงินเดือนเพื่อดูผลล่าสุด</p>}
      <div className="my-5 rounded-xl bg-tint p-4"><span className="text-sm text-ink-muted">ยอดโอนสุทธิรวม {source.employeeCount} คน</span><strong className="mt-1 block text-3xl tabular-nums">฿{formatSatang(row.grossSatang)}</strong></div>
      <dl className="grid grid-cols-[7rem_1fr] gap-3 text-sm">
        <dt className="text-ink-muted">สถานะ</dt><dd>{row.settledAt ? `จ่ายแล้ว ${isoToBuddhist(row.settledAt)}` : STATUS[source.status] ?? 'กำลังตรวจสอบ'}</dd>
        <dt className="text-ink-muted">กำหนดโอน</dt><dd>{isoToBuddhist(source.effectiveDate)}</dd>
        <dt className="text-ink-muted">{AP_FIELDS.billDate}</dt><dd>{isoToBuddhist(row.billDate)} · งวด {monthToThaiLong(row.billDate.slice(0, 7))}</dd>
        <dt className="text-ink-muted">{AP_FIELDS.filedDate}</dt><dd>{isoToBuddhist(row.filedDate)}</dd>
        <dt className="text-ink-muted">ค้างจ่าย</dt><dd>฿{formatSatang(row.outstandingSatang)}</dd>
      </dl>
      <p className="mt-5 text-xs text-ink-muted">ยอดนี้เป็นเงินเดือนสุทธิที่โอนให้พนักงาน ไม่รวมเงินสมทบนายจ้าง และยังไม่มีการแยกยอดตามโรงแรม</p>
      <a className="mt-6 inline-flex min-h-12 items-center rounded-lg bg-brand-500 px-5 font-semibold text-white" href="https://payroll.thehfhotel.org/status" target="_blank" rel="noreferrer">เปิดระบบเงินเดือน</a>
    </section>
  </div>;
}
