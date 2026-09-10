import { Decimal } from 'decimal.js';
import type { AccountingNature, ProductReadModel, StockLayer, StockMovement, StockPosition } from '../domain/entities.js';
import { StockMovement as StockMovementEntity, StockLayer as StockLayerEntity, StockPosition as StockPositionEntity } from '../domain/entities.js';
import { InsufficientStockError, InvalidCurrencyError } from '../domain/errors.js';
import { ValuationStrategyFactory } from '../domain/valuation/strategy.js';
import { Money, Quantity } from '../domain/value-objects.js';
import type { WriteUnitOfWork } from './ports.js';

export interface StockEntryParams {
  organizationId: string;
  warehouseId: string;
  product: ProductReadModel;
  /** Siempre positiva; el `type` decide el signo lógico. */
  quantity: Quantity;
  unitCost: Money;
  type: 'purchase_in' | 'adjustment_in' | 'opening_balance' | 'transfer_in';
  accountingNature: AccountingNature;
  referenceType: string | null;
  referenceId: string | null;
  reasonCode?: string | null;
  notes?: string | null;
  createdBy: string;
}

export interface StockEntryResult {
  movement: StockMovement;
  position: StockPosition;
  createdLayer: StockLayer | null;
}

/** Entrada de stock: compra, ajuste positivo, saldo inicial, reposición por
 *  anulación. Delega en la estrategia (weighted → promedio/display; FIFO →
 *  capa nueva) y persiste posición + movimiento + capa en el mismo TX. */
export async function applyStockEntry(uow: WriteUnitOfWork, params: StockEntryParams): Promise<StockEntryResult> {
  let position = await uow.stockPositions.find(params.organizationId, params.warehouseId, params.product.id);
  if (!position) {
    position = StockPositionEntity.create({
      organizationId: params.organizationId,
      productId: params.product.id,
      warehouseId: params.warehouseId,
      currencyCode: params.unitCost.toCurrencyCode(),
    });
  }
  if (position.currencyCode !== params.unitCost.toCurrencyCode()) {
    throw new InvalidCurrencyError(params.unitCost.toCurrencyCode());
  }

  const update = position.applyEntry({ quantity: params.quantity, unitCost: params.unitCost, method: params.product.valuationMethod });
  const totalCostCents = Math.round(new Decimal(params.quantity.toNumber()).times(params.unitCost.toCents()).toNumber());

  const movement = StockMovementEntity.create({
    organizationId: params.organizationId,
    productId: params.product.id,
    warehouseId: params.warehouseId,
    type: params.type,
    quantity: params.quantity,
    unitCostCents: params.unitCost.toCents(),
    totalCostCents,
    currencyCode: params.unitCost.toCurrencyCode(),
    referenceType: params.referenceType,
    referenceId: params.referenceId,
    accountingNature: params.accountingNature,
    reasonCode: params.reasonCode ?? null,
    lotId: null,
    notes: params.notes ?? null,
    createdBy: params.createdBy,
  });

  let createdLayer: StockLayer | null = null;
  if (update.layer) {
    createdLayer = StockLayerEntity.create({
      organizationId: params.organizationId,
      productId: params.product.id,
      warehouseId: params.warehouseId,
      entryMovementId: movement.id,
      quantityRemaining: update.layer.quantityRemaining,
      unitCost: update.layer.unitCost,
      enteredAt: update.layer.enteredAt,
    });
    await uow.stockLayers.save(createdLayer);
  }

  await uow.stockPositions.save(position);
  await uow.stockMovements.save(movement);
  return { movement, position, createdLayer };
}

export interface StockExitParams {
  organizationId: string;
  warehouseId: string;
  product: ProductReadModel;
  /** Siempre positiva; el `type` decide el signo lógico. */
  quantity: Quantity;
  type: 'sale_out' | 'adjustment_out' | 'transfer_out';
  accountingNature: AccountingNature;
  referenceType: string | null;
  referenceId: string | null;
  reasonCode?: string | null;
  notes?: string | null;
  createdBy: string;
  /** true → negar si no alcanza (transferencia, ajuste negativo, acciones que
   *  el usuario sí puede deshacer). false → escribir igual (venta facturada). */
  checkStock: boolean;
  onNegative?: (position: StockPosition) => Promise<void>;
}

export interface StockExitResult {
  movement: StockMovement;
  position: StockPosition;
  /** Costo autoritativo de la salida (por capa en FIFO; qty*avg en weighted). */
  cost: { totalCostCents: number; unitCostCents: number };
}

/** Salida de stock: venta, ajuste negativo, transferencia. SIEMPRE que
 *  `checkStock=false` el movimiento se persiste aunque la posición quede
 *  negativa: la mercadería ya salió y el kardex debe decirlo. */
export async function applyStockExit(uow: WriteUnitOfWork, params: StockExitParams): Promise<StockExitResult> {
  const strategy = ValuationStrategyFactory.for(params.product.valuationMethod);

  let position = await uow.stockPositions.find(params.organizationId, params.warehouseId, params.product.id);
  if (!position) {
    position = StockPositionEntity.create({
      organizationId: params.organizationId,
      productId: params.product.id,
      warehouseId: params.warehouseId,
      currencyCode: 'USD',
    });
  }

  if (params.checkStock && params.quantity.gt(position.quantityOnHand)) {
    throw new InsufficientStockError();
  }

  const layers = params.product.valuationMethod === 'fifo'
    ? await uow.stockLayers.findActiveLayers(params.organizationId, params.product.id, params.warehouseId)
    : [];

  const cogs = position.applyExit({ quantity: params.quantity, valuationStrategy: strategy, layers });

  // FIFO: decrementa el saldo de cada capa consumida.
  const consumed: StockLayer[] = [];
  for (const entry of cogs.consumedLayers) {
    entry.layer.consume(entry.quantity);
    consumed.push(entry.layer);
  }
  if (consumed.length > 0) await uow.stockLayers.persistOutgoing(consumed, []);

  const movement = StockMovementEntity.create({
    organizationId: params.organizationId,
    productId: params.product.id,
    warehouseId: params.warehouseId,
    type: params.type,
    quantity: params.quantity,
    unitCostCents: cogs.unitCostCents,
    totalCostCents: cogs.totalCostCents,
    currencyCode: position.currencyCode,
    referenceType: params.referenceType,
    referenceId: params.referenceId,
    accountingNature: params.accountingNature,
    reasonCode: params.reasonCode ?? null,
    lotId: null,
    notes: params.notes ?? null,
    createdBy: params.createdBy,
  });

  await uow.stockPositions.save(position);
  await uow.stockMovements.save(movement);

  if (position.quantityOnHand.isNegative() && params.onNegative) {
    await params.onNegative(position);
  }

  return { movement, position, cost: { totalCostCents: cogs.totalCostCents, unitCostCents: cogs.unitCostCents } };
}