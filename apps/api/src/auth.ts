import {
  CanActivate, ExecutionContext, ForbiddenException, Injectable, UnauthorizedException,
  createParamDecorator, SetMetadata,
} from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import { timingSafeEqual } from 'node:crypto';

/**
 * Authentification provisoire par jeton (en-tête Authorization: Bearer …).
 * À remplacer avant le pilote par de vrais comptes : mots de passe hachés ou SSO, MFA,
 * sessions expirables. Format de API_TOKENS : "jeton=utilisateur@client:rôle,…"
 * Rôles : operator (saisit), approver (valide), admin (tout, dans son client), superadmin (plateforme, client "*").
 */
export type Role = 'operator' | 'approver' | 'admin' | 'superadmin';
export interface User { id: string; tenant: string; role: Role }

const DEV_TOKENS = 'dev-operator=operateur@afriquia:operator,dev-approver=valideur@afriquia:approver,dev-admin=admin@afriquia:admin';

function parseTokens(): Map<string, User> {
  const raw = process.env.API_TOKENS ?? (process.env.NODE_ENV === 'production' ? '' : DEV_TOKENS);
  const map = new Map<string, User>();
  for (const entry of raw.split(',').map((s) => s.trim()).filter(Boolean)) {
    const m = /^([^=]+)=([^@]+)@([^:]+):(operator|approver|admin|superadmin)$/.exec(entry);
    if (!m) throw new Error(`API_TOKENS : entrée invalide « ${entry} »`);
    map.set(m[1], { id: m[2], tenant: m[3], role: m[4] as Role });
  }
  return map;
}

const ROLES_KEY = 'roles';
export const Roles = (...roles: Role[]) => SetMetadata(ROLES_KEY, roles);
export const Public = () => SetMetadata(ROLES_KEY, ['public']);

@Injectable()
export class AuthGuard implements CanActivate {
  private readonly tokens = parseTokens();
  constructor(private readonly reflector: Reflector) {}

  canActivate(ctx: ExecutionContext): boolean {
    const roles = this.reflector.getAllAndOverride<string[]>(ROLES_KEY, [ctx.getHandler(), ctx.getClass()]);
    if (roles?.includes('public')) return true;
    const req = ctx.switchToHttp().getRequest();
    const token = /^Bearer (.+)$/.exec(req.headers.authorization ?? '')?.[1] ?? '';
    let user: User | undefined;
    for (const [t, u] of this.tokens) {
      if (t.length === token.length && timingSafeEqual(Buffer.from(t), Buffer.from(token))) user = u;
    }
    if (!user) throw new UnauthorizedException('Jeton absent ou invalide');
    if (roles?.length && user.role !== 'admin' && user.role !== 'superadmin' && !roles.includes(user.role)) {
      throw new ForbiddenException('Rôle insuffisant');
    }
    req.user = user;
    return true;
  }
}

export const CurrentUser = createParamDecorator((_: unknown, ctx: ExecutionContext): User => ctx.switchToHttp().getRequest().user);

/** Le super-admin voit tous les clients ; les autres seulement le leur. */
export function tenantScope(u: User): string | null {
  return u.role === 'superadmin' ? null : u.tenant;
}
