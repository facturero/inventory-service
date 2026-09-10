import { zValidator } from '@hono/zod-validator';
import { z, ZodSchema } from 'zod';
import { ValidationError } from '../../domain/errors.js';

const quantityString = z
  .string()
  .regex(/^-?\d+(\.\d{1,4})?$/, 'La cantidad debe ser un número válido con hasta 4 decimales.');

const positiveQuantityString = z
  .string()
  .regex(/^\d+(\.\d{1,4})?$/, 'La cantidad debe ser un número válido con hasta 4 decimales.')
  .refine((v) => Number(v) > 0, 'La cantidad debe ser mayor que cero.');

export const createWarehouseSchema = z.object({
  code: z.string().min(1, 'El código es obligatorio.').max(20),
  name: z.string().min(1, 'El nombre es obligatorio.').max(255),
  address: z.string().max(255).optional().nullable(),
  establishmentId: z.string().uuid('El establishmentId no es válido.').optional().nullable(),
  isDefault: z.boolean().default(false),
});

export const updateWarehouseSchema = z.object({
  name: z.string().max(255).optional(),
  address: z.string().max(255).optional().nullable(),
  establishmentId: z.string().uuid('El establishmentId no es válido.').optional().nullable(),
  isDefault: z.boolean().optional(),
});

export const adjustStockSchema = z.object({
  productId: z.string().uuid('El productId no es válido.'),
  warehouseId: z.string().uuid('El warehouseId no es válido.'),
  quantity: quantityString,
  unitCost: z
    .string()
    .regex(/^\d+(\.\d{1,2})?$/, 'El costo unitario debe ser un número válido con hasta 2 decimales.')
    .optional(),
  currencyCode: z.string().length(3, 'El código de moneda debe tener 3 caracteres.').default('USD'),
  reasonCode: z.enum(['physical_count', 'damage', 'expiration', 'theft', 'internal_use', 'correction']),
  reason: z.string().max(255).optional(),
});

export const transferStockSchema = z.object({
  productId: z.string().uuid('El productId no es válido.'),
  fromWarehouseId: z.string().uuid('El fromWarehouseId no es válido.'),
  toWarehouseId: z.string().uuid('El toWarehouseId no es válido.'),
  quantity: positiveQuantityString,
  notes: z.string().optional(),
});

export function validateJson<T extends ZodSchema>(schema: T) {
  return zValidator('json', schema, (result) => {
    if (!result.success) {
      const details = result.error.issues.map((i) => ({
        field: i.path.join('.') || '(root)',
        message: i.message,
      }));
      throw new ValidationError(details);
    }
  });
}