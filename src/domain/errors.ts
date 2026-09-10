export interface ErrorDetail {
  field: string;
  message: string;
}

export abstract class AppError extends Error {
  abstract readonly code: string;
  abstract readonly httpStatus: number;
  readonly details?: ErrorDetail[];

  constructor(message: string, details?: ErrorDetail[]) {
    super(message);
    this.name = new.target.name;
    this.details = details;
    Object.setPrototypeOf(this, new.target.prototype);
  }
}

export class ValidationError extends AppError {
  readonly code = 'VALIDATION_ERROR';
  readonly httpStatus = 422;
  constructor(details: ErrorDetail[], message = 'La petición no es válida.') {
    super(message, details);
  }
}

export class OrganizationContextRequiredError extends AppError {
  readonly code = 'ORG_CONTEXT_REQUIRED';
  readonly httpStatus = 401;
  constructor(message = 'Falta el contexto de organización.') { super(message); }
}

export class UserContextRequiredError extends AppError {
  readonly code = 'USER_CONTEXT_REQUIRED';
  readonly httpStatus = 401;
  constructor(message = 'Falta el contexto de usuario.') { super(message); }
}

export class ForbiddenError extends AppError {
  readonly code = 'FORBIDDEN';
  readonly httpStatus = 403;
  constructor(message = 'Permiso insuficiente.') { super(message); }
}

export class WarehouseNotFoundError extends AppError {
  readonly code = 'WAREHOUSE_NOT_FOUND';
  readonly httpStatus = 404;
  constructor(message = 'Bodega no encontrada.') { super(message); }
}

export class ProductNotFoundError extends AppError {
  readonly code = 'PRODUCT_NOT_FOUND';
  readonly httpStatus = 404;
  constructor(message = 'Producto no encontrado.') { super(message); }
}

export class StockPositionNotFoundError extends AppError {
  readonly code = 'STOCK_POSITION_NOT_FOUND';
  readonly httpStatus = 404;
  constructor(message = 'Posición de stock no encontrada.') { super(message); }
}

export class InsufficientStockError extends AppError {
  readonly code = 'INSUFFICIENT_STOCK';
  readonly httpStatus = 422;
  constructor(message = 'Stock insuficiente.') { super(message); }
}

export class WarehouseCodeExistsError extends AppError {
  readonly code = 'WAREHOUSE_CODE_EXISTS';
  readonly httpStatus = 409;
  constructor(message = 'Ya existe una bodega con ese código en la organización.') { super(message); }
}

export class MultipleDefaultWarehousesError extends AppError {
  readonly code = 'MULTIPLE_DEFAULT_WAREHOUSES';
  readonly httpStatus = 409;
  constructor(message = 'Ya existe una bodega principal para la organización.') { super(message); }
}

export class CannotDeactivateWarehouseWithStockError extends AppError {
  readonly code = 'WAREHOUSE_HAS_STOCK';
  readonly httpStatus = 422;
  constructor(message = 'No se puede desactivar una bodega con stock.') { super(message); }
}

export class InvalidValuationMethodError extends AppError {
  readonly code = 'INVALID_VALUATION_METHOD';
  readonly httpStatus = 422;
  constructor(message = 'Método de valorización no soportado.') { super(message); }
}

export class ProductNotTrackedError extends AppError {
  readonly code = 'PRODUCT_NOT_TRACKED';
  readonly httpStatus = 422;
  constructor(message = 'El producto no lleva control de stock.') { super(message); }
}

export class InvalidAdjustmentReasonError extends AppError {
  readonly code = 'INVALID_ADJUSTMENT_REASON';
  readonly httpStatus = 422;
  constructor(message = 'Motivo de ajuste inválido.') { super(message); }
}

export class DefaultWarehouseMissingError extends AppError {
  readonly code = 'DEFAULT_WAREHOUSE_MISSING';
  readonly httpStatus = 422;
  constructor(message = 'La organización no tiene bodega principal.') { super(message); }
}

export class SameWarehouseTransferError extends AppError {
  readonly code = 'SAME_WAREHOUSE_TRANSFER';
  readonly httpStatus = 422;
  constructor(message = 'La bodega origen y destino deben ser distintas.') { super(message); }
}

export class PluginNotActiveError extends AppError {
  readonly code = 'PLUGIN_NOT_ACTIVE';
  readonly httpStatus = 403;
  constructor(message = 'El módulo de inventario no está activo para esta organización.') { super(message); }
}

export class InvalidCurrencyError extends AppError {
  readonly code = 'INVALID_CURRENCY';
  readonly httpStatus = 422;
  constructor(currencyCode: string) {
    super(`Moneda no soportada: ${currencyCode}.`);
  }
}

export class InvalidMoneyAmountError extends AppError {
  readonly code = 'INVALID_MONEY_AMOUNT';
  readonly httpStatus = 422;
  constructor(message = 'El monto ingresado no es válido.') { super(message); }
}