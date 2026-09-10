import { Quantity } from '../../domain/value-objects.js';
import { InventoryGap } from '../../domain/entities.js';
import { stockConsumedEvent, stockNegativeEvent } from '../events.js';
import { applyStockExit } from '../stock-ops.js';
import { INVENTORY_KARDEX_PLUGIN } from '../plugin.js';
import type { UnitOfWork } from '../../domain/repositories.js';
import type { UnitOfWorkGateway } from '../ports.js';
import { ResolveWarehouseForEstablishmentUseCase } from './resolve-warehouse-for-establishment.js';

export interface InvoiceIssuedPayload {
  invoiceId: string;
  organizationId: string;
  establishmentId: string | null;
  countryCode?: string;
  currencyCode?: string;
  lines: { productId: string; quantity: number }[];
}

/** Descuento directo al emitir la factura (sin reservas). El movimiento se
 *  escribe SIEMPRE, alcance o no: la factura ya está firmada y la mercadería
 *  salió del local. `allow_negative_stock` no se evalúa aquí (ver recuadro del
 *  IMPLEMENTATION); solo decide si la alerta es esperada o incidencia. */
export class HandleInvoiceIssuedUseCase {
  constructor(private readonly uow: UnitOfWorkGateway, private readonly systemUserId: string) {}

  async execute(payload: InvoiceIssuedPayload): Promise<{ writtenLines: number; skippedLines: number }> {
    const { organizationId, invoiceId, establishmentId, lines } = payload;
    const uow = await this.uow.begin();
    let writtenLines = 0;
    let skippedLines = 0;
    try {
      // Idempotencia por si el mismo evento vuelve a llegar (los processed_events
      // del InboxConsumer ya filtran; esto es defensa en profundidad): si la
      // factura ya descontó, no se vuelve a descontar.
      const alreadyWritten = await uow.stockMovements.listByReference(organizationId, 'invoice', invoiceId, 'sale_out');
      if (alreadyWritten.length > 0) {
        await uow.commit();
        return { writtenLines: 0, skippedLines: 0 };
      }

      // Primero de todo: el módulo debe estar activo. Si no, ni un movimiento:
      // se anota el hueco (una vez por línea que se saltó) y se confirma.
      const active = await uow.organizationPlugins.getActivationState(organizationId, INVENTORY_KARDEX_PLUGIN);
      if (!active) {
        await this.recordSkipped(uow, organizationId, lines.length);
        skippedLines = lines.length;
        await uow.commit();
        return { writtenLines: 0, skippedLines };
      }

      // Bodega resuelta UNA VEZ por factura: todas las líneas descuentan de la
      // misma, la del establecimiento emisor con respaldo en la PRINCIPAL.
      const resolver = new ResolveWarehouseForEstablishmentUseCase(uow);
      const warehouse = await resolver.execute(organizationId, establishmentId ?? null);

      for (const line of lines) {
        const product = await uow.products.findById(organizationId, line.productId);
        if (!product || !product.carriesStock()) continue;

        const result = await applyStockExit(uow, {
          organizationId,
          warehouseId: warehouse.id,
          product,
          quantity: Quantity.fromNumber(line.quantity),
          type: 'sale_out',
          accountingNature: 'cogs',
          referenceType: 'invoice',
          referenceId: invoiceId,
          notes: null,
          createdBy: this.systemUserId,
          checkStock: false,
          onNegative: async (position) => {
            await uow.outbox.add(
              stockNegativeEvent({
                organizationId,
                productId: product.id,
                warehouseId: warehouse.id,
                currentOnHand: position.quantityOnHand,
                allowNegativeStock: product.allowNegativeStock,
              }),
            );
          },
        });
        await uow.outbox.add(stockConsumedEvent(result.movement, result.position));
        writtenLines += 1;
      }

      await uow.commit();
      return { writtenLines, skippedLines: 0 };
    } catch (err) {
      await uow.rollback();
      throw err;
    }
  }

  private async recordSkipped(uow: UnitOfWork, organizationId: string, count: number): Promise<void> {
    let gap = await uow.inventoryGaps.findOpenGap(organizationId);
    if (!gap) {
      gap = InventoryGap.create({ organizationId, startedAt: new Date() });
    }
    gap.incrementSkipped(count);
    await uow.inventoryGaps.save(gap);
  }
}