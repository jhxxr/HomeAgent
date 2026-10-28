import { VERSION } from './protocol.js';

/** Human-readable version line shared by the Server and Runner CLIs. */
export const versionBanner = (component: 'Server' | 'Runner') =>
  `HomeAgent ${component} v${VERSION} · Node ${process.version} · ${process.platform}/${process.arch}`;
