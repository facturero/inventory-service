# inventory-service — Guía de implementación (para opencode)

> **Objetivo.** Servicio de **inventario multi-bodega** con valorización por estrategia intercambiable (promedio ponderado / FIFO), kardex atómico y consumo de eventos de billing y purchases. Node + TS + Hono + Sequelize, **misma plantilla que `../product-service/`**.
>
> **Convención de dinero (proyecto):** costos en **centavos BIGINT** + Dinero.js v2. Cantidades como `DECIMAL(18,4)` (cantidades no son dinero — precisión suficiente para gramos, litros, unidades fraccionarias).
>
> **Multi-bodega desde el diseño**: modelo aguanta N bodegas por organización, pero al onboarding se auto-provisiona **UNA** bodega `PRINCIPAL` (`is_default=true`). El frontend puede ocultar el concepto cuando `warehouses.count === 1`.
>
> **Valorización con Strategy pattern**: interfaz `ValuationStrategy` con dos implementaciones (`WeightedAverageStrategy`, `FifoStrategy`). Cada organización elige el método al crear el producto (por defecto: promedio ponderado, estándar SRI Ecuador).
>
> **Contratos:** `openapi.yaml` y `asyncapi.yaml` en esta carpeta son la fuente de verdad.

---

## Reglas de oro

1. **Imita `../product-service/`** archivo por archivo (Clean Architecture, entidades con factories privados, `AppError` lanzado, repos factory `(tx?)`, `Repositories` + `UnitOfWork`, modelos `timestamps:false`/`underscored:true`/`CHAR(36)`, controladores factory + `validateJson`, wiring solo en `main.ts`, Outbox).
2. **Base propia `inventory_db`.** Referencias externas por ID.
3. **NO verifica JWT.** Cabeceras del gateway: `X-Organization-Id`, `X-User-Id`, `X-Country-Code`, `X-Permissions`. Todas las rutas (salvo `/health`) exigen `X-Organization-Id`.
4. **Aislamiento en TODA query.** Recurso de otra org → `404`.
5. **Dinero.js para toda aritmética de costos.** Cantidades sí pueden usar aritmética JS normal (son `DECIMAL`).
6. **Kardex atómico:** cada movimiento (entrada/salida/ajuste/transferencia) escribe en `stock_movements` y actualiza `stock_positions` **en la misma transacción con lock** (`SELECT ... FOR UPDATE`).
7. **Valorización estratificada por producto:** el producto declara su método (`valuation_method`), inventory aplica la estrategia correspondiente al calcular costo de salida.
8. **Estados de reserva** para el flujo híbrido con billing: soft reserve → confirm/release.
9. **Eventos vía Outbox** (`inventory.*`, en pasado). Relay pendiente. **Consume** eventos de organization, product, billing y purchase.
10. Tras cada fase: `npm run typecheck` y `npm test` verdes.

---

## Dependencias adicionales

```bash
npm install dinero.js @dinero.js/currencies decimal.js
```

`decimal.js` para las cantidades — evita problemas de precisión de floats en JS al sumar/restar fracciones (0.1 + 0.2 !== 0.3 con floats; con Decimal sí).

---

## Fase 1 — Bootstrap

Clona de `../product-service/`: tsconfig, .sequelizerc, sequelize.config.cjs, .gitignore, Dockerfile, vitest.config, package.json (mismas deps + `dinero.js` + `@dinero.js/currencies` + `decimal.js`).

`.env.example`:
```
NODE_ENV=development
PORT=3010
DB_HOST=localhost
DB_PORT=3306
DB_USER=inventory_user
DB_PASSWORD=secret
DB_NAME=inventory_db
CORS_ORIGIN=http://localhost:5173
RABBITMQ_URL=amqp://localhost:5672
```

Estructura layer-first: `src/{domain,application/use-cases,infrastructure/persistence,interface/http,shared,__tests__}` + `migrations/`.

- [ ] `npm install && npm run typecheck` OK.

---

## Fase 2 — Migración

`migrations/<ts>-create-inventory-tables.js`:

**`warehouses`** (bodegas)
```
id                char(36)     PK
organization_id   char(36)     NN
establishment_id  char(36)     null  ← ref opcional a organization.establishments
code              varchar(20)  NN    ← 'PRINCIPAL', 'SUC-NORTE', 'CAMIONETA-01'…
name              varchar(255) NN
address           varchar(255) null
is_default        boolean      NN def false  ← una por org
status            enum(active,inactive) NN def active
created_at        datetime
updated_at        datetime
UNIQUE (organization_id, code)
UNIQUE INDEX (organization_id) WHERE is_default = true  ← solo 1 default por org
```

**`stock_positions`** (posición actual por producto + bodega)
```
id                     char(36)      PK
organization_id        char(36)      NN
product_id             char(36)      NN
warehouse_id           char(36)      NN
quantity_on_hand       decimal(18,4) NN def 0    ← física en bodega
quantity_reserved      decimal(18,4) NN def 0    ← apartada para pedidos/facturas
quantity_available     decimal(18,4) NN def 0    ← on_hand - reserved (denorm para queries rápidas)
average_cost_cents     bigint        NN def 0    ← costo promedio ponderado
currency_code          char(3)       NN def 'USD'
updated_at             datetime
UNIQUE (product_id, warehouse_id)
INDEX (organization_id, product_id)
```

**`stock_movements`** (kardex — historial completo, inmutable)
```
id                 char(36)      PK
organization_id    char(36)      NN
product_id         char(36)      NN
warehouse_id       char(36)      NN
type               enum(purchase_in, sale_out, transfer_out, transfer_in, adjustment_in, adjustment_out, reservation, release, opening_balance) NN
quantity           decimal(18,4) NN     ← siempre positiva; el `type` indica signo lógico
unit_cost_cents    bigint        null   ← costo unitario del movimiento (para entradas)
total_cost_cents   bigint        null   ← quantity * unit_cost (para valorización FIFO)
currency_code      char(3)       NN def 'USD'
reference_type     varchar(30)   null   ← 'invoice', 'purchase_order', 'adjustment', 'transfer'
reference_id       char(36)      null
notes              text          null
created_by         char(36)      NN     ← user_id del contexto
created_at         datetime
INDEX (product_id, warehouse_id, created_at)
INDEX (reference_type, reference_id)
```

**`stock_layers`** (para FIFO — lotes de entradas pendientes de despachar)
```
id                    char(36)      PK
organization_id       char(36)      NN
product_id            char(36)      NN
warehouse_id          char(36)      NN
entry_movement_id     char(36)      NN  ← FK → stock_movements
quantity_remaining    decimal(18,4) NN  ← cuánto queda de este lote por consumir
unit_cost_cents       bigint        NN
currency_code         char(3)       NN
entered_at            datetime      NN  ← para orden FIFO
INDEX (product_id, warehouse_id, entered_at) WHERE quantity_remaining > 0
```

> **Nota:** para promedio ponderado, `stock_layers` NO se usa. Solo se actualiza `stock_positions.average_cost_cents`.

**`reservations`** (para flujo híbrido con billing)
```
id                char(36)      PK
organization_id   char(36)      NN
product_id        char(36)      NN
warehouse_id      char(36)      NN
quantity          decimal(18,4) NN
reference_type    varchar(30)   NN   ← 'invoice_draft', 'sales_order'…
reference_id      char(36)      NN
status            enum(active, confirmed, released, expired) NN def active
expires_at        datetime      null ← reservas con TTL (opcional)
created_at        datetime
updated_at        datetime
INDEX (reference_type, reference_id)
INDEX (product_id, warehouse_id, status)
```

**Read-models (alimentados por eventos):**

**`products`** (subset del producto para saber su método de valorización y `allow_negative_stock`)
```
id                    char(36)     PK
organization_id       char(36)     NN
name                  varchar(255)
sku                   varchar(64)  null
type                  enum(good, service)
track_stock           boolean      NN
allow_negative_stock  boolean      NN def false  ← NUEVO CAMPO EN PRODUCT-SERVICE
valuation_method      enum(weighted_average, fifo) NN def weighted_average
status                enum(active, inactive)
```

**`outbox_messages`** + **`processed_events`**

- [ ] `npm run db:migrate` limpio; `undo` revierte.

---

## Fase 3 — Dominio (`src/domain/`)

### 3.1 Value objects (`value-objects.ts`)

**`Money`** — idéntico al de product-service (Dinero.js encapsulado).

**`Quantity`** — envuelve `Decimal.js` para operaciones con cantidades:
```ts
import Decimal from 'decimal.js';

export class Quantity {
  private constructor(private readonly value: Decimal) {}

  static fromNumber(n: number): Quantity { return new Quantity(new Decimal(n)); }
  static fromString(s: string): Quantity { return new Quantity(new Decimal(s)); }

  add(other: Quantity): Quantity { return new Quantity(this.value.plus(other.value)); }
  subtract(other: Quantity): Quantity { return new Quantity(this.value.minus(other.value)); }
  multiply(n: number | string): Quantity { return new Quantity(this.value.times(n)); }

  isZero(): boolean { return this.value.isZero(); }
  isPositive(): boolean { return this.value.isPositive(); }
  isNegative(): boolean { return this.value.isNegative(); }
  gte(other: Quantity): boolean { return this.value.gte(other.value); }

  toString(): string { return this.value.toFixed(4); }
  toNumber(): number { return this.value.toNumber(); }
}
```

### 3.2 Entidades (`entities.ts`)

- **`Warehouse`** — `id, organizationId, establishmentId|null, code, name, address|null, isDefault, status`. Métodos `create`, `update`, `deactivate`. Regla: no se puede desactivar una bodega con stock > 0.

- **`StockPosition`** — `id, organizationId, productId, warehouseId, quantityOnHand, quantityReserved, quantityAvailable, averageCost (Money), currencyCode, updatedAt`. Métodos:
  - `applyEntry({ quantity, unitCost, method })` — para entradas, actualiza average o crea layer FIFO.
  - `applyExit({ quantity, valuationStrategy })` — para salidas, calcula costo saliente.
  - `reserve(quantity)` — incrementa `quantity_reserved`.
  - `releaseReservation(quantity)` — decrementa.
  - `confirmReservation(quantity, valuationStrategy)` — decrementa reserva Y descuenta on-hand.

- **`StockMovement`** — inmutable. Factory `create({ ... })`. No hay update/delete.

- **`StockLayer`** — inmutable en principio, pero `quantityRemaining` decrece cuando FIFO consume. Se marca inactivo (soft) cuando llega a 0.

- **`Reservation`** — `id, organizationId, productId, warehouseId, quantity, referenceType, referenceId, status, expiresAt|null`. Métodos `confirm`, `release`, `expire`.

### 3.3 Estrategias de valorización (`valuation/`)

```ts
// domain/valuation/strategy.ts
export interface ValuationStrategy {
  /** Recalcula la posición al entrar unidades nuevas. */
  onEntry(position: StockPosition, quantity: Quantity, unitCost: Money): StockPositionUpdate;
  /** Calcula el costo de salir X unidades. Devuelve el costo saliente. */
  onExit(position: StockPosition, quantity: Quantity, layers?: StockLayer[]): CostOfGoodsSold;
}

export class WeightedAverageStrategy implements ValuationStrategy {
  onEntry(pos, qty, cost) {
    // new_avg = (on_hand * avg + qty * cost) / (on_hand + qty)
    // Con Dinero.js.
  }
  onExit(pos, qty) {
    // total_cost = qty * avg. El avg no cambia al salir.
  }
}

export class FifoStrategy implements ValuationStrategy {
  onEntry(pos, qty, cost) {
    // Crea un StockLayer nuevo. average_cost se recalcula solo para display.
  }
  onExit(pos, qty, layers) {
    // Consume layers en orden entered_at ASC. Puede consumir varios.
    // Devuelve la suma ponderada de los costos consumidos.
  }
}

export class ValuationStrategyFactory {
  static for(method: 'weighted_average' | 'fifo'): ValuationStrategy {
    if (method === 'fifo') return new FifoStrategy();
    return new WeightedAverageStrategy();
  }
}
```

### 3.4 Errores (`errors.ts`)

`AppError` + `ValidationError(422)`, `OrganizationContextRequiredError(401)`, `ForbiddenError(403)`, `WarehouseNotFoundError(404)`, `ProductNotFoundError(404)`, `StockPositionNotFoundError(404)`, `InsufficientStockError(422)`, `WarehouseCodeExistsError(409)`, `MultipleDefaultWarehousesError(409)`, `CannotDeactivateWarehouseWithStockError(422)`, `ReservationNotFoundError(404)`, `ReservationAlreadyResolvedError(422)`, `InvalidValuationMethodError(422)`, `ProductNotTrackedError(422)`.

### 3.5 Repositorios (`repositories.ts`)

```ts
WarehouseRepository: findById, findByCode, findDefaultByOrg, list, save, delete
StockPositionRepository: findByProductAndWarehouse (LOCK), listByProduct, listByWarehouse, save
StockMovementRepository: save (insert-only), listByProduct, listByReference
StockLayerRepository: listActiveByProduct (order entered_at ASC, LOCK), save
ReservationRepository: findById, findActiveByReference, save
ProductReadModelRepository: findById, upsert
OutboxRepository: add
```

Agregado `Repositories` + `UnitOfWork`.

- [ ] `typecheck` OK.

---

## Fase 4 — Persistencia (`src/infrastructure/persistence/`)

`sequelize.ts`, `models.ts` (asociaciones), `repositories.ts` (mappers, factories `(tx?)`, `buildRepositories`, `SequelizeUnitOfWork`).

Uso de locks pesimistas al consultar `stock_positions`:
```ts
async findByProductAndWarehouse(productId, warehouseId, tx?) {
  return await StockPositionModel.findOne({
    where: { product_id: productId, warehouse_id: warehouseId },
    lock: tx ? tx.LOCK.UPDATE : undefined,
    transaction: tx,
  });
}
```

- [ ] `typecheck` OK.

---

## Fase 5 — Casos de uso (`src/application/use-cases/`)

### 5.1 Bodegas
- `CreateWarehouseUseCase` — valida code único por org; si `isDefault`, quita el flag a la actual default; emite `inventory.warehouse.created`.
- `UpdateWarehouseUseCase` — cambios básicos + toggle default.
- `ListWarehousesUseCase`, `GetWarehouseUseCase`.
- `DeactivateWarehouseUseCase` — falla si `total_stock > 0`.

### 5.2 Consultas de stock
- `GetStockByProductUseCase(orgId, productId)` — devuelve `[{ warehouse, on_hand, reserved, available, avg_cost }]`.
- `GetStockSummaryUseCase(orgId)` — resumen paginado con filtros (bajo mínimo, con stock, sin stock).
- `GetStockMovementsUseCase(orgId, productId, warehouseId?, from?, to?)` — kardex paginado.

### 5.3 Movimientos manuales
- `AdjustStockUseCase({ orgId, productId, warehouseId, quantity (positiva o negativa), reason, unitCost? })` — ajuste con motivo. Emite `inventory.stock.adjusted`.
- `TransferStockUseCase({ orgId, productId, fromWarehouseId, toWarehouseId, quantity })` — genera dos movimientos atómicos (`transfer_out` + `transfer_in`). Emite `inventory.stock.transferred`.
- `SetOpeningBalanceUseCase` — para migración inicial de datos.

### 5.4 Reservas (flujo híbrido)
- `ReserveStockUseCase({ orgId, productId, warehouseId, quantity, referenceType, referenceId, allowNegative })`:
  - Si `allowNegative=false` (leído del product read-model) y `available < quantity` → `InsufficientStockError`.
  - Crea `Reservation` + incrementa `quantity_reserved`. Emite `inventory.stock.reserved`.
- `ConfirmReservationUseCase({ orgId, referenceType, referenceId })`:
  - Busca reservas activas por referencia.
  - Aplica `ValuationStrategy.onExit` → calcula costo saliente.
  - Genera `StockMovement (sale_out)` con `unit_cost_cents`.
  - Decrementa `quantity_reserved` y `quantity_on_hand`.
  - Emite `inventory.stock.consumed` con `unit_cost_cents` y `total_cost_cents`.
- `ReleaseReservationUseCase({ orgId, referenceType, referenceId })`:
  - Marca reserva como `released`, decrementa `quantity_reserved`. Emite `inventory.reservation.released`.

### 5.5 Consumidores de eventos externos

**`purchase.purchase_order.received` → `RegisterPurchaseEntryUseCase`**
Entrada de stock desde compra. Recibe `productId, warehouseId, quantity, unitCost, currencyCode, purchaseOrderId`.
- Aplica `ValuationStrategy.onEntry`.
- Genera `StockMovement (purchase_in)` + actualiza `stock_positions` + crea `stock_layers` si FIFO.
- Emite `inventory.stock.entered`.

**`billing.invoice.issued` → `HandleInvoiceIssuedUseCase`**
Flujo híbrido:
- Por cada línea con `productId` de tipo `good` y `track_stock=true`:
  - Si ya hay reserva activa para `invoice_draft:{invoiceId}` → `ConfirmReservationUseCase`.
  - Si NO hay reserva (billing emitió directo sin reservar) → generar `sale_out` directo. Verifica `allow_negative_stock`.
- Emite `inventory.stock.consumed` por cada línea.

**`billing.invoice.voided` → `HandleInvoiceVoidedUseCase`**
- Reversa: genera `adjustment_in` con motivo "anulación factura {invoiceId}". Repone el stock.
- Nota: la reposición usa el costo del movimiento original (buscar en `stock_movements` por `reference_id`).
- Emite `inventory.stock.entered` (tipo compensación).

**`billing.invoice.draft.line_added` → `ReserveStockUseCase`** (si se implementa el flujo con reserva).

**`product.product.updated` → `RefreshProductReadModelUseCase`**
Solo interesa `track_stock`, `allow_negative_stock`, `valuation_method`, `status`.

**`organization.establishment.created` → `EnsureWarehouseForEstablishmentUseCase`**
Auto-provisiona bodega para el nuevo establecimiento (opcional, según config).

**`organization.org.updated` → `EnsureDefaultWarehouseUseCase`** (idempotente)
Cuando la org recibe su country_code por primera vez, crea la bodega `PRINCIPAL` si no existe.

- [ ] Casos de uso implementados.

---

## Fase 6 — HTTP (`src/interface/http/`)

**`middlewares.ts`**: `contextMiddleware`, `requireOrganization` (401), `requirePermission(perm)` (403), `errorHandler`.

**`validators.ts`**: `validateJson` + Zod schemas para cada endpoint del `openapi.yaml`.

**`controllers.ts`**: factories; `organizationId` y `userId` del contexto.

**`routes.ts` + `app.ts`**: monta **exactamente** lo del `openapi.yaml`. CORS con `X-*`. `contextMiddleware` global.

- [ ] Rutas montadas según `openapi.yaml`.

---

## Fase 7 — Composition root + consumers

`main.ts` (puerto 3010): `sequelize.authenticate()`, `buildRepositories()` + `SequelizeUnitOfWork`, `startConsumers` para todos los eventos consumidos (idempotencia con `processed_events`).

- [ ] `build` OK; `/health` responde.

---

## Fase 8 — Tests (`src/__tests__/`)

Repos fake en memoria. Cubrir:
- **Warehouse:** crear + no permitir dos default; deactivate falla con stock > 0.
- **WeightedAverageStrategy:** entradas escalonadas actualizan promedio correctamente con Dinero.js (100 a $10 + 100 a $12 = avg $11).
- **FifoStrategy:** consume layers en orden; múltiples layers se consumen parcialmente correctamente.
- **Reservation:** flujo happy path (reservar → confirmar); release; expiración; doble confirmación → error.
- **allow_negative_stock=false:** reserva con available < qty → `InsufficientStockError`.
- **allow_negative_stock=true:** reserva/venta directa permite stock negativo, emite `inventory.stock.negative`.
- **Transfer:** movimientos atómicos; falla en medio deja consistente.
- **HandleInvoiceIssued:** flujo con reserva previa vs. venta directa.
- **HandleInvoiceVoided:** reposición correcta.

- [ ] `npm test` verde.

---

## Definición de "hecho"

1. `db:migrate` crea las 6 tablas + read-models + outbox.
2. Auto-provisión: `organization.org.updated` → crea bodega `PRINCIPAL` idempotente.
3. `POST /warehouses` crea bodega adicional; valida code único; `isDefault` toggle correcto.
4. `POST /stock/adjustments { productId, warehouseId, quantity: 100, unitCost: "10.00" }` incrementa on_hand y actualiza average_cost.
5. Segundo ajuste de 100 unidades a $12.00 con promedio → `average_cost = 1100` (centavos = $11.00).
6. Con FIFO en el producto, dos entradas escalonadas generan dos `stock_layers` distintos.
7. Reserva con `allow_negative_stock=false` y stock insuficiente → 422.
8. `billing.invoice.issued` con línea de producto tracked → genera `sale_out`; si había reserva previa, la confirma.
9. `billing.invoice.voided` → genera `adjustment_in` reponiendo stock al costo original.
10. `GET /stock?productId=X` devuelve posiciones por bodega con on_hand, reserved, available, avg_cost.
11. `GET /stock/movements?productId=X` devuelve kardex ordenado por fecha.
12. `npm test` + `npm run build` OK.

---

## Fuera de alcance (no hacer en Fase 1)

- **Lotes y fechas de vencimiento** (Fase 2 — trazabilidad).
- **Números de serie individuales** (Fase 2).
- **Ubicaciones dentro de bodega** (Fase 2).
- **Toma de inventario físico** con generación masiva de ajustes (Fase 2 — importante pero no crítico).
- **Stock mínimo y punto de reorden con alertas** (Fase 2).
- **Listas de materiales (BOM) y órdenes de producción** (Fase 3).
- **Multi-moneda operativa** (cada bodega maneja UNA currency; conversión es responsabilidad de reportes).
- **MRP** (Fase 3+).

## Cambios requeridos en product-service

Este servicio depende de dos campos nuevos en producto que hay que agregar:

- [ ] `allow_negative_stock BOOLEAN NN DEFAULT FALSE` en `product.products`
- [ ] `valuation_method ENUM('weighted_average', 'fifo') NN DEFAULT 'weighted_average'` en `product.products`

Ambos se emiten en el payload de `product.product.created/updated`. Documentar en `product-service/docs/INVENTARIO.md` cuando se implemente.
