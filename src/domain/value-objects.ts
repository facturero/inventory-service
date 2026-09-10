import { Decimal } from 'decimal.js';
import { dinero, add, subtract, multiply, toDecimal, toSnapshot, haveSameCurrency, type Dinero } from 'dinero.js';
import { USD, EUR, COP, PEN, MXN, type DineroCurrency } from 'dinero.js/currencies';
import { InvalidCurrencyError, InvalidMoneyAmountError } from './errors.js';

const SUPPORTED: Record<string, DineroCurrency<number>> = { USD, EUR, COP, PEN, MXN };

export class Money {
  private constructor(private readonly d: Dinero<number>) {}

  static fromCents(cents: number, currencyCode: string): Money {
    const currency = SUPPORTED[currencyCode];
    if (!currency) throw new InvalidCurrencyError(currencyCode);
    return new Money(dinero({ amount: cents, currency }));
  }

  static fromDecimalString(value: string, currencyCode: string): Money {
    const currency = SUPPORTED[currencyCode];
    if (!currency) throw new InvalidCurrencyError(currencyCode);
    const num = parseFloat(value);
    if (isNaN(num) || !isFinite(num)) throw new InvalidMoneyAmountError();
    const cents = Math.round(num * 10 ** currency.exponent);
    return new Money(dinero({ amount: cents, currency }));
  }

  add(other: Money): Money {
    if (!haveSameCurrency([this.d, other.d])) throw new Error('Moneda diferente.');
    return new Money(add(this.d, other.d));
  }

  subtract(other: Money): Money {
    if (!haveSameCurrency([this.d, other.d])) throw new Error('Moneda diferente.');
    return new Money(subtract(this.d, other.d));
  }

  multiply(multiplier: number): Money {
    return new Money(multiply(this.d, multiplier));
  }

  toCents(): number {
    return toSnapshot(this.d).amount;
  }

  toCurrencyCode(): string {
    return toSnapshot(this.d).currency.code;
  }

  toDecimalString(): string {
    return toDecimal(this.d);
  }

  equals(other: Money): boolean {
    const a = toSnapshot(this.d);
    const b = toSnapshot(other.d);
    return a.amount === b.amount && a.currency.code === b.currency.code;
  }
}

/**
 * Cantidad de inventario. DECIMAL(18,4): no es dinero y NO se redondea a la
 * unidad. Envuelve Decimal.js para que 0.1 + 0.2 === 0.3 de verdad — los
 * `quantity` del evento billing.invoice.issued llegan como `number` de
 * JavaScript y deben convertirse AQUÍ antes de operar, nunca sumarse crudos.
 */
export class Quantity {
  private constructor(private readonly value: Decimal) {}

  static fromNumber(n: number): Quantity {
    return new Quantity(new Decimal(n));
  }

  static fromString(s: string): Quantity {
    return new Quantity(new Decimal(s));
  }

  add(other: Quantity): Quantity {
    return new Quantity(this.value.plus(other.value));
  }

  subtract(other: Quantity): Quantity {
    return new Quantity(this.value.minus(other.value));
  }

  multiply(n: number | string): Quantity {
    return new Quantity(this.value.times(n));
  }

  negate(): Quantity {
    return new Quantity(this.value.negated());
  }

  abs(): Quantity {
    return new Quantity(this.value.abs());
  }

  isZero(): boolean {
    return this.value.isZero();
  }

  /** Estrictamente mayor que cero.
   *
   *  OJO: NO delegar en `Decimal.isPositive()`. En decimal.js el cero tiene
   *  signo positivo, así que `new Decimal(0).isPositive()` devuelve `true`.
   *  Todos los llamadores de este método preguntan "¿hay algo?", nunca
   *  "¿el signo no es negativo?": una bodega con posición en cero se puede
   *  desactivar, una capa FIFO con saldo cero está agotada, y un producto con
   *  cero unidades sale en el filtro "sin stock". */
  isPositive(): boolean {
    return this.value.gt(0);
  }

  isNegative(): boolean {
    return this.value.isNegative();
  }

  gte(other: Quantity): boolean {
    return this.value.gte(other.value);
  }

  gt(other: Quantity): boolean {
    return this.value.gt(other.value);
  }

  equals(other: Quantity): boolean {
    return this.value.eq(other.value);
  }

  /** Formato de persistencia y de salida: DECIMAL(18,4). */
  toFixed(): string {
    return this.value.toFixed(4);
  }

  toString(): string {
    return this.value.toFixed(4);
  }

  toNumber(): number {
    return this.value.toNumber();
  }
}