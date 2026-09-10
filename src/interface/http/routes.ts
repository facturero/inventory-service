import { Hono } from 'hono';
import { AdjustStockUseCase } from '../../application/use-cases/adjust-stock.js';
import { CreateWarehouseUseCase } from '../../application/use-cases/create-warehouse.js';
import { DeactivateWarehouseUseCase, GetWarehouseUseCase, ListWarehousesUseCase } from '../../application/use-cases/warehouse-queries.js';
import { GetStockByProductUseCase, GetStockMovementsUseCase, GetStockSummaryUseCase } from '../../application/use-cases/stock-queries.js';
import { TransferStockUseCase } from '../../application/use-cases/transfer-stock.js';
import { UpdateWarehouseUseCase } from '../../application/use-cases/update-warehouse.js';
import {
  adjustStockController,
  createWarehouseController,
  deactivateWarehouseController,
  getStockByProductController,
  getStockMovementsController,
  getStockSummaryController,
  getWarehouseController,
  listWarehousesController,
  transferStockController,
  updateWarehouseController,
} from './controllers.js';
import {
  adjustStockSchema,
  createWarehouseSchema,
  transferStockSchema,
  updateWarehouseSchema,
  validateJson,
} from './validators.js';
import { ContextVariables, requireOrganization, requirePermission } from './middlewares.js';

type Vars = { Variables: ContextVariables };

export interface AppDependencies {
  useCases: {
    listWarehouses: ListWarehousesUseCase;
    createWarehouse: CreateWarehouseUseCase;
    getWarehouse: GetWarehouseUseCase;
    updateWarehouse: UpdateWarehouseUseCase;
    deactivateWarehouse: DeactivateWarehouseUseCase;
    getStockByProduct: GetStockByProductUseCase;
    getStockSummary: GetStockSummaryUseCase;
    getStockMovements: GetStockMovementsUseCase;
    adjustStock: AdjustStockUseCase;
    transferStock: TransferStockUseCase;
  };
  corsOrigin: string;
}

export function healthRoutes(): Hono {
  const r = new Hono();
  r.get('/health', (c) => c.json({ status: 'ok' }));
  return r;
}

export function warehouseRoutes(deps: AppDependencies): Hono<Vars> {
  const r = new Hono<Vars>();
  const { useCases } = deps;

  r.get('/warehouses',
    requireOrganization(),
    requirePermission('inventory:read'),
    listWarehousesController(useCases.listWarehouses));

  r.post('/warehouses',
    requireOrganization(),
    requirePermission('inventory:manage'),
    validateJson(createWarehouseSchema),
    createWarehouseController(useCases.createWarehouse));

  r.get('/warehouses/:id',
    requireOrganization(),
    requirePermission('inventory:read'),
    getWarehouseController(useCases.getWarehouse));

  r.patch('/warehouses/:id',
    requireOrganization(),
    requirePermission('inventory:manage'),
    validateJson(updateWarehouseSchema),
    updateWarehouseController(useCases.updateWarehouse));

  r.post('/warehouses/:id/deactivate',
    requireOrganization(),
    requirePermission('inventory:manage'),
    deactivateWarehouseController(useCases.deactivateWarehouse));

  return r;
}

export function stockRoutes(deps: AppDependencies): Hono<Vars> {
  const r = new Hono<Vars>();
  const { useCases } = deps;

  r.get('/stock',
    requireOrganization(),
    requirePermission('inventory:read'),
    getStockSummaryController(useCases.getStockSummary));

  r.get('/stock/products/:productId',
    requireOrganization(),
    requirePermission('inventory:read'),
    getStockByProductController(useCases.getStockByProduct));

  r.get('/stock/movements',
    requireOrganization(),
    requirePermission('inventory:read'),
    getStockMovementsController(useCases.getStockMovements));

  r.post('/stock/adjustments',
    requireOrganization(),
    requirePermission('inventory:adjust'),
    validateJson(adjustStockSchema),
    adjustStockController(useCases.adjustStock));

  r.post('/stock/transfers',
    requireOrganization(),
    requirePermission('inventory:transfer'),
    validateJson(transferStockSchema),
    transferStockController(useCases.transferStock));

  // Reservas x-phase: 2 — diseñadas en el openapi, NO montadas en esta fase.
  return r;
}