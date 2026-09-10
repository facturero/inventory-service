import './infrastructure/telemetry/otel.js';
import { serve } from '@hono/node-server';
import { OutboxRelay } from '@facturero/outbox-relay';
import { config } from './infrastructure/config.js';
import { sequelize } from './infrastructure/persistence/sequelize.js';
import './infrastructure/persistence/models.js';
import { readOnlyRepositories, SequelizeUnitOfWorkFactory } from './infrastructure/persistence/repositories.js';
import { buildEventHandlers, startEventConsumers } from './infrastructure/messaging/consumer.js';
import { CreateWarehouseUseCase } from './application/use-cases/create-warehouse.js';
import { UpdateWarehouseUseCase } from './application/use-cases/update-warehouse.js';
import { DeactivateWarehouseUseCase, GetWarehouseUseCase, ListWarehousesUseCase } from './application/use-cases/warehouse-queries.js';
import { GetStockByProductUseCase, GetStockMovementsUseCase, GetStockSummaryUseCase } from './application/use-cases/stock-queries.js';
import { AdjustStockUseCase } from './application/use-cases/adjust-stock.js';
import { TransferStockUseCase } from './application/use-cases/transfer-stock.js';
import { createApp } from './interface/http/app.js';

/** Cold-start del estado del plugin: si inventory recibe un evento de una
 *  organización que todavía no tiene fila en organization_plugins le pregunta
 *  a plugin-catalog SERVICE y cachea la respuesta en la fila. Ante duda
 *  (service caído, sin variable) se procesa: nunca se deja de registrar una
 *  venta por culpa de una dependencia transversal. */
async function pluginCatalogColdStart(organizationId: string, pluginCode: string): Promise<boolean | null> {
  if (!config.PLUGIN_CATALOG_SERVICE_URL) return null;
  try {
    const res = await fetch(`${config.PLUGIN_CATALOG_SERVICE_URL}/organizations/me/plugins`, {
      headers: { 'X-Organization-Id': organizationId, 'X-User-Id': config.INTERNAL_USER_ID, 'X-Request-Id': 'inventory-cold-start' },
      signal: AbortSignal.timeout(4000),
    });
    if (!res.ok) return null;
    const rows = (await res.json()) as { pluginCode?: string; status?: string }[];
    const row = rows.find((r) => r.pluginCode === pluginCode);
    if (!row) return false;
    if (row.status === 'active') return true;
    if (row.status === 'disabled') return false;
    return null;
  } catch {
    return null;
  }
}

async function main(): Promise<void> {
  await sequelize.authenticate();
  await sequelize.sync();

  const uowGateway = new SequelizeUnitOfWorkFactory(config.PLUGIN_CATALOG_SERVICE_URL ? pluginCatalogColdStart : undefined);
  const repos = readOnlyRepositories;

  const app = createApp({
    useCases: {
      listWarehouses: new ListWarehousesUseCase(repos),
      createWarehouse: new CreateWarehouseUseCase(uowGateway),
      getWarehouse: new GetWarehouseUseCase(repos),
      updateWarehouse: new UpdateWarehouseUseCase(uowGateway),
      deactivateWarehouse: new DeactivateWarehouseUseCase(uowGateway),
      getStockByProduct: new GetStockByProductUseCase(repos),
      getStockSummary: new GetStockSummaryUseCase(repos),
      getStockMovements: new GetStockMovementsUseCase(repos),
      adjustStock: new AdjustStockUseCase(uowGateway),
      transferStock: new TransferStockUseCase(uowGateway),
    },
    corsOrigin: config.CORS_ORIGIN,
  });

  serve({ fetch: app.fetch, port: config.PORT });
  console.log(`[inventory-service] corriendo en puerto ${config.PORT}`);

  if (config.RABBITMQ_URL) {
    const relay = new OutboxRelay({
      sequelize,
      rabbitmqUrl: config.RABBITMQ_URL,
      exchange: 'crm.events',
    });
    await relay.start();

    await startEventConsumers({
      sequelize,
      rabbitmqUrl: config.RABBITMQ_URL,
      exchange: 'crm.events',
      queue: 'inventory-service.events',
      handlers: buildEventHandlers({ uowGateway, systemUserId: config.INTERNAL_USER_ID, productRepo: repos }),
    });
    console.log('[inventory-service] outbox relay + consumidor de eventos activos');
  } else {
    console.warn('[inventory-service] RABBITMQ_URL no configurado: eventos NO se publican ni consumen');
  }
}

main().catch((err) => {
  console.error('[inventory-service] error al iniciar:', err);
  process.exit(1);
});