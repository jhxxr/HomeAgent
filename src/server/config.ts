import path from 'node:path';
import { z } from 'zod';

export interface XAuthConfig {
  issuer: string;
  clientId: string;
  clientSecret?: string;
}
export interface ServerConfig {
  host: string; port: number; publicUrl: string; db: string;
  password?: string; xauth?: XAuthConfig; sessionSecret: string; trustProxyHops: number; retentionDays: number;
}
function parseOrigin(raw: string, label: string): string {
  let url: URL;
  try { url = new URL(raw); }
  catch { throw new Error(`${label} must be a valid URL`); }
  if (url.pathname !== '/' || url.search || url.hash || url.username || url.password) throw new Error(`${label} must be an origin without a path or credentials`);
  if (url.protocol !== 'https:' && !(url.protocol === 'http:' && ['localhost', '127.0.0.1', '[::1]'].includes(url.hostname))) {
    throw new Error(`${label} requires HTTPS, except on loopback`);
  }
  return url.origin;
}
const optionalEnv = (value: unknown) => typeof value === 'string' && value.trim() === '' ? undefined : value;
export function loadServerConfig(env = process.env): ServerConfig {
  const parsed = z.object({
    HOST: z.string().default('127.0.0.1'),
    PORT: z.coerce.number().int().min(0).max(65535).default(3210),
    PUBLIC_URL: z.url().default('http://localhost:3210'),
    ADMIN_PASSWORD: z.preprocess(value => value === '' ? undefined : value, z.string().min(16).optional()),
    XAUTH_ISSUER: z.preprocess(optionalEnv, z.string().optional()),
    XAUTH_CLIENT_ID: z.preprocess(optionalEnv, z.string().trim().min(1).max(256).optional()),
    XAUTH_CLIENT_SECRET: z.preprocess(optionalEnv, z.string().trim().min(1).max(512).optional()),
    SESSION_SECRET: z.string().min(32),
    HOMEAGENT_DB: z.string().default('./data/server.sqlite'),
    TRUST_PROXY_HOPS: z.coerce.number().int().min(0).max(5).default(0),
    AUDIT_RETENTION_DAYS: z.coerce.number().int().min(1).max(3650).default(90),
  }).parse(env);
  const publicUrl = parseOrigin(parsed.PUBLIC_URL, 'PUBLIC_URL');
  let xauth: XAuthConfig | undefined;
  if (parsed.XAUTH_ISSUER !== undefined || parsed.XAUTH_CLIENT_ID !== undefined || parsed.XAUTH_CLIENT_SECRET !== undefined) {
    if (!parsed.XAUTH_ISSUER || !parsed.XAUTH_CLIENT_ID) {
      throw new Error('XAUTH_ISSUER and XAUTH_CLIENT_ID must both be set when configuring XAuth');
    }
    xauth = {
      issuer: parseOrigin(parsed.XAUTH_ISSUER, 'XAUTH_ISSUER'),
      clientId: parsed.XAUTH_CLIENT_ID,
      ...(parsed.XAUTH_CLIENT_SECRET ? { clientSecret: parsed.XAUTH_CLIENT_SECRET } : {}),
    };
  }
  if (!parsed.ADMIN_PASSWORD && !xauth) {
    throw new Error('Configure ADMIN_PASSWORD (at least 16 characters) or XAuth (XAUTH_ISSUER and XAUTH_CLIENT_ID)');
  }
  return {
    host: parsed.HOST, port: parsed.PORT, publicUrl, db: path.resolve(parsed.HOMEAGENT_DB),
    ...(parsed.ADMIN_PASSWORD ? { password: parsed.ADMIN_PASSWORD } : {}),
    ...(xauth ? { xauth } : {}),
    sessionSecret: parsed.SESSION_SECRET,
    trustProxyHops: parsed.TRUST_PROXY_HOPS, retentionDays: parsed.AUDIT_RETENTION_DAYS,
  };
}
