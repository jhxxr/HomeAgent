import path from 'node:path';
import { z } from 'zod';

export interface ServerConfig {
  host: string; port: number; publicUrl: string; db: string;
  password: string; sessionSecret: string; trustProxyHops: number; retentionDays: number;
}
export function loadServerConfig(env = process.env): ServerConfig {
  const parsed = z.object({
    HOST: z.string().default('127.0.0.1'),
    PORT: z.coerce.number().int().min(0).max(65535).default(3210),
    PUBLIC_URL: z.url().default('http://localhost:3210'),
    ADMIN_PASSWORD: z.string().min(16),
    SESSION_SECRET: z.string().min(32),
    HOMEAGENT_DB: z.string().default('./data/server.sqlite'),
    TRUST_PROXY_HOPS: z.coerce.number().int().min(0).max(5).default(0),
    AUDIT_RETENTION_DAYS: z.coerce.number().int().min(1).max(3650).default(90),
  }).parse(env);
  const url = new URL(parsed.PUBLIC_URL);
  if (url.pathname !== '/' || url.search || url.hash || url.username || url.password) throw new Error('PUBLIC_URL must be an origin without a path or credentials');
  if (url.protocol !== 'https:' && !(url.protocol === 'http:' && ['localhost', '127.0.0.1', '[::1]'].includes(url.hostname))) {
    throw new Error('PUBLIC_URL requires HTTPS, except on loopback');
  }
  return {
    host: parsed.HOST, port: parsed.PORT, publicUrl: url.origin, db: path.resolve(parsed.HOMEAGENT_DB),
    password: parsed.ADMIN_PASSWORD, sessionSecret: parsed.SESSION_SECRET,
    trustProxyHops: parsed.TRUST_PROXY_HOPS, retentionDays: parsed.AUDIT_RETENTION_DAYS,
  };
}
