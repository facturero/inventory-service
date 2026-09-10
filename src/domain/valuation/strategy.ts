import { Decimal } from 'decimal.js';
import type { StockLayer, StockPosition } from '../entities.js';
import { InvalidValuationMethodError } from '../errors.js';
import { Money, Quantity } from '../value-objects.js';

export type ValuationMethod = 'weighted_average' | 'fifo';

export interface StockLayerCreate {
  organizationId: string;
  productId: string;
  warehouseId: string;
  quantityRemaining: Quantity;
  unitCost: Money;
  enteredAt: Date;
}

/** Resultado de aplicar una entrada: qué cambia en la posición y si hay que
 *  crear una capa FIFO. `averageCost` es el promedio nuevo (para weighted es el
 *  dato; para FIFO se recalcula solo para display: la aritmética posterior usa
 *  las capas). */
export interface StockPositionUpdate {
  averageCost: Money;
  layer?: StockLayerCreate;
}

export interface ConsumedLayer {
  layer: StockLayer;
  quantity: Quantity;
  costCents: number;
}

export interface CostOfGoodsSold {
  /** Valor autoritativo: suma EXACTA de lo consumido capa por capa. */
  totalCostCents: number;
  /** SOLO para mostrar: total / quantity redondeado. En una salida FIFO que
   *  cruza varias capas no existe un costo unitario; toda aritmética posterior
   *  parte de totalCostCents. */
  unitCostCents: number;
  consumedLayers: ConsumedLayer[];
  /** Lo que la salida pidió y no encontró en ninguna capa (posiciones en cero
   *  o negativas). No lo cubre ninguna capa: cuesta 0. */
  uncoveredQuantity: Quantity;
}

export interface ValuationStrategy {
  onEntry(position: StockPosition, quantity: Quantity, unitCost: Money): StockPositionUpdate;
  onExit(position: StockPosition, quantity: Quantity, layers: StockLayer[]): CostOfGoodsSold;
}

function weightedAverageCents(onHandQty: Quantity, averageCents: number, inQty: Quantity, inCostCents: number): number {
  const onHand = new Decimal(onHandQty.toNumber());
  const incoming = new Decimal(inQty.toNumber());
  const denominator = onHand.plus(incoming);
  if (denominator.isZero()) return 0;
  const numerator = onHand.times(averageCents).plus(incoming.times(inCostCents));
  return Math.round(numerator.dividedBy(denominator).toNumber());
}

export class WeightedAverageStrategy implements ValuationStrategy {
  onEntry(position: StockPosition, quantity: Quantity, unitCost: Money): StockPositionUpdate {
    const avg = weightedAverageCents(
      position.quantityOnHand,
      position.averageCost.toCents(),
      quantity,
      unitCost.toCents(),
    );
    return { averageCost: Money.fromCents(avg, position.currencyCode) };
  }

  onExit(_position: StockPosition, quantity: Quantity, _layers: StockLayer[]): CostOfGoodsSold {
    const totalCostCents = Math.round(
      new Decimal(quantity.toNumber()).times(_position.averageCost.toCents()).toNumber(),
    );
    const unitCostCents = quantity.isZero() ? 0 : Math.round(totalCostCents / quantity.toNumber());
    return {
      totalCostCents,
      unitCostCents,
      consumedLayers: [],
      uncoveredQuantity: Quantity.fromNumber(0),
    };
  }
}

export class FifoStrategy implements ValuationStrategy {
  onEntry(position: StockPosition, quantity: Quantity, unitCost: Money): StockPositionUpdate {
    // Promedio recalculado SOLO para display: la aritmética FIFO usa las capas.
    const avg = weightedAverageCents(
      position.quantityOnHand,
      position.averageCost.toCents(),
      quantity,
      unitCost.toCents(),
    );
    return {
      averageCost: Money.fromCents(avg, position.currencyCode),
      layer: {
        organizationId: position.organizationId,
        productId: position.productId,
        warehouseId: position.warehouseId,
        quantityRemaining: quantity,
        unitCost,
        enteredAt: new Date(),
      },
    };
  }

  onExit(_pos: StockPosition, quantity: Quantity, layers: StockLayer[]): CostOfGoodsSold {
    let remaining = quantity;
    const consumedLayers: ConsumedLayer[] = [];
    let totalCostCents = 0;

    for (const layer of layers) {
      if (remaining.isZero()) break;
      if (remaining.gte(layer.quantityRemaining)) {
        const costCents = Math.round(
          new Decimal(layer.quantityRemaining.toNumber()).times(layer.unitCostCents).toNumber(),
        );
        totalCostCents += costCents;
        consumedLayers.push({ layer, quantity: layer.quantityRemaining, costCents });
        remaining = remaining.subtract(layer.quantityRemaining);
      } else {
        const costCents = Math.round(new Decimal(remaining.toNumber()).times(layer.unitCostCents).toNumber());
        totalCostCents += costCents;
        consumedLayers.push({ layer, quantity: remaining, costCents });
        remaining = Quantity.fromNumber(0);
        break;
      }
    }

    const unitCostCents = quantity.isZero() ? 0 : Math.round(totalCostCents / quantity.toNumber());
    return {
      totalCostCents,
      unitCostCents,
      consumedLayers,
      uncoveredQuantity: remaining,
    };
  }
}

export class ValuationStrategyFactory {
  static for(method: ValuationMethod): ValuationStrategy {
    if (method === 'fifo') return new FifoStrategy();
    if (method === 'weighted_average') return new WeightedAverageStrategy();
    throw new InvalidValuationMethodError();
  }
}