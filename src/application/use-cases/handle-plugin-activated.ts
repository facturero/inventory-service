import { OrganizationPlugin } from '../../domain/entities.js';
import { stockStaleEvent } from '../events.js';
import { INVENTORY_KARDEX_PLUGIN } from '../plugin.js';
import type { UnitOfWorkGateway } from '../ports.js';
import type { UnitOfWork } from '../../domain/repositories.js';

/** Reactiva el seguimiento de stock. Marca active en el read-model, cierra el
 *  hueco abierto (si lo hay) y emite inventory.stock.stale con las fechas y el
 *  contador de movimientos perdidos. Idempotente: activar dos veces no cierra
 *  ni abre nada nuevo. */
export class HandlePluginActivatedUseCase {
  constructor(private readonly uow: UnitOfWorkGateway) {}

  async execute(payload: { organizationId: string; code: string }): Promise<void> {
    if (payload.code !== INVENTORY_KARDEX_PLUGIN) return;

    const uow = await this.uow.begin();
    try {
      const plugin = await uow.organizationPlugins.find(payload.organizationId, INVENTORY_KARDEX_PLUGIN);
      if (plugin?.isActive()) {
        await uow.commit();
        return;
      }
      if (plugin) {
        plugin.activate();
      } else {
        const fresh = OrganizationPlugin.create({ organizationId: payload.organizationId, pluginCode: INVENTORY_KARDEX_PLUGIN, status: 'active' });
        await uow.organizationPlugins.save(fresh);
        await uow.commit();
        return;
      }
      await uow.organizationPlugins.save(plugin);

      await this.closeGap(uow, payload.organizationId);
      await uow.commit();
    } catch (err) {
      await uow.rollback();
      throw err;
    }
  }

  private async closeGap(uow: UnitOfWork, organizationId: string): Promise<void> {
    const gap = await uow.inventoryGaps.findOpenGap(organizationId);
    if (!gap) return; // Sin hueco: reactivar no emite nada.
    gap.close();
    await uow.inventoryGaps.save(gap);
    if (gap.endedAt === null) return;
    await uow.outbox.add(
      stockStaleEvent({
        organizationId,
        startedAt: gap.startedAt,
        endedAt: gap.endedAt,
        skippedMovements: gap.skippedMovements,
      }),
    );
  }
}