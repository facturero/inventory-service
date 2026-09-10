# inventory-service — Guía de implementación (para opencode)

> **Objetivo.** Servicio de **inventario multi-bodega** con valorización por estrategia intercambiable (promedio ponderado / FIFO), **kardex atómico** y consumo de eventos de billing. (El servicio de compras no existe todavía; su consumidor se deja preparado.) Node + TS + Hono + Sequelize, **misma plantilla que `../product-service/`**.
>
> **Convención de dinero (proyecto):** costos en **centavos BIGINT** + Dinero.js v2. Cantidades como `DECIMAL(18,4)` (cantidades no son dinero — precisión suficiente para gramos, litros, unidades fraccionarias).
>
> **Multi-bodega desde el diseño**: modelo aguanta N bodegas por organización, pero al onboarding se auto-provisiona **UNA** bodega `PRINCIPAL` (`is_default=true`). El frontend puede ocultar el concepto cuando `warehouses.count === 1`.
>
> **Valorización con Strategy pattern**: interfaz `ValuationStrategy` con dos implementaciones (`WeightedAverageStrategy`, `FifoStrategy`). Cada organización elige el método al crear el producto (por defecto: promedio ponderado, estándar SRI Ecuador).
>
> **Contratos:** `openapi.yaml` y `asyncapi.yaml` en esta carpeta son la fuente de verdad.
>
> **Mapa de fases.** La **0** y la **9** no tocan código de este servicio, y las dos hacen
> falta: la 0 porque sin permisos y sin base no hay nada que probar, la 9 porque sin gateway
> ni pantallas el trabajo no llega al usuario. Las fases 1 a 8 son el servicio en sí.
>
> | | |
> |---|---|
> | 0 | Permisos en auth + base de datos y compose. **Bloqueante.** |
> | 1-8 | El servicio: bootstrap, migración, dominio, persistencia, casos de uso, HTTP, wiring, tests. |
> | 9 | Rutas del gateway, catálogo de plugins, frontend, deuda de otros servicios. |

---

## Estado (2026-09-10)

**El servicio está construido.** Las fases 1 a 8 están hechas, la 0 y la 9 también. Lo que
sigue de este documento se mantiene como referencia de por qué las cosas son como son, no
como plan de trabajo pendiente.

| Fase | Estado |
|---|---|
| 0 — Permisos y base | ✅ Migración `20260910130000-add-inventory-permissions.js` en auth + par `inventory-migrate` / `inventory-service` en `docker-compose.yml`. |
| 1-8 — El servicio | ✅ 10 tablas, 9 consumidores, 53 pruebas en verde, `typecheck` y `build` limpios. |
| 9.1 — Gateway | ✅ `INVENTORY_SERVICE_URL` + rutas `/warehouses/*` y `/stock/*` con su plugin. |
| 9.2 — Catálogo | ✅ `inventory.kardex`, `inventory.warehouses` y `admin.audit_log` corregidos a `hecho`. |
| 9.3 — Frontend | ✅ 4 pantallas, tipos, cliente, store, rutas, menú y traducciones en 3 idiomas. |
| 9.4 — Deuda ajena | ⬜ Sigue pendiente: es de billing, del POS y de product-service. |

### 🔴 Lo que NADIE ha verificado todavía

Nada se ha ejecutado contra una base de datos real. Todo lo verde de arriba viene de pruebas
en memoria, comprobación de tipos y compilación. Sin levantar el entorno siguen **sin
comprobar**:

- Que `db:migrate` corra limpio y que `undo` revierta. La columna generada de MySQL y los
  índices son justo el tipo de cosa que compila en el papel y falla en el motor.
- Que las rutas respondan a través del gateway con un JWT real y los permisos recién
  sembrados.
- Que un `billing.invoice.issued` de verdad descuente en la bodega correcta.
- Que el frontend hable con el servicio.

El primer arranque del entorno es el siguiente paso, y hasta entonces la lista de
"Definición de hecho" está a medias a propósito.

### Puerto: 3013, no 3010

El documento original asignaba el 3010 sin comprobarlo y **`fiscal-ecuador` ya publica ese
puerto en el host**. `docker compose up` habría fallado al arrancar. Corregido en los ocho
sitios donde aparecía.

### Trampas encontradas construyendo

Cuatro cosas que costaron tiempo y que están aquí para que no cuesten dos veces.

1. **`src/__tests__` está excluido de `tsconfig.json`**, igual que en la plantilla de
   `product-service`. Un `npm run typecheck` verde **no dice nada** sobre las pruebas: se
   colaron importaciones de tipo usadas como valor y las 35 pruebas reventaban en ejecución
   con el chequeo en verde. Si algo falla solo al correr `npm test`, mira ahí primero.
2. **`Decimal(0).isPositive()` devuelve `true`** en decimal.js: el cero tiene signo positivo.
   `Quantity.isPositive()` usa `gt(0)` a propósito. No lo "simplifiques" delegando en
   decimal.js: bloquearía desactivar bodegas vacías y dejaría las capas FIFO agotadas como
   activas para siempre.
3. **La estrategia de valorización es pura.** `onExit` calcula qué capas consumir y cuánto,
   pero **no las modifica**. Quien decrementa y persiste es `applyStockExit`. Hay una prueba
   que recorre ese camino entero precisamente porque la separación no es evidente leyendo
   solo la estrategia.
4. **`stockState` existía en el caso de uso y el controlador lo tiraba.** El filtro de con y
   sin existencia era inalcanzable por HTTP. Ya está cableado y declarado en el `openapi.yaml`.

---

## Decisiones cerradas (2026-09-10)

Cinco puntos que el diseño dejaba abiertos y que ya están resueltos. El resto del
documento los da por hechos.

| Tema | Decisión |
|---|---|
| Bodega de la venta | Una bodega por establecimiento, auto-provisionada. La venta descuenta de la bodega del establecimiento emisor; si no existe, de la `PRINCIPAL`. |
| Lotes y caducidad | Fuera de alcance, pero el kardex nace con `lot_id` nulo para que añadirlos sea una migración y no una reescritura. |
| Contabilidad | Cada movimiento guarda su **naturaleza contable**. El ajuste manual la deriva de un **motivo tipificado**, no de texto libre. |
| Reservas | Fuera de alcance. Las tablas se crean, los endpoints no se montan. La venta descuenta al **emitir**, nunca en borrador. |
| Plugin apagado | **Es un módulo de pago: sin `inventory.kardex` activo no se lleva inventario, ni por HTTP ni por eventos.** Al reactivar, el stock arrastra un hueco declarado y hace falta conteo físico. |

**Por qué la naturaleza contable ahora.** El libro mayor todavía no existe, pero cuando
exista tendrá que generar asientos del histórico. Si el kardex no distingue una merma de
un consumo interno de una venta, ese histórico hay que clasificarlo a mano fila por fila.
La columna cuesta nada hoy.

---

## El plugin apagado apaga el servicio

**Esto es un módulo de pago.** Si una organización no tiene `inventory.kardex` activo, el
inventario **no se lleva**: ni por HTTP ni por eventos. Dar seguimiento de stock a quien no
lo paga es regalar el producto.

El gateway ya corta el HTTP con `requiresPlugin`, y ese camino no se duplica aquí: dos
comprobaciones con dos cachés distintas acaban discrepando. Lo que el gateway **no** puede
cortar es el camino de eventos, porque los mensajes de RabbitMQ nunca pasan por él. Ese corte
es responsabilidad de este servicio.

### Read-model de activación

Tabla propia alimentada por eventos, como manda la arquitectura. Nada de preguntarle a
plugin-catalog en cada mensaje.

```
organization_plugins
  organization_id   char(36)  NN
  plugin_code       varchar(60) NN
  status            enum(active, disabled) NN
  updated_at        datetime  NN
  UNIQUE (organization_id, plugin_code)
```

Se alimenta de `plugin.activated` y `plugin.deactivated`, que ya se publican y cuyo payload
trae `organizationId` y `code`. No hay que tocar plugin-catalog.

### La regla, y por qué no es simétrica

Antes de escribir cualquier movimiento nacido de un evento:

| Lo que sabe el servicio | Qué hace |
|---|---|
| Hay fila y dice `disabled` | **No escribe.** Registra el hueco y confirma el mensaje. |
| Hay fila y dice `active` | Escribe normal. |
| No hay fila | Consulta una vez a plugin-catalog, guarda el resultado y decide. |
| No hay fila y plugin-catalog no responde | **Escribe igual** y lo deja en el log. |

La última fila es la importante y es deliberadamente asimétrica. Solo se corta cuando se
**sabe** que el plugin está apagado. Ante duda o ante un catálogo caído, se procesa.

El motivo es que los dos errores no cuestan lo mismo. Escribir un movimiento de una
organización que no paga es una fuga comercial de unos minutos, reconciliable después. No
escribir un movimiento por una caída de red es una venta que desaparece del kardex **para
siempre**: el evento ya se confirmó, nadie lo va a reenviar y el stock queda mal sin que
nadie se entere. El gateway toma la misma decisión cuando sirve caché vencida en vez de
apagarle los módulos a quien ya los tenía.

### El hueco, y qué pasa al reactivar

Mientras el plugin está apagado se siguen vendiendo cosas y el kardex no las ve. Al
reactivar, **el stock no es confiable y hay que decirlo**, no dejar que el usuario crea unos
números que llevan meses sin actualizarse.

```
inventory_gaps
  id                 char(36) PK
  organization_id    char(36) NN
  started_at         datetime NN      ← llegó plugin.deactivated
  ended_at           datetime null    ← llegó plugin.activated; null = sigue abierto
  skipped_movements  int NN def 0     ← cuántos se dejaron de escribir
```

- `plugin.deactivated` de `inventory.kardex`: abre un hueco.
- Cada movimiento que se salta: incrementa `skipped_movements` del hueco abierto.
- `plugin.activated`: cierra el hueco y emite `inventory.stock.stale` con las fechas y el
  contador.

La pantalla de stock muestra un aviso mientras exista un hueco cerrado sin resolver: el
inventario estuvo apagado entre tal y tal fecha, se dejaron de registrar N movimientos, hay
que hacer un conteo físico antes de confiar en estas cifras. Se resuelve con
`SetOpeningBalanceUseCase`, que es exactamente para lo que existe.

**Lo que NO se hace:** guardar los eventos saltados para reprocesarlos al reactivar. Reponer
tres meses de ventas de golpe da un kardex con fechas falsas y una valorización inventada, y
además premia al que dejó de pagar. El conteo físico es la respuesta correcta y la que usa
cualquier ERP.

---

## El kardex vive aquí. La bitácora no es el kardex.

**Sí, el kardex es este servicio.** Es la tabla `stock_movements` en `inventory_db`, y
inventory-service es su único dueño. Nadie más escribe ahí. Cuando alguien pide "el kardex
del producto X", se sirve de `GET /stock/movements`, no de ningún otro sitio.

Conviene decirlo porque el sistema tiene **dos historiales** y se parecen lo suficiente como
para que alguien los confunda algún día:

| | Kardex (`inventory_db.stock_movements`) | Bitácora (`audit_db.audit_logs`) |
|---|---|---|
| Responde | Cuánto hay, cuánto costó, de dónde salió | Quién hizo qué y cuándo |
| Fuente | La transacción misma, con lock | El evento publicado después |
| Si falta una fila | El stock y la valorización están mal | Falta trazabilidad, el stock sigue bien |
| Se puede reconstruir de | Nada. Es la fuente de verdad. | Del kardex, si hiciera falta |

La regla que se sigue de esto: **el saldo se calcula del kardex, jamás de la bitácora.** La
bitácora depende de que el evento se publique y llegue; el kardex no depende de nada externo,
se escribe en la misma transacción que la posición. Si un día el relay del outbox se cae una
hora, la bitácora tendrá un hueco y el stock seguirá exacto. Al revés no puede pasar.

---

## Volumen de eventos: nadie los ignora, y ese es el problema

**Ningún evento de este servicio queda sin consumir.** `audit-log-service` bindea `#` con
`AUDIT_DENYLIST` vacía, así que **todo** lo que se publique en `crm.events` acaba como fila
en `audit_db`. La pregunta "¿emitimos eventos que nadie escucha?" no aplica: siempre hay
alguien escuchando.

Lo que sí aplica es el reverso. Cada evento emitido cuesta una fila de bitácora, y la
retención por defecto de audit es `0`, que significa **para siempre**. El inventario es, con
diferencia, el servicio más ruidoso del sistema: emite por **movimiento**, no por acción de
usuario. Una factura de cinco líneas es una acción del usuario y cinco eventos de consumo.

Cuentas de un local con punto de venta activo:

| | |
|---|---|
| Ventas por día | 300 |
| Líneas por venta | 3 |
| Filas de bitácora por día, solo por consumo de stock | 900 |
| Filas al año | 328 500 |

Frente a eso, tres reglas para esta fase:

1. **Un evento por movimiento del kardex, ni uno más.** No se emiten eventos de "posición
   actualizada" ni de "promedio recalculado": eso ya va dentro del movimiento.
2. **La transferencia emite un solo `inventory.stock.transferred`**, no un `entered` más un
   `consumed`. Son dos filas de kardex pero una sola acción, y el payload ya lleva origen y
   destino.
3. **Cuando la bitácora empiece a doler, la palanca es `AUDIT_DENYLIST`, no dejar de
   publicar.** Silenciar `inventory.stock.consumed` en audit es una línea de configuración y
   es reversible. Dejar de emitirlo rompe a cualquier consumidor futuro, y el primero de
   ellos será el generador de asientos contables.

Requisito que la bitácora impone y hay que respetar: todo mensaje lleva `eventId` en headers
y `organizationId` en el payload. Sin lo primero audit lo descarta con un warn; sin lo
segundo lo marca no auditable. El relay del outbox ya pone el header, pero un payload al que
se le olvide `organizationId` desaparece de la bitácora **en silencio**.

---

## Reglas de oro

1. **Imita `../product-service/`** archivo por archivo (Clean Architecture, entidades con factories privados, `AppError` lanzado, repos factory `(tx?)`, `Repositories` + `UnitOfWork`, modelos `timestamps:false`/`underscored:true`/`CHAR(36)`, controladores factory + `validateJson`, wiring solo en `main.ts`, Outbox).
2. **Base propia `inventory_db`.** Referencias externas por ID.
3. **NO verifica JWT.** Cabeceras del gateway: `X-Organization-Id`, `X-User-Id`, `X-Country-Code`, `X-Permissions`. Todas las rutas (salvo `/health`) exigen `X-Organization-Id`.
4. **Aislamiento en TODA query.** Recurso de otra org → `404`.
5. **Dinero.js para toda aritmética de costos.** Cantidades sí pueden usar aritmética JS normal (son `DECIMAL`).
6. **Kardex atómico:** cada movimiento (entrada/salida/ajuste/transferencia) escribe en `stock_movements` y actualiza `stock_positions` **en la misma transacción con lock** (`SELECT ... FOR UPDATE`).
7. **Valorización estratificada por producto:** el producto declara su método (`valuation_method`), inventory aplica la estrategia correspondiente al calcular costo de salida.
8. **La tabla `reservations` se crea vacía y nadie la escribe.** Ver la regla 12.
9. **Eventos vía Outbox** (`inventory.*`, en pasado). **Consume** eventos de organization,
   product y billing. El consumidor de compras se deja escrito, pero no existe servicio de
   compras que publique nada.
10. **Toda salida y toda entrada declara su naturaleza contable.** Ningún movimiento se
    escribe sin `accounting_nature`. Es la materia prima del futuro asiento.
11. **La bodega de una venta se resuelve por establecimiento**, nunca se asume la default
    sin haberlo intentado antes.
12. **Sin reservas en esta fase.** Si un caso de uso necesita apartar stock, se pospone.
13. **Ningún movimiento nacido de un evento se escribe sin comprobar que `inventory.kardex`
    está activo para esa organización.** Es un módulo de pago. Ver la sección
    "El plugin apagado apaga el servicio".
14. Tras cada fase: `npm run typecheck` y `npm test` verdes.

---

## Dependencias adicionales

```bash
npm install dinero.js @dinero.js/currencies decimal.js
```

`decimal.js` para las cantidades — evita problemas de precisión de floats en JS al sumar/restar fracciones (0.1 + 0.2 !== 0.3 con floats; con Decimal sí).

---

## Fase 0 — Lo que hay que hacer FUERA de este servicio para poder probarlo

Nada de esta fase vive en `inventory-service/`, y sin las dos primeras piezas el servicio
compila, arranca y **ninguna ruta responde**. Se hace primero porque cuesta poco y porque
descubrirlo en la fase 6, con todo escrito, es perder una tarde.

### 0.1 🔴 Permisos en auth-service (bloqueante)

El gateway valida ruta contra permiso **antes** de enrutar. `openapi.yaml` declara cinco
permisos propios y **ninguno de los cinco existe** en la semilla de auth. Sin esto, todo
responde `403` aunque el servicio esté perfecto.

```
inventory:read       consultar stock, kardex y bodegas
inventory:manage     crear / editar / desactivar bodegas
inventory:adjust     ajustes manuales y saldo inicial
inventory:transfer   transferencias entre bodegas
inventory:reserve    RESERVADO — el flujo de reserva es fase 2; se siembra igual
                     para no tener que tocar auth otra vez
```

Nueva migración en `../auth-service/migrations/`, **calcada de
`20260907120000-add-audit-read-permission.js`**, que es el patrón vigente y ya resuelve los
tres problemas del caso:

1. `uuidFromCode(code)` para que el id del permiso sea determinista.
2. `INSERT ... ON DUPLICATE KEY UPDATE` en `permissions` y `INSERT IGNORE` en
   `role_permissions`: idempotente, se puede correr sobre una base que ya tiene datos.
3. **Bumpear `permissions_version`** solo a los usuarios de los roles afectados. Sin ese
   bump, el token vigente no trae los permisos nuevos y el usuario los ve recién al expirar
   la sesión.

Reparto por rol, siguiendo el criterio que ya usan los otros permisos:

| Rol | Permisos |
|---|---|
| Administrador | los cinco |
| Supervisor | `read`, `adjust`, `transfer` |
| Contador | `read` |
| Solo lectura | `read` |

### 0.2 🔴 Base de datos y docker-compose (bloqueante)

`docker-compose.yml` levanta once servicios y **ninguno es este**. No existe `inventory_db`.

Añadir el par `inventory-migrate` + `inventory-service` copiando el bloque de
`product-service` (líneas ~210-250 del compose). Mismo patrón exacto: el contenedor de
migración corre `sequelize-cli db:migrate` y el servicio depende de que termine con
`service_completed_successfully`.

```yaml
    environment: &inventory-env
      DB_HOST: mysql
      DB_PORT: 3306
      DB_USER: root
      DB_PASSWORD: root123
      DB_NAME: inventory_db
      RABBITMQ_URL: amqp://rabbitmq:5672
      CORS_ORIGIN: http://localhost:5173
      INTERNAL_USER_ID: 00000000-0000-0000-0000-000000000000
      PLUGIN_CATALOG_SERVICE_URL: http://plugin-catalog-service:3011
```

Puerto `3013:3013`. **No 3010: `fiscal-ecuador` ya publica ese puerto en el host y
`docker compose up` fallaría al arrancar.** La base se crea sola: el usuario `root` del compose tiene permiso, y
sequelize-cli la crea al migrar si no existe.

`INTERNAL_USER_ID` importa aquí más que en otros servicios: `stock_movements.created_by` es
`NOT NULL` y los movimientos que nacen de un evento (venta, anulación, alta de bodega) no
tienen usuario humano detrás. Van con ese uuid de ceros.

---

## Fase 1 — Bootstrap

Clona de `../product-service/`: tsconfig, .sequelizerc, sequelize.config.cjs, .gitignore, Dockerfile, vitest.config, package.json (mismas deps + `dinero.js` + `@dinero.js/currencies` + `decimal.js`).

`.env.example`:
```
NODE_ENV=development
PORT=3013
DB_HOST=localhost
DB_PORT=3306
DB_USER=inventory_user
DB_PASSWORD=secret
DB_NAME=inventory_db
CORS_ORIGIN=http://localhost:5173
RABBITMQ_URL=amqp://localhost:5672
INTERNAL_USER_ID=00000000-0000-0000-0000-000000000000
PLUGIN_CATALOG_SERVICE_URL=http://localhost:3011
```

`PLUGIN_CATALOG_SERVICE_URL` es **solo para el arranque en frío** del read-model de
activación: cuando llega un evento de una organización de la que todavía no se sabe nada, se
consulta una vez, se guarda y no se vuelve a preguntar. No es una llamada por mensaje. Si la
variable falta, el servicio arranca igual y aplica la regla de "ante duda, procesa" descrita
en la sección del plugin. El puerto 3011 está verificado contra el compose y contra la URL
que ya usa el gateway.

`INTERNAL_USER_ID` no es opcional: `stock_movements.created_by` es `NOT NULL` y los
movimientos que nacen de un evento no tienen usuario humano detrás.

Estructura layer-first: `src/{domain,application/use-cases,infrastructure/persistence,interface/http,shared,__tests__}` + `migrations/`.

- [x] `npm install && npm run typecheck` OK.

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
UNIQUE (organization_id, establishment_id)   ← 1 bodega por establecimiento
default_org_id    char(36) GENERATED ALWAYS AS (IF(is_default, organization_id, NULL)) STORED
UNIQUE (default_org_id)                      ← 1 sola bodega default por organización
```

> ⚠️ **MySQL no tiene índices parciales.** El diseño original escribía
> `UNIQUE INDEX (organization_id) WHERE is_default = true`, que es sintaxis de PostgreSQL y
> no compila aquí. La forma que sí funciona en MySQL 8 es la columna generada de arriba: el
> valor es `NULL` cuando la bodega no es la default, y MySQL trata cada `NULL` como distinto,
> así que el único que colisiona es un segundo `is_default = true` de la misma organización.
>
> El mismo truco explica por qué `UNIQUE (organization_id, establishment_id)` **no** necesita
> cláusula: las bodegas sin establecimiento llevan `NULL` ahí y no chocan entre sí.

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
type               enum(purchase_in, sale_out, transfer_out, transfer_in, adjustment_in,
                        adjustment_out, reservation, release, opening_balance) NN
                                        ← `reservation` y `release` quedan en el enum pero
                                          NUNCA se escriben en esta fase
quantity           decimal(18,4) NN     ← siempre positiva; el `type` indica signo lógico
unit_cost_cents    bigint        null   ← costo unitario del movimiento (para entradas)
total_cost_cents   bigint        null   ← quantity * unit_cost (para valorización FIFO)
currency_code      char(3)       NN def 'USD'
reference_type     varchar(30)   null   ← 'invoice', 'purchase_order', 'adjustment', 'transfer'
reference_id       char(36)      null
accounting_nature  enum(inventory_in, inventory_gain, cogs, expense, shrinkage, internal_transfer) NN
                                        ← qué significa el movimiento para la contabilidad
reason_code        varchar(30)   null   ← solo ajustes; de aquí sale accounting_nature
lot_id             char(36)      null   ← RESERVADO. Siempre NULL en esta fase.
notes              text          null
created_by         char(36)      NN     ← user_id del contexto
created_at         datetime
INDEX (product_id, warehouse_id, created_at)
INDEX (reference_type, reference_id)
INDEX (organization_id, accounting_nature, created_at)  ← lo usará el generador de asientos
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
lot_id                char(36)      null ← RESERVADO. Siempre NULL en esta fase.
INDEX (product_id, warehouse_id, quantity_remaining, entered_at)
      ← sin cláusula WHERE: MySQL no tiene índices parciales. Se mete
        quantity_remaining en la clave para que el filtro > 0 use el índice.
```

> **Nota:** para promedio ponderado, `stock_layers` NO se usa. Solo se actualiza `stock_positions.average_cost_cents`.

> **Qué significa `unit_cost_cents` en una salida FIFO.** Cuando una venta consume tres capas
> a costos distintos, no existe *un* costo unitario. El dato con sentido es
> `total_cost_cents`, que es la suma exacta de lo consumido capa por capa. `unit_cost_cents`
> se guarda como `total_cost_cents / quantity` **redondeado, y solo para mostrar**. Ninguna
> aritmética posterior puede partir de él: reponer una anulación, valorar el inventario o
> armar un asiento se hacen siempre desde el total. Si se multiplica el unitario redondeado
> por la cantidad, el resultado no cuadra con el total y el descuadre se acumula.

**`reservations`** — ⚠️ **se crea la tabla, no se usa en esta fase.** Existe para que
añadir el flujo de reserva más adelante no obligue a migrar. Ningún caso de uso la escribe.

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
inventory_account_code varchar(20) null  ← cuenta de activo. NULL hasta que exista contabilidad.
cogs_account_code      varchar(20) null  ← cuenta de costo de ventas. NULL por ahora.
expense_account_code   varchar(20) null  ← cuenta de gasto. NULL por ahora.
```

> Las tres cuentas nacen nulas y **no bloquean nada**. El inventario nunca las lee en esta
> fase: solo las almacena si el evento de producto las trae. Quien las usará es el futuro
> generador de asientos, combinando `accounting_nature` del movimiento con la cuenta del
> producto.

**Motivos de ajuste y su naturaleza contable**

El ajuste manual no acepta motivo libre a secas: acepta un `reason_code` tipificado del que
se deriva `accounting_nature`. Es lo que distingue una merma de un consumo interno cuando
la contabilidad tenga que armar el asiento.

| `reason_code` | Signo | `accounting_nature` |
|---|---|---|
| `physical_count` | + | `inventory_gain` |
| `physical_count` | − | `shrinkage` |
| `damage` | − | `shrinkage` |
| `expiration` | − | `shrinkage` |
| `theft` | − | `shrinkage` |
| `internal_use` | − | `expense` |
| `correction` | ± | `inventory_gain` / `shrinkage` |

`opening_balance` **no** es motivo de ajuste: es un tipo de movimiento propio con su
caso de uso propio. Ponerlo en las dos listas daba dos caminos para escribir la misma fila.

El campo `reason` de texto libre se mantiene como nota para el humano.

**Costo de un ajuste positivo.** El `unitCost` es obligatorio solo cuando la entrada trae un
costo real de fuera, que hoy es únicamente el saldo inicial. Un sobrante de conteo físico no
tiene factura detrás: entra al **promedio vigente de la posición**, y si la posición está en
cero entra en cero. Cobrarle al usuario un costo inventado para cuadrar un conteo es peor
que registrar el sobrante a costo cero y que la contabilidad lo vea.

`reason_code` se declara `varchar(30)` en la tabla y se valida contra la lista con Zod en el
borde, igual que el resto de enums del proyecto. Es a propósito: añadir un motivo nuevo no
debería costar un `ALTER TABLE` sobre un kardex de millones de filas.

**Naturaleza contable por tipo de movimiento**

| `type` | `accounting_nature` |
|---|---|
| `purchase_in`, `opening_balance` | `inventory_in` |
| `sale_out` | `cogs` |
| `transfer_in`, `transfer_out` | `internal_transfer` |
| `adjustment_in`, `adjustment_out` | según `reason_code` |

**`organization_plugins`** (read-model de activación) y **`inventory_gaps`** (huecos de
servicio apagado) — el esquema de las dos está en la sección "El plugin apagado apaga el
servicio". Van en esta misma migración.

**`outbox_messages`** + **`processed_events`**

- [ ] `npm run db:migrate` limpio; `undo` revierte. ← **sin verificar**: falta correrlo
      contra MySQL. La columna generada y los índices no se han probado en el motor.

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
    **No** valida que haya suficiente: una salida ya facturada se registra aunque deje la
    posición negativa. Quien decide si eso era aceptable es el llamador.

  `reserve`, `releaseReservation` y `confirmReservation` **no se implementan en esta fase**.
  `quantityReserved` existe, vale siempre `0` y solo participa en la fórmula de
  `quantityAvailable`.

- **`StockMovement`** — inmutable. Factory `create({ ... })`. No hay update/delete. El
  factory **exige** `accountingNature`; no hay valor por defecto, precisamente para que
  ningún camino nuevo se olvide de declararla.

- **`StockLayer`** — inmutable en principio, pero `quantityRemaining` decrece cuando FIFO consume. Se marca inactivo (soft) cuando llega a 0.

- **`Reservation`** — ⚠️ **no se implementa en esta fase.** La tabla existe; la entidad,
  el repositorio y los casos de uso quedan para cuando se cablee el flujo de borrador.

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

`AppError` + `ValidationError(422)`, `OrganizationContextRequiredError(401)`, `ForbiddenError(403)`, `WarehouseNotFoundError(404)`, `ProductNotFoundError(404)`, `StockPositionNotFoundError(404)`, `InsufficientStockError(422)`, `WarehouseCodeExistsError(409)`, `MultipleDefaultWarehousesError(409)`, `CannotDeactivateWarehouseWithStockError(422)`, `InvalidValuationMethodError(422)`, `ProductNotTrackedError(422)`,
`InvalidAdjustmentReasonError(422)`, `DefaultWarehouseMissingError(422)`,
`SameWarehouseTransferError(422)`, `PluginNotActiveError(403)`. Los errores de reserva
llegarán con el flujo de reserva.

`PluginNotActiveError` casi nunca se lanza: el HTTP ya lo corta el gateway y el camino de
eventos no lanza, se salta en silencio y anota el hueco. Existe para el caso de que alguien
llame al servicio saltándose el gateway.

> **Dónde sigue vivo `InsufficientStockError`.** Ya no se lanza al facturar: una venta
> emitida se registra pase lo que pase. Queda para las dos operaciones que el usuario sí
> está haciendo en ese instante y sí se pueden negar: **transferir** más de lo que hay en la
> bodega origen, y **ajustar en negativo** por debajo de cero. Ahí decir que no todavía sirve
> de algo.

### 3.5 Repositorios (`repositories.ts`)

```ts
WarehouseRepository: findById, findByCode, findDefaultByOrg, list, save, delete
StockPositionRepository: findByProductAndWarehouse (LOCK), listByProduct, listByWarehouse, save
StockMovementRepository: save (insert-only), listByProduct, listByReference
StockLayerRepository: listActiveByProduct (order entered_at ASC, LOCK), save
ProductRepository: findById, upsert          ← read-model local del producto
OrganizationPluginRepository: isActive, upsert
InventoryGapRepository: findOpen, findLastClosedGap, open, close, incrementSkipped
OutboxRepository: add
```

Agregado `Repositories` + `UnitOfWork`.

- [x] `typecheck` OK.

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

- [x] `typecheck` OK.

---

## Fase 5 — Casos de uso (`src/application/use-cases/`)

### 5.1 Bodegas
- `CreateWarehouseUseCase` — valida code único por org; si `isDefault`, quita el flag a la actual default; emite `inventory.warehouse.created`.
- `UpdateWarehouseUseCase` — cambios básicos + toggle default.
- `ListWarehousesUseCase`, `GetWarehouseUseCase`.
- `DeactivateWarehouseUseCase` — falla si `total_stock > 0`.
- `ResolveWarehouseForEstablishmentUseCase(orgId, establishmentId | null)` — **pieza central
  del descuento por venta.** Busca la bodega activa de ese establecimiento; si no hay,
  devuelve la `PRINCIPAL`. Si tampoco hay `PRINCIPAL`, es un error de datos y no una venta
  sin stock: lanza `DefaultWarehouseMissingError(422)` en vez de inventar una bodega.

### 5.2 Consultas de stock
- `GetStockByProductUseCase(orgId, productId)` — devuelve `[{ warehouse, on_hand, reserved, available, avg_cost }]`.
- `GetStockSummaryUseCase(orgId)` — resumen paginado con filtros (bajo mínimo, con stock,
  sin stock). **Además devuelve `staleWarning`**: consulta `InventoryGapRepository` por el
  último hueco cerrado y sin resolver, y si existe lo adjunta con sus fechas y su contador.
  Es lo único que hace que el usuario se entere de que estas cifras no son confiables, así
  que no es un extra: sin esto la reactivación del plugin es silenciosa.

  Un hueco se considera **resuelto** cuando existe un movimiento de saldo inicial o un ajuste
  con motivo `physical_count` posterior a su `ended_at`. Es decir: el aviso desaparece solo,
  cuando alguien hace el conteo, sin botón de "ya lo vi".
- `GetStockMovementsUseCase(orgId, productId, warehouseId?, from?, to?)` — kardex paginado.

### 5.3 Movimientos manuales
- `AdjustStockUseCase({ orgId, productId, warehouseId, quantity (positiva o negativa), reasonCode, reason?, unitCost? })` — ajuste con motivo tipificado. Deriva `accounting_nature` de
  `reasonCode` + signo según la tabla de la Fase 2. Emite `inventory.stock.adjusted`.
- `TransferStockUseCase({ orgId, productId, fromWarehouseId, toWarehouseId, quantity })` — genera dos movimientos atómicos (`transfer_out` + `transfer_in`). Emite `inventory.stock.transferred`.
- `SetOpeningBalanceUseCase` — para migración inicial de datos. Naturaleza `inventory_in`.

### 5.4 Reservas — no se construyen en esta fase

`ReserveStockUseCase`, `ConfirmReservationUseCase` y `ReleaseReservationUseCase` quedan
**fuera de alcance**. La venta descuenta al emitir, no al redactar el borrador.

`quantity_reserved` existe en la posición y se mantiene siempre en `0`. `quantity_available`
sigue calculándose como `on_hand - reserved`, así que hoy vale lo mismo que `on_hand`. Se
deja la fórmula, no el atajo, para que activar reservas después no toque las consultas.

**Lo que aceptamos con esto:** dos borradores de factura pueden comprometer la misma última
unidad, y el conflicto sale a la luz recién al emitir el segundo. Con `allow_negative_stock`
en falso, esa segunda emisión falla. Es un problema real y es el precio de no construir
expiración de reservas, liberación y limpieza de huérfanas ahora.

### 5.5 Consumidores de eventos externos

**`purchase.purchase_order.received` → `RegisterPurchaseEntryUseCase`**
Entrada de stock desde compra. Recibe `productId, warehouseId, quantity, unitCost, currencyCode, purchaseOrderId`.
- Aplica `ValuationStrategy.onEntry`.
- Genera `StockMovement (purchase_in)` + actualiza `stock_positions` + crea `stock_layers` si FIFO.
- Emite `inventory.stock.entered`.

**`billing.invoice.issued` → `HandleInvoiceIssuedUseCase`**
Descuento directo, sin reservas:
- **Primero de todo: `inventory.kardex` activo para esa organización.** Si no lo está, no se
  escribe nada, se incrementa `skipped_movements` del hueco abierto (una vez por línea que se
  saltó) y se confirma el mensaje. El resto de este caso de uso no llega a ejecutarse.
- Resuelve la bodega **una vez por factura** con `ResolveWarehouseForEstablishmentUseCase`,
  usando el `establishmentId` que ya trae el evento. Todas las líneas descuentan de ella.
- Por cada línea con `productId` de tipo `good` y `track_stock=true`:
  - Aplica `ValuationStrategy.onExit` y genera `StockMovement (sale_out)` con
    `accounting_nature = cogs`, `reference_type = 'invoice'` y `reference_id = invoiceId`.
  - **El movimiento se escribe siempre, alcance o no.** La factura ya está emitida y
    timbrada, y la mercadería ya salió del local. Negarse a registrar la salida no
    devuelve el producto: solo deja el kardex mintiendo en silencio para siempre. Si la
    posición queda bajo cero, queda bajo cero y se emite `inventory.stock.negative`.
  - `allow_negative_stock` **no se evalúa aquí**. Ese control pertenece al momento de
    vender, no al de contabilizar lo vendido. Ver el recuadro de abajo.
- Emite `inventory.stock.consumed` por cada línea.
- Idempotente por `eventId` en `processed_events`. Reprocesar una factura no puede duplicar
  el kardex.

> **Dónde vive de verdad `allow_negative_stock`.** El diseño original lo evaluaba al
> consumir el evento de factura emitida, y eso no puede funcionar: cuando el evento llega,
> la factura ya tiene número, ya está firmada y el cliente ya se fue con el producto. El
> único punto donde bloquear sirve de algo es **antes de emitir**, y ese punto está en
> billing y en el punto de venta, no aquí.
>
> Lo que el inventario aporta para que ese bloqueo exista es `GET /stock/products/{id}`,
> que ya está en el contrato. Cablearlo en billing y en el mostrador es trabajo de esos dos
> servicios y queda fuera de esta fase. Mientras no exista, el flag solo sirve para decidir
> a quién se le manda la alerta.

**`billing.invoice.voided` → `HandleInvoiceVoidedUseCase`**
- **Reversa desde el kardex, nunca desde el estado actual.** Busca los `sale_out` por
  `reference_type='invoice'` + `reference_id`, y repone uno por uno con su costo original.
  Si el precio o el promedio cambiaron entretanto, da igual: se devuelve lo que salió.
- Genera `adjustment_in` con `accounting_nature = inventory_in` y motivo
  "anulación factura {invoiceId}", apuntando a la misma referencia.
- Con FIFO, la reposición **crea un layer nuevo** al costo original en vez de resucitar el
  layer consumido. Reconstruir el layer exacto obligaría a un rastro capa por capa que no
  paga lo que cuesta.
- Emite `inventory.stock.entered` (tipo compensación).

**`product.product.updated` → `RefreshProductReadModelUseCase`**
Solo interesa `track_stock`, `allow_negative_stock`, `valuation_method`, `status`.

**`plugin.activated` → `HandlePluginActivatedUseCase`**
Solo reacciona a `code === 'inventory.kardex'`. Marca `active` en el read-model, cierra el
hueco abierto si lo hay y emite `inventory.stock.stale` con las fechas y el contador de
movimientos perdidos. Idempotente: activar dos veces no abre ni cierra nada nuevo.

**`plugin.deactivated` → `HandlePluginDeactivatedUseCase`**
Marca `disabled` y abre un hueco si no había uno abierto. No borra nada: el kardex histórico
se conserva intacto, simplemente deja de crecer.

**`organization.establishment.created` → `EnsureWarehouseForEstablishmentUseCase`**
**Obligatorio, no opcional.** Cada establecimiento nace con su bodega, con `code` derivado
del código del establecimiento y `establishment_id` apuntando a él. Sin esto, la resolución
de bodega de la venta cae siempre en `PRINCIPAL` y una segunda tienda descuadra el stock
desde su primera venta. Idempotente: si ya existe bodega para ese establecimiento, no hace
nada.

**`organization.org.updated` → `EnsureDefaultWarehouseUseCase`** (idempotente)
Cuando la org recibe su country_code por primera vez, crea la bodega `PRINCIPAL` si no existe.

- [x] Casos de uso implementados.

---

## Fase 6 — HTTP (`src/interface/http/`)

**`middlewares.ts`**: `contextMiddleware`, `requireOrganization` (401), `requirePermission(perm)` (403), `errorHandler`.

**`validators.ts`**: `validateJson` + Zod schemas para cada endpoint del `openapi.yaml`.

**`controllers.ts`**: factories; `organizationId` y `userId` del contexto.

**`routes.ts` + `app.ts`**: monta lo del `openapi.yaml` **salvo las tres rutas de
`/stock/reservations`**, marcadas `x-phase: 2` en el contrato. Si alguien las llama, 404
natural del router. CORS con `X-*`. `contextMiddleware` global.

Rutas de esta fase:

```
GET    /health
GET    /warehouses            POST /warehouses
GET    /warehouses/{id}       PATCH /warehouses/{id}
POST   /warehouses/{id}/deactivate
GET    /stock
GET    /stock/products/{productId}
GET    /stock/movements
POST   /stock/adjustments
POST   /stock/transfers
```

- [x] Rutas montadas; las de reserva **no** están montadas.

---

## Fase 7 — Composition root + consumers

`main.ts` (puerto 3013): `sequelize.authenticate()`, `buildRepositories()` + `SequelizeUnitOfWork`, `startConsumers` para todos los eventos consumidos (idempotencia con `processed_events`).

Consumidores de esta fase: `organization.org.updated`, `organization.establishment.created`,
`product.product.created/updated/disabled`, `billing.invoice.issued`, `billing.invoice.voided`,
`plugin.activated`, `plugin.deactivated`.
El de `purchase.purchase_order.received` se deja escrito pero nadie lo publica todavía: no
existe el servicio de compras.

- [x] `build` OK. ⬜ `/health` sin verificar: el servicio no se ha levantado.

---

## Fase 8 — Tests (`src/__tests__/`)

Repos fake en memoria. Cubrir:
- **Warehouse:** crear + no permitir dos default; deactivate falla con stock > 0.
- **WeightedAverageStrategy:** entradas escalonadas actualizan promedio correctamente con Dinero.js (100 a $10 + 100 a $12 = avg $11).
- **FifoStrategy:** consume layers en orden; múltiples layers se consumen parcialmente correctamente.
- **Resolución de bodega:** factura con establecimiento que tiene bodega usa esa; sin
  bodega propia cae en `PRINCIPAL`; sin `PRINCIPAL` lanza `DefaultWarehouseMissingError`.
- **Venta sin stock suficiente:** el movimiento se escribe igual, la posición queda
  negativa y se emite `inventory.stock.negative`. Con el flag en falso el resultado del
  kardex es el mismo; lo único que cambia es que la alerta se marca como incidencia.
- **Naturaleza contable:** la tabla entera de motivo + signo, caso por caso, en
  `adjust-stock.test.ts`. Es la pieza sobre la que se apoyará el generador de asientos: si
  alguien toca el mapeo, esto tiene que romperse. Incluye motivo fuera de la tabla, cantidad
  cero y producto sin seguimiento.
- **Costo del ajuste:** dos entradas escalonadas dejan el promedio ponderado correcto; un
  sobrante de conteo sin costo entra al promedio vigente, y a cero si la posición está vacía.
- **Consultas:** el resumen devuelve bodega, disponible y promedio; el filtro de existencia
  separa lo que hay de lo agotado (una posición en cero cuenta como sin existencia); el
  kardex devuelve los movimientos con su naturaleza.
- **Transfer:** movimientos atómicos; falla en medio deja consistente; ambos con
  `internal_transfer`.
- **HandleInvoiceIssued:** descuento directo por línea; reprocesar el mismo `eventId` no
  duplica movimientos.
- **Cantidad que llega como float:** una línea con `quantity: 0.1` y otra con `0.2` sobre la
  misma posición dejan exactamente `0.3` descontado, no `0.30000000000000004`. Es el test que
  demuestra que la conversión a `Decimal` ocurre en el borde y no después de operar.
- **HandleInvoiceVoided:** repone al costo original aunque el promedio haya cambiado
  después; con FIFO crea layer nuevo.
- **Plugin apagado:** con `inventory.kardex` en `disabled`, una factura emitida NO escribe
  movimientos, incrementa `skipped_movements` y confirma el mensaje sin error.
- **Plugin sin fila y catálogo caído:** el movimiento **sí** se escribe. Es el test que
  protege la asimetría: ante duda se procesa.
- **Ciclo de hueco:** desactivar abre uno, tres facturas saltadas lo dejan en 3, reactivar lo
  cierra y emite `inventory.stock.stale` con esas fechas y ese contador.
- **Reactivar dos veces** no cierra un hueco ya cerrado ni emite el evento de nuevo.

- [x] `npm test` verde — 53 pruebas.

---

## Fase 9 — Cablear el servicio al resto del sistema

Un inventario que solo responde por API no lo usa nadie en un local. Estas cuatro piezas van
**después** de que `npm test` esté verde, no antes, pero sin ellas el trabajo no llega al
usuario.

### 9.1 Rutas en el api-gateway

`../api-gateway-node/src/config/gateway.config.ts` no tiene **ninguna** entrada de
inventario. Dos cambios en ese archivo:

```ts
// 1. junto a los demás push de servicios (~línea 37)
if (env.INVENTORY_SERVICE_URL) services.push({ name: 'inventory-service', url: env.INVENTORY_SERVICE_URL });

// 2. en la tabla de rutas (~línea 136, junto a las de product-service)
{ method: 'ANY', path: '/warehouses/*', service: 'inventory-service', stripPrefix: '', requiresPlugin: 'inventory.warehouses' },
{ method: 'ANY', path: '/stock/*',      service: 'inventory-service', stripPrefix: '', requiresPlugin: 'inventory.kardex' },
```

Añadir `INVENTORY_SERVICE_URL` al esquema de entorno del gateway y a su `k8s/deployment.yaml`,
donde el resto de servicios ya declara su URL interna.

Las rutas de bodegas y de stock cuelgan de dos plugins distintos, así que una organización
puede tener kardex sin bodegas múltiples. Eso es deliberado y encaja con la auto-provisión de
una sola bodega: el concepto se puede ocultar.

⚠️ **El gateway solo cubre el HTTP.** Los eventos no pasan por él, así que el corte por
plugin del camino de eventos se hace **dentro de este servicio**. Ver la sección
"El plugin apagado apaga el servicio", que es requisito y no mejora.

### 9.2 Corregir el catálogo de plugins

`../plugin-catalog-service/seed/plugins-dependencias.json` miente en tres filas y es el
tablero del que cuelgan las rutas de arriba:

| Módulo | Dice | Realidad |
|---|---|---|
| `inventory.warehouses` | falta | correcto hoy; pasa a **hecho** al cerrar la fase 8 |
| `inventory.kardex` | parcial | **falta**: no existe ni una línea. Pasa a **hecho** al cerrar la fase 8 |
| `admin.audit_log` | falta | **hecho** desde hace tiempo: `audit-log-service` está desplegado |

La corrección de `admin.audit_log` no es de este trabajo, pero se arregla aquí porque es una
línea y porque el catálogo se usa para decidir qué se vende.

La semilla es idempotente y actualiza metadata sin pisar `price_cents` ni `is_active`, así
que corregir el JSON y volver a migrar es seguro.

### 9.3 Frontend — ✅ construido

Ficheros, todos bajo `../../frontend/src/`:

```
types/inventory.ts                        contratos; cantidades como string, nunca number
api/inventory.ts                          cliente HTTP
stores/inventory.ts                       store Pinia; expone isSingleWarehouse
views/inventory/StockListView.vue         pantalla principal
views/inventory/StockMovementsView.vue    kardex de un producto
views/inventory/WarehousesView.vue        bodegas
components/inventory/AdjustStockDialog.vue  ajuste
router/index.ts                           3 rutas con su requiredPlugin
menus/navigation.ts                       nav.stock con permiso inventory:read
i18n/{es,en,fr}.json                       38 claves por idioma
```

Lo que quedó decidido al construirlas:

- **Bodegas se oculta entero con una sola bodega.** No solo el enlace: también la columna de
  bodega en la tabla y el filtro por bodega. Obligar a elegir entre una única opción es ruido,
  y una sola bodega es el caso por defecto tras el alta.
- **El filtro de "bajo mínimo" NO se construyó.** El punto de reorden es fase 2 y el
  parámetro no tiene efecto en el backend. Poner el filtro en la pantalla habría sido prometer
  algo que no funciona. Sí están los de con y sin existencia.
- **El diálogo de ajuste enseña la consecuencia antes de guardar.** Además de ofrecer el
  motivo como desplegable cerrado, muestra en qué naturaleza contable se va a convertir. Y
  filtra los motivos por dirección: un robo o un vencimiento no suman existencias, así que no
  aparecen como entrada.
- **Una posición negativa se pinta en rojo y no se recorta a cero.** Es la incidencia que el
  servicio deja pasar a propósito para no perder la venta del kardex. Esconderla en la
  pantalla anularía esa decisión.
- **El nombre del producto se cruza en el cliente.** El stock viene por `productId` y el
  nombre vive en product-service: son dos bases y no hay JOIN posible.

Verificado: `npx tsc --noEmit` sin errores, `npm run build` OK y `npm run lint:ui` en verde.
⬜ Sin verificar contra el servicio corriendo.

### 9.4 Deuda que pertenece a otros servicios

Ninguna bloquea este trabajo. Se anotan porque salieron al revisar y se van a perder si no
quedan escritas.

- **Bloquear la venta sin stock es de billing y del POS, no de aquí.** Ver el recuadro de la
  fase 5.5. La pieza que este servicio aporta ya existe en el contrato:
  `GET /stock/products/{productId}`. Consumirla antes de emitir es trabajo de esos dos.
- **El POS vende a ciegas.** Su tabla local de productos tiene un campo `stock` con el
  comentario "sin control real aún". Sus ventas sí llegan aquí, porque empuja a
  `/invoices/from-pos` y eso termina en `billing.invoice.issued`. Lo que falta es el camino
  de vuelta. Y sin conexión no se puede validar: conviene aceptarlo, no pelearlo.
- **Cuentas contables por producto.** Los tres campos nulos del read-model (ver fase 2)
  necesitan su migración en product-service cuando exista contabilidad. No bloquean nada.
- **No hay compras.** La única entrada real de esta fase es el ajuste manual y el saldo
  inicial, así que el costo promedio nacerá de números escritos a mano. Es aceptable para
  arrancar, pero hay que saberlo antes de creerse la valorización.

---

## Definición de "hecho"

**Cómo leer esta lista hoy.** Los puntos que una prueba automática cubre están verificados.
Los que exigen una base de datos, RabbitMQ o el gateway corriendo **no se han comprobado**:
el entorno nunca se ha levantado. Están marcados uno por uno.

1. ⬜ `db:migrate` crea las tablas (son 10, no 6: se sumaron `organization_plugins`,
   `inventory_gaps` y `reservations` vacía). **Sin correr contra MySQL.**
2. ⬜ Auto-provisión: `organization.org.updated` crea bodega `PRINCIPAL` idempotente.
   Código escrito, evento nunca recibido de verdad.
3. ✅ Lógica cubierta por pruebas (bodega default única, no dos default, code único).
   ⬜ El endpoint no se ha llamado por HTTP.
4. ✅ `POST /stock/adjustments { productId, warehouseId, quantity: 100, unitCost: "10.00" }` incrementa on_hand y actualiza average_cost.
5. ✅ Segundo ajuste de 100 unidades a $12.00 con promedio → `average_cost = 1100` (centavos = $11.00).
6. ✅ Con FIFO, dos entradas escalonadas generan dos capas y la salida las consume en
   orden, sin volver a comerse la agotada.
7. ✅ `organization.establishment.created` crea la bodega del establecimiento, y repetir el
   evento no crea una segunda.
8. ✅ `billing.invoice.issued` con línea de producto tracked genera `sale_out` en la bodega
   **del establecimiento emisor**, con `accounting_nature = cogs`.
9. ✅ `billing.invoice.voided` genera `adjustment_in` reponiendo stock al costo original,
   leído del movimiento de salida y no del promedio vigente.
10. ✅ `GET /stock?productId=X` devuelve posiciones por bodega con on_hand, reserved, available, avg_cost.
11. ✅ `GET /stock/movements?productId=X` devuelve kardex ordenado por fecha, con la
    naturaleza contable de cada fila.
12. ✅ Un ajuste con `reasonCode: internal_use` sale con naturaleza `expense`; uno con
    `damage` sale con `shrinkage`.
13. ✅ Las rutas de `/stock/reservations` no se montan.
14. ✅ Con `inventory.kardex` desactivado, emitir una factura NO mueve el stock, y el hueco
    registra cuántos movimientos se saltaron.
15. ✅ Al reactivar, `GET /stock` avisa de que el inventario estuvo apagado y desde cuándo.
16. ✅ `npm test` (53) + `npm run build` OK.

Cierre de la fase 0:

17. ⬜ Los cinco permisos `inventory:*` existen en `auth_db` y el Administrador los tiene.
    Migración escrita, **sin ejecutar**.
    Un usuario con sesión abierta antes de la migración recibe `TOKEN_STALE`, refresca y
    ya los trae en el claim.
18. ⬜ `docker compose up` levanta `inventory-service` en el 3013 y `inventory-migrate`
    termina con éxito.

Cierre de la fase 9:

19. ⬜ El gateway enruta `/warehouses/*` y `/stock/*` al servicio, y los rechaza con 403
    cuando al usuario le falta el permiso.
20. ✅ El catálogo de plugins ya no dice que el kardex está "parcial" ni que la bitácora
    "falta".
21. ✅ Existe la pantalla de stock y la de ajuste, y la de ajuste ofrece los motivos como
    desplegable.

---

## Fuera de alcance (no hacer en Fase 1)

- **Reservas de stock** — tabla creada, flujo sin cablear. La venta descuenta al emitir.
- **Consumibles y recetas de consumo** — que vender una caja descuente también su empaque.
  Va con una tabla `product_components` en el catálogo, proyectada aquí, y expansión en el
  consumo. Es lo primero que entra después de esta fase. Cuando entre, cada movimiento hijo
  llevará su `accounting_nature` propia, casi siempre `expense`, que es justo por lo que la
  columna se agrega hoy.
- **Lotes y fechas de vencimiento** (Fase 2 — trazabilidad). `lot_id` ya existe nulo en
  `stock_movements` y `stock_layers`. La migración futura añade la tabla `stock_lots` y una
  tabla puente para el desglose por lote de cada posición, sin tocar el histórico ya escrito.
- **Números de serie individuales** (Fase 2).
- **Ubicaciones dentro de bodega** (Fase 2).
- **Toma de inventario físico** con generación masiva de ajustes (Fase 2 — importante pero no crítico).
- **Stock mínimo y punto de reorden con alertas** (Fase 2).
- **Listas de materiales (BOM) y órdenes de producción** (Fase 3).
- **Multi-moneda operativa** (cada bodega maneja UNA currency; conversión es responsabilidad de reportes).
- **MRP** (Fase 3+).

## Cambios requeridos en product-service

**Ya no hay ninguno bloqueante.** Los dos campos que este documento pedía existen desde la
migración `20260714000000-add-inventory-fields-to-products.cjs`:

- [x] `allow_negative_stock BOOLEAN NN DEFAULT FALSE`
- [x] `valuation_method ENUM('weighted_average', 'fifo') NN DEFAULT 'weighted_average'`

Queda **pendiente y no bloqueante**, para cuando exista contabilidad:

- [ ] `inventory_account_code`, `cogs_account_code`, `expense_account_code` en
      `product.products`, los tres nulos. Hasta entonces el read-model los guarda vacíos y
      el inventario no los lee.

Verificar que el payload de `product.product.upserted` incluya `trackStock`,
`allowNegativeStock` y `valuationMethod`; el read-model local depende de los tres.
