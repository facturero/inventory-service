import { Money } from '../../domain/value-objects.js';
import { ProductReadModel } from '../../domain/entities.js';
import { stockEnteredEvent } from '../events.js';
import { applyStockEntry } from '../stock-ops.js';
import type { UnitOfWorkGateway } from '../ports.js';

export interface InvoiceVoidedPayload {
  invoiceId: string;
  organizationId: string;
  reason?: string | null;
}

/** Anula la salida de una factura leyendo el kardex, NUNCA el estado actual:
 *  si el precio o el promedio cambiaron entretanto, se repone lo que salió,
 *  a su costo original. Con FIFO se crea un layer NUEVO al costo original (no
 *  se resucita el layer consumido: reconstruirlo costaría un rastro que no
 *  paga lo que cuesta). */
export class HandleInvoiceVoidedUseCase {
  constructor(private readonly uow: UnitOfWorkGateway, private readonly systemUserId: string) {}

  async execute(payload: InvoiceVoidedPayload): Promise<number> {
    const { invoiceId, organizationId } = payload;
    const uow = await this.uow.begin();
    let restored = 0;
    try {
      const outgoing = await uow.stockMovements.listByReference(organizationId, 'invoice', invoiceId, 'sale_out');

      for (const out of outgoing) {
        let product = await uow.products.findById(organizationId, out.productId);
        if (!product) {
          // Read-model nunca poblado (eventos anteriores al servicio):
          // placeholder para poder valorizar la reposición.
          product = ProductReadModel.upsert({ id: out.productId, organizationId, trackStock: true, type: 'good' });
        }

        const result = await applyStockEntry(uow, {
          organizationId,
          warehouseId: out.warehouseId,
          product,
          quantity: out.quantity, // ya positiva
          unitCost: Money.fromCents(out.unitCostCents ?? 0, out.currencyCode),
          type: 'adjustment_in',
          accountingNature: 'inventory_in',
          referenceType: 'invoice',
          referenceId: invoiceId,
          notes: `Anulación factura ${invoiceId}`,
          createdBy: this.systemUserId,
        });

        await uow.outbox.add(stockEnteredEvent(result.movement, result.position));
        restored += 1;
      }

      await uow.commit();
      return restored;
    } catch (err) {
      await uow.rollback();
      throw err;
    }
  }
}