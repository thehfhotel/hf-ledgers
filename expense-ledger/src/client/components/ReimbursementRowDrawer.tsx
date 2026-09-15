import type { ApRow } from '../../shared/apTypes.ts';
import { formatSatang } from '@shared/money.ts';
import { isoToBuddhist } from '@shared/date.ts';

export function ReimbursementRowDrawer({ row, onClose }: { row: ApRow; onClose: () => void }) {
  const source = row.reimbursement!;
  return <div className="fixed inset-0 z-50 flex justify-end bg-black/30" onClick={onClose}>
    <section role="dialog" aria-modal="true" aria-label="ใบเสร็จเบิกจ่าย" className="h-full w-full max-w-xl overflow-y-auto bg-panel p-6 shadow-xl" onClick={e => e.stopPropagation()}>
      <div className="flex items-center justify-between"><h2 className="text-lg font-semibold">ใบเสร็จเบิกจ่าย</h2><button onClick={onClose} className="rounded border px-3 py-2">ปิด</button></div>
      <p className="mt-4">ข้อมูลและสถานะการจ่ายอัปเดตจากระบบเบิกจ่าย แก้ไขหรือจ่ายเงินที่ระบบเบิกจ่าย</p>
      {source.error && <p className="mt-3 text-bad">การเชื่อมข้อมูลรายการนี้ต้องตรวจสอบ สถานะบัญชีอาจยังไม่ตรงกับระบบเบิกจ่าย</p>}
      <dl className="my-6 grid grid-cols-[7rem_1fr] gap-3">
        <dt>ผู้สำรองจ่าย</dt><dd>{row.creditor}</dd><dt>ร้านค้า</dt><dd>{row.item}</dd>
        <dt>ในนาม</dt><dd>{row.entity}</dd><dt>จำนวนเงิน</dt><dd>{formatSatang(row.grossSatang)}</dd>
        <dt>ค้างจ่าย</dt><dd>{formatSatang(row.outstandingSatang)}</dd>
        <dt>สถานะ</dt><dd>{row.settledAt ? `จ่ายแล้ว ${isoToBuddhist(row.settledAt)}` : 'รอจ่ายคืนพนักงาน'}</dd>
      </dl>
      <p className="whitespace-pre-wrap break-words text-sm text-ink-muted">{row.note}</p>
      <a className="my-5 inline-block underline" href="https://reimbursement.thehfhotel.org" target="_blank" rel="noreferrer">เปิดระบบเบิกจ่าย</a>
      <div className="space-y-3">{row.photos.map(p => <a key={p.id} href={p.url} target="_blank" rel="noreferrer"><img src={p.url} alt="ใบเสร็จ" className="w-full rounded border" /></a>)}</div>
    </section>
  </div>;
}
