/** An emergency contact needs both parts. Half of one is a mistake to point out, never something to drop quietly. */
export function contactFrom(name: unknown, phone: unknown): { name: string; phone: string } | null {
  const n = typeof name === 'string' ? name.trim() : '';
  const p = typeof phone === 'string' ? phone.trim() : '';
  if (!n && !p) return null;
  if (!n || !p) throw new Error('Give both the emergency contact’s name and phone number, or leave both empty.');
  return { name: n, phone: p };
}
