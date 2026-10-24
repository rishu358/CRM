import { brandTheme } from '@crm/ui/brand';
import { originOf } from './csp';

/**
 * What this installation calls itself and how it looks, from configuration (ADR-0045).
 *
 * Pure functions of the web app's environment, so each rule can be tested without a request. The
 * environment arrives already validated for shape (`@crm/env`: a colour is `#rrggbb`, an image
 * address is http(s) or a local path); what only this app can judge, whether a colour is readable
 * in this app's themes, is `brandProblems`, and it is applied when the environment is loaded, so a
 * colour that would break accessibility stops the web app starting instead of shipping.
 */
export interface BrandEnv {
  readonly APP_NAME: string;
  readonly SUPPORT_EMAIL?: string | undefined;
  readonly TERMS_URL?: string | undefined;
  readonly PRIVACY_URL?: string | undefined;
  readonly BRAND_LOGO_URL?: string | undefined;
  readonly BRAND_FAVICON_URL?: string | undefined;
  readonly BRAND_COLOR?: string | undefined;
  readonly BRAND_COLOR_DARK?: string | undefined;
}

/** What a component may know: public, and safe to hand to the browser. */
export interface PublicBrand {
  readonly name: string;
  readonly logoUrl: string | null;
  readonly faviconUrl: string | null;
  readonly supportEmail: string | null;
  readonly termsUrl: string | null;
  readonly privacyUrl: string | null;
}

export function publicBrand(env: BrandEnv): PublicBrand {
  return {
    name: env.APP_NAME,
    logoUrl: env.BRAND_LOGO_URL ?? null,
    faviconUrl: env.BRAND_FAVICON_URL ?? null,
    supportEmail: env.SUPPORT_EMAIL ?? null,
    termsUrl: env.TERMS_URL ?? null,
    privacyUrl: env.PRIVACY_URL ?? null,
  };
}

/** The reasons a configured colour cannot be used; empty when none is set or all are fine. */
export function brandProblems(env: BrandEnv): string[] {
  return [...brandTheme({ light: env.BRAND_COLOR, dark: env.BRAND_COLOR_DARK }).problems];
}

/**
 * CSS custom properties for the root element. `styles.css` reads them with the built-in tokens as
 * fallbacks, so an empty object, or a refused colour, leaves the stock theme untouched.
 */
export function brandStyle(env: BrandEnv): Record<string, string> {
  return { ...brandTheme({ light: env.BRAND_COLOR, dark: env.BRAND_COLOR_DARK }).variables };
}

/**
 * The origins images load from besides this one: the host of an absolute logo or favicon URL. A
 * local path (`/brand/logo.svg`) is this origin already and adds nothing, and only the origin ever
 * reaches the policy (`img-src` is `'self' data: blob:` otherwise).
 */
export function imageOrigins(env: BrandEnv): string[] {
  return [
    ...new Set(
      [env.BRAND_LOGO_URL, env.BRAND_FAVICON_URL]
        .map((value) => originOf(value))
        .filter((origin): origin is string => origin !== null),
    ),
  ];
}
