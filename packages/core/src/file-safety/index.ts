/**
 * Byte-level upload inspection that needs Node (`zlib`).
 *
 * A separate entry point (`@crm/core/file-safety`) rather than part of the
 * root export, because the root is imported by the browser bundle and must
 * stay free of Node built-ins.
 */
export * from './zip.js';
