import type { AccountingNature } from '../domain/entities.js';
import { InvalidAdjustmentReasonError } from '../domain/errors.js';

export type AdjustmentReasonCode =
  | 'physical_count'
  | 'damage'
  | 'expiration'
  | 'theft'
  | 'internal_use'
  | 'correction';

export const ADJUSTMENT_REASON_CODES: readonly AdjustmentReasonCode[] = [
  'physical_count',
  'damage',
  'expiration',
  'theft',
  'internal_use',
  'correction',
];

export function isAdjustmentReasonCode(value: string): value is AdjustmentReasonCode {
  return (ADJUSTMENT_REASON_CODES as readonly string[]).includes(value);
}

/** Naturaleza contable derivada de motivo + signo (tabla de IMPLEMENTATION,
 *  Fase 2). `positive` = la cantidad del ajuste es una entrada. */
export function accountingNatureForAdjustment(reasonCode: string, positive: boolean): AccountingNature {
  switch (reasonCode) {
    case 'physical_count':
      return positive ? 'inventory_gain' : 'shrinkage';
    case 'damage':
    case 'expiration':
    case 'theft':
      return 'shrinkage';
    case 'internal_use':
      return 'expense';
    case 'correction':
      return positive ? 'inventory_gain' : 'shrinkage';
    default:
      throw new InvalidAdjustmentReasonError();
  }
}