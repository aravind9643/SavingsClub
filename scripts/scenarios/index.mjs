import monthlyRound from './monthly-round.mjs';
import loans from './loans.mjs';
import lifecycle from './lifecycle.mjs';
import isolation from './isolation.mjs';
import payments from './payments.mjs';

export const SCENARIOS = [
  monthlyRound,
  loans,
  lifecycle,
  isolation,
  payments,
];
