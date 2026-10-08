// Shown only when there is more than one account to choose from.
export function AccountPicker({ accounts, value, onChange }) {
  if (accounts.length < 2) return null;
  return (
    <select aria-label="Account" value={value} onChange={(e) => onChange(e.target.value)}>
      <option value="">All accounts</option>
      {accounts.map((a) => <option key={a.id} value={a.id}>{a.name}</option>)}
    </select>
  );
}

export function scopeLabel(accounts, value) {
  if (accounts.length < 2) return '';
  if (!value) return `Across all ${accounts.length} accounts`;
  return `Showing only ${accounts.find((a) => String(a.id) === String(value))?.name ?? 'one account'}`;
}
