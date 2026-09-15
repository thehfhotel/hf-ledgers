export function RowOrigin({ synced, issue = false }: { synced: boolean; issue?: boolean }) {
  return <span className={'inline-block rounded-full border px-2 py-1 text-xs font-medium ' +
    (issue ? 'border-bad/40 bg-bad/5 text-bad' : synced ? 'border-brand-500/30 bg-brand-50 text-brand-700' : 'border-line-strong bg-tint text-ink-muted')}>
    {synced ? (issue ? 'จากระบบเบิกจ่าย · ต้องตรวจสอบ' : 'จากระบบเบิกจ่าย') : 'กรอกเอง'}
  </span>;
}
