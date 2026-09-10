import { randomUUID } from 'node:crypto';
import { CostOfGoodsSold, StockPositionUpdate, ValuationStrategy, ValuationStrategyFactory, ValuationMethod } from './valuation/strategy.js';
import { Money, Quantity } from './value-objects.js';

// ── Tipos compartidos ───────────────────────────────────────────────────────

export type WarehouseStatus = 'active' | 'inactive';
export type ProductStatus = 'active' | 'inactive';
export type ProductType = 'good' | 'service';
export type PluginStatus = 'active' | 'disabled';

export type MovementType =
  | 'purchase_in'
  | 'sale_out'
  | 'transfer_out'
  | 'transfer_in'
  | 'adjustment_in'
  | 'adjustment_out'
  | 'reservation'
  | 'release'
  | 'opening_balance';

export type AccountingNature =
  | 'inventory_in'
  | 'inventory_gain'
  | 'cogs'
  | 'expense'
  | 'shrinkage'
  | 'internal_transfer';

// ── Warehouse ───────────────────────────────────────────────────────────────

export interface WarehouseProps {
  id: string;
  organizationId: string;
  establishmentId: string | null;
  code: string;
  name: string;
  address: string | null;
  isDefault: boolean;
  status: WarehouseStatus;
  createdAt: Date;
  updatedAt: Date;
}

export class Warehouse {
  private constructor(private props: WarehouseProps) {}

  static create(params: {
    organizationId: string;
    code: string;
    name: string;
    address?: string | null;
    establishmentId?: string | null;
    isDefault?: boolean;
  }): Warehouse {
    const now = new Date();
    return new Warehouse({
      id: randomUUID(),
      organizationId: params.organizationId,
      code: params.code,
      name: params.name,
      address: params.address ?? null,
      establishmentId: params.establishmentId ?? null,
      isDefault: params.isDefault ?? false,
      status: 'active',
      createdAt: now,
      updatedAt: now,
    });
  }

  static fromPersistence(props: WarehouseProps): Warehouse {
    return new Warehouse({ ...props });
  }

  get id(): string { return this.props.id; }
  get organizationId(): string { return this.props.organizationId; }
  get establishmentId(): string | null { return this.props.establishmentId; }
  get code(): string { return this.props.code; }
  get name(): string { return this.props.name; }
  get address(): string | null { return this.props.address; }
  get isDefault(): boolean { return this.props.isDefault; }
  get status(): WarehouseStatus { return this.props.status; }
  get createdAt(): Date { return this.props.createdAt; }
  get updatedAt(): Date { return this.props.updatedAt; }

  belongsToOrganization(organizationId: string): boolean {
    return this.props.organizationId === organizationId;
  }

  update(params: { name?: string; address?: string | null; establishmentId?: string | null; isDefault?: boolean }): void {
    if (params.name !== undefined) this.props.name = params.name;
    if (params.address !== undefined) this.props.address = params.address;
    if (params.establishmentId !== undefined) this.props.establishmentId = params.establishmentId;
    if (params.isDefault !== undefined) this.props.isDefault = params.isDefault;
    this.props.updatedAt = new Date();
  }

  deactivate(): void {
    this.props.status = 'inactive';
    this.props.updatedAt = new Date();
  }

  toPersistence(): WarehouseProps {
    return { ...this.props };
  }
}

// ── StockPosition ───────────────────────────────────────────────────────────

export interface StockPositionProps {
  id: string;
  organizationId: string;
  productId: string;
  warehouseId: string;
  quantityOnHand: Quantity;
  quantityReserved: Quantity;
  quantityAvailable: Quantity;
  averageCost: Money;
  currencyCode: string;
  updatedAt: Date;
}

export class StockPosition {
  private constructor(private props: StockPositionProps) {}

  static create(params: { organizationId: string; productId: string; warehouseId: string; currencyCode: string }): StockPosition {
    const zero = Quantity.fromNumber(0);
    return new StockPosition({
      id: randomUUID(),
      organizationId: params.organizationId,
      productId: params.productId,
      warehouseId: params.warehouseId,
      quantityOnHand: zero,
      quantityReserved: zero,
      quantityAvailable: zero,
      averageCost: Money.fromCents(0, params.currencyCode),
      currencyCode: params.currencyCode,
      updatedAt: new Date(),
    });
  }

  static fromPersistence(props: {
    id: string;
    organizationId: string;
    productId: string;
    warehouseId: string;
    quantityOnHand: string;
    quantityReserved: string;
    quantityAvailable: string;
    averageCostCents: number;
    currencyCode: string;
    updatedAt: Date;
  }): StockPosition {
    return new StockPosition({
      id: props.id,
      organizationId: props.organizationId,
      productId: props.productId,
      warehouseId: props.warehouseId,
      quantityOnHand: Quantity.fromString(props.quantityOnHand),
      quantityReserved: Quantity.fromString(props.quantityReserved),
      quantityAvailable: Quantity.fromString(props.quantityAvailable),
      averageCost: Money.fromCents(props.averageCostCents, props.currencyCode),
      currencyCode: props.currencyCode,
      updatedAt: props.updatedAt,
    });
  }

  get id(): string { return this.props.id; }
  get organizationId(): string { return this.props.organizationId; }
  get productId(): string { return this.props.productId; }
  get warehouseId(): string { return this.props.warehouseId; }
  get quantityOnHand(): Quantity { return this.props.quantityOnHand; }
  get quantityReserved(): Quantity { return this.props.quantityReserved; }
  get quantityAvailable(): Quantity { return this.props.quantityAvailable; }
  get averageCost(): Money { return this.props.averageCost; }
  get currencyCode(): string { return this.props.currencyCode; }
  get updatedAt(): Date { return this.props.updatedAt; }

  belongsToOrganization(organizationId: string): boolean {
    return this.props.organizationId === organizationId;
  }

  hasStock(): boolean {
    return this.props.quantityOnHand.isPositive();
  }

  /** Aplica una entrada (compra, ajuste +, saldo inicial, reposición). Delega en
   *  la estrategia de valorización y actualiza la posición. NO valida nada del
   *  negocio (eso vive en el caso de uso). */
  applyEntry(params: { quantity: Quantity; unitCost: Money; method: ValuationMethod }): StockPositionUpdate {
    const strategy = ValuationStrategyFactory.for(params.method);
    const update = strategy.onEntry(this, params.quantity, params.unitCost);
    this.props.quantityOnHand = this.props.quantityOnHand.add(params.quantity);
    this.refreshAvailable();
    this.props.averageCost = update.averageCost;
    this.props.updatedAt = new Date();
    return update;
  }

  /** Aplica una salida (venta, ajuste -, transferencia out). Delega en la
   *  estrategia. NO valida stock suficiente: una salida ya facturada se registra
   *  aunque deje la posición negativa. Quien decide si era aceptable es el
   *  llamador. */
  applyExit(params: { quantity: Quantity; valuationStrategy: ValuationStrategy; layers?: StockLayer[] }): CostOfGoodsSold {
    const cogs = params.valuationStrategy.onExit(this, params.quantity, params.layers ?? []);
    this.props.quantityOnHand = this.props.quantityOnHand.subtract(params.quantity);
    this.refreshAvailable();
    this.props.updatedAt = new Date();
    return cogs;
  }

  private refreshAvailable(): void {
    // Fórmula completa, no el atajo (on_hand): cuando lleguen las reservas,
    // on_hand - reserved sigue siendo válido sin tocar las consultas.
    this.props.quantityAvailable = this.props.quantityOnHand.subtract(this.props.quantityReserved);
  }

  toPersistence() {
    return {
      id: this.props.id,
      organizationId: this.props.organizationId,
      productId: this.props.productId,
      warehouseId: this.props.warehouseId,
      quantityOnHand: this.props.quantityOnHand.toFixed(),
      quantityReserved: this.props.quantityReserved.toFixed(),
      quantityAvailable: this.props.quantityAvailable.toFixed(),
      averageCostCents: this.props.averageCost.toCents(),
      currencyCode: this.props.currencyCode,
      updatedAt: this.props.updatedAt,
    };
  }
}

// ── StockMovement (kardex, inmutable) ──────────────────────────────────────

export interface StockMovementProps {
  id: string;
  organizationId: string;
  productId: string;
  warehouseId: string;
  type: MovementType;
  quantity: Quantity;
  unitCostCents: number | null;
  totalCostCents: number | null;
  currencyCode: string;
  referenceType: string | null;
  referenceId: string | null;
  accountingNature: AccountingNature;
  reasonCode: string | null;
  lotId: string | null;
  notes: string | null;
  createdBy: string;
  createdAt: Date;
}

export class StockMovement {
  private constructor(private props: StockMovementProps) {}

  static create(params: Omit<StockMovementProps, 'id' | 'createdAt'>): StockMovement {
    return new StockMovement({ ...params, id: randomUUID(), createdAt: new Date() });
  }

  static fromPersistence(props: StockMovementProps): StockMovement {
    return new StockMovement({ ...props });
  }

  get id(): string { return this.props.id; }
  get organizationId(): string { return this.props.organizationId; }
  get productId(): string { return this.props.productId; }
  get warehouseId(): string { return this.props.warehouseId; }
  get type(): MovementType { return this.props.type; }
  get quantity(): Quantity { return this.props.quantity; }
  get unitCostCents(): number | null { return this.props.unitCostCents; }
  get totalCostCents(): number | null { return this.props.totalCostCents; }
  get currencyCode(): string { return this.props.currencyCode; }
  get referenceType(): string | null { return this.props.referenceType; }
  get referenceId(): string | null { return this.props.referenceId; }
  get accountingNature(): AccountingNature { return this.props.accountingNature; }
  get reasonCode(): string | null { return this.props.reasonCode; }
  get lotId(): string | null { return this.props.lotId; }
  get notes(): string | null { return this.props.notes; }
  get createdBy(): string { return this.props.createdBy; }
  get createdAt(): Date { return this.props.createdAt; }

  toPersistence(): StockMovementProps {
    return { ...this.props };
  }
}

// ── StockLayer (FIFO) ───────────────────────────────────────────────────────

export interface StockLayerProps {
  id: string;
  organizationId: string;
  productId: string;
  warehouseId: string;
  entryMovementId: string;
  quantityRemaining: Quantity;
  unitCostCents: number;
  currencyCode: string;
  enteredAt: Date;
  lotId: string | null;
}

export class StockLayer {
  private constructor(private props: StockLayerProps) {}

  static create(params: {
    organizationId: string;
    productId: string;
    warehouseId: string;
    entryMovementId: string;
    quantityRemaining: Quantity;
    unitCost: Money;
    enteredAt: Date;
  }): StockLayer {
    return new StockLayer({
      id: randomUUID(),
      organizationId: params.organizationId,
      productId: params.productId,
      warehouseId: params.warehouseId,
      entryMovementId: params.entryMovementId,
      quantityRemaining: params.quantityRemaining,
      unitCostCents: params.unitCost.toCents(),
      currencyCode: params.unitCost.toCurrencyCode(),
      enteredAt: params.enteredAt,
      lotId: null, // RESERVADO. Siempre null en esta fase.
    });
  }

  static fromPersistence(props: StockLayerProps): StockLayer {
    return new StockLayer({ ...props });
  }

  get id(): string { return this.props.id; }
  get organizationId(): string { return this.props.organizationId; }
  get productId(): string { return this.props.productId; }
  get warehouseId(): string { return this.props.warehouseId; }
  get entryMovementId(): string { return this.props.entryMovementId; }
  get quantityRemaining(): Quantity { return this.props.quantityRemaining; }
  get unitCostCents(): number { return this.props.unitCostCents; }
  get currencyCode(): string { return this.props.currencyCode; }
  get enteredAt(): Date { return this.props.enteredAt; }
  get lotId(): string | null { return this.props.lotId; }

  isExhausted(): boolean {
    return !this.props.quantityRemaining.isPositive();
  }

  /** Decrece la cantidad restante cuando FIFO consume. Marca vacío al llegar a 0. */
  consume(quantity: Quantity): void {
    this.props.quantityRemaining = this.props.quantityRemaining.subtract(quantity);
  }

  toPersistence(): StockLayerProps {
    return { ...this.props };
  }
}

// ── Product (read-model local) ──────────────────────────────────────────────

export interface ProductReadModelProps {
  id: string;
  organizationId: string;
  name: string | null;
  sku: string | null;
  type: ProductType | null;
  trackStock: boolean;
  allowNegativeStock: boolean;
  valuationMethod: ValuationMethod;
  status: ProductStatus | null;
  inventoryAccountCode: string | null;
  cogsAccountCode: string | null;
  expenseAccountCode: string | null;
}

export class ProductReadModel {
  private constructor(private props: ProductReadModelProps) {}

  static upsert(params: {
    id: string;
    organizationId: string;
    name?: string | null;
    sku?: string | null;
    type?: ProductType | null;
    trackStock?: boolean;
    allowNegativeStock?: boolean;
    valuationMethod?: ValuationMethod;
    status?: ProductStatus | null;
    inventoryAccountCode?: string | null;
    cogsAccountCode?: string | null;
    expenseAccountCode?: string | null;
  }): ProductReadModel {
    return new ProductReadModel({
      id: params.id,
      organizationId: params.organizationId,
      name: params.name ?? null,
      sku: params.sku ?? null,
      type: params.type ?? null,
      trackStock: params.trackStock ?? false,
      allowNegativeStock: params.allowNegativeStock ?? false,
      valuationMethod: params.valuationMethod ?? 'weighted_average',
      status: params.status ?? null,
      inventoryAccountCode: params.inventoryAccountCode ?? null,
      cogsAccountCode: params.cogsAccountCode ?? null,
      expenseAccountCode: params.expenseAccountCode ?? null,
    });
  }

  static fromPersistence(props: ProductReadModelProps): ProductReadModel {
    return new ProductReadModel({ ...props });
  }

  get id(): string { return this.props.id; }
  get organizationId(): string { return this.props.organizationId; }
  get name(): string | null { return this.props.name; }
  get sku(): string | null { return this.props.sku; }
  get type(): ProductType | null { return this.props.type; }
  get trackStock(): boolean { return this.props.trackStock; }
  get allowNegativeStock(): boolean { return this.props.allowNegativeStock; }
  get valuationMethod(): ValuationMethod { return this.props.valuationMethod; }
  get status(): ProductStatus | null { return this.props.status; }
  get inventoryAccountCode(): string | null { return this.props.inventoryAccountCode; }
  get cogsAccountCode(): string | null { return this.props.cogsAccountCode; }
  get expenseAccountCode(): string | null { return this.props.expenseAccountCode; }

  /** ¿El inventario lleva stock de este producto? Solo bienes con trackStock. */
  carriesStock(): boolean {
    return this.props.trackStock && this.props.type === 'good';
  }

  refresh(params: {
    name?: string | null;
    sku?: string | null;
    type?: ProductType | null;
    trackStock?: boolean;
    allowNegativeStock?: boolean;
    valuationMethod?: ValuationMethod;
    status?: ProductStatus | null;
  }): void {
    if (params.name !== undefined) this.props.name = params.name;
    if (params.sku !== undefined) this.props.sku = params.sku;
    if (params.type !== undefined) this.props.type = params.type;
    if (params.trackStock !== undefined) this.props.trackStock = params.trackStock;
    if (params.allowNegativeStock !== undefined) this.props.allowNegativeStock = params.allowNegativeStock;
    if (params.valuationMethod !== undefined) this.props.valuationMethod = params.valuationMethod;
    if (params.status !== undefined) this.props.status = params.status;
  }

  markInactive(): void {
    this.props.status = 'inactive';
  }

  toPersistence(): ProductReadModelProps {
    return { ...this.props };
  }
}

// ── OrganizationPlugin (read-model de activación) ──────────────────────────

export interface OrganizationPluginProps {
  organizationId: string;
  pluginCode: string;
  status: PluginStatus;
  updatedAt: Date;
}

export class OrganizationPlugin {
  private constructor(private props: OrganizationPluginProps) {}

  static create(params: { organizationId: string; pluginCode: string; status: PluginStatus }): OrganizationPlugin {
    return new OrganizationPlugin({
      organizationId: params.organizationId,
      pluginCode: params.pluginCode,
      status: params.status,
      updatedAt: new Date(),
    });
  }

  static fromPersistence(props: OrganizationPluginProps): OrganizationPlugin {
    return new OrganizationPlugin({ ...props });
  }

  get organizationId(): string { return this.props.organizationId; }
  get pluginCode(): string { return this.props.pluginCode; }
  get status(): PluginStatus { return this.props.status; }
  get updatedAt(): Date { return this.props.updatedAt; }

  isActive(): boolean {
    return this.props.status === 'active';
  }

  activate(): void {
    this.props.status = 'active';
    this.props.updatedAt = new Date();
  }

  deactivate(): void {
    this.props.status = 'disabled';
    this.props.updatedAt = new Date();
  }

  toPersistence(): OrganizationPluginProps {
    return { ...this.props };
  }
}

// ── InventoryGap (hueco de servicio apagado) ────────────────────────────────

export interface InventoryGapProps {
  id: string;
  organizationId: string;
  startedAt: Date;
  endedAt: Date | null;
  skippedMovements: number;
}

export class InventoryGap {
  private constructor(private props: InventoryGapProps) {}

  static create(params: { organizationId: string; startedAt: Date }): InventoryGap {
    return new InventoryGap({
      id: randomUUID(),
      organizationId: params.organizationId,
      startedAt: params.startedAt,
      endedAt: null,
      skippedMovements: 0,
    });
  }

  static fromPersistence(props: InventoryGapProps): InventoryGap {
    return new InventoryGap({ ...props });
  }

  get id(): string { return this.props.id; }
  get organizationId(): string { return this.props.organizationId; }
  get startedAt(): Date { return this.props.startedAt; }
  get endedAt(): Date | null { return this.props.endedAt; }
  get skippedMovements(): number { return this.props.skippedMovements; }

  isOpen(): boolean {
    return this.props.endedAt === null;
  }

  close(): void {
    if (this.isOpen()) this.props.endedAt = new Date();
  }

  incrementSkipped(count = 1): void {
    if (this.isOpen()) this.props.skippedMovements += count;
  }

  toPersistence(): InventoryGapProps {
    return { ...this.props };
  }
}