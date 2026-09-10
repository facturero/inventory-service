import { Warehouse } from '../../domain/entities.js';
import { warehouseCreatedEvent } from '../events.js';
import type { UnitOfWorkGateway } from '../ports.js';

/** Cada establecimiento nace con su bodega, con code derivado del código del
 *  establecimiento. OBLIGATORIO, no opcional: sin esto la resolución de bodega
 *  de la venta cae siempre en PRINCIPAL y una segunda tienda descuadra el
 *  stock desde su primera venta. Idempotente. */
export class EnsureWarehouseForEstablishmentUseCase {
  constructor(private readonly uow: UnitOfWorkGateway) {}

  async execute(payload: { organizationId: string; establishmentId: string; code: string; name?: string }): Promise<Warehouse> {
    const uow = await this.uow.begin();
    try {
      const existing = await uow.warehouses.findByEstablishment(payload.organizationId, payload.establishmentId);
      if (existing) {
        await uow.commit();
        return existing;
      }

      // Código derivado, acotado a 20 chars. En colisión se desambigua con el
      // inicio del UUID del establecimiento.
      let code = payload.code.slice(0, 20);
      if (await uow.warehouses.existsByCode(payload.organizationId, code)) {
        code = `${code.slice(0, 15)}-${payload.establishmentId.slice(0, 4)}`;
      }

      const count = await uow.warehouses.countByOrganization(payload.organizationId);
      const warehouse = Warehouse.create({
        organizationId: payload.organizationId,
        establishmentId: payload.establishmentId,
        code,
        name: payload.name ? `Bodega ${payload.name}` : `Bodega ${code}`,
        isDefault: count === 0, // primera bodega de la org es la default
      });
      await uow.warehouses.save(warehouse);
      await uow.outbox.add(warehouseCreatedEvent(warehouse));

      await uow.commit();
      return warehouse;
    } catch (err) {
      await uow.rollback();
      throw err;
    }
  }
}

/** Al completarse el perfil fiscal (o el primer org.updated), garantiza la
 *  bodega PRINCIPAL. Idempotente: no crea nada si ya hay default. */
export class EnsureDefaultWarehouseUseCase {
  constructor(private readonly uow: UnitOfWorkGateway) {}

  async execute(organizationId: string): Promise<Warehouse> {
    const uow = await this.uow.begin();
    try {
      const existing = await uow.warehouses.findDefault(organizationId);
      if (existing) {
        await uow.commit();
        return existing;
      }

      const warehouse = Warehouse.create({
        organizationId,
        code: 'PRINCIPAL',
        name: 'Bodega Central',
        isDefault: true,
      });
      await uow.warehouses.save(warehouse);
      await uow.outbox.add(warehouseCreatedEvent(warehouse));

      await uow.commit();
      return warehouse;
    } catch (err) {
      await uow.rollback();
      throw err;
    }
  }
}