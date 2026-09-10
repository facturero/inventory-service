import { ProductReadModel, ProductType } from '../../domain/entities.js';
import type { UnitOfWork } from '../../domain/repositories.js';

export interface ProductEventPayload {
  productId: string;
  organizationId: string;
  sku?: string | null;
  name: string;
  type: ProductType;
  trackStock: boolean;
  allowNegativeStock: boolean;
  valuationMethod: 'weighted_average' | 'fifo';
  status: 'active' | 'inactive';
}

/** Mantiene el read-model local de producto (solo lo que el inventario usa:
 *  trackStock, allowNegativeStock, valuationMethod, status + datos de display).
 *  Los cambios de valuationMethod NO tocan movimientos ya escritos. */
export class RefreshProductReadModelUseCase {
  constructor(private readonly repos: Pick<UnitOfWork, 'products'>) {}

  async syncFromEvent(payload: ProductEventPayload): Promise<void> {
    const existing = await this.repos.products.findById(payload.organizationId, payload.productId);
    if (existing) {
      existing.refresh({
        name: payload.name,
        sku: payload.sku ?? null,
        type: payload.type,
        trackStock: payload.trackStock,
        allowNegativeStock: payload.allowNegativeStock,
        valuationMethod: payload.valuationMethod,
        status: payload.status,
      });
      await this.repos.products.save(existing);
      return;
    }
    await this.repos.products.upsert(
      ProductReadModel.upsert({
        id: payload.productId,
        organizationId: payload.organizationId,
        name: payload.name,
        sku: payload.sku ?? null,
        type: payload.type,
        trackStock: payload.trackStock,
        allowNegativeStock: payload.allowNegativeStock,
        valuationMethod: payload.valuationMethod,
        status: payload.status,
      }),
    );
  }

  async markInactive(organizationId: string, productId: string): Promise<void> {
    const existing = await this.repos.products.findById(organizationId, productId);
    if (existing) {
      existing.markInactive();
      await this.repos.products.save(existing);
      return;
    }
    // Si el read-model todavía no lo conoce, se crea inactivo en frío.
    await this.repos.products.upsert(
      ProductReadModel.upsert({ id: productId, organizationId, status: 'inactive' }),
    );
  }
}