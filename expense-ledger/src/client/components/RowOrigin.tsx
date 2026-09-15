export function RowOrigin({ synced, payroll = false, issue = false }: { synced: boolean; payroll?: boolean; issue?: boolean }) {
  const label = payroll ? 'จากระบบเงินเดือน' : synced ? 'จากระบบเบิกจ่าย' : 'กรอกเอง';
  return <span className={'inline-block rounded-full border px-2 py-1 text-xs font-medium ' +
    (issue ? 'border-bad/40 bg-bad/5 text-bad' : synced || payroll ? 'border-brand-500/30 bg-brand-50 text-brand-700' : 'border-line-strong bg-tint text-ink-muted')}>
    {label}{issue ? ' · ต้องตรวจสอบ' : ''}
  </span>;
}
