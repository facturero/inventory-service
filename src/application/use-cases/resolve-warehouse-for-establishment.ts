import type { Warehouse } from '../../domain/entities.js';
import { DefaultWarehouseMissingError } from '../../domain/errors.js';

/** Pieza central del descuento por venta. La factura solo trae el
 *  establishmentId: quien decide en qué bodega descuenta es inventario. */
export class ResolveWarehouseForEstablishmentUseCase {
  constructor(
    private readonly repos: {
      warehouses: {
        findByEstablishment(organizationId: string, establishmentId: string): Promise<Warehouse | null>;
        findDefault(organizationId: string): Promise<Warehouse | null>;
      };
    },
  ) {}

  async execute(organizationId: string, establishmentId: string | null): Promise<Warehouse> {
    if (establishmentId) {
      const byEstablishment = await this.repos.warehouses.findByEstablishment(organizationId, establishmentId);
      if (byEstablishment && byEstablishment.status === 'active') return byEstablishment;
    }
    const fallback = await this.repos.warehouses.findDefault(organizationId);
    if (fallback && fallback.status === 'active') return fallback;
    // Error de datos, no inventar bodegas: si no hay PRINCIPAL, la venta no
    // tiene dónde descontar y hay que arreglar el onboarding antes que vender.
    throw new DefaultWarehouseMissingError();
  }
}