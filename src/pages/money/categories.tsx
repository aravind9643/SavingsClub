// Used by ProposeExpenseSheet. Its own module so the list of what a group
// may spend on is findable without reading a 900-line screen.
import type { ExpenseCategory } from '../../lib/types';

export const EXPENSE_CATEGORIES: { value: ExpenseCategory; label: string }[] = [
  { value: 'trip', label: 'Trip' },
  { value: 'party', label: 'Party' },
  { value: 'celebration', label: 'Celebration' },
  { value: 'other', label: 'Other' },
  { value: 'bank_charge', label: 'Bank charge' },
  { value: 'admin', label: 'Admin cost' },
];
