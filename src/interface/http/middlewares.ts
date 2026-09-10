import { Context, MiddlewareHandler } from 'hono';
import { runWithActor } from '@facturero/outbox-relay';
import {
  AppError,
  ForbiddenError,
  OrganizationContextRequiredError,
  UserContextRequiredError,
} from '../../domain/errors.js';

export type ContextVariables = {
  organizationId: string;
  userId: string;
  countryCode: string;
  permissions: string[];
};

export function contextMiddleware(): MiddlewareHandler<{
  Variables: ContextVariables;
}> {
  return async (c, next) => {
    const orgId = c.req.header('X-Organization-Id');
    const userId = c.req.header('X-User-Id');
    const countryCode = c.req.header('X-Country-Code');
    const perms = c.req.header('X-Permissions');

    if (orgId) c.set('organizationId', orgId);
    if (userId) c.set('userId', userId);
    if (countryCode) c.set('countryCode', countryCode);
    if (perms) c.set('permissions', perms.split(',').map((p) => p.trim()));

    // Quien actúa viaja en un contexto asíncrono hasta el outbox: así CADA
    // evento publicado durante esta petición lleva actor/ip/request-id sin que
    // los casos de uso tengan que arrastrarlos uno a uno.
    await runWithActor(
      {
        actorId: userId ?? null,
        actorEmail: c.req.header('X-User-Email') ?? null,
        actorIp: c.req.header('X-Client-Ip') ?? null,
        requestId: c.req.header('X-Request-Id') ?? null,
      },
      () => next(),
    );
  };
}

export function requireOrganization(): MiddlewareHandler<{
  Variables: ContextVariables;
}> {
  return async (c, next) => {
    const orgId = c.get('organizationId');
    if (!orgId) throw new OrganizationContextRequiredError();
    await next();
  };
}

export function requireUser(): MiddlewareHandler<{
  Variables: ContextVariables;
}> {
  return async (c, next) => {
    const userId = c.get('userId');
    if (!userId) throw new UserContextRequiredError();
    await next();
  };
}

export function requirePermission(perm: string): MiddlewareHandler<{
  Variables: ContextVariables;
}> {
  return async (c, next) => {
    const perms = c.get('permissions') ?? [];
    if (!perms.includes(perm)) throw new ForbiddenError();
    await next();
  };
}

export function errorHandler(err: Error, c: Context): Response {
  if (err instanceof AppError) {
    return c.json(
      {
        code: err.code,
        message: err.message,
        ...(err.details ? { details: err.details } : {}),
      },
      err.httpStatus as 400,
    );
  }

  console.error('[inventory-service] error no controlado:', err);
  return c.json({ code: 'INTERNAL_ERROR', message: 'Error interno del servidor.' }, 500);
}