import { escapeHtml } from '@crm/core/html';

/**
 * The link and the embed snippet for a form (ADR-0065 5.1).
 *
 * Built from configuration (`PUBLIC_FORMS_BASE_URL`, else the web app's own origin), never from a
 * literal, so the hosted pages can move to their own domain without a code change. The key is
 * base64url and cannot need escaping; the form's name is the company's own text and is escaped.
 */
export function formLink(baseUrl: string, key: string): string {
  return `${baseUrl.replace(/\/+$/, '')}/f/${key}`;
}

export function formSnippet(link: string, formName: string): string {
  return `<iframe src="${escapeHtml(link)}" title="${escapeHtml(formName)}" loading="lazy" style="border:0;width:100%;height:640px"></iframe>`;
}
