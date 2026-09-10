import { Context } from 'hono';
import { AdjustStockUseCase } from '../../application/use-cases/adjust-stock.js';
import { CreateWarehouseUseCase } from '../../application/use-cases/create-warehouse.js';
import { DeactivateWarehouseUseCase, ListWarehousesUseCase } from '../../application/use-cases/warehouse-queries.js';
import { GetWarehouseUseCase } from '../../application/use-cases/warehouse-queries.js';
import { GetStockByProductUseCase, GetStockMovementsUseCase, GetStockSummaryUseCase } from '../../application/use-cases/stock-queries.js';
import { TransferStockUseCase } from '../../application/use-cases/transfer-stock.js';
import { UpdateWarehouseUseCase } from '../../application/use-cases/update-warehouse.js';
import { toStockMovementJSON, toWarehouseJSON } from './serializers.js';
import { ContextVariables } from './middlewares.js';

type Ctx = Context<{ Variables: ContextVariables }>;

function parsePositiveInt(value: string | undefined, fallback: number): number {
  const n = Number.parseInt(value ?? '', 10);
  return Number.isFinite(n) && n > 0 ? n : fallback;
}

// ── Warehouses ──────────────────────────────────────────────────────────────

export function listWarehousesController(useCase: ListWarehousesUseCase) {
  return async (c: Ctx) => {
    const warehouses = await useCase.execute(c.get('organizationId'));
    return c.json(warehouses.map(toWarehouseJSON), 200);
  };
}

export function createWarehouseController(useCase: CreateWarehouseUseCase) {
  return async (c: Ctx) => {
    const body = c.req.valid('json' as never) as {
      code: string;
      name: string;
      address?: string | null;
      establishmentId?: string | null;
      isDefault?: boolean;
    };
    const warehouse = await useCase.execute({ ...body, organizationId: c.get('organizationId') });
    return c.json(toWarehouseJSON(warehouse), 201);
  };
}

export function getWarehouseController(useCase: GetWarehouseUseCase) {
  return async (c: Ctx) => {
    const warehouse = await useCase.execute(c.get('organizationId'), c.req.param('id') ?? '');
    return c.json(toWarehouseJSON(warehouse), 200);
  };
}

export function updateWarehouseController(useCase: UpdateWarehouseUseCase) {
  return async (c: Ctx) => {
    const body = c.req.valid('json' as never) as {
      name?: string;
      address?: string | null;
      establishmentId?: string | null;
      isDefault?: boolean;
    };
    const warehouse = await useCase.execute({
      organizationId: c.get('organizationId'),
      warehouseId: c.req.param('id') ?? '',
      ...body,
    });
    return c.json(toWarehouseJSON(warehouse), 200);
  };
}

export function deactivateWarehouseController(useCase: DeactivateWarehouseUseCase) {
  return async (c: Ctx) => {
    await useCase.execute({ organizationId: c.get('organizationId'), warehouseId: c.req.param('id') ?? '' });
    return c.body(null, 204);
  };
}

// ── Stock ───────────────────────────────────────────────────────────────────

export function getStockByProductController(useCase: GetStockByProductUseCase) {
  return async (c: Ctx) => {
    const result = await useCase.execute(c.get('organizationId'), c.req.param('productId') ?? '');
    return c.json(result, 200);
  };
}

export function getStockSummaryController(useCase: GetStockSummaryUseCase) {
  return async (c: Ctx) => {
    // El caso de uso siempre soportó stockState; el controlador no lo leía, así
    // que el filtro "con stock / sin stock" era inalcanzable desde HTTP.
    const rawState = c.req.query('stockState');
    const stockState = rawState === 'with_stock' || rawState === 'without_stock' ? rawState : undefined;

    const result = await useCase.execute(c.get('organizationId'), {
      productId: c.req.query('productId') || undefined,
      warehouseId: c.req.query('warehouseId') || undefined,
      stockState,
      page: parsePositiveInt(c.req.query('page'), 1),
      pageSize: parsePositiveInt(c.req.query('pageSize'), 50),
    });
    return c.json(result, 200);
  };
}

export function getStockMovementsController(useCase: GetStockMovementsUseCase) {
  return async (c: Ctx) => {
    const productId = c.req.query('productId');
    if (!productId) {
      return c.json({ code: 'VALIDATION_ERROR', message: 'El filtro productId es obligatorio.' }, 422);
    }
    const result = await useCase.execute(c.get('organizationId'), {
      productId,
      warehouseId: c.req.query('warehouseId') || undefined,
      type: c.req.query('type') || undefined,
      referenceType: c.req.query('referenceType') || undefined,
      referenceId: c.req.query('referenceId') || undefined,
      from: c.req.query('from') || undefined,
      to: c.req.query('to') || undefined,
      page: parsePositiveInt(c.req.query('page'), 1),
      pageSize: parsePositiveInt(c.req.query('pageSize'), 50),
    });
    return c.json(result, 200);
  };
}

export function adjustStockController(useCase: AdjustStockUseCase) {
  return async (c: Ctx) => {
    const body = c.req.valid('json' as never) as {
      productId: string;
      warehouseId: string;
      quantity: string;
      unitCost?: string;
      currencyCode?: string;
      reasonCode: string;
      reason?: string;
    };
    const movement = await useCase.execute({
      organizationId: c.get('organizationId'),
      createdBy: c.get('userId'),
      ...body,
    });
    return c.json(toStockMovementJSON(movement), 201);
  };
}

export function transferStockController(useCase: TransferStockUseCase) {
  return async (c: Ctx) => {
    const body = c.req.valid('json' as never) as {
      productId: string;
      fromWarehouseId: string;
      toWarehouseId: string;
      quantity: string;
      notes?: string;
    };
    const { outMovement, inMovement } = await useCase.execute({
      organizationId: c.get('organizationId'),
      createdBy: c.get('userId'),
      ...body,
    });
    return c.json({ outMovement: toStockMovementJSON(outMovement), inMovement: toStockMovementJSON(inMovement) }, 201);
  };
}